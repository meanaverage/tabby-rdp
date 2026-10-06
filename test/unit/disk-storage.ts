// Benign local storage contract tests: small buffers and stubbed filesystem operations; no protocol/server input.
import { test, TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { DiskStorage, DownloadBudget, MAX_DOWNLOAD_BYTES, DISK_PATH } = require('../../dist/diskStorage.js')
const promises = require('fs').promises
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred () { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

function filesystem (t: TestContext) {
    const files = new Map<string, number[]>()
    const events: string[] = []
    const handles: { closed: boolean }[] = []
    let directories = 0
    const gates: { mkdir?: Promise<void>, open?: Promise<void>, write?: Promise<void>, failWrite?: boolean } = {}
    t.mock.method(promises, 'mkdtemp', async () => { await gates.mkdir; return `/private/tmp/trd-storage-stub-${++directories}` })
    t.mock.method(promises, 'open', async (file: string, flags: string, mode: number) => {
        assert.equal(flags, 'wx'); assert.equal(mode, 0o600)
        await gates.open
        files.set(file, [])
        const handle = { closed: false,
            appendFile: async (data: Uint8Array) => {
                events.push(`write ${data[0]}`)
                await gates.write
                if (gates.failWrite) { throw new Error('write failed') }
                assert.equal(handle.closed, false)
                files.get(file)!.push(...data)
                events.push(`wrote ${data[0]}`)
            },
            close: async () => { assert.equal(handle.closed, false); events.push('close'); handle.closed = true },
        }
        handles.push(handle)
        return handle
    })
    t.mock.method(promises, 'rm', async (file: string, options: { recursive?: boolean }) => {
        events.push(options.recursive ? 'remove directory' : 'remove file')
        for (const at of files.keys()) { if (at === file || options.recursive && at.startsWith(file + '/')) { files.delete(at) } }
    })
    return { files, events, handles, gates }
}

test('download storage validates expected sizes, accepts empty and supported large files without allocating them', async t => {
    const io = filesystem(t)
    const storage = new DiskStorage()
    for (const size of [-1, 1.5, NaN, Infinity, undefined, MAX_DOWNLOAD_BYTES + 1]) {
        await assert.rejects(storage.createWriteHandle('file', size), /expected size/)
    }
    assert.equal(io.handles.length, 0)
    const empty = await storage.createWriteHandle('empty', 0)
    const blob = await empty.finalize()
    assert.deepEqual(io.files.get(blob[DISK_PATH]), [])
    const large = await storage.createWriteHandle('large', MAX_DOWNLOAD_BYTES)
    assert.equal(large.bytesWritten, 0)
    await large.abort()
    await storage.dispose()
    assert.equal(io.files.size, 0)
    await assert.rejects(storage.createWriteHandle('late', 1), /closed/)
})

test('accepted chunks are copied and written in order; finalize waits and closes exactly once', async t => {
    const io = filesystem(t)
    const storage = new DiskStorage()
    const handle = await storage.createWriteHandle('ordered', 3)
    const gate = deferred(); io.gates.write = gate.promise
    const first = new Uint8Array([1, 2])
    const a = handle.write(first)
    first[0] = 99
    const b = handle.write(new Uint8Array([3]))
    const finalized = handle.finalize()
    assert.equal(handle.finalize(), finalized)
    await assert.rejects(handle.write(new Uint8Array([4])), /closed/)
    await turn()
    assert.deepEqual(io.events, ['write 1'])
    gate.resolve()
    await Promise.all([a, b])
    const blob = await finalized
    assert.deepEqual(io.files.get(blob[DISK_PATH]), [1, 2, 3])
    assert.deepEqual(io.events, ['write 1', 'wrote 1', 'write 3', 'wrote 3', 'close'])
    assert.equal(handle.bytesWritten, 3)
    await handle.abort()
    await assert.rejects(handle.finalize(), /cancelled/)
    await storage.dispose()
    assert.equal(io.files.size, 0)
})

test('sequential downloads may exceed the pending budget while keeping normal chunk writes intact', async t => {
    const io = filesystem(t)
    const size = 4 * 65536
    const storage = new DiskStorage({ pendingBytes: 65536, budget: new DownloadBudget(65536) })
    const handle = await storage.createWriteHandle('streamed', size)
    for (let i = 0; i < 4; i++) { await handle.write(new Uint8Array(65536).fill(i)) }
    const blob = await handle.finalize()
    assert.equal(handle.bytesWritten, size)
    assert.equal(io.files.get(blob[DISK_PATH])!.length, size)
    assert.equal(io.files.get(blob[DISK_PATH])![size - 1], 3)
    await storage.dispose()
})

test('expected bytes are reserved before I/O and a short final file is rejected', async t => {
    const io = filesystem(t)
    const storage = new DiskStorage()
    const handle = await storage.createWriteHandle('short', 3)
    await handle.write(new Uint8Array([1]))
    await assert.rejects(handle.finalize(), /before its expected size/)
    assert.equal(io.files.size, 0)
    const next = await storage.createWriteHandle('bounded', 2)
    const gate = deferred(); io.gates.write = gate.promise
    const accepted = next.write(new Uint8Array([1, 2]))
    const rejected = assert.rejects(accepted, /cancelled|expected size/)
    await turn()
    await assert.rejects(next.write(new Uint8Array([3])), /exceeds/)
    gate.resolve()
    await rejected
    await next.abort()
    assert.equal(io.files.size, 0)
    await storage.dispose()
})

test('small chunks consume task capacity and shared pending capacity spans storage instances', async t => {
    const io = filesystem(t)
    const budget = new DownloadBudget(2 * 65536)
    const a = new DiskStorage({ pendingBytes: 65536, budget })
    const b = new DiskStorage({ pendingBytes: 2 * 65536, budget })
    const x = await a.createWriteHandle('x', 10)
    const y = await b.createWriteHandle('y', 10)
    const gate = deferred(); io.gates.write = gate.promise
    const writes = [x.write(new Uint8Array([1])), y.write(new Uint8Array([2]))]
    const settled = Promise.allSettled(writes)
    await turn()
    await assert.rejects(x.write(new Uint8Array([3])), /Too much/)
    await assert.rejects(y.write(new Uint8Array([4])), /Too much/)
    assert.deepEqual(io.events, ['write 1', 'write 2'])
    gate.resolve()
    await settled
    await Promise.all([x.abort(), y.abort()])
    // Every reservation returned, including a partial reservation refused by the shared budget.
    const fresh = await b.createWriteHandle('fresh', 2)
    await Promise.all([fresh.write(new Uint8Array([5])), fresh.write(new Uint8Array([6]))])
    await fresh.finalize()
    await Promise.all([a.dispose(), b.dispose()])
})

test('abort cancels queued writes and finalization, then closes after the active write settles', async t => {
    const io = filesystem(t)
    const storage = new DiskStorage()
    const handle = await storage.createWriteHandle('cancel', 2)
    const gate = deferred(); io.gates.write = gate.promise
    const results = Promise.allSettled([handle.write(new Uint8Array([1])), handle.write(new Uint8Array([2])), handle.finalize()])
    await turn()
    const stopping = handle.abort()
    assert.equal(handle.abort(), stopping)
    await turn()
    assert.deepEqual(io.events, ['write 1'])
    gate.resolve()
    assert.ok((await results).every(result => result.status === 'rejected'))
    await stopping
    assert.deepEqual(io.events, ['write 1', 'wrote 1', 'close', 'remove file'])
    await assert.rejects(handle.write(new Uint8Array([3])), /closed/)
    await storage.dispose()
})

test('write failures and empty writes abort cleanly without admitting more work', async t => {
    const io = filesystem(t)
    const storage = new DiskStorage()
    const failed = await storage.createWriteHandle('failed', 1)
    io.gates.failWrite = true
    await assert.rejects(failed.write(new Uint8Array([1])), /write failed/)
    await failed.abort()
    const empty = await storage.createWriteHandle('empty-write', 1)
    await assert.rejects(empty.write(new Uint8Array()), /contain bytes/)
    await empty.abort()
    assert.equal(io.files.size, 0)
    await storage.dispose()
})

test('dispose invalidates pending initialization and writes, cleaning late native results', async t => {
    const io = filesystem(t)
    const storage = new DiskStorage()
    const gate = deferred(); io.gates.open = gate.promise
    const opening = assert.rejects(storage.createWriteHandle('late', 1), /cancelled/)
    await turn()
    const closing = storage.dispose()
    gate.resolve()
    await Promise.all([opening, closing])
    assert.equal(io.files.size, 0)
    assert.ok(io.handles.every(h => h.closed))
    assert.equal(io.events.at(-1), 'remove directory')
    const active = new DiskStorage()
    const handle = await active.createWriteHandle('active', 2)
    const writeGate = deferred(); io.gates.write = writeGate.promise
    const writes = Promise.allSettled([handle.write(new Uint8Array([1])), handle.write(new Uint8Array([2]))])
    await turn()
    const disposing = active.dispose()
    await assert.rejects(handle.write(new Uint8Array([3])), /closed/)
    writeGate.resolve()
    assert.ok((await writes).every(result => result.status === 'rejected'))
    await disposing
    assert.equal(io.files.size, 0)
    assert.ok(io.handles.every(h => h.closed))
})

test('storage initialization timeout cleans an eventual file handle and bounds concurrent opens', async t => {
    const io = filesystem(t)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const storage = new DiskStorage({ initTimeoutMs: 10 })
    const gate = deferred(); io.gates.open = gate.promise
    const opening = assert.rejects(storage.createWriteHandle('late', 1), /in time/)
    await turn()
    t.mock.timers.tick(10)
    await opening
    gate.resolve()
    await turn()
    assert.equal(io.files.size, 0)
    assert.ok(io.handles.every(h => h.closed))
    await storage.dispose()
    const many = new DiskStorage()
    const held = deferred(); io.gates.open = held.promise
    const pending = Array.from({ length: 32 }, () => many.createWriteHandle('one', 1))
    const results = Promise.allSettled(pending)
    await assert.rejects(many.createWriteHandle('extra', 1), /Too many/)
    const closing = many.dispose()
    held.resolve()
    await Promise.all([results, closing])
    assert.equal(io.files.size, 0)
})
