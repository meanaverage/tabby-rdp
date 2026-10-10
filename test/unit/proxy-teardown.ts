// How the loopback proxy (src/rdcleanpath.ts) ends a connection to a desktop reached directly, over a socket of its
// own: every way it can end once TLS runs over that socket. TLS over a socket works inside the socket's own handle
// (Node's TLSWrap); the socket destroyed under it while TLS still uses it crashed Tabby's window, on the first
// connection to a desktop whose certificate the check refused (issue #69). The tests over the plugin's other streams
// (an SSH channel, a gateway's tunnel) are in proxy.ts: TLS over a stream of JavaScript has no handle to share.
//
// Each case runs in a process of its own, since a crash ends the process it happens in: in Node, and in Electron as
// Tabby has it when TRD_ELECTRON names an Electron binary that may run as Node (see CONTRIBUTING.md). Needs the openssl
// command for the stand-in server's certificate. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { selfSigned } from './support/certificates.js'

/**
 * The proxy, with a client sending one request through it to a stand-in RDP server over a socket (as a desktop tab's
 * direct connection reaches its desktop), then `scenario`. Records the order the proxy's streams to the server are
 * destroyed in: the socket it was given ('socket') and TLS over it ('tls'). Prints what happened as JSON, and exits on
 * its own only if nothing crashed.
 */
const CLIENT = String.raw`
const [dist, keyFile, certFile, scenario] = process.argv.slice(2)
const net = require('net')
const tls = require('tls')
const fs = require('fs')
const { createRequire } = require('module')

// Before the plugin is loaded: the proxy's socket to the server is marked by the factory below, TLS over it here.
const destroyed = []
const destroy = net.Socket.prototype.destroy
net.Socket.prototype.destroy = function (...args) {
    if (this.trdUpstream && !this.destroyed) {
        destroyed.push(this.trdUpstream)
    }
    return destroy.apply(this, args)
}
const connect = tls.connect
tls.connect = function (...args) {
    const socket = connect.apply(this, args)
    socket.trdUpstream = 'tls'
    return socket
}

const { startRDCleanPathProxy } = require(dist + '/rdcleanpath.js')
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
// The server's answer to the connection request: CredSSP (NLA), or TLS alone (no NLA).
const confirm = protocol => Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 2, 0, 8, 0, protocol, 0, 0, 0])
const withoutNla = scenario === 'refused without NLA'

const secureContext = tls.createSecureContext({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) })
const serverSockets = new Set()
const server = net.createServer(socket => {
    serverSockets.add(socket)
    socket.on('error', () => { })
    socket.once('data', () => {
        socket.write(confirm(withoutNla ? 1 : 2))
        if (scenario === 'server hangs up during TLS') {
            return socket.once('data', () => socket.end())
        }
        if (scenario === 'server answers TLS with something else') {
            return socket.once('data', () => socket.write(Buffer.alloc(64, 0x41)))
        }
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
        secure.on('error', () => { })
        if (scenario === 'server closes the relay') {
            secure.once('secure', () => setTimeout(() => secure.end(), 100))
        }
    })
})

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port
    const log = []
    let ws
    let checked = false
    const open = () => new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
        socket.trdUpstream = 'socket'
    })
    const check = () => {
        checked = true
        switch (scenario) {
            case 'refused': throw new Error('refused by the check')
            case 'refused later': return Promise.reject(new Error('refused by the check'))
            case 'client leaves during the check': ws.terminate(); return new Promise(() => { })
        }
    }
    const options = {
        withoutNla: () => { },
        withoutNlaCertificate: () => { throw new Error('refused: not the certificate the permission was given for') },
    }
    const proxy = await startRDCleanPathProxy(open, check, m => log.push(m), options)
    ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    let clientClosed = false
    ws.on('close', () => { clientClosed = true })
    await new Promise(resolve => ws.once('open', resolve))
    ws.send(request(proxy.token))
    const relayUp = () => log.some(l => /relay up/.test(l))
    for (let i = 0; i < 200 && !clientClosed && !relayUp(); i++) {
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (scenario === 'client leaves during the relay') {
        ws.terminate()
    }
    for (let i = 0; i < 200 && !clientClosed; i++) {
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    // Long enough for what a crash would follow (the TLS library's next look at its socket) to have happened.
    await new Promise(resolve => setTimeout(resolve, 300))
    process.stdout.write(JSON.stringify({ electron: process.versions.electron ?? null, log, failure: proxy.failure, checked, clientClosed, relayUp: relayUp(), destroyed }))
    proxy.close()
    for (const socket of serverSockets) socket.destroy()
    server.close()
    process.exit(0)
})
`

