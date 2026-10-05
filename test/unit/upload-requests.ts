// What the remote can ask for of the files offered to it from here (src/fileTransfer.ts, FileTransfer): parts of a
// bounded size, whether the files were pasted, dropped or picked, an error rather than a short answer or none at all,
// and no more read at once than MAX_IN_FLIGHT; and ⌘V with nothing to send. Driven through IronRDP's own
// RdpFileTransferProvider (vendor/iron-remote-desktop-rdp.js, its WebAssembly initialised), with stand-ins for the
// desktop layer, the page's document, the browser's FileReader and Electron's clipboard, as in clipboard-files.ts.
// Runs against the built plugin: npm run build && npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))

/** Electron's clipboard as the plugin's `require('electron')` gets it: files copied, as Finder or Files has them. */
const electron = {
    copied: [] as string[],
    /** What a format holds as it is, over what `copied` makes of it (a name that isn't one, say). */
    raw: {} as Record<string, string>,
    clipboard: {
        read: (format: string) => format in electron.raw ? electron.raw[format] : !electron.copied.length ? ''
            : format === 'NSFilenamesPboardType' ? `<plist><array>${electron.copied.map(p => `<string>${p}</string>`).join('')}</array></plist>`
                : format === 'x-special/gnome-copied-files' ? ['copy', ...electron.copied.map(p => pathToFileURL(p).href)].join('\n') : '',
        readBuffer: () => Buffer.alloc(0),
    },
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request === 'electron' ? electron : load.call(this, request, ...rest)
}

/** An element, as far as the messages over the desktop use one. */
class FakeElement {
    className = ''
    textContent = ''
    title = ''
    readonly children: FakeElement[] = []
    append (...nodes: FakeElement[]) { this.children.push(...nodes) }
    addEventListener () { }
    remove () { }
}
;(globalThis as any).document = { createElement: () => new FakeElement() }

/**
 * The browser's FileReader, as the provider reads what it hands out with it; how many are reading at once, and how
 * much. `hang`: how many of the next reads wait until a test lets them finish (`held`), or the provider aborts them.
 */
const readers = { now: 0, most: 0, bytes: 0, mostBytes: 0, hang: 0, held: [] as (() => void)[] }
;(globalThis as any).FileReader = class {
    result: ArrayBuffer | null = null
    error: unknown = null
    onload?: () => void
    onerror?: () => void
    private hung: (() => void) | null = null
    readAsArrayBuffer (blob: Blob) {
        readers.most = Math.max(readers.most, ++readers.now)
        readers.mostBytes = Math.max(readers.mostBytes, readers.bytes += blob.size)
        const done = () => { readers.now--; readers.bytes -= blob.size }
        const finish = () => blob.arrayBuffer().then(b => { done(); this.result = b; this.onload?.() }, e => { done(); this.error = e; this.onerror?.() })
        if (readers.hang > 0) {
            readers.hang--
            const release = () => {
                readers.held.splice(readers.held.indexOf(release), 1)
                this.hung = null
                finish()
            }
            this.hung = () => {
                readers.held.splice(readers.held.indexOf(release), 1)
                done()
            }
            readers.held.push(release)
            return
        }
        finish()
    }
    abort () {
        this.hung?.()
        this.hung = null
    }
}

const { FileTransfer, entriesFor, MAX_RANGE, MAX_IN_FLIGHT, MAX_WAITING, MIN_COST } = require('../../dist/fileTransfer.js')
import { Link } from './support/link.js'
let rdp: any

before(async () => {
    rdp = await import(pathToFileURL(root + 'vendor/iron-remote-desktop-rdp.js').href)
    await rdp.init('ERROR', fs.readFileSync(root + 'vendor/ironrdp_web_bg.wasm'))
})

/** Lets the provider's reads and the promises after them run. */
const settle = async (rounds = 10) => {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setImmediate(resolve))
    }
}

/**
 * Lets them run until `done`, for ten seconds at most (pasted files are read on Node's thread pool). By the clock that
 * tests mocking Date don't move.
 */
async function until (done: () => boolean): Promise<void> {
    for (const end = performance.now() + 10000; !done() && performance.now() < end;) {
        await settle(1)
    }
    assert.ok(done(), 'still waiting')
}

const MB = 1024 * 1024

/** Folders the tests made, removed when they are done (some hold files of tens of megabytes). */
const made: string[] = []
after(() => made.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

/** A new folder of the tests' own. */
const folder = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trd-requests-')))
    made.push(dir)
    return dir
}

/** The room in the connection, as FileTransfer asks the desktop's proxy for it (see ServerFlow). */
interface Flow {
    room (): boolean
    spend (bytes: number): void
    refund (bytes: number): void
    whenRoom (): Promise<void>
}

/**
 * A FileTransfer over a stand-in desktop layer, its provider on a stand-in session, with the clipboard going the ways
 * `ways` says (both, unless a test narrows them), and the room in the connection `flow` gives (none asked for without
 * one): what it showed and logged, what it handed the remote, and the remote's requests for what it was offered.
 * `link`: where each answer goes (see Link); `keep`: whether what it answered is kept too, or only how long each answer
 * was, for tests that hand out gigabytes.
 */
