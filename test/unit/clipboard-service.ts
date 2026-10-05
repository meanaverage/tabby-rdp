// Clipboard sharing in the desktop service (src/desktop.service.ts) and where a remote desktop tab's desktop comes from
// (src/targets.ts), with Tabby's modules stubbed: open desktops narrow when the setting changes without the plugin
// changing it, nothing more goes to a desktop the settings keep it from (nor to one that isn't showing, for paste and
// typing into all, nor to one behind a pane maximized over it), a desktop opened more narrowly while it is open narrows,
// its reconnects included and when it is shown again after its server ended it, a remote desktop tab connects with its
// profile as saved now (a reconnect at a new size too), and an .rdp import leaves the clipboard to the profile's defaults
// unless the file turns it off, also for a profile there already is. The service's own methods run on a stand-in config;
// nothing connects. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Electron's clipboard, as FileTransfer reads files copied here from it (Finder's, Files' formats). */
const copied: string[] = []
const electron = {
    clipboard: {
        read: (format: string) => !copied.length ? ''
            : format === 'NSFilenamesPboardType' ? `<plist><array>${copied.map(p => `<string>${p}</string>`).join('')}</array></plist>`
                : format === 'x-special/gnome-copied-files' ? ['copy', ...copied.map(p => pathToFileURL(p).href)].join('\n') : '',
        readBuffer: () => Buffer.alloc(0),
    },
}

// Tabby and Angular, as far as loading the service needs them; and Electron.
const decorator = () => () => undefined
const stubs: Record<string, unknown> = {
    '@angular/core': { Injectable: decorator, Component: decorator, NgZone: class { }, ViewEncapsulation: {} },
    'tabby-core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-settings': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-terminal': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    electron,
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { Subject } = require('rxjs')
const { RemoteDesktopService } = require('../../dist/desktop.service.js')
const { RemoteTargets } = require('../../dist/targets.js')
const { RDPProfilesService } = require('../../dist/rdpProfile.js')
const { ownClipboard } = require('../../dist/clipboard.js')

const settle = async () => {
    for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setImmediate(resolve))
    }
}

/**
 * Tabby's proxy of a profile (ProfilesService.getConfigProxyForProfile), as far as its options go: what is saved, else
 * its group's default for the type, else the type's (Settings › Profiles › defaults).
 */
function withDefaults (profile: any, groups: any[] = [], typeDefaults: Record<string, unknown> = {}) {
    const group = groups.find(g => g.id === profile.group)?.defaults?.rdp?.options ?? {}
    const options: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(profile.options ?? {}), ...Object.keys(group), ...Object.keys(typeDefaults)])) {
        Object.defineProperty(options, key, { enumerable: true, get: () => profile.options?.[key] ?? group[key] ?? typeDefaults[key] })
    }
    return { ...profile, options }
}

/** The service on a config of its own (`remoteDesktop` as given), with what else these tests hand it. */
function service (remoteDesktop: Record<string, unknown> = {}, deps: { profiles?: unknown, platform?: unknown } = {}) {
    const changed = new Subject()
    const config: any = {
        store: { remoteDesktop: { desktops: [], accounts: [], ...remoteDesktop }, profiles: [], groups: [] },
        changed$: changed,
        save () { },
    }
    const notified: string[] = []
    const notifications = { notice: (m: string) => notified.push(m), info: (m: string) => notified.push(m), error: (m: string) => notified.push(m) }
    const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
    const svc = new RemoteDesktopService({ tabs: [] }, {}, notifications, config, zone, deps.profiles ?? {}, {}, {}, deps.platform ?? {})
    return { svc, config, changed, notified }
}

/** An open desktop as the clipboard's checks see it: how its connection was set up, and its own setting if any. */
function desktop (clipboard: string, own?: string) {
    return {
        state: 'connected', viewOnly: false, visible: false, key: 'rdp#10.0.0.5:3389', log: [] as string[], clipboard, clipboardCap: 'both',
        spec: { id: '10.0.0.5:3389', name: 'Win', ...own ? { clipboard: own } : {} },
        stops: 0,
        stopSending () { this.stops++ },
    }
}

test('open desktops that follow the setting narrow when it changes in another window, the config file or by sync', () => {
    const { svc, config, changed } = service({ clipboard: 'both' })
    const follows = desktop('both')
    const own = desktop('both', 'both')
    svc.sessions.set({}, follows)
    svc.sessions.set({}, own)
    // Saved in another window: Tabby loads it and says it changed, and that is all.
    config.store.remoteDesktop.clipboard = 'fromRemote'
    changed.next()
    assert.deepEqual([follows.clipboard, follows.stops], ['fromRemote', 1])
    assert.match(follows.log.join('\n'), /clipboard: only from the remote desktop from now on/)
    // One with a setting of its own keeps it.
    assert.deepEqual([own.clipboard, own.stops], ['both', 0])
    // Settings › Config file, or a load from elsewhere, puts a new store in place.
    config.store = { ...config.store, remoteDesktop: { ...config.store.remoteDesktop, clipboard: 'off' } }
    changed.next()
    assert.equal(follows.clipboard, 'off')
    // Widening waits for the next connection.
    config.store.remoteDesktop.clipboard = 'both'
    changed.next()
    assert.equal(follows.clipboard, 'off')
})

