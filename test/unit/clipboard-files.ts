// Files through the clipboard (src/fileTransfer.ts) go only where the clipboard does: what the plugin checks itself, on
// top of what the clipboard setting sets up in IronRDP's component (test/unit/clipboard.ts). Driven through IronRDP's
// own RdpFileTransferProvider (vendor/iron-remote-desktop-rdp.js, its WebAssembly initialised), with stand-ins for the
// desktop layer, the page's document, the browser's FileReader, Electron's clipboard and the remote's requests.
// Runs against the built plugin: npm run build && npm run test:unit
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))

/** Electron's clipboard as the plugin's `require('electron')` gets it: no files on it, and how often it was read. */
const electron = { reads: 0, clipboard: { read: () => { electron.reads++; return '' }, readBuffer: () => { electron.reads++; return Buffer.alloc(0) } } }
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

/** The browser's FileReader, as the provider reads what it hands out with it. */
;(globalThis as any).FileReader = class {
    result: ArrayBuffer | null = null
    error: unknown = null
    onload?: () => void
    onerror?: () => void
    readAsArrayBuffer (blob: Blob) {
        blob.arrayBuffer().then(b => { this.result = b; this.onload?.() }, e => { this.error = e; this.onerror?.() })
    }
    abort () { }
}

const { FileTransfer } = require('../../dist/fileTransfer.js')
let rdp: any

before(async () => {
    rdp = await import(pathToFileURL(root + 'vendor/iron-remote-desktop-rdp.js').href)
    await rdp.init('ERROR', readFileSync(root + 'vendor/ironrdp_web_bg.wasm'))
})

/** Lets the provider's reads and the promises after them run. */
const settle = async () => {
    for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setImmediate(resolve))
    }
}

type Ways = { toRemote: boolean, fromRemote: boolean }
const BOTH: Ways = { toRemote: true, fromRemote: true }
const FROM_REMOTE: Ways = { toRemote: false, fromRemote: true }
const OFF: Ways = { toRemote: false, fromRemote: false }

/**
 * A FileTransfer over a stand-in desktop layer, its provider on a stand-in session: the ways the clipboard goes (they
 * can change, as the settings narrow them), what it logged and showed, what it handed the remote, and the remote's
 * requests for what is on its clipboard from here.
 */
function transfer (initial: Ways) {
    let ways = { ...initial }
    const listeners = new Map<string, (event: unknown) => void>()
    const classes = new Set<string>()
    const shown: string[] = []
    const layer = {
        addEventListener: (type: string, handler: (event: unknown) => void) => { listeners.set(type, handler) },
        removeEventListener: (type: string) => { listeners.delete(type) },
        contains: () => false,
        classList: {
            add: (...names: string[]) => names.forEach(n => classes.add(n)),
            remove: (...names: string[]) => names.forEach(n => classes.delete(n)),
            toggle: (name: string, on: boolean) => { on ? classes.add(name) : classes.delete(name) },
        },
        appendChild: (el: FakeElement) => { shown.push(el.children[0]?.textContent ?? '') },
    }
    const log: string[] = []
    const files = new FileTransfer(rdp, layer, (m: string) => log.push(m), () => ways)
    const provider = files.provider
    provider.setSession({ invokeExtension () { } })
    // What reaches the connection, each answer under the remote's number for its request.
    const handedOut: { streamId: number, isError: boolean, text: string }[] = []
    const submit = files.submit.bind(files)
    files.submit = (streamId: number, isError: boolean, data: Uint8Array) => {
        handedOut.push({ streamId, isError, text: new TextDecoder().decode(data) })
        submit(streamId, isError, data)
    }
    let streams = 0
    return {
        files, provider, listeners, classes, shown, log, handedOut,
        narrow (to: Ways) { ways = { ...to } },
        /** The remote asks for a file it was offered, as pasting it there does: its size, then its contents. */
        async paste (size: number) {
            provider.handleFileContentsRequest({ streamId: ++streams, index: 0, flags: rdp.FileContentsFlags.SIZE, position: 0, size: 8 })
            provider.handleFileContentsRequest({ streamId: ++streams, index: 0, flags: rdp.FileContentsFlags.RANGE, position: 0, size })
            await settle()
            return handedOut.slice(-2)
        },
    }
}

