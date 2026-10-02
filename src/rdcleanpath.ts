// RDCleanPath proxy for the IronRDP web client, running inside Tabby's renderer.
// The WASM client talks WebSocket to this proxy; the proxy opens the upstream stream
// (a plain socket here, an SSH direct-tcpip channel later), forwards the X.224 request,
// terminates TLS, checks the server's certificate, hands the cert chain back to the client (for CredSSP), then relays.
import * as tls from 'tls'
import { createHash, randomBytes } from 'crypto'
import { Duplex } from 'stream'
import { AddressInfo } from 'net'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WebSocketServer } = require('ws')

const VERSION_1 = 3390
const GENERAL_ERROR = 1

export type UpstreamFactory = (destination: string) => Promise<Duplex>

/**
 * Decides on the server's certificate, given its SHA-256 fingerprint (`AB:CD:…`); throws to refuse it. Upstream TLS
 * accepts any certificate (RDP servers are self-signed), so this is what stands between the client and an impostor.
 * It runs before the client hears back from the proxy, and so before CredSSP: no credentials have been sent yet.
 */
export type CertificateCheck = (fingerprint: string) => void | Promise<void>

/** A SHA-256 fingerprint as `AB:CD:…` (openssl and Node print it so), from any hex spelling; '' if it isn't one. */
export function normalizeFingerprint (value: string): string {
    const hex = String(value ?? '').replace(/[\s:]/g, '').toUpperCase()
    return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(':') : ''
}

function fingerprintOf (der: Buffer): string {
    return normalizeFingerprint(createHash('sha256').update(der).digest('hex'))
}

export interface RDCleanPathProxy {
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

export interface RDCleanPathOptions {
    /** Set INFO_AUTOLOGON in the client's Client Info PDU (xrdp; see autologon()). */
    autologon?: boolean
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

interface Request { version?: number, destination?: string, proxyAuth?: string, x224?: Buffer }

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
            case 6: req.x224 = Buffer.from(value); break
        }
        p = field.end
    }
    return req
}

function encodeResponse (x224: Buffer, certChain: Buffer[], serverAddr: string): Buffer {
    return seq(
        explicit(0, derInteger(VERSION_1)),
        explicit(6, octets(x224)),
        explicit(7, seq(...certChain.map(octets))),
        explicit(9, utf8(serverAddr)),
    )
}

function encodeError (): Buffer {
    return seq(explicit(0, derInteger(VERSION_1)), explicit(1, seq(explicit(0, derInteger(GENERAL_ERROR)))))
}

// ---- upstream handshake ------------------------------------------------------------------------

// Reads exactly one TPKT-framed PDU (the X.224 Connection Confirm) without consuming TLS bytes.
function readTpkt (stream: Duplex): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let acc = Buffer.alloc(0)
        const cleanup = () => {
            stream.off('data', onData)
            stream.off('error', onError)
            stream.off('close', onClose)
        }
        const onError = (e: Error) => { cleanup(); reject(e) }
        const onClose = () => { cleanup(); reject(new Error('upstream closed during X.224')) }
        const onData = (chunk: Buffer) => {
            acc = Buffer.concat([acc, chunk])
            if (acc.length < 4) {
                return
            }
            const len = acc.readUInt16BE(2)
            if (acc.length < len) {
                return
            }
            stream.pause()
            cleanup()
            if (acc.length > len) {
                stream.unshift(acc.subarray(len))
            }
            resolve(acc.subarray(0, len))
        }
        stream.on('data', onData)
        stream.on('error', onError)
        stream.on('close', onClose)
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
    const MAX_DER = 16 * 1024 * 1024
    let rdp = false
    let pending: Buffer = Buffer.alloc(0)
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
        pending = pending.length ? Buffer.concat([pending, data]) : data
        const out: Buffer[] = []
        for (;;) {
            const length = lengthOf(pending)
            if (!length || pending.length < length) {
                break
            }
            if (!rdp && earlyAuth && pending[0] !== 0x30) {
                earlyAuth = false
            } else if (pending[0] === 0x03) {
                rdp = true
            }
            out.push(pending.subarray(0, length))
            pending = pending.subarray(length)
        }
        // A copy of the rest: it would otherwise keep the whole chunk it came in alive.
        pending = Buffer.from(pending)
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

class NoTlsError extends Error { }

