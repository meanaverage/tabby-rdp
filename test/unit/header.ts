// What the plugin adds to Tabby's window around the desktops: the red microphone in Tabby's header (src/header.ts),
// shown whatever tab is in front and, in full screen, where Tabby shows no header, over the window instead, with a menu
// that shows a desktop or stops sending it the microphone; the desktop menu's switch for its microphone, its paste and
// typing into all as the desktops showing count, and the note in the Clipboard menu on a desktop with its own setting
// (src/ui.ts); the clipboard a profile connects with, as the settings page lists it (src/settingsPage.ts); and the
// plugin's hotkeys, of which only its own act (src/index.ts). With Tabby's modules and the page's document stubbed.
// Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const g = globalThis as any

// Tabby and Angular, as far as loading the plugin needs them: decorators that change nothing, classes to extend.
const decorator = () => () => undefined
const classes = () => new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } })
const stubs: Record<string, unknown> = {
    '@angular/core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : decorator }),
    'tabby-core': classes(),
    'tabby-settings': classes(),
    'tabby-terminal': classes(),
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}

/** An element, as far as the plugin's header controls use one. */
class FakeElement {
    className = ''
    title = ''
    innerHTML = ''
    textContent = ''
    readonly style: Record<string, string> = {}
    readonly attributes: { name: string, value: string }[] = []
    readonly children: FakeElement[] = []
    parent: FakeElement | null = null
    readonly listeners = new Map<string, ((event: unknown) => void)[]>()
    readonly classes = new Set<string>()
    readonly classList = {
        toggle: (name: string, on = !this.classes.has(name)) => { on ? this.classes.add(name) : this.classes.delete(name) },
        contains: (name: string) => this.classes.has(name),
    }

    constructor (readonly root = false) { }

    get isConnected (): boolean {
        return this.root || !!this.parent?.isConnected
    }

    get firstChild (): FakeElement | null {
        return this.children[0] ?? null
    }

    setAttribute (name: string, value: string): void {
        this.attributes.push({ name, value })
    }

    addEventListener (type: string, handler: (event: unknown) => void): void {
        this.listeners.set(type, [...this.listeners.get(type) ?? [], handler])
    }

    click (): void {
        this.listeners.get('click')?.forEach(handler => handler({}))
    }

    append (...nodes: FakeElement[]): void {
        nodes.forEach(node => this.insertBefore(node, null))
    }

    appendChild (node: FakeElement): FakeElement {
        this.insertBefore(node, null)
        return node
    }

    insertBefore (node: FakeElement, before: FakeElement | null): void {
        node.remove()
        node.parent = this
        const at = before ? this.children.indexOf(before) : -1
        at < 0 ? this.children.push(node) : this.children.splice(at, 0, node)
    }

    remove (): void {
        if (this.parent) {
            this.parent.children.splice(this.parent.children.indexOf(this), 1)
            this.parent = null
        }
    }

    querySelector (): null {
        return null
    }
}

/** Tabby's window: its body, and the header's right-hand group (the settings gear's), which full screen takes away. */
const page = {
    body: new FakeElement(true),
    right: new FakeElement(),
    /** Tabby's tab bar shows: not in full screen (unless Appearance › Show tabs in fullscreen mode is on). */
    set tabBar (shown: boolean) {
        shown ? this.body.append(this.right) : this.right.remove()
    },
}
page.tabBar = true
g.document = {
    body: page.body,
    head: new FakeElement(),
    querySelector: (selector: string) => selector === 'app-root .btn-space ~ .btn-group' && page.right.isConnected ? page.right : null,
    querySelectorAll: () => [],
    createElement: () => new FakeElement(),
}
g.MutationObserver = class { observe () { } }
g.window = {}

const { HeaderControls } = require('../../dist/header.js')
const { desktopActions, settingsMenu } = require('../../dist/ui.js')
const { RemoteDesktopSettingsComponent } = require('../../dist/settingsPage.js')
const { HostCompatibility } = require('../../dist/hostCompat.js')

const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
const alpha = { name: 'alpha' }
const beta = { name: 'beta' }