test('a paste of files ending starts the reading of this computer\'s clipboard again only while the settings let it go', async () => {
    const { svc, config } = service({ clipboard: 'both' })
    // The component, put in the layer, says it is ready and hands over its API; the provider is IronRDP's, stubbed.
    let ready: (event: unknown) => void = () => { }
    const element = { setAttribute () { }, addEventListener: (_: string, handler: (event: unknown) => void) => { ready = handler } }
    ;(globalThis as any).document = { createElement: () => element }
    const calls: string[] = []
    const ui = {
        enableFileTransfer (provider: any) {
            provider.onUploadStarted = () => calls.push('suppress')
            provider.onUploadFinished = () => calls.push('resume')
        },
        setEnableClipboard () { },
    }
    const rdp = { Backend: {}, RdpFileTransferProvider: class { handleFileContentsRequest () { } on () { } dispose () { } } }
    const session: any = {
        ...desktop('off'),
        // Not closed while it connects (run() stops waiting for the component once it is).
        disposed: new Promise<void>(() => { }),
        host: { replaceChildren: () => ready({ detail: { irgUserInteraction: ui } }) },
        // The connection stops here, once the clipboard is set up.
        overlay: { addEventListener () { }, removeEventListener () { }, classList: { remove () { } }, getBoundingClientRect () { throw new Error('stopped here') } },
        files: null,
    }
    // The pane's desktop, as a connecting one is: run() stops for one closed (or replaced) meanwhile.
    const pane = {}
    svc.sessions.set(pane, session)
    const outcome = await svc.run(pane, { key: 'rdp', label: 'Win' }, session.spec, session, rdp, { credentials: { username: 'u', password: 'p' } })
    assert.equal(outcome.error, 'stopped here')
    assert.equal(session.clipboard, 'both')
    session.files.provider.onUploadFinished()
    assert.deepEqual(calls, ['resume'])
    // The setting narrows elsewhere, and a paste of files ends before Tabby says so: the reading stays stopped.
    config.store.remoteDesktop.clipboard = 'fromRemote'
    session.files.provider.onUploadFinished()
    assert.deepEqual(calls, ['resume'])
})

/**
 * run() as far as the clipboard is set up, for a desktop with its own clipboard (`own`, or none) under the setting
 * `setting`, the component stubbed: the mode the connection gets, and what was turned off in the component.
 */
async function setUpFor (setting: string, own?: string): Promise<{ mode: string, calls: string[] }> {
    const { svc } = service({ clipboard: setting })
    let ready: (event: unknown) => void = () => { }
    const element = { setAttribute () { }, addEventListener: (_: string, handler: (event: unknown) => void) => { ready = handler } }
    ;(globalThis as any).document = { createElement: () => element }
    const calls: string[] = []
    const ui = {
        enableFileTransfer (provider: any) {
            provider.onUploadStarted = () => calls.push('suppress')
            provider.onUploadFinished = () => calls.push('resume')
        },
        setEnableClipboard (enable: boolean) { calls.push(`setEnableClipboard(${enable})`) },
    }
    const rdp = { Backend: {}, RdpFileTransferProvider: class { handleFileContentsRequest () { } on () { } dispose () { } } }
    const session: any = {
        ...desktop('off', own),
        disposed: new Promise<void>(() => { }),
        host: { replaceChildren: () => ready({ detail: { irgUserInteraction: ui } }) },
        overlay: { addEventListener () { }, removeEventListener () { }, classList: { remove () { } }, getBoundingClientRect () { throw new Error('stopped here') } },
        files: null,
    }
    // The pane's desktop, as a connecting one is: run() stops for one closed (or replaced) meanwhile.
    const pane = {}
    svc.sessions.set(pane, session)
    const outcome = await svc.run(pane, { key: 'rdp', label: 'Win' }, session.spec, session, rdp, { credentials: { username: 'u', password: 'p' } })
    assert.equal(outcome.error, 'stopped here')
    return { mode: session.clipboard, calls }
}

test('a connection is set up with the desktop\'s own clipboard where it has one, in place of the setting', async () => {
    assert.deepEqual(await setUpFor('both', 'off'), { mode: 'off', calls: ['suppress', 'setEnableClipboard(false)'] })
    assert.deepEqual(await setUpFor('both', 'fromRemote'), { mode: 'fromRemote', calls: ['suppress'] })
    assert.deepEqual(await setUpFor('off', 'both'), { mode: 'both', calls: [] })
    // Without one of its own, the setting's.
    assert.deepEqual(await setUpFor('fromRemote'), { mode: 'fromRemote', calls: ['suppress'] })
})

test('a desktop configured twice behind a host is merged against the setting as it is now', () => {
    const { svc, config } = service({ clipboard: 'fromRemote', desktops: [{ via: 'host', host: '127.0.0.1', port: 3389, clipboard: 'both' }] },
        // Tabby's proxy of a profile: the type's default ('') for what the profile doesn't set.
        { profiles: { getConfigProxyForProfile: (p: any) => ({ ...p, options: { clipboard: '', ...p.options } }) } })
    config.store.profiles = [{ id: 'rdp:custom:win:1', type: 'rdp', name: 'Win', options: { host: '127.0.0.1', port: 3389, via: 'ssh:custom:host:1' } }]
    const target = { key: 'alice@host:22', label: 'host', hostname: 'host', profileId: 'ssh:custom:host:1' }
    // The entry says both ways, the profile follows the setting: only from the remote, as the setting is now.
    assert.equal(svc.desktopsOf(target).find((s: any) => s.id === '127.0.0.1:3389').clipboard, 'fromRemote')
    config.store.remoteDesktop.clipboard = 'off'
    assert.equal(svc.desktopsOf(target).find((s: any) => s.id === '127.0.0.1:3389').clipboard, 'off')
})

