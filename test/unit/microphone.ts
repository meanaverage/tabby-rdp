// The microphone sent to a remote desktop (src/microphone.ts), with stand-ins for the browser's capture: the remote
// opens and closes it, and turning it off here (the setting, or Stop for a desktop) ends a capture at once and refuses
// the remote's later requests on that connection, also a capture that was still starting, and sends nothing captured
// before it. And how the service keeps it (src/desktop.service.ts): listed for the microphone in Tabby's header
// whatever is in front, said in a note when it starts on a desktop that isn't in view, a Stop kept for the desktop
// through the connections made in place of a dropped one, and the setting turned off reaching a connection still being
// set up. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const g = globalThis as any

/** The fake microphone: getUserMedia calls, and the tracks handed out. */
const device = {
    requests: 0,
    tracks: [] as { readyState: string, stop: () => void }[],
    /** While set, getUserMedia waits for this to resolve (a capture still starting). */
    gate: null as Promise<void> | null,
}
Object.defineProperty(g, 'navigator', {
    configurable: true,
    value: {
        mediaDevices: {
            getUserMedia: async () => {
                device.requests++
                await device.gate
                const track = { label: 'Fake microphone', readyState: 'live', stop () { this.readyState = 'ended' }, addEventListener () { } }
                device.tracks.push(track)
                return { getTracks: () => [track], getAudioTracks: () => [track] }
            },
        },
    },
})

/** The fake audio graph: the capture nodes made, and the later steps of starting a capture, which can be held up. */
const audio = {
    /** The worklet's nodes and the ScriptProcessors standing in for it, as made. */
    nodes: [] as any[],
    /** No AudioWorklet: its module is refused, and the ScriptProcessor captures instead. */
    noWorklet: false,
    /** While set, loading the worklet's module waits for this. */
    module: null as Promise<void> | null,
    /** What a new context's state is ('suspended': a window that hasn't been interacted with yet). */
    state: 'running',
    /** While set, resuming a suspended context waits for this. */
    resume: null as Promise<void> | null,
}
const node = () => ({ connect () { }, disconnect () { } })
/** As Chromium has it: a closed context takes no new nodes, and refuses a module it was still loading. */
const closedContext = () => Object.assign(new Error('the AudioContext is closed'), { name: 'InvalidStateError' })
g.AudioContext = class {
    sampleRate = 48000
    state = audio.state
    destination = {}
    audioWorklet = {
        addModule: async () => {
            if (audio.noWorklet) {
                throw new Error('no AudioWorklet here')
            }
            await audio.module
            if (this.state === 'closed') {
                throw closedContext()
            }
        },
    }

    createMediaStreamSource () { return node() }
    createGain () { return { ...node(), gain: { value: 1 } } }
    createScriptProcessor () {
        if (this.state === 'closed') {
            throw closedContext()
        }
        const processor = { ...node(), onaudioprocess: null }
        audio.nodes.push(processor)
        return processor
    }

    async close () { this.state = 'closed' }
    async resume () {
        await audio.resume
        this.state = 'running'
    }
}
g.AudioWorkletNode = class {
    port: any = {}
    constructor (context: { state: string }) {
        if (context.state === 'closed') {
            throw closedContext()
        }
        audio.nodes.push(this)
    }

    connect () { }
    disconnect () { }
}

/** A block of 20 ms at 48 kHz, stereo, as the worklet posts it, or as a ScriptProcessor's event carries it. */
const block = () => [new Float32Array(960).fill(0.25), new Float32Array(960).fill(0.25)]
const processed = () => ({ inputBuffer: { numberOfChannels: 2, getChannelData: () => new Float32Array(1024).fill(0.25) } })

const { Microphone } = require('../../dist/microphone.js')

const settle = () => new Promise(resolve => setTimeout(resolve, 10))
const OPEN = { type: 'open', sampleRate: 44100, channels: 2 }

