#!/usr/bin/env node
// Measures the RDCleanPath proxy as Tabby's window has it: the plugin's side of the proxy (this process, standing in
// for the window's renderer, where IronRDP's client also runs) and a stand-in RDP server in a process of its own
// (X.224, TLS, then bulk data). For a built plugin (`--dist`, this checkout's dist/ by default; an older build's works
// too, which is how the helper was compared with the proxy that ran in the window):
//
//   node scripts/bench-proxy.mjs [--dist <dir>] [--route direct|stream] [--direction down|up] [--mb <n>] [--json]
//
//   --route direct: the desktop reached directly (a connection the proxy makes; before the helper, a socket of the
//           window's with TLS over it); stream: through a stream of JavaScript's over a socket, flow-controlled as an
//           SSH channel is, as an SSH tab's channel reaches a desktop behind its host (Tabby's SSH itself isn't in it).
//   --direction down: the server sends (graphics, a file copied from the remote); up: the client sends 1 MB messages
//           (a file pasted to the remote), each taking room first as FileTransfer's do (ServerFlow).
//
// Reports the throughput, this process's CPU time and event-loop delay while the data moved (how long the window
// would have been held up: IronRDP's own work isn't in it, but the WebSocket client's is, the same for every build), its
// peak memory, and the helper's CPU time and memory where there is one. Needs the openssl command for the server's
// certificate. Numbers vary from run to run and machine to machine: compare builds on one machine, several runs each.
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'

const SERVER = String.raw`
const net = require('net'), tls = require('tls'), fs = require('fs')
const [key, cert, direction, total] = process.argv.slice(2)
const secureContext = tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) })
const PDU = 16384
const frame = Buffer.alloc(PDU, 0x41)
frame.writeUInt8(3, 0); frame.writeUInt8(0, 1); frame.writeUInt16BE(PDU, 2)
const server = net.createServer(socket => {
    socket.setNoDelay(true)
    socket.on('error', () => { })
    socket.once('data', () => {
        // The connection request's answer: CredSSP chosen.
        socket.write(Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 2, 0, 8, 0, 2, 0, 0, 0]))
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
        secure.on('error', () => { })
        let received = 0
        secure.on('data', d => {
            received += d.length
            if (direction === 'up' && received >= Number(total)) {
                process.send({ received })
            }
        })
        secure.once('secure', async () => {
            if (direction !== 'down') {
                return
            }
            // Only once the measurement starts.
            await go
            let sent = 0
            const pump = () => {
                while (sent < Number(total)) {
                    sent += PDU
                    if (!secure.write(frame)) {
                        return secure.once('drain', pump)
                    }
                }
            }
            pump()
        })
    })
})
let started
const go = new Promise(resolve => { started = resolve })
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
process.on('message', m => m === 'stop' ? process.exit(0) : m === 'go' && started())
`

function options (args) {
    const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
    const o = { dist: path.join(root, 'dist'), route: 'direct', direction: 'down', mb: 256, json: false }
    for (let i = 0; i < args.length; i++) {
        const [name, value] = [args[i], args[i + 1]]
        if (name === '--dist') { o.dist = path.resolve(value); i++ } else if (name === '--route') { o.route = value; i++ } else if (name === '--direction') { o.direction = value; i++ } else if (name === '--mb') { o.mb = Number(value); i++ } else if (name === '--json') { o.json = true } else { throw new Error(`Unknown argument ${name}`) }
    }
    if (!['direct', 'stream'].includes(o.route) || !['down', 'up'].includes(o.direction) || !(o.mb > 0)) {
        throw new Error('usage: node scripts/bench-proxy.mjs [--dist <dir>] [--route direct|stream] [--direction down|up] [--mb <n>] [--json]')
    }
    return o
}

/** A child's CPU time (seconds) and memory (MB), as ps reports them; null where there is no such process. */
function usage (pid) {
    try {
        const [rss, time] = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/)
        const parts = time.split(/[:.-]/).map(Number)
        // [[dd-]hh:]mm:ss.cc
        const seconds = time.includes('.')
            ? parts.slice(0, -1).reduce((s, p) => s * 60 + p, 0) + parts.at(-1) / 100
            : parts.reduce((s, p) => s * 60 + p, 0)
        return { cpu: seconds, rssMB: Number(rss) / 1024 }
    } catch {
        return null
    }
}

/** The helper process this one started, if any (the proxy's, after the helper). */
function helperPid () {
    try {
        return Number(execFileSync('pgrep', ['-P', String(process.pid), '-f', 'tabby-rdp-proxy'], { encoding: 'utf8' }).trim().split('\n')[0]) || null
    } catch {
        return null
    }
}

