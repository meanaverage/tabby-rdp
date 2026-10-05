// RDCleanPath proxy for the IronRDP web client, running inside Tabby's renderer.
// The WASM client talks WebSocket to this proxy; the proxy opens the upstream stream
// (a plain socket here, an SSH direct-tcpip channel later), forwards the X.224 request,
// terminates TLS, checks the server's certificate, hands the cert chain back to the client (for CredSSP), then relays.
import * as tls from 'tls'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { IncomingMessage } from 'http'
import { Duplex } from 'stream'
import { AddressInfo, isIP } from 'net'
import { CertificateDetails, certificateAuthorities, certificateDetails } from './authorities'
import { ByteQueue } from './byteQueue'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WebSocketServer } = require('ws')

const VERSION_1 = 3390
const GENERAL_ERROR = 1

/**
 * Opens the stream to the server at `destination`. `signal` aborts once the client it is for has gone (see the
 * connection's end), so that what takes time to open one (an RD Gateway's sign-in, say) can stop rather than go on,
 * with its sockets, for no one.
 */
export type UpstreamFactory = (destination: string, signal?: AbortSignal) => Promise<Duplex>

/**
 * Decides on the server's certificate, given its SHA-256 fingerprint (`AB:CD:…`), whether it is valid for the
 * server's name by this computer's certificate authorities (see RDCleanPathOptions.serverName), why not (Node's code
 * for the TLS library's verdict, such as DEPTH_ZERO_SELF_SIGNED_CERT; '' when it is), and what the certificate says of
 * itself (whom it was issued to and by, and its dates; see CertificateDetails); throws to refuse it. Upstream TLS
 * accepts any certificate (RDP servers make their own), so this is what stands between the client and an impostor. It
 * runs before the client hears back from the proxy, and so before CredSSP: no credentials have been sent yet, nor the
 * user name (see withoutUserCookie).
 */
export type CertificateCheck = (fingerprint: string, valid: boolean, reason: string, details?: CertificateDetails) => void | Promise<void>

/** A SHA-256 fingerprint as `AB:CD:…` (openssl and Node print it so), from any hex spelling; '' if it isn't one. */
export function normalizeFingerprint (value: string): string {
    const hex = String(value ?? '').replace(/[\s:]/g, '').toUpperCase()
    return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(':') : ''
}

function fingerprintOf (der: Buffer): string {
    return normalizeFingerprint(createHash('sha256').update(der).digest('hex'))
}

export interface RDCleanPathProxy extends ServerFlow {
    /** Where the client connects: the token is its path (and goes in its request too). */
    url: string
    token: string
    /**
     * Why the last connection failed before the relay was up (the server didn't answer, refused, offered no TLS, sent
     * no certificate): the client only sees a generic RDCleanPath error then.
     */
    failure: string | null
    /** RDP bytes relayed since the proxy started (after TLS, before SSH): from the server, and to it. */
    stats: { bytesIn: number, bytesOut: number }
    close (): void
}

/**
 * Room for what answers the remote desktop's requests with far more than they are: a part of a file sent from here
 * (FileTransfer), a shared folder's read (SharedDrives). What is handed to the connection goes to the server as the
 * proxy reads it from the connection's WebSocket, and waits in Tabby's window until then; the proxy reads no further
 * ahead of the server than HIGH_WATER (see send). A server that keeps asking and reads slowly, or not at all, could
 * have those answers fill the window's memory, so each takes room before it is read for the remote, and waits while
 * there is none. The room is FLOW_WINDOW less what was taken and the proxy hasn't read from the connection since:
 * whatever it reads counts, the connection's other messages too. Room is taken while there is any, so what is taken
 * can pass FLOW_WINDOW by one answer; what an answer didn't use (a short read, an error, none at all) is given back.
 * A server that reads nothing at all has no more than that kept for it. One that reads while it keeps asking can have
 * more: each byte of the connection's other messages the proxy reads makes room for a byte of answers, so what waits
 * can grow past FLOW_WINDOW by as much as the proxy reads of them meanwhile.
 * RDCleanPathProxy gives it, for the connection it relays.
 */
export interface ServerFlow {
    /** Whether there is room now. */
    room (): boolean
    /** Takes `bytes` of room, for an answer about to be read for the remote and handed to the connection. */
    spend (bytes: number): void
    /** Gives back `bytes` taken and not handed to the connection after all. */
    refund (bytes: number): void
    /** Resolves once there is room (at once if there is), or the connection ends. */
    whenRoom (): Promise<void>
}

/**
 * What answers to the remote's requests may have taken of the window's memory, read for it or handed to the connection,
 * beyond what the proxy has read from the connection (see ServerFlow): four of the largest parts of files a request
 * gets. A link stays busy with far less, as the proxy lets no more than HIGH_WATER wait for the server.
 */
export const FLOW_WINDOW = 64 * 1024 * 1024

