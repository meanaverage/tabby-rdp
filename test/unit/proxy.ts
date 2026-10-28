// The loopback proxy's edges (src/rdcleanpath.ts): what a client can do before it has shown the token, a client
// that leaves while the server is being reached, and closing the proxy. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Duplex } from 'node:stream'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'

const require = createRequire(import.meta.url)
const { startRDCleanPathProxy, FLOW_WINDOW, SERVER_BACKLOG } = require('../../dist/rdcleanpath.js')
const WebSocket = require('ws')
import { authority, signedWith } from './support/certificates.js'

const der = (tag: number, content: Buffer) => {
    const n = content.length
    const length = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
    return Buffer.concat([Buffer.from([tag, ...length]), content])
}
/**
 * A version 2 pre-connection PDU ([MS-RDPEPS] 2.2.1.2) carrying `text`, as the proxy (in the network helper) sends it
 * first to a Hyper-V host: what these tests expect it to send. The helper's own tests check its PDU field by field.
 */
function preconnectionPdu (text: string): Buffer {
    const blob = Buffer.from(text + '\0', 'utf16le')
    const pdu = Buffer.alloc(18 + blob.length)
    pdu.writeUInt32LE(pdu.length, 0)
    pdu.writeUInt32LE(2, 8)
    pdu.writeUInt16LE(blob.length / 2, 16)
    blob.copy(pdu, 18)
    return pdu
}

/** An RDCleanPath request: version 3390, a destination, the token, an X.224 request. */
const request = (token: string) => der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
    der(0xa2, der(0x0c, Buffer.from('server:3389'))),
    der(0xa3, der(0x0c, Buffer.from(token))),
    der(0xa6, der(0x04, Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0]))),
]))
const closed = (ws: any) => new Promise<number>(resolve => ws.once('close', (code: number) => resolve(code)))
const opened = (ws: any) => new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
const soon = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms))

/** An upstream that never answers, keeps what it was sent, and says when it was destroyed. */
function silentUpstream (): { open: () => Promise<Duplex>, streams: Duplex[], sent: Buffer[] } {
    const streams: Duplex[] = []
    const sent: Buffer[] = []
    return {
        streams,
        sent,
        open: async () => {
            const stream = new Duplex({ read () { }, write (chunk, _encoding, done) { sent.push(Buffer.from(chunk)); done() } })
            streams.push(stream)
            return stream
        },
    }
}

/** A request for a Hyper-V VM's console: a pre-connection blob and no X.224 request. */
const consoleRequest = (token: string, blob: string) => der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
    der(0xa2, der(0x0c, Buffer.from('host:2179'))),
    der(0xa3, der(0x0c, Buffer.from(token))),
    der(0xa5, der(0x0c, Buffer.from(blob))),
]))

test('a first message past a request\'s size ends the connection, before any token', async () => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    // A DER header claiming two gigabytes, then data: nothing of it is kept past the limit.
    ws.send(Buffer.concat([Buffer.from([0x30, 0x84, 0x7f, 0xff, 0xff, 0xff]), Buffer.alloc(40 * 1024)]))
    ws.send(Buffer.alloc(40 * 1024))
    await closed(ws)
    assert.equal(upstream.streams.length, 0)
    proxy.close()
})

test('a wrong token gets nothing', async () => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    ws.send(request('not-the-token'))
    await closed(ws)
    assert.equal(upstream.streams.length, 0)
    assert.equal(proxy.failure, 'bad token')
    proxy.close()
})

test('a client that leaves while the server is being reached takes the connection with it', async () => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    const ws = new WebSocket(proxy.url)
    await opened(ws)
    ws.send(request(proxy.token))
    for (let i = 0; i < 40 && !upstream.streams.length; i++) {
        await soon(25)
    }
    assert.equal(upstream.streams.length, 1)
    assert.equal(upstream.streams[0].destroyed, false)
    ws.terminate()
    for (let i = 0; i < 40 && !upstream.streams[0].destroyed; i++) {
        await soon(25)
    }
    assert.equal(upstream.streams[0].destroyed, true)
    proxy.close()
})

test('closing the proxy ends its clients, idle ones too', async () => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    const idle = new WebSocket(proxy.url)
    idle.on('error', () => { })
    await opened(idle)
    const busy = new WebSocket(proxy.url)
    busy.on('error', () => { })
    await opened(busy)
    busy.send(request(proxy.token))
    for (let i = 0; i < 40 && !upstream.streams.length; i++) {
        await soon(25)
    }
    const ended = Promise.all([closed(idle), closed(busy)])
    proxy.close()
    await ended
    for (let i = 0; i < 40 && !upstream.streams[0].destroyed; i++) {
        await soon(25)
    }
    assert.equal(upstream.streams[0].destroyed, true)
})

/** Whether a connection to `url` is turned away; `origin` is what a browser's page would send. */
const turnedAway = (url: string, origin?: string) => new Promise<boolean>(resolve => {
    const ws = new WebSocket(url, origin ? { origin } : {})
    ws.once('open', () => { ws.terminate(); resolve(false) })
    ws.once('error', () => resolve(true))
})

test('a connection without the token in its address is turned away, and takes none of the places', async t => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    t.after(() => proxy.close())
    const base = `ws://127.0.0.1:${new URL(proxy.url).port}`
    for (const url of [base, `${base}/`, `${base}/${'0'.repeat(proxy.token.length)}`, `${base}/${proxy.token}x`]) {
        assert.equal(await turnedAway(url), true, url)
    }
    // Something that doesn't know the token tries for every place at once: the desktop's own client still gets in,
    // and through to the server.
    const tries = Array.from({ length: 8 }, () => turnedAway(base))
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    ws.send(request(proxy.token))
    for (let i = 0; i < 40 && !upstream.streams.length; i++) {
        await soon(25)
    }
    assert.equal(upstream.streams.length, 1)
    assert.ok((await Promise.all(tries)).every(Boolean))
})

test('a web page is turned away, even with the token; a page that is a file (Tabby\'s own) is not', async t => {
    const proxy = await startRDCleanPathProxy(silentUpstream().open, () => { })
    t.after(() => proxy.close())
    assert.equal(await turnedAway(proxy.url, 'https://example.com'), true)
    assert.equal(await turnedAway(proxy.url, 'http://127.0.0.1:8080'), true)
    // A sandboxed page, or one from a data: URL, says `null`; an extension's page says its own scheme.
    assert.equal(await turnedAway(proxy.url, 'null'), true)
    assert.equal(await turnedAway(proxy.url, 'chrome-extension://abcdefghijklmnop'), true)
    // Tabby's window (a file's page: Electron sends `file://`), and a client that isn't a page at all.
    assert.equal(await turnedAway(proxy.url, 'file://'), false)
    assert.equal(await turnedAway(proxy.url), false)
})

test('a token of the right length that is wrong gets nothing either', async t => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    t.after(() => proxy.close())
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    ws.send(request(proxy.token.replace(/.$/, (c: string) => c === '0' ? '1' : '0')))
    await closed(ws)
    assert.equal(upstream.streams.length, 0)
    assert.equal(proxy.failure, 'bad token')
})

test('no more than a few clients at once', async () => {
    const proxy = await startRDCleanPathProxy(silentUpstream().open, () => { })
    const clients = []
    for (let i = 0; i < 4; i++) {
        const ws = new WebSocket(proxy.url)
        ws.on('error', () => { })
        await opened(ws)
        clients.push(ws)
    }
    const extra = new WebSocket(proxy.url)
    extra.on('error', () => { })
    await closed(extra)
    assert.ok(clients.every(ws => ws.readyState === WebSocket.OPEN))
    proxy.close()
})

test('a Hyper-V VM\'s console: the blob goes first, then TLS at once, no X.224 from the proxy', async () => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    const blob = '5f05e000-c4d4-499c-8cca-429587811556;EnhancedMode=1'
    ws.send(consoleRequest(proxy.token, blob))
    for (let i = 0; i < 40 && upstream.sent.length < 2; i++) {
        await soon(25)
    }
    const sent = Buffer.concat(upstream.sent)
    const pcb: Buffer = preconnectionPdu(blob)
    assert.deepEqual(sent.subarray(0, pcb.length), pcb)
    // A TLS handshake record (ClientHello) follows; an X.224 request would start with TPKT's 3.
    assert.equal(sent[pcb.length], 0x16)
    proxy.close()
})

test('a request with a blob and an X.224 request sends both, the blob first', async () => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    const x224 = Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0])
    ws.send(der(0x30, Buffer.concat([
        der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
        der(0xa2, der(0x0c, Buffer.from('server:3389'))),
        der(0xa3, der(0x0c, Buffer.from(proxy.token))),
        der(0xa5, der(0x0c, Buffer.from('route-me'))),
        der(0xa6, der(0x04, x224)),
    ])))
    for (let i = 0; i < 40 && Buffer.concat(upstream.sent).length < 18 + 18 + x224.length; i++) {
        await soon(25)
    }
    assert.deepEqual(Buffer.concat(upstream.sent), Buffer.concat([preconnectionPdu('route-me'), x224]))
    proxy.close()
})

test('a request with neither an X.224 request nor a blob is refused', async () => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    ws.send(der(0x30, Buffer.concat([
        der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
        der(0xa2, der(0x0c, Buffer.from('server:3389'))),
        der(0xa3, der(0x0c, Buffer.from(proxy.token))),
    ])))
    await closed(ws)
    assert.equal(proxy.failure, 'malformed request')
    assert.equal(upstream.streams.length, 0)
    proxy.close()
})

/** A server's answer to the connection request: a confirm choosing this security protocol (or refusing, `failure`). */
const confirm = (selected: number, failure = false) => Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, failure ? 3 : 2, 0, 8, 0, selected, 0, 0, 0])

/** An upstream that answers the connection request with `answer`, and keeps what it was sent. */
function answeringUpstream (answer: Buffer): { open: () => Promise<Duplex>, sent: Buffer[] } {
    const sent: Buffer[] = []
    return {
        sent,
        open: async () => {
            const stream: Duplex = new Duplex({
                read () { },
                write (chunk, _encoding, done) {
                    if (!sent.length) {
                        stream.push(answer)
                    }
                    sent.push(Buffer.from(chunk))
                    done()
                },
            })
            return stream
        },
    }
}

