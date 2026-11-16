import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { encodeFileList, decodeFileList, freeRDPFileProvider } = require('../../dist/freerdpFiles.js')
const { numbers, ipcFrame, FreeRDPFrames } = require('../../dist/freerdp.js')
const { FreeRDPClipboard } = require('../../dist/freerdpClipboard.js')

const entries = [
    { name: 'folder', size: 0, isDirectory: true },
    { name: '你好.txt', path: 'folder', size: 5, isDirectory: false },
    { name: 'empty', size: 0, isDirectory: false },
]

test('file descriptors preserve folder indices, Unicode names and zero-length files', () => {
    const bytes = encodeFileList(entries)
    assert.equal(bytes.length, 4 + entries.length * 592)
    assert.equal(bytes.readUInt32LE(4), 0x44)
    assert.equal(bytes.readUInt32LE(4 + 36), 0x10)
    assert.deepEqual(decodeFileList(bytes), entries.map(e => ({ path: undefined, ...e })))
    assert.equal(decodeFileList(encodeFileList([{ name: 'large.bin', size: 0xffffffff }]))[0].size, 0xffffffff)
})

test('malformed descriptor lengths, unsafe paths, oversized names and unsupported sizes are refused', () => {
    for (const name of ['../secret', '..\\secret', 'C:\\secret', '\\share\\secret', 'folder\\..\\secret', 'a\0b', 'x'.repeat(260)]) {
        assert.throws(() => encodeFileList([{ name, size: 1 }]), name)
    }
    for (const size of [-1, NaN, 2 ** 32, 1.2]) assert.throws(() => encodeFileList([{ name: 'x', size }]))
    const valid = encodeFileList(entries)
    for (const data of [valid.subarray(1), valid.subarray(0, -1), Buffer.concat([valid, Buffer.alloc(1)])]) assert.throws(() => decodeFileList(data))
    const malicious = encodeFileList([{ name: 'normal', size: 1 }])
    malicious.fill(0, 76); malicious.write('..\\secret', 76, 'utf16le')
    assert.throws(() => decodeFileList(malicious))
    malicious.fill(65, 76)
    assert.throws(() => decodeFileList(malicious))
})

test('file IPC accepts bounded large ranges without relaxing text limits', () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 7), received: Buffer[] = []
    const frame = ipcFrame('s', data), parser = new FreeRDPFrames()
    for (let i = 0; i < frame.length; i += 7777) parser.push(frame.subarray(i, i + 7777), (_type: string, bytes: Buffer) => received.push(bytes))
    assert.deepEqual(received, [data])
    assert.throws(() => ipcFrame('T', data))
    assert.throws(() => ipcFrame('s', Buffer.alloc(16 * 1024 * 1024 + 13)))
    const header = Buffer.alloc(5); header[0] = 's'.charCodeAt(0); header.writeUInt32BE(0xffffffff, 1)
    assert.throws(() => new FreeRDPFrames().push(header, () => assert.fail()))
})

;(globalThis as any).FileReader = class {
    result: ArrayBuffer | null = null
    onload?: () => void
    readAsArrayBuffer (blob: Blob) { blob.arrayBuffer().then(data => { this.result = data; this.onload?.() }) }
    abort () { }
}