export interface RDCleanPathOptions {
    /** Set INFO_AUTOLOGON in the client's Client Info PDU (xrdp; see autologon()). */
    autologon?: boolean
    /**
     * Called when the server chose TLS without Network Level Authentication (see offersNla), before anything more is
     * sent to it: the client would go on to send the password as it is. Throws to refuse. Not optional, so that no
     * caller lets such servers through by leaving it out; without options at all, they are refused (refuseWithoutNla).
     */
    withoutNla: () => void | Promise<void>
    /**
     * Called for a server that withoutNla let through, once the certificate check has taken its certificate: that
     * certificate's fingerprint, before the client hears back and so before the password goes to it. Throws to stop
     * there. withoutNla decides before TLS, with no certificate to go by; this holds what it decided to the server that
     * then showed one (a permission given for one certificate isn't one for another). Left out, nothing is held to a
     * certificate: a caller whose withoutNla lets a server through on a permission it remembered (as the desktop
     * service's does) has to give this, or that permission goes to whatever answers there next, whatever certificate
     * it shows.
     */
    withoutNlaCertificate?: (fingerprint: string) => void | Promise<void>
    /**
     * The name the server goes by here (a host name, or an IP address): its certificate is checked against it and
     * this computer's certificate authorities, for the certificate check to weigh, and a host name goes in the TLS
     * handshake (SNI) as other clients send it. Without one, nothing is checked that way, and the certificate is never
     * taken for valid: the desktops reached through an SSH host, whose names are that host's.
     */
    serverName?: string
    /** TLS options for the connection to the server (tests: an authority of their own, as `ca`). */
    tls?: tls.ConnectionOptions
    /** How long reaching the server, TLS included, may take before the connection is given up on (tests: less). */
    handshakeTimeoutMs?: number
}

/** The answer to a server without Network Level Authentication where nobody decides otherwise: refused. */
function refuseWithoutNla (): never {
    throw new Error('the server doesn\'t use Network Level Authentication')
}

// ---- minimal DER -------------------------------------------------------------------------------

function derLength (n: number): Buffer {
    if (n < 0x80) {
        return Buffer.from([n])
    }
    const bytes: number[] = []
    for (let v = n; v > 0; v = Math.floor(v / 256)) {
        bytes.unshift(v & 0xff)
    }
    return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv (tag: number, content: Buffer): Buffer {
    return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function derInteger (n: number): Buffer {
    let hex = n.toString(16)
    if (hex.length % 2) {
        hex = '0' + hex
    }
    let b = Buffer.from(hex, 'hex')
    if (b[0] & 0x80) {
        b = Buffer.concat([Buffer.from([0]), b])
    }
    return tlv(0x02, b)
}

const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items))
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner)
const octets = (b: Buffer) => tlv(0x04, b)
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'))

interface Tlv { tag: number, start: number, end: number }

function readTlv (buf: Buffer, off: number): Tlv | null {
    if (buf.length < off + 2) {
        return null
    }
    let len = buf[off + 1]
    let p = off + 2
    if (len & 0x80) {
        const k = len & 0x7f
        if (buf.length < p + k) {
            return null
        }
        len = 0
        for (let i = 0; i < k; i++) {
            len = len * 256 + buf[p++]
        }
    }
    return { tag: buf[off], start: p, end: p + len }
}

interface Request {
    version?: number
    destination?: string
    proxyAuth?: string
    /** The pre-connection blob's text (a Hyper-V VM's id, for one): sent to the server before anything else. */
    pcb?: string
    /** The X.224 connection request. Absent for a Hyper-V VM's console: there TLS comes first, and the client does X.224 after CredSSP. */
    x224?: Buffer
}

function decodeRequest (buf: Buffer): Request {
    const outer = readTlv(buf, 0)
    if (!outer || outer.tag !== 0x30) {
        throw new Error('RDCleanPath: not a SEQUENCE')
    }
    const req: Request = {}
    let p = outer.start
    while (p < outer.end) {
        const field = readTlv(buf, p)!
        const inner = readTlv(buf, field.start)!
        const value = buf.subarray(inner.start, inner.end)
        switch (field.tag & 0x1f) {
            case 0: req.version = value.readUIntBE(0, value.length); break
            case 2: req.destination = value.toString('utf8'); break
            case 3: req.proxyAuth = value.toString('utf8'); break
            case 5: req.pcb = value.toString('utf8'); break
            case 6: req.x224 = Buffer.from(value); break
        }
        p = field.end
    }
    return req
}

/** The response: the server's X.224 confirm (none for a Hyper-V VM's console), its certificate chain, its address. */
function encodeResponse (x224: Buffer | null, certChain: Buffer[], serverAddr: string): Buffer {
    return seq(
        explicit(0, derInteger(VERSION_1)),
        ...x224 ? [explicit(6, octets(x224))] : [],
        explicit(7, seq(...certChain.map(octets))),
        explicit(9, utf8(serverAddr)),
    )
}

/**
 * A version 2 pre-connection PDU ([MS-RDPEPS] 2.2.1.2) carrying `text`: what a client sends first to a server that
 * routes by it, as Hyper-V does to a VM's console by the VM's id.
 */
export function preconnectionPdu (text: string): Buffer {
    const blob = Buffer.from(text + '\0', 'utf16le')
    const pdu = Buffer.alloc(18 + blob.length)
    pdu.writeUInt32LE(pdu.length, 0)        // cbSize
    pdu.writeUInt32LE(0, 4)                 // Flags
    pdu.writeUInt32LE(2, 8)                 // Version
    pdu.writeUInt32LE(0, 12)                // Id
    pdu.writeUInt16LE(blob.length / 2, 16)  // cchPCB, with the terminator
    blob.copy(pdu, 18)
    return pdu
}

function encodeError (): Buffer {
    return seq(explicit(0, derInteger(VERSION_1)), explicit(1, seq(explicit(0, derInteger(GENERAL_ERROR)))))
}

// ---- upstream handshake ------------------------------------------------------------------------

