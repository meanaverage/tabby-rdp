// Idle backend instances, using the real vendored WASM. This measures initialization, not connected desktops or GPUs.
// node --expose-gc scripts/bench-ironrdp-instances.mjs [output.json]
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { createBackend } from '../vendor/ironrdp-factory.js'

if (!globalThis.gc) throw new Error('run with node --expose-gc')
globalThis.window = globalThis
const bytes = await readFile(new URL('../vendor/ironrdp_web_bg.wasm', import.meta.url))
const began = performance.now()
const module = await WebAssembly.compile(bytes)
const compileMs = performance.now() - began
const collect = async () => { for (let i = 0; i < 8; i++) { await setImmediate(); globalThis.gc() } }
await collect()
const baseline = process.memoryUsage()
const live = []
const samples = []
for (let count = 1; count <= 8; count++) {
    const start = performance.now()
    live.push(await createBackend(module, 'ERROR'))
    const initMs = performance.now() - start
    await collect()
    const usage = process.memoryUsage()
    samples.push({ count, linearBytes: live.reduce((sum, backend) => sum + backend.runtime.memory.buffer.byteLength, 0),
        heapDeltaBytes: usage.heapUsed - baseline.heapUsed, rssDeltaBytes: usage.rss - baseline.rss, initMs })
}
const oldMemories = live.map(backend => new WeakRef(backend.runtime.memory))
live.length = 0
await collect()
const retainedAfterFirstBatch = oldMemories.filter(ref => ref.deref() !== undefined).length
const cycles = []
for (let count = 0; count < 32; count++) {
    // Scope the strong reference to this helper, including its constructor/finalizer classes.
    cycles.push(await (async () => {
        const backend = await createBackend(module, 'ERROR')
        const size = new backend.Backend.DesktopSize(800, 600)
        size.free()
        return new WeakRef(backend.runtime.memory)
    })())
}
await collect()
const retainedAfterCycles = cycles.filter(ref => ref.deref() !== undefined).length
const result = {
    measured: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    mode: 'idle initialized backends; no network, desktop framebuffer, audio or VideoDecoder',
    wasmSha256: createHash('sha256').update(bytes).digest('hex'), compileMs, samples,
    collection: { firstBatch: 8, retainedAfterFirstBatch, cycles: 32, retainedAfterCycles },
}
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + '\n')
console.table(samples.map(sample => ({ instances: sample.count, linearMiB: sample.linearBytes / 1048576,
    heapDeltaMiB: +(sample.heapDeltaBytes / 1048576).toFixed(2), initMs: +sample.initMs.toFixed(2) })))
console.log(result.collection)
if (retainedAfterFirstBatch || retainedAfterCycles) process.exitCode = 1