function microphone (): { mic: any, changes: boolean[], log: string[], sent: Int16Array[], errors: string[] } {
    const changes: boolean[] = []
    const log: string[] = []
    const sent: Int16Array[] = []
    const errors: string[] = []
    const mic = new Microphone((pcm: Int16Array) => sent.push(pcm), () => changes.push(mic.capturing), (m: string) => log.push(m), (m: string) => errors.push(m))
    return { mic, changes, log, sent, errors }
}

test('the remote opens and closes the microphone', async () => {
    device.requests = 0
    const { mic, changes } = microphone()
    mic.callback(OPEN)
    await settle()
    assert.equal(mic.capturing, true)
    assert.equal(device.requests, 1)
    mic.callback({ type: 'close' })
    assert.equal(mic.capturing, false)
    assert.equal(device.tracks.at(-1)!.readyState, 'ended')
    assert.deepEqual(changes, [true, false])
})

test('turned off here: the capture ends at once, and later requests on the connection are refused', async () => {
    device.requests = 0
    const { mic, changes, log } = microphone()
    mic.callback(OPEN)
    await settle()
    assert.equal(mic.capturing, true)
    mic.turnOff()
    assert.equal(mic.capturing, false)
    assert.equal(device.tracks.at(-1)!.readyState, 'ended')
    mic.callback({ type: 'close' })
    mic.callback(OPEN)
    await settle()
    assert.equal(mic.capturing, false)
    assert.equal(device.requests, 1)
    assert.deepEqual(changes, [true, false])
    assert.ok(log.some(l => /turned off/.test(l)), log.join('\n'))
})

test('turned off while it was still starting: it never captures', async () => {
    device.requests = 0
    let release!: () => void
    device.gate = new Promise(resolve => { release = resolve })
    try {
        const { mic, changes } = microphone()
        mic.callback(OPEN)
        await settle()
        assert.equal(device.requests, 1)
        mic.turnOff()
        release()
        await settle()
        assert.equal(mic.capturing, false)
        assert.equal(device.tracks.at(-1)!.readyState, 'ended')
        assert.equal(device.requests, 1)  // not started over
        assert.deepEqual(changes, [])
    } finally {
        device.gate = null
    }
})

test('what was captured before Stop and arrives after it isn\'t sent: neither the worklet\'s blocks nor the ScriptProcessor\'s', async () => {
    for (const noWorklet of [false, true]) {
        audio.noWorklet = noWorklet
        try {
            const { mic, sent } = microphone()
            mic.callback(OPEN)
            await settle()
            const capture = audio.nodes.at(-1)
            const deliver = () => noWorklet ? capture.onaudioprocess(processed()) : capture.port.onmessage({ data: block() })
            deliver()
            assert.equal(sent.length, 1, 'a block while capturing is sent')
            assert.ok(sent[0].length > 0)
            // The worklet posts on its own thread: a block can be on its way when Stop comes.
            mic.turnOff()
            deliver()
            assert.equal(sent.length, 1, noWorklet ? 'ScriptProcessor' : 'AudioWorklet')
            // Closed by the remote, likewise.
            const again = microphone()
            again.mic.callback(OPEN)
            await settle()
            const later = audio.nodes.at(-1)
            again.mic.callback({ type: 'close' })
            noWorklet ? later.onaudioprocess(processed()) : later.port.onmessage({ data: block() })
            assert.equal(again.sent.length, 0)
        } finally {
            audio.noWorklet = false
        }
    }
})