test('an answer to the connection request that isn\'t RDP is refused at once, not waited on for the length it seems to give', async t => {
    // A web server on the desktop's port, say: "HTTP" would be TPKT's version and reserved byte, and 21 KB to wait for.
    // And a TPKT header too short to hold any X.224 answer.
    for (const answer of [Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'), Buffer.from([3, 0, 0, 4])]) {
        const upstream = answeringUpstream(answer)
        const proxy = await startRDCleanPathProxy(upstream.open, () => { })
        const ws = new WebSocket(proxy.url)
        t.after(() => { ws.terminate(); proxy.close() })
        ws.on('error', () => { })
        await opened(ws)
        const gone = closed(ws)
        ws.send(request(proxy.token))
        assert.equal(await Promise.race([gone.then(() => 'refused'), soon(2000).then(() => 'still waiting')]), 'refused')
        assert.match(proxy.failure ?? '', /isn't RDP/)
    }
})

test('a server without Network Level Authentication: asked about before anything more goes to it', async () => {
    // Refused: the server got the connection request and nothing else, and the client hears a failure.
    const refusedUpstream = answeringUpstream(confirm(1))
    const log: string[] = []
    let asked = 0
    const refusing = await startRDCleanPathProxy(refusedUpstream.open, () => { }, (m: string) => log.push(m), {
        withoutNla: () => { asked++; throw new Error('the server doesn\'t use Network Level Authentication') },
    })
    const ws = new WebSocket(refusing.url)
    ws.on('error', () => { })
    await opened(ws)
    const gone = closed(ws)
    ws.send(request(refusing.token))
    await gone
    assert.equal(asked, 1)
    assert.equal(Buffer.concat(refusedUpstream.sent).length, 11, 'only the connection request went to the server')
    assert.match(refusing.failure ?? '', /Network Level Authentication/)
    refusing.close()

    // Allowed: TLS follows.
    const allowedUpstream = answeringUpstream(confirm(1))
    const allowing = await startRDCleanPathProxy(allowedUpstream.open, () => { }, () => { }, { withoutNla: () => { asked++ } })
    const ws2 = new WebSocket(allowing.url)
    ws2.on('error', () => { })
    await opened(ws2)
    ws2.send(request(allowing.token))
    for (let i = 0; i < 40 && allowedUpstream.sent.length < 2; i++) {
        await soon(25)
    }
    assert.equal(asked, 2)
    assert.equal(allowedUpstream.sent[1]?.[0], 0x16, 'a TLS handshake follows')
    allowing.close()

    // A server that chose it isn't asked about.
    const nlaUpstream = answeringUpstream(confirm(2))
    const plain = await startRDCleanPathProxy(nlaUpstream.open, () => { }, () => { }, { withoutNla: () => { asked++ } })
    const ws3 = new WebSocket(plain.url)
    ws3.on('error', () => { })
    await opened(ws3)
    ws3.send(request(plain.token))
    for (let i = 0; i < 40 && nlaUpstream.sent.length < 2; i++) {
        await soon(25)
    }
    assert.equal(asked, 2)
    assert.equal(nlaUpstream.sent[1]?.[0], 0x16)
    plain.close()
})

test('a proxy started without a decision about servers without Network Level Authentication refuses them', async t => {
    // No options at all, and options without the decision (a JavaScript caller): the server gets the connection
    // request and nothing else.
    for (const options of [undefined, { autologon: true }]) {
        const upstream = answeringUpstream(confirm(1))
        const proxy = await startRDCleanPathProxy(upstream.open, () => { }, () => { }, options)
        const ws = new WebSocket(proxy.url)
        t.after(() => { ws.terminate(); proxy.close() })
        ws.on('error', () => { })
        await opened(ws)
        const gone = closed(ws)
        ws.send(request(proxy.token))
        // Refused, or on to TLS (a ClientHello follows the request), whichever comes first.
        await Promise.race([gone, (async () => {
            for (let i = 0; i < 80 && upstream.sent.length < 2; i++) {
                await soon(25)
            }
        })()])
        assert.equal(Buffer.concat(upstream.sent).length, 11, 'only the connection request went to the server')
        await gone
        assert.match(proxy.failure ?? '', /Network Level Authentication/)
    }
})

/**
 * An X.224 connection request as IronRDP's web client builds it (a native build of its connector, user
 * alice@corp.example): the user name as a cookie, then SSL|HYBRID|HYBRID_EX.
 */
const IRONRDP_REQUEST = Buffer.from('0300003833e00000000000436f6f6b69653a206d737473686173683d616c69636540636f72702e6578616d706c650d0a010008000b000000', 'hex')

test('the server never sees the user name before the certificate check: not even one the proxy then refuses', async t => {
    const upstream = answeringUpstream(confirm(1))
    const proxy = await startRDCleanPathProxy(upstream.open, () => { }, () => { }, { withoutNla: () => { throw new Error('refused') } })
    const ws = new WebSocket(proxy.url)
    t.after(() => { ws.terminate(); proxy.close() })
    ws.on('error', () => { })
    await opened(ws)
    const gone = closed(ws)
    ws.send(der(0x30, Buffer.concat([
        der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
        der(0xa2, der(0x0c, Buffer.from('server:3389'))),
        der(0xa3, der(0x0c, Buffer.from(proxy.token))),
        der(0xa6, der(0x04, IRONRDP_REQUEST)),
    ])))
    await gone
    const sent = Buffer.concat(upstream.sent)
    assert.doesNotMatch(sent.toString('latin1'), /alice|mstshash/)
    assert.equal(sent.toString('hex'), '030000130ee00000000000010008000b000000')
})

test('a server that closes its side ends the desktop, also where the stream never says "closed"', async t => {
    // A stand-in server (needs the openssl command for its certificate): answers the connection request, does TLS,
    // and then closes.
    let secureContext: tls.SecureContext
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-proxy-'))
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '2', '-subj', '/CN=server.test'], { stdio: 'ignore' })
        secureContext = tls.createSecureContext({ key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) })
    } catch {
        t.skip('no openssl command')
        return
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', () => {
            socket.write(confirm(2))
            const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
            secure.on('error', () => { })
            secure.once('secure', () => setTimeout(() => secure.end(), 100))
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    // The way to it, as an SSH channel behaves once the far end is gone: the end is reported, what is written after
    // it is never confirmed, and nothing says "closed".
    const open = async (): Promise<Duplex> => {
        const socket = net.connect(port, '127.0.0.1')
        let ended = false
        const stream: Duplex = new Duplex({
            read () { },
            write (chunk, _encoding, done) {
                if (!ended) {
                    socket.write(chunk, () => done())
                }
            },
            final () { /* never confirmed */ },
        })
        socket.on('data', d => stream.push(d))
        socket.on('end', () => { ended = true; stream.push(null) })
        socket.on('error', () => { })
        stream.on('close', () => socket.destroy())
        return stream
    }
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(open, () => { }, (m: string) => log.push(m))
    const ws = new WebSocket(proxy.url)
    // Whatever the outcome, nothing stays open to keep the test run from ending.
    t.after(() => { ws.terminate(); proxy.close(); server.close() })
    ws.on('error', () => { })
    await opened(ws)
    const gone = closed(ws)
    ws.send(request(proxy.token))
    const outcome = await Promise.race([gone.then(() => 'closed'), soon(4000).then(() => 'still open')])
    assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
    assert.equal(outcome, 'closed', 'the client hears that the desktop is gone')
})

/** A self-signed certificate with `extensions` (openssl's -addext), its key, and its DER form; null without openssl. */
function selfSigned (...extensions: string[]): { key: Buffer, cert: Buffer, der: Buffer } | null {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-proxy-'))
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '2', '-subj', '/CN=server.test',
            ...extensions.flatMap(e => ['-addext', e])], { stdio: 'ignore' })
        const cert = fs.readFileSync(`${dir}/cert.pem`)
        return { key: fs.readFileSync(`${dir}/key.pem`), cert, der: Buffer.from(cert.toString().replace(/-----[^-]+-----|\s/g, ''), 'base64') }
    } catch {
        return null
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

// Windows' self-signed RDP certificate: key and data encipherment, no signatures.
const encipherOnly = selfSigned('keyUsage=critical,keyEncipherment,dataEncipherment')
const signing = selfSigned('keyUsage=critical,digitalSignature,keyEncipherment')
const unrestricted = selfSigned()

/**
 * The error Electron's TLS library (BoringSSL) raises for a server certificate whose key usage rules the handshake out,
 * as Electron 43 has it: its code, reason, library and function, and its message.
 */
const keyUsageRefusal = () => Object.assign(
    new Error('1305670782464:error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT:../../third_party/boringssl/src/ssl/ssl_cert.cc:397:\n'),
    { code: 'ERR_SSL_KEY_USAGE_BIT_INCORRECT', reason: 'KEY_USAGE_BIT_INCORRECT', library: 'SSL routines', function: 'OPENSSL_internal' })

/**
 * A stand-in RDP server with `certificate`: answers the connection request choosing `selected` (CredSSP unless said
 * otherwise), then does TLS, and says for each connection which TLS it got and what came before it. `broken`:
 * connections (by number, from 1) whose way there fails at TLS's first bytes with an error shaped like the TLS
 * library's refusal, code and all, as an SSH channel or a gateway could fail with one passed on from elsewhere: it
 * reaches the TLS socket on top as it is.
 */
async function tlsServer (certificate: { key: Buffer | string, cert: Buffer | string }, broken: number[] = [], selected = 2) {
    const secureContext = tls.createSecureContext({ key: certificate.key, cert: certificate.cert })
    const handshakes: string[] = []
    const requests: Buffer[] = []
    // The name each client asked for in its handshake (SNI), false for none; and what came after the handshake.
    const names: (string | false)[] = []
    const received: Buffer[] = []
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', d => {
            requests.push(Buffer.from(d))
            socket.write(confirm(selected))
            const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
            secure.on('error', () => { })
            secure.on('data', (d: Buffer) => received.push(d))
            secure.once('secure', () => {
                handshakes.push(`${secure.getProtocol()} ${secure.getCipher().name}`)
                names.push((secure as any).servername)
            })
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    let opened = 0
    const open = () => new Promise<Duplex>(resolve => {
        const failing = broken.includes(++opened)
        const socket = net.connect(port, '127.0.0.1', () => {
            let writes = 0
            const stream: Duplex = new Duplex({
                read () { },
                write (chunk, _encoding, done) {
                    // The first write is the connection request; the second, TLS's first.
                    if (failing && ++writes === 2) {
                        stream.destroy(keyUsageRefusal())
                        return done()
                    }
                    socket.write(chunk, () => done())
                },
                destroy (error, done) { socket.destroy(); done(error) },
            })
            socket.on('data', d => stream.push(d))
            socket.on('end', () => stream.push(null))
            socket.on('error', e => stream.destroy(e))
            resolve(stream)
        })
    })
    return { port, open, handshakes, requests, names, received, opened: () => opened, close: () => server.close() }
}

/** An RDCleanPath request, as `request` makes it, with this X.224 connection request. */
const requestWith = (token: string, x224: Buffer) => der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
    der(0xa2, der(0x0c, Buffer.from('server:3389'))),
    der(0xa3, der(0x0c, Buffer.from(token))),
    der(0xa6, der(0x04, x224)),
]))