// Reads exactly one TPKT-framed PDU (the X.224 Connection Confirm) without consuming TLS bytes.
function readTpkt (stream: Duplex): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const acc = new ByteQueue()
        const cleanup = () => {
            stream.off('data', onData)
            stream.off('error', onError)
            stream.off('close', onClose)
            stream.off('end', onClose)
        }
        const onError = (e: Error) => { cleanup(); reject(e) }
        const onClose = () => { cleanup(); reject(new Error('upstream closed during X.224')) }
        const onData = (chunk: Buffer) => {
            acc.push(chunk)
            if (acc.length < 4) {
                return
            }
            const header = acc.peek(4)
            const len = header.readUInt16BE(2)
            // TPKT is version 3, and an X.224 TPDU takes three bytes at least: anything else is not an RDP server
            // answering (a web server on that port, say), and isn't waited on for the length it seems to give.
            if (header[0] !== 3 || len < 7) {
                cleanup()
                reject(new Error('the server\'s answer isn\'t RDP (is that the desktop\'s port?)'))
                return
            }
            if (acc.length < len) {
                return
            }
            stream.pause()
            cleanup()
            // A copy: it is kept for the connection, and is a few bytes of the queue's storage.
            const pdu = Buffer.from(acc.take(len))
            if (acc.length) {
                stream.unshift(acc.take(acc.length))
            }
            resolve(pdu)
        }
        stream.on('data', onData)
        stream.on('error', onError)
        stream.on('close', onClose)
        // An SSH channel says when the server has closed its side ("end") without always saying it is closed.
        stream.on('end', onClose)
    })
}

function certChainOf (socket: tls.TLSSocket): Buffer[] {
    const chain: Buffer[] = []
    let cert: any = socket.getPeerCertificate(true)
    const seen = new Set<string>()
    while (cert?.raw && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256)
        chain.push(cert.raw)
        cert = cert.issuerCertificate
    }
    return chain
}

/** selectedProtocol's flags in the server's negotiation response (RDP_NEG_RSP). */
const PROTOCOL_HYBRID = 0x02
const PROTOCOL_HYBRID_EX = 0x08

/**
 * The security protocol the server chose (RDP_NEG_RSP's selectedProtocol), or 0 when its answer to the connection
 * request has no negotiation response. Tested by its flags, as IronRDP does, so that the proxy and the client never
 * read the same answer differently.
 */
function selectedProtocol (x224: Buffer): number {
    return x224.length >= 19 && x224[11] === 0x02 ? x224.readUInt32LE(15) : 0
}

/**
 * Whether the server's answer to the connection request chose Network Level Authentication (CredSSP: HYBRID or
 * HYBRID_EX). With it, the sign-in is a proof both ways and the password only goes to a server that knows it already.
 * Without it (plain TLS, as xrdp does), the client sends the password itself in its Client Info PDU: encrypted on the
 * way, readable to whatever answered.
 */
export function offersNla (x224: Buffer): boolean {
    return (selectedProtocol(x224) & (PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX)) !== 0
}

/**
 * Whether an Early User Authorization Result follows CredSSP: the server chose HYBRID_EX (see serverFraming). IronRDP
 * expects one whenever that flag is set, alone or not.
 */
export function earlyUserAuthorization (x224: Buffer): boolean {
    return (selectedProtocol(x224) & PROTOCOL_HYBRID_EX) !== 0
}

/** The routing cookie that names the user (see withoutUserCookie). */
const COOKIE = Buffer.from('Cookie: mstshash=')

/**
 * The client's X.224 connection request without its routing cookie, `Cookie: mstshash=<user name>`, which IronRDP fills
 * in with the user name. It goes before TLS, in the clear, and before the certificate check and the stop at a server
 * without Network Level Authentication: the account's name would reach whoever watches the way there, and servers the
 * proxy then refuses. The cookie is optional, and what it is for, routing by user name in a load balancer in front of
 * several servers, the plugin doesn't take part in (it sends no load-balancing info either). A request that isn't a
 * connection request with such a cookie comes back as it is; so does a broker's routing token (`Cookie: msts=`), which
 * names no user. The proxy sends none that still has the cookie (see handshake).
 */
export function withoutUserCookie (request: Buffer): Buffer {
    // TPKT (4: version 3, 0, length), then X.224: length indicator (the rest of the header), the CR code, DST-REF,
    // SRC-REF and class (6), then the cookie, the negotiation request and the rest.
    const li = request[4]
    if (request.length < 11 + COOKIE.length || request[0] !== 3 || request.readUInt16BE(2) !== request.length ||
        (request[5] & 0xf0) !== 0xe0 || 5 + li !== request.length || !request.subarray(11, 11 + COOKIE.length).equals(COOKIE)) {
        return request
    }
    const end = request.indexOf('\r\n', 11 + COOKIE.length)
    if (end < 0) {
        return request
    }
    const cut = end + 2 - 11
    const out = Buffer.concat([request.subarray(0, 11), request.subarray(end + 2)])
    out.writeUInt16BE(request.length - cut, 2)
    out[4] = li - cut
    return out
}

/**
 * The server's answer to the client's security negotiation, when it rules out TLS (which IronRDP and RDCleanPath
 * need): a server with RDP's standard security only (xrdp with security_layer=rdp, for example) answers without a
 * negotiation response, or with PROTOCOL_RDP, or refuses the negotiation. Null when TLS can go ahead.
 */
