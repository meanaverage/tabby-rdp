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
const { startRDCleanPathProxy, preconnectionPdu, offersNla, signsNothing, earlyUserAuthorization, withoutUserCookie, FLOW_WINDOW } = require('../../dist/rdcleanpath.js')
const WebSocket = require('ws')
import { authority, signedWith } from './support/certificates.js'

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

test('HYBRID_EX is a flag: an Early User Authorization Result follows whenever it is set, as IronRDP expects', () => {
    assert.equal(earlyUserAuthorization(confirm(8)), true)
    // HYBRID|HYBRID_EX: IronRDP waits for the result, and the proxy has to frame it (it refused the stream before).
    assert.equal(earlyUserAuthorization(confirm(0x0a)), true)
    assert.equal(offersNla(confirm(0x0a)), true)
    assert.equal(earlyUserAuthorization(confirm(2)), false)
    assert.equal(earlyUserAuthorization(confirm(1)), false)
    assert.equal(earlyUserAuthorization(confirm(8, true)), false)  // a refusal whose code happens to be 8
    assert.equal(earlyUserAuthorization(Buffer.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0, 0, 0])), false)
})

/**
 * An X.224 connection request as IronRDP's web client builds it (a native build of its connector, user
 * alice@corp.example): the user name as a cookie, then SSL|HYBRID|HYBRID_EX.
 */
const IRONRDP_REQUEST = Buffer.from('0300003833e00000000000436f6f6b69653a206d737473686173683d616c69636540636f72702e6578616d706c650d0a010008000b000000', 'hex')

test('the user name cookie is taken out of the connection request; the rest stays as it was', () => {
    assert.match(IRONRDP_REQUEST.toString('latin1'), /Cookie: mstshash=alice@corp\.example\r\n/)
    const out: Buffer = withoutUserCookie(IRONRDP_REQUEST)
    assert.equal(out.toString('hex'), '030000130ee00000000000010008000b000000')
    assert.equal(out.readUInt16BE(2), out.length, 'TPKT length')
    assert.equal(out[4], out.length - 5, 'X.224 length indicator')
    // Already without one, a broker's routing token (no user name in it), or not a connection request: as it is.
    const plain = Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0])
    assert.equal(withoutUserCookie(plain), plain)
    const token = Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0xe0, 0, 0, 0, 0, 0]), Buffer.from('Cookie: msts=3640205228.15629.0000\r\n')])
    token.writeUInt16BE(token.length, 2)
    token[4] = token.length - 5
    assert.equal(withoutUserCookie(token), token)
    const confirmation = confirm(2)
    assert.equal(withoutUserCookie(confirmation), confirmation)
    const unterminated = Buffer.from(IRONRDP_REQUEST.toString('latin1').replace('\r\n', '__'), 'latin1')
    assert.equal(withoutUserCookie(unterminated), unterminated)
})

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

test('certificates that leave signatures out of their key usage, and those that don\'t', { skip: !encipherOnly || !signing || !unrestricted }, () => {
    assert.equal(signsNothing(encipherOnly!.der), true)
    assert.equal(signsNothing(signing!.der), false)
    assert.equal(signsNothing(unrestricted!.der), false)
    // What can't be read doesn't show the need: no fallback for it (TLS took it, but that is no reason to give up
    // forward secrecy).
    assert.equal(signsNothing(Buffer.from('not a certificate')), false)
    assert.equal(signsNothing(encipherOnly!.der.subarray(0, encipherOnly!.der.length - 300)), false)
    const keyUsage = encipherOnly!.der.indexOf(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]))
    const garbled = Buffer.from(encipherOnly!.der)
    garbled[garbled.indexOf(0x03, keyUsage + 5)] = 0x04
    assert.equal(signsNothing(garbled), false, 'a key usage that isn\'t a bit string')
})

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

/**
 * Has the TLS library turn the server's certificate down in these handshakes (by number, from 1), as Electron's
 * (BoringSSL) does a certificate whose key usage rules the handshake out; plain Node doesn't check key usage. As there,
 * the TLS socket ends itself with the library's error, and the stream under it is left as it was (Electron 43: the
 * stream's `errored` stays null). The highest TLS version each handshake allowed is kept, in order (`any`: not limited).
 */
