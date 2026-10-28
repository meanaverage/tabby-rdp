// The network helper in Tabby itself, without a remote machine: the proxy started from Tabby's window (Electron's Node
// spawning the helper), Chromium's own WebSocket (as IronRDP's client uses it) talking to the helper's server, a
// relay both ways to a stand-in RDP server in the window, the helper killed under a relay (the failure says so, the
// client hears the end, and the next proxy starts), and a proxy closed (its helper gone).
//   npm test -- helper
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from '../lib/harness.js'
import { selfSigned } from '../unit/support/certificates.js'

const dist = path.resolve(fileURLToPath(new URL('../../dist', import.meta.url)))

await suite('helper', async t => {
    const { ev, check } = t
    const certificate = selfSigned('server.test')
    if (!certificate) {
        t.skip('helper', 'no openssl command for the stand-in server\'s certificate')
        return
    }
    await ev(`Object.assign(H, {
        trdProxy () {
            // The plugin's module as Tabby loaded it (Node's module registry), else the checkout's build.
            const cache = require('module')._cache ?? {}
            const file = Object.keys(cache).find(k => /[\\\\/]dist[\\\\/]rdcleanpath\\.js$/.test(k)) ?? ${JSON.stringify(dist + '/rdcleanpath.js')}
            H.trdModule = file
            return require(file)
        },
        async trdServer () {
            const net = require('net'), tls = require('tls')
            const secureContext = tls.createSecureContext({ key: ${JSON.stringify(certificate.key.toString())}, cert: ${JSON.stringify(certificate.cert.toString())} })
            const server = net.createServer(socket => {
                socket.on('error', () => { })
                socket.once('data', () => {
                    socket.write(Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 2, 0, 8, 0, 2, 0, 0, 0]))
                    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
                    secure.on('error', () => { })
                    // Echoes each PDU it gets, and starts with one of its own.
                    secure.once('secure', () => secure.write(Buffer.from([3, 0, 0, 7, 1, 2, 3])))
                    secure.on('data', d => secure.write(d))
                })
            })
            await new Promise(r => server.listen(0, '127.0.0.1', r))
            H.trdServers = [...(H.trdServers ?? []), server]
            return server.address().port
        },
        trdRequest (token) {
            const der = (tag, c) => Buffer.concat([Buffer.from([tag, c.length]), c])
            return der(0x30, Buffer.concat([der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))), der(0xa2, der(0x0c, Buffer.from('server:3389'))),
                der(0xa3, der(0x0c, Buffer.from(token))), der(0xa6, der(0x04, Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0])))]))
        },
        async trdRelay () {
            const port = await H.trdServer()
            const log = []
            const proxy = await H.trdProxy().startRDCleanPathProxy(async () => ({ direct: { host: '127.0.0.1', port } }), () => { }, m => log.push(m), { withoutNla: () => { } })
            const ws = new WebSocket(proxy.url)
            ws.binaryType = 'arraybuffer'
            const messages = []
            let closed = false
            ws.onmessage = e => messages.push(new Uint8Array(e.data))
            ws.onclose = () => { closed = true }
            await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
            ws.send(H.trdRequest(proxy.token))
            for (let i = 0; i < 100 && messages.length < 2; i++) await new Promise(r => setTimeout(r, 50))
            ws.send(new Uint8Array([3, 0, 0, 6, 9, 9]))
            for (let i = 0; i < 100 && messages.length < 3; i++) await new Promise(r => setTimeout(r, 50))
            return { proxy, ws, log, messages, closed: () => closed }
        },
        trdHelpers () {
            try {
                return require('child_process').execFileSync('pgrep', ['-P', String(process.pid), '-f', 'tabby-rdp-proxy'], { encoding: 'utf8' }).trim().split('\\n').filter(Boolean).map(Number)
            } catch { return [] }
        },
    })`)
    t.onCleanup(() => ev('for (const s of H.trdServers ?? []) s.close(); for (const p of H.trdProxies ?? []) p.close()'))

    // A relay through the helper, with Chromium's WebSocket as the client.
    const relay = await ev<{ response: boolean, first: number[], echo: number[], log: string[], helpers: number, module: string }>(`
        const r = await H.trdRelay()
        H.trdProxies = [r.proxy]
        H.trdLive = r
        return { response: r.messages[0]?.[0] === 0x30, first: [...(r.messages[1] ?? [])], echo: [...(r.messages[2] ?? [])], log: r.log, helpers: H.trdHelpers().length, module: H.trdModule }
    `)
    check('the RDCleanPath response comes back to Chromium\'s WebSocket', relay.response, relay)
    check('the server\'s PDU reaches the client, a message of its own', JSON.stringify(relay.first) === JSON.stringify([3, 0, 0, 7, 1, 2, 3]), relay)
    check('the client\'s data reaches the server, and its echo comes back', JSON.stringify(relay.echo) === JSON.stringify([3, 0, 0, 6, 9, 9]), relay)
    check('the relay is up, in the log', relay.log.some(l => /relay up/.test(l)), relay.log)
    check('one helper runs, a child of Tabby\'s window', relay.helpers === 1, relay)
    console.log(`      (the plugin's module: ${relay.module})`)

    // The helper killed under the relay: the failure says so, the client hears the end, and the proxy is ended.
    const killed = await ev<{ failure: string | null, closed: boolean, ended: boolean }>(`
        const r = H.trdLive
        for (const pid of H.trdHelpers()) process.kill(pid, 'SIGKILL')
        for (let i = 0; i < 100 && !(r.closed() && r.proxy.failure); i++) await new Promise(res => setTimeout(res, 50))
        return { failure: r.proxy.failure, closed: r.closed(), ended: r.proxy.ended }
    `)
    check('a helper that stops says how, in the failure', /stopped unexpectedly \(signal SIGKILL/.test(killed.failure ?? ''), killed)
    check('the client hears the end', killed.closed, killed)
    check('the proxy is ended, for the desktop to start another', killed.ended, killed)

    // Another proxy works, and closing it leaves no helper behind.
    const again = await ev<{ echo: number[], before: number, after: number }>(`
        const r = await H.trdRelay()
        H.trdProxies.push(r.proxy)
        const before = H.trdHelpers().length
        r.ws.close()
        r.proxy.close()
        await r.proxy.stopped
        return { echo: [...(r.messages[2] ?? [])], before, after: H.trdHelpers().length }
    `)
    check('a new proxy relays again', JSON.stringify(again.echo) === JSON.stringify([3, 0, 0, 6, 9, 9]), again)
    check('closing the proxy stops its helper', again.before === 1 && again.after === 0, again)
}, { needsHost: false })