function noTls (x224: Buffer): string | null {
    // TPKT (4), X.224 Connection Confirm (7), then RDP_NEG_RSP or RDP_NEG_FAILURE (8): type, flags, length, value.
    const standardOnly = 'the RDP server only offers standard RDP security, without TLS (for xrdp: set security_layer=negotiate in /etc/xrdp/xrdp.ini and restart xrdp)'
    if (x224.length < 19) {
        return standardOnly
    }
    const type = x224[11]
    const value = x224.readUInt32LE(15)
    if (type === 0x02) {
        return value === 0 ? standardOnly : null
    }
    if (type === 0x03) {
        switch (value) {
            case 2: return standardOnly  // SSL_NOT_ALLOWED_BY_SERVER
            case 3: return 'the RDP server has no TLS certificate (for xrdp: see certificate= and key_file= in /etc/xrdp/xrdp.ini)'
            default: return `the RDP server refused the security negotiation (code ${value})`
        }
    }
    return null
}

/**
 * xrdp signs in with the Client Info PDU's credentials only when its INFO_AUTOLOGON flag is set, and otherwise shows
 * its own login window; IronRDP's web client never sets it. The proxy has the client's side in the clear (it does
 * the TLS), so it sets the flag in that one PDU, in place, and passes everything else through untouched.
 * Returns a function from client data to what goes upstream.
 */
function autologon (): (data: Buffer) => Buffer {
    const INFO_AUTOLOGON = 0x08
    const SEC_INFO_PKT = 0x40
    let pending = Buffer.alloc(0)
    let done = false
    // TPKT (4), X.224 Data (3: 02 f0 80), MCS Send Data Request (0x64, initiator 2, channel 2, priority 1, PER length
    // 1 or 2), basic security header (flags 2 with SEC_INFO_PKT, flagsHi 2), then TS_INFO_PACKET: CodePage 4, flags 4.
    const patch = (pdu: Buffer): boolean => {
        if (pdu.length < 14 || pdu[4] !== 0x02 || pdu[5] !== 0xf0 || pdu[7] >> 2 !== 25) {
            return false
        }
        const sec = 13 + (pdu[13] & 0x80 ? 2 : 1)
        if (pdu.length < sec + 12 || !(pdu.readUInt16LE(sec) & SEC_INFO_PKT)) {
            return false
        }
        const flags = sec + 4 + 4
        pdu.writeUInt32LE((pdu.readUInt32LE(flags) | INFO_AUTOLOGON) >>> 0, flags)
        return true
    }
    return data => {
        if (done) {
            return data
        }
        pending = Buffer.concat([pending, data])  // a copy: patched in place
        let p = 0
        // Whole TPKT frames; a partial one waits for the rest. Anything else (fast-path input) means the connection
        // sequence, and with it the Client Info PDU, is over.
        while (pending.length - p >= 4) {
            if (pending[p] !== 0x03) {
                done = true
                break
            }
            const length = pending.readUInt16BE(p + 2)
            if (length < 4 || pending.length - p < length) {
                break
            }
            done = patch(pending.subarray(p, p + length))
            p += length
            if (done) {
                break
            }
        }
        const out = done ? pending : pending.subarray(0, p)
        pending = done ? Buffer.alloc(0) : pending.subarray(p)
        return out
    }
}

/**
 * Splits what the server sends into whole PDUs, one per WebSocket message. IronRDP's web client drops whatever else a
 * message holds at the end of the connection sequence (it hands its session reader the bare stream, without the
 * framer's leftovers): when GNOME sent the last activation PDU and the start of dynamic-channel negotiation in one
 * read, the graphics channel never opened and the desktop stayed blank, typically after a reconnect. So messages
 * follow PDU boundaries, not TLS records or SSH reads. Before RDP there can be CredSSP's DER messages and, with
 * HYBRID_EX (`earlyAuth`), a four-byte Early User Authorization Result; after that, TPKT and fast-path. Returns a
 * function from server data to the PDUs it completes; it throws on data that is none of these.
 */
export function serverFraming (earlyAuth: boolean): (data: Buffer) => Buffer[] {
    // A server's CredSSP messages are small: its NTLM challenge or Kerberos reply, and its proof of the public key, a
    // few kilobytes at most. A larger claim is no server's: it would only have Tabby keep whatever comes, and wait.
    const MAX_DER = 256 * 1024
    let rdp = false
    const pending = new ByteQueue()
    const invalid = () => new Error('invalid RDP server frame')
    /** The length of the PDU at the start of `b`, 0 while its header is incomplete. */
    const lengthOf = (b: Buffer): number => {
        if (b.length < 2) {
            return 0
        }
        if (!rdp && b[0] === 0x30) {
            if (!(b[1] & 0x80)) {
                return 2 + b[1]
            }
            const octets = b[1] & 0x7f
            if (octets === 0 || octets > 4) {
                throw invalid()
            }
            if (b.length < 2 + octets) {
                return 0
            }
            const content = b.readUIntBE(2, octets)
            if (content > MAX_DER) {
                throw invalid()
            }
            return 2 + octets + content
        }
        if (!rdp && earlyAuth) {
            return 4
        }
        if (b[0] === 0x03) {
            if (b[1] !== 0) {
                throw invalid()
            }
            if (b.length < 4) {
                return 0
            }
            const length = b.readUInt16BE(2)
            if (length < 4) {
                throw invalid()
            }
            return length
        }
        if (rdp && !(b[0] & 0x03)) {
            if (!(b[1] & 0x80)) {
                if (b[1] < 2) {
                    throw invalid()
                }
                return b[1]
            }
            if (b.length < 3) {
                return 0
            }
            const length = ((b[1] & 0x7f) << 8) | b[2]
            if (length < 3) {
                throw invalid()
            }
            return length
        }
        throw invalid()
    }
    return data => {
        pending.push(data)
        const out: Buffer[] = []
        for (;;) {
            // Six bytes hold any of these headers: DER's tag and length with up to four length octets.
            const head = pending.peek(6)
            const length = lengthOf(head)
            if (!length || pending.length < length) {
                break
            }
            if (!rdp && earlyAuth && head[0] !== 0x30) {
                earlyAuth = false
            } else if (head[0] === 0x03) {
                rdp = true
            }
            out.push(pending.take(length))
        }
        return out
    }
}