function refusedByTls (handshakes: number[]): { versions: string[], restore: () => void } {
    // The module the proxy calls (not the namespace imported above, whose bindings can't be replaced).
    const library = require('tls')
    const connect = library.connect
    const versions: string[] = []
    library.connect = (options: tls.ConnectionOptions, ...rest: unknown[]) => {
        const socket: tls.TLSSocket = connect.call(library, options, ...rest)
        versions.push(options.maxVersion ?? 'any')
        if (handshakes.includes(versions.length)) {
            setImmediate(() => socket.destroy(keyUsageRefusal()))
        }
        return socket
    }
    return { versions, restore: () => { library.connect = connect } }
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

test('TLS falls back to RSA key exchange on the TLS library\'s key-usage refusal, for a certificate without signatures', { skip: !encipherOnly }, async t => {
    const server = await tlsServer(encipherOnly!)
    const handshakes = refusedByTls([1])
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m))
    t.after(() => { handshakes.restore(); proxy.close(); server.close() })
    await attempt(proxy, log)
    assert.ok(log.some(l => /using TLS 1.2 with RSA key exchange/.test(l)), log.join('\n'))
    assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
    assert.equal(server.opened(), 2)
    assert.match(server.handshakes[0], /^TLSv1\.2 AES/)
    // Shown to be needed, with a certificate that was accepted: the next connection starts with it.
    await attempt(proxy, log)
    assert.deepEqual(handshakes.versions, ['any', 'TLSv1.2', 'TLSv1.2'])
})

test('an error of the stream under TLS doesn\'t make TLS fall back, whatever its code', { skip: !encipherOnly }, async t => {
    // Only the TLS library's own refusal counts: one passed on by the way there (an SSH channel, a gateway) is the
    // way there's, and could come from anywhere.
    const server = await tlsServer(encipherOnly!, [1])
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m))
    t.after(() => { proxy.close(); server.close() })
    await attempt(proxy, log)
    assert.equal(server.opened(), 1, 'not tried again')
    assert.match(proxy.failure ?? '', /KEY_USAGE_BIT_INCORRECT/)
    assert.ok(!log.some(l => /RSA key exchange/.test(l)), log.join('\n'))
})

test('an error that only says the words doesn\'t make TLS fall back', { skip: !signing }, async t => {
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
    assert.match(server.handshakes[0], /^TLSv1\.3/)
})

test('a certificate that allows signatures after a key-usage refusal: stopped, and the next connection starts without the fallback', { skip: !signing }, async t => {
    // Something on the way made the first handshake fail, to take forward secrecy away from the connection.
    const server = await tlsServer(signing!)
    const handshakes = refusedByTls([1])
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m))
    t.after(() => { handshakes.restore(); proxy.close(); server.close() })
    await attempt(proxy, log)
    assert.match(proxy.failure ?? '', /doesn't show a need for the fallback/)
    assert.ok(!log.some(l => /relay up/.test(l)), log.join('\n'))
    await attempt(proxy, log)
    assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
    assert.deepEqual(handshakes.versions, ['any', 'TLSv1.2', 'any'])
    assert.match(server.handshakes[server.handshakes.length - 1], /^TLSv1\.3/)
})