function transfer (ways = { toRemote: true, fromRemote: true }, flow?: Flow, link?: Link, keep = !link) {
    const shown: string[] = []
    const layer = {
        addEventListener () { },
        removeEventListener () { },
        contains: () => false,
        classList: { add () { }, remove () { }, toggle () { } },
        appendChild: (el: FakeElement) => { shown.push(el.children[0]?.textContent ?? '') },
    }
    const log: string[] = []
    const files = new FileTransfer(rdp, layer, (m: string) => log.push(m), () => ways, flow)
    const provider = files.provider
    provider.setSession({ invokeExtension () { } })
    // What reaches the connection, each answer under the remote's number for its request (the provider answers under a
    // number of the plugin's own, which FileTransfer maps back: see its constructor).
    const handedOut: { streamId: number, isError: boolean, data: Uint8Array, length: number }[] = []
    const submit = files.submit.bind(files)
    files.submit = (streamId: number, isError: boolean, data: Uint8Array) => {
        handedOut.push({ streamId, isError, data: keep ? new Uint8Array(data) : new Uint8Array(), length: data.length })
        if (link && !isError) {
            link.hand(data.length)
        }
        submit(streamId, isError, data)
    }
    let streams = 0
    return {
        files, provider, shown, log, handedOut,
        /** The remote asks for `size` bytes of the file at `index` from `position`; the stream it asked on. */
        ask (position: number, size: number, index = 0) {
            const streamId = ++streams
            provider.handleFileContentsRequest({ streamId, index, flags: rdp.FileContentsFlags.RANGE, position, size })
            return streamId
        },
        /** The answer on a stream, once it has come. */
        async answer (streamId: number) {
            await until(() => handedOut.some(a => a.streamId === streamId))
            return handedOut.find(a => a.streamId === streamId)!
        },
        /** The whole file at `index` as a remote reads it: a part of `chunk` bytes at a time, until a short one. */
        async readAll (chunk: number, index = 0) {
            const parts: Uint8Array[] = []
            for (let at = 0; ; ) {
                const answer = await this.answer(this.ask(at, chunk, index))
                assert.equal(answer.isError, false)
                parts.push(answer.data)
                at += answer.data.length
                if (answer.data.length < chunk) {
                    return Buffer.concat(parts)
                }
            }
        },
    }
}

/** A file of `size` bytes with something different in each part of it, on disk. */
function onDisk (size: number): { file: string, bytes: Buffer } {
    const dir = folder()
    const bytes = Buffer.alloc(size)
    for (let i = 0; i < size; i += 4096) {
        bytes.writeUInt32LE(i, i)
    }
    const file = path.join(dir, 'big.bin')
    fs.writeFileSync(file, bytes)
    return { file, bytes }
}

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

test('files dropped or picked are sent a bounded part at a time, as pasted ones are: asked for more, an error', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { bytes } = onDisk(MAX_RANGE + 10)
    for (const how of ['picked', 'dropped']) {
        const c = transfer()
        try {
            const file = new File([new Uint8Array(bytes)], 'big.bin')
            // The picker hands over Files; a drop, entries holding them.
            c.files.send(how === 'picked' ? [file] : [{ file, name: 'big.bin', size: file.size, lastModified: file.lastModified }])
            const whole = await c.answer(c.ask(0, 0xFFFFFFFF))
            assert.deepEqual([whole.isError, whole.data.length], [true, 0], how)
            assert.equal(c.shown.at(-1), 'Copying to the remote desktop failed: the remote desktop asked for 17 MB of big.bin at once, more than the 16 MB a request gets')
            const part = await c.answer(c.ask(10, MAX_RANGE))
            assert.deepEqual([part.isError, hash(part.data)], [false, hash(bytes.subarray(10, 10 + MAX_RANGE))], how)
            const end = await c.answer(c.ask(MAX_RANGE, 0xFFFFFFFF))
            assert.deepEqual([end.isError, end.data.length], [false, 10], how)
        } finally {
            c.files.dispose()
        }
    }
})

test('a remote reading a file in the parts its reads take gets all of it, past 16 MB, pasted or picked', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file, bytes } = onDisk(2 * MAX_RANGE + 12345)
    for (const how of ['pasted', 'picked']) {
        for (const chunk of [MB, MAX_RANGE]) {
            const c = transfer()
            try {
                c.files.send(how === 'pasted' ? entriesFor([file]).entries : [new File([new Uint8Array(bytes)], 'big.bin')], how === 'pasted')
                assert.equal(hash(await c.readAll(chunk)), hash(bytes), `${how}, ${chunk / MB} MB at a time`)
            } finally {
                c.files.dispose()
            }
        }
    }
})

test('a pasted file that can\'t be read when the remote asks gets it an error, not silence', { skip: process.platform === 'win32' }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file } = onDisk(100)
    const c = transfer()
    try {
        c.files.send(entriesFor([file]).entries, true)
        fs.writeFileSync(`${file}.new`, 'another file')
        fs.renameSync(`${file}.new`, file)
        for (let i = 0; i < 3; i++) {
            const answer = await c.answer(c.ask(0, 100))
            assert.deepEqual([answer.isError, answer.data.length], [true, 0])
        }
        // Said once, however often it asks.
        assert.deepEqual(c.shown.filter(s => /replaced/.test(s)), ['Copying to the remote desktop failed: big.bin was replaced after it was offered'])
        assert.equal(c.log.filter(l => /replaced/.test(l)).length, 1)
    } finally {
        c.files.dispose()
    }
})