test('a new RDP profile made from the template follows the clipboard of its type\'s and its group\'s defaults', async () => {
    const [template] = await new RDPProfilesService({}, { store: {} }).getBuiltinProfiles()
    // Tabby's New profile: a copy of the template without its id; the editor then saves only what was changed.
    const { id: _id, isBuiltin: _builtin, isTemplate: _template, ...copy } = JSON.parse(JSON.stringify(template))
    const profile = { ...copy, name: 'Office PC', options: { ...copy.options, host: '10.0.0.5' } }
    assert.ok(!('clipboard' in profile.options), JSON.stringify(profile.options))
    // Default profile settings › Remote desktop (RDP) › Clipboard: Off.
    assert.equal(ownClipboard(withDefaults(profile, [], { clipboard: 'off' }).options.clipboard), 'off')
    // The "Remote desktops" group's (the settings page's New profile… puts it there before the editor opens).
    const groups = [{ id: 'g1', name: 'Remote desktops', defaults: { rdp: { options: { clipboard: 'fromRemote' } } } }]
    assert.equal(ownClipboard(withDefaults({ ...profile, group: 'g1' }, groups).options.clipboard), 'fromRemote')
    // No defaults: none of its own, so the setting's.
    assert.equal(ownClipboard(withDefaults(profile).options.clipboard), undefined)
})

/** An element of the page, as far as a desktop's layer (DesktopSession) uses one. */
class LayerElement {
    className = ''
    innerHTML = ''
    readonly style: Record<string, string> = {}
    private readonly classes = new Set<string>()
    readonly classList = {
        add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
        toggle: (name: string, on = !this.classes.has(name)) => { on ? this.classes.add(name) : this.classes.delete(name) },
        contains: (name: string) => this.classes.has(name),
    }
    private readonly found = new Map<string, LayerElement>()
    querySelector (selector: string): LayerElement {
        if (!this.found.has(selector)) {
            this.found.set(selector, new LayerElement())
        }
        return this.found.get(selector)!
    }
    querySelectorAll (): LayerElement[] { return [] }
    addEventListener (): void { }
    removeEventListener (): void { }
    appendChild (child: LayerElement): LayerElement { return child }
    replaceChildren (): void { }
    contains (): boolean { return false }
    remove (): void { }
    focus (): void { }
    getBoundingClientRect () { return { width: 0, height: 0 } }
}

test('a desktop asked for with a narrower clipboard while it is open elsewhere narrows the open one, its reconnects included', async () => {
    const { svc, config } = service({ clipboard: 'both' })
    const pane = () => ({ element: { nativeElement: new LayerElement() }, destroyed$: new Subject(), focused$: new Subject() })
    const open = pane()
    const asking = pane()
    svc.app.tabs.push(open, asking)
    svc.app.selectTab = () => { }
    svc.help = { tipOnce () { }, note () { } }
    ;(globalThis as any).document = { createElement: () => new LayerElement(), activeElement: null, visibilityState: 'visible' }
    ;(globalThis as any).getComputedStyle = () => ({ position: 'relative' })
    // The desktop's connections, as the service starts them (not made here).
    const connected: any[] = []
    svc.connect = (_: unknown, target: unknown, _spec: unknown, session: any) => {
        connected.push(session)
        Object.assign(session, { remote: target, state: 'connected', clipboard: svc.settingsFor(session).clipboard, stops: 0, stopSending () { this.stops++ } })
    }
    const toasts: string[] = []
    let revoked = 0
    const files = { toast: (text: string) => toasts.push(text), revoke: () => revoked++, dispose () { } }
    const target = (spec: object) => ({ key: 'rdp', label: 'Win', direct: { id: '10.0.0.5:3389', name: 'Win', ...spec }, isOpen: () => true })
    await svc.showDesktop(open, undefined, { target: target({}), background: true })
    const first = connected[0]
    first.files = files
    assert.equal(first.clipboard, 'both')
    // Another profile for the same desktop, or an .rdp file's: one desktop per server, so the open one comes forward.
    await svc.showDesktop(asking, undefined, { target: target({ name: 'Win (shared)', clipboard: 'off' }) })
    assert.deepEqual([svc.sessions.has(asking), connected.length], [false, 1])
    assert.deepEqual([first.clipboard, first.stops, revoked], ['off', 1, 1])
    assert.deepEqual(toasts, ['Clipboard sharing with this desktop is now off, as Win (shared) has it, until it is closed. ' +
        'The change applies in full once the desktop reconnects.'])
    // A wider one doesn't widen it, nor does the setting.
    await svc.showDesktop(asking, undefined, { target: target({ name: 'Win' }) })
    config.store.remoteDesktop.clipboard = 'both'
    assert.deepEqual([first.clipboard, svc.settingsFor(first).clipboard, toasts.length], ['off', 'off', 1])
    // The server drops the connection, and the plugin connects again by itself (as it does a second after the drop):
    // the connection made in its place is set up off as well.
    await svc.reopen(open, first.spec, true)
    assert.equal(connected.length, 2)
    const second = connected[1]
    assert.deepEqual([svc.sessions.get(open) === second, second.clipboardCap, second.clipboard], [true, 'off', 'off'])
    // Reconnecting at a new size (the resize setting) keeps to it too.
    const reopened: any[] = []
    svc.showDesktop = async (_: unknown, _id: unknown, options: unknown) => { reopened.push(options) }
    Object.assign(second, { visible: true, remoteSize: { width: 800, height: 600, scale: 100 } })
    second.overlay.getBoundingClientRect = () => ({ width: 1024, height: 768 })
    config.store.remoteDesktop.resize = 'reconnect'
    svc.followPane(open, second)
    assert.equal(reopened[0]?.clipboardCap, 'off')
    svc.disconnect(open)
})

