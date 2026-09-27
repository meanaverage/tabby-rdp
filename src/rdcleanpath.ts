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
    close (): void
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

/** Sends the client's X.224 request upstream, reads the confirm, then does TLS there. */
async function handshake (openUpstream: UpstreamFactory, destination: string, x224Request: Buffer, legacyTls: boolean): Promise<{ raw: Duplex, upstream: tls.TLSSocket, x224: Buffer }> {
    const raw = await openUpstream(destination)
    try {
        raw.write(x224Request)
        const x224 = await readTpkt(raw)
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

export async function startRDCleanPathProxy (openUpstream: UpstreamFactory, checkCertificate: CertificateCheck, log: (msg: string) => void = () => {}): Promise<RDCleanPathProxy> {
    const token = randomBytes(24).toString('hex')
    // Set once the server turned out to need KEY_ENCIPHERMENT_ONLY_TLS; later connections start with it.
    let legacyTls = false
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

        const fail = (why: string) => {
            log(`RDCleanPath failed: ${why}`)
            try { ws.send(encodeError()) } catch { }
            ws.close()
            upstream?.destroy()
            raw?.destroy()
        }

        ws.on('message', async (data: Buffer) => {
            if (stage === 'relay') {
                upstream!.write(data)
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
                upstream.on('data', (d: Buffer) => ws.send(d))
                upstream.on('close', () => ws.close())
                upstream.on('error', (e: Error) => { log(`upstream error: ${e.message}`); ws.close() })
                for (const d of early) {
                    upstream.write(d)
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
    return { url: `ws://127.0.0.1:${port}`, token, close: () => wss.close() }
}