test('many requests at once: no more than MAX_IN_FLIGHT read at a time, the others in turn, all answered', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file, bytes } = onDisk(4 * MAX_RANGE)
    const c = transfer()
    try {
        c.files.send(entriesFor([file]).entries, true)
        readers.most = 0
        // Each part three times over, asked for all at once.
        const asked = Array.from({ length: 12 }, (_, i) => ({ at: (i % 4) * MAX_RANGE, stream: c.ask((i % 4) * MAX_RANGE, MAX_RANGE) }))
        assert.ok(readers.most <= MAX_IN_FLIGHT / MAX_RANGE, `${readers.most} read at once`)
        for (const { at, stream } of asked) {
            const answer = await c.answer(stream)
            assert.deepEqual([answer.isError, hash(answer.data)], [false, hash(bytes.subarray(at, at + MAX_RANGE))])
        }
        assert.ok(readers.most <= MAX_IN_FLIGHT / MAX_RANGE, `${readers.most} read at once`)
    } finally {
        c.files.dispose()
    }
})

test('a pasted file\'s parts are read off Tabby\'s window, one at a time, however many the remote asks for at once', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file, bytes } = onDisk(4 * MAX_RANGE)
    const c = transfer()
    const nodeFs = require('fs')
    const { readSync, openSync } = nodeFs
    const open = nodeFs.promises.open
    try {
        c.files.send(entriesFor([file]).entries, true)
        // Reads in the window, and the file open on the thread pool at once.
        let inWindow = 0
        let now = 0
        let most = 0
        nodeFs.readSync = (...args: unknown[]) => { inWindow++; return readSync(...args) }
        nodeFs.openSync = (...args: unknown[]) => { inWindow++; return openSync(...args) }
        nodeFs.promises.open = async (p: string, ...rest: unknown[]) => {
            const handle = await open(p, ...rest)
            if (p === file) {
                most = Math.max(most, ++now)
                const close = handle.close.bind(handle)
                handle.close = () => { now--; return close() }
            }
            return handle
        }
        const asked = Array.from({ length: 8 }, (_, i) => ({ at: (i % 4) * MAX_RANGE, stream: c.ask((i % 4) * MAX_RANGE, MAX_RANGE) }))
        for (const { at, stream } of asked) {
            const answer = await c.answer(stream)
            assert.deepEqual([answer.isError, hash(answer.data)], [false, hash(bytes.subarray(at, at + MAX_RANGE))])
        }
        assert.equal(inWindow, 0, 'read in the window')
        assert.equal(most, 1, 'read at once')
    } finally {
        Object.assign(nodeFs, { readSync, openSync })
        nodeFs.promises.open = open
        c.files.dispose()
    }
})

test('a pasted file cut short since it was offered gets the remote an error for what is gone, not a short answer', { skip: process.platform === 'win32' }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file, bytes } = onDisk(MB)
    const c = transfer()
    try {
        c.files.send(entriesFor([file]).entries, true)
        fs.truncateSync(file, MB / 2)
        const whole = await c.answer(c.ask(0, MB))
        assert.deepEqual([whole.isError, whole.data.length], [true, 0])
        assert.equal(c.shown.at(-1), 'Copying to the remote desktop failed: big.bin is shorter than when it was offered')
        // What is still there of it is sent as before.
        const half = await c.answer(c.ask(0, MB / 2))
        assert.deepEqual([half.isError, hash(half.data)], [false, hash(bytes.subarray(0, MB / 2))])
    } finally {
        c.files.dispose()
    }
})

test('more requests waiting than MAX_WAITING get errors, requests for nothing count too, and a new offer answers those still waiting', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file } = onDisk(1000)
    const c = transfer()
    try {
        c.files.send(entriesFor([file]).entries, true)
        // Each counts as the most a part can be until it is read: four are read at once, the rest wait.
        const reading = MAX_IN_FLIGHT / MAX_RANGE
        const streams = Array.from({ length: reading + MAX_WAITING + 3 }, () => c.ask(0, MAX_RANGE))
        // Answered at once: the three there was no room for.
        assert.deepEqual(c.handedOut.map(a => [a.streamId, a.isError]), streams.slice(-3).map(s => [s, true]))
        await until(() => c.handedOut.length === streams.length)
        assert.equal(c.handedOut.filter(a => !a.isError).length, reading + MAX_WAITING)

        // Requests for nothing at all count as some, else any number of them could be under way at once.
        const empty = MAX_IN_FLIGHT / MIN_COST + MAX_WAITING
        const none = Array.from({ length: empty + 5 }, () => c.ask(0, 0))
        assert.deepEqual(c.handedOut.slice(streams.length).map(a => [a.streamId, a.isError]), none.slice(-5).map(s => [s, true]))
        await until(() => c.handedOut.length === streams.length + none.length)
        assert.deepEqual(c.handedOut.slice(-empty).map(a => [a.isError, a.data.length]), Array(empty).fill([false, 0]))

        // Waiting when the next files are offered: they were for the last ones.
        const before = c.handedOut.length
        const waiting = Array.from({ length: reading + 6 }, () => c.ask(0, MAX_RANGE))
        c.files.send(entriesFor([file]).entries, true)
        const refused = c.handedOut.slice(before).filter(a => a.isError).map(a => a.streamId)
        assert.deepEqual(refused, waiting.slice(reading))
    } finally {
        c.files.dispose()
    }
})