async function fixture (t: any) {
    // Deliberately do not initialise the vendor WASM: FreeRDP uses only the JS provider.
    const { RdpFileTransferProvider } = await import(pathToFileURL(resolve('vendor/iron-remote-desktop-rdp.js')).href)
    const sent: { type: string, data: Buffer }[] = []
    const ways = { toRemote: true, fromRemote: true }
    const Provider = freeRDPFileProvider(RdpFileTransferProvider, (type: string, data: Buffer) => sent.push({ type, data }), () => ways, () => {})
    const provider = new Provider({ storageBackend: 'blob' })
    provider.on('error', () => {})
    t.after(() => provider.dispose())
    return { provider, sent, ways }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('real JS provider uploads file contents and handles repeat pastes without IronRDP WASM', async t => {
    const { provider, sent } = await fixture(t)
    const upload = provider.uploadFiles([{ file: new Blob(['hello']), name: 'hello.txt', size: 5, lastModified: 0 }])
    assert.equal(sent[0].type, 'o')
    const generation = sent[0].data.readUInt32BE(0)
    provider.receive('a', Buffer.concat([numbers(generation), Buffer.from([1])]))
    provider.receive('q', numbers(generation, 41, 0, 1, 0, 0, 8))
    assert.equal(sent.at(-1)!.data.readBigUInt64LE(12), 5n)
    provider.receive('q', numbers(generation, 42, 0, 2, 0, 0, 5))
    await upload.completion
    assert.equal(sent.at(-1)!.data.subarray(12).toString(), 'hello')
    provider.receive('q', numbers(generation, 43, 0, 2, 1, 0, 4))
    await settle()
    assert.equal(sent.at(-1)!.data.subarray(12).toString(), 'ello')
})

test('remote file downloads complete through SIZE and RANGE; clipboard replacement cancels old streams', async t => {
    const { provider, sent } = await fixture(t)
    provider.receive('l', numbers(1))
    provider.receive('f', Buffer.concat([numbers(1), encodeFileList([{ name: 'x.txt', size: 5 }])]))
    const download = provider.downloadFile(provider.availableFiles[0], 0)
    const stream = download.transferId
    const size = Buffer.alloc(8); size.writeBigUInt64LE(5n)
    provider.receive('s', Buffer.concat([numbers(stream, 0), size]))
    await settle()
    assert.equal(sent.at(-1)!.data.readUInt32BE(12), 2)
    provider.receive('s', Buffer.concat([numbers(stream, 0), Buffer.from('hello')]))
    assert.equal(await (await download.completion).text(), 'hello')
    const oldFile = provider.availableFiles[0]
    const cancelled = provider.downloadFile(oldFile, 0)
    const rejected = assert.rejects(cancelled.completion, /failed to provide/)
    provider.receive('l', numbers(2))
    await rejected
    provider.receive('f', Buffer.concat([numbers(1), encodeFileList(entries)]))
    assert.deepEqual(provider.availableFiles, [])
    provider.receive('f', Buffer.concat([numbers(2), encodeFileList([{ name: 'new.txt', size: 3 }])]))
    assert.throws(() => provider.downloadFile(oldFile, 0), /clipboard changed/)
    // An asynchronous disk write from the old transfer must not restart it against the new clipboard.
    assert.throws(() => provider.sendRequestFileContents(cancelled.transferId, 0, 2, 0, 3), /clipboard changed/)
})

test('permissions and stale upload generations prevent file data from being returned', async t => {
    const { provider, sent, ways } = await fixture(t)
    const upload = provider.uploadFiles([{ file: new Blob(['secret']), name: 'x', size: 6 }])
    upload.completion.catch(() => {})
    provider.receive('q', numbers(0, 1, 0, 2, 0, 0, 6))
    assert.equal(sent.at(-1)!.data.readUInt32BE(8), 1)
    ways.toRemote = false
    provider.receive('q', numbers(1, 2, 0, 2, 0, 0, 6))
    assert.equal(sent.at(-1)!.data.length, 12)
    assert.equal(sent.at(-1)!.data.readUInt32BE(8), 1)
    ways.fromRemote = false
    provider.receive('l', numbers(1))
    provider.receive('f', Buffer.concat([numbers(1), encodeFileList(entries)]))
    assert.deepEqual(provider.availableFiles, [])
})

test('text polling leaves an offered file list intact and resumes for newly copied text', () => {
    let local = 'before', files = false
    const sent: string[] = []
    const clipboard = new FreeRDPClipboard({ read: () => local, write: () => {}, send: (s: string) => sent.push(s), narrow: () => {} },
        () => ({ toRemote: true, fromRemote: true }), { focused: () => true, viewOnly: () => false })
    clipboard.filesPending = () => files
    clipboard.localFiles(); files = true
    clipboard.poll(); local = 'after'; clipboard.poll()
    assert.deepEqual(sent, [])
    files = false; clipboard.poll()
    assert.deepEqual(sent, ['after'])
})

test('file acknowledgements ignore a replaced local offer', async t => {
    const { provider } = await fixture(t)
    const answered: boolean[] = []
    provider.handleFormatListResponse = (ok: boolean) => answered.push(ok)
    provider.sendInitiateFileCopy(entries)
    provider.sendInitiateFileCopy(entries)
    provider.receive('a', Buffer.concat([numbers(1), Buffer.from([0])]))
    assert.deepEqual(answered, [])
    provider.receive('a', Buffer.concat([numbers(2), Buffer.from([1])]))
    assert.deepEqual(answered, [true])
})

test('replacing an upload fails abandoned requests and permits reusing their streams', async t => {
    const { provider, sent } = await fixture(t)
    provider.handleFileContentsRequest = () => {} // A disk read that never answered.
    provider.sendInitiateFileCopy(entries)
    provider.receive('q', numbers(1, 12, 0, 2, 0, 0, 5))
    provider.sendInitiateFileCopy(entries)
    assert.equal(sent.at(-2)!.type, 's')
    assert.deepEqual(sent.at(-2)!.data, numbers(1, 12, 1))
    const before = sent.length
    provider.receive('q', numbers(2, 12, 0, 2, 0, 0, 5))
    assert.equal(sent.length, before)
    provider.sendSubmitFileContents(12, false, Buffer.from('new'))
    assert.deepEqual(sent.at(-1)!.data, Buffer.concat([numbers(2, 12, 0), Buffer.from('new')]))
})