// ---- proxy -------------------------------------------------------------------------------------

/**
 * TLS for servers whose certificate only allows key encipherment, like Windows' self-signed RDP certificate.
 * BoringSSL (Electron) enforces the certificate's key usage, and every ECDHE or TLS 1.3 handshake needs the
 * digital-signature bit, so only TLS 1.2 with RSA key exchange works with such a certificate (other RDP
 * clients use OpenSSL, which doesn't enforce it).
 */
const KEY_ENCIPHERMENT_ONLY_TLS: tls.ConnectionOptions = {
    maxVersion: 'TLSv1.2',
    ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256',
}

/**
 * The TLS library turned the server's certificate down for its key usage, the one failure KEY_ENCIPHERMENT_ONLY_TLS is
 * for. Known by the library's own reason (Node's code is made from it), never by an error's text: that can carry what
 * a gateway or an SSH host put in it, which would take forward secrecy away from a server that has no need to lose it.
 * And only when the TLS socket raised it itself: an error the stream under it failed with reaches the TLS socket as it
 * is, code and all (Electron's BoringSSL raises its own refusal with that stream untouched).
 */
class KeyUsageRefused extends Error { }

const isKeyUsageRefusal = (e: any) => e?.code === 'ERR_SSL_KEY_USAGE_BIT_INCORRECT' || e?.reason === 'KEY_USAGE_BIT_INCORRECT'

const KEY_USAGE = Buffer.from([0x55, 0x1d, 0x0f])  // the key usage extension's OID, 2.5.29.15

/**
 * Whether a certificate (DER) shows that it leaves digital signatures out of its key usage, as Windows' self-signed RDP
 * certificate does (key and data encipherment only): the certificates KEY_ENCIPHERMENT_ONLY_TLS is for. False for one
 * that allows them, has no key usage at all (anything goes), or can't be read here: the fallback, which gives up
 * forward secrecy, is only for a certificate shown to need it.
 */
export function signsNothing (der: Buffer): boolean {
    const at = (offset: number, end: number): Tlv => {
        const t = readTlv(der, offset)
        if (!t || t.end > end) {
            throw new Error('not DER')
        }
        return t
    }
    const children = (parent: Tlv): Tlv[] => {
        const list: Tlv[] = []
        for (let p = parent.start; p < parent.end; p = list[list.length - 1].end) {
            list.push(at(p, parent.end))
        }
        return list
    }
    try {
        // Certificate: SEQUENCE { tbsCertificate: SEQUENCE { ..., extensions: [3] { SEQUENCE OF Extension } }, ... }
        const certificate = at(0, der.length)
        for (const field of children(at(certificate.start, certificate.end))) {
            if (field.tag !== 0xa3) {
                continue
            }
            for (const extension of children(at(field.start, field.end))) {
                // Extension: SEQUENCE { extnID OID, critical BOOLEAN (optional), extnValue OCTET STRING }
                const [id, ...rest] = children(extension)
                if (id.tag === 0x06 && der.subarray(id.start, id.end).equals(KEY_USAGE)) {
                    const value = rest[rest.length - 1]
                    const bits = at(value.start, value.end)
                    if (bits.tag !== 0x03) {
                        throw new Error('not a key usage')
                    }
                    // A BIT STRING: the count of unused bits, then the bits; digitalSignature is the first.
                    return bits.end - bits.start < 2 || !(der[bits.start + 1] & 0x80)
                }
            }
        }
        return false
    } catch {
        return false
    }
}

class NoTlsError extends Error { }

/** The client's first message (the RDCleanPath request: a destination, a token, an X.224 request) is small. */
const MAX_HELLO = 64 * 1024
/** How long a client has to send it, and how long the server has to answer X.224 and TLS. */
const HELLO_TIMEOUT_MS = 10_000
const HANDSHAKE_TIMEOUT_MS = 45_000
/** What the client may send ahead while the server is being reached (CredSSP hasn't started: next to nothing). */
const MAX_EARLY = 256 * 1024
/** One client at a time uses a proxy; a reconnect can overlap the connection it replaces. */
const MAX_CLIENTS = 4
/** A WebSocket message from the client: RDP PDUs, at most a few megabytes for a shared drive's read. */
const MAX_MESSAGE = 32 * 1024 * 1024
/** Data waiting for the other side past this pauses the side it comes from, until half of it is gone. */
const HIGH_WATER = 8 * 1024 * 1024

/**
 * Sends the client's X.224 request upstream, reads the confirm, then does TLS there. With a pre-connection blob, that
 * goes first; without an X.224 request (a Hyper-V VM's console), TLS follows the blob at once and X.224 is the
 * client's to do later. `track` hears of each stream as soon as it exists, so the caller can end them if the client
 * goes away meanwhile; `gone` says it has, and `signal` aborts then, for the factory that opens the first stream (which
 * `track` only hears of once it is open).
 */
