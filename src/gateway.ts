import { createHash, randomBytes, randomUUID } from 'crypto'
import { Duplex } from 'stream'
import * as tls from 'tls'
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

/** A `host` or `host:port` setting as a gateway (443 by default), or null if it isn't one. */
export function parseGateway (value: unknown): Gateway | null {
    const m = /^\s*(?:\[([0-9a-f:.]+)\]|([^\s:/]+))(?::(\d{1,5}))?\s*$/i.exec(String(value ?? ''))
    const port = Number(m?.[3] ?? 443)
    return m && port > 0 && port < 65536 ? { host: m[1] ?? m[2], port } : null
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

/** Splits a byte stream into the gateway's packets (8 bytes of header: type, reserved, total length). */
export function packetReader (onPacket: (type: number, body: Buffer) => void): (chunk: Buffer) => void {
    let pending: Buffer = Buffer.alloc(0)
    return chunk => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
        while (pending.length >= 8) {
            const length = pending.readUInt32LE(4)
            if (length < 8 || length > MAX_PACKET) {
                throw new Error(`a gateway packet of ${length} bytes`)
            }
            if (pending.length < length) {
                break
            }
            onPacket(pending.readUInt16LE(0), pending.subarray(8, length))
            pending = pending.subarray(length)
        }
        pending = Buffer.from(pending)
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

/** Splits the server's bytes into frames: data frames' payloads (fragments as they come), pings, and a close. */
export function wsReader (on: { data: (payload: Buffer) => void, ping: (payload: Buffer) => void, close: () => void }): (chunk: Buffer) => void {
    let pending: Buffer = Buffer.alloc(0)
    return chunk => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
        for (;;) {
            if (pending.length < 2) {
                break
            }
            const opcode = pending[0] & 0x0f
            const masked = (pending[1] & 0x80) !== 0
            let length = pending[1] & 0x7f
            let at = 2
            if (length === 126) {
                if (pending.length < 4) {
                    break
                }
                length = pending.readUInt16BE(2)
                at = 4
            } else if (length === 127) {
                if (pending.length < 10) {
                    break
                }
                const long = pending.readBigUInt64BE(2)
                if (long > BigInt(MAX_PACKET * 4)) {
                    throw new Error('a WebSocket frame too large to be the gateway\'s')
                }
                length = Number(long)
                at = 10
            }
            const maskAt = at
            if (masked) {
                at += 4
            }
            if (pending.length < at + length) {
                break
            }
            let payload = pending.subarray(at, at + length)
            if (masked) {
                payload = Buffer.from(payload)
                for (let i = 0; i < length; i++) {
                    payload[i] ^= pending[maskAt + (i & 3)]
                }
            }
            pending = pending.subarray(at + length)
            if (opcode === 0x8) {
                on.close()
            } else if (opcode === 0x9) {
                on.ping(payload)
            } else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
                // The packets inside are a stream of their own: fragments and whole messages alike just add to it.
                on.data(payload)
            }
        }
        pending = Buffer.from(pending)
    }
}

// ---- the HTTP upgrade, with NTLM --------------------------------------------------------------------

