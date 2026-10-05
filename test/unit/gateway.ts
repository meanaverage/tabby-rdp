// The RD Gateway tunnel (src/gateway.ts) against a stand-in gateway: TLS, the WebSocket upgrade with an NTLM sign-in
// (checked with the account's hash and for the TLS connection it is made over, as a gateway does), the tunnel's
// packets, and data both ways. Needs the openssl
// command for the stand-in's certificate. Runs against the built plugin: npm run build && npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { Duplex } from 'node:stream'
import * as tls from 'node:tls'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)
const { openThroughGateway, parseGateway, formatGateway, GatewaySignInError, packetReader, wsFrame, wsReader, dataPacket, gatewayError, endPointBinding, pongs } = require('../../dist/gateway.js')
const { ntlmV2Hash, channelBindingHash } = require('../../dist/ntlm.js')
const { specOf } = require('../../dist/desktops.js')
import { authority, selfSigned as selfSignedWith } from './support/certificates.js'

/** A self-signed certificate signed with this hash, with its key; its DER form too. */
function selfSigned (hash: string): { key: Buffer, cert: Buffer, der: Buffer } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-gw-'))
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', `-${hash}`, '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '2', '-subj', '/CN=gateway.test'], { stdio: 'ignore' })
        const cert = fs.readFileSync(`${dir}/cert.pem`)
        return { key: fs.readFileSync(`${dir}/key.pem`), cert, der: Buffer.from(cert.toString().replace(/-----[^-]+-----|\s/g, ''), 'base64') }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

let certificate: ReturnType<typeof selfSigned> | null = null
try {
    certificate = selfSigned('sha256')
} catch {
    // no openssl: the tests that need the stand-in are skipped
}

const SERVER_CHALLENGE = Buffer.from('1122334455667788', 'hex')
const u16 = (text: string) => Buffer.from(text, 'utf16le')

/** An NTLM challenge message, with a timestamp among its target information as Windows sends. */
function challengeMessage (): Buffer {
    const info = Buffer.concat([Buffer.from('02000400', 'hex'), u16('GW'), Buffer.from('07000800', 'hex'), Buffer.from('0090d336b734c301', 'hex'), Buffer.alloc(4)])
    const message = Buffer.alloc(56)
    message.write('NTLMSSP\0', 'latin1')
    message.writeUInt32LE(2, 8)
    message.writeUInt32LE(56, 16)
    message.writeUInt32LE(0xe28a8215, 20)
    SERVER_CHALLENGE.copy(message, 24)
    message.writeUInt16LE(info.length, 40)
    message.writeUInt16LE(info.length, 42)
    message.writeUInt32LE(56, 44)
    return Buffer.concat([message, info])
}

/** One of the pairs the client's response carries back (after the proof's 16 bytes and the blob's first 28). */
function pairOf (nt: Buffer, id: number): Buffer | null {
    for (let at = 44; at + 4 <= nt.length;) {
        const [pair, length] = [nt.readUInt16LE(at), nt.readUInt16LE(at + 2)]
        if (pair === id) {
            return nt.subarray(at + 4, at + 4 + length)
        }
        if (pair === 0) {
            break
        }
        at += 4 + length
    }
    return null
}

/**
 * Whether an NTLM authenticate message proves `password` for the user it names, on this TLS connection: a gateway
 * (extended protection, its default) also wants the hash of its own certificate's binding among the pairs.
 */
function proves (message: Buffer, password: string): boolean {
    const field = (i: number) => message.subarray(message.readUInt32LE(16 + i * 8), message.readUInt32LE(16 + i * 8) + message.readUInt16LE(12 + i * 8))
    const nt = field(1)
    const hash = ntlmV2Hash(field(3).toString('utf16le'), field(2).toString('utf16le'), password)
    const binding = Buffer.concat([Buffer.from('tls-server-end-point:'), createHash('sha256').update(certificate!.der).digest()])
    return createHmac('md5', hash).update(SERVER_CHALLENGE).update(nt.subarray(16)).digest().equals(nt.subarray(0, 16)) &&
        !!pairOf(nt, 10)?.equals(channelBindingHash(binding)) && pairOf(nt, 9)?.toString('utf16le') === 'HTTP/127.0.0.1'
}

const pkt = (type: number, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt16LE(type, 0); h.writeUInt32LE(8 + body.length, 4); return Buffer.concat([h, body]) }
/** An unmasked frame, as a server's are; `split` sends it in two pieces to try the reader. */
const serverFrame = (payload: Buffer) => {
    const long = Buffer.alloc(8)
    long.writeBigUInt64BE(BigInt(payload.length))
    const header = payload.length < 126 ? Buffer.from([0x82, payload.length])
        : payload.length < 65536 ? Buffer.from([0x82, 126, payload.length >> 8, payload.length & 0xff]) : Buffer.concat([Buffer.from([0x82, 127]), long])
    return Buffer.concat([header, payload])
}

/**
 * The client's frames as a gateway reads them (masked), for what wsReader leaves out: pongs. Each frame's opcode and
 * payload, unmasked, however the bytes are cut.
 */
