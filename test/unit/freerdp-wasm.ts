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