test('turned off while the capture was still being set up, past the device: it never captures or says it does', async () => {
    // The worklet's module still loading: the stop closes the context, which then refuses the module and new nodes.
    // That is the stop, not a microphone that couldn't be opened, and the ScriptProcessor isn't tried instead.
    let loaded!: () => void
    audio.module = new Promise(resolve => { loaded = resolve })
    try {
        const { mic, changes, errors, log } = microphone()
        mic.callback(OPEN)
        await settle()
        mic.turnOff()
        loaded()
        await settle()
        assert.deepEqual([mic.capturing, changes, errors], [false, [], []])
        assert.equal(device.tracks.at(-1)!.readyState, 'ended')
        assert.ok(!log.some(l => /ScriptProcessor/.test(l)), log.join('\n'))
    } finally {
        audio.module = null
    }
    // A context that starts suspended, still resuming (Chromium holds audio until the window has been interacted with):
    // with the worklet, and with the ScriptProcessor in its place.
    for (const noWorklet of [false, true]) {
        let resumed!: () => void
        audio.state = 'suspended'
        audio.resume = new Promise(resolve => { resumed = resolve })
        audio.noWorklet = noWorklet
        try {
            const { mic, changes, errors } = microphone()
            mic.callback(OPEN)
            await settle()
            mic.turnOff()
            resumed()
            await settle()
            assert.deepEqual([mic.capturing, changes, errors], [false, [], []], noWorklet ? 'ScriptProcessor' : 'AudioWorklet')
            assert.equal(device.tracks.at(-1)!.readyState, 'ended')
        } finally {
            audio.state = 'running'
            audio.resume = null
            audio.noWorklet = false
        }
    }
})

test('turned on again here: the remote\'s requests are taken again, and one it has open starts at once', async () => {
    const { mic, changes, log } = microphone()
    mic.callback(OPEN)
    await settle()
    mic.turnOff()
    mic.turnOn()
    await settle()
    assert.equal(mic.capturing, true)
    assert.deepEqual(changes, [true, false, true])
    assert.ok(log.includes('microphone: turned on again here'), log.join('\n'))
    // Not open on the remote: it waits for the remote to open it.
    const closed = microphone()
    closed.mic.turnOff()
    closed.mic.turnOn()
    await settle()
    assert.equal(closed.mic.capturing, false)
    closed.mic.callback(OPEN)
    await settle()
    assert.equal(closed.mic.capturing, true)
})

// desktop.service.js is one of Tabby's Angular services: its microphone bookkeeping runs with stand-ins for Tabby.
class SplitTabComponent { }
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    if (request === 'tabby-core') {
        return { SplitTabComponent }
    }
    return request === 'tabby-settings' || request === 'tabby-terminal' ? {} : load.call(this, request, ...rest)
}
const { Subject } = require('rxjs')
const { RemoteDesktopService } = require('../../dist/desktop.service.js')
g.document = { visibilityState: 'visible' }

/**
 * The service, with a connected desktop per pane (each pane its own tab, the first one in front), as run() wires them.
 * Tabby's config says when it changes (`changed`), as when another window or the config file changes it.
 */
function desktops (...names: string[]): { service: any, app: any, panes: any[], sessions: any[], config: any, notes: string[], changed: any } {
    const notes: string[] = []
    const panes = names.map(name => ({ name }))
    const app = { tabs: panes, activeTab: panes[0] }
    const changed = new Subject()
    const config = { store: { remoteDesktop: { microphone: true, osd: {} } }, save () { }, changed$: changed }
    const service = new RemoteDesktopService(app, {}, { info: (text: string) => notes.push(text) }, config, { run: (f: () => unknown) => f() })
    const sessions = panes.map(pane => {
        const session = standIn(pane)
        session.mic = new Microphone(() => { }, () => service.microphoneChanged(pane, session, session.mic), (m: string) => session.log.push(m), () => { })
        service.sessions.set(pane, session)
        return session
    })
    return { service, app, panes, sessions, config, notes, changed }
}

/** A connected desktop in `pane`, as the service sees one (a DesktopSession), without a microphone yet. */
function standIn (pane: { name: string }): any {
    const classes = new Set<string>()
    return {
        key: `rdp#${pane.name}:3389`,
        spec: { id: `${pane.name}:3389`, name: `${pane.name} desktop` },
        visible: true,
        state: 'connected',
        clipboard: 'both',
        clipboardCap: 'both',
        log: [] as string[],
        overlay: {
            classList: { toggle: (c: string, on: boolean) => on ? classes.add(c) : classes.delete(c), contains: (c: string) => classes.has(c) },
            getBoundingClientRect: () => ({ width: 0, height: 0 }),
            addEventListener () { },
            removeEventListener () { },
        },
        host: { querySelector: () => null },
        dispose () { },
    }
}