function clientFrames (onFrame: (opcode: number, payload: Buffer) => void): (chunk: Buffer) => void {
    let pending = Buffer.alloc(0)
    return chunk => {
        pending = Buffer.concat([pending, chunk])
        for (;;) {
            if (pending.length < 2) {
                return
            }
            let length = pending[1] & 0x7f
            let at = 2
            if (length === 126) {
                length = pending.length >= 4 ? pending.readUInt16BE(2) : Infinity
                at = 4
            } else if (length === 127) {
                length = pending.length >= 10 ? Number(pending.readBigUInt64BE(2)) : Infinity
                at = 10
            }
            if (pending.length < at + 4 + length) {
                return
            }
            const mask = pending.subarray(at, at + 4)
            const payload = Buffer.from(pending.subarray(at + 4, at + 4 + length)).map((b, i) => b ^ mask[i & 3])
            onFrame(pending[0] & 0x0f, Buffer.from(payload))
            pending = pending.subarray(at + 4 + length)
        }
    }
}

/**
 * A stand-in gateway: one account, a policy for which targets it lets through, and an echo behind the channel
 * (what arrives in data packets comes back in upper case). `trickle`: its HTTP answers go a byte at a time, each in a
 * TLS record of its own. `onChannel`: runs once the channel is answered, with the connection (to send more on it).
 * The client's pongs are kept, by payload.
 */
function standIn (password: string, allow: (target: string) => number = () => 0, trickle = false, onChannel?: (socket: tls.TLSSocket) => void) {
    const seen = { requests: [] as string[], target: '', closed: false, pongs: [] as string[] }
    const sockets = new Set<tls.TLSSocket>()
    const server = tls.createServer({ key: certificate!.key, cert: certificate!.cert }, socket => {
        sockets.add(socket)
        let http = Buffer.alloc(0)
        let upgraded = false
        // Answers go out one after another, each in two pieces with the cut inside its frame: the reader has to put
        // them together.
        let sending = Promise.resolve()
        const inPieces = (frame: Buffer) => {
            sending = sending.then(() => new Promise<void>(resolve => {
                socket.write(frame.subarray(0, 5))
                setTimeout(() => { socket.write(frame.subarray(5)); resolve() }, 2)
            }))
        }
        const packets = packetReader((type: number, body: Buffer) => {
            const send = (t: number, b: Buffer) => socket.write(serverFrame(pkt(t, b)))
            if (type === 0x01) send(0x02, Buffer.alloc(10))
            else if (type === 0x04) send(0x05, Buffer.alloc(10))
            else if (type === 0x06) send(0x07, Buffer.alloc(8))
            else if (type === 0x08) {
                const port = body.readUInt16LE(2)
                const length = body.readUInt16LE(6)
                seen.target = `${body.subarray(8, 8 + length - 2).toString('utf16le')}:${port}`
                const status = Buffer.alloc(8)
                status.writeUInt32LE(allow(seen.target) >>> 0, 0)
                send(0x09, status)
                onChannel?.(socket)
            } else if (type === 0x0a) {
                const data = body.subarray(2, 2 + body.readUInt16LE(0))
                inPieces(serverFrame(dataPacket(Buffer.from(data.toString('latin1').toUpperCase(), 'latin1'))))
            } else if (type === 0x10) seen.closed = true
        })
        const frames = wsReader({ data: packets, ping: () => { }, close: () => socket.end() })
        const answer = async (text: string) => {
            if (!trickle) {
                return socket.write(text)
            }
            // Each byte written once the one before has gone, so that they aren't joined into one record.
            for (const byte of Buffer.from(text)) {
                await new Promise(resolve => socket.write(Buffer.from([byte]), resolve))
            }
        }
        socket.on('error', () => { })
        const control = clientFrames((opcode, payload) => opcode === 0xa && seen.pongs.push(payload.toString()))
        socket.on('data', chunk => {
            if (upgraded) {
                control(chunk)
                return frames(chunk)
            }
            http = Buffer.concat([http, chunk])
            const end = http.indexOf('\r\n\r\n')
            if (end < 0) {
                return
            }
            const head = http.subarray(0, end).toString('latin1')
            http = http.subarray(end + 4)
            seen.requests.push(head.split('\r\n')[0])
            const auth = Buffer.from(/^Authorization: NTLM (.+)$/mi.exec(head)?.[1] ?? '', 'base64')
            const page = 'Access Denied'
            if (auth.length >= 12 && auth.readUInt32LE(8) === 1) {
                answer(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nWWW-Authenticate: NTLM ${challengeMessage().toString('base64')}\r\nContent-Length: ${page.length}\r\n\r\n${page}`)
            } else if (auth.length >= 12 && auth.readUInt32LE(8) === 3 && proves(auth, password)) {
                const key = /^Sec-WebSocket-Key: (.+)$/mi.exec(head)![1]
                const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
                answer(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
                upgraded = true
            } else {
                answer(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM\r\nContent-Length: ${page.length}\r\n\r\n${page}`)
            }
        })
    })
    return new Promise<{ port: number, seen: typeof seen, close: () => void }>(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: (server.address() as net.AddressInfo).port,
            seen,
            close: () => { server.close(); sockets.forEach(socket => socket.destroy()) },
        }))
    })
}