test('a desktop narrowed while it was open keeps to it when it is shown again after its server ended it, and view only too', async () => {
    const { svc } = service({ clipboard: 'both' })
    const pane = () => ({ element: { nativeElement: new LayerElement() }, destroyed$: new Subject(), focused$: new Subject() })
    const open = pane()
    const asking = pane()
    svc.app.tabs.push(open, asking)
    svc.app.selectTab = () => { }
    svc.help = { tipOnce () { }, note () { } }
    ;(globalThis as any).document = { createElement: () => new LayerElement(), activeElement: null, visibilityState: 'visible' }
    ;(globalThis as any).getComputedStyle = () => ({ position: 'relative' })
    const connected: any[] = []
    svc.connect = (_: unknown, target: unknown, _spec: unknown, session: any) => {
        connected.push(session)
        Object.assign(session, { remote: target, state: 'connected', clipboard: svc.settingsFor(session).clipboard, stopSending () { } })
    }
    const files = { toast () { }, revoke () { }, dispose () { } }
    const target = (spec: object) => ({ key: 'rdp', label: 'Win', direct: { id: '10.0.0.5:3389', name: 'Win', ...spec }, isOpen: () => true })
    svc.targets = { targetOf: async () => target({}), cached: () => target({}) }
    await svc.showDesktop(open, undefined, { target: target({}), background: true })
    connected[0].files = files
    // Another profile for the same desktop, with the clipboard off: the open one narrows to it.
    await svc.showDesktop(asking, undefined, { target: target({ name: 'Win (shared)', clipboard: 'off' }) })
    assert.deepEqual([connected[0].clipboardCap, connected[0].clipboard], ['off', 'off'])
    // And view only, which keeps what is typed in the pane from going to it.
    svc.setViewOnly(open, true)
    // The server ends the session, as it can whenever it likes: "Remote desktop session ended", with Reconnect. Shown
    // again with the Desktop toggle (or its hotkey), or picked in the menu, it connects anew, still off.
    for (const how of ['the Desktop toggle', 'the menu']) {
        const ended = svc.sessions.get(open)
        svc.afterEnd(open, ended.remote, ended.spec, ended, { connected: true, reason: 'logged off' })
        assert.equal(ended.state, 'ended', how)
        if (how === 'the Desktop toggle') {
            svc.showConsole(open)
            await svc.toggle(open)
        } else {
            await svc.showDesktop(open, ended.spec.id)
        }
        const now = svc.sessions.get(open)
        assert.notEqual(now, ended, how)
        assert.deepEqual([now.clipboardCap, now.clipboard], ['off', 'off'], how)
        assert.equal(now.viewOnly, true, how)
        now.files = files
    }
    svc.disconnect(open)
})

test('a reconnect at a new size in a remote desktop tab connects with its profile as saved, as Reconnect does', async () => {
    const { svc, config, notified } = service({ clipboard: 'both', resize: 'reconnect' })
    const saved: any = { id: 'rdp:custom:win:1', type: 'rdp', name: 'Win', options: { host: '10.0.0.5', port: 3389, clipboard: 'both' } }
    config.store.profiles = [saved]
    svc.targets = new RemoteTargets(config, { getConfigProxyForProfile: (p: any) => withDefaults(p) })
    svc.help = { tipOnce () { }, note () { } }
    ;(globalThis as any).document = { createElement: () => new LayerElement(), activeElement: null, visibilityState: 'visible' }
    ;(globalThis as any).getComputedStyle = () => ({ position: 'relative' })
    const connected: any[] = []
    svc.connect = (_: unknown, target: any, spec: any, session: any) => {
        connected.push({ session, address: spec.id })
        Object.assign(session, { remote: target, state: 'connected', clipboard: svc.settingsFor(session).clipboard, stopSending () { } })
    }
    // The tab holds the profile as Tabby opened it.
    const tab = { profile: { ...saved, options: { ...saved.options } }, element: { nativeElement: new LayerElement() }, destroyed$: new Subject(), focused$: new Subject() }
    svc.app.tabs.push(tab)
    await svc.showDesktop(tab)
    const first = connected[0].session
    assert.equal(first.clipboard, 'both')
    // Saved with the clipboard off and another address while the tab is open; then the pane changes size.
    saved.options = { host: '10.0.0.6', port: 3389, clipboard: 'off' }
    Object.assign(first, { remoteSize: { width: 800, height: 600, scale: 100 } })
    first.overlay.getBoundingClientRect = () => ({ width: 1024, height: 768 })
    svc.followPane(tab, first)
    await settle()
    assert.equal(connected.length, 2)
    assert.deepEqual([connected[1].address, connected[1].session.clipboard], ['10.0.0.6:3389', 'off'])
    // Saved to go through an SSH profile: not connected from the tab any more.
    const second = connected[1].session
    saved.options = { host: '127.0.0.1', port: 3389, via: 'ssh:custom:host:1' }
    Object.assign(second, { remoteSize: { width: 800, height: 600, scale: 100 } })
    second.overlay.getBoundingClientRect = () => ({ width: 1024, height: 768 })
    svc.followPane(tab, second)
    await settle()
    assert.equal(connected.length, 2)
    assert.match(notified.at(-1) ?? '', /^Win no longer connects directly: open it from the profile list$/)
    svc.disconnect(tab)
})