test('the remote asks the provider itself for what it was offered: the plugin\'s check is what it gets to', () => {
    // The provider hands its file contents callback to IronRDP as a closure that calls the method on the provider, so
    // the one FileTransfer puts on the instance answers. A build that bound the method early would bypass it.
    assert.match(readFileSync(root + 'vendor/iron-remote-desktop-rdp.js', 'utf8'), /\((\w+)\) => this\.handleFileContentsRequest\(\1\)/)
})

test('files offered while the clipboard went both ways aren\'t handed out once it narrows, pasted before or not', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const c = transfer(BOTH)
    try {
        c.files.send([new File(['the secret file'], 'secret.txt')])
        const served = await c.paste(15)
        assert.deepEqual(served.map(s => [s.isError, s.text]), [[false, '\x0f\0\0\0\0\0\0\0'], [false, 'the secret file']])
        // The provider keeps them to paste again. The setting narrows: pasted again there, they aren't handed out.
        c.narrow(FROM_REMOTE)
        assert.deepEqual((await c.paste(15)).map(s => [s.isError, s.text]), [[true, ''], [true, '']])
        assert.deepEqual(c.log.filter(m => /not sent/.test(m)), ['files: not sent: this computer\'s clipboard doesn\'t go to the remote'])
        assert.equal(c.shown.at(-1), 'Not sent: the clipboard only goes from this desktop to this computer.')
        // Said once, however often the remote asks.
        await c.paste(15)
        assert.equal(c.log.filter(m => /not sent/.test(m)).length, 1)
    } finally {
        c.files.dispose()
    }

    // Offered, and not pulled yet when the setting narrows (off, this time).
    const d = transfer(BOTH)
    try {
        d.files.send([new File(['another secret'], 'other.txt')])
        d.narrow(OFF)
        assert.deepEqual((await d.paste(14)).map(s => [s.isError, s.text]), [[true, ''], [true, '']])
        assert.equal(d.shown.at(-1), 'Not sent: clipboard sharing with this desktop is off.')
    } finally {
        d.files.dispose()
    }
})

test('files dropped on the desktop aren\'t offered where this computer\'s clipboard doesn\'t go, nor pasted onto the console', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const ways of [FROM_REMOTE, OFF, BOTH]) {
        const c = transfer(ways)
        try {
            let read = 0
            c.provider.handleDrop = async () => { read++; return [] }
            const swallowed: string[] = []
            const event = { dataTransfer: { types: ['Files'] }, preventDefault: () => swallowed.push('default'), stopPropagation: () => swallowed.push('propagation') }
            c.listeners.get('dragover')!(event)
            // The layer shows where they would go, or that they don't.
            assert.deepEqual([...c.classes].sort(), ways.toRemote ? ['trd-drop-target'] : ['trd-drop-refused', 'trd-drop-target'])
            c.listeners.get('drop')!(event)
            await settle()
            assert.deepEqual(c.classes.size, 0)
            // Taken either way: Tabby would otherwise type their paths into the console under the desktop.
            assert.deepEqual(swallowed, ['default', 'propagation', 'default', 'propagation'])
            assert.equal(read, ways.toRemote ? 1 : 0)
            assert.equal(c.shown.length, ways.toRemote ? 0 : 1)
        } finally {
            c.files.dispose()
        }
    }
})

test('picking files to send is refused before the picker shows, and sending them is refused', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const c = transfer(FROM_REMOTE)
    try {
        let picked = 0
        let offered = 0
        c.provider.showFilePicker = async () => { picked++; return [new File(['x'], 'x.txt')] }
        c.provider.uploadFiles = () => { offered++; return { transferIds: new Map(), completion: new Promise(() => { }) } }
        await c.files.pickAndSend()
        assert.equal(c.files.send([new File(['x'], 'x.txt')]), null)
        assert.deepEqual([picked, offered], [0, 0])
        assert.equal(c.shown.at(-1), 'Not sent: the clipboard only goes from this desktop to this computer.')
        // Both ways, they are.
        c.narrow(BOTH)
        await c.files.pickAndSend()
        assert.deepEqual([picked, offered], [1, 1])
    } finally {
        c.files.dispose()
    }
})

test('⌘V on such a desktop doesn\'t look for files copied here: this computer\'s clipboard isn\'t even read', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const ways of [FROM_REMOTE, OFF]) {
        const c = transfer(ways)
        try {
            electron.reads = 0
            assert.equal(c.files.pasteClipboardFiles(), false)
            assert.equal(electron.reads, 0)
        } finally {
            c.files.dispose()
        }
    }
    // Where it goes, it is read (and holds no files here).
    const c = transfer(BOTH)
    try {
        electron.reads = 0
        assert.equal(c.files.pasteClipboardFiles(), false)
        assert.ok(electron.reads > 0)
    } finally {
        c.files.dispose()
    }
})