/** Connects a client through the proxy, and waits for the relay to be up or the connection to end. */
async function attempt (proxy: any, log: string[], x224?: Buffer): Promise<void> {
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    const gone = closed(ws)
    const relays = () => log.filter(l => /relay up/.test(l)).length
    const before = relays()
    ws.send(x224 ? requestWith(proxy.token, x224) : request(proxy.token))
    for (let i = 0; i < 80 && relays() === before && ws.readyState === WebSocket.OPEN; i++) {
        await soon(25)
    }
    ws.terminate()
    await gone
}

test('a client that leaves while its upstream is still being opened has the factory told: the signal it is given aborts', async t => {
    // The factory is an RD Gateway's sign-in, which takes as long as the gateway likes and is no stream among the
    // proxy's until it is done: what lets it stop is the signal.
    const signals: AbortSignal[] = []
    const opening = new Promise<Duplex>(() => { })
    const proxy = await startRDCleanPathProxy((_destination: string, signal?: AbortSignal) => { signals.push(signal!); return opening }, () => { })
    t.after(() => proxy.close())
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    const gone = closed(ws)
    ws.send(request(proxy.token))
    for (let i = 0; i < 80 && !signals.length; i++) {
        await soon(25)
    }
    assert.equal(signals.length, 1)
    assert.equal(signals[0].aborted, false)
    ws.terminate()
    await gone
    for (let i = 0; i < 80 && !signals[0].aborted; i++) {
        await soon(25)
    }
    assert.equal(signals[0].aborted, true)
})

test('an error of the stream under TLS ends the connection with its words, and nothing is tried again', { skip: !encipherOnly }, async t => {
    // One passed on by the way there (an SSH channel, a gateway) is the way there's, and could come from anywhere,
    // whatever its code says: the connection fails with it, as it is.
    const server = await tlsServer(encipherOnly!, [1])
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m))
    t.after(() => { proxy.close(); server.close() })
    await attempt(proxy, log)
    assert.equal(server.opened(), 1, 'not tried again')
    assert.match(proxy.failure ?? '', /KEY_USAGE_BIT_INCORRECT/)
    assert.ok(!log.some(l => /RSA key exchange/.test(l)), log.join('\n'))
})

test('an error that only says a TLS library\'s words is no reason to try again either', { skip: !signing }, async t => {
    // As a gateway or an SSH host can put them in an error of its own (a sign-in scheme's name, a channel failure).
    const server = await tlsServer(signing!)
    let calls = 0
    const open = () => ++calls === 1 ? Promise.reject(new Error('channel open failed: administratively prohibited: KEY_USAGE_BIT_INCORRECT')) : server.open()
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(open, () => { }, (m: string) => log.push(m))
    t.after(() => { proxy.close(); server.close() })
    await attempt(proxy, log)
    assert.equal(calls, 1, 'not tried again')
    assert.match(proxy.failure ?? '', /administratively prohibited/)
    await attempt(proxy, log)
    assert.ok(!log.some(l => /RSA key exchange/.test(l)), log.join('\n'))
    assert.match(server.handshakes[0], /^TLSv1\.2 ECDHE-/)
})

/**
 * Runs in Electron (ELECTRON_RUN_AS_NODE), as in Tabby: the plugin's side of the proxy, which starts the network helper
 * and carries its streams, with a client sending one request through it to the RDP server at `port`, reached the ways
 * the proxy is given in Tabby: by the helper's own connection (`direct`), through an SSH channel (`ssh`, the plugin's
 * SSHChannelStream over a stand-in for Tabby's channel), or through a stream of the plugin's own (`tunnel`). The last
 * two also come `-broken`: failing at TLS's first bytes with an error shaped like a TLS library's refusal, as one
 * passed on from elsewhere would be. Prints what the proxy logged and why it failed, as JSON.
 */
const ELECTRON_CLIENT = String.raw`
const [dist, port, mode] = process.argv.slice(2)
const net = require('net')
const { Duplex } = require('stream')
const { createRequire } = require('module')
const { startRDCleanPathProxy } = require(dist + '/rdcleanpath.js')
const { SSHChannelStream } = require(dist + '/sshChannelStream.js')
const WebSocket = globalThis.WebSocket ?? createRequire(dist + '/rdcleanpath.js')('ws')
const der = (tag, content) => {
    const n = content.length
    return Buffer.concat([Buffer.from([tag, ...n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]]), content])
}
const request = token => der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
    der(0xa2, der(0x0c, Buffer.from('server:3389'))),
    der(0xa3, der(0x0c, Buffer.from(token))),
    der(0xa6, der(0x04, Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0]))),
]))
const passedOn = () => Object.assign(new Error('passed on: KEY_USAGE_BIT_INCORRECT'), { code: 'ERR_SSL_KEY_USAGE_BIT_INCORRECT', reason: 'KEY_USAGE_BIT_INCORRECT' })
// A stream of the plugin's own over the socket. The first write is the connection request; the second, TLS's first.
const tunnelOver = (socket, broken) => {
    let writes = 0
    const stream = new Duplex({
        read () { },
        write (chunk, _encoding, done) {
            if (broken && ++writes === 2) {
                stream.destroy(passedOn())
                return done()
            }
            socket.write(chunk, () => done())
        },
        destroy (error, done) { socket.destroy(); done(error) },
    })
    socket.on('data', d => stream.push(d))
    socket.on('end', () => stream.push(null))
    return stream
}
// What SSHChannelStream uses of Tabby's SSH channel, carried over the socket. Broken: the channel fails as TLS's first
// bytes go out.
const channelOver = (socket, broken) => {
    const subscribers = { data: [], eof: [], closed: [] }
    const subject = name => ({ subscribe (o) { subscribers[name].push(typeof o === 'function' ? { next: o } : o) } })
    let writes = 0
    socket.on('data', d => subscribers.data.forEach(s => s.next(new Uint8Array(d))))
    socket.on('end', () => subscribers.eof.forEach(s => s.next()))
    socket.on('close', () => subscribers.closed.forEach(s => s.next()))
    return {
        data$: subject('data'), eof$: subject('eof'), closed$: subject('closed'),
        write: data => {
            if (broken && ++writes === 2) {
                subscribers.data.forEach(s => s.error && s.error(passedOn()))
                return Promise.resolve()
            }
            return new Promise(resolve => socket.write(data, () => resolve()))
        },
        eof: async () => { socket.end() },
        close: async () => { socket.destroy() },
    }
}
const open = () => mode === 'direct' ? Promise.resolve({ direct: { host: '127.0.0.1', port: Number(port) } }) : new Promise(resolve => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
        const broken = mode.endsWith('-broken')
        const stream = mode.startsWith('ssh') ? new SSHChannelStream(channelOver(socket, broken)) : tunnelOver(socket, broken)
        socket.on('error', e => stream.destroy(e))
        resolve(stream)
    })
})
;(async () => {
    const log = []
    const proxy = await startRDCleanPathProxy(open, () => { }, m => log.push(m))
    // Electron's own WebSocket, as IronRDP's client in Tabby's window has; Node 22's otherwise.
    const ws = new WebSocket(proxy.url)
    ws.binaryType = 'arraybuffer'
    await new Promise(resolve => { ws.onopen = resolve })
    let closed = false
    ws.onclose = () => { closed = true }
    ws.send(request(proxy.token))
    for (let i = 0; i < 200 && !closed && !log.some(l => /relay up/.test(l)); i++) {
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    ws.close()
    proxy.close()
    process.stdout.write(JSON.stringify({ electron: process.versions.electron, log, failure: proxy.failure }))
    process.exit(0)
})()
`

test('in Electron: the plugin\'s side of the proxy starts the helper and carries a socket, an SSH channel or a gateway-like tunnel; an error passed on by the stream ends the connection', {
    skip: !process.env.TRD_ELECTRON ? 'set TRD_ELECTRON to an Electron binary to run this' : !encipherOnly,
}, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-electron-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const script = path.join(dir, 'client.js')
    fs.writeFileSync(script, ELECTRON_CLIENT)
    const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../dist')
    const run = async (mode: string) => {
        const server = await tlsServer(encipherOnly!)
        try {
            const child = spawn(process.env.TRD_ELECTRON!, [script, dist, String(server.port), mode], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
            let out = ''
            child.stdout.on('data', d => { out += d })
            await new Promise(resolve => child.once('exit', resolve))
            return { ...JSON.parse(out), handshakes: server.handshakes }
        } finally {
            server.close()
        }
    }
    // Windows' own certificate, whichever way the desktop is reached: one modern handshake.
    for (const mode of ['direct', 'ssh', 'tunnel']) {
        const fine = await run(mode)
        assert.ok(fine.electron, 'ran in Electron')
        assert.ok(fine.log.some((l: string) => /relay up/.test(l)), `${mode}: ${fine.log.join('\n')}`)
        assert.match(fine.handshakes[0], /^TLSv1\.3 /, mode)
    }
    for (const mode of ['tunnel-broken', 'ssh-broken']) {
        const broken = await run(mode)
        assert.ok(!broken.log.some((l: string) => /relay up/.test(l)), `${mode}: ${broken.log.join('\n')}`)
        assert.match(broken.failure ?? '', /passed on/, mode)
    }
})