test('narrowed while connected: the requests waiting for their turn get errors at once, and those being read once read', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file } = onDisk(1000)
    const ways = { toRemote: true, fromRemote: true }
    const c = transfer(ways)
    try {
        c.files.send(entriesFor([file]).entries, true)
        const reading = MAX_IN_FLIGHT / MAX_RANGE
        const streams = Array.from({ length: reading + 6 }, () => c.ask(0, MAX_RANGE))
        assert.equal(c.handedOut.length, 0)
        // The settings narrow (see RemoteDesktopService.applyClipboard), and the files offered are taken back: the
        // requests waiting were for them, and don't wait for the parts being read.
        ways.toRemote = false
        c.files.revoke()
        assert.deepEqual(c.handedOut.map(a => [a.streamId, a.isError]), streams.slice(reading).map(s => [s, true]))
        await until(() => c.handedOut.length === streams.length)
        assert.deepEqual(c.handedOut.filter(a => !a.isError), [])
    } finally {
        c.files.dispose()
    }
})

test('⌘V with copied folders that hold only links to outside them sends nothing, and pastes nothing', { skip: process.platform === 'win32' }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const home = folder()
    fs.mkdirSync(path.join(home, '.ssh'))
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
    fs.mkdirSync(path.join(home, 'report'))
    fs.symlinkSync('../.ssh', path.join(home, 'report', 'attachments'))
    const c = transfer()
    try {
        let offered = 0
        c.provider.uploadFiles = () => { offered++; return { transferIds: new Map(), completion: new Promise(() => { }) } }
        electron.copied = [path.join(home, 'report')]
        // Taken (the keys don't go to the remote, which would paste what it had), with nothing to paste.
        assert.equal(c.files.pasteClipboardFiles(), true)
        assert.equal(await c.files.offerAnswered(), false)
        assert.equal(offered, 0)
        assert.equal(c.shown.at(-1), 'Nothing to send\nLeft out: 1 link to outside the copied folder')
        // A folder with files besides goes, and says what was left out.
        fs.writeFileSync(path.join(home, 'report', 'notes.txt'), 'notes')
        assert.equal(c.files.pasteClipboardFiles(), true)
        assert.equal(offered, 1)
        assert.equal(c.shown.at(-1), 'Pasting 1 file…\nLeft out: 1 link to outside the copied folder')
    } finally {
        electron.copied = []
        c.files.dispose()
    }
})

test('⌘V with copied files that are gone, links that lead nowhere, pipes or an empty folder sends nothing, and pastes nothing', { skip: process.platform === 'win32' }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const home = folder()
    fs.mkdirSync(path.join(home, 'empty'))
    fs.symlinkSync('nowhere', path.join(home, 'dangling'))
    const pipe = path.join(home, 'pipe')
    const piped = (() => { try { require('node:child_process').execFileSync('mkfifo', [pipe]); return true } catch { return false } })()
    const c = transfer()
    try {
        let offered = 0
        c.provider.uploadFiles = () => { offered++; return { transferIds: new Map(), completion: new Promise(() => { }) } }
        const copies = [['gone.txt'], ['empty'], ['dangling'], ['gone.txt', 'empty', 'dangling'], ...piped ? [['pipe']] : []]
        for (const names of copies) {
            electron.copied = names.map(name => path.join(home, name))
            // Taken (the keys don't go to the remote, which would paste what it had), with nothing to paste.
            assert.equal(c.files.pasteClipboardFiles(), true, names.join())
            assert.equal(await c.files.offerAnswered(), false, names.join())
            assert.equal(c.files.nothingOffered, true, names.join())
            assert.equal(c.shown.at(-1), 'Nothing to send', names.join())
        }
        assert.equal(offered, 0)
        // A file that can go, among them, is sent as before.
        fs.writeFileSync(path.join(home, 'notes.txt'), 'notes')
        electron.copied = ['gone.txt', 'notes.txt'].map(name => path.join(home, name))
        assert.equal(c.files.pasteClipboardFiles(), true)
        assert.equal(offered, 1)
        assert.equal(c.shown.at(-1), 'Pasting 1 file…')
    } finally {
        electron.copied = []
        c.files.dispose()
    }
})

test('⌘V with a copied file whose name is malformed (a bad address on the clipboard) says it couldn\'t read it, and pastes nothing', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const c = transfer()
    try {
        let offered = 0
        c.provider.uploadFiles = () => { offered++; return { transferIds: new Map(), completion: new Promise(() => { }) } }
        // Whichever format this system reads files from (Finder's, Files' or a URI list).
        electron.raw = { 'public.file-url': 'file:///%E0%A4%A', 'x-special/gnome-copied-files': 'copy\nfile:///%E0%A4%A', 'text/uri-list': 'file:///%E0%A4%A' }
        // Taken (the keys don't go to the remote, which would paste what it had), with the reason shown.
        assert.equal(c.files.pasteClipboardFiles(), true)
        assert.equal(await c.files.offerAnswered(), false)
        assert.equal(c.files.nothingOffered, true)
        assert.match(c.shown.at(-1) ?? '', /^Couldn't read the copied files: /)
        assert.equal(offered, 0)
    } finally {
        electron.raw = {}
        c.files.dispose()
    }
})