test('a reconnect at a new size in an SSH tab connects the same desktop, not the host\'s last used one in another pane', async () => {
    const { svc } = service({ resize: 'reconnect', desktops: [{ via: 'h', host: '10.0.0.5', name: 'Five' }, { via: 'h', host: '10.0.0.6', name: 'Six' }] })
    svc.help = { tipOnce () { }, note () { } }
    ;(globalThis as any).document = { createElement: () => new LayerElement(), activeElement: null, visibilityState: 'visible' }
    ;(globalThis as any).getComputedStyle = () => ({ position: 'relative' })
    const connected: any[] = []
    svc.connect = (_: unknown, target: any, spec: any, session: any) => {
        connected.push({ session, address: spec.id })
        Object.assign(session, { remote: target, state: 'connected', clipboard: svc.settingsFor(session).clipboard, stopSending () { } })
    }
    const target = { key: 'alice@h:22', label: 'h', isOpen: () => true }
    svc.targets = { targetOf: async () => target, cached: () => target }
    const pane = () => ({ profile: { type: 'ssh' }, element: { nativeElement: new LayerElement() }, destroyed$: new Subject(), focused$: new Subject() })
    // .5 in one pane of the host's tab, then .6 in another, which makes .6 the host's last used.
    const first = pane()
    const second = pane()
    svc.app.tabs.push(first, second)
    svc.app.selectTab = () => { }
    await svc.showDesktop(first, '10.0.0.5:3389', { target })
    await svc.showDesktop(second, '10.0.0.6:3389', { target })
    const five = connected[0].session
    Object.assign(five, { remoteSize: { width: 800, height: 600, scale: 100 } })
    five.overlay.getBoundingClientRect = () => ({ width: 1024, height: 768 })
    svc.followPane(first, five)
    await settle()
    assert.deepEqual(connected.map(c => c.address), ['10.0.0.5:3389', '10.0.0.6:3389', '10.0.0.5:3389'])
    assert.equal(svc.sessions.get(first)?.spec.id, '10.0.0.5:3389')
    svc.disconnect(first)
    svc.disconnect(second)
})

test('paste to all desktops leaves out a desktop this computer\'s clipboard doesn\'t go to, and sends it nothing', async () => {
    const { svc, config, notified } = service({ clipboard: 'fromRemote' })
    const sent: string[] = []
    const session = {
        ...desktop('both'),
        visible: true,
        ui: { sendClipboardData: async () => { sent.push('clipboard') }, ctrlV: () => sent.push('Ctrl+V') },
        // Shown over the desktop, which is in view.
        files: { pasteClipboardFiles: () => { sent.push('files'); return false }, clipboardAnswered: async () => true, toast: (m: string) => notified.push(m) },
    }
    const pane = {}
    svc.sessions.set(pane, session)
    assert.equal(svc.pasteToAll(pane), 0)
    await settle()
    assert.deepEqual(sent, [])
    assert.deepEqual(notified, ['Not pasted: this desktop doesn\'t take this computer\'s clipboard.'])
    assert.equal(await svc.sendClipboard(session), false)
    assert.deepEqual(sent, [])
    // Where it goes: files looked for, the clipboard sent, then Ctrl+V.
    config.store.remoteDesktop.clipboard = 'both'
    assert.equal(svc.pasteToAll(pane), 1)
    await settle()
    assert.deepEqual(sent, ['files', 'clipboard', 'Ctrl+V'])
})

test('paste to all, with copied files none of which can go: nothing pasted, and the log doesn\'t say the remote refused them', { skip: process.platform === 'win32' }, async t => {
    const { svc } = service({ clipboard: 'both' })
    // FileTransfer itself, over IronRDP's own provider (its WebAssembly initialised), on a stand-in layer.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const rdp = await import(pathToFileURL(root + 'vendor/iron-remote-desktop-rdp.js').href)
    await rdp.init('ERROR', fs.readFileSync(root + 'vendor/ironrdp_web_bg.wasm'))
    const { FileTransfer } = require('../../dist/fileTransfer.js')
    const element = () => ({ className: '', textContent: '', title: '', append () { }, addEventListener () { }, remove () { } })
    ;(globalThis as any).document = { createElement: element }
    const layer = { addEventListener () { }, removeEventListener () { }, contains: () => false, classList: { add () { }, remove () { }, toggle () { } }, appendChild () { } }
    // A copied folder that holds nothing but a link to outside it, which isn't sent (see entriesFor).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-paste-all-'))
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    fs.mkdirSync(path.join(home, '.ssh'))
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
    fs.mkdirSync(path.join(home, 'report'))
    fs.symlinkSync('../.ssh', path.join(home, 'report', 'attachments'))
    copied.splice(0, copied.length, path.join(home, 'report'))
    t.after(() => copied.splice(0))
    const sent: string[] = []
    const session: any = { ...desktop('both'), visible: true, ui: { sendClipboardData: async () => { sent.push('clipboard') }, ctrlV: () => sent.push('Ctrl+V') } }
    session.files = new FileTransfer(rdp, layer, (m: string) => session.log.push(m), () => ({ toRemote: true, fromRemote: true }))
    t.after(() => session.files.dispose())
    session.files.provider.setSession({ invokeExtension () { } })
    const pane = {}
    svc.sessions.set(pane, session)
    assert.equal(svc.pasteToAll(pane), 1)
    await settle()
    // Neither the clipboard nor Ctrl+V: the remote would paste what it had.
    assert.deepEqual(sent, [])
    assert.ok(session.log.includes('files: nothing to send'), session.log.join('\n'))
    assert.deepEqual(session.log.filter((m: string) => /refused/.test(m)), [])
    assert.ok(session.log.includes('paste to all desktops: no Ctrl+V: none of the files copied here could be sent'), session.log.join('\n'))
})

