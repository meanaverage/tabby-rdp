// `desk` in the desktop service (src/desktop.service.ts) and the terminal's listener (src/desk.ts), with Tabby's modules
// stubbed. Which hosts' keys it keeps: only what a setup asked to set desk up reports, with desk still on as it ends, and
// nothing once a setup ran with desk off or found xrdp or Windows. What a request gets to do: nothing without a key a
// host gave (not even a word in the window), one note at most when desk is off, nothing in a pane that isn't in front,
// and the machine's desktop only with that machine's own key. And a sign-in form (the desktop's, or its gateway's), a
// desktop that finishes connecting, or a question (a certificate to trust) that shows up while another pane is in front
// leaves the keyboard there, until that pane is. Nothing connects. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Tabby and Angular, as far as loading the service needs them.
const decorator = () => () => undefined
const stubs: Record<string, unknown> = {
    '@angular/core': { Injectable: decorator, NgZone: class { } },
    'tabby-core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-settings': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    // A terminal's middleware passes on what it is fed; this one keeps it.
    'tabby-terminal': {
        SessionMiddleware: class { shown: Buffer[] = []; feedFromSession (data: Buffer) { this.shown.push(data) } },
        TerminalDecorator: class { subscribeUntilDetached () { } },
    },
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { RemoteDesktopService } = require('../../dist/desktop.service.js')
const { DeskTriggerDecorator } = require('../../dist/desk.js')
import { FakeElement, installDocument } from './support/dom.js'
const { deskKeyDigest } = require('../../dist/deskScript.js')
const signin = require('../../dist/signin.js')

const CERT = Array(32).fill('AA').join(':')
const KEY_A = '0123456789abcdef0123456789abcdef'
const KEY_B = 'fedcba9876543210fedcba9876543210'

type Target = { key: string, label: string, exec: (command: string, stdin: string) => Promise<string> }

/** An SSH tab, as the service tells one. */
const sshPane = () => ({ profile: { type: 'ssh' }, element: { nativeElement: {} } })

/**
 * The service on a config of its own, the pane's target being `target`, and what it showed and ran. `nested`: what
 * `ssh` typed in an SSH tab's console leads to (its destination, and the machine reached through the tab's host).
 */
function harness (target: Target, remoteDesktop: Record<string, unknown> = {}, nested: { destination: string, target: Target }[] = []) {
    const store = { desk: true, deskKeys: [] as { desktop: string, sha256: string }[], trustedCertificates: [], withoutNla: [], nestedSSH: [], desktops: [], accounts: [], desktopSharpness: [], ...remoteDesktop }
    // Tabby's config says when it changes (another window, the config file, config sync): here when a test says so.
    const listeners: (() => void)[] = []
    const config = { store: { remoteDesktop: store, profiles: [] }, save () { }, changed$: { subscribe: (f: () => void) => { listeners.push(f) } } }
    const seen = { infos: [] as string[], errors: [] as string[], notes: [] as string[], targetOf: 0, opened: [] as string[], shown: 0 }
    const notifications = { notice: (_text: string): unknown => undefined, info: (text: string) => seen.infos.push(text), error: (text: string) => seen.errors.push(text) }
    const help = { note: (_element: unknown, text: string) => seen.notes.push(text) }
    const app = { activeTab: null as unknown, tabs: [] as unknown[] }
    const targets = {
        targetOf: async () => { seen.targetOf++; return target },
        nestedSSH: async () => nested.map(n => ({ cmd: { destination: n.destination } })),
        nestedTarget: async (_pane: unknown, found: { cmd: { destination: string } }) => nested.find(n => n.destination === found.cmd.destination)?.target ?? null,
    }
    const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
    const svc = new RemoteDesktopService(app, targets, notifications, config, zone, {}, help, {}, {})
    // Where the console would be brought to the desktop: noted, not done.
    svc.openConsoleOn = async (_pane: unknown, there: Target) => { seen.opened.push(there.key) }
    return { svc, store, seen, app, notifications, zone, changed: () => listeners.forEach(f => f()) }
}

const request = (key: string, machine = '') => ({ session: 'abcd1234', socket: '', cwd: '/tmp', kind: 'native', machine, hostname: 'h', key })
const known = (desktop: string, key: string) => ({ desktop, sha256: deskKeyDigest(key) })

test('a request without a key a host gave runs nothing and shows nothing, desk on or off', async () => {
    const target = { key: 'alice@a:22', label: 'a', exec: async () => 'machine-a\n' }
    for (const desk of [true, false]) {
        const { svc, seen, app } = harness(target, { desk, deskKeys: [known('alice@a:22', KEY_A)] })
        const pane = sshPane()
        app.activeTab = pane
        for (const key of ['', KEY_B]) {
            await svc.openConsole(pane, request(key, 'machine-a'))
            await svc.openConsole(pane, request(key))
        }
        assert.deepEqual(seen, { infos: [], errors: [], notes: [], targetOf: 0, opened: [], shown: 0 }, `desk ${desk}`)
        assert.equal(svc.knowsDeskKey(KEY_A), true)
        assert.equal(svc.knowsDeskKey(KEY_B), false)
        assert.equal(svc.knowsDeskKey(''), false)
    }
})

test('with desk off, a request with a known key says so, once in a cooldown, and runs nothing', async () => {
    const { svc, seen, app } = harness({ key: 'alice@a:22', label: 'a', exec: async () => 'machine-a\n' }, { desk: false, deskKeys: [known('alice@a:22', KEY_A)] })
    const pane = sshPane()
    app.activeTab = pane
    for (let i = 0; i < 20; i++) {
        await svc.openConsole(pane, request(KEY_A))
    }
    assert.equal(seen.infos.length, 1)
    assert.match(seen.infos[0], /`desk` is off/)
    assert.equal(seen.targetOf, 0)
    // From a pane that isn't in front (a host whose hook was left, printing it when it likes): not a word.
    await svc.openConsole(sshPane(), request(KEY_A))
    assert.equal(seen.infos.length, 1)
    assert.deepEqual(seen.notes, [])
})

test('the machine\'s desktop opens only with that machine\'s own key, once in a cooldown', async () => {
    const target = { key: 'alice@a:22', label: 'a', exec: async () => 'machine-a\n' }
    const { svc, seen, app } = harness(target, { deskKeys: [known('alice@a:22', KEY_A), known('alice@b:22', KEY_B)] })
    const inFront = () => { const pane = sshPane(); app.activeTab = pane; return pane }

    // Host b's key, in a's tab (b's own output shown there, say): a note, nothing opened.
    await svc.openConsole(inFront(), request(KEY_B, 'machine-a'))
    assert.deepEqual(seen.opened, [])
    assert.match(seen.notes.pop() ?? '', /^desk on a sent a key that isn't the one this Tabby has for it/)
    // a's own: opened, once, whatever follows within the cooldown.
    const pane = inFront()
    await svc.openConsole(pane, request(KEY_A, 'machine-a'))
    await svc.openConsole(pane, request(KEY_A, 'machine-a'))
    assert.deepEqual(seen.opened, ['alice@a:22'])
    // Without a machine (desk from before machines were sent, or an empty field): the tab's host, with its key only.
    await svc.openConsole(inFront(), request(KEY_A))
    await svc.openConsole(inFront(), request(KEY_B))
    assert.deepEqual(seen.opened, ['alice@a:22', 'alice@a:22'])
    assert.match(seen.notes.pop() ?? '', /^desk on a sent a key that isn't/)
    assert.deepEqual(seen.errors, [])
})

test('a machine that can\'t say which it is, or whose key this Tabby doesn\'t have: nothing opens, and the note says which', async () => {
    const failing = { key: 'alice@a:22', label: 'a', exec: async () => { throw new Error('channel closed') } }
    const { svc, seen, app } = harness(failing, { deskKeys: [known('alice@a:22', KEY_A)] })
    let pane = sshPane()
    app.activeTab = pane
    await svc.openConsole(pane, request(KEY_A, 'machine-a'))
    assert.deepEqual(seen.errors, ['desk: couldn\'t ask a which machine it is'])
    assert.deepEqual(seen.opened, [])

    const other = harness({ key: 'alice@a:22', label: 'a', exec: async () => 'machine-a\n' }, { deskKeys: [known('alice@b:22', KEY_B)] })
    pane = sshPane()
    other.app.activeTab = pane
    await other.svc.openConsole(pane, request(KEY_B, 'machine-a'))
    assert.deepEqual(other.seen.notes, ['This Tabby doesn\'t know desk on a yet: open its desktop once, then run desk again.'])
    assert.deepEqual(other.seen.opened, [])
})

test('a request from a pane that isn\'t in front shows nothing there: it would take the keyboard from the pane in use', async () => {
    const target = { key: 'alice@a:22', label: 'a', exec: async () => 'machine-a\n' }
    const { svc, seen, app } = harness(target, { deskKeys: [known('alice@a:22', KEY_A)] })
    const pane = sshPane()
    const inUse = sshPane()
    app.activeTab = inUse
    await svc.openConsole(pane, request(KEY_A, 'machine-a'))
    assert.equal(seen.targetOf, 0)
    assert.match(seen.notes.pop() ?? '', /while this pane wasn't the one in front/)

    // In front when asked, but the host answers only once the user has moved on: the desktop isn't shown then either.
    const { svc: real, seen: seen2, app: app2 } = harness(target, { deskKeys: [known('alice@a:22', KEY_A)] })
    delete real.openConsoleOn
    real.showDesktop = async () => { seen2.shown++ }
    const later = sshPane()
    app2.activeTab = later
    target.exec = async () => { app2.activeTab = inUse; return 'machine-a\n' }
    await real.openConsole(later, request(KEY_A, 'machine-a'))
    assert.equal(seen2.shown, 0)
    assert.match(seen2.notes.pop() ?? '', /^desk's desktop wasn't shown: another pane was in front by then/)
})

test('desk run after ssh typed in the console: that machine\'s desktop, with its own key only', async () => {
    // The tab is on a; `ssh c` runs in its console, and desk ran on c (its key kept under c's key, through a).
    const a = { key: 'alice@a:22', label: 'a', exec: async () => 'machine-a\n' }
    const c = { key: 'alice@a:22>bob@c:22', label: 'c', exec: async () => 'machine-c\n' }
    const KEY_C = '00112233445566778899aabbccddeeff'
    const { svc, seen, app } = harness(a, { deskKeys: [known(a.key, KEY_A), known(c.key, KEY_C)] }, [{ destination: 'c', target: c }])
    const inFront = () => { const pane = sshPane(); app.activeTab = pane; return pane }
    await svc.openConsole(inFront(), request(KEY_C, 'machine-c'))
    assert.deepEqual(seen.opened, [c.key])
    // a's own key, for the machine c: neither machine's desktop.
    await svc.openConsole(inFront(), request(KEY_A, 'machine-c'))
    assert.deepEqual(seen.opened, [c.key])
    assert.match(seen.notes.pop() ?? '', /^desk on c sent a key that isn't the one this Tabby has for it/)
    // A machine none of the console's ssh leads to: refused, naming both.
    await svc.openConsole(inFront(), { ...request(KEY_C, 'machine-x'), hostname: 'x' })
    assert.deepEqual(seen.opened, [c.key])
    assert.match(seen.notes.pop() ?? '', /^desk ran on x, but this tab is connected to a\./)
})

test('the terminal\'s listener, desk off: output full of look-alikes shows nothing; desk\'s own says desk is off, once', async () => {
    const { svc, seen, app, notifications, zone } = harness({ key: 'alice@a:22', label: 'a', exec: async () => 'machine-a\n' },
        { desk: false, deskKeys: [known('alice@a:22', KEY_A)] })
    // An SSH tab's terminal, in front, with the listener installed as Tabby does it.
    const terminal = {
        ...sshPane(), middleware: [] as any[],
        session: { middleware: { push: (m: unknown) => terminal.middleware.push(m) } },
        sessionChanged$: { subscribe: () => ({ unsubscribe () { } }) },
    }
    app.activeTab = terminal
    new DeskTriggerDecorator(svc, zone, notifications).attach(terminal)
    const [listener] = terminal.middleware
    const b64 = (s: string) => Buffer.from(s).toString('base64')
    const desk = (key: string) => `\x1b]7777;desk;${['abcd1234', '', '/tmp', 'native', '', 'a', key].map(b64).join(';')}\x07`
    const settle = () => new Promise(resolve => setTimeout(resolve, 10))
    // A log being followed: 50 chunks, each with requests without a key or with one no host gave.
    for (let i = 0; i < 50; i++) {
        listener.feedFromSession(Buffer.from(`line ${i}\n${desk('')}${desk(KEY_B)}`))
    }
    await settle()
    assert.deepEqual(seen.infos, [])
    assert.equal(seen.targetOf, 0)
    assert.equal(Buffer.concat(listener.shown).toString(), Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join(''))
    // desk itself, from a host whose hook was left from when it was on, again and again: one notice.
    for (let i = 0; i < 20; i++) {
        listener.feedFromSession(Buffer.from(desk(KEY_A)))
        await settle()
    }
    assert.equal(seen.infos.length, 1)
    assert.match(seen.infos[0], /`desk` is off/)
    assert.equal(seen.targetOf, 0)
})

test('a sign-in form that shows up while another pane is in front leaves the keyboard there', async () => {
    // The host's own desktop is xrdp's, which asks for a sign-in after the setup (answered with Cancel).
    const target = { key: 'alice@a:22', label: 'a', exec: async () => 'RD_XRDP port=3389 user=alice\n' }
    const real = signin.askCredentials
    signin.askCredentials = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return null }
    try {
        const focused: string[] = []
        for (const where of ['this pane', 'another pane']) {
            const { svc, app } = harness(target)
            const spec = svc.desktopsOf(target)[0]
            const pane = sshPane()
            const s = {
                ...session(spec, target.key), visible: true, overlay: {},
                focusDesktop: () => focused.push(where),
            }
            svc.sessions.set(pane, s)
            app.activeTab = where === 'this pane' ? pane : sshPane()
            assert.equal(await svc.endpointFor(pane, target, spec, s, false), null)
        }
        assert.deepEqual(focused, ['this pane'])
    } finally {
        signin.askCredentials = real
    }
})

test('a gateway\'s own sign-in form that shows up while another pane is in front leaves the keyboard there', async () => {
    const target = { key: 'rdp', label: 'Office PC', exec: async () => '' }
    const real = { ask: signin.askCredentials, load: signin.loadCredentials }
    signin.askCredentials = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return null }
    // No password saved for the gateway's account: the form shows.
    signin.loadCredentials = async () => null
    try {
        const focused: string[] = []
        for (const where of ['this pane', 'another pane']) {
            const { svc, app } = harness(target, { accounts: [{ id: 'k1', name: 'Gateway', username: 'gw-user' }] })
            const spec = { id: 'pc.corp:3389', name: 'Office PC', kind: 'windows', host: 'pc.corp', port: 3389, gateway: 'gw.example', gatewayAccount: 'k1' }
            const pane = { profile: { type: 'rdp' }, element: { nativeElement: {} } }
            const s = { ...session(spec, 'rdp#pc.corp:3389'), visible: true, overlay: {}, focusDesktop: () => focused.push(where) }
            svc.sessions.set(pane, s)
            app.activeTab = where === 'this pane' ? pane : sshPane()
            assert.equal(await svc.gatewayAccountFor(spec, s, { host: 'gw.example', port: 443 }), null)
        }
        assert.deepEqual(focused, ['this pane'])
    } finally {
        Object.assign(signin, { askCredentials: real.ask, loadCredentials: real.load })
    }
})

test('a desktop that finishes connecting while another pane is in front leaves the keyboard there', () => {
    const { svc, app } = harness({ key: 'alice@a:22', label: 'a', exec: async () => '' })
    const focused: string[] = []
    for (const where of ['this pane', 'another pane', 'this pane, its console in front']) {
        const pane = sshPane()
        const s = { visible: !where.endsWith('in front'), focusDesktop: () => focused.push(where) }
        app.activeTab = where === 'another pane' ? sshPane() : pane
        svc.focusIfInFront(pane, s)
    }
    assert.deepEqual(focused, ['this pane'])
})

test('the first tip, closed while another pane is in front, leaves the keyboard there', () => {
    const { svc, app } = harness({ key: 'alice@a:22', label: 'a', exec: async () => '' })
    const help = (svc as any).help
    // Closed at once, as Got it or its own timer (25 s on) does.
    help.tipOnce = (_overlay: unknown, _console: boolean, done: () => void) => done()
    const focused: string[] = []
    for (const where of ['this pane', 'another pane']) {
        const pane = sshPane()
        const s = { state: 'connected', visible: true, overlay: {}, focusDesktop: () => focused.push(where) }
        svc.sessions.set(pane, s)
        app.activeTab = where === 'this pane' ? pane : sshPane()
        svc.tip(pane, s)
    }
    assert.deepEqual(focused, ['this pane'])
})

test('a question that comes for a desktop in a pane that isn\'t in front leaves the keyboard where it is, until that pane is', async t => {
    const page = installDocument()
    t.after(page.restore)
    const { Subject } = require('rxjs')
    const { specOf } = require('../../dist/desktops.js')
    const notices: string[] = []
    const { svc, app, notifications } = harness({ key: 'alice@a:22', label: 'a', exec: async () => '' })
    // A note that stays a while, not a notice gone in a second.
    notifications.info = (text: string) => notices.push(text)
    svc.connect = async () => { }
    // The user types in a terminal in front; the desktop's pane is another tab (Tabby keeps it in the page, off
    // screen), or the other pane of a split: its layer shows over that pane all the same.
    const pane = (type: string) => ({ profile: { type }, element: { nativeElement: new FakeElement() }, destroyed$: new Subject(), focused$: new Subject() })
    const front = pane('ssh')
    const back = pane('rdp')
    app.tabs = [front, back]
    const typing = new FakeElement('textarea')
    front.element.nativeElement.appendChild(typing)
    const spec = specOf({ host: '10.0.0.5', name: 'Office PC' })
    const target = { key: 'rdp', label: '10.0.0.5:3389', direct: spec, isOpen: () => true }
    const question = async () => {
        const session = svc.sessions.get(back)
        const problem = { expected: '', actual: Array(32).fill('BB').join(':'), pinned: false, valid: false, name: '10.0.0.5', reason: 'DEPTH_ZERO_SELF_SIGNED_CERT' }
        const answer = svc.refusedCertificate(back, target, spec, session, { host: '10.0.0.5', port: 3389 }, problem)
        await new Promise(resolve => setTimeout(resolve, 5))
        return { session, answer }
    }
    // Opened in front, then the user went to the other tab; a reconnect there meets a certificate to ask about.
    app.activeTab = back
    await svc.showDesktop(back, undefined, { target })
    await new Promise(resolve => setTimeout(resolve, 5))
    app.activeTab = front
    typing.focus()
    const { session, answer } = await question()
    const cancel = session.overlay.querySelector('.trd-status-default')
    assert.equal(cancel?.tagName, 'BUTTON')
    assert.equal((globalThis as any).document.activeElement, typing, 'the keyboard stays in the terminal in front')
    assert.equal(notices.length, 1, 'a notice says a desktop out of view has a question')
    // The user goes to that pane: the focus is on Cancel, so Enter there picks Cancel.
    app.activeTab = back
    back.focused$.next()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal((globalThis as any).document.activeElement, cancel)
    cancel!.click()
    assert.equal(await answer, false)
    // In the pane in front, the focus is on Cancel at once.
    const again = await question()
    assert.equal((globalThis as any).document.activeElement, again.session.overlay.querySelector('.trd-status-default'))
    again.session.overlay.querySelector('.trd-status-default')!.click()
    assert.equal(await again.answer, false)
    svc.disconnect(back)
})

/** A desktop's layer (a DesktopSession) on the stand-in page, in front for as long as `front.on` says. */
function layer (t: { after: (f: () => void) => void }, front: { on: boolean }) {
    const page = installDocument()
    const { DesktopSession } = require('../../dist/desktop.service.js')
    const { specOf } = require('../../dist/desktops.js')
    const session = new DesktopSession(new FakeElement(), 'rdp#10.0.0.5:3389', specOf({ host: '10.0.0.5' }))
    session.inFront = () => front.on
    t.after(() => { session.dispose(); page.restore() })
    return session
}

test('the retries of a focus stop once the user is in another pane, though the desktop still shows', async t => {
    const front = { on: true }
    const session = layer(t, front)
    // The canvas shows a moment after the desktop connects: the focus is tried again until it does.
    session.host.appendChild(new FakeElement('iron-remote-desktop'))
    let tries = 0
    session.canvas = () => { tries++; return null }
    session.visible = true
    session.focusDesktop()
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(tries > 2, `${tries} tries in front`)
    front.on = false
    const before = tries
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(tries, before, 'tried again in the background')
})

test('a desktop that is shown, or Tabby\'s re-focus of its terminal taken back, leaves the keyboard where the user went meanwhile', async t => {
    const front = { on: true }
    const session = layer(t, front)
    let focused = 0
    session.focusDesktop = () => { focused++ }
    const elsewhere = new FakeElement('textarea')
    const results: Record<string, number> = {}
    for (const [how, start] of [['shown', () => session.setVisible(true)], ['re-focused', () => { session.visible = true; session.reclaimFocus({ target: elsewhere }) }]] as const) {
        // In front when it starts, in another pane when the focus would run (a tab in the background still shows).
        for (const [where, stays] of [['in front', true], ['another pane', false]] as const) {
            front.on = true
            focused = 0
            start()
            front.on = stays
            await new Promise(resolve => setTimeout(resolve, 5))
            results[`${how}, ${where}`] = focused
        }
    }
    assert.deepEqual(results, { 'shown, in front': 1, 'shown, another pane': 0, 're-focused, in front': 1, 're-focused, another pane': 0 })
})

test('a sign-in form\'s focus, waiting for its moment, goes ahead only in the pane the user is in then', async () => {
    const target = { key: 'alice@a:22', label: 'a', exec: async () => 'RD_XRDP port=3389 user=alice\n' }
    const real = { ask: signin.askCredentials, load: signin.loadCredentials }
    try {
        const focused: string[] = []
        for (const form of ['the desktop\'s', 'the gateway\'s']) {
            for (const where of ['this pane', 'another pane']) {
                const { svc, app } = harness(target, { accounts: [{ id: 'k1', name: 'Gateway', username: 'gw-user' }] })
                const spec = form === 'the desktop\'s' ? svc.desktopsOf(target)[0]
                    : { id: 'pc.corp:3389', name: 'Office PC', kind: 'windows', host: 'pc.corp', port: 3389, gateway: 'gw.example', gatewayAccount: 'k1' }
                const pane = sshPane()
                const s = { ...session(spec, target.key), visible: true, overlay: {}, focusDesktop: () => focused.push(`${form} form, ${where}`) }
                svc.sessions.set(pane, s)
                app.activeTab = pane
                // The user goes to another pane just before the form's focus would run (set up first: it comes first).
                signin.askCredentials = async () => {
                    if (where === 'another pane') {
                        setTimeout(() => { app.activeTab = sshPane() })
                    }
                    await new Promise(resolve => setTimeout(resolve, 20))
                    return null
                }
                signin.loadCredentials = async () => null
                if (form === 'the desktop\'s') {
                    assert.equal(await svc.endpointFor(pane, target, spec, s, false), null)
                } else {
                    assert.equal(await svc.gatewayAccountFor(spec, s, { host: 'gw.example', port: 443 }), null)
                }
            }
        }
        assert.deepEqual(focused, ['the desktop\'s form, this pane', 'the gateway\'s form, this pane'])
    } finally {
        Object.assign(signin, { askCredentials: real.ask, loadCredentials: real.load })
    }
})

test('Tabby focusing a desktop\'s pane, and the user in another pane by the time it takes the keyboard: it stays there', async t => {
    const page = installDocument()
    t.after(page.restore)
    const { Subject } = require('rxjs')
    const { specOf } = require('../../dist/desktops.js')
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const { svc, app } = harness({ key: 'alice@a:22', label: 'a', exec: async () => '' })
    svc.connect = async () => { }
    const pane = (type: string) => ({ profile: { type }, element: { nativeElement: new FakeElement() }, destroyed$: new Subject(), focused$: new Subject() })
    const front = pane('ssh')
    const back = pane('rdp')
    app.tabs = [front, back]
    const spec = specOf({ host: '10.0.0.5', name: 'Office PC' })
    app.activeTab = back
    await svc.showDesktop(back, undefined, { target: { key: 'rdp', label: '10.0.0.5:3389', direct: spec, isOpen: () => true } })
    await wait(5)
    const session = svc.sessions.get(back)
    let focused = 0
    session.focusDesktop = () => { focused++ }
    // Tabby focuses the pane; the user switches to the other tab before the focus is taken.
    back.focused$.next()
    app.activeTab = front
    await wait(5)
    assert.equal(focused, 0)
    // In the pane, it is taken.
    app.activeTab = back
    back.focused$.next()
    await wait(5)
    assert.equal(focused, 1)
    svc.disconnect(back)
})

test('keys from a menu: the desktop stops asking for the keyboard once the user is in another pane', async t => {
    const page = installDocument()
    t.after(page.restore)
    const { svc, app } = harness({ key: 'alice@a:22', label: 'a', exec: async () => '' })
    const pane = sshPane()
    const other = sshPane()
    app.activeTab = pane
    const attempts: number[] = []
    const s = {
        ...session({}, 'alice@a:22'), state: 'connected', viewOnly: false, visible: true, overlay: new FakeElement(),
        // The user goes to another pane right after the first try.
        focusDesktop: (n: number) => { attempts.push(n); app.activeTab = other },
    }
    svc.sessions.set(pane, s)
    assert.equal(await svc.takeKeyboard(pane), false)
    assert.deepEqual(attempts, [1])
    assert.match(s.log.at(-1)!, /did not take the keyboard/)
})

// ---- what setups say about desk's key ---------------------------------------------------------------------------------

/** A session as endpointFor sees it; a question is answered with `answer`. */
function session (spec: unknown, key: string, answer?: string) {
    return {
        spec, key, authKey: key, log: [] as string[], visible: false, disposed: new Promise<void>(() => { }),
        status (_text: string, actions: { label: string, run: () => void }[] = []) {
            actions.find(a => a.label === answer)?.run()
        },
    }
}

/** What a GNOME host's setup prints: `clients` connected already, and desk's key if it gives one. */
const gnome = (key?: string, clients = 0, extra = '') => `${extra}RD_CLIENTS ${clients}\n${key ? `RD_DESK ${key}\n` : ''}RD_OK port=3389 user=tabby pass=secret cert=${CERT}\n`

/** Runs the host's own desktop's setup through endpointFor, the host answering with `answers` in turn. */
async function setUp (h: ReturnType<typeof harness>, target: Target & { asked: string[] }, answer?: string) {
    const spec = h.svc.desktopsOf(target)[0]
    const s = session(spec, target.key, answer)
    const pane = sshPane()
    h.svc.sessions.set(pane, s)
    await h.svc.endpointFor(pane, target, spec, s, false)
    return s
}

/** A host whose setups answer `answers` in turn (each a function of the script, which can also change the settings). */
function host (answers: ((script: string) => string)[]) {
    const target = {
        key: 'alice@a:22', label: 'a', asked: [] as string[],
        exec: async (_command: string, script: string) => {
            target.asked.push(/^TRD_DESK=(\d)$/m.exec(script)?.[1] + (/^TRD_TAKEOVER=1$/m.test(script) ? ' take-over' : ''))
            return answers.shift()!(script)
        },
    }
    return target
}

test('a host\'s key is kept only from a setup asked to set desk up, with desk still on as it ends', async () => {
    // Desk on: kept.
    let h = harness(host([]))
    let target = host([() => gnome(KEY_A)])
    await setUp(h, target)
    assert.deepEqual(target.asked, ['1'])
    assert.deepEqual(h.store.deskKeys, [known('alice@a:22', KEY_A)])

    // Desk off: whatever the host says, its key is gone (the setup removed desk there).
    h.store.desk = false
    target = host([() => gnome(KEY_B)])
    await setUp(h, target)
    assert.deepEqual(target.asked, ['0'])
    assert.deepEqual(h.store.deskKeys, [])

    // Turned on while a setup asked with it off runs: that setup set nothing up; no key from it.
    target = host([() => { h.store.desk = true; return gnome(KEY_A) }])
    await setUp(h, target)
    assert.deepEqual(target.asked, ['0'])
    assert.deepEqual(h.store.deskKeys, [])

    // Turned off while a setup asked with it on runs: no key from it either, and the one kept before goes.
    h = harness(host([]), { deskKeys: [known('alice@a:22', KEY_A)] })
    target = host([() => { h.store.desk = false; return gnome(KEY_A) }])
    await setUp(h, target)
    assert.deepEqual(target.asked, ['1'])
    assert.deepEqual(h.store.deskKeys, [])
})

test('a setup that began with desk on gives no key once desk was turned off meanwhile, though desk is on again when it ends', async () => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    // The setting changes here (the menu) or elsewhere (another window, the config file: the config says it changed).
    for (const how of ['the menu', 'the config']) {
        const h = harness(host([]))
        const turn = (on: boolean) => {
            if (how === 'the menu') {
                h.svc.updateSettings({ desk: on })
            } else {
                h.store.desk = on
                h.changed()
            }
        }
        // Setup A starts with desk on, and the host takes its time.
        let finish!: (output: string) => void
        const slow = { key: 'alice@a:22', label: 'a', exec: () => new Promise<string>(resolve => { finish = resolve }) }
        const a = h.svc.setUp(sshPane(), slow)
        await wait(5)
        // Desk is turned off, and a setup run then forgets the host's key (it removes desk there).
        turn(false)
        await h.svc.setUp(sshPane(), host([() => gnome(KEY_B)]))
        assert.deepEqual(h.store.deskKeys, [], how)
        // Desk is on again, and A ends, having asked for desk to be set up: its key isn't put back.
        turn(true)
        finish(gnome(KEY_A))
        await a
        assert.deepEqual(h.store.deskKeys, [], how)
        // A setup after that, with desk on throughout, keeps its key as before.
        await h.svc.setUp(sshPane(), host([() => gnome(KEY_A)]))
        assert.deepEqual(h.store.deskKeys, [known('alice@a:22', KEY_A)], how)
    }
})

test('a setup that began before desk was turned off and on again changes nothing as it ends: a newer setup\'s key stays', async () => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    for (const ends of ['succeeds', 'fails']) {
        const h = harness(host([]), { deskKeys: [known('alice@a:22', KEY_A)] })
        let finish!: (output: string) => void
        let fail!: (error: Error) => void
        const slow = { key: 'alice@a:22', label: 'a', exec: () => new Promise<string>((resolve, reject) => { finish = resolve; fail = reject }) }
        const a = h.svc.setUp(sshPane(), slow).catch((e: Error) => e.message)
        await wait(5)
        h.svc.updateSettings({ desk: false })
        h.svc.updateSettings({ desk: true })
        // A newer setup, with desk on throughout, keeps its key.
        await h.svc.setUp(sshPane(), host([() => gnome(KEY_B)]))
        assert.deepEqual(h.store.deskKeys, [known('alice@a:22', KEY_B)], ends)
        // The older one ends: it neither puts its key back nor takes the newer one away.
        if (ends === 'succeeds') {
            finish(gnome(KEY_A))
        } else {
            fail(new Error('the connection to the host dropped'))
        }
        await a
        assert.deepEqual(h.store.deskKeys, [known('alice@a:22', KEY_B)], ends)
    }
    // Without desk turned off meanwhile, a setup that fails leaves the key alone, as before.
    const kept = harness(host([]), { deskKeys: [known('alice@a:22', KEY_A)] })
    await kept.svc.setUp(sshPane(), { key: 'alice@a:22', label: 'a', exec: async () => { throw new Error('dropped') } }).catch(() => null)
    assert.deepEqual(kept.store.deskKeys, [known('alice@a:22', KEY_A)])
})

test('a setup with desk off forgets the host\'s key whatever it answers: an error, nothing usable, or nothing at all', async () => {
    // Opening a host's desktop with desk off is how a host is dropped from desk (README): a host that keeps its setup
    // from finishing mustn't keep its key.
    const answers: [string, (script: string) => string | Promise<string>][] = [
        ['an error', () => 'RD_ERR could not start gnome-remote-desktop-headless\n'],
        // No result: the Windows probe that follows answers too, not as Windows.
        ['nothing it can use', script => /TRD_DESK=/.test(script) ? 'garbage\n' : 'Linux\n'],
        ['a certificate it can\'t use', () => 'RD_OK port=3389 user=tabby pass=x cert=nonsense\n'],
    ]
    for (const [what, answer] of answers) {
        const h = harness(host([]), { desk: false, deskKeys: [known('alice@a:22', KEY_A)] })
        const target = { key: 'alice@a:22', label: 'a', exec: async (_command: string, script: string) => answer(script) }
        await assert.rejects(h.svc.setUp(sshPane(), target), what)
        assert.deepEqual(h.store.deskKeys, [], what)
        assert.equal(h.svc.knowsDeskKey(KEY_A), false, what)
    }
    // A host that never answers: gone as the setup starts.
    const h = harness(host([]), { desk: false, deskKeys: [known('alice@a:22', KEY_A)] })
    const pending = h.svc.setUp(sshPane(), { key: 'alice@a:22', label: 'a', exec: () => new Promise<string>(() => { }) })
    pending.catch(() => { })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(h.store.deskKeys, [])
    // Turned off while a setup with it on runs, which then fails: gone too. With it still on, a failed setup (the host
    // unreachable for a moment) leaves the key as it was.
    const off = harness(host([]), { deskKeys: [known('alice@a:22', KEY_A)] })
    await assert.rejects(off.svc.setUp(sshPane(), { key: 'alice@a:22', label: 'a', exec: async () => { off.store.desk = false; return 'RD_ERR stopped\n' } }))
    assert.deepEqual(off.store.deskKeys, [])
    const on = harness(host([]), { deskKeys: [known('alice@a:22', KEY_A)] })
    await assert.rejects(on.svc.setUp(sshPane(), { key: 'alice@a:22', label: 'a', exec: async () => 'RD_ERR stopped\n' }))
    assert.deepEqual(on.store.deskKeys, [known('alice@a:22', KEY_A)])
})

test('a take-over\'s setup is the one whose key is kept; a host no longer GNOME\'s keeps none; notes go to the log', async () => {
    const h = harness(host([]), { deskKeys: [known('alice@b:22', KEY_B)] })
    // Clients connected already: taken over, and that second setup reports another key (made again meanwhile).
    let target = host([() => gnome(KEY_A, 1), () => gnome(KEY_B, 0)])
    await setUp(h, target, 'Take it over')
    assert.deepEqual(target.asked, ['1', '1 take-over'])
    assert.deepEqual(h.store.deskKeys, [known('alice@b:22', KEY_B), known('alice@a:22', KEY_B)])

    // GNOME gone, xrdp now: desk can't work there, and its old key opens nothing any more. (The setup alone: the
    // sign-in to xrdp that follows it isn't what this is about.)
    target = host([() => 'RD_XRDP port=3389 user=alice\n'])
    assert.equal((await h.svc.setUp(sshPane(), target)).kind, 'xrdp')
    assert.deepEqual(h.store.deskKeys, [known('alice@b:22', KEY_B)])

    // What the setup couldn't do (an rc file it couldn't change) is in the desktop's log.
    target = host([() => gnome(KEY_A, 0, 'RD_NOTE desk\'s line stays in /home/alice/.zshrc: it can\'t be written (read-only?)\n')])
    const s = await setUp(h, target)
    assert.ok(s.log.includes('setup: desk\'s line stays in /home/alice/.zshrc: it can\'t be written (read-only?)'), JSON.stringify(s.log))
})