test('a stream the remote asks on again before its answer gets an error, and lets no more be read at once', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file, bytes } = onDisk(4 * MAX_RANGE)
    for (const how of ['dropped', 'pasted']) {
        const c = transfer()
        try {
            c.files.send(how === 'pasted' ? entriesFor([file]).entries : [new File([new Uint8Array(bytes)], 'big.bin')], how === 'pasted')
            readers.mostBytes = 0
            const ask = (streamId: number, flags: number, position: number, size: number) =>
                c.provider.handleFileContentsRequest({ streamId, index: 0, flags, position, size })
            // The remote numbers the streams: twelve parts on one stream, each followed by the file's size on it. The size
            // is answered at once, and an answer used to let a part being read go uncounted.
            for (let i = 0; i < 12; i++) {
                ask(7, rdp.FileContentsFlags.RANGE, (i % 4) * MAX_RANGE, MAX_RANGE)
                ask(7, rdp.FileContentsFlags.SIZE, 0, 8)
            }
            await until(() => readers.now === 0 && c.handedOut.length === 24)
            assert.ok(readers.mostBytes <= MAX_IN_FLIGHT, `${how}: ${readers.mostBytes / MB} MB read at once`)
            // The first part is read and answered; everything asked on that stream before its answer gets an error.
            assert.deepEqual(c.handedOut.filter(a => !a.isError).map(a => a.data.length), [MAX_RANGE], how)
            assert.ok(c.log.some(l => /another one on its stream \(7\) wasn't answered yet/.test(l)), c.log.join('\n'))
        } finally {
            c.files.dispose()
        }
    }
})

test('the requests waiting can\'t be used to let more be read at once either', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file } = onDisk(4 * MAX_RANGE)
    const c = transfer()
    try {
        c.files.send([new File([new Uint8Array(fs.readFileSync(file))], 'big.bin')])
        readers.mostBytes = 0
        const reading = MAX_IN_FLIGHT / MAX_RANGE
        // Four parts being read, the waiting list full, then more on a stream being read: the ones past the list got an
        // error each, and that error used to let a part being read on the same stream go uncounted.
        const streams = Array.from({ length: reading + MAX_WAITING }, (_, i) => c.ask((i % 4) * MAX_RANGE, MAX_RANGE))
        for (let i = 0; i < 20; i++) {
            c.provider.handleFileContentsRequest({ streamId: streams[0], index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size: MAX_RANGE })
        }
        await until(() => c.handedOut.length === streams.length + 20)
        assert.ok(readers.mostBytes <= MAX_IN_FLIGHT, `${readers.mostBytes / MB} MB read at once`)
        assert.equal(c.handedOut.filter(a => a.streamId === streams[0]).length, 21)
        assert.equal(c.handedOut.filter(a => !a.isError).length, streams.length)
    } finally {
        c.files.dispose()
    }
})

test('⌘V with copied folders that can\'t be read sends nothing, and pastes nothing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const home = folder()
    fs.mkdirSync(path.join(home, 'report', 'private'), { recursive: true })
    fs.writeFileSync(path.join(home, 'report', 'notes.txt'), 'notes')
    fs.chmodSync(path.join(home, 'report', 'private'), 0o000)
    t.after(() => fs.chmodSync(path.join(home, 'report', 'private'), 0o755))
    const c = transfer()
    try {
        let offered = 0
        c.provider.uploadFiles = () => { offered++; return { transferIds: new Map(), completion: new Promise(() => { }) } }
        electron.copied = [path.join(home, 'report')]
        // Taken (the keys don't go to the remote, which would paste what it had), with nothing to paste.
        assert.equal(c.files.pasteClipboardFiles(), true)
        assert.equal(await c.files.offerAnswered(), false)
        assert.equal(offered, 0)
        assert.match(c.shown.at(-1) ?? '', /^Couldn't read the copied files: /)
    } finally {
        electron.copied = []
        c.files.dispose()
    }
})

test('while the connection has no room, no part is read for the remote: its requests wait, and are read once there is', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { file, bytes } = onDisk(4 * MAX_RANGE)
    // The desktop's proxy on its server (see ServerFlow): what was handed to the connection, and isn't read from it
    // yet, has taken all the room, as when the server leaves what is sent unread.
    let room = false
    let resumed: (() => void)[] = []
    const flow = { room: () => room, spend () { }, refund () { }, whenRoom: () => room ? Promise.resolve() : new Promise<void>(resolve => resumed.push(resolve)) }
    // Pasted files are opened to read each part.
    const promises = require('fs').promises
    const open = promises.open
    let opened = 0
    promises.open = (...args: unknown[]) => { opened++; return open.apply(promises, args) }
    t.after(() => { promises.open = open })
    for (const how of ['dropped', 'pasted']) {
        room = false
        opened = 0
        readers.most = 0
        const c = transfer(undefined, flow)
        try {
            c.files.send(how === 'pasted' ? entriesFor([file]).entries : [new File([new Uint8Array(bytes)], 'big.bin')], how === 'pasted')
            const asked = Array.from({ length: 8 }, (_, i) => ({ at: (i % 4) * MAX_RANGE, stream: c.ask((i % 4) * MAX_RANGE, MAX_RANGE) }))
            await settle(50)
            assert.deepEqual([c.handedOut.length, readers.most, opened], [0, 0, 0], `${how}: nothing read, nothing answered`)
            // Its size is answered still: a few bytes.
            c.provider.handleFileContentsRequest({ streamId: 99, index: 0, flags: rdp.FileContentsFlags.SIZE, position: 0, size: 8 })
            assert.deepEqual(c.handedOut.map(a => [a.streamId, a.isError]), [[99, false]], how)
            // There is room again: all of it, in turn.
            room = true
            resumed.splice(0).forEach(resume => resume())
            for (const { at, stream } of asked) {
                const answer = await c.answer(stream)
                assert.deepEqual([answer.isError, hash(answer.data)], [false, hash(bytes.subarray(at, at + MAX_RANGE))], how)
            }
        } finally {
            c.files.dispose()
        }
    }
})