test('paste to all desktops: Ctrl+V goes only where a paste from here is still taken once the remote has the clipboard', async () => {
    const { svc, config } = service({ clipboard: 'both' })
    // Each desktop takes the new clipboard in its own time; meanwhile the setting narrows, one goes view only, and one
    // is hidden behind its console.
    const answers: (() => void)[] = []
    const desktops = ['A', 'B', 'C', 'D'].map(name => {
        const sent: string[] = []
        const session: any = {
            ...desktop('both'),
            visible: true,
            spec: { id: `${name}:3389`, name },
            sent,
            ui: { sendClipboardData: async () => { sent.push('clipboard') }, ctrlV: () => sent.push('Ctrl+V') },
            files: {
                pasteClipboardFiles: () => false,
                clipboardAnswered: () => new Promise<boolean>(resolve => answers.push(() => resolve(true))),
            },
        }
        const pane = {}
        svc.sessions.set(pane, session)
        return { pane, session }
    })
    // One pane at a time (no split here): each gets its own paste.
    desktops.forEach(({ pane }) => assert.equal(svc.pasteToAll(pane), 1))
    await settle()
    assert.deepEqual(desktops.map(d => d.session.sent), [['clipboard'], ['clipboard'], ['clipboard'], ['clipboard']])
    config.store.remoteDesktop.clipboard = 'fromRemote'
    desktops[0].session.clipboard = 'fromRemote'  // as applyClipboard narrows it
    desktops[1].session.viewOnly = true
    desktops[2].session.visible = false
    answers.forEach(answer => answer())
    await settle()
    assert.deepEqual(desktops.map(d => d.session.sent), [['clipboard'], ['clipboard'], ['clipboard'], ['clipboard']])
    assert.ok(desktops[0].session.log.some((m: string) => /no Ctrl\+V/.test(m)))
    // The last one: still taking it once the setting is back (as when it reconnects), but closed meanwhile.
    config.store.remoteDesktop.clipboard = 'both'
    const last = desktops[3]
    assert.equal(svc.pasteToAll(last.pane), 1)
    await settle()
    svc.sessions.delete(last.pane)
    answers.at(-1)!()
    await settle()
    assert.deepEqual(last.session.sent, ['clipboard', 'clipboard'])
})

test('paste to all desktops: no Ctrl+V for a desktop whose tab the user has left by the time the remote has the clipboard, though its layer still shows', async () => {
    const { svc } = service({ clipboard: 'both' })
    ;(globalThis as any).document = { createElement: () => new LayerElement(), activeElement: null, visibilityState: 'visible' }
    const answers: (() => void)[] = []
    const sent: string[] = []
    const session: any = {
        ...desktop('both'),
        visible: true,
        ui: { sendClipboardData: async () => { sent.push('clipboard') }, ctrlV: () => sent.push('Ctrl+V') },
        files: { pasteClipboardFiles: () => false, clipboardAnswered: () => new Promise<boolean>(resolve => answers.push(() => resolve(true))) },
    }
    const pane = {}
    const other = {}
    svc.app.tabs = [pane, other]
    svc.app.activeTab = pane
    svc.sessions.set(pane, session)
    // In its tab, which stays the one in front: Ctrl+V goes once the remote has the clipboard.
    assert.equal(svc.pasteToAll(pane), 1)
    await settle()
    answers.shift()!()
    await settle()
    assert.deepEqual(sent, ['clipboard', 'Ctrl+V'])
    // The user goes to another tab meanwhile (the layer of a tab in the background still shows): the clipboard went,
    // but Ctrl+V would go to a desktop out of view.
    sent.length = 0
    assert.equal(svc.pasteToAll(pane), 1)
    await settle()
    svc.app.activeTab = other
    answers.shift()!()
    await settle()
    assert.deepEqual(sent, ['clipboard'])
    assert.ok(session.log.some((m: string) => /no Ctrl\+V: the desktop stopped taking a paste from here meanwhile/.test(m)), session.log.join('\n'))
})

test('paste to all and type into all reach only the desktops showing, and the count says as many', async () => {
    const { svc } = service({ clipboard: 'both' })
    // A split tab of three panes, typing into all on. (Tabby's SplitTabComponent is a stand-in here, so the service is
    // told which split the panes are in.)
    const panes = [{}, {}, {}]
    const split = { getAllTabs: () => panes }
    const sent: string[][] = panes.map(() => [])
    panes.forEach((pane, i) => svc.sessions.set(pane, {
        ...desktop('both'),
        visible: i !== 2,
        spec: { id: `${i}:3389`, name: `D${i}` },
        keysDown: new Map(),
        noteKey (type: string, init: any) { type === 'keydown' ? this.keysDown.set(init.code, init) : this.keysDown.delete(init.code) },
        ui: {
            sendClipboardData: async () => { sent[i].push('clipboard') },
            ctrlV: () => sent[i].push('Ctrl+V'),
            sendKeyboardEvent: (event: KeyboardEvent) => sent[i].push(`${event.type} ${event.code}`),
        },
        files: { pasteClipboardFiles: () => false, clipboardAnswered: async () => true },
        overlay: { classList: { toggle () { } } },
    }))
    svc.splitOf = () => split
    svc.broadcast.add(split)
    ;(globalThis as any).KeyboardEvent = class { constructor (readonly type: string, init: any) { Object.assign(this, init) } }
    // The third pane shows its console: it isn't counted, and gets neither the paste nor the keys.
    assert.equal(svc.desktopsInTab(panes[0]), 2)
    assert.equal(svc.pasteToAll(panes[0]), 2)
    await settle()
    svc.broadcastKey(panes[0], 'keydown', { code: 'KeyA', key: 'a' })
    svc.broadcastKey(panes[0], 'keyup', { code: 'KeyA', key: 'a' })
    assert.deepEqual(sent, [['clipboard', 'Ctrl+V'], ['clipboard', 'Ctrl+V', 'keydown KeyA', 'keyup KeyA'], []])
    // A key held when a desktop goes out of sight is let go there all the same.
    svc.broadcastKey(panes[0], 'keydown', { code: 'ShiftLeft', key: 'Shift' })
    svc.sessions.get(panes[1]).visible = false
    svc.broadcastKey(panes[0], 'keyup', { code: 'ShiftLeft', key: 'Shift' })
    svc.broadcastKey(panes[0], 'keydown', { code: 'KeyB', key: 'b' })
    assert.deepEqual(sent[1].slice(4), ['keydown ShiftLeft', 'keyup ShiftLeft'])
    // A pane maximized over the others (Tabby's pane-maximize) leaves them nearly transparent behind it: they get
    // neither, and aren't counted.
    svc.sessions.get(panes[1]).visible = true
    sent.forEach(list => list.splice(0))
    ;(split as any).getMaximizedTab = () => panes[0]
    assert.equal(svc.desktopsInTab(panes[0]), 1)
    assert.equal(svc.pasteToAll(panes[0]), 1)
    await settle()
    svc.broadcastKey(panes[0], 'keydown', { code: 'KeyC', key: 'c' })
    assert.deepEqual(sent, [['clipboard', 'Ctrl+V'], [], []])
    // Nor are they in view: a capture starting there brings the note and the window's own microphone.
    assert.equal(svc.inView(panes[1], svc.sessions.get(panes[1])), false)
})

