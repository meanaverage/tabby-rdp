// Clipboard sharing (src/clipboard.ts): the setting's modes, and IronRDP's component set up for each before connecting.
// The last tests drive the vendored component's own clipboard code (vendor/iron-remote-desktop.js, its services
// taken out of the bundle) with a stand-in for the WebAssembly session and the browser clipboard, so that what each
// mode lets through is checked against the component as it ships. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { clipboardSetting, clipboardWays, narrowest, ownClipboard, setUpClipboard, splitPaste } = require('../../dist/clipboard.js')
const { desktopsFor, specOf } = require('../../dist/desktops.js')

const root = fileURLToPath(new URL('../../', import.meta.url))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('the setting: both ways unless set; a mode it doesn\'t offer, or anything else unknown, is off', () => {
    assert.equal(clipboardSetting(undefined), 'both')
    assert.equal(clipboardSetting(''), 'both')
    for (const mode of ['both', 'fromRemote', 'off']) {
        assert.equal(clipboardSetting(mode), mode)
    }
    // Only from this computer to the remote isn't offered: written by hand, it mustn't let more through.
    assert.equal(clipboardSetting('toRemote'), 'off')
    assert.equal(clipboardSetting('Both'), 'off')
    assert.equal(clipboardSetting(true), 'off')
    // A desktop's own: none (the setting's) when unset or empty.
    assert.equal(ownClipboard(undefined), undefined)
    assert.equal(ownClipboard(''), undefined)
    assert.equal(ownClipboard('fromRemote'), 'fromRemote')
    assert.equal(ownClipboard('toRemote'), 'off')
    // The defaults Tabby fills in say the same.
    assert.match(readFileSync(root + 'src/ui.ts', 'utf8'), /\n\s*clipboard: 'both',/)
})

test('a desktop\'s own, from its entry behind a host or its profile\'s options, in place of the setting', () => {
    assert.equal(specOf({ host: '10.0.0.5', clipboard: 'fromRemote' }).clipboard, 'fromRemote')
    assert.equal(specOf({ host: '10.0.0.5', clipboard: 'off' }).clipboard, 'off')
    assert.equal(specOf({ host: '10.0.0.5', clipboard: 'toRemote' }).clipboard, 'off')
    // None: the setting's.
    assert.equal(specOf({ host: '10.0.0.5' }).clipboard, undefined)
    assert.equal(specOf({ host: '10.0.0.5', clipboard: '' }).clipboard, undefined)
    // A Hyper-V VM's console too.
    assert.equal(specOf({ hyperv: '5f05e000-c4d4-499c-8cca-429587811556', clipboard: 'off' }).clipboard, 'off')
})

test('the ways each mode lets the clipboard go, and what several let through together', () => {
    assert.deepEqual(clipboardWays('both'), { toRemote: true, fromRemote: true })
    assert.deepEqual(clipboardWays('fromRemote'), { toRemote: false, fromRemote: true })
    assert.deepEqual(clipboardWays('off'), { toRemote: false, fromRemote: false })
    assert.deepEqual(clipboardWays('both', 'fromRemote'), { toRemote: false, fromRemote: true })
    assert.deepEqual(clipboardWays('fromRemote', 'both'), { toRemote: false, fromRemote: true })
    assert.deepEqual(clipboardWays('both', 'off'), { toRemote: false, fromRemote: false })
    assert.equal(narrowest('both', 'both'), 'both')
    assert.equal(narrowest('both', 'fromRemote'), 'fromRemote')
    assert.equal(narrowest('fromRemote', 'both'), 'fromRemote')
    assert.equal(narrowest('off', 'both'), 'off')
})