async function main () {
    const o = options(process.argv.slice(2))
    const require = createRequire(path.join(o.dist, 'index.js'))
    const { startRDCleanPathProxy } = require(path.join(o.dist, 'rdcleanpath.js'))
    const total = o.mb * 1024 * 1024
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-bench-'))
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '1', '-subj', '/CN=server.test'], { stdio: 'ignore' })
        fs.writeFileSync(`${dir}/server.cjs`, SERVER)
        const server = spawn(process.execPath, [`${dir}/server.cjs`, `${dir}/key.pem`, `${dir}/cert.pem`, o.direction, String(total)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
        const port = await new Promise(resolve => server.once('message', m => resolve(m.port)))
        const serverDone = o.direction === 'up' ? new Promise(resolve => server.on('message', m => m.received && resolve())) : null
        // The way to the desktop: a socket of the window's (the proxy before the helper), the helper's own connection
        // (a factory that names it), or the plugin's SSH channel adapter over a socket.
        const socket = () => new Promise(resolve => { const s = net.connect(port, '127.0.0.1', () => { s.setNoDelay(true); resolve(s) }) })
        // A stream of JavaScript's over the socket, as Tabby's SSH channels reach the plugin, and flow-controlled as
        // an SSH channel is by its window: the socket waits while the stream's reader does.
        const streamOver = s => {
            const stream = new Duplex({
                read () { s.resume() },
                write (chunk, _encoding, done) { s.write(chunk, () => done()) },
                final (done) { s.end(); done() },
                destroy (error, done) { s.destroy(); done(error) },
            })
            s.on('data', d => { if (!stream.push(d)) s.pause() })
            s.on('end', () => stream.push(null))
            s.on('error', e => stream.destroy(e))
            return stream
        }
        const helperBuild = fs.existsSync(path.join(o.dist, 'proxyHelper.js'))
        const open = o.route === 'stream'
            ? async () => streamOver(await socket())
            : helperBuild ? async () => ({ direct: { host: '127.0.0.1', port } }) : socket
        const log = []
        const proxy = await startRDCleanPathProxy(open, () => { }, m => log.push(m), { withoutNla: () => { } })
        const der = (tag, c) => Buffer.concat([Buffer.from([tag, c.length]), c])
        const ws = new WebSocket(proxy.url)
        ws.binaryType = 'arraybuffer'
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
        let received = 0
        let first = true
        let downDone
        const down = new Promise(resolve => { downDone = resolve })
        ws.onmessage = e => {
            if (first) {
                first = false
                return
            }
            received += e.data.byteLength
            if (o.direction === 'down' && received >= total) {
                downDone()
            }
        }
        ws.send(der(0x30, Buffer.concat([der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))), der(0xa2, der(0x0c, Buffer.from('server:3389'))),
            der(0xa3, der(0x0c, Buffer.from(proxy.token))), der(0xa6, der(0x04, Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0])))])))
        for (let i = 0; i < 400 && !log.some(l => /relay up/.test(l)); i++) {
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        if (!log.some(l => /relay up/.test(l))) {
            throw new Error(`the relay didn't come up: ${log.join('; ')}`)
        }
        const helper = helperPid()
        const helperBefore = helper ? usage(helper) : null
        const delay = monitorEventLoopDelay({ resolution: 1 })
        let rss = process.memoryUsage().rss
        const sampler = setInterval(() => { rss = Math.max(rss, process.memoryUsage().rss) }, 20)
        delay.enable()
        const cpu = process.cpuUsage()
        const started = process.hrtime.bigint()
        server.send('go')
        if (o.direction === 'up') {
            const message = Buffer.alloc(1024 * 1024, 0x42)
            // A TPKT frame's header, so that xrdp-style framing would take it; the proxy passes it on as it is.
            message.writeUInt8(3, 0)
            // As FileTransfer sends a file: each part takes room first (ServerFlow), and waits while there is none.
            let sent = 0
            while (sent < total) {
                if (!proxy.room()) {
                    await proxy.whenRoom()
                }
                proxy.spend(message.length)
                ws.send(message)
                sent += message.length
                // Each message from a task of its own, as IronRDP's client sends them, so that the delay measured is
                // the proxy's and not a loop of sends that never yields.
                await new Promise(resolve => ws.bufferedAmount > 8 * 1024 * 1024 ? setTimeout(resolve, 1) : setImmediate(resolve))
            }
            await serverDone
        } else {
            await down
        }
        const seconds = Number(process.hrtime.bigint() - started) / 1e9
        const used = process.cpuUsage(cpu)
        delay.disable()
        clearInterval(sampler)
        const helperAfter = helper ? usage(helper) : null
        const result = {
            build: helperBuild ? 'helper' : 'in-window', route: o.route, direction: o.direction, mb: o.mb,
            seconds: +seconds.toFixed(3), mbPerSecond: +(o.mb / seconds).toFixed(1),
            windowCpuSeconds: +((used.user + used.system) / 1e6).toFixed(2),
            windowCpuPerMB: +((used.user + used.system) / 1e3 / o.mb).toFixed(2),
            // Beyond the 1 ms the delay is sampled at: how long a timer waited for the thread.
            eventLoopDelayMs: { p50: +Math.max(0, delay.percentile(50) / 1e6 - 1).toFixed(1), p99: +Math.max(0, delay.percentile(99) / 1e6 - 1).toFixed(1), max: +Math.max(0, delay.max / 1e6 - 1).toFixed(1) },
            windowPeakRssMB: +(rss / 1024 / 1024).toFixed(0),
            ...helperAfter ? { helperCpuSeconds: +(helperAfter.cpu - (helperBefore?.cpu ?? 0)).toFixed(2), helperRssMB: +helperAfter.rssMB.toFixed(0) } : {},
        }
        ws.close()
        proxy.close()
        await proxy.stopped
        server.send('stop')
        console.log(o.json ? JSON.stringify(result) : result)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

main().then(() => process.exit(0), e => { console.error(e.message ?? e); process.exit(1) })