test('a remote desktop tab connects with its profile as saved now, defaults included, not as it was when it opened', async () => {
    const saved: any = { id: 'rdp:custom:win:1', type: 'rdp', name: 'Win', group: 'g1', options: { host: '10.0.0.5', port: 3389 } }
    const groups = [{ id: 'g1', name: 'Office', defaults: { rdp: { options: { clipboard: 'fromRemote' } } } }]
    const config = { store: { profiles: [saved], groups } }
    const targets = new RemoteTargets(config, { getConfigProxyForProfile: (p: any) => withDefaults(p, groups) })
    // The tab holds the profile as Tabby opened it: both ways then.
    const tab = { profile: { id: saved.id, type: 'rdp', name: 'Win', options: { host: '10.0.0.5', port: 3389, clipboard: 'both' } }, element: { nativeElement: {} } }
    assert.equal((await targets.targetOf(tab)).direct.clipboard, 'fromRemote')
    // Edited in the profile editor while the tab is open, which saves new options in place of the old.
    saved.options = { host: '10.0.0.6', port: 3390, clipboard: 'off' }
    const edited = await targets.targetOf(tab)
    assert.deepEqual([edited.direct.id, edited.direct.clipboard, edited.label], ['10.0.0.6:3390', 'off', '10.0.0.6:3390'])
    // Changed to go through an SSH profile: not connected from here, to an address as that host sees it.
    saved.options = { host: '127.0.0.1', port: 3389, via: 'ssh:custom:host:1' }
    assert.equal(await targets.targetOf(tab), null)
    // Quick connect has no saved profile: the tab's own.
    const quick = { profile: { type: 'rdp', name: 'pc.local', options: { host: 'pc.local', port: 3389 } }, element: { nativeElement: {} } }
    assert.equal((await targets.targetOf(quick)).direct.id, 'pc.local:3389')
})

test('Reconnect in a remote desktop tab makes its desktop afresh; over an SSH tab, it keeps the remote it had', async () => {
    const { svc } = service()
    const opened: unknown[] = []
    svc.showDesktop = async (_: unknown, id: string | undefined, options: { target?: unknown }) => { opened.push({ id, target: options.target }) }
    const spec = { id: '10.0.0.5:3389', name: 'Win' }
    const tab = { profile: { type: 'rdp' }, element: { nativeElement: {} } }
    svc.sessions.set(tab, { visible: true, viewOnly: false, remote: { key: 'rdp', label: 'Win', direct: spec }, spec, dispose () { } })
    await svc.reopen(tab, spec)
    const ssh = { profile: { type: 'ssh' }, element: { nativeElement: {} } }
    const remote = { key: 'alice@host:22', label: 'host' }
    svc.sessions.set(ssh, { visible: true, viewOnly: false, remote, spec, dispose () { } })
    await svc.reopen(ssh, spec)
    assert.deepEqual(opened, [{ id: undefined, target: undefined }, { id: spec.id, target: remote }])
})

/** A file as Remote Desktop Connection saves it: UTF-16LE with a byte order mark, CRLF lines. */
const rdpFile = (...lines: string[]) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]))

/**
 * Imports a file, answering the question with `answer` (1: Add only, 2: Cancel): what the question said the desktop
 * gets, the profile made, and the clipboard it ends up with once Tabby fills in its defaults.
 */
async function importing (file: Uint8Array, { setting = 'both', groupDefault = '', typeDefault = '', answer = 1, microphone = false } = {}) {
    const groups: any[] = groupDefault ? [{ id: 'g1', name: 'Remote desktops', defaults: { rdp: { options: { clipboard: groupDefault } } } }] : []
    const typeDefaults = typeDefault ? { clipboard: typeDefault } : {}
    const made: any[] = []
    const profiles = {
        getProfileGroups: async () => groups,
        newProfileGroup: async (group: any) => { group.id = 'g2'; groups.push(group) },
        newProfile: async (profile: any) => { made.push(profile) },
        getConfigProxyForProfile: (profile: any) => withDefaults(profile, groups, typeDefaults),
        openNewTabForProfile: async () => null,
    }
    const asked: string[] = []
    const platform = { showMessageBox: async (box: { detail: string }) => { asked.push(box.detail); return { response: answer } } }
    const { svc, notified } = service({ clipboard: setting, microphone }, { profiles, platform })
    await svc.importRdp(file, 'office.rdp')
    const gets = /the desktop gets (.*?)\. Add it only/.exec(asked[0] ?? '')?.[1]
    const profile = made[0]
    const clipboard = profile && (ownClipboard(withDefaults(profile, groups, typeDefaults).options.clipboard) ?? setting)
    return { gets, profile, clipboard, groups, notified }
}