test('the same desktop configured twice behind a host opens with the narrower clipboard of the two', () => {
    const host = { key: 'alice@host:22', label: 'host' }
    const clipboardOf = (setting: string, entries: object[], profiles: object[] = []) =>
        desktopsFor(host, entries.map(e => ({ via: 'host', ...e })), undefined, profiles, setting).find((s: any) => s.id === '127.0.0.1:3389')?.clipboard
    const entry = { name: 'Win VM', host: '127.0.0.1', port: 3389 }
    // An entry, and an RDP profile through this host at the same address set to off: the entry opens, with off.
    assert.equal(clipboardOf('both', [entry], [{ ...entry, name: 'Win VM (untrusted)', clipboard: 'off' }]), 'off')
    // Two profiles, one a copy set to off; and the other way round.
    assert.equal(clipboardOf('both', [], [entry, { ...entry, clipboard: 'off' }]), 'off')
    assert.equal(clipboardOf('both', [], [{ ...entry, clipboard: 'off' }, entry]), 'off')
    // One that follows the setting is as narrow as the setting is.
    assert.equal(clipboardOf('fromRemote', [{ ...entry, clipboard: 'both' }], [entry]), 'fromRemote')
    assert.equal(clipboardOf('off', [], [{ ...entry, clipboard: 'fromRemote' }, entry]), 'off')
    assert.equal(clipboardOf('both', [{ ...entry, clipboard: 'both' }], [{ ...entry, clipboard: 'fromRemote' }]), 'fromRemote')
    // The other no narrower: one that follows the setting keeps following it (and so narrows with it while connected),
    // and one with its own keeps that.
    assert.equal(clipboardOf('both', [entry], [entry]), undefined)
    assert.equal(clipboardOf('fromRemote', [entry], [{ ...entry, clipboard: 'both' }]), undefined)
    assert.equal(clipboardOf('both', [{ ...entry, clipboard: 'off' }], [entry]), 'off')
    // Only one: as configured.
    assert.equal(clipboardOf('off', [{ ...entry, clipboard: 'both' }]), 'both')
    assert.equal(clipboardOf('both', [entry]), undefined)
})

test('paste to all desktops: only those this computer\'s clipboard goes to get it, and the others are named', () => {
    const desktops = [{ name: 'A', mode: 'both' }, { name: 'B', mode: 'fromRemote' }, { name: 'C', mode: 'both' }, { name: 'D', mode: 'off' }]
    const split = (list: typeof desktops) => splitPaste(list, (d: { mode: string }) => clipboardWays(d.mode), (d: { name: string }) => d.name)
    const all = split(desktops)
    assert.deepEqual(all.targets.map((d: { name: string }) => d.name), ['A', 'C'])
    assert.deepEqual(all.left.map((d: { name: string }) => d.name), ['B', 'D'])
    assert.equal(all.note, 'Pasting on 2 of 4 desktops: not on B and D, which don\'t take this computer\'s clipboard.')
    assert.equal(split(desktops.slice(0, 3)).note, 'Pasting on 2 of 3 desktops: not on B, which doesn\'t take this computer\'s clipboard.')
    assert.equal(split([desktops[1], desktops[3]]).note, 'Not pasted: these desktops don\'t take this computer\'s clipboard.')
    const none = split([desktops[3]])
    assert.deepEqual([none.targets, none.note], [[], 'Not pasted: this desktop doesn\'t take this computer\'s clipboard.'])
    const every = split([desktops[0], desktops[2]])
    assert.deepEqual([every.targets.length, every.left, every.note], [2, [], null])
})

/**
 * A stand-in for the component's API: enableFileTransfer composes the provider's hooks as the component does
 * (suppress and resume its reading of this computer's clipboard), and the calls are recorded.
 */
function stubComponent (compose = true) {
    const calls: string[] = []
    const ui = {
        enableFileTransfer (provider: any) {
            calls.push('enableFileTransfer')
            if (compose) {
                provider.onUploadStarted = () => calls.push('suppress')
                provider.onUploadFinished = () => calls.push('resume')
            }
        },
        setEnableClipboard (enable: boolean) {
            calls.push(`setEnableClipboard(${enable})`)
        },
    }
    return { ui, calls }
}

