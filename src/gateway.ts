import { createHash, randomBytes, randomUUID } from 'crypto'
import { isIP } from 'net'
import { Duplex } from 'stream'
import * as tls from 'tls'
import { domainToASCII } from 'url'
import { CertificateDetails, certificateAuthorities, certificateDetails } from './authorities'
import { ByteQueue } from './byteQueue'
import { authenticateMessage, negotiateMessage } from './ntlm'

/**
 * A stream to an RDP server through a Remote Desktop Gateway ([MS-TSGU], its WebSocket transport, which Windows
 * Server 2012 R2 and later speak): HTTPS to the gateway, signed in to with NTLM, then a tunnel and a channel to the
 * server, and the RDP connection's bytes inside data packets. What comes out is a plain stream to the server, which
 * the proxy uses like a TCP connection: X.224, TLS and the server's own sign-in go through it unchanged.
 *
 * Not here: the older RPC-over-HTTP transport, Kerberos, smart cards, pluggable authentication cookies and the UDP
 * side channel.
 */

export interface Gateway {
    host: string
    port: number
}

export interface GatewayAccount {
    /** `user`, `DOMAIN\user` or `user@domain`. */
    username: string
    domain?: string
    password: string
}

/**
 * A gateway's host in one canonical form, so its trust key, its credential scope, its SNI and the way it is shown all
 * agree on it and an alternate spelling of the same gateway isn't taken for another one: an IPv6 literal compressed
 * (so `[0:0::1]` and `[::1]` are one), any other host as the name it resolves to (lower case, international letters as
 * punycode, one trailing dot dropped). Null for what names no host: an IPv6 literal that isn't one, an empty label
 * (`gw..example`, or a second trailing dot), a label over 63 characters or a name over 253, and a name with a
 * character no host name has (`#`, `?`, `@`, `%`, quotes, …), which the URL parser behind domainToASCII would otherwise
 * read as the end of the name or decode (`gw.example#x` as `gw.example`, `a%41` as `aa`) rather than refuse.
 */
function canonicalGatewayHost (bracketed: string | undefined, bare: string | undefined): string | null {
    if (bracketed !== undefined) {
        try {
            return new URL(`http://[${bracketed}]`).hostname.replace(/^\[|\]$/g, '')
        } catch {
            return null
        }
    }
    // Letters of any script go to IDNA, which refuses what isn't a name; of ASCII, only what a host name is made of.
    if (/[^A-Za-z0-9._-]/.test((bare ?? '').replace(/[^\x00-\x7f]/g, ''))) {
        return null
    }
    const host = domainToASCII((bare ?? '').replace(/\.$/, ''))
    return host && host.length <= 253 && host.split('.').every(label => label.length > 0 && label.length <= 63) ? host : null
}

/** A `host` or `host:port` setting as a gateway (443 by default), or null if it isn't one. The host is canonical. */
export function parseGateway (value: unknown): Gateway | null {
    // Text only, as specOf reads a gateway: String() of an object from the config runs its own conversions, which can throw.
    const m = /^\s*(?:\[([0-9a-f:.]+)\]|([^\s:/]+))(?::(\d{1,5}))?\s*$/i.exec(typeof value === 'string' ? value : '')
    const port = Number(m?.[3] ?? 443)
    const host = m && canonicalGatewayHost(m[1], m[2])
    return host && port > 0 && port < 65536 ? { host, port } : null
}

/** A gateway as a setting writes it: `host`, or `host:port` when that isn't 443 (an IPv6 address in brackets). */
export function formatGateway (gateway: Gateway): string {
    const host = gateway.host.includes(':') ? `[${gateway.host}]` : gateway.host
    return gateway.port === 443 ? host : `${host}:${gateway.port}`
}

/** The gateway refused the account (its HTTP sign-in, or its connection authorization policy). */
export class GatewaySignInError extends Error { }

// ---- packets ([MS-TSGU] 2.2.10) ------------------------------------------------------------------