test('a paste still being pulled isn\'t failed while its requests wait for room, over a minute: each one tells the provider', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    // A slow link: the connection has no room for 70 seconds, what was sent before still going out. Meanwhile the
    // remote asks for each next part as the parts before reach it, every 8 seconds. The provider fails a paste whose
    // remote hasn't asked it for anything in a minute, and these requests wait here.
    let open = true
    const waiting: (() => void)[] = []
    const opened = () => open ? Promise.resolve() : new Promise<void>(resolve => waiting.push(resolve))
    // (taking, whenTaking: what FileTransfer waited for before there was room.)
    const flow = { room: () => open, spend () { }, refund () { }, whenRoom: opened, taking: () => open, whenTaking: opened }
    const c = transfer(undefined, flow)
    try {
        c.files.send([new File([new Uint8Array(8 * MB)], 'big.bin')])
        const asked = [c.ask(0, MB)]
        await until(() => c.handedOut.length === 1)
        open = false
        for (let i = 1; i < 8; i++) {
            t.mock.timers.tick(8000)
            asked.push(c.ask(i * MB, MB))
            await settle()
        }
        t.mock.timers.tick(6000)
        await settle()
        assert.equal(c.handedOut.length, 1, 'answered while there was no room')
        // The link has caught up.
        open = true
        waiting.splice(0).forEach(resume => resume())
        await until(() => c.handedOut.length === 8)
        assert.deepEqual(asked.map(stream => c.handedOut.find(a => a.streamId === stream)?.length), Array(8).fill(MB))
        assert.equal(c.shown.at(-1), 'Copied 1 file to the remote desktop')
        assert.deepEqual(c.log.filter(l => /stopped requesting|failed/.test(l)), [])
    } finally {
        c.files.dispose()
    }
})

/** The room the tests' links give (see Link), as the desktop's proxy does (FLOW_WINDOW). */
const WINDOW = 64 * MB
/** What the proxy lets the server leave unread before it stops reading from the connection (HIGH_WATER). */
const HIGH_WATER = 8 * MB

test('what is read for the remote stays within the room the connection gives, however slowly the server reads', async () => {
    const { file, bytes } = onDisk(4 * MAX_RANGE)
    for (const how of ['pasted', 'dropped']) {
        // A server that reads 2 MB at a time, now and then, behind the proxy.
        const link = new Link(WINDOW, HIGH_WATER)
        const c = transfer(undefined, link, link)
        try {
            c.files.send(how === 'pasted' ? entriesFor([file]).entries : [new File([new Uint8Array(bytes)], 'big.bin')], how === 'pasted')
            const reading = () => (c.files as any).reading.length
            // The remote keeps asking for parts of 16 MB, four at a time, each on a stream of its own.
            for (let round = 0; round < 40 && link.most <= WINDOW + MAX_RANGE; round++) {
                for (let i = 0; i < 4; i++) {
                    c.ask(i * MAX_RANGE, MAX_RANGE)
                }
                // The parts started are read and answered (those without room wait), and the proxy reads.
                await settle()
                await until(() => reading() === 0)
                link.tick(2 * MB)
            }
            // Within the room, and one part more: the one that took the last of it.
            assert.ok(link.most <= WINDOW + MAX_RANGE, `${how}: ${link.most / MB} MB handed to the connection and not read`)
            // And it moved on as the server read.
            assert.ok(link.serverRead >= 50 * MB, `${how}: the server read ${link.serverRead / MB} MB`)
        } finally {
            c.files.dispose()
        }
    }
})