test('a certificate whose key usage can\'t be read doesn\'t get the fallback either', { skip: !encipherOnly }, async t => {
    // Windows' certificate, its key usage made unreadable (not a bit string): TLS takes it, but nothing shows that it
    // rules modern TLS out.
    const der = Buffer.from(encipherOnly!.der)
    der[der.indexOf(0x03, der.indexOf(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f])) + 5)] = 0x04
    const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n`
    const server = await tlsServer({ key: encipherOnly!.key, cert })
    const handshakes = refusedByTls([1])
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m))
    t.after(() => { handshakes.restore(); proxy.close(); server.close() })
    await attempt(proxy, log)
    assert.deepEqual(handshakes.versions, ['any', 'TLSv1.2'])
    assert.match(proxy.failure ?? '', /doesn't show a need for the fallback/)
    assert.ok(!log.some(l => /relay up/.test(l)), log.join('\n'))
})

test('a fallback whose own handshake fails leaves the next connection on modern TLS', { skip: !encipherOnly }, async t => {
    const server = await tlsServer(encipherOnly!)
    const handshakes = refusedByTls([1, 2])
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m))
    t.after(() => { handshakes.restore(); proxy.close(); server.close() })
    await attempt(proxy, log)
    assert.ok(!log.some(l => /relay up/.test(l)), log.join('\n'))
    await attempt(proxy, log)
    assert.deepEqual(handshakes.versions, ['any', 'TLSv1.2', 'any'])
    assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
})

test('a remembered fallback that then fails is forgotten: the next connection tries modern TLS first', { skip: !encipherOnly }, async t => {
    // The third connection (the second attempt, with the fallback as remembered) fails on its way there.
    const server = await tlsServer(encipherOnly!, [3])
    const handshakes = refusedByTls([1])
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, () => { }, (m: string) => log.push(m))
    t.after(() => { handshakes.restore(); proxy.close(); server.close() })
    await attempt(proxy, log)
    await attempt(proxy, log)
    await attempt(proxy, log)
    assert.deepEqual(handshakes.versions, ['any', 'TLSv1.2', 'TLSv1.2', 'any'])
})

test('a remembered fallback whose server doesn\'t answer in time is forgotten too: a server that hangs fails either way', { skip: !encipherOnly }, async t => {
    // Windows' certificate. The third connection (the second attempt, with the fallback as remembered) goes to a
    // server that never answers; the third attempt meets the TLS library's refusal again, and falls back again.
    const server = await tlsServer(encipherOnly!)
    const handshakes = refusedByTls([1, 3])
    const hanging = silentUpstream()
    let connections = 0
    const open = () => ++connections === 3 ? hanging.open() : server.open()
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(open, () => { }, (m: string) => log.push(m), { withoutNla: () => { }, handshakeTimeoutMs: 300 })
    t.after(() => { handshakes.restore(); proxy.close(); server.close() })
    await attempt(proxy, log)
    await attempt(proxy, log)
    assert.equal(proxy.failure, 'the server didn\'t answer in time')
    assert.equal(hanging.streams[0].destroyed, true)
    await attempt(proxy, log)
    assert.deepEqual(handshakes.versions, ['any', 'TLSv1.2', 'any', 'TLSv1.2'])
    assert.equal(log.filter(l => /relay up/.test(l)).length, 2, log.join('\n'))
})

test('a remembered fallback whose client leaves before the server answers is forgotten too', { skip: !encipherOnly }, async t => {
    const server = await tlsServer(encipherOnly!)
    const handshakes = refusedByTls([1, 3])
    const hanging = silentUpstream()
    let connections = 0
    const open = () => ++connections === 3 ? hanging.open() : server.open()
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(open, () => { }, (m: string) => log.push(m))
    t.after(() => { handshakes.restore(); proxy.close(); server.close() })
    await attempt(proxy, log)
    // The second attempt, with the fallback as remembered: its client goes once the server is being reached.
    const ws = new WebSocket(proxy.url)
    await opened(ws)
    ws.send(request(proxy.token))
    for (let i = 0; i < 80 && !hanging.streams.length; i++) {
        await soon(25)
    }
    ws.terminate()
    for (let i = 0; i < 80 && !hanging.streams[0]?.destroyed; i++) {
        await soon(25)
    }
    assert.equal(hanging.streams[0].destroyed, true)
    await attempt(proxy, log)
    assert.deepEqual(handshakes.versions, ['any', 'TLSv1.2', 'any', 'TLSv1.2'])
    assert.equal(log.filter(l => /relay up/.test(l)).length, 2, log.join('\n'))
})

/**
 * Runs in Electron (ELECTRON_RUN_AS_NODE), whose TLS library is BoringSSL, as in Tabby: the plugin's proxy, with a
 * client sending one request through it to the RDP server at `port`, reached the ways the proxy is given in Tabby:
 * directly (`direct`, a socket), through an SSH channel (`ssh`, the plugin's SSHChannelStream over a stand-in for
 * Tabby's channel), or through a stream of the plugin's own (`tunnel`: one like an RD Gateway's tunnel). The
 * last two also come `-broken`: failing at TLS's first bytes with an error shaped like the TLS library's refusal, as
 * one passed on from elsewhere would be. Prints what the proxy logged and why it failed, as JSON.
 */
const ELECTRON_CLIENT = String.raw`
const [dist, port, mode] = process.argv.slice(2)
const net = require('net')
const { Duplex } = require('stream')
const { createRequire } = require('module')
const { startRDCleanPathProxy } = require(dist + '/rdcleanpath.js')
const { SSHChannelStream } = require(dist + '/sshChannelStream.js')
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
const open = () => new Promise(resolve => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
        if (mode === 'direct') {
            return resolve(socket)
        }
        const broken = mode.endsWith('-broken')
        const stream = mode.startsWith('ssh') ? new SSHChannelStream(channelOver(socket, broken)) : tunnelOver(socket, broken)
        socket.on('error', e => stream.destroy(e))
        resolve(stream)
    })
})
;(async () => {
    const log = []
    const proxy = await startRDCleanPathProxy(open, () => { }, m => log.push(m))
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    await new Promise(resolve => ws.once('open', resolve))
    ws.send(request(proxy.token))
    for (let i = 0; i < 200 && ws.readyState === WebSocket.OPEN && !log.some(l => /relay up/.test(l)); i++) {
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    process.stdout.write(JSON.stringify({ electron: process.versions.electron, log, failure: proxy.failure }))
    process.exit(0)
})()
`

test('in Electron: its TLS library\'s own key-usage refusal falls back over a socket, an SSH channel or a gateway-like tunnel, an error passed on by the stream doesn\'t', {
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
    // BoringSSL's own refusal leaves the stream under TLS as it was, whichever kind it is: a Windows desktop reached
    // directly, through an SSH host (most of them) or a gateway falls back.
    for (const mode of ['direct', 'ssh', 'tunnel']) {
        const fine = await run(mode)
        assert.ok(fine.electron, 'ran in Electron')
        assert.ok(fine.log.some((l: string) => /using TLS 1.2 with RSA key exchange/.test(l)), `${mode}: ${fine.log.join('\n')}`)
        assert.ok(fine.log.some((l: string) => /relay up/.test(l)), `${mode}: ${fine.log.join('\n')}`)
        assert.match(fine.handshakes[0], /^TLSv1\.2 AES/, mode)
    }
    for (const mode of ['tunnel-broken', 'ssh-broken']) {
        const broken = await run(mode)
        assert.ok(!broken.log.some((l: string) => /RSA key exchange/.test(l)), `${mode}: ${broken.log.join('\n')}`)
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

test('the user name reaches no server whose certificate is refused, the retry with legacy TLS included', { skip: !encipherOnly }, async t => {
    // Windows' certificate: the first handshake fails as Electron's does (its TLS library's own refusal), the proxy
    // starts over on a fresh connection, and the certificate check (refusing it here) comes after that one's handshake.
    const server = await tlsServer(encipherOnly!)
    const handshakes = refusedByTls([1])
    const log: string[] = []
    let checked = 0
    const proxy = await startRDCleanPathProxy(server.open, () => { checked++; throw new Error('not the certificate remembered') }, (m: string) => log.push(m), { withoutNla: () => { } })
    t.after(() => { handshakes.restore(); proxy.close(); server.close() })
    await attempt(proxy, log, IRONRDP_REQUEST)
    assert.ok(log.some(l => /using TLS 1.2 with RSA key exchange/.test(l)), log.join('\n'))
    assert.equal(checked, 1)
    assert.match(proxy.failure ?? '', /not the certificate remembered/)
    assert.equal(server.requests.length, 2)
    for (const sent of server.requests) {
        assert.equal(sent.toString('hex'), '030000130ee00000000000010008000b000000')
    }
})

test('a connection request that still names the user once the cookie is taken out goes nowhere', async t => {
    const upstream = silentUpstream()
    const proxy = await startRDCleanPathProxy(upstream.open, () => { }, () => { }, { withoutNla: () => { } })
    t.after(() => proxy.close())
    // IronRDP's request with a TPKT length that doesn't add up: withoutUserCookie leaves it as it is.
    const odd = Buffer.from(IRONRDP_REQUEST)
    odd.writeUInt16BE(odd.length + 1, 2)
    assert.equal(withoutUserCookie(odd), odd)
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
 * `legacy`: the TLS library refuses the first handshake for the certificate's key usage, as Electron's does with
 * Windows' own, so the one checked is the fallback's.
 */
async function checked (certificate: { key: Buffer, cert: Buffer }, options: { name?: string, ca?: Buffer, legacy?: boolean } = {}) {
    const { whyNotValid, describeCertificate, vouched } = require('../../dist/authorities.js')
    const name = options.name ?? 'server.test'
    const server = await tlsServer(certificate)
    const handshakes = options.legacy ? refusedByTls([1]) : null
    const heard: [boolean, string, any][] = []
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(server.open, (_fingerprint: string, valid: boolean, reason: string, details: any) => { heard.push([valid, reason, details]) },
        (m: string) => log.push(m), { withoutNla: () => { }, serverName: name, tls: { ca: options.ca ?? testAuthority!.ca } })
    try {
        await attempt(proxy, log)
    } finally {
        handshakes?.restore()
        proxy.close()
        server.close()
    }
    assert.equal(heard.length, 1, log.join('\n'))
    const [valid, reason, details] = heard[0]
    return {
        valid, reason, chain: details?.chain, forName: details?.forName, fellBack: log.some(l => /using TLS 1.2 with RSA key exchange/.test(l)),
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
    // Windows' own (key and data encipherment, which Node doesn't take for one that signed itself), checked as it is
    // and after the fallback Electron's TLS library makes it take; a self-signed gateway's (digital signature and key
    // encipherment); and openssl's own kind.
    for (const [certificate, legacy] of [[encipherOnly!, false], [encipherOnly!, true], [signing!, false], [unrestricted!, false]] as const) {
        const self = await checked(certificate, { legacy })
        assert.equal(self.fellBack, legacy)
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

test('in Electron: where a certificate\'s chain stands, and whether it is for the name, as its TLS library (BoringSSL) leaves them to say', {
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
    // Windows' own: its TLS library refuses the first handshake (KEY_USAGE_BIT_INCORRECT), and the fallback's reports it
    // only as a signature it can't check (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Self-signed all the same.
    const windows = await run(encipherOnly!, 'server.test', testAuthority!.ca)
    assert.ok(windows.log.some((l: string) => /using TLS 1.2 with RSA key exchange/.test(l)), windows.log.join('\n'))
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

test('the room for answers: taken, made again only by what the proxy reads from the connection, all of it again when that ends', { skip: !forServer }, async t => {
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
    // The proxy reads a megabyte from the connection: that much room again.
    room = madeAgain()
    ws.send(Buffer.alloc(MB))
    await within(room, 'read from the connection')
    assert.equal(proxy.room(), true)
    // The server reads nothing: past what the proxy lets wait for it, the proxy stops reading from the connection, and
    // makes no room however much more waits there.
    const before = proxy.stats.bytesOut
    for (let i = 0; i < 48; i++) {
        ws.send(Buffer.alloc(MB))
    }
    let read = -1
    for (let i = 0; i < 100 && read !== proxy.stats.bytesOut; i++) {
        read = proxy.stats.bytesOut
        await soon(50)
    }
    assert.ok(read - before < 48 * MB, `the proxy read ${(read - before) / MB} MB of 48`)
    proxy.refund(FLOW_WINDOW)
    proxy.spend(FLOW_WINDOW)
    assert.equal(proxy.room(), false)
    room = madeAgain()
    await soon(200)
    assert.equal(made, false)
    // The server reads again: the proxy reads the rest, and there is room.
    reading()
    await within(room, 'the server reading again')
    assert.equal(proxy.room(), true)
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

test('after the fallback to TLS 1.2, the certificate is checked as on the first handshake', { skip: !encipheringOnly || !testAuthority }, async t => {
    // The first connection fails as Electron's TLS does with such a certificate (its TLS library's own refusal); the
    // second, made with the fallback, is the one checked: valid for its name, the name sent as SNI there too.
    const server = await tlsServer(encipheringOnly!)
    const handshakes = refusedByTls([1])
    t.after(() => { handshakes.restore(); server.close() })
    const { calls, sni, log } = await heard(server, { serverName: 'server.test', tls: { ca: testAuthority!.ca } })
    assert.ok(log.some(l => /using TLS 1.2 with RSA key exchange/.test(l)), log.join('\n'))
    assert.equal(server.opened(), 2)
    assert.deepEqual([calls, sni], [[[true, '']], 'server.test'])
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