const PKT_HANDSHAKE_REQUEST = 0x01
const PKT_HANDSHAKE_RESPONSE = 0x02
const PKT_TUNNEL_CREATE = 0x04
const PKT_TUNNEL_RESPONSE = 0x05
const PKT_TUNNEL_AUTH = 0x06
const PKT_TUNNEL_AUTH_RESPONSE = 0x07
const PKT_CHANNEL_CREATE = 0x08
const PKT_CHANNEL_RESPONSE = 0x09
const PKT_DATA = 0x0a
const PKT_SERVICE_MESSAGE = 0x0b
const PKT_KEEPALIVE = 0x0d
const PKT_CLOSE_CHANNEL = 0x10
const PKT_CLOSE_CHANNEL_RESPONSE = 0x11

/** This client shows (that is: logs) a consent message the gateway has for its users. */
const CAPABILITY_MESSAGING_CONSENT_SIGN = 0x4
/** A packet's largest payload: a 16-bit length, kept well under it. */
const MAX_DATA = 32 * 1024
/** What an incoming packet may be at most (a data packet's 64 KiB, and room for a certificate in the tunnel response). */
const MAX_PACKET = 256 * 1024
/**
 * How many of the gateway's administrator's messages are logged: it decides how many it sends, and when, for as long
 * as the connection lasts. An administrator has one to show, as the connection starts.
 */
const MAX_SERVICE_MESSAGES = 10

function packet (type: number, body: Buffer): Buffer {
    const header = Buffer.alloc(8)
    header.writeUInt16LE(type, 0)
    header.writeUInt32LE(8 + body.length, 4)
    return Buffer.concat([header, body])
}

/** A length-prefixed, zero-terminated UTF-16 string, as the tunnel and channel packets carry names. */
function name (text: string): Buffer {
    const value = Buffer.from(text + '\0', 'utf16le')
    const length = Buffer.alloc(2)
    length.writeUInt16LE(value.length)
    return Buffer.concat([length, value])
}

export function handshakeRequest (): Buffer {
    // Version 1.0, client version 0, no extended authentication (the HTTP sign-in is the authentication).
    return packet(PKT_HANDSHAKE_REQUEST, Buffer.from([1, 0, 0, 0, 0, 0]))
}

export function tunnelCreate (): Buffer {
    const body = Buffer.alloc(8)
    body.writeUInt32LE(CAPABILITY_MESSAGING_CONSENT_SIGN, 0)
    return packet(PKT_TUNNEL_CREATE, body)
}

export function tunnelAuth (clientName: string): Buffer {
    return packet(PKT_TUNNEL_AUTH, Buffer.concat([Buffer.alloc(2), name(clientName)]))
}

export function channelCreate (host: string, port: number): Buffer {
    const head = Buffer.alloc(6)
    head.writeUInt8(1, 0)        // one resource
    head.writeUInt8(0, 1)        // no alternative names
    head.writeUInt16LE(port, 2)
    head.writeUInt16LE(3, 4)     // protocol: RDP over TCP
    return packet(PKT_CHANNEL_CREATE, Buffer.concat([head, name(host)]))
}

export function dataPacket (data: Buffer): Buffer {
    const length = Buffer.alloc(2)
    length.writeUInt16LE(data.length)
    return packet(PKT_DATA, Buffer.concat([length, data]))
}

/** What a gateway's error code means, in words for the user (the code itself goes to the log). */
export function gatewayError (code: number, target: string): string {
    switch (code & 0xffff) {
        case 0x59da: return `the gateway doesn't let this account connect to ${target} (its resource authorization policy)`
        case 0x59db: case 0x59ed: return 'the gateway doesn\'t let this account connect (its connection authorization policy)'
        case 0x59dd: return `the gateway couldn't reach ${target}`
        case 0x59e6: return 'the gateway has no connections left to give'
        case 0x59e8: case 0x59e9: case 0x59f9: return 'the gateway asks for a way of signing in that isn\'t supported here (a smart card or a sign-in page)'
        case 0x59ee: return 'the gateway has no certificate set up'
        default: return `the gateway refused the connection (0x${(code >>> 0).toString(16)})`
    }
}

/**
 * The start of a gateway's service message (a length, then UTF-16 text), for the log: up to its terminator, 300
 * characters at most. Only that much is read: the gateway decides how long it is, up to a packet's size, and looking
 * through all of it for where it ends could take the square of that.
 */
function serviceMessage (body: Buffer): string {
    const text = body.subarray(body.length >= 2 ? 2 : 0).subarray(0, 600).toString('utf16le')
    const nul = text.indexOf('\0')
    return nul < 0 ? text : text.slice(0, nul)
}

