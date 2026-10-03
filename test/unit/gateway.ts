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
import * as tls from 'node:tls'

const require = createRequire(import.meta.url)
const { openThroughGateway, parseGateway, GatewaySignInError, packetReader, wsFrame, wsReader, dataPacket, gatewayError, endPointBinding } = require('../../dist/gateway.js')
const { ntlmV2Hash, channelBindingHash } = require('../../dist/ntlm.js')
const { specOf } = require('../../dist/desktops.js')

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
    const header = payload.length < 126 ? Buffer.from([0x82, payload.length]) : Buffer.from([0x82, 126, payload.length >> 8, payload.length & 0xff])
    return Buffer.concat([header, payload])
}

/**
 * A stand-in gateway: one account, a policy for which targets it lets through, and an echo behind the channel
 * (what arrives in data packets comes back in upper case).
 */
function standIn (password: string, allow: (target: string) => number = () => 0) {
    const seen = { requests: [] as string[], target: '', closed: false }
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
            } else if (type === 0x0a) {
                const data = body.subarray(2, 2 + body.readUInt16LE(0))
                inPieces(serverFrame(dataPacket(Buffer.from(data.toString('latin1').toUpperCase(), 'latin1'))))
            } else if (type === 0x10) seen.closed = true
        })
        const frames = wsReader({ data: packets, ping: () => { }, close: () => socket.end() })
        socket.on('error', () => { })
        socket.on('data', chunk => {
            if (upgraded) {
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
                socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nWWW-Authenticate: NTLM ${challengeMessage().toString('base64')}\r\nContent-Length: ${page.length}\r\n\r\n${page}`)
            } else if (auth.length >= 12 && auth.readUInt32LE(8) === 3 && proves(auth, password)) {
                const key = /^Sec-WebSocket-Key: (.+)$/mi.exec(head)![1]
                const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
                socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
                upgraded = true
            } else {
                socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM\r\nContent-Length: ${page.length}\r\n\r\n${page}`)
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
const gatewayFor = async (password: string, allow?: (target: string) => number) => {
    const gateway = await standIn(password, allow)
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
    const certificates: [string, boolean][] = []
    const log: string[] = []
    const stream = await openThroughGateway(connect(gateway.port), { host: '127.0.0.1', port: gateway.port }, { username: 'CORP\\alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 },
        (fingerprint: string, valid: boolean) => { certificates.push([fingerprint, valid]) }, { log: (m: string) => log.push(m), timeoutMs: 5000 })
    assert.deepEqual(gateway.seen.requests, ['RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1', 'RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1'])
    assert.equal(gateway.seen.target, 'pc.corp:3389')
    assert.equal(certificates.length, 1)
    assert.match(certificates[0][0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    assert.equal(certificates[0][1], false)  // self-signed: not valid by any authority
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
