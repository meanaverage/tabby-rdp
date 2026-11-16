// Real packaged clients inside Tabby's Electron runtime, against a local synthetic TLS RDP peer.
// Runs on hosted Windows/Linux/macOS without private credentials, a VM, or a reachable desktop server.
import { suite } from '../lib/harness.js'
import { selfSigned } from '../unit/support/certificates.js'

await suite('freerdp-runtime', async t => {
    const certificate = selfSigned('runtime.test', 'subjectAltName=DNS:runtime.test')
    t.check('test TLS certificate can be created', !!certificate)
    if (!certificate) return
    t.onCleanup(() => t.ev('H.runtimeClient?.shutdown(); for (const s of H.runtimeSockets ?? []) s.destroy(); H.runtimeServer?.close()'))
    await t.ev(`
        const cache = require('module')._cache ?? {}
        const file = Object.keys(cache).find(k => /[\\\\/]dist[\\\\/]freerdp\\.js$/.test(k))
        if (!file) throw new Error('Tabby has not loaded the FreeRDP module')
        H.runtimeModule = require(file)
        const tls = require('tls')
        const secureContext = tls.createSecureContext({ key: ${JSON.stringify(certificate.key.toString())}, cert: ${JSON.stringify(certificate.cert.toString())} })
        H.runtimeSockets = new Set()
        H.runtimeServer = require('net').createServer(socket => {
            H.runtimeSockets.add(socket)
            socket.on('error', () => {})
            socket.on('close', () => H.runtimeSockets.delete(socket))
            let request = Buffer.alloc(0)
            const negotiation = data => {
                request = Buffer.concat([request, data])
                if (request.length < 4 || request.length < request.readUInt16BE(2)) return
                socket.removeListener('data', negotiation)
                H.runtimeRequests.push(request)
                socket.write(Buffer.from([3,0,0,19,14,0xd0,0,0,0x12,0x34,0,2,0,8,0,2,0,0,0]))
                const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
                H.runtimeSockets.add(secure)
                secure.on('error', () => {})
                secure.on('close', () => H.runtimeSockets.delete(secure))
                secure.on('data', data => { H.runtimeApplicationBytes += data.length })
            }
            socket.on('data', negotiation)
        })
        await new Promise(resolve => H.runtimeServer.listen(0, '127.0.0.1', resolve))
    `)
    for (const runtime of ['native', 'wasm']) {
        const available = await t.ev<boolean>(`return ${runtime === 'native' ? 'H.runtimeModule.hasFreeRDP()' : 'true'}`)
        if (!available) { t.skip('native FreeRDP runtime', 'no helper for this host architecture'); continue }
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await t.ev<{ refused: boolean, checked: number, closed: boolean, application: number, anonymous: boolean }>(`
                H.runtimeRequests = []; H.runtimeApplicationBytes = 0
                let checked = 0, closed = false, refused = false
                const client = new H.runtimeModule.FreeRDPProcess(${JSON.stringify(runtime)})
                H.runtimeClient = client
                const options = { host: 'runtime.test', username: 'DO_NOT_SEND', password: 'synthetic-only', domain: 'PRIVATE',
                    width: 800, height: 600, pipeline: false, authorities: [], frame: () => {},
                    certificate: () => { checked++; throw new Error('Refuse the fixture certificate') },
                    withoutNla: () => { throw new Error('Require NLA') },
                    open: async () => {
                        client.child.once('close', () => { closed = true })
                        const socket = require('net').connect(H.runtimeServer.address().port, '127.0.0.1')
                        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
                        return socket
                    },
                }
                let timeout
                try {
                    await Promise.race([client.connect(options), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('WASM runtime timed out')), 15000) })])
                } catch { refused = true } finally { clearTimeout(timeout); client.shutdown() }
                for (let i = 0; i < 100 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 30))
                return { refused, checked, closed, application: H.runtimeApplicationBytes,
                    anonymous: H.runtimeRequests.length > 0 && H.runtimeRequests.every(b => !b.includes(Buffer.from('DO_NOT_SEND')) && !b.includes(Buffer.from('PRIVATE'))) }
            `)
            t.check(`${runtime} attempt ${attempt + 1}: executes TLS and asks the certificate policy`, result.refused && result.checked === 1, result)
            t.check(`${runtime} attempt ${attempt + 1}: rejects before credentials and closes its process`, result.closed && result.application === 0 && result.anonymous, result)
        }
    }
}, { needsHost: false })