test('both ways: the provider registered, nothing turned off; a paste of files ends with the reading started again', () => {
    const { ui, calls } = stubComponent()
    const provider: any = {}
    let sending = true
    const set = setUpClipboard(ui, provider, 'both', () => sending)
    assert.equal(set.mode, 'both')
    assert.deepEqual(calls, ['enableFileTransfer'])
    provider.onUploadFinished()
    assert.deepEqual(calls, ['enableFileTransfer', 'resume'])
    // Narrowed while connected: stopped, and a later paste of files doesn't start it again.
    sending = false
    set.stopSending()
    provider.onUploadFinished()
    assert.deepEqual(calls, ['enableFileTransfer', 'resume', 'suppress'])
})

test('only from the remote: the reading stopped before connecting, and kept stopped', () => {
    const { ui, calls } = stubComponent()
    const provider: any = {}
    const set = setUpClipboard(ui, provider, 'fromRemote', () => false)
    assert.equal(set.mode, 'fromRemote')
    assert.deepEqual(calls, ['enableFileTransfer', 'suppress'])
    provider.onUploadFinished()
    assert.deepEqual(calls, ['enableFileTransfer', 'suppress'])
})

test('off: the clipboard turned off after the provider is registered (which turns it on), and the reading stopped', () => {
    const { ui, calls } = stubComponent()
    const set = setUpClipboard(ui, {}, 'off', () => false)
    assert.equal(set.mode, 'off')
    assert.deepEqual(calls, ['enableFileTransfer', 'suppress', 'setEnableClipboard(false)'])
})

test('a component that doesn\'t compose the hooks can\'t be kept from sending: the clipboard is off then', () => {
    for (const mode of ['both', 'fromRemote']) {
        const { ui, calls } = stubComponent(false)
        assert.equal(setUpClipboard(ui, {}, mode, () => true).mode, 'off')
        assert.deepEqual(calls, ['enableFileTransfer', 'setEnableClipboard(false)'])
        // Hooks of the provider's own don't stand in for the component's.
        const own = stubComponent(false)
        assert.equal(setUpClipboard(own.ui, { onUploadStarted () { }, onUploadFinished () { } }, mode, () => true).mode, 'off')
    }
    assert.throws(() => setUpClipboard({ enableFileTransfer () { } }, {}, 'off', () => false), /can't turn its clipboard off/)
})

// ---- the vendored component --------------------------------------------------------------------------------------

/** This computer's clipboard as the component sees it: what is on it, how often it was read, and what was written. */
const browser = {
    local: 'copied here',
    reads: 0,
    writes: [] as Record<string, Blob>[],
    /** While set, a read of the clipboard waits for this (the browser can take its time). */
    gate: null as Promise<void> | null,
    reset () {
        this.local = 'copied here'
        this.reads = 0
        this.writes = []
        this.gate = null
    },
}

class FakeShadowRoot {
    constructor (readonly host: object) { }
}

/** The component's RemoteDesktopService, ClipboardService and PublicAPI classes, out of the vendored bundle. */
const component = (() => {
    const text = readFileSync(root + 'vendor/iron-remote-desktop.js', 'utf8')
    // The component makes them as `l = new On(o()), a = new Mn(l, o()), u = new Ln(l, a)` (the names are minified). A
    // build of IronRDP that makes them otherwise fails here on purpose: what the modes enforce rests on this code.
    const made = /(\w+) = new (\w+)\((\w+)\(\)\), (\w+) = new (\w+)\(\1, \3\(\)\), (\w+) = new (\w+)\(\1, \4\)/.exec(text)
    assert.ok(made, 'finds where the component makes its services')
    const body = text.replace(/\nexport \{[^}]*\};?\s*$/, '\n') +
        `\nreturn { RemoteDesktopService: ${made[2]}, ClipboardService: ${made[5]}, PublicAPI: ${made[7]} };`
    const navigator = {
        clipboard: {
            read: async () => {
                browser.reads++
                await browser.gate
                return [{ types: ['text/plain'], getType: async () => new Blob([browser.local]) }]
            },
            write: async (items: { record: Record<string, Blob> }[]) => { browser.writes.push(items[0].record) },
        },
        permissions: { query: async () => ({ state: 'granted' }) },
    }
    const host = {}
    const document = { hasFocus: () => true, activeElement: host }
    const window = { isSecureContext: true }
    class ClipboardItem {
        constructor (readonly record: Record<string, Blob>) { }
    }
    const load = new Function('window', 'document', 'navigator', 'HTMLElement', 'ShadowRoot', 'customElements', 'ClipboardItem', body)
    const classes = load(window, document, navigator, class { }, FakeShadowRoot, { define () { } }, ClipboardItem)
    return { ...classes, canvas: { getRootNode: () => new FakeShadowRoot(host) } }
})()

