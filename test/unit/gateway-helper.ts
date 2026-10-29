// A desktop's RD Gateway: the setting that names one (src/gateway.ts: parseGateway and formatGateway, and a desktop's
// spec), and the tunnel through one as the plugin uses it. The tunnel itself (TLS, the WebSocket upgrade with an NTLM
// sign-in, the tunnel's packets, the answers a gateway can give, a desktop closed during the setting up) is the
// network helper's, and its own tests have it part by part: helper/internal/gateway (go test). Here it goes through the
// helper as a desktop's connection does: the proxy is given a gateway as the way to a server (a GatewayUpstream), a
// client sends its RDCleanPath request, and a stand-in gateway checks the sign-in as a gateway does (with the account's
// hash, for the TLS connection it is made over, and the service it is for). What this side decides comes first: the
// gateway's certificate, before the account is even asked for; and what it hears back: a refused sign-in, the tunnel
// up. Needs the openssl command for the stand-in's certificates. Runs against the built plugin and helper:
// npm run build && npm run build:helper && npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, createHmac } from 'node:crypto'
import * as net from 'node:net'
import * as tls from 'node:tls'

const require = createRequire(import.meta.url)
const { parseGateway, formatGateway } = require('../../dist/gateway.js')
const { specOf } = require('../../dist/desktops.js')
const { startRDCleanPathProxy } = require('../../dist/rdcleanpath.js')
const { whyNotValid } = require('../../dist/authorities.js')
const WebSocket = require('ws')
import { authority, selfSigned, type Certificate } from './support/certificates.js'

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

// ---- the stand-in gateway ------------------------------------------------------------------------------

// The stand-in's own certificate (self-signed, as an RD Gateway's often is); null without openssl, and the tests that
// need it are skipped.
const certificate = selfSigned('gateway.test')

const SERVER_CHALLENGE = Buffer.from('1122334455667788', 'hex')
/**
 * The NT hash of the stand-in's one password, `password`: MD4 of it in UTF-16, the hash every NTLM sign-in starts
 * from (Node's OpenSSL no longer computes MD4; this one is well known, and the helper's MD4 gives it too).
 */
const NT_HASH = Buffer.from('8846f7eaee8fb117ad06bdd830b7586c', 'hex')
const u16 = (text: string) => Buffer.from(text, 'utf16le')
const hmacMd5 = (key: Buffer, ...data: Buffer[]) => data.reduce((h, d) => h.update(d), createHmac('md5', key)).digest()

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
 * Why an NTLM authenticate message doesn't prove the stand-in's password for CORP\alice on a TLS connection with the
 * certificate `served`, or '' if it does: a gateway (extended protection, its default) also wants the hash of its own
 * certificate's binding among the pairs (MD5 over a bindings structure with no addresses, the binding as its
 * application data), and the name of the service it is for.
 */
function disproof (message: Buffer, served: Certificate): string {
    const field = (i: number) => message.subarray(message.readUInt32LE(16 + i * 8), message.readUInt32LE(16 + i * 8) + message.readUInt16LE(12 + i * 8))
    const [nt, domain, user] = [field(1), field(2).toString('utf16le'), field(3).toString('utf16le')]
    if (user !== 'alice' || domain !== 'CORP') {
        return `another account (${domain}\\${user})`
    }
    const hash = hmacMd5(NT_HASH, u16(user.toUpperCase() + domain))
    if (!hmacMd5(hash, SERVER_CHALLENGE, nt.subarray(16)).equals(nt.subarray(0, 16))) {
        return 'the proof'
    }
    const binding = Buffer.concat([Buffer.from('tls-server-end-point:'), createHash('sha256').update(served.der).digest()])
    const length = Buffer.alloc(4)
    length.writeUInt32LE(binding.length)
    if (!pairOf(nt, 10)?.equals(createHash('md5').update(Buffer.concat([Buffer.alloc(16), length, binding])).digest())) {
        return 'the channel binding'
    }
    return pairOf(nt, 9)?.toString('utf16le') === 'HTTP/127.0.0.1' ? '' : 'the target name'
}

const pkt = (type: number, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt16LE(type, 0); h.writeUInt32LE(8 + body.length, 4); return Buffer.concat([h, body]) }
/** An unmasked frame, as a server's are. */
const serverFrame = (payload: Buffer) => {
    const long = Buffer.alloc(8)
    long.writeBigUInt64BE(BigInt(payload.length))
    const header = payload.length < 126 ? Buffer.from([0x82, payload.length])
        : payload.length < 65536 ? Buffer.from([0x82, 126, payload.length >> 8, payload.length & 0xff]) : Buffer.concat([Buffer.from([0x82, 127]), long])
    return Buffer.concat([header, payload])
}