async function handshake (
    openUpstream: UpstreamFactory, destination: string, pcb: string | undefined, x224Request: Buffer | undefined, legacyTls: boolean,
    track: (stream: Duplex) => void, gone: () => boolean, withoutNla: () => void | Promise<void>, options: Pick<RDCleanPathOptions, 'serverName' | 'tls'>,
    signal?: AbortSignal,
): Promise<{ raw: Duplex, upstream: tls.TLSSocket, x224: Buffer | null }> {
    // Without the user name IronRDP puts in it. A request that still names one after that (its form not the one
    // withoutUserCookie knows) goes nowhere: the name isn't to reach the server before it is checked.
    const request = x224Request && withoutUserCookie(x224Request)
    if (request?.includes(COOKIE)) {
        throw new Error('the connection request carries the user name in a form the proxy can\'t take it out of')
    }
    const raw = await openUpstream(destination, signal)
    track(raw)
    try {
        if (gone()) {
            throw new Error('the client left')
        }
        if (pcb) {
            raw.write(preconnectionPdu(pcb))
        }
        let x224: Buffer | null = null
        if (request) {
            raw.write(request)
            x224 = await readTpkt(raw)
            const refused = noTls(x224)
            if (refused) {
                throw new NoTlsError(refused)
            }
            // Before TLS: a server that isn't to get the password gets nothing more at all.
            if (!offersNla(x224)) {
                await withoutNla()
            }
        }
        // With a name, the certificate is checked against it (an address against the certificate's addresses; it goes
        // without SNI, which only takes names), the authorities and its dates. Whatever the outcome, the handshake
        // completes: the certificate check decides.
        const name = options.serverName
        const upstream = tls.connect({
            socket: raw as any, rejectUnauthorized: false,
            ...name ? { host: name, ca: certificateAuthorities(), ...isIP(name) ? {} : { servername: name } } : {},
            ...legacyTls ? KEY_ENCIPHERMENT_ONLY_TLS : {}, ...options.tls,
        })
        track(upstream)
        // An error after the one the handshake below waits for (the stream under it failing as the socket is destroyed,
        // which a TLS socket over a stream passes on as its own) would have no listener until the relay is up, and an
        // 'error' without one is an uncaught exception in Tabby's window. The relay listens for its own.
        upstream.on('error', () => { })
        await new Promise<void>((resolve, reject) => {
            upstream.once('secureConnect', resolve)
            // TLS's own refusal only: not an error of the stream under it (raw.errored), whatever its code.
            upstream.once('error', e => reject(isKeyUsageRefusal(e) && !raw.errored ? new KeyUsageRefused(e.message) : e))
            upstream.once('close', () => reject(new Error('upstream closed during TLS')))
            upstream.once('end', () => reject(new Error('upstream closed during TLS')))
        })
        return { raw, upstream, x224 }
    } catch (e) {
        raw.destroy()
        throw e
    }
}

/** Whether `given` is the secret, compared in a time that doesn't tell how much of it was right. */
function sameSecret (given: string, secret: Buffer): boolean {
    const bytes = Buffer.from(given)
    return bytes.length === secret.length && timingSafeEqual(bytes, secret)
}

/**
 * The Origin a client may say it comes from: none (not a browser's page), or a file's page, as Tabby's window is (its
 * WebSockets carry `Origin: file://`). Not a web page (`http:`, `https:`), a sandboxed or otherwise opaque one (`null`),
 * or a browser extension's.
 */
const ALLOWED_ORIGINS = [undefined, 'file://']

/**
 * `text` without the proxy's token. IronRDP's error for an address it couldn't connect to names the address, whose path
 * is the token, and such an error goes to the desktop's status line and its log, which "Copy log" hands out.
 */
export function withoutToken (text: string, proxy: { token: string } | null | undefined): string {
    return proxy?.token ? text.split(proxy.token).join('…') : text
}