/** What IronRDP's ClipboardData looks like to the component. */
class ClipboardData {
    readonly list: { mime: string, value: unknown }[] = []
    addText (mime: string, value: string) { this.list.push({ mime, value }) }
    addBinary (mime: string, value: Uint8Array) { this.list.push({ mime, value }) }
    isEmpty () { return this.list.length === 0 }
    items () { return this.list.map(item => ({ mimeType: () => item.mime, value: () => item.value })) }
}

/**
 * Connects through the vendored component, set up by setUpClipboard for `mode`, to a stand-in WebAssembly session:
 * what the component handed the session builder (IronRDP attaches the clipboard channel only when it gets the
 * remote clipboard callback: ironrdp-web's session.rs), and what reached the session as this computer's clipboard.
 */
async function connect (mode: string) {
    browser.reset()
    const builder: string[] = []
    const callbacks: Record<string, (...args: any[]) => any> = {}
    const sent: ClipboardData[] = []
    class SessionBuilder { }
    for (const name of ['proxyAddress', 'destination', 'serverDomain', 'password', 'authToken', 'username', 'renderCanvas',
        'setCursorStyleCallbackContext', 'setCursorStyleCallback', 'canvasResizedCallback', 'desktopSize', 'extension',
        'remoteClipboardChangedCallback', 'forceClipboardUpdateCallback']) {
        (SessionBuilder.prototype as any)[name] = function (arg: any) {
            builder.push(name === 'extension' ? `extension:${arg}` : name)
            if (name.endsWith('Callback') && typeof arg === 'function') {
                callbacks[name] = arg
            }
            return this
        }
    }
    (SessionBuilder.prototype as any).connect = async () => ({
        desktopSize: () => ({ width: 1024, height: 768 }),
        onClipboardPaste: async (data: ClipboardData) => { sent.push(data) },
        run: () => new Promise(() => { }),
        shutdown () { },
    })
    const module = { SessionBuilder, ClipboardData, DesktopSize: class { constructor (readonly width: number, readonly height: number) { } } }
    const service = new component.RemoteDesktopService(module)
    service.setCanvas(component.canvas)
    const clipboard = new component.ClipboardService(service, module)
    await clipboard.initClipboard()
    const ui = new component.PublicAPI(service, clipboard).getExposedFunctions()
    const provider: any = { getBuilderExtensions: () => ['files'], setSession () { }, dispose () { } }
    let sending = mode === 'both'
    const set = setUpClipboard(ui, provider, mode, () => sending)
    await ui.connect({ proxyAddress: 'ws://127.0.0.1:1', destination: 'desktop:3389', serverDomain: '', password: 'p', authToken: 't',
        username: 'u', extensions: [], desktopSize: { width: 1024, height: 768 } })
    return {
        set,
        builder,
        callbacks,
        provider,
        /** The component's clipboard code itself: what the component calls when it gets the focus back. */
        clipboard,
        /** What reached the session from this computer's clipboard, as text ('' for an empty clipboard). */
        sent: () => sent.map(data => data.list.map(item => item.value).join('')),
        narrow () {
            sending = false
            set.stopSending()
        },
        /** The server's clipboard changed (IronRDP has fetched it and hands it over). */
        remoteCopies (text: string) {
            const data = new ClipboardData()
            data.addText('text/plain', text)
            callbacks.remoteClipboardChangedCallback?.(data)
        },
        close: () => ui.shutdown(),
    }
}