/** The client's frames as a gateway reads them (masked): each frame's opcode and payload, unmasked, however the bytes are cut. */
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

/** The packets inside the frames' payloads, however they are cut. */
function packetReader (onPacket: (type: number, body: Buffer) => void): (data: Buffer) => void {
    let pending = Buffer.alloc(0)
    return data => {
        pending = Buffer.concat([pending, data])
        while (pending.length >= 8 && pending.readUInt32LE(4) >= 8 && pending.length >= pending.readUInt32LE(4)) {
            const length = pending.readUInt32LE(4)
            onPacket(pending.readUInt16LE(0), pending.subarray(8, length))
            pending = pending.subarray(length)
        }
    }
}

/**
 * A stand-in gateway: one account (CORP\alice, whose password is `password`), a status for each of its answers (a
 * refusal: `refuse`, by the packet type of the request it answers), and behind the channel an echo: what arrives in
 * data packets is kept, and goes back as it came.
 */
function standIn (refuse: Record<number, number> = {}) {
    const seen = { requests: [] as string[], afterTls: 0, why: [] as string[], target: '', clientName: '', data: Buffer.alloc(0), ended: 0 }
    const sockets = new Set<tls.TLSSocket>()
    const server = tls.createServer({ key: certificate!.key, cert: certificate!.cert }, socket => {
        sockets.add(socket)
        socket.on('error', () => { })
        socket.on('close', () => seen.ended++)
        let http = Buffer.alloc(0)
        let upgraded = false
        const send = (type: number, body: Buffer) => socket.write(serverFrame(pkt(type, body)))
        const status = (type: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(refuse[type] ?? 0); return b }
        const packets = packetReader((type, body) => {
            if (type === 0x01) {
                send(0x02, Buffer.concat([status(type), Buffer.from([1, 0, 0, 0, 0, 0])]))
            } else if (type === 0x04) {
                send(0x05, Buffer.concat([Buffer.alloc(2), status(type), Buffer.alloc(4)]))
            } else if (type === 0x06) {
                seen.clientName = body.subarray(4, 4 + body.readUInt16LE(2)).toString('utf16le').replace(/\0$/, '')
                send(0x07, Buffer.concat([status(type), Buffer.alloc(4)]))
            } else if (type === 0x08) {
                seen.target = `${body.subarray(8, 8 + body.readUInt16LE(6)).toString('utf16le').replace(/\0$/, '')}:${body.readUInt16LE(2)}`
                send(0x09, Buffer.concat([status(type), Buffer.alloc(4)]))
            } else if (type === 0x0a) {
                const data = body.subarray(2, 2 + body.readUInt16LE(0))
                seen.data = Buffer.concat([seen.data, data])
                send(0x0a, body.subarray(0, 2 + data.length))
            }
        })
        const frames = clientFrames((opcode, payload) => opcode === 0x8 ? socket.end() : opcode <= 0x2 && packets(payload))
        socket.on('data', data => {
            const chunk = Buffer.from(data)
            seen.afterTls += chunk.length
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
            const refused = `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: NTLM\r\nContent-Length: ${page.length}\r\n\r\n${page}`
            if (auth.length >= 12 && auth.readUInt32LE(8) === 1) {
                socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nWWW-Authenticate: NTLM ${challengeMessage().toString('base64')}\r\nContent-Length: ${page.length}\r\n\r\n${page}`)
            } else if (auth.length >= 12 && auth.readUInt32LE(8) === 3) {
                const why = disproof(auth, certificate!)
                if (why) {
                    seen.why.push(why)
                    socket.write(refused)
                    return
                }
                const key = /^Sec-WebSocket-Key: (.+)$/mi.exec(head)![1]
                const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
                socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
                upgraded = true
                if (http.length) {
                    frames(http)
                }
            } else {
                socket.write(refused)
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
const gatewayFor = async (refuse?: Record<number, number>) => {
    const gateway = await standIn(refuse)
    standIns.push(gateway)
    return gateway
}

const connect = (port: number) => () => new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
    socket.once('error', reject)
})
const soon = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))
const until = async (ok: () => boolean, ms = 5000) => {
    for (let waited = 0; !ok() && waited < ms; waited += 25) {
        await soon()
    }
    return ok()
}

// ---- through the helper -------------------------------------------------------------------------------

const der = (tag: number, content: Buffer) => {
    const n = content.length
    const length = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
    return Buffer.concat([Buffer.from([tag, ...length]), content])
}
/** The client's X.224 connection request, which the proxy sends through the tunnel to the server (here, the echo). */
const X224_REQUEST = Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0])
/** An RDCleanPath request: version 3390, a destination, the token, the X.224 request. */
const request = (token: string) => der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
    der(0xa2, der(0x0c, Buffer.from('server:3389'))),
    der(0xa3, der(0x0c, Buffer.from(token))),
    der(0xa6, der(0x04, X224_REQUEST)),
]))

/**
 * Connects a client through the proxy and sends its request, and waits for the connection to end: through the
 * gateway, the X.224 request comes back from the echo as the server's answer, which is no confirm (one without a
 * negotiation: standard RDP security only), so the proxy goes no further than that.
 */
async function attempt (proxy: any): Promise<void> {
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    let timer: NodeJS.Timeout | undefined
    const gone = new Promise<void>(resolve => {
        ws.once('close', () => resolve())
        timer = setTimeout(resolve, 10000)
    })
    ws.send(request(proxy.token))
    await gone
    clearTimeout(timer)
    ws.terminate()
}

/** What a GatewayUpstream was asked and told, in order: its certificate, its account, a refusal, the tunnel up. */
interface Heard {
    events: string[]
    certificates: { fingerprint: string, valid: boolean, reason: string, details: any }[]
}

/**
 * A GatewayUpstream for the stand-in at `port` (or for `host`, reached there), to pc.corp:3389, signing in as
 * CORP\alice with `password`; the certificate check takes the certificate unless `refuse` says why not. The events it
 * hears go to `heard`, with how many requests of the sign-in the stand-in had by then.
 */
function upstream (port: number, heard: Heard, options: { password?: string, host?: string, direct?: boolean, target?: string, refuse?: string, seen?: { requests: string[] } } = {}) {
    const by = () => options.seen ? ` (${options.seen.requests.length})` : ''
    return {
        gateway: { host: options.host ?? '127.0.0.1', port },
        target: { host: options.target ?? 'pc.corp', port: 3389 },
        via: options.direct ? { direct: { host: '127.0.0.1', port } } : connect(port),
        clientName: 'office-laptop',
        timeoutMs: 5000,
        checkCertificate: (fingerprint: string, valid: boolean, reason: string, details: unknown) => {
            heard.events.push(`certificate${by()}`)
            heard.certificates.push({ fingerprint, valid, reason, details })
            if (options.refuse) {
                throw new Error(options.refuse)
            }
        },
        account: () => {
            heard.events.push(`account${by()}`)
            return { username: 'alice', domain: 'CORP', password: options.password ?? 'password' }
        },
        refused: (message: string) => { heard.events.push(`refused: ${message}`) },
        opened: () => { heard.events.push('opened') },
    }
}

const fingerprintOf = (cert: Certificate) => createHash('sha256').update(cert.der).digest('hex').toUpperCase().match(/../g)!.join(':')

for (const way of ['a stream of the plugin\'s', 'the helper\'s own connection'] as const) {
    test(`through the gateway, by ${way}: its certificate decided on first, then signed in with NTLM, and a channel to the target`, { skip: !certificate }, async t => {
        const gateway = await gatewayFor()
        const heard: Heard = { events: [], certificates: [] }
        const log: string[] = []
        let serverChecked = 0
        const proxy = await startRDCleanPathProxy(async () => upstream(gateway.port, heard, { direct: way !== 'a stream of the plugin\'s', seen: gateway.seen }),
            () => { serverChecked++ }, (m: string) => log.push(m))
        t.after(() => proxy.close())
        await attempt(proxy)
        // The certificate before anything of the sign-in, and the account only then; the stand-in took the sign-in.
        assert.deepEqual(heard.events, ['certificate (0)', 'account (0)', 'opened'], log.join('\n'))
        assert.deepEqual(gateway.seen.requests, ['RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1', 'RDG_OUT_DATA /remoteDesktopGateway/ HTTP/1.1'])
        assert.deepEqual(gateway.seen.why, [])
        assert.equal(gateway.seen.target, 'pc.corp:3389')
        assert.equal(gateway.seen.clientName, 'office-laptop')
        // Self-signed: not valid by any authority, and why, for the question to say; and what it says of itself.
        const [checked] = heard.certificates
        assert.equal(checked.fingerprint, fingerprintOf(certificate!))
        assert.deepEqual([checked.valid, checked.reason], [false, 'DEPTH_ZERO_SELF_SIGNED_CERT'])
        assert.deepEqual([checked.details.subject, checked.details.issuer, checked.details.chain], ['gateway.test', 'gateway.test', 'self-signed'])
        assert.ok(log.some(l => l === 'gateway: signed in to 127.0.0.1') && log.some(l => l === 'gateway: channel to pc.corp:3389 through 127.0.0.1'), log.join('\n'))
        // Through the channel: the client's X.224 request, as it sent it; and back from the echo, the same, which isn't a
        // server's answer. So no server certificate, and no relay.
        assert.equal(gateway.seen.data.toString('hex'), X224_REQUEST.toString('hex'))
        assert.match(proxy.failure ?? '', /standard RDP security/)
        assert.equal(serverChecked, 0)
        assert.ok(!log.some(l => /relay up/.test(l)), log.join('\n'))
    })
}

test('a gateway\'s certificate that is refused: the account isn\'t asked for, and nothing after TLS reaches the gateway', { skip: !certificate }, async t => {
    const gateway = await gatewayFor()
    const heard: Heard = { events: [], certificates: [] }
    const proxy = await startRDCleanPathProxy(async () => upstream(gateway.port, heard, { refuse: 'not the certificate remembered' }), () => { })
    t.after(() => proxy.close())
    await attempt(proxy)
    assert.deepEqual(heard.events, ['certificate'])
    assert.match(proxy.failure ?? '', /not the certificate remembered/)
    assert.ok(await until(() => gateway.seen.ended === 1), 'the connection to the gateway ended')
    assert.deepEqual(gateway.seen.requests, [])
    assert.equal(gateway.seen.afterTls, 0)
})

test('a client that leaves while the gateway\'s certificate is being decided: the account isn\'t asked for, and nothing of the sign-in goes out', { skip: !certificate }, async t => {
    const gateway = await gatewayFor()
    const heard: Heard = { events: [], certificates: [] }
    let decide = () => { }
    const decided = new Promise<void>(resolve => { decide = resolve })
    const proxy = await startRDCleanPathProxy(async () => ({
        ...upstream(gateway.port, heard),
        checkCertificate: () => { heard.events.push('certificate'); return decided },
    }), () => { })
    t.after(() => { decide(); proxy.close() })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await new Promise<void>(resolve => ws.once('open', resolve))
    ws.send(request(proxy.token))
    assert.ok(await until(() => heard.events.length === 1), 'the certificate was asked about')
    const gone = new Promise<void>(resolve => ws.once('close', () => resolve()))
    ws.terminate()
    await gone
    assert.ok(await until(() => gateway.seen.ended === 1), 'the connection to the gateway ended')
    // The decision comes after all: too late to go on with.
    decide()
    await soon(300)
    assert.deepEqual(heard.events, ['certificate'])
    assert.deepEqual(gateway.seen.requests, [])
    assert.equal(gateway.seen.afterTls, 0)
})

test('a desktop closed while its gateway account is being asked for (a prompt, say): the account given after that isn\'t sent', { skip: !certificate }, async t => {
    const gateway = await gatewayFor()
    const heard: Heard = { events: [], certificates: [] }
    let give = () => { }
    const given = new Promise<void>(resolve => { give = resolve })
    const proxy = await startRDCleanPathProxy(async () => ({
        ...upstream(gateway.port, heard),
        account: async () => {
            heard.events.push('account')
            await given
            return { username: 'alice', domain: 'CORP', password: 'password' }
        },
    }), () => { })
    t.after(() => { give(); proxy.close() })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await new Promise<void>(resolve => ws.once('open', resolve))
    ws.send(request(proxy.token))
    assert.ok(await until(() => heard.events.includes('account')), 'the account was asked for')
    proxy.close()
    give()
    await proxy.stopped
    assert.deepEqual(heard.events, ['certificate', 'account'])
    assert.deepEqual(gateway.seen.requests, [])
    assert.deepEqual(gateway.seen.why, [])
    ws.terminate()
})

test('a wrong password is a refused sign-in: the desktop hears it in the gateway\'s words, and so does the proxy\'s failure', { skip: !certificate }, async t => {
    const gateway = await gatewayFor()
    const heard: Heard = { events: [], certificates: [] }
    const proxy = await startRDCleanPathProxy(async () => upstream(gateway.port, heard, { password: 'wrong' }), () => { })
    t.after(() => proxy.close())
    await attempt(proxy)
    assert.deepEqual(heard.events, ['certificate', 'account', 'refused: The gateway refused the sign-in.'])
    assert.equal(proxy.failure, 'The gateway refused the sign-in.')
    assert.deepEqual(gateway.seen.why, ['the proof'])
})

test('the gateway\'s policies: a target it won\'t connect to is the target\'s, an account it won\'t let in is a refused sign-in', { skip: !certificate }, async t => {
    // Its resource authorization policy, at the channel: the desktop isn't told the account was refused.
    const target = await gatewayFor({ 0x08: 0x800759da })
    const heard: Heard = { events: [], certificates: [] }
    const proxy = await startRDCleanPathProxy(async () => upstream(target.port, heard, { target: 'secret.corp' }), () => { })
    t.after(() => proxy.close())
    await attempt(proxy)
    assert.deepEqual(heard.events, ['certificate', 'account'])
    assert.equal(proxy.failure, 'the gateway doesn\'t let this account connect to secret.corp:3389 (its resource authorization policy)')
    // Its connection authorization policy, at the tunnel's authorization: the account's doing, as a refused sign-in is.
    const account = await gatewayFor({ 0x06: 0x800759db })
    const refused: Heard = { events: [], certificates: [] }
    const other = await startRDCleanPathProxy(async () => upstream(account.port, refused), () => { })
    t.after(() => other.close())
    await attempt(other)
    const words = 'The gateway doesn\'t let this account connect (its connection authorization policy).'
    assert.deepEqual(refused.events, ['certificate', 'account', `refused: ${words}`])
    assert.equal(other.failure, words)
})

// A gateway's own certificate, as a self-signed RD Gateway's often is (digital signature and key encipherment, which
// OpenSSL doesn't take for one that signed itself); one this computer's authority (the tests' own) issued for another
// gateway; and one it issued for this one.
const gatewaySelfSigned = selfSigned('gateway.test', 'keyUsage=critical,digitalSignature,keyEncipherment', 'subjectAltName=DNS:gateway.test')
const gatewayAuthority = authority('tabby-rdp gateway authority')
const anotherGateway = gatewayAuthority?.issue(['other-gateway.test'])
const thisGateway = gatewayAuthority?.issue(['gateway.test'])

test('a gateway\'s certificate: self-signed whatever its key usage, and checked for the gateway\'s name whatever its chain, by the authorities given', { skip: !gatewaySelfSigned || !anotherGateway || !thisGateway }, async () => {
    /** What the check heard for a gateway named gateway.test with this certificate, refused there. */
    const heardFor = async (served: Certificate, options: Record<string, unknown> = {}) => {
        const server = tls.createServer({ key: served.key, cert: served.cert }, socket => socket.on('error', () => { }))
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as net.AddressInfo).port
        const heard: Heard = { events: [], certificates: [] }
        const proxy = await startRDCleanPathProxy(async () => upstream(port, heard, { host: 'gateway.test', refuse: 'refused' }), () => { }, () => { }, { withoutNla: () => { }, ...options })
        try {
            await attempt(proxy)
            assert.match(proxy.failure ?? '', /refused/)
        } finally {
            proxy.close()
            server.close()
        }
        assert.deepEqual(heard.events, ['certificate'])
        const [{ valid, reason, details }] = heard.certificates
        return { valid, reason, ...details }
    }
    const own = await heardFor(gatewaySelfSigned!)
    assert.deepEqual([own.valid, own.chain, own.forName], [false, 'self-signed', true])
    assert.match(whyNotValid(own.reason, 'gateway.test', own), /^it is self-signed \(/)
    const other = await heardFor(anotherGateway!, { tls: { ca: gatewayAuthority!.ca } })
    assert.deepEqual([other.valid, other.reason, other.chain, other.forName], [false, 'ERR_TLS_CERT_ALTNAME_INVALID', 'authority', false])
    assert.equal(whyNotValid(other.reason, 'gateway.test', other), 'it was issued for another name than gateway.test')
    // Its own, from an authority given: valid. Without that authority, the same certificate is no authority's word.
    const vouched = await heardFor(thisGateway!, { tls: { ca: gatewayAuthority!.ca } })
    assert.deepEqual([vouched.valid, vouched.reason], [true, ''])
    const unknown = await heardFor(thisGateway!)
    assert.equal(unknown.valid, false)
})