/** The header controls over a stand-in service whose desktops get the microphone as `users` says; menus are recorded. */
function header () {
    // A page of its own: what an earlier test's controls put there goes.
    page.right.children.splice(0).forEach(child => { child.parent = null })
    page.body.children.filter(child => child !== page.right).forEach(child => child.remove())
    const calls: string[] = []
    const menus: any[][] = []
    const desktop = {
        users: [] as { pane: { name: string }, name: string, inView: boolean }[],
        microphoneUsers () { return this.users },
        has: () => false,
        isVisible: () => false,
        bringForward: (pane: { name: string }) => { calls.push(`show ${pane.name}`) },
        stopMicrophone: (pane: { name: string }) => { calls.push(`stop ${pane.name}`) },
    }
    const app = { activeTab: { title: 'Settings' } }
    const controls = new HeaderControls(app, desktop, { cached: () => null }, { popupContextMenu: (items: any[]) => menus.push(items) }, {}, zone, {})
    return { controls, desktop, app, calls, menus }
}

/** The plugin's elements in the header's group, and over the window. */
const group = () => page.right.children.find(c => c.className === 'trd-header')
const headerMicrophone = () => group()?.children.find(c => /trd-header-mic/.test(c.className))
const floating = () => page.body.children.find(c => c.className === 'trd-floating-mic')

test('the microphone in Tabby\'s header shows whatever tab is in front, says who receives it, and its menu shows or stops each', () => {
    const { controls, desktop, calls, menus } = header()
    // In front: Tabby's settings, a tab with no desktop at all.
    desktop.users = [{ pane: alpha, name: 'alpha desktop', inView: false }]
    controls.refresh()
    assert.equal(group()!.style.display, 'flex')
    assert.equal(headerMicrophone()!.style.display, '')
    assert.equal(headerMicrophone()!.title, 'Microphone in use: alpha desktop is receiving it. Click to show the desktop, or to stop sending the microphone there.')
    assert.equal(floating(), undefined)
    desktop.users.push({ pane: beta, name: 'beta desktop', inView: true })
    controls.refresh()
    assert.match(headerMicrophone()!.title, /^Microphone in use: alpha desktop and beta desktop are receiving it\./)
    // Its menu, clicked.
    headerMicrophone()!.click()
    const items = menus.at(-1)!
    assert.deepEqual(items.map(i => i.type === 'separator' ? '—' : i.label), ['Microphone in use', '—', 'Show alpha desktop', 'Stop sending the microphone to alpha desktop',
        '—', 'Show beta desktop', 'Stop sending the microphone to beta desktop'])
    items[2].click()
    items[6].click()
    assert.deepEqual(calls, ['show alpha', 'stop beta'])
    // None any more: gone, and with nothing to switch in front, the whole group.
    desktop.users = []
    controls.refresh()
    assert.equal(headerMicrophone()!.style.display, 'none')
    assert.equal(group()!.style.display, 'none')
    // Tabby draws its header anew (a layout change): the controls are put back in it.
    group()!.remove()
    desktop.users = [{ pane: alpha, name: 'alpha desktop', inView: false }]
    controls.refresh()
    assert.equal(headerMicrophone()!.style.display, '')
})

test('in full screen, without Tabby\'s header, the microphone shows over the window for a desktop not in view', () => {
    const { controls, desktop, calls, menus } = header()
    page.tabBar = false
    try {
        desktop.users = [{ pane: alpha, name: 'alpha desktop', inView: false }]
        controls.refresh()
        const button = floating()!
        assert.ok(button, 'over the window')
        // At the top in the middle: in the corner it would take the clicks meant for the desktop in view, on a maximized
        // window's close button or on GNOME's system menu.
        assert.match(button.style.cssText, /^position: fixed; top: 8px; left: 50%; transform: translateX\(-50%\); z-index: 1040; width: 26px; height: 26px;/)
        assert.doesNotMatch(button.style.cssText, /right:/)
        // The note that typing goes into all desktops, there too, moves clear of it meanwhile (the service's style keys it on this).
        assert.equal(page.body.classList.contains('trd-floating-mic-on'), true)
        assert.equal(button.title, 'Microphone in use: alpha desktop is receiving it. Click to show the desktop, or to stop sending the microphone there.')
        button.click()
        menus.at(-1)!.find(i => i.label === 'Stop sending the microphone to alpha desktop').click()
        assert.deepEqual(calls, ['stop alpha'])
        // The desktop in view has its own dot: none over the window for it.
        desktop.users = [{ pane: alpha, name: 'alpha desktop', inView: true }]
        controls.refresh()
        assert.equal(floating(), undefined)
        assert.equal(page.body.classList.contains('trd-floating-mic-on'), false)
        desktop.users = [{ pane: alpha, name: 'alpha desktop', inView: false }, { pane: beta, name: 'beta desktop', inView: true }]
        controls.refresh()
        assert.equal(floating()!.title, 'Microphone in use: alpha desktop is receiving it. Click to show the desktop, or to stop sending the microphone there.')
        assert.equal(page.body.children.filter(c => c.className === 'trd-floating-mic').length, 1)
    } finally {
        page.tabBar = true
    }
    // Out of full screen: back in the header, and gone from over the window.
    controls.refresh()
    assert.equal(floating(), undefined)
    assert.equal(headerMicrophone()!.style.display, '')
})