test('a paste over a slow link, its room spent again and again, completes: the remote asks for more as each part reaches it', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    // A link of 256 KB a second, and a remote reading the file as FUSE does: twelve requests of 1 MB at a time, the
    // next asked as each answer reaches it. That is more than the room (4 MB here), so requests wait for it, over a
    // minute in all, and the provider's watchdogs (a minute) keep running meanwhile.
    const { file, bytes } = onDisk(24 * MB)
    const link = new Link(4 * MB, 2 * MB, 64 * 1024)
    const c = transfer(undefined, link, link, true)
    try {
        c.files.send(entriesFor([file]).entries, true)
        // Where each answer ends in what was handed to the connection: it has reached the remote once the server has
        // read that far.
        const arriving: number[] = []
        const handedOut = c.handedOut
        let next = 0
        const ask = () => {
            if (next < 24) {
                c.ask(next++ * MB, MB)
            }
        }
        for (let i = 0; i < 12; i++) {
            ask()
        }
        let seen = 0
        let waited = 0
        let tenths = 0
        for (; tenths < 1500 && handedOut.filter(a => !a.isError).length < 24; tenths++) {
            await settle()
            await until(() => (c.files as any).reading.length === 0)
            waited = Math.max(waited, (c.files as any).waiting.length)
            for (const answer of handedOut.slice(seen)) {
                if (!answer.isError) {
                    arriving.push(link.handed)
                }
            }
            seen = handedOut.length
            t.mock.timers.tick(100)
            link.tick(MB / 40)
            while (arriving.length && arriving[0] <= link.serverRead) {
                arriving.shift()
                ask()
            }
        }
        assert.ok(waited > 0 && tenths > 600, `requests waited for room (${waited} at most), for ${tenths / 10} seconds in all`)
        assert.deepEqual(handedOut.map(a => [a.isError, a.length]), Array(24).fill([false, MB]))
        assert.equal(hash(Buffer.concat(c.handedOut.map(a => a.data))), hash(bytes), 'the file, whole')
        assert.equal(c.shown.at(-1), 'Copied 1 file to the remote desktop')
    } finally {
        c.files.dispose()
    }
})

test('a read the provider dropped no longer holds its stream after 65 seconds: asked on it again, the remote is answered', async t => {
    t.mock.timers.enable({ apis: ['Date'] })
    const c = transfer()
    try {
        const ask = (streamId: number) => c.provider.handleFileContentsRequest({ streamId, index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size: 100 })
        const answers = (streamId: number) => c.handedOut.filter(a => a.streamId === streamId).map(a => [a.isError, a.length])
        c.files.send([new File([new Uint8Array(1000).fill(7)], 'a.bin')])
        // Pasted there whole: the provider keeps the file for pasting again.
        c.provider.handleFileContentsRequest({ streamId: 1, index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size: 1000 })
        await until(() => c.shown.at(-1) === 'Copied 1 file to the remote desktop')
        // Pasted again, and while that is read, the remote copies something of its own: the provider drops the read,
        // and answers nothing.
        readers.hang = 1
        ask(5)
        await settle()
        c.provider.handleFilesAvailable([{ name: 'notes.txt', size: 5 }], 1)
        await settle()
        assert.deepEqual(answers(5), [])
        // Asked on that stream again, half a minute later: it still holds the stream, as a read under way would.
        t.mock.timers.tick(30 * 1000)
        ask(5)
        assert.deepEqual(answers(5), [[true, 0]])
        // More than 65 seconds after the provider took it: it doesn't any more.
        t.mock.timers.tick(36 * 1000)
        ask(5)
        await until(() => answers(5).length === 2)
        assert.deepEqual(answers(5), [[true, 0], [false, 100]])
    } finally {
        readers.hang = 0
        c.files.dispose()
    }
})

test('what is handed to the connection takes room as it goes, and an extra answer for an earlier request on a stream is dropped: it releases nothing of the request on the stream now', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // The room as the desktop's proxy counts it, here with no proxy reading: what was taken stays taken.
    let owed = 0
    const flow = {
        room: () => true,
        spend: (bytes: number) => { owed += Math.max(0, bytes) },
        refund: (bytes: number) => { owed = Math.max(0, owed - Math.max(0, bytes)) },
        whenRoom: () => Promise.resolve(),
    }
    const c = transfer(undefined, flow)
    try {
        c.files.send([new File([new Uint8Array(4 * MB)], 'a.bin')])
        const ask = (streamId: number) => c.provider.handleFileContentsRequest({ streamId, index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size: MB })
        // A first request on stream 7, answered: its part takes room as it is handed over.
        ask(7)
        const [first] = [...(c.files as any).served.keys()]
        await until(() => c.handedOut.length === 1)
        assert.equal(owed, MB)
        // The remote asks on that stream again; the provider is still reading that part, which takes room for as much
        // as it may be.
        owed = 0
        readers.hang = 1
        ask(7)
        await settle()
        assert.equal(owed, MB)
        // Answers under the first request's number, which was answered: they are for no request any more. They go to
        // no one (the remote would take them for the answer to the one it asked on that stream last, and a short or an
        // error one is the end of that file for it), and the request on the stream now keeps the room it took.
        c.provider.sendSubmitFileContents(first, false, new Uint8Array(MB / 2))
        c.provider.sendSubmitFileContents(first, true, new Uint8Array())
        assert.equal(owed, MB)
        assert.equal(c.handedOut.length, 1)
        assert.equal(c.log.filter(l => /no more was dropped/.test(l)).length, 1, 'said once')
        // The part read is handed over all the same, once, and takes its room as it goes.
        readers.held[0]()
        await until(() => c.handedOut.length === 2)
        assert.deepEqual(c.handedOut.map(a => [a.streamId, a.isError, a.length]), [[7, false, MB], [7, false, MB]])
        assert.equal(owed, MB)
    } finally {
        readers.hang = 0
        c.files.dispose()
    }
})