test('an .rdp import: the file can turn the clipboard off; otherwise the profile follows its defaults, as the question says', async () => {
    const plain = rdpFile('full address:s:pc17.corp.example')
    const both = await importing(plain)
    assert.equal(both.gets, 'your clipboard and the folders you share')
    // No clipboard option of its own: not even an empty one, which would hide the defaults.
    assert.ok(!('clipboard' in both.profile.options))
    assert.equal(both.clipboard, 'both')
    // The "Remote desktops" group, where imports go, turns it off for its profiles; or the type's defaults narrow it.
    const grouped = await importing(plain, { groupDefault: 'off' })
    assert.deepEqual([grouped.gets, grouped.profile.group, grouped.clipboard], ['the folders you share', 'g1', 'off'])
    const typed = await importing(plain, { typeDefault: 'fromRemote' })
    assert.deepEqual([typed.gets, typed.clipboard], ['the folders you share and can put things on your clipboard', 'fromRemote'])
    // Else the setting.
    const setting = await importing(plain, { setting: 'off' })
    assert.deepEqual([setting.gets, setting.clipboard], ['the folders you share', 'off'])
    // The file's redirectclipboard:i:0, whatever the defaults.
    const off = await importing(rdpFile('full address:s:pc17.corp.example', 'redirectclipboard:i:0'), { typeDefault: 'both' })
    assert.deepEqual([off.gets, off.profile.options.clipboard, off.clipboard], ['the folders you share (the file turns the clipboard off for it)', 'off', 'off'])
    // Asking doesn't make the group: cancelled, there is none.
    const cancelled = await importing(plain, { answer: 2 })
    assert.deepEqual([cancelled.profile, cancelled.groups], [undefined, []])
})

test('an .rdp import names the microphone where the setting sends it, and doesn\'t call the file\'s ask for it not applied then', async () => {
    const asking = rdpFile('full address:s:pc17.corp.example', 'audiocapturemode:i:1', 'redirectprinters:i:1')
    const on = await importing(asking, { microphone: true })
    assert.equal(on.gets, 'your clipboard, the folders you share and your microphone when it asks for it')
    assert.deepEqual(on.notified.filter(n => /Not applied/.test(n)), ['office.rdp also asks for printer redirection (not supported). Not applied.'])
    const off = await importing(asking)
    assert.equal(off.gets, 'your clipboard and the folders you share')
    assert.deepEqual(off.notified.filter(n => /Not applied/.test(n)),
        ['office.rdp also asks for the microphone (Settings › Remote Desktop › Microphone); printer redirection (not supported). Not applied.'])
    // With the clipboard narrowed, the list still reads.
    const narrowed = await importing(rdpFile('full address:s:pc17.corp.example'), { microphone: true, typeDefault: 'fromRemote' })
    assert.equal(narrowed.gets, 'the folders you share and your microphone when it asks for it, and can put things on your clipboard')
})

/**
 * Imports a file whose desktop has a profile already (`existing`), answering a question with `answer` (0: turn the
 * clipboard off there and open it, 1: open it as it is, 2: cancel): what was asked, what was opened, and the
 * clipboard saved in that profile.
 */
async function reimporting (file: Uint8Array, existing: any, { setting = 'both', answer = 0 } = {}) {
    const opened: any[] = []
    const asked: { message: string, detail: string }[] = []
    const profiles = { getConfigProxyForProfile: (profile: any) => withDefaults(profile), openNewTabForProfile: async (profile: any) => { opened.push(profile) } }
    const platform = { showMessageBox: async (box: { message: string, detail: string }) => { asked.push(box); return { response: answer } } }
    const { svc, config } = service({ clipboard: setting }, { profiles, platform })
    config.store.profiles = [existing]
    const result = await svc.importRdp(file, 'office.rdp')
    return { result, opened, asked, saved: existing.options.clipboard }
}

test('an .rdp file that turns the clipboard off doesn\'t open a profile for its desktop that shares it without asking', async () => {
    const off = rdpFile('full address:s:pc17.corp.example', 'redirectclipboard:i:0')
    const profile = (clipboard?: string) => ({ id: 'rdp:custom:pc17:1', type: 'rdp', name: 'PC17', options: { host: 'pc17.corp.example', port: 3389, ...clipboard ? { clipboard } : {} } })
    // Turned off there, then opened (an open tab of it then narrows: see the test above on desktops opened twice).
    const turned = await reimporting(off, profile())
    assert.equal(turned.asked[0].message, 'Turn the clipboard off for "PC17"?')
    assert.match(turned.asked[0].detail, /^office\.rdp turns the clipboard off for its desktop, and "PC17", already a profile for that desktop, shares it both ways\./)
    assert.deepEqual([turned.saved, turned.opened.length], ['off', 1])
    const fromRemote = await reimporting(off, profile('fromRemote'))
    assert.match(fromRemote.asked[0].detail, /lets that desktop put things on your clipboard/)
    // Opened as it is, by choice; or not at all.
    const kept = await reimporting(off, profile(), { answer: 1 })
    assert.deepEqual([kept.saved, kept.opened.length], [undefined, 1])
    const cancelled = await reimporting(off, profile(), { answer: 2 })
    assert.deepEqual([cancelled.result, cancelled.saved, cancelled.opened.length], [null, undefined, 0])
    // Nothing to ask where it is off already (its own, or the setting's), or where the file doesn't turn it off.
    for (const [file, existing, setting] of [[off, profile('off'), 'both'], [off, profile(), 'off'], [rdpFile('full address:s:pc17.corp.example'), profile(), 'both']] as const) {
        const quiet = await reimporting(file, existing, { setting })
        assert.deepEqual([quiet.asked.length, quiet.opened.length, quiet.saved], [0, 1, existing.options.clipboard])
    }
})