const users = (service: any) => service.microphoneUsers().map((u: { name: string }) => u.name)

test('a capture is listed for the header, and shows as the dot on its desktop', async () => {
    const { service, sessions, notes } = desktops('alpha', 'beta')
    let changes = 0
    service.changed$.subscribe(() => changes++)
    sessions[0].mic.callback(OPEN)
    await settle()
    assert.deepEqual(users(service), ['alpha desktop'])
    assert.equal(service.microphoneUsers()[0].inView, true)
    assert.equal(sessions[0].overlay.classList.contains('trd-mic-on'), true)
    assert.equal(changes, 1)
    assert.deepEqual(notes, [])  // in view: its dot says it
    sessions[0].mic.callback({ type: 'close' })
    assert.deepEqual(users(service), [])
    assert.equal(sessions[0].overlay.classList.contains('trd-mic-on'), false)
    assert.equal(changes, 2)
})

test('a capture that starts out of view is said in a note, at most once a minute per desktop', async () => {
    const { service, app, panes, sessions, notes } = desktops('alpha', 'beta', 'gamma')
    sessions[0].visible = false  // alpha: its console in front
    sessions[0].mic.callback(OPEN)
    sessions[1].mic.callback(OPEN)  // beta: its tab in the background
    await settle()
    assert.equal(notes.length, 2, notes.join('\n'))
    // What the plugin knows: the desktop gets the microphone. Not that "an app" records.
    assert.match(notes[0], /^alpha desktop is receiving your microphone, and that desktop isn't showing\./)
    assert.match(notes[1], /^beta desktop is receiving your microphone/)
    assert.deepEqual(users(service), ['alpha desktop', 'beta desktop'])
    assert.deepEqual(service.microphoneUsers().map((u: { inView: boolean }) => u.inView), [false, false])
    // Stopped and started again soon after: the header still shows it, without another note.
    sessions[0].mic.callback({ type: 'close' })
    sessions[0].mic.callback(OPEN)
    await settle()
    assert.equal(notes.length, 2)
    // In front, but the window is hidden.
    app.activeTab = panes[2]
    g.document.visibilityState = 'hidden'
    try {
        sessions[2].mic.callback(OPEN)
        await settle()
    } finally {
        g.document.visibilityState = 'visible'
    }
    assert.equal(notes.length, 3)
    assert.match(notes[2], /gamma desktop/)
})

test('Stop sends no more to that desktop; turning the setting off stops all of them at once', async () => {
    const { service, panes, sessions, config } = desktops('alpha', 'beta')
    sessions.forEach(s => s.mic.callback(OPEN))
    await settle()
    assert.deepEqual(users(service), ['alpha desktop', 'beta desktop'])
    service.stopMicrophone(panes[0])
    assert.deepEqual(users(service), ['beta desktop'])
    assert.equal(sessions[0].overlay.classList.contains('trd-mic-on'), false)
    sessions[0].mic.callback({ type: 'close' })
    sessions[0].mic.callback(OPEN)
    await settle()
    assert.deepEqual(users(service), ['beta desktop'])  // refused for the rest of the connection
    service.updateSettings({ microphone: false })
    assert.equal(config.store.remoteDesktop.microphone, false)
    assert.deepEqual(users(service), [])
    sessions[1].mic.callback({ type: 'close' })
    sessions[1].mic.callback(OPEN)
    await settle()
    assert.deepEqual(users(service), [])
})

/**
 * The connection setup for a stand-in desktop in `pane`, up to connecting (which fails here), without run()'s final
 * teardown: the tests exercise the wired microphone afterward. Returns the callback wired to IronRDP's audioInput
 * extension (null: the connection has no microphone). `rdp`: more of IronRDP's module.
 */
async function connecting (service: any, pane: any, session: any, rdp: Record<string, unknown> = {}) {
    let ready: (event: unknown) => void = () => { }
    g.document.createElement = () => ({ setAttribute () { }, addEventListener: (_: string, handler: (event: unknown) => void) => { ready = handler } })
    let microphone: ((message: unknown) => void) | null = null
    const builder: any = new Proxy({}, { get: (_, key) => key === 'build' ? () => ({}) : () => builder })
    const ui = {
        enableFileTransfer (provider: any) {
            provider.onUploadStarted = () => { }
            provider.onUploadFinished = () => { }
        },
        setEnableClipboard () { },
        configBuilder: () => builder,
        connect: async () => { throw new Error('not connected here') },
        invokeExtension () { },
    }
    Object.assign(session, {
        disposed: new Promise<void>(() => { }),
        host: { replaceChildren: () => ready({ detail: { irgUserInteraction: ui } }), querySelector: () => null },
        proxy: { url: 'ws://127.0.0.1:1/token', token: 'token' },
        status () { },
        files: null,
    })
    const outcome = await service.runConnection(pane, { key: 'rdp', label: 'Win', direct: session.spec }, session.spec, session, {
        Backend: {},
        RdpFileTransferProvider: class { handleFileContentsRequest () { } on () { } dispose () { } },
        displayControl: () => 'display control',
        audioPlayback: () => 'sound',
        audioInput: (callback: (message: unknown) => void) => { microphone = callback; return 'microphone' },
        audioInputData: () => 'audio',
        ...rdp,
    }, { host: '10.0.0.5', port: 3389, credentials: { username: 'u', password: 'p' } }, new AbortController().signal)
    assert.equal(outcome.error, 'not connected here')
    return microphone as ((message: unknown) => void) | null
}

test('Stop holds for the desktop: a connection made in place of a dropped one gets nothing until it is turned back on', async () => {
    const { service, panes, sessions } = desktops('alpha')
    sessions[0].mic.callback(OPEN)
    await settle()
    service.stopMicrophone(panes[0])
    assert.equal(service.microphoneStoppedFor(panes[0]), true)
    assert.deepEqual(users(service), [])
    // The server ends the connection, and the plugin reconnects by itself: the desktop is dropped, and a new one for the
    // same desktop connects in its place (reopen() and showDesktop()).
    service.disconnect(panes[0])
    const again = standIn(panes[0])
    service.sessions.set(panes[0], again)
    const microphone = await connecting(service, panes[0], again)
    assert.ok(microphone, 'the setting is on: the connection has a microphone')
    microphone!(OPEN)
    await settle()
    assert.equal(again.mic.capturing, false)
    assert.deepEqual(users(service), [])
    assert.ok(again.log.includes('microphone: not sent: turned off here'), again.log.join('\n'))
    // Turned back on in the desktop's menu: the remote has it open, so it is sent at once, and from then on.
    service.resumeMicrophone(panes[0])
    await settle()
    assert.equal(service.microphoneStoppedFor(panes[0]), false)
    assert.deepEqual(users(service), ['alpha desktop'])
    const later = standIn(panes[0])
    service.sessions.set(panes[0], later)
    ;(await connecting(service, panes[0], later))!(OPEN)
    await settle()
    assert.equal(later.mic.capturing, true)
})

/** An element of the page, as far as a desktop's layer (DesktopSession) uses one. */
class LayerElement {
    className = ''
    innerHTML = ''
    textContent = ''
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

test('Stop holds through the reconnect the plugin makes by itself when the server drops the connection', async () => {
    const config = { store: { remoteDesktop: { microphone: true, osd: {} } }, save () { }, changed$: new Subject() }
    const pane = { name: 'alpha', element: { nativeElement: new LayerElement() }, destroyed$: new Subject(), focused$: new Subject() }
    const app = { tabs: [pane], activeTab: pane, selectTab () { } }
    const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
    const service = new RemoteDesktopService(app, {}, { info () { }, error () { } }, config, zone)
    service.help = { tipOnce () { }, note () { }, explain () { } }
    // The desktop's connections as the service starts them, each run as far as run() goes here (see connecting()).
    const made: any[] = []
    service.connect = (_: unknown, target: unknown, _spec: unknown, session: any) => {
        made.push(session)
        Object.assign(session, { remote: target, state: 'connected' })
    }
    const spec = { id: '10.0.0.5:3389', name: 'alpha desktop' }
    const target = { key: 'rdp', label: 'alpha', direct: spec, isOpen: () => true }
    const layers = () => {
        g.document.createElement = () => new LayerElement()
        g.getComputedStyle = () => ({ position: 'relative' })
    }
    layers()
    await service.showDesktop(pane, undefined, { target, background: true })
    const first = made[0]
    ;(await connecting(service, pane, first))!(OPEN)
    first.proxy.close = () => { }
    await settle()
    assert.deepEqual(users(service), ['alpha desktop'])
    service.stopMicrophone(pane)
    assert.deepEqual(users(service), [])
    // The server resets the connection: the plugin connects again by itself, a second later, in a new session.
    layers()
    service.afterEnd(pane, target, spec, first, { connected: true, error: 'connection reset by peer' })
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal(made.length, 2, 'connected again')
    const second = made[1]
    assert.deepEqual([service.sessions.get(pane) === second, second.key, service.microphoneStoppedFor(pane)], [true, first.key, true])
    const microphone = await connecting(service, pane, second)
    second.proxy.close = () => { }
    microphone!(OPEN)
    await settle()
    assert.deepEqual([second.mic.capturing, users(service)], [false, []])
    service.disconnect(pane)
})

test('Stop is for that desktop only, and Send again doesn\'t override the setting turned off', async () => {
    const { service, panes, sessions } = desktops('alpha', 'beta')
    service.stopMicrophone(panes[0])
    const beta = standIn(panes[1])
    service.sessions.set(panes[1], beta)
    ;(await connecting(service, panes[1], beta))!(OPEN)
    await settle()
    assert.deepEqual(users(service), ['beta desktop'])
    service.updateSettings({ microphone: false })
    sessions[0].mic.callback(OPEN)
    service.resumeMicrophone(panes[0])
    await settle()
    assert.deepEqual(users(service), [])
})

test('the setting turned off reaches a connection still being set up, and open ones when another window changes it', async () => {
    const { service, panes, sessions } = desktops('alpha', 'beta')
    // beta connects, and waits for the browser to say whether it decodes H.264 meanwhile; the setting goes off then.
    let answer!: (supported: boolean) => void
    const asked = new Promise<boolean>(resolve => { answer = resolve })
    const connected = connecting(service, panes[1], sessions[1], {
        graphicsPipeline: () => 'pipeline',
        h264Decoder: () => 'h264',
        h264Supported: () => asked,
        WebCodecsH264Decoder: class { close () { } },
    })
    await settle()
    service.updateSettings({ microphone: false })
    answer(true)
    assert.equal(await connected, null, 'no microphone for a connection set up after the setting went off')
    assert.equal(sessions[1].mic, null)
    // Turned on again: that applies on the next connection. alpha's stays off for this one.
    service.updateSettings({ microphone: true })
    sessions[0].mic.callback(OPEN)
    await settle()
    assert.deepEqual(users(service), [])

    // Changed in another Tabby window (or the config file, or by sync): Tabby only says the config changed.
    const elsewhere = desktops('gamma')
    elsewhere.sessions[0].mic.callback(OPEN)
    await settle()
    assert.deepEqual(users(elsewhere.service), ['gamma desktop'])
    elsewhere.config.store.remoteDesktop.microphone = false
    elsewhere.changed.next()
    assert.deepEqual(users(elsewhere.service), [])
    elsewhere.sessions[0].mic.callback({ type: 'close' })
    elsewhere.sessions[0].mic.callback(OPEN)
    await settle()
    assert.deepEqual(users(elsewhere.service), [])
})