test('a read the provider answers late, after the remote asked on its stream again: that answer goes to no one, and the new request keeps its room', async t => {
    t.mock.timers.enable({ apis: ['Date'] })
    let owed = 0
    const flow = {
        room: () => true,
        spend: (bytes: number) => { owed += Math.max(0, bytes) },
        refund: (bytes: number) => { owed = Math.max(0, owed - Math.max(0, bytes)) },
        whenRoom: () => Promise.resolve(),
    }
    const c = transfer(undefined, flow)
    try {
        const ask = (streamId: number) => c.provider.handleFileContentsRequest({ streamId, index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size: 100 })
        const answers = (streamId: number) => c.handedOut.filter(a => a.streamId === streamId).map(a => [a.isError, a.length])
        c.files.send([new File([new Uint8Array(1000).fill(7)], 'a.bin')])
        // Pasted there whole: the provider keeps the file for pasting again.
        c.provider.handleFileContentsRequest({ streamId: 1, index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size: 1000 })
        await until(() => c.shown.at(-1) === 'Copied 1 file to the remote desktop')
        owed = 0
        // Pasted again, and the provider is slow to answer: more than 65 seconds, which is as long as it is waited for.
        readers.hang = 1
        ask(5)
        const [first] = [...(c.files as any).served.keys()]
        await settle()
        assert.equal(owed, MIN_COST)
        t.mock.timers.tick(66 * 1000)
        // The remote asks on that stream again, and that read is under way too: the first request's room went back,
        // and the new one took its own.
        readers.hang = 1
        ask(5)
        await settle()
        assert.equal(owed, MIN_COST, 'the new request took room')
        // The provider answers the first one now, as late as that: for no request any more. It isn't sent to the
        // remote, which would take it for the answer to the new one, and the new request keeps its room.
        c.provider.sendSubmitFileContents(first, false, new Uint8Array(100))
        assert.deepEqual(answers(5), [])
        assert.equal(owed, MIN_COST)
        // The new request's own answer goes out, once, and takes the room of what it hands over.
        readers.held[1]()
        await until(() => answers(5).length === 1)
        assert.deepEqual(answers(5), [[false, 100]])
        assert.equal(owed, 100)
        assert.equal(c.log.filter(l => /no more was dropped/.test(l)).length, 1)
    } finally {
        readers.hang = 0
        c.files.dispose()
    }
})

test('a new offer while a pasted file\'s part is still read from disk: that read keeps its room until it is over, then its request gets an error', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let owed = 0
    const flow = {
        room: () => true,
        spend: (bytes: number) => { owed += Math.max(0, bytes) },
        refund: (bytes: number) => { owed = Math.max(0, owed - Math.max(0, bytes)) },
        whenRoom: () => Promise.resolve(),
    }
    const { file } = onDisk(2 * MB)
    const c = transfer(undefined, flow)
    const nodeFs = require('fs')
    const open = nodeFs.promises.open
    let release = () => { }
    const opened = new Promise<void>(resolve => { release = resolve })
    try {
        c.files.send(entriesFor([file]).entries, true)
        // The disk is slow: the part isn't read until the test says so.
        nodeFs.promises.open = async (p: string, ...rest: unknown[]) => {
            if (p === file) {
                await opened
            }
            return open(p, ...rest)
        }
        c.provider.handleFileContentsRequest({ streamId: 3, index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size: MB })
        await settle()
        assert.deepEqual([c.handedOut, owed], [[], MB])
        // Other files are offered meanwhile: the read goes on, and what it reads counts until it is over.
        c.files.send([new File([new Uint8Array(MB)], 'b.bin')])
        await settle()
        assert.deepEqual([c.handedOut, owed], [[], MB])
        // Over: its request gets an error (it was for the files offered before), and the room goes back.
        release()
        await until(() => c.handedOut.length > 0)
        assert.deepEqual([c.handedOut.map(a => [a.streamId, a.isError]), owed], [[[3, true]], 0])
    } finally {
        nodeFs.promises.open = open
        release()
        c.files.dispose()
    }
})

test('a new offer answers what was being read for the last files with an error at once, and gives back the room it took', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let owed = 0
    const flow = {
        room: () => true,
        spend: (bytes: number) => { owed += Math.max(0, bytes) },
        refund: (bytes: number) => { owed = Math.max(0, owed - Math.max(0, bytes)) },
        whenRoom: () => Promise.resolve(),
    }
    const c = transfer(undefined, flow)
    try {
        c.files.send([new File([new Uint8Array(4 * MB)], 'a.bin')])
        readers.hang = 1
        c.provider.handleFileContentsRequest({ streamId: 3, index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size: MB })
        await settle()
        assert.deepEqual([c.handedOut, owed], [[], MB])
        // The last files go, with the read the provider had under way for them: the remote isn't left to wait for it.
        c.files.send([new File([new Uint8Array(4 * MB)], 'b.bin')])
        assert.deepEqual([c.handedOut.map(a => [a.streamId, a.isError]), owed], [[[3, true]], 0])
        await settle()
        assert.deepEqual(c.handedOut.map(a => [a.streamId, a.isError]), [[3, true]])
        // The files offered now are read for the remote as before, on that stream again.
        const answer = await c.answer(c.ask(0, MB))
        assert.deepEqual([answer.isError, answer.length], [false, MB])
    } finally {
        readers.hang = 0
        c.files.dispose()
    }
})