// Whatever a failed test left open ends with the file.
const standIns: { close: () => void }[] = []
after(() => standIns.forEach(s => s.close()))
const gatewayFor = async (password: string, allow?: (target: string) => number, trickle?: boolean, onChannel?: (socket: tls.TLSSocket) => void) => {
    const gateway = await standIn(password, allow, trickle, onChannel)
    standIns.push(gateway)
    return gateway
}

const connect = (port: number) => () => new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
    socket.once('error', reject)
})
const next = (stream: NodeJS.ReadableStream) => new Promise<Buffer>(resolve => stream.once('data', resolve))

test('gateway settings: a host, or host:port', () => {
    assert.deepEqual(parseGateway('gw.example.com'), { host: 'gw.example.com', port: 443 })
    assert.deepEqual(parseGateway(' gw.example.com:8443 '), { host: 'gw.example.com', port: 8443 })
    assert.deepEqual(parseGateway('[2001:db8::1]:443'), { host: '2001:db8::1', port: 443 })
    assert.equal(parseGateway('https://gw.example.com/'), null)
    assert.equal(parseGateway(''), null)
    assert.equal(parseGateway('gw:99999'), null)
})

test('gateway host is canonical, so an alternate spelling isn\'t taken for a first use', () => {
    // Letter case and a trailing dot name the same host; the trust key and SNI must agree, so parseGateway settles them.
    assert.deepEqual(parseGateway('RDGW.Example.COM.'), { host: 'rdgw.example.com', port: 443 })
    assert.deepEqual(parseGateway('RDGW.Example.COM:8443'), { host: 'rdgw.example.com', port: 8443 })
    // Two spellings of one IPv6 address compress to one.
    assert.equal(parseGateway('[0:0::1]')!.host, '::1')
    assert.equal(parseGateway('[::1]')!.host, '::1')
    // An international name is the punycode it resolves to, with its port kept apart; capitals or not.
    assert.deepEqual(parseGateway('bücher.example:8443'), { host: 'xn--bcher-kva.example', port: 8443 })
    assert.deepEqual(parseGateway('BÜCHER.example'), parseGateway('xn--bcher-kva.example'))
})

test('a gateway setting that names no host is none', () => {
    // A second trailing dot, an empty label, nothing but a dot: no host (one trailing dot is the same name).
    for (const value of ['gw.example..', 'gw..example', '.', '..', '.gw.example', `${'a'.repeat(64)}.example`, `${'a.'.repeat(127)}example`]) {
        assert.equal(parseGateway(value), null, value)
    }
    // Brackets that hold no IPv6 address.
    for (const value of ['[1::2::3]', '[::g]', '[]', '[1.2.3.4]']) {
        assert.equal(parseGateway(value), null, value)
    }
    // A character no host name has: refused, not read as the end of the name (`#`, `?`, `\`), a user name in front of
    // it (`@`), or an escape to decode (`%41` as `a`); so are its full-width look-alikes, which IDNA turns into them.
    for (const value of ['gw.example#x', 'gw.example?x', 'gw.example\\x', 'evil@gw.example', 'a%41.example', 'gw"x.example', 'gw.example＃x', 'gw.example＠x']) {
        assert.equal(parseGateway(value), null, value)
    }
    assert.deepEqual(parseGateway(`${'a'.repeat(63)}.example`), { host: `${'a'.repeat(63)}.example`, port: 443 })
    assert.deepEqual(parseGateway('rd_gw-2.example'), { host: 'rd_gw-2.example', port: 443 })
})

test('a gateway written back as a setting: its port only when it isn\'t 443, an IPv6 address in brackets', () => {
    assert.equal(formatGateway(parseGateway('GW.example:443')), 'gw.example')
    assert.equal(formatGateway(parseGateway('bücher.example:8443')), 'xn--bcher-kva.example:8443')
    assert.equal(formatGateway(parseGateway('[2001:DB8::1]:4433')), '[2001:db8::1]:4433')
})

test('a desktop\'s gateway: kept with its account; not for a Hyper-V console, which is its host\'s', () => {
    const spec = specOf({ name: 'Office PC', host: 'pc17.corp', gateway: ' rdgw.example.com ', gatewayAccount: 'k1' })
    assert.equal(spec.gateway, 'rdgw.example.com')
    assert.equal(spec.gatewayAccount, 'k1')
    assert.equal(spec.id, 'pc17.corp:3389')
    const plain = specOf({ name: 'Office PC', host: 'pc17.corp', gateway: '', gatewayAccount: 'k1' })
    assert.ok(!('gateway' in plain) && !('gatewayAccount' in plain))
    assert.equal(specOf({ name: 'VM', hyperv: '5f05e000-0000-4000-8000-000000000001', gateway: 'rdgw.example.com' }).gateway, undefined)
})