test('a server without NLA is held to the certificate it shows, after the certificate check and before the client hears back', { skip: !unrestricted }, async t => {
    const fingerprint = createHash('sha256').update(unrestricted!.der).digest('hex').toUpperCase().match(/../g)!.join(':')
    // TLS only (1): let through before TLS, then held to its certificate. CredSSP (2, 8, both): neither.
    for (const [selected, plain] of [[1, true], [2, false], [8, false], [0x0a, false]] as const) {
        const server = await tlsServer(unrestricted!, [], selected)
        const calls: string[] = []
        const log: string[] = []
        const proxy = await startRDCleanPathProxy(server.open, (f: string) => { calls.push(`checked ${f}`) }, (m: string) => log.push(m), {
            withoutNla: () => { calls.push('let through') },
            withoutNlaCertificate: (f: string) => { calls.push(`held to ${f}`) },
        })
        t.after(() => { proxy.close(); server.close() })
        await attempt(proxy, log)
        assert.deepEqual(calls, plain ? ['let through', `checked ${fingerprint}`, `held to ${fingerprint}`] : [`checked ${fingerprint}`], `selectedProtocol ${selected}`)
        assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
    }
    // Not held to it: the client gets an error instead of the server's certificate, and nothing it sends goes on.
    const server = await tlsServer(unrestricted!, [], 1)
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m), {
        withoutNla: () => { },
        withoutNlaCertificate: () => { throw new Error('allowed for another certificate') },
    })
    const ws = new WebSocket(proxy.url)
    t.after(() => { ws.terminate(); proxy.close(); server.close() })
    ws.on('error', () => { })
    await opened(ws)
    const answers: Buffer[] = []
    ws.on('message', (d: Buffer) => answers.push(Buffer.from(d)))
    const gone = closed(ws)
    ws.send(request(proxy.token))
    await gone
    assert.match(proxy.failure ?? '', /allowed for another certificate/)
    assert.ok(!log.some(l => /relay up/.test(l)), log.join('\n'))
    // One answer, the RDCleanPath error: no certificate chain (a success response carries one, DER of the server's).
    assert.equal(answers.length, 1)
    assert.equal(answers[0].includes(unrestricted!.der), false)
})

test('the user name reaches no server whose certificate is refused: Windows\' own certificate, checked once', { skip: !encipherOnly }, async t => {
    // Windows' certificate (key and data encipherment only) completes the handshake as it is; the certificate check,
    // refusing it here, comes before anything more goes to the server.
    const server = await tlsServer(encipherOnly!)
    const log: string[] = []
    let checked = 0
    const proxy = await startRDCleanPathProxy(server.open, () => { checked++; throw new Error('not the certificate remembered') }, (m: string) => log.push(m), { withoutNla: () => { } })
    t.after(() => { proxy.close(); server.close() })
    await attempt(proxy, log, IRONRDP_REQUEST)
    assert.equal(checked, 1)
    assert.match(proxy.failure ?? '', /not the certificate remembered/)
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0].toString('hex'), '030000130ee00000000000010008000b000000')
    assert.equal(Buffer.concat(server.received).length, 0, 'nothing after the handshake reached the server')
})

test('Windows\' own certificate (no signatures in its key usage) gets TLS 1.2 ECDHE over a socket or a stream', { skip: !encipherOnly }, async t => {
    // Electron's TLS library refused such a certificate in any handshake that needs a signature, and the plugin fell
    // back to TLS 1.2 with RSA key exchange for it. The helper accepts it with forward-secret ECDHE.
    const server = await tlsServer(encipherOnly!)
    t.after(() => server.close())
    for (const route of ['stream', 'direct'] as const) {
        const log: string[] = []
        const proxy = await startRDCleanPathProxy(route === 'stream' ? server.open : async () => ({ direct: { host: '127.0.0.1', port: server.port } }),
            () => { }, (m: string) => log.push(m), { withoutNla: () => { } })
        try {
            const before = server.opened()
            await attempt(proxy, log)
            assert.ok(log.some(l => /relay up/.test(l)), `${route}: ${log.join('\n')}`)
            assert.ok(!log.some(l => /RSA key exchange/.test(l)), log.join('\n'))
            assert.match(server.handshakes[server.handshakes.length - 1], /^TLSv1\.2 ECDHE-/, route)
            assert.ok(log.some(l => /^TLS: negotiated TLS 1\.2 TLS_ECDHE_/.test(l)), `${route}: ${log.join('\n')}`)
            if (route === 'stream') {
                assert.equal(server.opened() - before, 1, 'one connection')
            }
        } finally {
            proxy.close()
        }
    }
})

test('the network helper delivers X.224 and relay bytes to the optional PDU trace', { skip: !encipherOnly }, async t => {
    const server = await tlsServer(encipherOnly!)
    const seen: { direction: 'in' | 'out', data: Buffer, kind?: 'x224' }[] = []
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m), {
        withoutNla: () => { },
        tap: (direction: 'in' | 'out', data: Buffer, kind?: 'x224') => seen.push({ direction, data: Buffer.from(data), kind }),
    })
    t.after(() => { proxy.close(); server.close() })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    ws.send(request(proxy.token))
    for (let i = 0; i < 80 && !log.some(l => /relay up/.test(l)); i++) await soon(25)
    assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
    const data = Buffer.from([3, 0, 0, 6, 9, 9])
    ws.send(data)
    for (let i = 0; i < 80 && !server.received.some(chunk => chunk.equals(data)); i++) await soon(25)
    assert.ok(server.received.some(chunk => chunk.equals(data)))
    assert.ok(seen.some(item => item.direction === 'out' && item.kind === 'x224'))
    assert.ok(seen.some(item => item.direction === 'in' && item.kind === 'x224'))
    assert.ok(seen.some(item => item.direction === 'out' && item.kind === undefined && item.data.equals(data)))
    const gone = closed(ws)
    ws.terminate()
    await gone
})

test('a connection request that still names the user once the cookie is taken out goes nowhere', async t => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { }, () => { }, { withoutNla: () => { } })
    t.after(() => proxy.close())
    // IronRDP's request with a TPKT length that doesn't add up: the cookie can't be taken out of it (the helper's own
    // tests check that it is left as it is).
    const odd = Buffer.from(IRONRDP_REQUEST)
    odd.writeUInt16BE(odd.length + 1, 2)
    const ws = new WebSocket(proxy.url)
    t.after(() => ws.terminate())
    ws.on('error', () => { })
    await opened(ws)
    const gone = closed(ws)
    ws.send(requestWith(proxy.token, odd))
    // Refused at once; a proxy that sent it would still be waiting for the server's answer.
    await Promise.race([gone, soon(2000)])
    assert.equal(upstream.streams.length, 0, 'no server was even reached')
    assert.match(proxy.failure ?? '', /user name/)
})

test('HYBRID|HYBRID_EX: CredSSP, the early user authorization result and RDP each reach the client whole, through the relay', { skip: !unrestricted }, async t => {
    // A server choosing 0x0A that sends, in one piece after TLS, a CredSSP message, the four-byte Early User
    // Authorization Result and an RDP PDU (TPKT).
    const secureContext = tls.createSecureContext({ key: unrestricted!.key, cert: unrestricted!.cert })
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', () => {
            socket.write(confirm(0x0a))
            const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
            secure.on('error', () => { })
            secure.once('secure', () => secure.write(Buffer.concat([
                Buffer.from([0x30, 3, 2, 1, 6]), Buffer.from([0, 0, 0, 0]), Buffer.from([3, 0, 0, 7, 2, 0xf0, 0x80]),
            ])))
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const open = () => new Promise<Duplex>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
        socket.once('error', reject)
    })
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(open, () => { }, (m: string) => log.push(m), { withoutNla: () => { } })
    const ws = new WebSocket(proxy.url)
    t.after(() => { ws.terminate(); proxy.close(); server.close() })
    ws.on('error', () => { })
    await opened(ws)
    const messages: string[] = []
    ws.on('message', (d: Buffer) => messages.push(Buffer.from(d).toString('hex')))
    let gone = false
    ws.once('close', () => { gone = true })
    // The client asks for SSL, HYBRID and HYBRID_EX, as IronRDP does.
    ws.send(requestWith(proxy.token, Buffer.from([3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 0x0b, 0, 0, 0])))
    for (let i = 0; i < 80 && messages.length < 4 && !gone; i++) {
        await soon(25)
    }
    await soon(100)
    // After the RDCleanPath response: one message each.
    assert.deepEqual(messages.slice(1), ['3003020106', '00000000', '0300000702f080'], log.join('\n'))
    assert.equal(gone, false, 'the relay stays up')
})

// The name a desktop connected to directly goes by: its certificate is checked against it and the certificate
// authorities, and the check hears whether it is valid and why not, before the client hears back. A test authority
// stands in for this computer's (the `ca` the proxy is given in its TLS options).
const testAuthority = authority()
const forServer = testAuthority?.issue(['server.test', '127.0.0.1'])
const encipheringOnly = testAuthority?.issue(['server.test'], { keyUsage: 'critical,keyEncipherment,dataEncipherment' })
const expiredOne = testAuthority?.issue(['server.test'], { expired: true })

/**
 * Connects once through a proxy with `options` to `server` (see tlsServer): what its certificate check heard (valid,
 * reason) each time it ran, the server's last SNI, and the log.
 */
async function heard (server: Awaited<ReturnType<typeof tlsServer>>, options: Record<string, unknown>) {
    const calls: [boolean, string][] = []
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, (_fingerprint: string, valid: boolean, reason: string) => { calls.push([valid, reason]) },
        (m: string) => log.push(m), { withoutNla: () => { }, ...options })
    try {
        await attempt(proxy, log)
    } finally {
        proxy.close()
    }
    return { calls, sni: server.names[server.names.length - 1], log }
}