interface Outcome {
    electron: string | null
    log: string[]
    failure: string | null
    checked: boolean
    clientClosed: boolean
    relayUp: boolean
    destroyed: string[]
    code: number | null
    signal: string | null
    stderr: string
}

const certificate = selfSigned('server.test')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-teardown-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
const script = path.join(dir, 'client.js')
fs.writeFileSync(script, CLIENT)
if (certificate) {
    fs.writeFileSync(path.join(dir, 'key.pem'), certificate.key)
    fs.writeFileSync(path.join(dir, 'cert.pem'), certificate.cert)
}
const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../dist')

/** Runs `scenario` in a process of its own: this Node, or Electron (`runtime`, run as Node). */
async function run (scenario: string, runtime = process.execPath): Promise<Outcome> {
    const child = spawn(runtime, [script, dist, path.join(dir, 'key.pem'), path.join(dir, 'cert.pem'), scenario], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let out = ''
    let stderr = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { stderr += d })
    const [code, signal] = await new Promise<[number | null, string | null]>(resolve => child.once('exit', (c, s) => resolve([c, s])))
    let reported: Omit<Outcome, 'code' | 'signal' | 'stderr'> = { electron: null, log: [], failure: null, checked: false, clientClosed: false, relayUp: false, destroyed: [] }
    try {
        reported = JSON.parse(out)
    } catch { }
    return { ...reported, code, signal, stderr }
}

/** Every way the connection ends after TLS is up over the socket, and what each must leave behind. */
const SCENARIOS: { name: string, failure?: RegExp, relayUp?: boolean }[] = [
    // The issue: a desktop tab's first connection, its certificate not trusted yet. The check refuses it at once.
    { name: 'refused', failure: /refused by the check/ },
    { name: 'refused later', failure: /refused by the check/ },
    // A server without NLA, let through before TLS, then held to the certificate its permission was given for.
    { name: 'refused without NLA', failure: /not the certificate the permission was given for/ },
    { name: 'client leaves during the check' },
    { name: 'client leaves during the relay', relayUp: true },
    { name: 'server closes the relay', relayUp: true },
    { name: 'server hangs up during TLS', failure: /upstream closed during TLS/ },
    { name: 'server answers TLS with something else', failure: /./ },
]

/** What every scenario must show, whatever ran it. */
function assertEnded (scenario: typeof SCENARIOS[number], outcome: Outcome, where: string): void {
    const what = `${where}, ${scenario.name}: ${JSON.stringify({ ...outcome, stderr: outcome.stderr.slice(-2000) })}`
    assert.equal(outcome.signal, null, `the process crashed (${outcome.signal}): ${what}`)
    assert.equal(outcome.code, 0, `the process didn't end as it should: ${what}`)
    assert.equal(outcome.clientClosed, true, `the client heard the connection end: ${what}`)
    assert.equal(outcome.relayUp, !!scenario.relayUp, what)
    if (scenario.failure) {
        assert.match(outcome.failure ?? '', scenario.failure, what)
    }
    // TLS goes before the socket under it, every time the proxy ends them both. (Where the server hangs up or TLS
    // fails, TLS may end itself first; it never ends after its socket.)
    const tlsAt = outcome.destroyed.indexOf('tls')
    const socketAt = outcome.destroyed.indexOf('socket')
    assert.ok(socketAt === -1 || tlsAt !== -1 && tlsAt < socketAt, `TLS destroyed before the socket under it: ${what}`)
}

for (const scenario of SCENARIOS) {
    test(`a direct connection that ends this way leaves the process running, TLS destroyed before its socket: ${scenario.name}`, { skip: !certificate }, async () => {
        const outcome = await run(scenario.name)
        assertEnded(scenario, outcome, 'in Node')
        if (scenario.name.startsWith('refused') || scenario.name.startsWith('client leaves')) {
            assert.equal(outcome.checked, true, 'the certificate was checked')
            assert.deepEqual(outcome.destroyed, ['tls', 'socket'], 'the proxy ended both itself, TLS first')
        }
    })
}

test('in Electron: a direct connection that ends any of these ways leaves the window\'s process running', {
    skip: !process.env.TRD_ELECTRON ? 'set TRD_ELECTRON to an Electron binary to run this' : !certificate,
}, async () => {
    for (const scenario of SCENARIOS) {
        const outcome = await run(scenario.name, process.env.TRD_ELECTRON)
        assert.ok(outcome.electron, `ran in Electron: ${outcome.stderr.slice(-2000)}`)
        assertEnded(scenario, outcome, `in Electron ${outcome.electron}`)
    }
})