/** One HTTP response's status and headers, read from the stream; its body (a 401's page) is read and dropped. */
function readResponse (stream: Duplex, timeoutMs: number): Promise<{ status: number, headers: Map<string, string[]> }> {
    return new Promise((resolve, reject) => {
        let pending = Buffer.alloc(0)
        let head: { status: number, headers: Map<string, string[]>, body: number } | null = null
        const done = (error: Error | null, value?: { status: number, headers: Map<string, string[]> }) => {
            clearTimeout(timer)
            stream.off('data', onData)
            stream.off('error', onError)
            stream.off('close', onClose)
            // Paused before anything left over goes back, so that it waits for whoever reads next.
            stream.pause()
            if (pending.length) {
                stream.unshift(pending)
            }
            error ? reject(error) : resolve(value!)
        }
        const onError = (e: Error) => done(e)
        const onClose = () => done(new Error('the gateway closed the connection'))
        const timer = setTimeout(() => done(new Error('the gateway didn\'t answer in time')), timeoutMs)
        const onData = (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk])
            if (!head) {
                const end = pending.indexOf('\r\n\r\n')
                if (end < 0) {
                    if (pending.length > 64 * 1024) {
                        done(new Error('the gateway\'s answer isn\'t HTTP'))
                    }
                    return
                }
                const lines = pending.subarray(0, end).toString('latin1').split('\r\n')
                const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1])
                if (!status) {
                    return done(new Error('the gateway\'s answer isn\'t HTTP'))
                }
                const headers = new Map<string, string[]>()
                for (const line of lines.slice(1)) {
                    const m = /^([^:]+):\s*(.*)$/.exec(line)
                    if (m) {
                        headers.set(m[1].toLowerCase(), [...headers.get(m[1].toLowerCase()) ?? [], m[2]])
                    }
                }
                pending = pending.subarray(end + 4)
                // A switch of protocols has no body; other answers say how long theirs is.
                head = { status, headers, body: status === 101 ? 0 : Number(headers.get('content-length')?.[0] ?? 0) }
            }
            if (pending.length >= head.body) {
                pending = pending.subarray(head.body)
                done(null, { status: head.status, headers: head.headers })
            }
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
async function upgrade (stream: Duplex, gateway: Gateway, account: GatewayAccount, certificate: Buffer, timeoutMs: number): Promise<void> {
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
}

/**
 * Opens a stream to target.host:target.port through the gateway. `open` gives a TCP stream to the gateway (directly, or
 * through an SSH host). `checkCertificate` decides on the gateway's certificate before the account is used: it gets
 * the SHA-256 fingerprint (`AB:CD:…`) and whether the certificate is valid for the gateway's name by this computer's
 * certificate authorities, and throws to refuse.
 */
export async function openThroughGateway (
    open: () => Promise<Duplex>, gateway: Gateway, account: GatewayAccount, target: { host: string, port: number },
    checkCertificate: (fingerprint: string, valid: boolean) => void | Promise<void>, options: GatewayOptions = {},
): Promise<Duplex> {
    const log = options.log ?? (() => null)
    const timeoutMs = options.timeoutMs ?? 20000
    const targetName = `${target.host}:${target.port}`
    const raw = await open()
    let secure: tls.TLSSocket | null = null
    try {
        // A name is sent (SNI), an address isn't; either is what the certificate is checked for.
        const named = !/^[\d.]+$|:/.test(gateway.host)
        const socket = tls.connect({ socket: raw as any, host: gateway.host, rejectUnauthorized: false, ...named ? { servername: gateway.host } : {}, ...options.tls })
        secure = socket
        await new Promise<void>((resolve, reject) => {
            socket.once('secureConnect', resolve)
            socket.once('error', reject)
            socket.once('close', () => reject(new Error('the gateway closed the connection during TLS')))
        })
        const certificate = socket.getPeerCertificate()
        if (!certificate?.fingerprint256) {
            throw new Error('the gateway sent no certificate')
        }
        await checkCertificate(certificate.fingerprint256, socket.authorized)
        await upgrade(socket, gateway, account, certificate.raw, timeoutMs)
        log(`gateway: signed in to ${gateway.host}`)

        // From here on: WebSocket frames, the gateway's packets inside.
        let expecting: { type: number, resolve: (body: Buffer) => void, reject: (e: Error) => void } | null = null
        let stream: Duplex | null = null
        let ended = false
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
                log(`gateway: its administrator's message: ${body.subarray(body.length >= 2 ? 2 : 0).toString('utf16le').replace(/\0+$/, '').slice(0, 300)}`)
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
            ping: payload => socket.write(wsFrame(payload, 0xa)),
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
    }
}