/** Splits a byte stream into the gateway's packets (8 bytes of header: type, reserved, total length). */
export function packetReader (onPacket: (type: number, body: Buffer) => void): (chunk: Buffer) => void {
    const pending = new ByteQueue()
    return chunk => {
        pending.push(chunk)
        while (pending.length >= 8) {
            const length = pending.peek(8).readUInt32LE(4)
            if (length < 8 || length > MAX_PACKET) {
                throw new Error(`a gateway packet of ${length} bytes`)
            }
            if (pending.length < length) {
                break
            }
            const packet = pending.take(length)
            onPacket(packet.readUInt16LE(0), packet.subarray(8))
        }
    }
}

// ---- WebSocket frames (RFC 6455), client side -----------------------------------------------------

/** A binary (or control) frame from the client: masked, as the client's must be. */
export function wsFrame (payload: Buffer, opcode = 0x2): Buffer {
    const length = payload.length
    const header = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10)
    header[0] = 0x80 | opcode
    if (length < 126) {
        header[1] = 0x80 | length
    } else if (length < 65536) {
        header[1] = 0x80 | 126
        header.writeUInt16BE(length, 2)
    } else {
        header[1] = 0x80 | 127
        header.writeBigUInt64BE(BigInt(length), 2)
    }
    const mask = randomBytes(4)
    const masked = Buffer.alloc(length)
    for (let i = 0; i < length; i++) {
        masked[i] = payload[i] ^ mask[i & 3]
    }
    return Buffer.concat([header, mask, masked])
}

/**
 * Answers pings with pongs: one waiting to go out at a time, for the latest ping, as RFC 6455 allows (5.5.3). A gateway
 * that sends pings and doesn't read what comes back would otherwise have the pongs pile up here as fast as it sends.
 */
export function pongs (socket: { write (data: Buffer, done: () => void): unknown }, ended: () => boolean): (payload: Buffer) => void {
    let waiting = false
    let latest: Buffer | null = null
    const pong = (payload: Buffer): void => {
        if (waiting) {
            latest = Buffer.from(payload)
            return
        }
        waiting = true
        socket.write(wsFrame(payload, 0xa), () => {
            waiting = false
            const next = latest
            latest = null
            if (next && !ended()) {
                pong(next)
            }
        })
    }
    return pong
}

/** Splits the server's bytes into frames: data frames' payloads (fragments as they come), pings, and a close. */
export function wsReader (on: { data: (payload: Buffer) => void, ping: (payload: Buffer) => void, close: () => void }): (chunk: Buffer) => void {
    const pending = new ByteQueue()
    return chunk => {
        pending.push(chunk)
        for (;;) {
            // The header: 2 bytes, then up to 8 of length (and 4 of mask, read with the frame).
            const head = pending.peek(10)
            if (head.length < 2) {
                break
            }
            const opcode = head[0] & 0x0f
            const masked = (head[1] & 0x80) !== 0
            let length = head[1] & 0x7f
            let at = 2
            if (length === 126) {
                if (head.length < 4) {
                    break
                }
                length = head.readUInt16BE(2)
                at = 4
            } else if (length === 127) {
                if (head.length < 10) {
                    break
                }
                const long = head.readBigUInt64BE(2)
                if (long > BigInt(MAX_PACKET * 4)) {
                    throw new Error('a WebSocket frame too large to be the gateway\'s')
                }
                length = Number(long)
                at = 10
            }
            // Close, ping and pong carry 125 bytes at most (RFC 6455, 5.5): each ping is answered with as much.
            if (opcode >= 0x8 && length > 125) {
                throw new Error('a WebSocket control frame too large to be the gateway\'s')
            }
            const maskAt = at
            if (masked) {
                at += 4
            }
            if (pending.length < at + length) {
                break
            }
            const frame = pending.take(at + length)
            let payload = frame.subarray(at)
            if (masked) {
                payload = Buffer.from(payload)
                for (let i = 0; i < length; i++) {
                    payload[i] ^= frame[maskAt + (i & 3)]
                }
            }
            if (opcode === 0x8) {
                on.close()
            } else if (opcode === 0x9) {
                on.ping(payload)
            } else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
                // The packets inside are a stream of their own: fragments and whole messages alike just add to it.
                on.data(payload)
            }
        }
    }
}