test('packets and frames come out whole however the bytes arrive', () => {
    const packets: [number, string][] = []
    const read = packetReader((type: number, body: Buffer) => packets.push([type, body.toString('hex')]))
    const stream = Buffer.concat([pkt(0x0d, Buffer.alloc(0)), dataPacket(Buffer.from('hi'))])
    for (const byte of stream) {
        read(Buffer.from([byte]))
    }
    assert.deepEqual(packets, [[0x0d, ''], [0x0a, '02006869']])
    assert.throws(() => packetReader(() => { })(Buffer.from('0a000000ffffff7f', 'hex')), /gateway packet/)
    // A client frame: masked, and the reader gives back what went in, also for the longer length forms.
    for (const size of [5, 300, 70000]) {
        const payload = Buffer.alloc(size, 7)
        const out: Buffer[] = []
        wsReader({ data: (p: Buffer) => out.push(p), ping: () => { }, close: () => { } })(wsFrame(payload))
        assert.ok(Buffer.concat(out).equals(payload), `${size} bytes`)
    }
})

/** How many bytes Buffer.concat and Buffer.from (of bytes) copy while `f` runs. */
function copiedBy (f: () => void): number {
    const { concat, from } = Buffer
    let copied = 0
    Buffer.concat = ((list: readonly Uint8Array[], length?: number) => {
        const out = concat.call(Buffer, list, length)
        copied += out.length
        return out
    }) as typeof Buffer.concat
    Buffer.from = ((value: any, ...rest: any[]) => {
        const out = (from as any).call(Buffer, value, ...rest)
        copied += value instanceof Uint8Array ? out.length : 0
        return out
    }) as typeof Buffer.from
    try {
        f()
    } finally {
        Buffer.concat = concat
        Buffer.from = from
    }
    return copied
}

test('a packet or a frame that comes a byte at a time costs its size in copying, not its square', () => {
    // A gateway can send one-byte TLS records, each its own read: Tabby's window waits while they are joined.
    const size = 64 * 1024
    const bytes = (b: Buffer) => [...b].map(byte => Buffer.from([byte]))
    let packets = 0
    const readPackets = packetReader(() => { packets++ })
    const packetBytes = bytes(pkt(0x0a, Buffer.alloc(size)))
    const packetCopies = copiedBy(() => packetBytes.forEach(byte => readPackets(byte)))
    assert.equal(packets, 1)
    assert.ok(packetCopies < 32 * size, `${packetCopies} bytes copied for a packet of ${size}`)
    const payloads: Buffer[] = []
    const readFrames = wsReader({ data: (p: Buffer) => payloads.push(p), ping: () => { }, close: () => { } })
    const frameBytes = bytes(wsFrame(Buffer.alloc(size, 1)))
    const frameCopies = copiedBy(() => frameBytes.forEach(byte => readFrames(byte)))
    assert.ok(Buffer.concat(payloads).equals(Buffer.alloc(size, 1)))
    assert.ok(frameCopies < 32 * size, `${frameCopies} bytes copied for a frame of ${size}`)
})

test('a control frame carries 125 bytes at most', () => {
    const read = wsReader({ data: () => { }, ping: () => { }, close: () => { } })
    assert.throws(() => read(Buffer.concat([Buffer.from([0x89, 126, 0, 200]), Buffer.alloc(200)])), /control frame/)
    let pinged = 0
    wsReader({ data: () => { }, ping: () => { pinged++ }, close: () => { } })(Buffer.concat([Buffer.from([0x89, 125]), Buffer.alloc(125)]))
    assert.equal(pinged, 1)
})

test('the channel binding: the certificate under its signature\'s hash, SHA-256 at least', { skip: !certificate }, () => {
    const prefix = 'tls-server-end-point:'
    for (const [signed, hashed] of [['sha256', 'sha256'], ['sha384', 'sha384'], ['sha512', 'sha512'], ['sha1', 'sha256']]) {
        const { der } = selfSigned(signed)
        const binding: Buffer = endPointBinding(der)
        assert.equal(binding.subarray(0, prefix.length).toString(), prefix)
        assert.equal(binding.subarray(prefix.length).toString('hex'), createHash(hashed).update(der).digest('hex'), `signed with ${signed}`)
    }
    // Not a certificate: still an answer (SHA-256), not a throw.
    assert.equal(endPointBinding(Buffer.from('nonsense')).length, prefix.length + 32)
    // What goes into the sign-in: MD5 over a bindings structure with no addresses, the binding as its application data.
    const binding = Buffer.from(prefix + 'x')
    const structure = Buffer.concat([Buffer.alloc(16), Buffer.from([binding.length, 0, 0, 0]), binding])
    assert.equal(channelBindingHash(binding).toString('hex'), createHash('md5').update(structure).digest('hex'))
})