test('the certificate check hears whether the certificate is valid for the name, and why not', { skip: !forServer || !testAuthority }, async t => {
    const server = await tlsServer(forServer!)
    t.after(() => server.close())
    const ca = { tls: { ca: testAuthority!.ca } }
    // Valid for its name: the name goes as SNI.
    assert.deepEqual(await heard(server, { serverName: 'server.test', ...ca }).then(h => [h.calls, h.sni]), [[[true, '']], 'server.test'])
    // An address: matched to the certificate's addresses, and no SNI (which takes names only).
    assert.deepEqual(await heard(server, { serverName: '127.0.0.1', ...ca }).then(h => [h.calls, h.sni]), [[[true, '']], false])
    // Another name, or another address.
    assert.deepEqual((await heard(server, { serverName: 'other.test', ...ca })).calls, [[false, 'ERR_TLS_CERT_ALTNAME_INVALID']])
    assert.deepEqual((await heard(server, { serverName: '127.0.0.2', ...ca })).calls, [[false, 'ERR_TLS_CERT_ALTNAME_INVALID']])
    // An authority this computer doesn't have.
    assert.deepEqual((await heard(server, { serverName: 'server.test' })).calls, [[false, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']])
    // No name (a desktop behind an SSH host): nothing checked, never valid, no SNI, as before.
    assert.deepEqual(await heard(server, ca).then(h => [h.calls, h.sni]), [[[false, '']], false])
})

test('the certificate check hears what the certificate says of itself: whom it was issued to and by, and its dates', { skip: !forServer || !testAuthority }, async t => {
    const { describeCertificate } = require('../../dist/authorities.js')
    const server = await tlsServer(forServer!)
    t.after(() => server.close())
    const details: any[] = []
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, (_fingerprint: string, _valid: boolean, _reason: string, about: unknown) => { details.push(about) },
        (m: string) => log.push(m), { withoutNla: () => { }, serverName: 'server.test', tls: { ca: testAuthority!.ca } })
    try {
        await attempt(proxy, log)
    } finally {
        proxy.close()
    }
    assert.equal(details.length, 1)
    const [{ subject, names, issuer, validFrom, validTo }] = details
    assert.deepEqual([subject, names, issuer], ['server.test', ['server.test', '127.0.0.1'], 'tabby-rdp test authority'])
    assert.ok(Date.parse(validFrom) <= Date.now() && Date.now() < Date.parse(validTo), `${validFrom} to ${validTo}`)
    assert.match(describeCertificate(details[0]),
        /^Issued to server\.test \(server\.test, 127\.0\.0\.1\) by tabby-rdp test authority, valid \d{4}-\d\d-\d\d \d\d:\d\d UTC to \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/)
})

// A certificate marked for the Remote Desktop use only (an organisation's Remote Desktop template makes them so), from
// the tests' authority, and the same from an authority anyone could make, which the server sends along.
const RDP_ONLY = '1.3.6.1.4.1.311.54.1.2'
const forRemoteDesktop = testAuthority?.issue(['server.test'], { extendedKeyUsage: RDP_ONLY })
const madeUp = authority('Corp Issuing CA 02')
const madeUpLeaf = madeUp?.issue(['server.test'], { extendedKeyUsage: RDP_ONLY })

/**
 * What the certificate check heard for a server with `certificate` (and the chain it sends), checked as `name` against
 * `ca` (the tests' authority unless said otherwise), and the question's words for it: why it isn't valid (whyNotValid,
 * from what the check heard) and what it says of itself (describeCertificate, marked as its own word unless vouched for).
 */
async function checked (certificate: { key: Buffer, cert: Buffer }, options: { name?: string, ca?: Buffer } = {}) {
    const { whyNotValid, describeCertificate, vouched } = require('../../dist/authorities.js')
    const name = options.name ?? 'server.test'
    const server = await tlsServer(certificate)
    const heard: [boolean, string, any][] = []
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, (_fingerprint: string, valid: boolean, reason: string, details: any) => { heard.push([valid, reason, details]) },
        (m: string) => log.push(m), { withoutNla: () => { }, serverName: name, tls: { ca: options.ca ?? testAuthority!.ca } })
    try {
        await attempt(proxy, log)
    } finally {
        proxy.close()
        server.close()
    }
    assert.equal(heard.length, 1, log.join('\n'))
    const [valid, reason, details] = heard[0]
    return {
        valid, reason, chain: details?.chain, forName: details?.forName,
        why: valid ? '' : whyNotValid(reason, name, details), about: details ? describeCertificate(details, !vouched(valid, details)) : '',
    }
}

test('the certificate check hears where the certificate\'s chain stands, which the reason it isn\'t valid can hide', { skip: !forRemoteDesktop || !madeUpLeaf || !forServer }, async () => {
    // A made-up authority sent along with its certificate: the TLS library names the key usage, not the authority.
    const made = await checked({ key: madeUpLeaf!.key, cert: Buffer.concat([madeUpLeaf!.cert, madeUp!.ca]) })
    assert.deepEqual([made.valid, made.reason, made.chain], [false, 'INVALID_PURPOSE', 'unknown authority'])
    assert.match(made.why, /^it isn't from a certificate authority this computer trusts, and it is marked for other uses than a server's \(its extended key usage\)$/)
    assert.match(made.about, /^It says it was issued to server\.test \(server\.test\) by Corp Issuing CA 02, valid [^\n]* UTC: its own word, which nothing here has checked/)
    // The same certificate without its authority's: an issuer named, nothing to check it with.
    assert.match((await checked(madeUpLeaf!)).why, /^no certificate authority this computer trusts vouches for it from what the server sent \(/)
    // The trusted authority's certificate for the Remote Desktop use: an organisation's kind, said so, and what it says
    // of itself is that authority's word.
    const organisation = await checked(forRemoteDesktop!)
    assert.deepEqual([organisation.valid, organisation.reason, organisation.chain, organisation.forName], [false, 'INVALID_PURPOSE', 'authority', true])
    assert.equal(organisation.why, 'it is marked for other uses than a server\'s (its extended key usage), as some organisations\' Remote Desktop certificates are')
    assert.match(organisation.about, /^Issued to server\.test \(server\.test\) by tabby-rdp test authority, valid /)
    // Expired, from the trusted authority, for its name.
    if (expiredOne) {
        const expired = await checked(expiredOne)
        assert.deepEqual([expired.reason, expired.chain, expired.why], ['CERT_HAS_EXPIRED', 'authority', 'it has expired'])
    }
    // A valid one: nothing to say.
    const valid = await checked(forServer!)
    assert.deepEqual([valid.valid, valid.chain], [true, undefined])
})

test('a self-signed certificate is called so whatever its key usage: Windows\' own, and a gateway\'s', { skip: !encipherOnly || !signing || !unrestricted || !testAuthority }, async () => {
    // Windows' own (key and data encipherment, which OpenSSL doesn't take for one that signed itself); a self-signed
    // gateway's (digital signature and key encipherment); and openssl's own kind.
    for (const certificate of [encipherOnly!, signing!, unrestricted!]) {
        const self = await checked(certificate)
        assert.deepEqual([self.valid, self.chain, self.forName], [false, 'self-signed', true])
        assert.equal(self.why, 'it is self-signed (made by the server itself, as RDP servers make theirs unless given one), so no certificate authority vouches for it')
        assert.match(self.about, /: its own word, which nothing here has checked/)
    }
    // Checked as an address it isn't for: said too, after where it stands.
    const byAddress = await checked(encipherOnly!, { name: '127.0.0.1' })
    assert.match(byAddress.why, /^it is self-signed \([^)]*\), so no certificate authority vouches for it, and it was issued for another name than 127\.0\.0\.1$/)
})

// Certificates signed with the key of one the tests' authority issued for a server (without basic constraints, as some
// tools leave them; and with ones that say it is no authority): no authority vouches for them, whatever they are
// marked for.
const someServer = testAuthority?.issue(['evil.example'])
const endEntity = someServer && signedWith(someServer)
const notAnAuthority = testAuthority?.issue(['evil.example'], { constraints: 'critical,CA:FALSE' })
const notAuthority = notAnAuthority && signedWith(notAnAuthority)

test('a certificate signed with the key of one an authority issued for a server leads to no authority', { skip: !endEntity || !notAuthority }, async () => {
    for (const [issuer, its] of [[endEntity!, someServer!], [notAuthority!, notAnAuthority!]] as const) {
        const sent = (leaf: { key: Buffer, cert: Buffer } | null) => leaf && { key: leaf.key, cert: Buffer.concat([leaf.cert, its.cert]) }
        // Marked for the Remote Desktop use only: no word of organisations.
        const remote = await checked(sent(issuer.issue(['server.test'], { extendedKeyUsage: RDP_ONLY }))!)
        assert.deepEqual([remote.valid, remote.reason, remote.chain], [false, 'INVALID_PURPOSE', 'incomplete'])
        assert.match(remote.why, /^no certificate authority this computer trusts vouches for it from what the server sent \([^)]*\), and it is marked for other uses than a server's \(its extended key usage\)$/)
        assert.match(remote.about, /: its own word, which nothing here has checked/)
        // For any use: nothing about uses.
        const any = await checked(sent(issuer.issue(['server.test']))!)
        assert.deepEqual([any.reason, any.chain], ['INVALID_PURPOSE', 'incomplete'])
        assert.match(any.why, /^no certificate authority this computer trusts vouches for it from what the server sent \([^)]*\)$/)
        // Expired as well: both said, not the dates alone.
        const old = sent(issuer.issue(['server.test'], { expired: true }))
        if (old) {
            const expired = await checked(old)
            assert.deepEqual([expired.reason, expired.chain], ['CERT_HAS_EXPIRED', 'incomplete'])
            assert.match(expired.why, /^no certificate authority this computer trusts vouches for it from what the server sent \([^)]*\), and it has expired$/)
        }
    }
})