// ---- the HTTP upgrade, with NTLM --------------------------------------------------------------------

/** What a response's status line and headers may be at most. */
const MAX_HEAD = 64 * 1024
/** What its body may be at most: a 401's page, a kilobyte or so, which isn't kept anyway. */
const MAX_BODY = 256 * 1024
/** A header's name: an HTTP token (RFC 9110, 5.6.2). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/

/**
 * One HTTP response's status and headers, read from the stream. A 401's body (its page) is counted off as it comes, not
 * kept; a length (Content-Length) that isn't a number, or is over MAX_BODY, is refused. What follows is left for the
 * next reader.
 */
function readResponse (stream: Duplex, timeoutMs: number): Promise<{ status: number, headers: Map<string, string[]> }> {
    return new Promise((resolve, reject) => {
        // The status line and headers, copied in as they come.
        const head = Buffer.alloc(MAX_HEAD)
        let filled = 0
        let response: { status: number, headers: Map<string, string[]> } | null = null
        // How much of the body is still to come, and what came after it.
        let body = 0
        let rest: Buffer | null = null
        const done = (error: Error | null) => {
            clearTimeout(timer)
            stream.off('data', onData)
            stream.off('error', onError)
            stream.off('close', onClose)
            // Paused before anything left over goes back, so that it waits for whoever reads next.
            stream.pause()
            if (rest?.length) {
                stream.unshift(rest)
            }
            error ? reject(error) : resolve(response!)
        }
        const onError = (e: Error) => done(e)
        const onClose = () => done(new Error('the gateway closed the connection'))
        const timer = setTimeout(() => done(new Error('the gateway didn\'t answer in time')), timeoutMs)
        const onData = (chunk: Buffer) => {
            if (!response) {
                // Only what is new is searched, from three bytes back: the blank line can straddle two pieces.
                const from = Math.max(0, filled - 3)
                const start = filled
                filled += chunk.copy(head, filled)
                const end = head.subarray(0, filled).indexOf('\r\n\r\n', from)
                if (end < 0) {
                    if (filled === MAX_HEAD) {
                        done(new Error('the gateway\'s answer isn\'t HTTP'))
                    }
                    return
                }
                const lines = head.subarray(0, end).toString('latin1').split('\r\n')
                const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1])
                // A CR or LF that doesn't end a line is no HTTP a gateway sends.
                if (!status || lines.some(line => line.includes('\r') || line.includes('\n'))) {
                    return done(new Error('the gateway\'s answer isn\'t HTTP'))
                }
                const headers = new Map<string, string[]>()
                for (const line of lines.slice(1)) {
                    // Split at the first colon, the value trimmed: no pattern whose parts can take the same characters,
                    // which a long line can make cost the square of its length.
                    const colon = line.indexOf(':')
                    const name = colon > 0 ? line.slice(0, colon).toLowerCase() : ''
                    if (HEADER_NAME.test(name)) {
                        const values = headers.get(name) ?? []
                        values.push(line.slice(colon + 1).trim())
                        headers.set(name, values)
                    }
                }
                // Only a 401's page has to be got past: a sign-in round follows it on the same connection. Any other
                // answer ends the sign-in, connection and all (and a switch of protocols has no body).
                const length = status === 401 ? (headers.get('content-length')?.[0] ?? '0').trim() : '0'
                if (!/^\d{1,9}$/.test(length) || Number(length) > MAX_BODY) {
                    return done(new Error('the gateway\'s answer is malformed or too large'))
                }
                response = { status, headers }
                body = Number(length)
                // What this piece has after the blank line.
                chunk = chunk.subarray(end + 4 - start)
            }
            if (chunk.length < body) {
                body -= chunk.length
                return
            }
            rest = chunk.subarray(body)
            done(null)
        }
        stream.on('data', onData)
        stream.on('error', onError)
        stream.on('close', onClose)
        stream.resume()
    })
}

/**
 * What ties a sign-in to the TLS connection it is made over (RFC 5929's tls-server-end-point): the server's
 * certificate, hashed with its signature's hash, or SHA-256 where that is MD5, SHA-1 or none. A gateway checks it by
 * default (extended protection): a sign-in relayed from another connection doesn't have it.
 */