export async function startRDCleanPathProxy (openUpstream: UpstreamFactory, checkCertificate: CertificateCheck, log: (msg: string) => void = () => {}, options: RDCleanPathOptions = { withoutNla: refuseWithoutNla }): Promise<RDCleanPathProxy> {
    // Called from JavaScript without the decision, the proxy still refuses such servers rather than let them through.
    if (typeof options.withoutNla !== 'function') {
        options = { ...options, withoutNla: refuseWithoutNla }
    }
    const token = randomBytes(24).toString('hex')
    // The client shows it twice: as its address's path, before it is let in at all, and in its request.
    const path = Buffer.from(`/${token}`)
    const secret = Buffer.from(token)
    let failure: string | null = null
    // Set once a connection showed that the server needs KEY_ENCIPHERMENT_ONLY_TLS (its handshake fell back, and the
    // certificate leaves signatures out and was accepted). The next connection starts with it and clears it, to set it
    // again once it has shown the same: one that doesn't get that far, whatever stops it (a failure, the server not
    // answering in time, the client leaving), or that finds a certificate that doesn't need it, leaves it cleared.
    let legacyTls = false
    const stats = { bytesIn: 0, bytesOut: 0 }
    // The room (see ServerFlow): what was taken for answers and not read from the connection since, the client whose
    // connection that is (the latest to reach the relay: a reconnect can overlap the connection it replaces), and what
    // waits for room. Once the proxy is closed there is room for good: nothing more goes anywhere.
    let owed = 0
    let flowClient: unknown = null
    let roomWaiters: (() => void)[] = []
    let shut = false
    const hasRoom = () => shut || owed < FLOW_WINDOW
    const roomMade = () => {
        if (roomWaiters.length && hasRoom()) {
            const go = roomWaiters
            roomWaiters = []
            go.forEach(f => f())
        }
    }
    const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        maxPayload: MAX_MESSAGE,
        // Anything on this computer can reach the port, and so can a web page in a browser. A connection without the
        // token is turned away before it takes one of the few places, which the desktop's own client would then find
        // taken; and one from a page other than a file's, as Tabby's window is, is turned away whatever it has.
        verifyClient: ({ req }: { req: IncomingMessage }) => ALLOWED_ORIGINS.includes(req.headers.origin) && sameSecret(req.url ?? '', path),
    })
    await new Promise<void>((resolve, reject) => {
        wss.once('listening', resolve)
        wss.once('error', reject)
    })
    wss.on('error', (e: Error) => log(`proxy: ${e.message}`))

    wss.on('connection', (ws: any) => {
        // Only a client that knows the token gets here (see verifyClient), and then only as far as its first message
        // (which has to be small and arrive soon) until that shows the token too.
        if (wss.clients.size > MAX_CLIENTS) {
            ws.terminate()
            return
        }
        let buf = Buffer.alloc(0)
        let stage: 'hello' | 'handshake' | 'relay' = 'hello'
        const early: Buffer[] = []
        let earlySize = 0
        let upstream: tls.TLSSocket | null = null
        let closed = false
        // Aborts when the client has gone, for an upstream still being opened, which isn't among the streams yet.
        const leaving = new AbortController()
        // Every stream opened for this client, from the moment it exists: ended with the client.
        const streams = new Set<Duplex>()
        const track = (stream: Duplex) => {
            streams.add(stream)
            stream.once('close', () => streams.delete(stream))
            if (closed) {
                stream.destroy()
            }
        }
        const end = () => {
            closed = true
            leaving.abort()
            clearTimeout(deadline)
            for (const stream of streams) {
                stream.destroy()
            }
            // What was handed to this connection went with it: the next starts with all the room.
            if (flowClient === ws) {
                flowClient = null
                owed = 0
                roomMade()
            }
        }
        let deadline = setTimeout(() => stage === 'hello' && ws.terminate(), HELLO_TIMEOUT_MS)
        const toServer = options.autologon ? autologon() : (data: Buffer) => data
        const send = (data: Buffer) => {
            const out = toServer(data)
            // The server (or the SSH channel to it) not keeping up: stop reading from the client until it has (see
            // ServerFlow).
            if (out.length && !upstream!.write(out) && upstream!.writableLength > HIGH_WATER) {
                ws.pause()
                upstream!.once('drain', () => ws.resume())
            }
        }
        failure = null

        const fail = (why: string) => {
            failure = why
            log(`RDCleanPath failed: ${why}`)
            try { ws.send(encodeError()) } catch { }
            ws.close()
            end()
        }

        ws.on('error', (e: Error) => {
            log(`proxy: client: ${e.message}`)
            ws.terminate()
            end()
        })
        ws.on('message', async (data: Buffer) => {
            if (stage === 'relay') {
                stats.bytesOut += data.length
                // Read from the connection: as much room again (see ServerFlow).
                if (flowClient === ws) {
                    owed = Math.max(0, owed - data.length)
                    roomMade()
                }
                send(data)
                return
            }
            if (stage === 'handshake') {
                earlySize += data.length
                if (earlySize > MAX_EARLY) {
                    return fail('the client sent too much before the server was reached')
                }
                early.push(data)
                return
            }
            // Before the token is checked: no more than a request's worth is kept, whatever length it claims.
            if (buf.length + data.length > MAX_HELLO) {
                ws.terminate()
                return
            }
            buf = Buffer.concat([buf, data])
            const outer = readTlv(buf, 0)
            if (!outer || buf.length < outer.end) {
                return
            }
            stage = 'handshake'
            clearTimeout(deadline)
            try {
                const req = decodeRequest(buf.subarray(0, outer.end))
                buf = Buffer.alloc(0)
                if (req.version !== VERSION_1 || !req.destination || !req.x224 && !req.pcb?.trim()) {
                    return fail('malformed request')
                }
                if (!sameSecret(req.proxyAuth ?? '', secret)) {
                    return fail('bad token')
                }
                deadline = setTimeout(() => stage === 'handshake' && fail('the server didn\'t answer in time'), options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
                // Whether this connection uses KEY_ENCIPHERMENT_ONLY_TLS, and whether it came to it by falling back
                // (rather than starting with it, as remembered): kept here until the connection shows it was needed.
                // Taken from legacyTls, which stays cleared until then: a server that hangs, or a client that leaves
                // meanwhile, has the next connection try modern TLS first, as one whose handshake fails does.
                let legacy = legacyTls
                legacyTls = false
                let fellBack = false
                let up: Awaited<ReturnType<typeof handshake>>
                try {
                    up = await handshake(openUpstream, req.destination, req.pcb, req.x224, legacy, track, () => closed, options.withoutNla, options, leaving.signal)
                } catch (e: any) {
                    if (closed || legacy || !(e instanceof KeyUsageRefused)) {
                        throw e
                    }
                    // The X.224 exchange is spent on that connection: start over on a fresh one.
                    log('TLS: the server certificate only allows key encipherment; using TLS 1.2 with RSA key exchange')
                    legacy = fellBack = true
                    up = await handshake(openUpstream, req.destination, req.pcb, req.x224, legacy, track, () => closed, options.withoutNla, options, leaving.signal)
                }
                // Reached: from here on the time is the user's (a certificate to look at) and the session's.
                clearTimeout(deadline)
                if (closed) {
                    return
                }
                upstream = up.upstream
                const x224 = up.x224
                // Both handshakes above, the first and the legacy-TLS retry, end here: the certificate is checked
                // before the client gets the response it waits for to start CredSSP, and before anything it sent
                // early goes upstream.
                const chain = certChainOf(upstream)
                if (!chain.length) {
                    return fail('the server sent no certificate')
                }
                // RSA key exchange, without forward secrecy, only for a certificate shown to leave no better choice. One
                // that doesn't show it, after a handshake that failed as if it did, means something on the way made
                // that failure up; after one that started with it as remembered, that the certificate changed. Either
                // way the next connection starts without the fallback.
                if (legacy && !signsNothing(chain[0])) {
                    legacyTls = false
                    return fail(fellBack
                        ? 'the server\'s certificate doesn\'t show a need for the fallback to TLS 1.2 with RSA key exchange (no forward secrecy) that this connection made: something on the way may be interfering with TLS'
                        : 'the server\'s certificate changed, and no longer needs TLS 1.2 with RSA key exchange: the next connection uses modern TLS')
                }
                // Valid only as checked against a name: without one, Node checks against "localhost".
                const valid = !!options.serverName && upstream.authorized
                const reason = valid ? '' : options.serverName ? String(upstream.authorizationError ?? '') : ''
                // Where the chain stands and whether it is for the name, which Node's code for why it isn't valid can
                // hide (see certificateDetails), by the authorities the handshake was checked against.
                const peer = upstream.getPeerCertificate(true)
                const checked = options.serverName && !valid ? { name: options.serverName, authorities: options.tls?.ca ?? certificateAuthorities(), reason } : undefined
                await checkCertificate(fingerprintOf(chain[0]), valid, reason, certificateDetails(peer, checked))
                if (closed) {
                    return
                }
                // Remembered only now: the handshake worked, with a certificate that needs it and that was accepted.
                legacyTls = legacy
                // A server without NLA, let through before TLS: what let it through is held to its certificate.
                if (x224 && !offersNla(x224) && options.withoutNlaCertificate) {
                    await options.withoutNlaCertificate(fingerprintOf(chain[0]))
                    if (closed) {
                        return
                    }
                }
                ws.send(encodeResponse(x224, chain, req.destination))
                stage = 'relay'
                // The room is this connection's from now on, all of it (see ServerFlow).
                flowClient = ws
                owed = 0
                roomMade()
                // PROTOCOL_HYBRID_EX in the server's negotiation response: an Early User Authorization Result follows CredSSP.
                // (A Hyper-V VM's console: CredSSP first, then the X.224 exchange, which never asks for HYBRID_EX.)
                const frames = serverFraming(!!x224 && earlyUserAuthorization(x224))
                upstream.on('data', (d: Buffer) => {
                    stats.bytesIn += d.length
                    let pdus: Buffer[]
                    try {
                        pdus = frames(d)
                    } catch (e: any) {
                        log(`upstream: ${e.message}`)
                        ws.close()
                        upstream?.destroy()
                        return
                    }
                    for (const pdu of pdus) {
                        ws.send(pdu)
                    }
                    // The client not keeping up: stop reading from the server until it has taken half of it.
                    if (ws.bufferedAmount > HIGH_WATER && !upstream!.isPaused()) {
                        upstream!.pause()
                        const wait = setInterval(() => {
                            if (closed || ws.bufferedAmount < HIGH_WATER / 2) {
                                clearInterval(wait)
                                upstream?.resume()
                            }
                        }, 50)
                    }
                })
                upstream.on('close', () => ws.close())
                // The server closing its side is the end of the desktop: RDP has no use for a connection open one way.
                // Through an SSH host that is all there may be to hear (the channel reports the end, and "closed" only
                // once something more is sent into it), and a desktop waiting for "closed" stayed up, frozen.
                upstream.on('end', () => {
                    ws.close()
                    upstream?.destroy()
                })
                upstream.on('error', (e: Error) => { log(`upstream error: ${e.message}`); ws.close() })
                for (const d of early) {
                    stats.bytesOut += d.length
                    send(d)
                }
                log(`RDCleanPath relay up to ${req.destination}`)
            } catch (e: any) {
                if (!closed) {
                    fail(e?.message ?? String(e))
                }
            }
        })
        ws.on('close', end)
    })

    const { port } = wss.address() as AddressInfo
    return {
        url: `ws://127.0.0.1:${port}/${token}`,
        token,
        stats,
        get failure () { return failure },
        close: () => {
            // Stops listening, and ends the clients there are: close() alone waits for them.
            wss.close()
            for (const client of wss.clients) {
                client.terminate()
            }
            // Nothing more goes to the server: what waited for room goes on, and finds the end.
            shut = true
            owed = 0
            roomMade()
        },
        room: hasRoom,
        // Counted only as a number of bytes: anything else would leave the room unknown, and every answer waiting.
        spend: (bytes: number) => {
            if (bytes > 0) {
                owed += bytes
            }
        },
        refund: (bytes: number) => {
            if (bytes > 0) {
                owed = Math.max(0, owed - bytes)
                roomMade()
            }
        },
        whenRoom: () => hasRoom() ? Promise.resolve() : new Promise<void>(resolve => roomWaiters.push(resolve)),
    }
}
