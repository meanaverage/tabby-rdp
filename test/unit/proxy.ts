// The loopback proxy's edges (src/rdcleanpath.ts): what a client can do before it has shown the token, a client
// that leaves while the server is being reached, and closing the proxy. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Duplex } from 'node:stream'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'

const require = createRequire(import.meta.url)
const { startRDCleanPathProxy, preconnectionPdu, offersNla } = require('../../dist/rdcleanpath.js')
const WebSocket = require('ws')

const der = (tag: number, content: Buffer) => {
    const n = content.length
    const length = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
    return Buffer.concat([Buffer.from([tag, ...length]), content])
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

test('a pre-connection PDU: version 2, the text in UTF-16 with its terminator', () => {
    const pdu: Buffer = preconnectionPdu('ab')
    assert.equal(pdu.length, 18 + 6)
    assert.deepEqual([pdu.readUInt32LE(0), pdu.readUInt32LE(4), pdu.readUInt32LE(8), pdu.readUInt32LE(12), pdu.readUInt16LE(16)], [24, 0, 2, 0, 3])
    assert.equal(pdu.subarray(18).toString('utf16le'), 'ab\0')
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

test('Network Level Authentication: what the server chose', () => {
    assert.equal(offersNla(confirm(2)), true)    // CredSSP
    assert.equal(offersNla(confirm(8)), true)    // CredSSP with early user authorization
    assert.equal(offersNla(confirm(1)), false)   // TLS alone: the password would go in the Client Info PDU
    assert.equal(offersNla(confirm(0)), false)   // standard RDP security
    assert.equal(offersNla(confirm(2, true)), false)  // a refusal whose code happens to be 2
    assert.equal(offersNla(Buffer.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0, 0, 0])), false)  // no negotiation response at all
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
