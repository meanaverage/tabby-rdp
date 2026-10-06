// Actual WASM/glue isolation, plus a deliberately tiny module with an unreachable instruction to test trap ownership.
// No server, decoder input or unpublished patch is involved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as path from 'node:path'
// @ts-ignore build script has no declaration file
import { makeFactory } from '../../scripts/make-ironrdp-factory.mjs'

const require = createRequire(import.meta.url)
const { IronRDPLoader } = require('../../dist/ironrdp.js')
const root = path.resolve(import.meta.dirname, '../..')
const loadFactory = () => import(pathToFileURL(path.join(root, 'vendor/ironrdp-factory.js')).href)
// Logging's browser global; no DOM is needed to initialize the backend.
;(globalThis as any).window = globalThis

test('the generated factory is reproducible from the public bundle', () => {
    assert.equal(fs.readFileSync(path.join(root, 'vendor/ironrdp-factory.js'), 'utf8'),
        makeFactory(fs.readFileSync(path.join(root, 'vendor/iron-remote-desktop-rdp.js'), 'utf8')))
    assert.throws(() => makeFactory('import other from "./other.js"; export { other };'), /standalone/)
})

test('real IronRDP backends have separate classes, heap data and growing memories', async () => {
    const { createBackend } = await loadFactory()
    const module = await WebAssembly.compile(fs.readFileSync(path.join(root, 'vendor/ironrdp_web_bg.wasm')))
    const [a, b] = await Promise.all([createBackend(module, 'ERROR'), createBackend(module, 'ERROR')])
    assert.notEqual(a.Backend.DesktopSize, b.Backend.DesktopSize)
    assert.notEqual(a.runtime.memory, b.runtime.memory)
    const first = new a.Backend.ClipboardData()
    const second = new b.Backend.ClipboardData()
    first.addText('text/plain', 'first desktop only')
    assert.equal(first.isEmpty(), false)
    assert.equal(second.isEmpty(), true)
    const bytes = b.runtime.memory.buffer.byteLength
    a.runtime.memory.grow(1)
    assert.equal(b.runtime.memory.buffer.byteLength, bytes)
    // wasm-bindgen refreshes only the growing instance's cached views; both remain usable.
    const left = new a.Backend.DesktopSize(640, 480)
    const right = new b.Backend.DesktopSize(800, 600)
    assert.deepEqual([left.width, left.height, right.width, right.height], [640, 480, 800, 600])
    first.free(); second.free(); left.free(); right.free()
})

// (module (memory (export "memory") 1) (func (export "trap") (result i32) unreachable)
//         (func (export "value") (result i32) i32.const 7))
const TRAP_MODULE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 0, 1, 127,
    3, 3, 2, 0, 0,
    5, 3, 1, 0, 1,
    7, 25, 3, 6, 109, 101, 109, 111, 114, 121, 2, 0, 4, 116, 114, 97, 112, 0, 0, 5, 118, 97, 108, 117, 101, 0, 1,
    10, 10, 2, 3, 0, 0, 11, 4, 0, 65, 7, 11,
])
const TRAP_GLUE = `
let wasm;
async function init (level, module) { const instance = await WebAssembly.instantiate(module); wasm = instance.exports; }
const Backend = { trap: () => wasm.trap(), value: () => wasm.value() };
export { init, Backend };
`

test('a WASM trap belongs to one backend; healthy and replacement backends keep working', async () => {
    const factory = await import(`data:text/javascript,${encodeURIComponent(makeFactory(TRAP_GLUE))}`)
    const module = await WebAssembly.compile(TRAP_MODULE)
    let loads = 0
    const loader = new IronRDPLoader(async () => { loads++; return { module, createBackend: factory.createBackend } })
    const [a, b] = await Promise.all([loader.create('ERROR'), loader.create('ERROR')])
    let aTraps = 0
    let bTraps = 0
    a.runtime.onTrap(() => aTraps++)
    const stop = b.runtime.onTrap(() => bTraps++)
    assert.throws(() => a.Backend.trap(), WebAssembly.RuntimeError)
    assert.equal(aTraps, 1)
    assert.throws(() => a.Backend.value(), WebAssembly.RuntimeError)
    assert.equal(aTraps, 1)
    assert.equal(bTraps, 0)
    assert.equal(b.Backend.value(), 7)
    const replacement = await loader.create('ERROR')
    assert.equal(replacement.Backend.value(), 7)
    assert.notEqual(replacement.runtime.memory, a.runtime.memory)
    assert.equal(loads, 1)
    stop()
    assert.throws(() => b.Backend.trap(), WebAssembly.RuntimeError)
    assert.equal(bTraps, 0)
})

test('trapped and disposed backends cancel their own browser timers and event listeners', async () => {
    const glue = TRAP_GLUE.replace('const Backend = {', `const Backend = {
        arm: (target, callback) => {
            setInterval(callback, 1);
            setTimeout(callback, 10);
            target.addEventListener('tick', callback);
        },`)
    const factory = await import(`data:text/javascript,${encodeURIComponent(makeFactory(glue))}`)
    const module = await WebAssembly.compile(TRAP_MODULE)
    const [a, b] = await Promise.all([factory.createBackend(module), factory.createBackend(module)])
    const target = new EventTarget()
    let left = 0, right = 0
    try {
        a.Backend.arm(target, () => left++)
        b.Backend.arm(target, () => right++)
        assert.throws(() => a.Backend.trap(), WebAssembly.RuntimeError)
        target.dispatchEvent(new Event('tick'))
        assert.equal(left, 0)
        assert.equal(right, 1)
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(left, 0)
        assert.ok(right > 1)
        b.runtime.dispose()
        const stopped = right
        target.dispatchEvent(new Event('tick'))
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(right, stopped)
        // Late callbacks cannot install new browser roots in an ended backend.
        b.Backend.arm(target, () => right++)
        target.dispatchEvent(new Event('tick'))
        assert.equal(right, stopped)
    } finally {
        a.runtime.dispose(); b.runtime.dispose()
    }
})

test('a load failure can retry, while a failed instance keeps the compiled module for other desktops', async () => {
    let loads = 0
    let creates = 0
    const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    const loader = new IronRDPLoader(async () => {
        if (++loads === 1) throw new Error('load failed')
        return { module, createBackend: async (m: WebAssembly.Module) => {
            assert.equal(m, module)
            if (++creates === 1) throw new WebAssembly.RuntimeError('instance failed')
            return { instance: creates }
        } }
    })
    await assert.rejects(loader.create('ERROR'), /load failed/)
    await assert.rejects(loader.create('ERROR'), /instance failed/)
    assert.deepEqual(await loader.create('ERROR'), { instance: 2 })
    assert.equal(loads, 2)
})
