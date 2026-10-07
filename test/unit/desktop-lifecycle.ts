// A desktop's connection over time, in the desktop service (src/desktop.service.ts), with Tabby's modules and IronRDP
// stubbed: a desktop closed while its proxy starts or while it connects gets nothing more, a reconnected desktop that
// drops at once goes on backing off and stops, a video decoder the browser takes back again turns H.264 off, and the
// proxy's token stays out of what a failed connection says. The service's own methods run; nothing reaches a server.
// Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'

const require = createRequire(import.meta.url)

// Tabby and Angular, as far as loading the service needs them.
const decorator = () => () => undefined
const stubs: Record<string, unknown> = {
    '@angular/core': { Injectable: decorator, NgZone: class { } },
    'tabby-core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-settings': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { RemoteDesktopService } = require('../../dist/desktop.service.js')
const rdcleanpath = require('../../dist/rdcleanpath.js')
const WebSocket = require('ws')

/** The service on a config of its own; what it would do to Tabby's window around a connection is left out. */
function service () {
    const config = {
        store: { remoteDesktop: { desktops: [], accounts: [], trustedCertificates: [], withoutNla: [] }, profiles: [] },
        save () { },
        changed$: { subscribe () { } },
    }
    const notifications = { notice () { }, info () { }, error () { } }
    const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
    const svc = new RemoteDesktopService({ tabs: [] }, {}, notifications, config, zone, {}, {}, {}, {})
    const revisions = new Map<string, string>()
    svc.accountRevisions = new (require('../../dist/accountRevisions.js').AccountRevisions)(() => ({
        getItem: (key: string) => revisions.get(key) ?? null, setItem: (key: string, value: string) => revisions.set(key, value),
    }), () => true)
    for (const method of ['applySize', 'watchSize', 'tip', 'label', 'syncIndicator']) {
        svc[method] = () => { }
    }
    return svc
}

/**
 * IronRDP as run() uses it, and the component it puts in the layer. The component's connect() does `connect`, with
 * the configuration it was built with; the connection's run() does `run`. Decoders made are kept.
 */
function ironrdp (connect: (config: string[]) => Promise<any>) {
    const decoders: any[] = []
    let ready: (event: unknown) => void = () => { }
    const element = { setAttribute () { }, addEventListener: (_: string, handler: (event: unknown) => void) => { ready = handler } }
    ;(globalThis as any).document = { createElement: () => element }
    const ui = {
        enableFileTransfer (provider: any) {
            provider.onUploadStarted = () => { }
            provider.onUploadFinished = () => { }
        },
        setEnableClipboard () { },
        setVisibility () { },
        configBuilder () {
            const config: string[] = []
            const builder: any = new Proxy({}, {
                get: (_, method: string) => method === 'build' ? () => config : (value: unknown) => {
                    config.push(`${method}:${typeof value === 'object' ? JSON.stringify(value) : value}`)
                    return builder
                },
            })
            return builder
        },
        connect,
    }
    const rdp = {
        Backend: {},
        RdpFileTransferProvider: class { handleFileContentsRequest () { } on () { } dispose () { } },
        displayControl: () => 'displayControl',
        graphicsPipeline: (on: boolean) => `graphicsPipeline ${on}`,
        h264Decoder: () => 'h264Decoder',
        h264Supported: async () => true,
        WebCodecsH264Decoder: class {
            failed: string | null = null
            reclaimed = false
            constructor () { decoders.push(this) }
            close () { }
        },
        audioPlayback: () => 'audioPlayback',
    }
    return { rdp, decoders, ready: () => ready({ detail: { irgUserInteraction: ui } }) }
}

/** A desktop session being connected in `pane`, as run() sees one; `onReady`: its component is put in the layer. */
function session (svc: any, pane: object, onReady: () => void) {
    const s: any = {
        spec: { id: '10.0.0.5:3389', name: 'Win', kind: 'windows', host: '10.0.0.5', port: 3389 },
        key: 'rdp#10.0.0.5:3389',
        log: [] as string[],
        visible: false,
        state: 'connecting',
        files: null,
        h264: null,
        disposed: new Promise<void>(() => { }),
        host: { replaceChildren: () => onReady() },
        overlay: { addEventListener () { }, removeEventListener () { }, classList: { remove () { } }, getBoundingClientRect: () => ({ width: 1280, height: 800 }) },
        status () { },
        proxy: { url: 'ws://127.0.0.1:50000/0123456789abcdef', token: '0123456789abcdef', failure: null, stats: { bytesIn: 0, bytesOut: 0 }, close () { } },
    }
    svc.sessions.set(pane, s)
    return s
}

const target = { key: 'rdp', label: 'Win', isOpen: () => true }
const endpoint = { host: '10.0.0.5', port: 3389, credentials: { username: 'u', password: 'p' } }

/** A connected attempt whose Rust run promise can hang, trap independently, or settle after the attempt ended. */
async function pendingConnection (svc: any, pane: object) {
    let started!: () => void
    const runningRust = new Promise<void>(resolve => { started = resolve })
    let finish!: (value: unknown) => void
    let fail!: (error: Error) => void
    const result = new Promise((resolve, reject) => { finish = resolve; fail = reject })
    const { rdp, ready } = ironrdp(async () => ({ run: () => { started(); return result } }))
    rdp.h264Supported = async () => false
    let trap!: (error: Error) => void
    const backend = { ...rdp, runtime: { onTrap: (f: (error: Error) => void) => { trap = f; return () => { } }, dispose () { } } }
    const s = session(svc, pane, ready)
    let dispose!: () => void
    s.disposed = new Promise<void>(resolve => { dispose = resolve })
    const shown: string[] = []
    s.status = (message: string) => { shown.push(message) }
    const running = svc.run(pane, target, s.spec, s, backend, endpoint)
    await runningRust
    assert.equal(s.state, 'connected')
    return { s, running, finish, fail, dispose, shown, trap: () => trap(new WebAssembly.RuntimeError('synthetic trap')) }
}

test('a desktop closed while its proxy starts gets the proxy closed, and doesn\'t go on to connect', async () => {
    const svc = service()
    const pane = {}
    const s = session(svc, pane, () => { })
    delete s.proxy
    svc.endpointFor = async () => ({ ...endpoint })
    svc.loadIronRDP = async () => ({})
    let ran = false
    svc.run = async () => { ran = true; return { connected: false } }
    const start = rdcleanpath.startRDCleanPathProxy
    let started: any = null
    rdcleanpath.startRDCleanPathProxy = async (...args: unknown[]) => {
        started = await start(...args)
        // The desktop is closed meanwhile.
        svc.sessions.delete(pane)
        return started
    }
    try {
        await svc.connect(pane, target, s.spec, s)
    } finally {
        rdcleanpath.startRDCleanPathProxy = start
    }
    assert.ok(started, 'a proxy was started')
    assert.equal(ran, false)
    assert.equal(s.proxy, undefined)
    // Its port is closed: nothing can connect there any more.
    const ws = new WebSocket(started.url)
    assert.equal(await new Promise(resolve => { ws.once('open', () => { ws.terminate(); resolve('open') }); ws.once('error', () => resolve('refused')) }), 'refused')
})

test('a desktop closed as its component gets ready is given no clipboard, files or decoder', async () => {
    const svc = service()
    const pane = {}
    const { rdp, ready } = ironrdp(async () => { throw new Error('connected after all') })
    const s = session(svc, pane, () => {
        ready()
        svc.sessions.delete(pane)
    })
    assert.deepEqual(await svc.run(pane, target, s.spec, s, rdp, endpoint), { connected: false })
    assert.equal(s.files, null)
    assert.equal(s.clipboard, undefined)
})

test('a desktop closed while the browser is asked about H.264 gets no decoder, sound, microphone or drives', async () => {
    const svc = service()
    const pane = {}
    const { rdp, ready, decoders } = ironrdp(async () => { throw new Error('connected after all') })
    rdp.h264Supported = async () => {
        svc.sessions.delete(pane)
        return true
    }
    const s = session(svc, pane, ready)
    assert.deepEqual(await svc.run(pane, target, s.spec, s, rdp, endpoint), { connected: false })
    assert.equal(decoders.length, 0)
    assert.equal(s.h264, null)
    assert.equal(s.audio, undefined)
})

test('a failed connection doesn\'t say the proxy\'s token, where IronRDP names the proxy\'s address', async () => {
    const svc = service()
    const pane = {}
    // IronRDP's error when the WebSocket to the proxy doesn't open (its kind: ProxyConnect).
    const refused = (url: string) => ({ kind: () => 6, backtrace: () => `failed to connect to ${url} (WebSocket is \`Closed\`)\n\nStack:\n  0: ironrdp_web::session` })
    const { rdp, ready } = ironrdp(async () => { throw refused(s.proxy.url) })
    const s = session(svc, pane, ready)
    const outcome = await svc.run(pane, target, s.spec, s, rdp, endpoint)
    assert.equal(outcome.connected, false)
    assert.match(outcome.error, /^failed to connect to ws:\/\/127\.0\.0\.1:50000\/… \(WebSocket is `Closed`\)/)
    assert.ok(![outcome.error, ...s.log].some(line => line.includes(s.proxy.token)), [outcome.error, ...s.log].join('\n'))
    // The same for a refused sign-in's line in the log.
    const { rdp: rdp2, ready: ready2 } = ironrdp(async () => { throw { kind: () => 2, backtrace: () => `logon failure through ${s.proxy.url}` } })
    const s2 = session(svc, pane, ready2)
    assert.equal((await svc.run(pane, target, s2.spec, s2, rdp2, endpoint)).signInFailed, 'The sign-in was refused.')
    assert.ok(s2.log.some((line: string) => /^sign-in failed: logon failure through ws:\/\/127\.0\.0\.1:50000\/…$/.test(line)), s2.log.join('\n'))
})

test('a reconnected desktop that drops at once goes on backing off; one that stayed up 30 s is back for good', async () => {
    const svc = service()
    const pane = {}
    const realNow = Date.now
    let upFor = 0
    const { rdp, ready } = ironrdp(async () => ({
        run: async () => {
            // How long the connection stayed up before it dropped.
            const now = realNow()
            Date.now = () => now + upFor
            throw new Error('the server ended the connection')
        },
    }))
    rdp.h264Supported = async () => false
    const shown: string[] = []
    const drop = async (ms: number) => {
        upFor = ms
        const s = session(svc, pane, ready)
        s.status = (text: string) => { shown.push(text) }
        try {
            const outcome = await svc.run(pane, target, s.spec, s, rdp, endpoint)
            assert.equal(outcome.error, 'the server ended the connection')
        } finally {
            Date.now = realNow
        }
        // As afterEnd does for a connection that dropped: the next reconnect, its wait shown.
        svc.scheduleReconnect(pane, target, s.spec, s, 'Connection lost.')
        clearTimeout(svc.reconnects.get(pane)?.timer)
        return shown[shown.length - 1]
    }
    // Reconnecting already (its first wait, a second, is behind it): each connection drops within a second.
    svc.reconnects.set(pane, { attempts: 1, since: 0 })
    for (const wait of [2, 4, 8, 15, 30]) {
        assert.match(await drop(1000), new RegExp(`Reconnecting in ${wait} s`))
    }
    assert.match(await drop(1000), /Stopped reconnecting automatically/)
    assert.equal(svc.reconnects.has(pane), false)
    // Reconnecting again later, and up for 30 seconds before it dropped: the waits start over.
    svc.reconnects.set(pane, { attempts: 4, since: 0 })
    assert.match(await drop(30000), /Reconnecting in 1 s/)
    clearTimeout(svc.reconnects.get(pane)?.timer)
})

test('a stable connection resets reconnect backoff exactly once on an asynchronous trap or ordinary end', async t => {
    let now = 1000
    t.mock.method(Date, 'now', () => now)
    const svc = service(), pane = {}
    t.after(() => svc.cancelReconnect(pane))
    const account = t.mock.method(svc, 'reconnectedUntilNow')
    for (const ending of ['trap', 'disconnect', 'graceful']) {
        svc.reconnects.set(pane, { attempts: 5, since: now })
        const attempt = await pendingConnection(svc, pane)
        const before = account.mock.callCount()
        now += 31000
        if (ending === 'trap') attempt.trap()
        else if (ending === 'disconnect') attempt.fail(new Error('ordinary disconnect'))
        else attempt.finish({ reason: () => 'logged off' })
        const outcome = await attempt.running
        assert.equal(outcome.connected, true)
        assert.equal(account.mock.callCount(), before + 1, ending)
        assert.equal(svc.reconnects.has(pane), false, `${ending} resets the old budget`)
        svc.afterEnd(pane, target, attempt.s.spec, attempt.s, outcome)
        if (ending === 'graceful') {
            assert.equal(svc.reconnects.has(pane), false)
            assert.match(attempt.shown.at(-1)!, /Remote desktop session ended: logged off/)
        } else {
            assert.equal(svc.reconnects.get(pane)?.attempts, 1)
            assert.match(attempt.shown.at(-1)!, /Reconnecting in 1 s/)
        }
        svc.cancelReconnect(pane)
    }
})

test('short-lived asynchronous traps retain the bounded reconnect budget', async t => {
    let now = 1000
    t.mock.method(Date, 'now', () => now)
    const svc = service(), pane = {}
    t.after(() => svc.cancelReconnect(pane))
    const account = t.mock.method(svc, 'reconnectedUntilNow')
    svc.reconnects.set(pane, { attempts: 1, since: now })
    for (const delay of [2, 4, 8, 15, 30, null]) {
        const attempt = await pendingConnection(svc, pane)
        const before = account.mock.callCount()
        now += 1000
        attempt.trap()
        const outcome = await attempt.running
        assert.equal(account.mock.callCount(), before + 1)
        assert.equal(svc.reconnects.get(pane)?.since, now)
        svc.afterEnd(pane, target, attempt.s.spec, attempt.s, outcome)
        assert.match(attempt.shown.at(-1)!, delay === null ? /Stopped reconnecting automatically/ : new RegExp(`Reconnecting in ${delay} s`))
        clearTimeout(svc.reconnects.get(pane)?.timer)
    }
    assert.equal(svc.reconnects.has(pane), false)
})

test('late Rust settlement after a trap cannot change a retry\'s accounting, decoder policy or resources', async t => {
    let now = 1000
    t.mock.method(Date, 'now', () => now)
    const svc = service(), pane = {}
    const account = t.mock.method(svc, 'reconnectedUntilNow')
    for (const rejects of [false, true]) {
        const attempt = await pendingConnection(svc, pane)
        now += 1000
        attempt.trap()
        await attempt.running
        const accounted = account.mock.callCount()
        // A startup/sign-in retry can reuse the DesktopSession. Its resources and the pane's retry state are new.
        const retry = { attempts: 2, since: now }
        svc.reconnects.set(pane, retry)
        let closed = 0, reasonRead = 0
        attempt.s.mic = { close: () => closed++ }
        attempt.s.drives = { dispose: () => closed++ }
        attempt.s.h264 = { failed: 'new decoder', reclaimed: true }
        now += 60000
        if (rejects) attempt.fail(new Error('late failure'))
        else attempt.finish({ reason: () => { reasonRead++; return 'late result' } })
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(account.mock.callCount(), accounted)
        assert.equal(svc.reconnects.get(pane), retry)
        assert.deepEqual(retry, { attempts: 2, since: now - 60000 })
        assert.equal(closed, 0)
        assert.equal(reasonRead, 0)
        assert.equal(svc.h264Failed.size, 0)
        assert.equal(svc.h264Reclaimed.size, 0)
    }
})

test('disposing an old attempt cannot reset a replacement session\'s reconnect state', async t => {
    let now = 1000
    t.mock.method(Date, 'now', () => now)
    const svc = service(), pane = {}
    const account = t.mock.method(svc, 'reconnectedUntilNow')
    const attempt = await pendingConnection(svc, pane)
    now += 31000
    const replacement = session(svc, pane, () => { })
    const retry = { attempts: 3, since: now }
    svc.reconnects.set(pane, retry)
    attempt.dispose()
    assert.deepEqual(await attempt.running, { connected: false })
    attempt.fail(new Error('old Rust run settles after disposal'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(account.mock.callCount(), 0)
    assert.equal(svc.sessions.get(pane), replacement)
    assert.equal(svc.reconnects.get(pane), retry)
    assert.deepEqual(retry, { attempts: 3, since: now })
})

test('a video decoder the browser takes back twice turns H.264 off for the desktop: the next connection has bitmaps', async () => {
    const svc = service()
    const pane = {}
    const configs: string[][] = []
    let decoder: any = null
    const { rdp, ready, decoders } = ironrdp(async (config: string[]) => {
        configs.push(config)
        decoder = decoders[decoders.length - 1] ?? null
        return {
            run: async () => {
                // A hidden window: the browser takes the idle decoder back, which ends the connection.
                if (decoder) {
                    decoder.failed = 'the browser took the decoder back'
                    decoder.reclaimed = true
                    decoders.length = 0
                }
                throw new Error('decoding failed')
            },
        }
    })
    const connectOnce = async () => {
        const s = session(svc, pane, ready)
        return (await svc.run(pane, target, s.spec, s, rdp, endpoint)).error
    }
    // The first time, it reconnects with H.264: a new stream starts with a key frame.
    assert.equal(await connectOnce(), 'the video decoder was reclaimed')
    assert.ok(configs[0].includes('withExtension:h264Decoder'), configs[0].join('\n'))
    // Taken back again soon after: it goes like any other failure of the decoder.
    assert.match(await connectOnce(), /^H\.264 decoding failed \(the browser took the decoder back\); continuing without it$/)
    assert.equal(await connectOnce(), 'decoding failed')
    assert.ok(!configs[2].includes('withExtension:h264Decoder') && configs[2].includes('withExtension:graphicsPipeline false'), configs[2].join('\n'))
})

test('a sign-in that completes after its desktop was edited or removed doesn\'t save its password again', async t => {
    const signin = require('../../dist/signin.js')
    const saved = new Map<string, string>()
    stubs.keytar = {
        getPassword: async (_service: string, key: string) => saved.get(key) ?? null,
        setPassword: async (_service: string, key: string, value: string) => { saved.set(key, value) },
        deletePassword: async (_service: string, key: string) => { saved.delete(key) },
        findCredentials: async () => [...saved].map(([account, password]) => ({ account, password })),
    }
    t.after(() => { delete stubs.keytar })
    const svc = service()
    const pane = {}
    // The form was answered with "remember", and the server takes its time: the desktop changes meanwhile (`between`).
    const signedIn = async (key: string, between?: () => Promise<unknown>) => {
        saved.clear()
        const { rdp, ready } = ironrdp(async () => {
            await between?.()
            return { run: async () => ({ reason: () => 'ended' }) }
        })
        const s = session(svc, pane, ready)
        s.credentialKey = key
        const mark = signin.forgetMark()
        await svc.run(pane, target, s.spec, s, rdp, { ...endpoint, remember: true, mark })
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setImmediate(resolve))
        }
        return { saved: [...saved.keys()], log: s.log.filter((line: string) => /^sign-in: /.test(line)) }
    }
    const kept = (key: string) => ({ saved: [key], log: ['sign-in: saved in the keychain'] })
    const notSaved = { saved: [], log: ['sign-in: not saved: the desktop was changed or removed meanwhile'] }
    const direct = 'rdp#10.0.0.5:3389'
    const behind = 'alice@h:22#10.0.0.5:3389'
    assert.deepEqual(await signedIn(direct), kept(direct))
    // Edited (its user name, its gateway, its address) or removed meanwhile: what was forgotten stays forgotten.
    assert.deepEqual(await signedIn(direct, () => signin.forgetCredentialsFor('10.0.0.5:3389', { direct: true, scope: '' })), notSaved)
    assert.deepEqual(await signedIn(direct, () => signin.moveCredentialsFor('10.0.0.5:3389', '10.0.0.9:3389', { direct: true, scope: '' })), notSaved)
    assert.deepEqual(await signedIn(behind, () => signin.forgetCredentialsFor('10.0.0.5:3389')), notSaved)
    // Forgotten while the password is being written: it goes once it is there (the store's operations come in turn, and
    // the sign-in forgets it again besides).
    {
        saved.clear()
        let write = () => { }
        const written = new Promise<void>(resolve => { write = resolve })
        const keytar = stubs.keytar as any
        const setPassword = keytar.setPassword
        keytar.setPassword = async (service: string, key: string, value: string) => { await written; return setPassword(service, key, value) }
        const { rdp, ready } = ironrdp(async () => ({ run: async () => ({ reason: () => 'ended' }) }))
        const s = session(svc, pane, ready)
        s.credentialKey = direct
        await svc.run(pane, target, s.spec, s, rdp, { ...endpoint, remember: true, mark: signin.forgetMark() })
        const forgetting = signin.forgetCredentialsFor('10.0.0.5:3389', { direct: true, scope: '' })
        write()
        await forgetting
        for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setImmediate(resolve))
        }
        keytar.setPassword = setPassword
        assert.deepEqual([[...saved.keys()], s.log.filter((line: string) => /^sign-in: /.test(line))],
            [[], ['sign-in: saved, then forgotten again: the desktop was changed or removed meanwhile']])
    }
    assert.deepEqual(await signedIn(behind, () => signin.moveCredentialsFor('10.0.0.5:3389', '10.0.0.9:3389')), notSaved)
    assert.deepEqual(await signedIn(direct, () => signin.forgetCredentialsOrFail(direct)), notSaved)
    // Another desktop's, or the same address reached another way (through a gateway, or behind a host), is none of its
    // business.
    assert.deepEqual(await signedIn(direct, () => signin.forgetCredentialsFor('10.0.0.6:3389', { direct: true })), kept(direct))
    assert.deepEqual(await signedIn(direct, () => signin.forgetCredentialsFor('10.0.0.5:3389', { direct: true, scope: '@gateway#gw.example:443' })), kept(direct))
    assert.deepEqual(await signedIn(direct, () => signin.forgetCredentialsFor('10.0.0.5:3389')), kept(direct))
    // One that began after the edit asks for its own, and is saved.
    await signin.forgetCredentialsFor('10.0.0.5:3389', { direct: true, scope: '' })
    assert.deepEqual(await signedIn(direct), kept(direct))
})