test('files copied on the remote aren\'t offered where nothing comes from it, and an earlier offer can\'t be saved', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const off = transfer(OFF)
    try {
        off.provider.handleFilesAvailable([{ name: 'report.pdf', size: 3 }], 7)
        assert.deepEqual(off.files.offered, [])
        assert.deepEqual(off.shown, [])
        assert.deepEqual(off.log, ['files: the remote copied 1; not offered: its clipboard doesn\'t come here'])
    } finally {
        off.files.dispose()
    }

    // Offered while it came here; then the setting turns it off, and Save to Downloads is pressed.
    const c = transfer(FROM_REMOTE)
    try {
        let fetched = 0
        c.provider.downloadFile = () => { fetched++; return { completion: Promise.reject(new Error('fetched from the remote')) } }
        c.provider.handleFilesAvailable([{ name: 'report.pdf', size: 3 }], 7)
        assert.equal(c.files.offered.length, 1)
        assert.equal(c.shown.at(-1), '1 file copied on the remote desktop')
        c.narrow(OFF)
        assert.deepEqual(await c.files.saveAll(fileURLToPath(new URL('./not-there', import.meta.url))), [])
        assert.equal(fetched, 0)
        assert.equal(c.shown.at(-1), 'Not saved: clipboard sharing with this desktop is off.')
    } finally {
        c.files.dispose()
    }
})

test('narrowed while connected: the files offered there are taken back, a paste still pulling them included', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // Offered, not pulled yet: the paste fails at once, and says so, rather than waiting for the remote that won't get them.
    const c = transfer(BOTH)
    try {
        const pasting = c.files.send([new File(['the secret file'], 'secret.txt')])
        assert.equal(c.provider.isUploadInProgress(), true)
        c.narrow(FROM_REMOTE)
        c.files.revoke()
        await pasting
        assert.equal(c.provider.isUploadInProgress(), false)
        assert.equal(c.shown.at(-1), 'Copying to the remote desktop failed: this computer\'s clipboard doesn\'t go to this desktop any more')
        assert.deepEqual((await c.paste(15)).map(s => [s.isError, s.text]), [[true, ''], [true, '']])
    } finally {
        c.files.dispose()
    }
    // Pasted there before: the provider keeps them to paste again, and drops them.
    const d = transfer(BOTH)
    try {
        d.files.send([new File(['the secret file'], 'secret.txt')])
        await d.paste(15)
        assert.ok(d.provider.retainedFiles, 'kept for pasting again')
        d.narrow(OFF)
        d.files.revoke()
        assert.equal(d.provider.retainedFiles, undefined)
        assert.deepEqual((await d.paste(15)).map(s => [s.isError, s.text]), [[true, ''], [true, '']])
    } finally {
        d.files.dispose()
    }
})

test('Save to Downloads stops between files once nothing comes from the remote any more', async () => {
    const c = transfer(FROM_REMOTE)
    // The real path, as saveAll gives its paths: the temporary folder can be behind a link (macOS's default).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trd-save-')))
    try {
        const fetched: string[] = []
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        // The first file takes a while to arrive; the setting turns the clipboard off meanwhile.
        c.provider.downloadFile = (file: { name: string }) => {
            fetched.push(file.name)
            return { completion: (fetched.length === 1 ? held : Promise.resolve()).then(() => new Blob([`contents of ${file.name}`])) }
        }
        c.provider.handleFilesAvailable([{ name: 'one.txt', size: 15 }, { name: 'two.txt', size: 15 }, { name: 'three.txt', size: 17 }], 7)
        const saving = c.files.saveAll(dir)
        await settle()
        c.narrow(OFF)
        release()
        const saved = await saving
        assert.deepEqual(fetched, ['one.txt'])
        assert.deepEqual(saved.map((f: string) => f.slice(dir.length + 1)), ['one.txt'])
        assert.deepEqual(readdirSync(dir), ['one.txt'])
        assert.equal(c.shown.at(-1), 'Stopped saving: clipboard sharing with this desktop is off now (1 file saved).')
    } finally {
        c.files.dispose()
        rmSync(dir, { recursive: true, force: true })
    }
})