test('errors in words', () => {
    assert.match(gatewayError(0x800759da, 'pc:3389'), /doesn't let this account connect to pc:3389/)
    assert.match(gatewayError(0x59dd, 'pc:3389'), /couldn't reach pc:3389/)
    assert.match(gatewayError(0x1234, 'pc:3389'), /0x1234/)
})

test('through the gateway: signed in with NTLM, a channel to the target, data both ways', { skip: !certificate }, async () => {
    const gateway = await gatewayFor('Secret1')
    const certificates: [string, boolean, string, any][] = []
    const log: string[] = []
    const stream = await openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'CORP\\alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 },
        (fingerprint: string, valid: boolean, reason: string, details: unknown) => { certificates.push([fingerprint, valid, reason, details]) }, { log: (m: string) => log.push(m), timeoutMs: 5000 })
    assert.deepEqual(gateway.seen.requests, ['RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1', 'RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1'])
    assert.equal(gateway.seen.target, 'pc.corp:3389')
    assert.equal(certificates.length, 1)
    assert.match(certificates[0][0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    assert.equal(certificates[0][1], false)  // self-signed: not valid by any authority
    assert.equal(certificates[0][2], 'DEPTH_ZERO_SELF_SIGNED_CERT', 'and why, for the question to say')
    // And what it says of itself: made by itself, for its own name; and where its chain stands, which is checked:
    // self-signed.
    assert.deepEqual([certificates[0][3].subject, certificates[0][3].issuer, certificates[0][3].names], ['gateway.test', 'gateway.test', []])
    assert.equal(certificates[0][3].chain, 'self-signed')
    stream.write('hello')
    assert.equal((await next(stream)).toString(), 'HELLO')
    // More than a packet's worth goes in several, and comes back in order.
    const big = Buffer.alloc(100000, 'a')
    stream.write(big)
    let back = Buffer.alloc(0)
    while (back.length < big.length) {
        back = Buffer.concat([back, await next(stream)])
    }
    assert.ok(back.equals(Buffer.alloc(100000, 'A')))
    assert.ok(log.some(l => /signed in/.test(l)) && log.some(l => /channel to pc.corp:3389/.test(l)), log.join('\n'))
    stream.destroy()
    gateway.close()
})

// A gateway's own certificate, as a self-signed RD Gateway's often is (digital signature and key encipherment, which
// Node doesn't take for one that signed itself); and one this computer's authority (the tests' own) issued for
// another gateway.
const gatewaySelfSigned = selfSignedWith('gateway.test', 'keyUsage=critical,digitalSignature,keyEncipherment', 'subjectAltName=DNS:gateway.test')
const gatewayAuthority = authority('tabby-rdp gateway authority')
const anotherGateway = gatewayAuthority?.issue(['other-gateway.test'])

test('a gateway\'s certificate: self-signed whatever its key usage, and checked for the gateway\'s name whatever its chain', { skip: !gatewaySelfSigned || !anotherGateway }, async () => {
    const { whyNotValid } = require('../../dist/authorities.js')
    /** What the check heard for a gateway named gateway.test with this certificate, refused there. */
    const heard = async (served: { key: Buffer, cert: Buffer }, options: Record<string, unknown> = {}) => {
        const server = tls.createServer({ key: served.key, cert: served.cert }, socket => socket.on('error', () => { }))
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as net.AddressInfo).port
        let checked: any = null
        try {
            await assert.rejects(openThroughGateway(connect(port), { host: 'gateway.test', port }, { username: 'alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 },
                (_fingerprint: string, valid: boolean, reason: string, details: any) => {
                    checked = { valid, reason, ...details }
                    throw new Error('refused')
                }, { timeoutMs: 2000, ...options }), /refused/)
        } finally {
            server.close()
        }
        return checked
    }
    const own = await heard(gatewaySelfSigned!)
    assert.deepEqual([own.valid, own.chain, own.forName], [false, 'self-signed', true])
    assert.match(whyNotValid(own.reason, 'gateway.test', own), /^it is self-signed \(/)
    const other = await heard(anotherGateway!, { tls: { ca: gatewayAuthority!.ca } })
    assert.deepEqual([other.valid, other.reason, other.chain, other.forName], [false, 'ERR_TLS_CERT_ALTNAME_INVALID', 'authority', false])
    assert.equal(whyNotValid(other.reason, 'gateway.test', other), 'it was issued for another name than gateway.test')
})

test('answers that come a byte at a time are read all the same', { skip: !certificate }, async () => {
    const gateway = await gatewayFor('Secret1', undefined, true)
    const stream = await openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'CORP\\alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000 })
    stream.write('hi')
    assert.equal((await next(stream)).toString(), 'HI')
    stream.destroy()
    gateway.close()
})

/**
 * A gateway that answers each request of the sign-in with the next of `answers` (status line and headers), and after
 * the last sends filler for as long as the connection lasts.
 */
async function endless (...answers: string[]) {
    const sockets = new Set<tls.TLSSocket>()
    const server = tls.createServer({ key: certificate!.key, cert: certificate!.cert }, socket => {
        sockets.add(socket)
        socket.on('error', () => { })
        const left = [...answers]
        let request = Buffer.alloc(0)
        socket.on('data', chunk => {
            request = Buffer.concat([request, chunk])
            if (!left.length || request.indexOf('\r\n\r\n') < 0) {
                return
            }
            request = Buffer.alloc(0)
            socket.write(left.shift()!)
            if (left.length) {
                return
            }
            const filler = Buffer.alloc(64 * 1024, 0x41)
            const pump = () => {
                while (!socket.destroyed && socket.write(filler)) { }
                if (!socket.destroyed) {
                    socket.once('drain', pump)
                }
            }
            pump()
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const gateway = { port: (server.address() as net.AddressInfo).port, close: () => { server.close(); sockets.forEach(s => s.destroy()) } }
    standIns.push(gateway)
    return gateway
}

test('an old gateway\'s answer (no WebSocket transport) says so at once, however long it says it is', { skip: !certificate }, async () => {
    const gateway = await endless(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM ${challengeMessage().toString('base64')}\r\nContent-Length: 0\r\n\r\n`,
        'HTTP/1.1 200 OK\r\nContent-Length: 1073741824\r\n\r\n')
    const started = Date.now()
    await assert.rejects(openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'alice', password: 'x' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000 }),
        /doesn't take WebSocket connections/)
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`)
    gateway.close()
})

test('an answer whose length isn\'t one, or is more than an error page\'s, is refused at once, and none of it kept', { skip: !certificate }, async () => {
    for (const length of ['99999999999', 'abc', '-1', String(1024 * 1024)]) {
        const gateway = await endless(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM\r\nContent-Length: ${length}\r\n\r\n`)
        const started = Date.now()
        await assert.rejects(openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'alice', password: 'x' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000 }),
            /malformed or too large/, length)
        assert.ok(Date.now() - started < 2500, `${length}: took ${Date.now() - started} ms`)
        gateway.close()
    }
})

test('a gateway that takes the connection and never answers TLS is given up on', async t => {
    const sockets = new Set<net.Socket>()
    const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => { }) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.close(); sockets.forEach(s => s.destroy()) })
    const port = (server.address() as net.AddressInfo).port
    await assert.rejects(openThroughGateway(connect(port), { host: '127.0.0.1', port }, { username: 'alice', password: 'x' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 300 }),
        /didn't answer in time \(TLS\)/)
})

test('a desktop closed while the gateway\'s sign-in is under way ends it: no more is sent, and the connection goes', { skip: !certificate }, async t => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const at = (port: number) => ({ host: '127.0.0.1', port })
    const account = { username: 'alice', password: 'Secret1' }
    // While its certificate is being decided on: nothing of the sign-in is sent.
    {
        const gateway = await gatewayFor('Secret1')
        const sockets: net.Socket[] = []
        const open = async () => { const socket = await connect(gateway.port)(); sockets.push(socket); return socket }
        const closed = new AbortController()
        await assert.rejects(openThroughGateway(open, at(gateway.port), account, { host: 'pc.corp', port: 3389 },
            async () => { closed.abort(); await wait(20) }, { timeoutMs: 5000, signal: closed.signal }), /the desktop was closed meanwhile/)
        assert.deepEqual(gateway.seen.requests, [])
        assert.equal(sockets[0].destroyed, true)
        gateway.close()
    }
    // After the first message of the sign-in, while the gateway's answer comes: the second isn't sent.
    {
        const gateway = await gatewayFor('Secret1', undefined, true)
        const sockets: net.Socket[] = []
        const open = async () => { const socket = await connect(gateway.port)(); sockets.push(socket); return socket }
        const closed = new AbortController()
        const signingIn = openThroughGateway(open, at(gateway.port), account, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000, signal: closed.signal })
        const rejected = assert.rejects(signingIn)
        for (let i = 0; i < 400 && gateway.seen.requests.length < 1; i++) {
            await wait(1)
        }
        closed.abort()
        await rejected
        await wait(300)
        assert.equal(gateway.seen.requests.length, 1)
        assert.equal(sockets[0].destroyed, true)
        gateway.close()
    }
    // While TLS is awaited, from a gateway that never answers: ended at once, not after the step's time.
    {
        const sockets = new Set<net.Socket>()
        const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => { }) })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        t.after(() => { server.close(); sockets.forEach(s => s.destroy()) })
        const port = (server.address() as net.AddressInfo).port
        const closed = new AbortController()
        const started = Date.now()
        const signingIn = openThroughGateway(connect(port), at(port), account, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000, signal: closed.signal })
        const rejected = assert.rejects(signingIn)
        await wait(50)
        closed.abort()
        await rejected
        assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
    }
    // A desktop closed before it began: nothing is opened.
    const closed = new AbortController()
    closed.abort()
    let opened = 0
    await assert.rejects(openThroughGateway(async () => { opened++; return connect(0)() }, at(443), account, { host: 'pc.corp', port: 3389 }, () => { }, { signal: closed.signal }), /the desktop was closed meanwhile/)
    assert.equal(opened, 0)
})

test('a wrong password is a refused sign-in', { skip: !certificate }, async () => {
    const gateway = await gatewayFor('Secret1')
    await assert.rejects(openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'alice', domain: 'CORP', password: 'wrong' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000 }),
        (e: Error) => e instanceof GatewaySignInError && /refused the sign-in/.test(e.message))
    gateway.close()
})

test('a certificate that is refused: nothing of the account is sent', { skip: !certificate }, async () => {
    const gateway = await gatewayFor('Secret1')
    await assert.rejects(openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 },
        () => { throw new Error('not the certificate remembered') }, { timeoutMs: 5000 }), /not the certificate remembered/)
    assert.deepEqual(gateway.seen.requests, [])
    gateway.close()
})

test('the gateway\'s policies: a target it won\'t connect to, and an account it won\'t let in', { skip: !certificate }, async () => {
    const policy = await gatewayFor('Secret1', () => 0x800759da)
    await assert.rejects(openThroughGateway(connect(policy.port), { host: '127.0.0.1', port: policy.port }, { username: 'alice', password: 'Secret1' }, { host: 'secret.corp', port: 3389 }, () => { }, { timeoutMs: 5000 }),
        (e: Error) => !(e instanceof GatewaySignInError) && /doesn't let this account connect to secret.corp:3389/.test(e.message))
    policy.close()
    const unreachable = await gatewayFor('Secret1', () => 0x59dd)
    await assert.rejects(openThroughGateway(connect(unreachable.port), { host: '127.0.0.1', port: unreachable.port }, { username: 'alice', password: 'Secret1' }, { host: 'off.corp', port: 3389 }, () => { }, { timeoutMs: 5000 }),
        /couldn't reach off.corp:3389/)
    unreachable.close()
})

v8.setFlagsFromString('--expose-gc')
const gc: () => void = vm.runInNewContext('gc')
const soon = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * `count` reads as a rogue gateway can make them, each a buffer of its own (16 KiB): a frame carrying one byte of a
 * packet, and pongs to fill the rest. Each goes to `read`; what is returned holds them weakly.
 */
function paddedReads (count: number, read: (chunk: Buffer) => void): WeakRef<ArrayBufferLike>[] {
    const pong = Buffer.concat([Buffer.from([0x8a, 125]), Buffer.alloc(125)])
    const reads: WeakRef<ArrayBufferLike>[] = []
    for (let i = 0; i < count; i++) {
        const chunk = Buffer.alloc(3 + 128 * pong.length)
        chunk.set([0x82, 1, i & 0xff])
        for (let k = 0; k < 128; k++) {
            pong.copy(chunk, 3 + k * pong.length)
        }
        reads.push(new WeakRef(chunk.buffer))
        read(chunk)
    }
    return reads
}

test('a packet that comes a byte per read, padded with pongs, doesn\'t keep the reads it came in', async () => {
    // A rogue gateway leaves the packet unfinished: kept as they came, the bytes would keep their reads, 16 KiB each,
    // 4 GiB for a packet's 256 KiB. Here a thousand of them.
    const bodies: Buffer[] = []
    const read = wsReader({ data: packetReader((_: number, body: Buffer) => bodies.push(body)), ping: () => { }, close: () => { } })
    const size = 256 * 1024
    const header = Buffer.alloc(8)
    header.writeUInt16LE(0x0a, 0)
    header.writeUInt32LE(size, 4)
    read(serverFrame(header))
    const reads = paddedReads(1024, read)
    await new Promise(resolve => setImmediate(resolve))
    gc()
    const kept = reads.filter(ref => ref.deref()).length
    assert.equal(kept, 0, `${kept} of the gateway's reads are still kept`)
    // The packet is whole once the rest comes, those bytes in it.
    read(serverFrame(Buffer.alloc(size - 8 - 1024)))
    assert.equal(bodies.length, 1)
    assert.deepEqual([...bodies[0].subarray(0, 1024)], Array.from({ length: 1024 }, (_, i) => i & 0xff))
})

test('a header line with a CR or LF of its own, after however many spaces, is refused at once', { skip: !certificate }, async () => {
    // A pattern for the line (`.` stops at a lone CR or LF, and `$` waits for the end) took the square of its length.
    for (const stray of ['\n', '\r']) {
        const gateway = await endless(`HTTP/1.1 401 Unauthorized\r\nX:${' '.repeat(60000)}a${stray}b\r\nContent-Length: 0\r\n\r\n`)
        const started = performance.now()
        await assert.rejects(openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'alice', password: 'x' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000 }),
            /isn't HTTP/, JSON.stringify(stray))
        assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`)
        gateway.close()
    }
})

test('a header\'s value is trimmed, and a line that isn\'t a header is passed over', { skip: !certificate }, async () => {
    // The sign-in goes on with the challenge, however many spaces are around it; the line without a name is ignored.
    const gateway = await endless(`HTTP/1.1 401 Unauthorized\r\n: no name\r\nWWW-Authenticate:${' '.repeat(30000)}NTLM ${challengeMessage().toString('base64')}${' '.repeat(30000)}\r\nContent-Length: 0\r\n\r\n`,
        'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
    await assert.rejects(openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'alice', password: 'x' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000 }),
        (e: Error) => e instanceof GatewaySignInError)
    gateway.close()
})

test('pings get pongs, but only one waits to go out at a time: the latest ping\'s', () => {
    // A gateway that sends pings and doesn't read what comes back would otherwise have them pile up, as fast as it sends.
    const written: Buffer[] = []
    const flushed: (() => void)[] = []
    const pong = pongs({ write: (data: Buffer, done: () => void) => { written.push(data); flushed.push(done) } }, () => false)
    for (let i = 0; i < 1000; i++) {
        pong(Buffer.from(`ping ${i}`))
    }
    assert.equal(written.length, 1)
    flushed.shift()!()
    assert.equal(written.length, 2)
    flushed.shift()!()
    assert.equal(written.length, 2)
    const payloads: string[] = []
    const frames = clientFrames((opcode, payload) => payloads.push(`${opcode.toString(16)} ${payload}`))
    written.forEach(frames)
    assert.deepEqual(payloads, ['a ping 0', 'a ping 999'])
    // Nothing more once the connection has ended.
    const ended = pongs({ write: (data: Buffer, done: () => void) => { written.push(data); flushed.push(done) } }, () => true)
    ended(Buffer.from('a'))
    ended(Buffer.from('b'))
    flushed.shift()!()
    assert.equal(written.length, 3)
})

test('a gateway that sends pings and reads nothing gets one pong at a time, not one per ping', { skip: !certificate }, async () => {
    // The way to the gateway, which stops taking writes when told to (the gateway's reading stopped): the one being
    // written waits, and what comes after it piles up on this side.
    let gatewaySide: tls.TLSSocket | null = null
    const gateway = await gatewayFor('Secret1', undefined, false, socket => { gatewaySide = socket })
    let holding = false
    const held: (() => void)[] = []
    const open = async (): Promise<Duplex> => {
        const socket = await connect(gateway.port)()
        const raw: Duplex = new Duplex({
            read () { },
            write (chunk, _encoding, done) {
                const send = () => socket.write(chunk, () => done())
                holding ? held.push(send) : send()
            },
            destroy (error, done) { socket.destroy(); done(error) },
        })
        socket.on('data', d => raw.push(d))
        socket.on('error', e => raw.destroy(e))
        return raw
    }
    const stream = await openThroughGateway(open, { host: '127.0.0.1', port: gateway.port }, { username: 'CORP\\alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000 })
    holding = true
    // A thousand pings, then a data packet that says they have all been read.
    gatewaySide!.write(Buffer.concat([
        ...Array.from({ length: 1000 }, (_, i) => Buffer.concat([Buffer.from([0x89, `ping ${i}`.length]), Buffer.from(`ping ${i}`)])),
        serverFrame(dataPacket(Buffer.from('read'))),
    ]))
    assert.equal((await next(stream)).toString(), 'read')
    // The gateway reads again: what waited reaches it, and then what the tunnel sends after it.
    holding = false
    held.splice(0).forEach(send => send())
    stream.write('last')
    assert.equal((await next(stream)).toString(), 'LAST')
    assert.deepEqual(gateway.seen.pongs, ['ping 0', 'ping 999'])
    stream.destroy()
    gateway.close()
})

test('a gateway\'s ping is answered through the tunnel', { skip: !certificate }, async () => {
    const gateway = await gatewayFor('Secret1', undefined, false, socket => socket.write(Buffer.concat([Buffer.from([0x89, 5]), Buffer.from('hello')])))
    const stream = await openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'CORP\\alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 }, () => { }, { timeoutMs: 5000 })
    for (let i = 0; i < 80 && !gateway.seen.pongs.length; i++) {
        await soon()
    }
    assert.deepEqual(gateway.seen.pongs, ['hello'])
    stream.destroy()
    gateway.close()
})

test('a gateway\'s messages, however many it sends, are logged a few at most', { skip: !certificate }, async () => {
    // Its administrator's message, two hundred thousand times over, once the channel is up: each would be a line of
    // the desktop's log, which a desktop keeps for as long as it is open.
    const message = Buffer.alloc(4)
    message.write('x', 2, 'utf16le')
    const frame = serverFrame(Buffer.concat(Array.from({ length: 200 }, () => pkt(0x0b, message))))
    const flood = Buffer.concat(Array.from({ length: 1000 }, () => frame))
    const gateway = await gatewayFor('Secret1', undefined, false, socket => socket.write(flood))
    const log: string[] = []
    const stream = await openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'CORP\\alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 },
        () => { }, { log: (m: string) => log.push(m), timeoutMs: 5000 })
    stream.write('hi')
    assert.equal((await next(stream)).toString(), 'HI')
    const messages = log.filter(l => /administrator/.test(l))
    assert.equal(messages.length, 11, `${messages.length} lines`)
    assert.equal(messages.at(-1), 'gateway: more messages from its administrator; past 10, they aren\'t logged')
    stream.destroy()
    gateway.close()
})

test('a service message as long as a packet is logged in part, without holding Tabby up', { skip: !certificate }, async () => {
    // Its text, then NULs to the end of the packet and one other character: stripping NULs at the end with a pattern
    // took the square of the message's length, seconds for this one, at any time during a session.
    const body = Buffer.alloc(256 * 1024 - 8)
    body.write('Maintenance tonight', 2, 'utf16le')
    body.write('x', body.length - 2, 'utf16le')
    const gateway = await gatewayFor('Secret1', undefined, false, socket => socket.write(serverFrame(pkt(0x0b, body))))
    const log: string[] = []
    const started = performance.now()
    const stream = await openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'CORP\\alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 },
        () => { }, { log: (m: string) => log.push(m), timeoutMs: 5000 })
    stream.write('hi')
    assert.equal((await next(stream)).toString(), 'HI')
    assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`)
    assert.ok(log.includes('gateway: its administrator\'s message: Maintenance tonight'), log.join('\n'))
    stream.destroy()
    gateway.close()
})