// An authority whose root a server sends along cross-signed by another one, which this computer doesn't trust: the
// chain still leads to the root it trusts, which the cross-signed copy is by its name and key.
const rootAuthority = authority('tabby-rdp test root')
const issuing = rootAuthority?.below('tabby-rdp issuing')
const oldRoot = authority('tabby-rdp old root')
const crossSigned = oldRoot && rootAuthority?.signedBy(oldRoot)
const underRoot = issuing?.issue(['server.test'])
const clientIssuing = rootAuthority?.below('tabby-rdp client issuing', { extendedKeyUsage: 'clientAuth' })
const underClientIssuing = clientIssuing?.issue(['server.test'], { extendedKeyUsage: 'serverAuth' })

test('a chain sent with its root cross-signed by another authority leads to the root this computer trusts', { skip: !issuing || !crossSigned || !underRoot }, async () => {
    const sent = (leaf: { key: Buffer, cert: Buffer }) => ({ key: leaf.key, cert: Buffer.concat([leaf.cert, issuing!.ca, crossSigned!]) })
    const ca = rootAuthority!.ca
    assert.equal((await checked(sent(underRoot!), { ca })).valid, true)
    // Another name: that is what is said, and what it says of itself is the authority's word.
    const other = await checked(sent(underRoot!), { name: 'other.test', ca })
    assert.deepEqual([other.valid, other.reason, other.chain, other.forName], [false, 'ERR_TLS_CERT_ALTNAME_INVALID', 'authority', false])
    assert.equal(other.why, 'it was issued for another name than other.test')
    assert.match(other.about, /^Issued to server\.test \(server\.test\) by tabby-rdp issuing, valid /)
    const old = issuing!.issue(['server.test'], { expired: true })
    if (old) {
        const expired = await checked(sent(old), { name: 'other.test', ca })
        assert.deepEqual([expired.reason, expired.chain, expired.why], ['CERT_HAS_EXPIRED', 'authority', 'it was issued for another name than other.test, and it has expired'])
    }
})

test('another machine\'s certificate from the authority this computer trusts, presented for this one: its name is the reason', { skip: !testAuthority }, async () => {
    // A machine's Remote Desktop certificate, as an organisation's template issues them, from the trusted authority.
    const remote = await checked(testAuthority!.issue(['attacker-box.test'], { extendedKeyUsage: RDP_ONLY })!)
    assert.deepEqual([remote.valid, remote.reason, remote.chain, remote.forName], [false, 'INVALID_PURPOSE', 'authority', false])
    assert.equal(remote.why, 'it was issued for another name than server.test, and it is marked for other uses than a server\'s (its extended key usage)')
    // What it says of itself is the authority's word, and names the machine it is.
    assert.match(remote.about, /^Issued to attacker-box\.test \(attacker-box\.test\) by tabby-rdp test authority, valid /)
    const old = testAuthority!.issue(['attacker-box.test'], { expired: true })
    if (old) {
        const expired = await checked(old)
        assert.deepEqual([expired.reason, expired.chain, expired.why], ['CERT_HAS_EXPIRED', 'authority', 'it was issued for another name than server.test, and it has expired'])
    }
})

test('a chain that leads to an authority through one marked for other uses than a server\'s: no word of organisations', { skip: !underClientIssuing }, async () => {
    const through = await checked({ key: underClientIssuing!.key, cert: Buffer.concat([underClientIssuing!.cert, clientIssuing!.ca]) }, { ca: rootAuthority!.ca })
    assert.deepEqual([through.valid, through.reason, through.chain, through.forName], [false, 'INVALID_PURPOSE', 'authority', true])
    assert.equal(through.why, 'a certificate in its chain isn\'t one that may vouch for it')
})

// Chains that lead to the authority the tests trust, for which the TLS library has a reason of its own to refuse them:
// a limit on the length of the path below an authority, and on the names an authority may sign for. The plugin's own
// reading of a chain checks signatures and who may issue certificates, not those.
const limited = rootAuthority?.below('tabby-rdp limited', { constraints: 'critical,CA:TRUE,pathlen:0' })
const belowLimit = limited?.below('tabby-rdp below the limit')
const pastLimit = belowLimit?.issue(['server.test'])
const restricted = rootAuthority?.below('tabby-rdp restricted', { nameConstraints: 'critical,permitted;DNS:other.test' })
const outsideNames = restricted?.issue(['server.test'])

test('a chain the TLS library refuses for a limit the authority set leads to the authority, and what it says of itself isn\'t that authority\'s word', { skip: !pastLimit || !outsideNames }, async () => {
    const ca = rootAuthority!.ca
    const long = await checked({ key: pastLimit!.key, cert: Buffer.concat([pastLimit!.cert, belowLimit!.ca, limited!.ca]) }, { ca })
    assert.deepEqual([long.valid, long.reason, long.chain], [false, 'PATH_LENGTH_EXCEEDED', 'authority'])
    assert.equal(long.why, 'it couldn\'t be verified (PATH_LENGTH_EXCEEDED)')
    assert.match(long.about, /^It says it was issued to server\.test \(server\.test\) by tabby-rdp below the limit, valid [^\n]* UTC: its own word, which nothing here has checked/)
    // Names the authority doesn't allow: the code is the library's own (UNSPECIFIED, with OpenSSL 3), not one the
    // plugin reads.
    const named = await checked({ key: outsideNames!.key, cert: Buffer.concat([outsideNames!.cert, restricted!.ca]) }, { ca })
    assert.deepEqual([named.valid, named.chain], [false, 'authority'])
    assert.ok(named.reason && !/^(ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|INVALID_PURPOSE)$/.test(named.reason), named.reason)
    assert.equal(named.why, `it couldn't be verified (${named.reason})`)
    assert.match(named.about, /: its own word, which nothing here has checked/)
    // The codes the plugin's reading accounts for leave it the authority's word, as before (see the tests above).
    const another = await checked(testAuthority!.issue(['attacker-box.test'], { extendedKeyUsage: RDP_ONLY })!)
    assert.deepEqual([another.reason, another.chain], ['INVALID_PURPOSE', 'authority'])
    assert.doesNotMatch(another.about, /nothing here has checked/)
})

test('a chain to an authority is marked unchecked for any reason of the TLS library\'s that the plugin\'s reading doesn\'t account for', { skip: !forServer || !testAuthority }, async t => {
    const { certificateDetails, vouched } = require('../../dist/authorities.js')
    const server = tls.createServer({ key: forServer!.key, cert: forServer!.cert }, socket => socket.on('error', () => { }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const socket = tls.connect({ socket: net.connect((server.address() as net.AddressInfo).port, '127.0.0.1'), host: 'server.test', servername: 'server.test',
        rejectUnauthorized: false, ca: testAuthority!.ca })
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject) })
    t.after(() => socket.destroy())
    const peer = socket.getPeerCertificate(true)
    const details = (reason: string, authorities: Buffer[] = [testAuthority!.ca]) => certificateDetails(peer, { name: 'server.test', authorities, reason })
    // The codes the plugin's reading accounts for (its chain, name, dates and uses, as whyNotValid puts them).
    for (const reason of ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'INVALID_PURPOSE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
        const read = details(reason)
        assert.equal(read.chain, 'authority', reason)
        assert.equal(read.unchecked, undefined, reason)
        assert.equal(vouched(false, read), true, reason)
    }
    // Any other, or none: the library refused it for something of its own, and the authority's word isn't all of it.
    for (const reason of ['PATH_LENGTH_EXCEEDED', 'UNSPECIFIED', 'CERT_REVOKED', 'CA_KEY_TOO_SMALL', 'HOSTNAME_MISMATCH', '']) {
        const read = details(reason)
        assert.equal(read.chain, 'authority', reason)
        assert.equal(read.unchecked, true, reason)
        assert.equal(vouched(false, read), false, reason)
        // Valid, an authority vouched for it: its word all the same.
        assert.equal(vouched(true, read), true, reason)
    }
    // Where the chain doesn't lead to an authority, nothing was the authority's word to begin with.
    const none = details('PATH_LENGTH_EXCEEDED', [])
    assert.deepEqual([none.chain, none.unchecked, vouched(false, none)], ['unknown authority', undefined, false])
})