test('the note that typing goes into all desktops, at the top in the middle too, moves below the microphone over the window', () => {
    const { installStyle } = require('../../dist/desktop.service.js')
    installStyle(new HostCompatibility({}))
    const css = (g.document.head as FakeElement).children.map(c => c.textContent).join('\n')
    assert.match(css, /\.trd-overlay\.trd-broadcast-on::before \{[^}]*position: absolute; top: 8px; left: 50%;\s*transform: translateX\(-50%\);/)
    const { controls, desktop } = header()
    page.tabBar = false
    try {
        desktop.users = [{ pane: alpha, name: 'alpha desktop', inView: false }]
        controls.refresh()
        const microphone = floating()!.style.cssText
        const bottom = Number(/top: (\d+)px/.exec(microphone)![1]) + Number(/height: (\d+)px/.exec(microphone)![1])
        // While it shows, the body says so, and the note's top is below where it ends.
        assert.equal(page.body.classList.contains('trd-floating-mic-on'), true)
        const moved = /\.trd-floating-mic-on \.trd-overlay\.trd-broadcast-on::before \{ top: (\d+)px; \}/.exec(css)
        assert.ok(moved && Number(moved[1]) > bottom, `the note at ${moved?.[1]}px, the microphone down to ${bottom}px`)
    } finally {
        page.tabBar = true
    }
})

/** A connected desktop's actions in the menus, over a stand-in service: the microphone setting `on`, and stopped or not. */
function actions (on: boolean, stopped: boolean) {
    const calls: string[] = []
    const desktop = {
        desktopOf: () => ({ id: '10.0.0.5:3389', name: 'Win', kind: 'windows' }),
        isConnected: () => true,
        isViewOnly: () => false,
        settings: () => ({ microphone: on }),
        microphoneStoppedFor: () => stopped,
        stopMicrophone: () => calls.push('stop'),
        resumeMicrophone: () => calls.push('send again'),
    }
    const item = desktopActions(desktop, {}, alpha).find((i: any) => /microphone/i.test(i.label ?? ''))
    return { item, calls }
}

test('a desktop\'s menu turns its microphone off and on again, while the setting sends it', () => {
    const sending = actions(true, false)
    assert.deepEqual([sending.item.type, sending.item.label, sending.item.checked], ['checkbox', 'Send the microphone (when this desktop asks for it)', true])
    sending.item.click()
    assert.deepEqual(sending.calls, ['stop'])
    const stopped = actions(true, true)
    assert.equal(stopped.item.checked, false)
    stopped.item.click()
    assert.deepEqual(stopped.calls, ['send again'])
    // With the setting off, no desktop gets it: nothing to switch.
    assert.equal(actions(false, false).item, undefined)
})

test('a desktop\'s menu offers paste and typing into all as the desktops showing count, and Type into all while it is on', async () => {
    const { RemoteDesktopContextMenu } = require('../../dist/ui.js')
    const items = async (showing: number, broadcast: boolean) => {
        const calls: string[] = []
        const desktop = {
            has: () => true,
            isConnected: () => true,
            isVisible: () => true,
            hasConsole: () => false,
            choicesOf: () => ({ specs: [], current: null }),
            vmsCut: () => false,
            desktopOf: () => ({ id: '10.0.0.5:3389', name: 'Win', kind: 'windows' }),
            canSaveFoundDesktop: () => false,
            isViewOnly: () => false,
            microphoneStoppedFor: () => false,
            canSignInAgain: () => false,
            settings: () => ({ resize: 'live', zoom: 'fit', sharpness: 'standard', clipboard: 'both', microphone: false }),
            ownSharpness: () => null,
            clipboardCapOf: () => 'both',
            configuredDesktops: () => [],
            desktopsInTab: () => showing,
            isBroadcast: () => broadcast,
            setBroadcast: (_: unknown, on: boolean) => calls.push(`typing into all ${on ? 'on' : 'off'}`),
            pasteToAll: () => calls.push('paste to all'),
        }
        const menu = new RemoteDesktopContextMenu(desktop, { cached: () => null, targetOf: async () => null }, {}, {}, { tabs: [] }, {})
        const all = (await menu.getItems({ profile: { type: 'rdp' }, element: { nativeElement: {} } }) as any[])
            .filter(i => /all .*desktops in this tab/.test(i.label ?? ''))
        return { labels: all.map(i => `${i.label}${i.type === 'checkbox' ? ` [${i.checked ? 'x' : ' '}]` : ''}`), click: (n: number) => all[n].click(), calls }
    }
    assert.deepEqual((await items(3, false)).labels, ['Paste to all 3 desktops in this tab', 'Type into all 3 desktops in this tab [ ]'])
    assert.deepEqual((await items(1, false)).labels, [])
    // On, while the others' consoles are in front: it can still be turned off from here.
    const on = await items(1, true)
    assert.deepEqual(on.labels, ['Type into all desktops in this tab [x]'])
    on.click(0)
    assert.deepEqual(on.calls, ['typing into all off'])
})