export function endPointBinding (certificate: Buffer): Buffer {
    // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE, signatureAlgorithm SEQUENCE, signature }: the second member.
    const member = (at: number): { start: number, end: number } => {
        let length = certificate[at + 1]
        let start = at + 2
        if (length & 0x80) {
            const bytes = length & 0x7f
            length = 0
            for (let i = 0; i < bytes; i++) {
                length = length * 256 + certificate[start + i]
            }
            start += bytes
        }
        return { start, end: start + length }
    }
    let algorithm = ''
    try {
        const tbs = member(member(0).start)
        algorithm = certificate.subarray(tbs.end, member(tbs.end).end).toString('hex')
    } catch {
        // not a certificate this reads: SHA-256
    }
    // sha384/sha512 with RSA, ECDSA, or as RSASSA-PSS's hash.
    const hash = /2a864886f70d01010c|2a8648ce3d040303|608648016503040202/.test(algorithm) ? 'sha384'
        : /2a864886f70d01010d|2a8648ce3d040304|608648016503040203/.test(algorithm) ? 'sha512' : 'sha256'
    return Buffer.concat([Buffer.from('tls-server-end-point:', 'latin1'), createHash(hash).update(certificate).digest()])
}

/** Upgrades the connection to the gateway's WebSocket, signing in with NTLM on the way. */
async function upgrade (stream: Duplex, gateway: Gateway, account: GatewayAccount, certificate: Buffer, timeoutMs: number, proceed: () => void = () => { }): Promise<void> {
    const key = randomBytes(16).toString('base64')
    const connection = `{${randomUUID().toUpperCase()}}`
    const request = (authorization: Buffer) => [
        'RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1',
        `Host: ${gateway.host}${gateway.port === 443 ? '' : `:${gateway.port}`}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        `RDG-Connection-Id: ${connection}`,
        `Authorization: NTLM ${authorization.toString('base64')}`,
        '', '',
    ].join('\r\n')
    const negotiate = negotiateMessage()
    proceed()
    stream.write(request(negotiate))
    const first = await readResponse(stream, timeoutMs)
    if (first.status !== 401) {
        throw new Error(first.status === 101 ? 'the gateway let the connection in without a sign-in' : `the gateway answered ${first.status} to the sign-in`)
    }
    const offered = first.headers.get('www-authenticate') ?? []
    const challenge = offered.map(v => /^NTLM\s+([A-Za-z0-9+/=]+)\s*$/.exec(v)?.[1]).find(Boolean)
    if (!challenge) {
        throw new Error(offered.some(v => /^NTLM\b/i.test(v))
            ? 'the gateway didn\'t take up the NTLM sign-in'
            : `the gateway doesn't offer an NTLM sign-in (it offers: ${offered.map(v => v.split(' ')[0]).join(', ') || 'nothing'})`)
    }
    const challengeMessage = Buffer.from(challenge, 'base64')
    proceed()
    stream.write(request(authenticateMessage(negotiate, challengeMessage, {
        ...account, channelBinding: endPointBinding(certificate), targetName: `HTTP/${gateway.host}`,
    })))
    const second = await readResponse(stream, timeoutMs)
    if (second.status === 401 || second.status === 403) {
        throw new GatewaySignInError('The gateway refused the sign-in.')
    }
    if (second.status !== 101) {
        // An older gateway takes the request for its HTTP transport (two connections, one each way), not spoken here.
        throw new Error(second.status === 200
            ? 'the gateway doesn\'t take WebSocket connections (Windows Server 2012 R2 and later do)'
            : `the gateway answered ${second.status} after the sign-in`)
    }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    if (second.headers.get('sec-websocket-accept')?.[0] !== accept) {
        throw new Error('the gateway\'s WebSocket answer doesn\'t match the request')
    }
}

// ---- the tunnel ------------------------------------------------------------------------------------

export interface GatewayOptions {
    /** A name for this computer, as the gateway's logs will have it. */
    clientName?: string
    /** For each step of setting the tunnel up (default 20 s). */
    timeoutMs?: number
    log?: (message: string) => void
    /** TLS options for the connection to the gateway (tests: a test certificate's). */
    tls?: tls.ConnectionOptions
    /**
     * Aborts when what the tunnel is for has gone (the desktop was closed): nothing more is sent to the gateway then,
     * the sign-in's messages included, and the connection to it is ended, rather than left to the gateway's timeouts.
     */
    signal?: AbortSignal
}