/** Sends the client's X.224 request upstream, reads the confirm, then does TLS there. */
async function handshake (openUpstream: UpstreamFactory, destination: string, x224Request: Buffer, legacyTls: boolean): Promise<{ raw: Duplex, upstream: tls.TLSSocket, x224: Buffer }> {
    const raw = await openUpstream(destination)
    try {
        raw.write(x224Request)
        const x224 = await readTpkt(raw)
        const refused = noTls(x224)
        if (refused) {
            throw new NoTlsError(refused)
        }
        const upstream = tls.connect({ socket: raw as any, rejectUnauthorized: false, ...legacyTls ? KEY_ENCIPHERMENT_ONLY_TLS : {} })
        await new Promise<void>((resolve, reject) => {
            upstream.once('secureConnect', resolve)
            upstream.once('error', reject)
        })
        return { raw, upstream, x224 }
    } catch (e) {
        raw.destroy()
        throw e
    }
}

export async function startRDCleanPathProxy (openUpstream: UpstreamFactory, checkCertificate: CertificateCheck, log: (msg: string) => void = () => {}, options: RDCleanPathOptions = {}): Promise<RDCleanPathProxy> {
    const token = randomBytes(24).toString('hex')
    let failure: string | null = null
    // Set once the server turned out to need KEY_ENCIPHERMENT_ONLY_TLS; later connections start with it.
    let legacyTls = false
    const stats = { bytesIn: 0, bytesOut: 0 }
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve, reject) => {
        wss.once('listening', resolve)
        wss.once('error', reject)
    })

    wss.on('connection', (ws: any) => {
        let buf = Buffer.alloc(0)
        let stage: 'hello' | 'handshake' | 'relay' = 'hello'
        const early: Buffer[] = []
        let upstream: tls.TLSSocket | null = null
        let raw: Duplex | null = null
        const toServer = options.autologon ? autologon() : (data: Buffer) => data
        const send = (data: Buffer) => {
            const out = toServer(data)
            if (out.length) {
                upstream!.write(out)
            }
        }
        failure = null

        const fail = (why: string) => {
            failure = why
            log(`RDCleanPath failed: ${why}`)
            try { ws.send(encodeError()) } catch { }
            ws.close()
            upstream?.destroy()
            raw?.destroy()
        }

        ws.on('message', async (data: Buffer) => {
            if (stage === 'relay') {
                stats.bytesOut += data.length
                send(data)
                return
            }
            if (stage === 'handshake') {
                early.push(data)
                return
            }
            buf = Buffer.concat([buf, data])
            const outer = readTlv(buf, 0)
            if (!outer || buf.length < outer.end) {
                return
            }
            stage = 'handshake'
            try {
                const req = decodeRequest(buf.subarray(0, outer.end))
                if (req.version !== VERSION_1 || !req.x224 || !req.destination) {
                    return fail('malformed request')
                }
                if (req.proxyAuth !== token) {
                    return fail('bad token')
                }
                let up: Awaited<ReturnType<typeof handshake>>
                try {
                    up = await handshake(openUpstream, req.destination, req.x224, legacyTls)
                } catch (e: any) {
                    if (legacyTls || !/KEY_USAGE_BIT_INCORRECT/.test(e?.message ?? '')) {
                        throw e
                    }
                    // The X.224 exchange is spent on that connection: start over on a fresh one.
                    log('TLS: the server certificate only allows key encipherment; using TLS 1.2 with RSA key exchange')
                    legacyTls = true
                    up = await handshake(openUpstream, req.destination, req.x224, legacyTls)
                }
                raw = up.raw
                upstream = up.upstream
                const x224 = up.x224
                // Both handshakes above, the first and the legacy-TLS retry, end here: the certificate is checked
                // before the client gets the response it waits for to start CredSSP, and before anything it sent
                // early goes upstream.
                const chain = certChainOf(upstream)
                if (!chain.length) {
                    return fail('the server sent no certificate')
                }
                await checkCertificate(fingerprintOf(chain[0]))
                ws.send(encodeResponse(x224, chain, req.destination))
                stage = 'relay'
                // PROTOCOL_HYBRID_EX in the server's negotiation response: an Early User Authorization Result follows CredSSP.
                const frames = serverFraming(x224.length >= 19 && x224[11] === 0x02 && x224.readUInt32LE(15) === 8)
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
                })
                upstream.on('close', () => ws.close())
                upstream.on('error', (e: Error) => { log(`upstream error: ${e.message}`); ws.close() })
                for (const d of early) {
                    stats.bytesOut += d.length
                    send(d)
                }
                log(`RDCleanPath relay up to ${req.destination}`)
            } catch (e: any) {
                fail(e?.message ?? String(e))
            }
        })
        ws.on('close', () => {
            upstream?.destroy()
            raw?.destroy()
        })
    })

    const { port } = wss.address() as AddressInfo
    return {
        url: `ws://127.0.0.1:${port}`,
        token,
        stats,
        get failure () { return failure },
        close: () => wss.close(),
    }
}