test('the component, both ways: the channel is there, this computer\'s clipboard goes, the remote\'s comes', async () => {
    const c = await connect('both')
    try {
        assert.ok(c.builder.includes('remoteClipboardChangedCallback') && c.builder.includes('forceClipboardUpdateCallback'))
        assert.ok(c.builder.includes('extension:files'), 'files through the clipboard')
        await sleep(350)
        assert.ok(browser.reads > 0, 'this computer\'s clipboard is read')
        assert.deepEqual(c.sent(), ['copied here'])
        c.remoteCopies('copied there')
        await sleep(20)
        assert.equal(await browser.writes[0]?.['text/plain']?.text(), 'copied there')
    } finally {
        c.close()
    }
})

test('the component, only from the remote: this computer\'s clipboard is neither read nor sent, the remote\'s comes', async () => {
    const c = await connect('fromRemote')
    try {
        assert.ok(c.builder.includes('remoteClipboardChangedCallback') && c.builder.includes('extension:files'))
        await sleep(350)
        assert.equal(browser.reads, 0)
        // The server asks for this side's clipboard when the channel starts: it gets an empty one.
        await c.callbacks.forceClipboardUpdateCallback()
        assert.deepEqual(c.sent(), [''])
        // A paste of files ending (the provider's own hook) doesn't start the reading again.
        c.provider.onUploadFinished()
        browser.local = 'a password'
        await sleep(350)
        assert.equal(browser.reads, 0)
        assert.deepEqual(c.sent(), [''])
        c.remoteCopies('copied there')
        await sleep(20)
        assert.equal(await browser.writes[0]?.['text/plain']?.text(), 'copied there')
    } finally {
        c.close()
    }
})

test('the component, off: no clipboard callbacks or file extensions for IronRDP, so no clipboard channel; nothing read', async () => {
    const c = await connect('off')
    try {
        assert.equal(c.set.mode, 'off')
        assert.ok(!c.builder.includes('remoteClipboardChangedCallback'))
        assert.ok(!c.builder.includes('forceClipboardUpdateCallback'))
        assert.ok(!c.builder.includes('extension:files'))
        await sleep(350)
        assert.equal(browser.reads, 0)
        assert.deepEqual(c.sent(), [])
    } finally {
        c.close()
    }
})

test('the component, narrowed while connected: the sending stops at once, and a paste of files doesn\'t restart it', async () => {
    const c = await connect('both')
    try {
        await sleep(250)
        assert.deepEqual(c.sent(), ['copied here'])
        c.narrow()
        browser.local = 'a password'
        const reads = browser.reads
        c.provider.onUploadFinished()
        await sleep(350)
        assert.equal(browser.reads, reads)
        assert.deepEqual(c.sent(), ['copied here'])
    } finally {
        c.close()
    }
})

test('the component, narrowed while a read of this computer\'s clipboard is under way: what it read isn\'t sent', async () => {
    const c = await connect('both')
    try {
        await sleep(250)
        assert.deepEqual(c.sent(), ['copied here'])
        // A read starts, and the browser holds it; meanwhile something new is copied here, and the setting narrows.
        let release!: () => void
        browser.gate = new Promise(resolve => { release = resolve })
        browser.local = 'a password'
        const reads = browser.reads
        await sleep(150)
        assert.ok(browser.reads > reads, 'a read is under way')
        c.narrow()
        release()
        await sleep(350)
        assert.deepEqual(c.sent(), ['copied here'])
    } finally {
        c.close()
    }
})

test('the component, only from the remote: nothing starts the reading again, for as long as the connection lasts', async () => {
    const c = await connect('fromRemote')
    try {
        // What the remote copies is written here once the desktop has the focus, which it has.
        c.remoteCopies('copied there')
        await sleep(350)
        // The focus back after a while elsewhere: the component writes what waited for it, and reads nothing.
        c.remoteCopies('copied there again')
        c.clipboard.flushFocused()
        await sleep(350)
        // A paste of files that ends, or fails (the provider's hook either way), several times over.
        for (let i = 0; i < 3; i++) {
            c.provider.onUploadFinished()
            await sleep(120)
        }
        assert.equal(browser.reads, 0)
        assert.deepEqual(c.sent(), [])
        assert.equal(browser.writes.length, 2)
    } finally {
        c.close()
    }
})