/**
 * Opens a stream to target.host:target.port through the gateway. `open` gives a TCP stream to the gateway (directly, or
 * through an SSH host). `checkCertificate` decides on the gateway's certificate before the account is used: it gets
 * the SHA-256 fingerprint (`AB:CD:…`), whether the certificate is valid for the gateway's name by this computer's
 * certificate authorities (see certificateAuthorities), why not (Node's code for it, '' when it is), and what the
 * certificate says of itself (see CertificateDetails), and throws to refuse.
 */
export async function openThroughGateway (
    open: () => Promise<Duplex>, gateway: Gateway, account: GatewayAccount, target: { host: string, port: number },
    checkCertificate: (fingerprint: string, valid: boolean, reason: string, details?: CertificateDetails) => void | Promise<void>, options: GatewayOptions = {},
): Promise<Duplex> {
    const log = options.log ?? (() => null)
    const timeoutMs = options.timeoutMs ?? 20000
    const targetName = `${target.host}:${target.port}`
    const signal = options.signal
    // Nothing more goes to the gateway once what it is for has gone: checked before each step and message of the
    // sign-in, and the connection ends then, which also ends what waits on it (the TLS handshake, an answer).
    const proceed = () => {
        if (signal?.aborted) {
            throw new Error('the desktop was closed meanwhile')
        }
    }
    proceed()
    const raw = await open()
    let secure: tls.TLSSocket | null = null
    const abort = () => {
        secure?.destroy()
        raw.destroy()
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
        proceed()
        // A name is sent (SNI), an address isn't; either is what the certificate is checked for.
        const named = !isIP(gateway.host)
        const socket = tls.connect({
            socket: raw as any, host: gateway.host, rejectUnauthorized: false, ca: certificateAuthorities(),
            ...named ? { servername: gateway.host } : {}, ...options.tls,
        })
        secure = socket
        // A step like the others: a gateway that takes the connection and never answers TLS would keep it for good.
        let timer: NodeJS.Timeout | undefined
        await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('the gateway didn\'t answer in time (TLS)')), timeoutMs)
            socket.once('secureConnect', resolve)
            socket.once('error', reject)
            socket.once('close', () => reject(new Error('the gateway closed the connection during TLS')))
        }).finally(() => clearTimeout(timer))
        const certificate = socket.getPeerCertificate(true)
        if (!certificate?.fingerprint256) {
            throw new Error('the gateway sent no certificate')
        }
        // Where its chain stands and whether it is for the gateway's name, which Node's code for why it isn't valid can
        // hide (see certificateDetails).
        const reason = socket.authorized ? '' : String(socket.authorizationError ?? '')
        const checked = socket.authorized ? undefined : { name: gateway.host, authorities: options.tls?.ca ?? certificateAuthorities(), reason }
        await checkCertificate(certificate.fingerprint256, socket.authorized, reason, certificateDetails(certificate, checked))
        await upgrade(socket, gateway, account, certificate.raw, timeoutMs, proceed)
        log(`gateway: signed in to ${gateway.host}`)

        // From here on: WebSocket frames, the gateway's packets inside.
        let expecting: { type: number, resolve: (body: Buffer) => void, reject: (e: Error) => void } | null = null
        let stream: Duplex | null = null
        let ended = false
        let messages = 0
        const end = (error?: Error) => {
            if (ended) {
                return
            }
            ended = true
            expecting?.reject(error ?? new Error('the gateway closed the connection'))
            socket.destroy()
            stream?.destroy(error)
        }
        const packets = packetReader((type, body) => {
            if (type === PKT_DATA) {
                const length = body.length >= 2 ? body.readUInt16LE(0) : 0
                // The reader not keeping up: nothing more is read from the gateway until it asks again.
                if (stream && !stream.push(Buffer.from(body.subarray(2, 2 + length)))) {
                    socket.pause()
                }
            } else if (type === PKT_KEEPALIVE) {
                // nothing to answer: the gateway only checks the line
            } else if (type === PKT_SERVICE_MESSAGE) {
                if (++messages <= MAX_SERVICE_MESSAGES) {
                    log(`gateway: its administrator's message: ${serviceMessage(body)}`)
                } else if (messages === MAX_SERVICE_MESSAGES + 1) {
                    log(`gateway: more messages from its administrator; past ${MAX_SERVICE_MESSAGES}, they aren't logged`)
                }
            } else if (type === PKT_CLOSE_CHANNEL) {
                socket.write(wsFrame(packet(PKT_CLOSE_CHANNEL_RESPONSE, Buffer.alloc(8))))
                end()
            } else if (expecting && type === expecting.type) {
                const waiting = expecting
                expecting = null
                waiting.resolve(body)
            }
        })
        const frames = wsReader({
            data: payload => packets(payload),
            ping: pongs(socket, () => ended),
            close: () => end(),
        })
        socket.on('data', (chunk: Buffer) => {
            try {
                frames(chunk)
            } catch (e: any) {
                end(e)
            }
        })
        socket.on('error', (e: Error) => end(e))
        socket.on('close', () => end())
        socket.resume()

        /** Sends a packet and waits for the answer of the given type: its body. */
        const exchange = (send: Buffer, type: number, step: string) => new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => {
                expecting = null
                reject(new Error(`the gateway didn't answer in time (${step})`))
            }, timeoutMs)
            expecting = {
                type,
                resolve: body => { clearTimeout(timer); resolve(body) },
                reject: e => { clearTimeout(timer); reject(e) },
            }
            try {
                proceed()
            } catch (e: any) {
                expecting = null
                clearTimeout(timer)
                return reject(e)
            }
            socket.write(wsFrame(send))
        })
        const refused = (code: number, step: string) => {
            log(`gateway: ${step} refused: 0x${(code >>> 0).toString(16)}`)
            const message = gatewayError(code, targetName)
            // Not being allowed in by policy is the account's doing, like a refused sign-in.
            return [0x59db, 0x59ed].includes(code & 0xffff) ? new GatewaySignInError(`${message[0].toUpperCase()}${message.slice(1)}.`) : new Error(message)
        }

        const handshake = await exchange(handshakeRequest(), PKT_HANDSHAKE_RESPONSE, 'handshake')
        if (handshake.length < 4 || handshake.readUInt32LE(0) !== 0) {
            throw refused(handshake.length < 4 ? 0 : handshake.readUInt32LE(0), 'the handshake')
        }
        // The tunnel: server version (2), status (4), fields present (2), reserved (2), then what the fields say.
        const tunnel = await exchange(tunnelCreate(), PKT_TUNNEL_RESPONSE, 'tunnel')
        if (tunnel.length < 10 || tunnel.readUInt32LE(2) !== 0) {
            throw refused(tunnel.length < 10 ? 0 : tunnel.readUInt32LE(2), 'the tunnel')
        }
        const authorized = await exchange(tunnelAuth(options.clientName ?? 'tabby-rdp'), PKT_TUNNEL_AUTH_RESPONSE, 'authorization')
        if (authorized.length < 4 || authorized.readUInt32LE(0) !== 0) {
            throw refused(authorized.length < 4 ? 0 : authorized.readUInt32LE(0), 'the authorization')
        }
        const channel = await exchange(channelCreate(target.host, target.port), PKT_CHANNEL_RESPONSE, 'channel')
        if (channel.length < 4 || channel.readUInt32LE(0) !== 0) {
            throw refused(channel.length < 4 ? 0 : channel.readUInt32LE(0), 'the channel')
        }
        log(`gateway: channel to ${targetName} through ${gateway.host}`)

        const tunnelStream = new Duplex({
            read () { socket.resume() },
            write (chunk: Buffer, _encoding, callback) {
                let flushed = true
                for (let at = 0; at < chunk.length; at += MAX_DATA) {
                    flushed = socket.write(wsFrame(dataPacket(chunk.subarray(at, at + MAX_DATA))))
                }
                // The gateway not keeping up: the writer waits for it.
                flushed ? callback() : socket.once('drain', () => callback())
            },
            final (callback) {
                socket.write(wsFrame(packet(PKT_CLOSE_CHANNEL, Buffer.alloc(4))))
                callback()
            },
            destroy (error, callback) {
                ended = true
                socket.destroy()
                callback(error)
            },
        })
        stream = tunnelStream
        return tunnelStream
    } catch (e) {
        secure?.destroy()
        raw.destroy()
        throw e
    } finally {
        // Only for the sign-in and the tunnel's setup: the tunnel itself ends with the client's connection (see track).
        signal?.removeEventListener('abort', abort)
    }
}