test('the Clipboard menu says when the desktop open in the pane has a setting of its own, which it doesn\'t change', () => {
    const clipboardMenu = (spec: object | null, cap = 'both', setting = 'both') => {
        const desktop = {
            settings: () => ({ resize: 'live', zoom: 'fit', sharpness: 'standard', clipboard: setting, microphone: false }),
            desktopOf: () => spec,
            ownSharpness: () => null,
            clipboardCapOf: () => cap,
            hasConsole: () => true,
            configuredDesktops: () => [],
        }
        return settingsMenu(desktop, alpha).find((i: any) => i.label === 'Clipboard (applies on the next connect)').submenu
    }
    // Its own, from its profile (or the profile's group's or type's defaults) or its entry behind a host.
    const own = clipboardMenu({ id: '10.0.0.5:3389', name: 'Win', clipboard: 'off' })
    assert.deepEqual([own[0].label, own[0].enabled, own[1].type], ['Win doesn\'t follow this: its profile or its own settings say off', false, 'separator'])
    assert.deepEqual(own.slice(2).map((i: any) => [i.label, i.checked]), [['Both ways', true], ['Only from the remote desktop to this computer', false], ['Off', false]])
    // Narrowed while it was open, by another way of opening it: said too, as the note at the time said.
    const capped = clipboardMenu({ id: '10.0.0.5:3389', name: 'Win' }, 'off')
    assert.deepEqual([capped[0].label, capped[0].enabled, capped[1].type],
        ['Clipboard sharing with Win is off until it is closed, as another way of opening it asked', false, 'separator'])
    // Only where that narrows it: not for one whose own setting, or the setting it follows, is off anyway.
    const ownOff = clipboardMenu({ id: '10.0.0.5:3389', name: 'Win', clipboard: 'off' }, 'fromRemote')
    assert.deepEqual(ownOff.map((i: any) => i.label ?? i.type),
        ['Win doesn\'t follow this: its profile or its own settings say off', 'separator', 'Both ways', 'Only from the remote desktop to this computer', 'Off'])
    assert.deepEqual(clipboardMenu({ id: '10.0.0.5:3389', name: 'Win' }, 'fromRemote', 'off').map((i: any) => i.label),
        ['Both ways', 'Only from the remote desktop to this computer', 'Off'])
    // Narrower than its own setting: said as the narrower one.
    const narrower = clipboardMenu({ id: '10.0.0.5:3389', name: 'Win', clipboard: 'fromRemote' }, 'off')
    assert.equal(narrower[1].label, 'Clipboard sharing with Win is off until it is closed, as another way of opening it asked')
    // Following the setting, or no desktop open: only the setting's choices.
    for (const spec of [{ id: '10.0.0.5:3389', name: 'Win' }, null]) {
        assert.deepEqual(clipboardMenu(spec).map((i: any) => i.label), ['Both ways', 'Only from the remote desktop to this computer', 'Off'])
    }
})