test('unavailable account coordination reports an actionable error without changing config or secrets', async t => {
    const svc = service()
    const account = { id: 'shared', name: 'Account', username: 'user' }
    svc.config.store.remoteDesktop.accounts = [account]
    svc.accountRevisions = new (require('../../dist/accountRevisions.js').AccountRevisions)(() => ({}), () => false)
    const messages: string[] = []
    svc.notifications.error = (message: string) => messages.push(message)
    svc.platform.showMessageBox = async () => ({ response: 0 })
    stubs.keytar = { setPassword: () => assert.fail('unexpected store write'), deletePassword: () => assert.fail('unexpected store deletion') }
    t.after(() => { delete stubs.keytar })
    assert.match((await svc.saveAccount(account, 'unused')).keychainError, /Restart or update Tabby/)
    assert.equal(await svc.confirmRemoveAccount(account.id), false)
    assert.match(messages[0], /Restart or update Tabby/)
    assert.deepEqual(svc.accounts(), [account])
})

for (const store of ['keychain', 'vault']) {
    test(`account edits during an active ${store} write clean stale work before removal or replacement`, async t => {
        const signin = require('../../dist/signin.js')
        const saved = new Map<string, string>()
        let finish!: () => void
        let started!: () => void
        let waiting: Promise<void>
        const put = async (key: string, value: string) => {
            if (JSON.parse(value).password === 'before') { started(); await waiting }
            saved.set(key, value)
        }
        stubs.keytar = {
            getPassword: async (_: string, key: string) => store === 'keychain' ? saved.get(key) ?? null : null,
            setPassword: (_: string, key: string, value: string) => put(key, value),
            deletePassword: async (_: string, key: string) => { if (store === 'keychain') { saved.delete(key) } },
            findCredentials: async () => [],
        }
        signin.useVault(store === 'vault' ? {
            isEnabled: () => true, isOpen: () => true, load: async () => ({ secrets: [] }),
            addSecret: (secret: any) => put(secret.key.key, secret.value),
            removeSecret: async (_: string, key: any) => { saved.delete(key.key) },
        } : null)
        t.after(() => { finish?.(); signin.useVault(null); delete stubs.keytar })
        for (const action of ['remove', 'rename']) {
            saved.clear()
            waiting = new Promise<void>(resolve => { finish = resolve })
            const writing = new Promise<void>(resolve => { started = resolve })
            const svc = service()
            const account = { id: 'shared', name: 'Account', username: 'user' }
            svc.config.store.remoteDesktop.accounts = [account]
            const old = svc.saveAccount(account, 'before')
            await writing
            const revision = svc.accounts()[0].credentialRevision
            const edit = action === 'remove' ? svc.removeAccount(account.id) : svc.saveAccount({ ...account, username: 'renamed' }, 'after')
            assert.equal(svc.accountRevisions.current(account.id, revision), false, 'explicit edit invalidates before waiting on the active store')
            finish()
            const [outcome] = await Promise.all([old, edit])
            assert.match(outcome.keychainError, /newer change was kept/)
            if (action === 'remove') {
                assert.equal(saved.has('account#shared'), false)
                assert.deepEqual(svc.accounts(), [])
            } else {
                assert.deepEqual(JSON.parse(saved.get('account#shared')!), { username: 'renamed', password: 'after' })
                assert.equal(svc.accounts()[0].username, 'renamed')
            }
        }
    })

    for (const route of ['desktop', 'gateway']) {
        test(`${route} shared-account persistence (${store}) honors newer edits, names, removal and cancelled forms`, async t => {
            const signin = require('../../dist/signin.js')
            const gateway = require('../../dist/gateway.js')
            const open = gateway.openThroughGateway
            const ask = signin.askCredentials
            const saved = new Map<string, string>()
            const extraKeychain = new Map<string, string>()
            const keychain = store === 'keychain' ? saved : extraKeychain
            stubs.keytar = {
                getPassword: async (_: string, key: string) => keychain.get(key) ?? null,
                setPassword: async (_: string, key: string, value: string) => { keychain.set(key, value) },
                deletePassword: async (_: string, key: string) => { keychain.delete(key) },
                findCredentials: async () => [...keychain].map(([account, password]) => ({ account, password })),
            }
            signin.useVault(store === 'vault' ? {
                isEnabled: () => true, isOpen: () => true,
                load: async () => ({ secrets: [...saved].map(([key, value]) => ({ type: signin.VAULT_SECRET_TYPE, key: { key }, value })) }),
                getSecret: async (_: string, key: any) => ({ value: saved.get(key.key) }),
                addSecret: async (secret: any) => { saved.set(secret.key.key, secret.value) },
                removeSecret: async (_: string, key: any) => { saved.delete(key.key) },
            } : null)
            t.after(() => { signin.useVault(null); gateway.openThroughGateway = open; signin.askCredentials = ask; delete stubs.keytar })
            for (const action of ['unchanged', 'password', 'rename', 'remove', 'cancel', 'stale']) {
                saved.clear(); extraKeychain.clear()
                const svc = service()
                const account = { id: 'shared', name: 'Account', username: 'user' }
                svc.config.store.remoteDesktop.accounts = [account]
                svc.config.store.remoteDesktop.gatewayPasswordsMigrated = true
                if (action === 'stale') { svc.accountRevisions.change(account.id) }
                const pane = {}
                const between = async () => {
                    if (action === 'password') { await svc.saveAccount(account, 'new-value') }
                    if (action === 'rename') { await svc.saveAccount({ ...account, username: 'new-user' }) }
                    if (action === 'remove') { await svc.removeAccount(account.id) }
                }
                const { rdp, ready } = ironrdp(async () => { await between(); return { run: async () => ({ reason: () => 'ended' }) } })
                const s = session(svc, pane, ready)
                s.credentialKey = s.key
                s.spec.account = account.id
                s.spec.gatewayAccount = account.id
                const options: any[] = []
                signin.askCredentials = async (_: unknown, form: any) => {
                    options.push(form)
                    return action === 'cancel' ? null : { username: 'user', password: 'old-value', remember: true }
                }
                const gw = { host: 'gateway.example', port: 443 }
                if (route === 'desktop') {
                    const found = await svc.endpointFor(pane, target, s.spec, s, false)
                    if (found) { await svc.run(pane, target, s.spec, s, rdp, found) }
                    else { assert.equal(action, 'cancel') }
                } else {
                    const own = await svc.gatewayAccountFor(s.spec, s, gw)
                    gateway.openThroughGateway = async () => { await between(); return new PassThrough() }
                    if (own) { (await svc.throughGateway(target, s.spec, s, gw, { ...endpoint, gatewayAccount: own })).destroy() }
                    else { assert.equal(action, 'cancel') }
                }
                for (let i = 0; i < 12; i++) { await new Promise(resolve => setImmediate(resolve)) }
                assert.equal(options[0].canRemember, action !== 'stale')
                if (action === 'stale') { assert.match(options[0].error, /save the account again in Settings and reopen/) }
                const stored = saved.get('account#shared')
                assert.equal(stored && JSON.parse(stored).password, action === 'unchanged' ? 'old-value' : action === 'password' ? 'new-value' : undefined, `${route}: ${action}`)
                if (action === 'rename') { assert.equal(svc.accounts()[0].username, 'new-user') }
                if (action === 'remove') { assert.equal(svc.accounts().length, 0) }
            }
        })
    }
}