test('a name Node found wrong is on a chain the TLS library took to an authority, whatever the plugin\'s own reading of it', { skip: !forServer || !testAuthority }, async t => {
    const { certificateDetails } = require('../../dist/authorities.js')
    const server = tls.createServer({ key: forServer!.key, cert: forServer!.cert }, socket => socket.on('error', () => { }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const socket = tls.connect({ socket: net.connect((server.address() as net.AddressInfo).port, '127.0.0.1'), host: 'other.test', servername: 'other.test',
        rejectUnauthorized: false, ca: testAuthority!.ca })
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject) })
    t.after(() => socket.destroy())
    assert.equal(String(socket.authorizationError), 'ERR_TLS_CERT_ALTNAME_INVALID')
    const peer = socket.getPeerCertificate(true)
    // Read against a list that hasn't the authority the TLS library had (as without the system's store, say): no
    // authority by the plugin's reading, but Node checks the name only once the library took the chain to one.
    assert.equal(certificateDetails(peer, { name: 'other.test', authorities: [] }).chain, 'unknown authority')
    assert.deepEqual(certificateDetails(peer, { name: 'other.test', authorities: [], reason: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
        { ...certificateDetails(peer), chain: 'authority', forName: false })
})

/**
 * A script for Electron run as Node (ELECTRON_RUN_AS_NODE): the built plugin's proxy (`dist`), checking the server's
 * certificate as `name` against the authority in `ca` (a file), and a client sending one request through it to the
 * RDP server at `port`. Prints what the check heard, why the question would say it isn't valid, and what the proxy
 * logged, as JSON.
 */
const ELECTRON_CHECK = String.raw`
const [dist, port, name, ca] = process.argv.slice(2)
const fs = require('fs')
const net = require('net')
const { createRequire } = require('module')
const { startRDCleanPathProxy } = require(dist + '/rdcleanpath.js')
const { whyNotValid } = require(dist + '/authorities.js')
const WebSocket = createRequire(dist + '/rdcleanpath.js')('ws')
const der = (tag, content) => {
    const n = content.length
    return Buffer.concat([Buffer.from([tag, ...n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]]), content])
}
const request = token => der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
    der(0xa2, der(0x0c, Buffer.from('server:3389'))),
    der(0xa3, der(0x0c, Buffer.from(token))),
    der(0xa6, der(0x04, Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0]))),
]))
const open = () => new Promise(resolve => { const socket = net.connect(Number(port), '127.0.0.1', () => resolve(socket)) })
;(async () => {
    const log = []
    const heard = []
    const check = (_fingerprint, valid, reason, details) => { heard.push({ valid, reason, chain: details && details.chain, forName: details && details.forName, why: valid ? '' : whyNotValid(reason, name, details) }) }
    const proxy = await startRDCleanPathProxy(open, check, m => log.push(m), { withoutNla: () => { }, serverName: name, tls: { ca: fs.readFileSync(ca) } })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await new Promise(resolve => ws.once('open', resolve))
    ws.send(request(proxy.token))
    for (let i = 0; i < 200 && ws.readyState === WebSocket.OPEN && !heard.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    process.stdout.write(JSON.stringify({ electron: process.versions.electron, log, heard }))
    process.exit(0)
})()
`

test('in Electron: where a certificate\'s chain stands, and whether it is for the name, as the plugin reads them there (BoringSSL)', {
    skip: !process.env.TRD_ELECTRON ? 'set TRD_ELECTRON to an Electron binary to run this' : !encipherOnly || !endEntity || !crossSigned || !testAuthority,
}, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-electron-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const script = path.join(dir, 'check.js')
    fs.writeFileSync(script, ELECTRON_CHECK)
    const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../dist')
    const run = async (certificate: { key: Buffer, cert: Buffer }, name: string, authority: Buffer) => {
        const ca = path.join(dir, `ca-${Math.random().toString(36).slice(2)}.pem`)
        fs.writeFileSync(ca, authority)
        const server = await tlsServer(certificate)
        try {
            const child = spawn(process.env.TRD_ELECTRON!, [script, dist, String(server.port), name, ca], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
            let out = ''
            child.stdout.on('data', d => { out += d })
            await new Promise(resolve => child.once('exit', resolve))
            const result = JSON.parse(out)
            assert.ok(result.electron, 'ran in Electron')
            assert.equal(result.heard.length, 1, result.log.join('\n'))
            return { ...result.heard[0], log: result.log as string[] }
        } finally {
            server.close()
        }
    }
    // Windows' own: self-signed, though OpenSSL doesn't take it for its own issuer (its key usage).
    const windows = await run(encipherOnly!, 'server.test', testAuthority!.ca)
    assert.deepEqual([windows.valid, windows.chain, windows.forName], [false, 'self-signed', true])
    assert.match(windows.why, /^it is self-signed \(/)
    // Signed with the key of a server's certificate from the trusted authority: no authority, no word of organisations.
    const leaf = endEntity!.issue(['server.test'], { extendedKeyUsage: RDP_ONLY })!
    const forged = await run({ key: leaf.key, cert: Buffer.concat([leaf.cert, someServer!.cert]) }, 'server.test', testAuthority!.ca)
    assert.deepEqual([forged.reason, forged.chain], ['INVALID_PURPOSE', 'incomplete'])
    assert.doesNotMatch(forged.why, /organisations/)
    // The root sent cross-signed by another authority, as another name: the name.
    const cross = await run({ key: underRoot!.key, cert: Buffer.concat([underRoot!.cert, issuing!.ca, crossSigned!]) }, 'other.test', rootAuthority!.ca)
    assert.deepEqual([cross.reason, cross.chain, cross.why], ['ERR_TLS_CERT_ALTNAME_INVALID', 'authority', 'it was issued for another name than other.test'])
    // Another machine's Remote Desktop certificate from the trusted authority: its name, no word of organisations.
    const other = await run(testAuthority!.issue(['attacker-box.test'], { extendedKeyUsage: RDP_ONLY })!, 'server.test', testAuthority!.ca)
    assert.deepEqual([other.reason, other.chain, other.forName], ['INVALID_PURPOSE', 'authority', false])
    assert.equal(other.why, 'it was issued for another name than server.test, and it is marked for other uses than a server\'s (its extended key usage)')
})

test('the room for answers: taken, made again by what the proxy reads from the connection and the server takes, all of it again when that ends', { skip: !forServer }, async t => {
    // A stand-in RDP server that, past TLS, reads nothing until told to.
    const secureContext = tls.createSecureContext({ key: forServer!.key, cert: forServer!.cert })
    let reading = () => { }
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', () => {
            socket.write(confirm(2))
            const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
            secure.on('error', () => { })
            reading = () => secure.on('data', () => { })
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(() => new Promise<Duplex>(resolve => {
        const socket: net.Socket = net.connect(port, '127.0.0.1', () => resolve(socket))
    }), () => { }, (m: string) => log.push(m), { withoutNla: () => { } })
    t.after(() => { proxy.close(); server.close() })
    const MB = 1024 * 1024
    let made = false
    const madeAgain = () => {
        made = false
        return proxy.whenRoom().then(() => { made = true })
    }
    // Waits for `room` to be made, ten seconds at most.
    const within = async (room: Promise<void>, what: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([room, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no room: ${what}`)), 10000) })])
        } finally {
            clearTimeout(timer)
        }
    }
    assert.equal(proxy.room(), true)
    await proxy.whenRoom()
    const connect = async () => {
        const ws = new WebSocket(proxy.url)
        ws.on('error', () => { })
        await opened(ws)
        log.length = 0
        ws.send(request(proxy.token))
        for (let i = 0; i < 80 && !log.some(l => /relay up/.test(l)); i++) {
            await soon(25)
        }
        assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
        return ws
    }
    const ws = await connect()
    // Answers take it all: none is left, and none is made by waiting.
    proxy.spend(FLOW_WINDOW)
    assert.equal(proxy.room(), false)
    let room = madeAgain()
    await soon(100)
    assert.equal(made, false)
    // What an answer didn't use is given back.
    proxy.refund(MB)
    await within(room, 'given back')
    proxy.spend(MB)
    assert.equal(proxy.room(), false)
    // The proxy reads a megabyte from the connection: it no longer waits there, but what of it the system's own buffers
    // didn't take waits in the proxy for the server, and takes room there.
    const sent = proxy.stats.bytesOut
    ws.send(Buffer.alloc(MB))
    for (let i = 0; i < 100 && proxy.stats.bytesOut - sent < MB; i++) {
        await soon(10)
    }
    assert.equal(proxy.stats.bytesOut - sent, MB)
    assert.equal(proxy.room(), proxy.backlog < MB)
    // The server reads nothing: the proxy still reads all the connection has, so that nothing waits in the client's
    // own queue, where nothing counts it; what it read waits for the server, and takes room.
    proxy.refund(FLOW_WINDOW)
    const before = proxy.stats.bytesOut
    for (let i = 0; i < 48; i++) {
        ws.send(Buffer.alloc(MB))
    }
    for (let i = 0; i < 100 && proxy.stats.bytesOut - before < 48 * MB; i++) {
        await soon(50)
    }
    assert.equal(proxy.stats.bytesOut - before, 48 * MB)
    assert.equal(ws.bufferedAmount, 0)
    // What the system's own buffers took of it aside, it waits in the proxy. How much they take is the host's to say (some
    // megabytes over a loopback as a rule; a host tuned for fast links may have them take far more), so more goes, a
    // megabyte at a time, until a clear part waits, and no more than the room, which what waits is spent against below.
    const settled = async () => {
        let waiting = -1
        for (let i = 0; i < 100 && waiting !== proxy.backlog; i++) {
            waiting = proxy.backlog
            await soon(50)
        }
        return waiting
    }
    let total = 48 * MB
    let waiting = await settled()
    for (; waiting <= 16 * MB && total < FLOW_WINDOW; total += MB) {
        ws.send(Buffer.alloc(MB))
        waiting = await settled()
    }
    assert.ok(waiting > 16 * MB, `${waiting / MB} MB waits for the server, of ${total / MB} MB sent`)
    for (let i = 0; i < 100 && proxy.stats.bytesOut - before < total; i++) {
        await soon(50)
    }
    assert.equal(proxy.stats.bytesOut - before, total)
    assert.equal(ws.bufferedAmount, 0)
    // It counts against the room, byte for byte.
    assert.equal(proxy.room(), true)
    proxy.spend(FLOW_WINDOW - waiting - 1)
    assert.equal(proxy.room(), true)
    proxy.spend(1)
    assert.equal(proxy.room(), false)
    room = madeAgain()
    await soon(200)
    assert.equal(made, false)
    // The server reads again: what waited for it goes, and there is room.
    reading()
    await within(room, 'the server reading again')
    assert.equal(proxy.room(), true)
    proxy.refund(FLOW_WINDOW)
    // A connection that ends takes what was handed to it along: the next starts with all the room.
    proxy.spend(2 * FLOW_WINDOW)
    room = madeAgain()
    ws.terminate()
    await within(room, 'the connection ended')
    const next = await connect()
    assert.equal(proxy.room(), true)
    // Closed, the proxy has room for good: what waits for it goes on, and finds the end.
    proxy.spend(2 * FLOW_WINDOW)
    assert.equal(proxy.room(), false)
    room = madeAgain()
    proxy.close()
    await within(room, 'closed')
    proxy.spend(FLOW_WINDOW)
    await within(proxy.whenRoom(), 'closed, again')
    next.terminate()
})

test('a server that asks again and again and reads nothing: what the client answers waits in the proxy, which ends the connection past SERVER_BACKLOG', { skip: !forServer }, async t => {
    // Security review finding 1: the remote asks for this computer's clipboard, a few bytes a time, and reads nothing;
    // the client answers each with the whole clipboard, which nothing counts against the room. Paused, the client's own
    // queue to send would grow with every answer, until the window ran out of memory.
    const secureContext = tls.createSecureContext({ key: forServer!.key, cert: forServer!.cert })
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', () => {
            socket.write(confirm(2))
            const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
            secure.on('error', () => { })
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(() => new Promise<Duplex>(resolve => {
        const socket: net.Socket = net.connect(port, '127.0.0.1', () => resolve(socket))
    }), () => { }, (m: string) => log.push(m), { withoutNla: () => { } })
    t.after(() => { proxy.close(); server.close() })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    const ended = closed(ws)
    ws.send(request(proxy.token))
    for (let i = 0; i < 80 && !log.some(l => /relay up/.test(l)); i++) {
        await soon(25)
    }
    assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
    const MB = 1024 * 1024
    const answer = Buffer.alloc(2 * MB)
    let gone = false
    void ended.then(() => { gone = true })
    // An answer at a time, each once the one before has left the client: the proxy takes each, though the server
    // takes none (paused, it would leave them in the client's queue, and this would stop).
    let sent = 0
    let waited = 0
    for (; !gone && sent < 2 * SERVER_BACKLOG; sent += answer.length) {
        ws.send(answer)
        for (let i = 0; i < 200 && !gone && ws.bufferedAmount; i++) {
            await soon(10)
        }
        assert.ok(gone || !ws.bufferedAmount, `the client still held ${ws.bufferedAmount / MB} MB after ${sent / MB} MB`)
        waited = Math.max(waited, proxy.backlog)
    }
    await ended
    assert.ok(gone, `${sent / MB} MB sent, and the connection still up`)
    assert.ok(waited <= SERVER_BACKLOG + answer.length, `${waited / MB} MB waited in the proxy`)
    assert.match(proxy.failure, /^more than \d+ MB sent to the server waited for it to take them \(\d+ MB\)/)
    assert.ok(log.some(l => /relay ended/.test(l)), log.join('\n'))
    // What the connection took went with it.
    assert.equal(proxy.backlog, 0)
    assert.equal(proxy.room(), true)
})

test('a server that fails TLS over a stream like the system ssh\'s leaves no error unheard behind', async t => {
    // The stream to the server as SystemSSHTarget.openTcp makes one (Duplex.from, ssh's stdout and stdin): destroyed when
    // TLS fails, it passes an abort on to the TLS socket, which had no listener left for it by then. An 'error' nobody
    // listens for is an uncaught exception, which in Tabby's window is one in its renderer.
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', () => {
            socket.write(confirm(2))
            // Not TLS: a handshake failure alert.
            socket.once('data', () => { socket.write(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28])); setTimeout(() => socket.destroy(), 5) })
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const { PassThrough } = await import('node:stream')
    const open = () => new Promise<Duplex>(resolve => {
        const socket = net.connect(port, '127.0.0.1', () => {
            const readable = new PassThrough()
            const writable = new PassThrough()
            socket.pipe(readable)
            writable.pipe(socket)
            socket.on('error', e => readable.destroy(e))
            resolve(Duplex.from({ readable, writable }))
        })
    })
    const unheard: Error[] = []
    const listener = (e: Error) => unheard.push(e)
    process.on('uncaughtException', listener)
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(open, () => { }, (m: string) => log.push(m), { withoutNla: () => { } })
    t.after(() => { process.off('uncaughtException', listener); proxy.close(); server.close() })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    const gone = closed(ws)
    ws.send(request(proxy.token))
    await gone
    await soon(100)
    assert.match(proxy.failure ?? '', /handshake failure/)
    assert.deepEqual(unheard.map(e => e.message), [])
})

test('a self-signed or expired certificate is not valid, and says which', { skip: !testAuthority || !forServer }, async t => {
    const self = selfSigned('subjectAltName=DNS:server.test')
    if (self) {
        const server = await tlsServer(self)
        t.after(() => server.close())
        assert.deepEqual((await heard(server, { serverName: 'server.test', tls: { ca: testAuthority!.ca } })).calls, [[false, 'DEPTH_ZERO_SELF_SIGNED_CERT']])
    }
    // openssl 3.4 or later makes one valid only in 2020.
    if (expiredOne) {
        const server = await tlsServer(expiredOne)
        t.after(() => server.close())
        assert.deepEqual((await heard(server, { serverName: 'server.test', tls: { ca: testAuthority!.ca } })).calls, [[false, 'CERT_HAS_EXPIRED']])
    }
})

test('a certificate refused by the check: the client gets no response, and nothing it sent goes to the server', { skip: !forServer }, async t => {
    const server = await tlsServer(forServer!)
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { throw new Error('certificate refused') }, (m: string) => log.push(m), { withoutNla: () => { }, serverName: 'other.test' })
    t.after(() => { proxy.close(); server.close() })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await opened(ws)
    const messages: Buffer[] = []
    ws.on('message', (m: Buffer) => messages.push(m))
    const gone = closed(ws)
    ws.send(request(proxy.token))
    // What a client could send ahead (CredSSP's first message, say) while the server is reached.
    ws.send(Buffer.from('3082000a0201060a0101', 'hex'))
    await gone
    assert.match(proxy.failure ?? '', /certificate refused/)
    assert.ok(!log.some(l => /relay up/.test(l)), log.join('\n'))
    // Only RDCleanPath's error came back (version 3390 and a general error), never the response with the certificates.
    assert.equal(messages.length, 1)
    assert.equal(messages[0].toString('hex'), '300fa00402020d3ea1073005a003020101')
    await soon(50)
    assert.equal(Buffer.concat(server.received).length, 0, 'nothing after the handshake reached the server')
})

test('the last of what a server sends over an SSH channel before closing it reaches a client that was behind', { skip: !unrestricted }, async t => {
    // The channel ends and closes right after the server's last bytes, while the client isn't reading: what the stream
    // still holds, and what waits for the helper's credit, goes before the stream closes (its end reason, say).
    const { SSHChannelStream } = require('../../dist/sshChannelStream.js')
    const { Subject } = require('rxjs')
    const secureContext = tls.createSecureContext({ key: unrestricted!.key, cert: unrestricted!.cert })
    const PDU = 16384
    const total = 24 * 1024 * 1024
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', () => {
            socket.write(confirm(2))
            const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
            secure.on('error', () => { })
            secure.once('secure', () => {
                const frame = Buffer.alloc(PDU, 0x41)
                frame.writeUInt8(3, 0)
                frame.writeUInt8(0, 1)
                frame.writeUInt16BE(PDU, 2)
                for (let sent = 0; sent < total; sent += PDU) {
                    secure.write(frame)
                }
                secure.end()
            })
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    // An SSH channel as russh hands it over: its data as it comes, then its EOF and close.
    const open = () => new Promise<Duplex>(resolve => {
        const socket = net.connect(port, '127.0.0.1', () => {
            const channel = {
                data$: new Subject(), eof$: new Subject(), closed$: new Subject(),
                write: (data: Uint8Array) => new Promise<void>(done => socket.write(data, () => done())),
                eof: async () => { socket.end() },
                close: async () => { socket.destroy() },
            }
            socket.on('data', d => channel.data$.next(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)))
            socket.on('end', () => channel.eof$.next())
            socket.on('close', () => channel.closed$.next())
            socket.on('error', () => { })
            resolve(new SSHChannelStream(channel))
        })
    })
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(open, () => { }, (m: string) => log.push(m), { withoutNla: () => { } })
    const ws = new WebSocket(proxy.url)
    t.after(() => { ws.terminate(); proxy.close(); server.close() })
    ws.on('error', () => { })
    await opened(ws)
    let received = 0
    let first = true
    ws.on('message', (d: Buffer) => {
        if (first) {
            first = false
        } else {
            received += d.length
        }
    })
    ws.send(request(proxy.token))
    for (let i = 0; i < 80 && first; i++) {
        await soon(25)
    }
    ws.pause()
    await soon(1500)
    ws.resume()
    for (let i = 0; i < 600 && received < total && ws.readyState === WebSocket.OPEN; i++) {
        await soon(25)
    }
    assert.equal(received, total, `${received} of ${total} bytes; ${proxy.failure ?? ''} ${log.join('\n')}`)
})

test('a stream that hands over megabytes at once (an SSH channel catching up after a pause) is carried within the window, whole', { skip: !unrestricted }, async t => {
    // SSHChannelStream gives what it held while its reader paused in one piece, however large: the plugin's side has to
    // send the helper no more than the window's credit allows, and keep the rest until the helper takes some.
    const secureContext = tls.createSecureContext({ key: unrestricted!.key, cert: unrestricted!.cert })
    const PDU = 16384
    const total = 32 * 1024 * 1024
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', () => {
            socket.write(confirm(2))
            const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
            secure.on('error', () => { })
            secure.once('secure', () => {
                const frame = Buffer.alloc(PDU, 0x41)
                frame.writeUInt8(3, 0)
                frame.writeUInt8(0, 1)
                frame.writeUInt16BE(PDU, 2)
                for (let sent = 0; sent < total; sent += PDU) {
                    secure.write(frame)
                }
            })
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    // What arrives is held and handed over every 100 ms, all of it in one chunk.
    const open = () => new Promise<Duplex>(resolve => {
        const socket = net.connect(port, '127.0.0.1', () => {
            let held: Buffer[] = []
            const stream: Duplex = new Duplex({
                read () { },
                write (chunk, _encoding, done) { socket.write(chunk, () => done()) },
                destroy (error, done) { clearInterval(timer); socket.destroy(); done(error) },
            })
            const timer = setInterval(() => {
                if (held.length) {
                    stream.push(Buffer.concat(held))
                    held = []
                }
            }, 100)
            socket.on('data', d => held.push(d))
            socket.on('error', e => stream.destroy(e))
            resolve(stream)
        })
    })
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(open, () => { }, (m: string) => log.push(m), { withoutNla: () => { } })
    const ws = new WebSocket(proxy.url)
    t.after(() => { ws.terminate(); proxy.close(); server.close() })
    ws.on('error', () => { })
    await opened(ws)
    let received = 0
    let first = true
    ws.on('message', (d: Buffer) => {
        if (first) {
            first = false
        } else {
            received += d.length
        }
    })
    ws.send(request(proxy.token))
    // The client stops reading for a while, as a busy window does: the helper stops reading the stream, whose
    // window fills, while the stream goes on handing over what it held.
    for (let i = 0; i < 80 && first; i++) {
        await soon(25)
    }
    ws.pause()
    await soon(1500)
    ws.resume()
    for (let i = 0; i < 600 && received < total && ws.readyState === WebSocket.OPEN; i++) {
        await soon(25)
    }
    assert.equal(received, total, `${received} of ${total} bytes; ${proxy.failure ?? ''} ${log.join('\n')}`)
    assert.equal(proxy.failure, null)
})
