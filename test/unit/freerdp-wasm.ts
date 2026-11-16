import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
const require = createRequire(import.meta.url)
const { FreeRDPWasmProcess, hasFreeRDPWasm } = require('../../dist/freerdpWasm.js')
const { helperEnvironment } = require('../../dist/freerdp.js')

test('portable FreeRDP records exact sources, artifacts and dependency licenses', { skip: !hasFreeRDPWasm() }, () => {
    const root = resolve('.'), dir = join(root, 'wasm/freerdp')
    const record = JSON.parse(readFileSync(join(dir, 'BUILD.json'), 'utf8'))
    const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
    assert.deepEqual(record.freerdp, JSON.parse(readFileSync('native/freerdp-source.json', 'utf8')))
    assert.deepEqual(record.toolchain, JSON.parse(readFileSync('native/wasm-source.json', 'utf8')))
    for (const [source, expected] of Object.entries(record.buildSources)) assert.equal(hash(join(root, source)), expected, `${source}: rebuild WASM`)
    for (const file of record.files) assert.equal(hash(join(dir, file.path)), file.sha256, file.path)
    const walk = (dir: string, prefix = ''): string[] => readdirSync(dir).flatMap(name => {
        const stat = lstatSync(join(dir, name))
        assert.ok(!stat.isSymbolicLink())
        return stat.isDirectory() ? walk(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]
    })
    const listed = record.files.map((f: { path: string }) => f.path).sort()
    assert.deepEqual(walk(dir).filter(p => p !== 'BUILD.json').sort(), listed)
    for (const name of ['FreeRDP-LICENSE', 'FreeRDP-NOTICE', 'Unicode-NOTICE', 'LibreSSL-LICENSE', 'zlib-LICENSE', 'Emscripten-LICENSE']) {
        assert.ok(listed.includes(`licenses/${name}`), name)
    }
})

test('WASM bridge rejects wrong tokens and browser origins, then terminates a blocked worker', { skip: !hasFreeRDPWasm(), timeout: 10000 }, async t => {
    const token = 'a'.repeat(64)
    const child = await FreeRDPWasmProcess.create({ port: 1, token }, helperEnvironment())
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    t.after(() => child.kill())
    const WebSocket = require('ws')
    const address = `ws://127.0.0.1:${child.server.address().port}`
    for (const [path, options] of [['/wrong', {}], [`/${token}`, { origin: 'https://example.com' }]] as const) {
        const ws = new WebSocket(address + path, options)
        ws.on('error', () => {})
        const status = await new Promise<number>(resolve => ws.once('unexpected-response', (_req: unknown, response: any) => { response.resume(); resolve(response.statusCode); ws.terminate() }))
        assert.equal(status, 401)
    }
    const closed = once(child, 'close')
    assert.equal(child.kill(), true)
    await closed
    assert.equal(child.kill(), false)
    assert.equal(child.server.address(), null)
    assert.equal(child.connections.size, 0)
})

test('WASM exits when its input ends while waiting for a start command', { skip: !hasFreeRDPWasm(), timeout: 10000 }, async t => {
    const child = await FreeRDPWasmProcess.create({ port: 1, token: 'b'.repeat(64) }, helperEnvironment())
    t.after(() => child.kill())
    child.on('error', () => {})
    const closed = once(child, 'close')
    child.stdin.end()
    await closed
    assert.equal(child.connections.size, 0)
    assert.equal(child.server.address(), null)
})

test('WASM socket stops a stalled receiver before retaining unbounded uploads', { timeout: 15000 }, async t => {
    const { boundedWebSocket, MAX_WASM_SOCKET_BACKLOG } = require('../../dist/freerdpWasmSocket.js')
    const { WebSocketServer } = require('ws')
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    t.after(() => { for (const client of server.clients) client.terminate(); server.close() })
    server.on('connection', (peer: any) => peer.pause())
    let overflows = 0
    const Socket = boundedWebSocket(require('ws'), () => overflows++)
    const socket = new Socket(`ws://127.0.0.1:${server.address().port}`)
    socket.on('error', () => {})
    t.after(() => socket.terminate())
    await once(socket, 'open')
    const part = Buffer.alloc(1024 * 1024, 42)
    for (let i = 0; i < 256 && !overflows; i++) {
        socket.send(part)
        assert.ok(socket.bufferedAmount <= MAX_WASM_SOCKET_BACKLOG)
    }
    assert.equal(overflows, 1)
    socket.send(part)
    assert.equal(overflows, 1)
})

test('WASM bridge flushes final relay data before closing', { skip: !hasFreeRDPWasm(), timeout: 10000 }, async t => {
    const { createServer } = require('node:net')
    const bytes = Buffer.alloc(4 * 1024 * 1024, 73)
    const relay = createServer((socket: any) => socket.end(bytes))
    relay.listen(0, '127.0.0.1')
    await once(relay, 'listening')
    t.after(() => relay.close())
    const token = 'c'.repeat(64)
    const child = await FreeRDPWasmProcess.create({ port: relay.address().port, token }, helperEnvironment())
    child.on('error', () => {})
    t.after(() => child.kill())
    const ws = new (require('ws'))(`ws://127.0.0.1:${child.server.address().port}/${token}`)
    t.after(() => ws.terminate())
    const chunks: Buffer[] = []
    ws.on('message', (data: Buffer) => chunks.push(data))
    await once(ws, 'close')
    assert.deepEqual(Buffer.concat(chunks), bytes)
})