test('the settings page lists a profile\'s clipboard as it connects with it: its own, else its group\'s or the type\'s default', () => {
    const profiles = [
        { id: 'rdp:custom:a:1', type: 'rdp', name: 'Own', group: 'g1', options: { host: '10.0.0.5', port: 3389, clipboard: 'fromRemote' } },
        { id: 'rdp:custom:b:1', type: 'rdp', name: 'Grouped', group: 'g1', options: { host: '10.0.0.6', port: 3389 } },
        { id: 'rdp:custom:c:1', type: 'rdp', name: 'Plain', options: { host: '10.0.0.7', port: 3389 } },
    ]
    const groups = [{ id: 'g1', name: 'Remote desktops', defaults: { rdp: { options: { clipboard: 'off' } } } }]
    // Tabby's proxy of a profile: what it sets, else its group's default.
    const proxy = (p: any) => ({ ...p, options: { clipboard: '', ...groups.find(g => g.id === p.group)?.defaults.rdp.options, ...p.options } })
    let rows: FakeElement[] = []
    const list = { replaceChildren: (...children: FakeElement[]) => { rows = children } }
    const element = { nativeElement: { querySelector: (selector: string) => selector === '[data-list=desktops]' ? list : null } }
    const desktop = { accounts: () => [], configuredDesktops: () => [] }
    const injector = { get: () => ({ getConfigProxyForProfile: proxy }) }
    const settings = new RemoteDesktopSettingsComponent(element, desktop, {}, { store: { profiles, groups } }, {}, injector, zone, {}, new HostCompatibility({}))
    settings.renderDesktops()
    assert.deepEqual(rows.slice(0, 3).map(row => /Clipboard: ([^<]*)/.exec(row.innerHTML)?.[1] ?? null),
        ['only from the remote desktop to this computer', 'off', null])
})

test('the settings page says which hosts a desktop added from an SSH tab is for: those without a profile, such as ssh run in a local terminal', () => {
    // The page as it is written (nothing after that is needed here).
    let html = ''
    const root = { set innerHTML (text: string) { html = text; throw new Error('written') } }
    const settings = new RemoteDesktopSettingsComponent({ nativeElement: root }, {}, {}, { store: {} }, {}, {}, zone, {}, new HostCompatibility({}))
    assert.throws(() => settings.render(), /written/)
    // Not "an ssh typed in a terminal", which reads as an SSH tab's console, whose machines get no desktops of the tab's host.
    assert.equal(/data-tip="(A desktop added from an SSH tab[^"]*)"/.exec(html)?.[1],
        'A desktop added from an SSH tab&#39;s menu belongs to that host. That is for hosts without a profile, such as ssh run in a local terminal.')
})

test('copied connection logs include host compatibility information before the connection entries', () => {
    const compat = new HostCompatibility({
        name: () => 'Tabbz Preview', version: () => '1.0.238-beta.1', platform: 'darwin', electron: '43.7.0', node: '22.0.0',
        terminalPackage: () => ({ devDependencies: { '@xterm/xterm': '^5' } }),
    })
    let copied = ''
    const platform = { setClipboard: ({ text }: { text: string }) => { copied = text } }
    const settings = new RemoteDesktopSettingsComponent({}, {}, {}, {}, platform, {}, zone, {}, compat)
    settings.copyLog('Test desktop', ['connected: test desktop', 'resized: 800x600'])
    const lines = copied.split('\n')
    assert.match(lines[0], /^tabby-rdp .+ on .+: Test desktop$/)
    assert.deepEqual(lines.slice(1, 5), compat.diagnosticLines())
    assert.deepEqual(lines.slice(5), ['connected: test desktop', 'resized: 800x600'])
})

test('only the plugin\'s own hotkeys act: a name every object inherits does nothing, and throws nothing', async () => {
    const { Subject } = require('rxjs')
    const RemoteDesktopModule = require('../../dist/index.js').default
    const hotkey$ = new Subject()
    const done: string[] = []
    // Every call the module makes on the service is recorded.
    const desktop = new Proxy({}, { get: (_, key) => (...args: unknown[]) => { done.push(String(key)); return key === 'has' ? true : undefined } })
    const ssh = { profile: { type: 'ssh' }, element: { nativeElement: {} } }
    const injector = { get: () => ({ start () { } }) }
    // eslint-disable-next-line no-new
    new RemoteDesktopModule({ activeTab: ssh }, { hotkey$ }, desktop, { install () { } }, {}, { install () { } }, injector)
    // A hotkey handler that throws does so outside the call (RxJS reports it later, as an uncaught exception).
    const thrown: unknown[] = []
    const caught = (e: unknown) => { thrown.push(e) }
    process.on('uncaughtException', caught)
    try {
        for (const id of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__']) {
            hotkey$.next(id)
        }
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.deepEqual([done, thrown], [[], []])
        // One of its own acts on the active tab's desktop.
        hotkey$.next('remote-desktop-disconnect')
        assert.deepEqual(done, ['has', 'disconnect'])
    } finally {
        process.off('uncaughtException', caught)
    }
})
