import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import type { Catalog, PackageChangeProgress, ReleaseEnvironment } from '../../src/releases.js'
const require = createRequire(import.meta.url)
const { ReleaseManager, parseCatalog, releaseVersion, newer, RELEASE_STATE_KEY } = require('../../dist/releases.js') as typeof import('../../src/releases.js')
const policy = { minimumTabbyVersion: '1.0.236', rollbackFloor: '0.5.1' }
function catalog (versions = ['0.5.1', '0.6.0-beta.1', '0.6.0-rc.1'], tags: Record<string, string> = { latest: '0.5.1', beta: '0.6.0-rc.1' }): Catalog {
    return parseCatalog({ name: 'tabby-rdp', 'dist-tags': tags, versions: Object.fromEntries(versions.map(version => [version,
        { name: 'tabby-rdp', version, tabbyRdp: policy, engines: { node: '>=18' } }])) })
}
function setup (options: Partial<ReleaseEnvironment> = {}, saved: any = null) {
    const calls: unknown[][] = []
    let stored = JSON.stringify(saved)
    let time = 100000
    let fetches = 0
    const env: ReleaseEnvironment = {
        running: '0.5.1', policy, tabby: '1.0.237', node: '22.0.0', os: 'darwin', cpu: 'arm64',
        storage: { getItem: key => { assert.equal(key, RELEASE_STATE_KEY); return stored }, setItem: (key, value) => { assert.equal(key, RELEASE_STATE_KEY); stored = value } },
        fetchCatalog: async () => { fetches++; return catalog() },
        install: async (...args) => { calls.push(['install', ...args]) },
        uninstall: async (...args) => { calls.push(['uninstall', ...args]) },
        confirm: async (...args) => { calls.push(['confirm', ...args]); return true },
        now: () => time, ...options,
    }
    return { manager: new ReleaseManager(env), env, calls, saved: () => JSON.parse(stored), fetches: () => fetches,
        advance: (ms: number) => { time += ms } }
}

test('strict exact versions and SemVer preview ordering', () => {
    for (const bad of ['latest', 'beta', '^0.5.1', 'v0.5.1', '0.5.1+build', '01.5.1', '0.6.0-beta.01', '0.6.0-alpha.1', 'other@0.5.1', 'https://example.test/p.tgz']) {
        assert.equal(releaseVersion(bad), false, bad)
    }
    assert.equal(newer('0.6.0-beta.10', '0.6.0-beta.2'), true)
    assert.equal(newer('0.6.0-rc.1', '0.6.0-beta.10'), true)
    assert.equal(newer('0.6.0', '0.6.0-rc.9'), true)
    assert.equal(newer('0.5.1', '0.6.0-rc.1'), false)
})

test('catalog accepts only fixed package and canonical versions; dist-tags do not bypass the list', () => {
    const c = parseCatalog({ name: 'tabby-rdp', versions: {
        '0.5.1': { name: 'tabby-rdp', version: '0.5.1' },
        '9.0.0': { name: 'another-package', version: '9.0.0' },
        '1.0.0': { name: 'tabby-rdp', version: '2.0.0' },
    }, 'dist-tags': { latest: '9.0.0', beta: '0.5.1' } })
    assert.deepEqual(c.versions.map(p => p.version), ['0.5.1'])
    assert.deepEqual(c.versions[0].policy, policy)
    assert.equal(c.stable, null)
    assert.equal(c.preview, null)
    assert.throws(() => parseCatalog({ name: 'other', versions: {} }))
})

test('stable default and missing preview are honest; stable supersedes an older preview', async () => {
    const { manager: m } = setup()
    await m.refreshCatalog()
    assert.equal(m.state.channel, 'stable')
    assert.equal(m.recommended, '0.5.1')
    assert.deepEqual(m.versions.map(p => p.version), ['0.5.1'])
    await m.setChannel('preview')
    assert.equal(m.available, '0.6.0-rc.1')
    m.catalog = catalog(['0.5.1'], { latest: '0.5.1' })
    assert.equal(m.catalog.preview, null)
    assert.equal(m.recommended, '0.5.1')
    m.catalog = catalog(['0.6.0', '0.6.0-rc.1'], { latest: '0.6.0', beta: '0.6.0-rc.1' })
    assert.equal(m.recommended, '0.6.0')
})

test('local paused prompts suppress available notes but not explicit choices; preferences survive startup', async () => {
    const s = setup()
    const m = s.manager
    await m.refreshCatalog()
    await m.setChannel('preview')
    await m.setPaused(true)
    assert.equal(m.available, null)
    assert.equal(m.recommended, '0.6.0-rc.1')
    const restarted = new ReleaseManager(s.env)
    assert.equal(restarted.state.channel, 'preview')
    assert.equal(restarted.state.paused, true)
    await m.install('0.6.0-rc.1')
    assert.deepEqual(s.calls.at(-1), ['install', 'tabby-rdp', '0.6.0-rc.1'])
})

test('requests coalesce; cache and manual retry cooldown bound repeated checks', async () => {
    let answer!: (c: Catalog) => void
    let count = 0
    const s = setup({ fetchCatalog: () => { count++; return new Promise(resolve => { answer = resolve }) } })
    const first = s.manager.refreshCatalog()
    const second = s.manager.refreshCatalog(true)
    await Promise.resolve()
    assert.equal(count, 1)
    answer(catalog())
    await Promise.all([first, second])
    await s.manager.refreshCatalog(true)
    assert.equal(count, 1)
    s.advance(10001)
    const third = s.manager.refreshCatalog(true)
    await Promise.resolve()
    assert.equal(count, 2)
    answer(catalog())
    await third
    s.advance(60000)
    await s.manager.refreshCatalog()
    assert.equal(count, 2)
})

test('a failed refresh preserves the list but blocks stale installation until a successful retry', async () => {
    const s = setup()
    await s.manager.refreshCatalog()
    await s.manager.setChannel('preview')
    s.advance(16000)
    s.env.fetchCatalog = () => { throw new Error('offline') }
    await s.manager.refreshCatalog(true)
    assert.match(s.manager.error, /offline/)
    assert.equal(s.manager.catalog?.stable, '0.5.1')
    assert.equal(s.manager.available, null)
    await s.manager.install('0.6.0-rc.1')
    assert.equal(s.calls.length, 0)
    s.advance(16000)
    s.env.fetchCatalog = async () => catalog()
    await s.manager.refreshCatalog(true)
    await s.manager.install('0.6.0-rc.1')
    assert.deepEqual(s.calls.at(-1), ['install', 'tabby-rdp', '0.6.0-rc.1'])
})

test('compatibility includes data floor, explicit policy, Tabby, Node, OS, CPU and deprecation', async () => {
    const s = setup()
    const m = s.manager
    await m.refreshCatalog()
    const p = m.catalog!.versions[0]
    const check = (changes: object, pattern: RegExp) => {
        const old = { ...p }
        Object.assign(p, changes)
        assert.match(m.reason(p.version)!, pattern)
        Object.assign(p, old)
    }
    check({ policy: undefined }, /not been confirmed/)
    check({ policy: { ...policy, minimumTabbyVersion: '9.0.0' } }, /Requires Tabby/)
    check({ node: '>=99' }, /Node/)
    check({ os: ['win32'] }, /computer/)
    check({ os: ['!darwin'] }, /computer/)
    check({ cpu: ['x64'] }, /computer/)
    check({ deprecated: true }, /withdrawn/)
    m.catalog = catalog(['0.4.0'])
    assert.match(m.reason('0.4.0')!, /requires version 0.5.1/)
})

test('a higher migration floor survives replacement and prevents arbitrary rollback', async () => {
    const s = setup({ running: '0.7.0', policy: { ...policy, rollbackFloor: '0.6.0' } }, { previous: '0.5.1', rollbackFloor: '0.5.1' })
    await s.manager.refreshCatalog()
    assert.match(s.manager.reason('0.5.1')!, /requires version 0.6.0/)
    const restarted = new ReleaseManager({ ...s.env, running: '0.6.0', policy })
    assert.equal(restarted.state.rollbackFloor, '0.6.0')
})

test('install records previous and pending only after success, then startup reconciles the loaded package', async () => {
    let finish!: () => void
    const s = setup({ install: async (...args) => { s.calls.push(['install', ...args]); await new Promise<void>(resolve => { finish = resolve }) } })
    await s.manager.setChannel('preview')
    const installation = s.manager.install('0.6.0-rc.1')
    while (!finish) { await new Promise(resolve => setImmediate(resolve)) }
    assert.equal(s.saved().previous, undefined)
    assert.equal(s.manager.pending, null)
    assert.equal(s.manager.busy, true)
    await s.manager.install('0.6.0-beta.1')
    await s.manager.uninstall()
    assert.equal(s.calls.filter(c => c[0] === 'install').length, 1)
    finish()
    await installation
    assert.equal(s.saved().previous, '0.5.1')
    assert.equal(s.saved().pending, '0.6.0-rc.1')
    assert.equal(s.manager.running, '0.5.1')
    assert.equal(s.manager.pending, '0.6.0-rc.1')
    const restarted = new ReleaseManager({ ...s.env, running: '0.6.0-rc.1' })
    assert.equal(restarted.pending, null)
    assert.equal(restarted.state.pending, '0.6.0-rc.1')
    assert.equal(restarted.state.previous, '0.5.1')
})

test('failed or cancelled installs preserve history, and invalid/preview-without-opt-in never reach installer', async () => {
    const s = setup({ install: async () => { throw new Error('disk full') } }, { previous: '0.4.0' })
    await s.manager.install('0.6.0-rc.1')
    assert.match(s.manager.error, /Choose Preview/)
    assert.equal(s.calls.length, 0)
    await s.manager.setChannel('preview')
    await s.manager.install('other@1.0.0')
    assert.equal(s.calls.length, 0)
    await s.manager.install('0.6.0-rc.1')
    assert.match(s.manager.error, /disk full/)
    assert.equal(s.saved().previous, '0.4.0')
    assert.equal(s.saved().pending, undefined)
    s.env.confirm = async () => false
    s.env.install = async () => { assert.fail('cancelled install must not run') }
    await s.manager.install('0.6.0-rc.1')
    assert.equal(s.saved().previous, '0.4.0')
})

test('return to stable explicitly permits a compatible downgrade and switches channel only on success', async () => {
    const s = setup({ running: '0.6.0-rc.1' }, { channel: 'preview' })
    await s.manager.install('0.5.1', true)
    assert.match(String(s.calls[0][2]), /This is a downgrade/)
    assert.deepEqual(s.calls[1], ['install', 'tabby-rdp', '0.5.1'])
    assert.equal(s.saved().channel, 'stable')
    assert.equal(s.saved().previous, '0.6.0-rc.1')
    const failed = setup({ running: '0.6.0-rc.1', install: async () => { throw new Error('failed') } }, { channel: 'preview' })
    await failed.manager.install('0.5.1', true)
    assert.equal(failed.saved().channel, 'preview')
})

test('an old-running newly constructed manager preserves a foreign pending change', async () => {
    const s = setup({}, { pending: '0.6.0-rc.1', previous: '0.5.1' })
    await s.manager.ready
    assert.equal(s.manager.running, '0.5.1')
    assert.equal(s.manager.pending, '0.6.0-rc.1')
    assert.equal(s.saved().pending, '0.6.0-rc.1')
    assert.equal(s.manager.state.previous, '0.5.1')
})

test('uninstall confirms precise retained data scope and invokes only supported fixed-name API', async () => {
    const s = setup()
    await s.manager.uninstall()
    assert.match(String(s.calls[0][2]), /Saved connections, settings, passwords and remote setup are kept/)
    assert.deepEqual(s.calls[1], ['uninstall', 'tabby-rdp'])
    assert.equal(s.manager.removed, true)
    assert.equal(s.manager.running, '0.5.1')
    await s.manager.install('0.6.0-rc.1')
    await s.manager.uninstall()
    assert.equal(s.calls.length, 2)
    assert.equal(s.saved().previous, undefined)
})

test('uninstall cancellation and failure do not report removal', async () => {
    const s = setup({ confirm: async () => false })
    await s.manager.uninstall()
    assert.equal(s.calls.length, 0)
    assert.equal(s.manager.removed, false)
    s.env.confirm = async () => true
    s.env.uninstall = async () => { throw new Error('permission denied') }
    await s.manager.uninstall()
    assert.match(s.manager.error, /permission denied/)
    assert.equal(s.manager.removed, false)
})

test('unavailable local storage has safe defaults and an honest window-only warning', async () => {
    const s = setup({ storage: undefined })
    assert.equal(s.manager.state.channel, 'stable')
    await s.manager.ready
    assert.match(s.manager.storageWarning, /window only/)
    await s.manager.setChannel('preview')
    await s.manager.install('0.6.0-rc.1')
    assert.equal(s.manager.pending, null)
    assert.match(s.manager.error, /history cannot be saved/)
    assert.equal(s.calls.length, 0)
    assert.match(s.manager.storageWarning, /window only/)
})

function sharedLock () {
    let tail = Promise.resolve()
    return (run: () => Promise<void>) => {
        const next = tail.then(run)
        tail = next.catch(() => {})
        return next
    }
}

test('two windows serialize installation; foreign pending survives preferences and old/new window construction', async () => {
    let disk: string | null = '0.5.1'
    let finish!: () => void
    const s = setup({ withLock: sharedLock(), diskVersion: () => disk,
        install: async (...args) => { s.calls.push(['install', ...args]); await new Promise<void>(resolve => { finish = resolve }); disk = args[1] } })
    const a = s.manager
    const b = new ReleaseManager(s.env)
    await Promise.all([a.ready, b.ready])
    await a.setChannel('preview')
    const first = a.install('0.6.0-rc.1')
    while (!finish) { await new Promise(resolve => setImmediate(resolve)) }
    const second = b.install('0.6.0-beta.1')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(s.calls.filter(c => c[0] === 'install').length, 1)
    finish()
    await Promise.all([first, second])
    assert.equal(s.calls.filter(c => c[0] === 'install').length, 1)
    assert.equal(a.pending, '0.6.0-rc.1')
    assert.equal(b.pending, '0.6.0-rc.1')
    await b.setPaused(true)
    assert.equal(s.saved().pending, '0.6.0-rc.1')
    assert.equal(s.saved().previous, '0.5.1')
    const old = new ReleaseManager(s.env)
    const fresh = new ReleaseManager({ ...s.env, running: '0.6.0-rc.1' })
    await Promise.all([old.ready, fresh.ready])
    assert.equal(old.pending, '0.6.0-rc.1')
    assert.equal(fresh.pending, null)
    a.syncFromStorage()
    assert.equal(a.pending, '0.6.0-rc.1')
    assert.equal(a.state.paused, true)
    assert.equal(s.saved().pending, '0.6.0-rc.1')
})

test('foreign uninstall blocks a second mutation; manual reinstall is reconciled from actual disk', async () => {
    let disk: string | null = '0.5.1'
    const s = setup({ withLock: sharedLock(), diskVersion: () => disk,
        uninstall: async (...args) => { s.calls.push(['uninstall', ...args]); disk = null } })
    const b = new ReleaseManager(s.env)
    await Promise.all([s.manager.ready, b.ready])
    await s.manager.uninstall()
    b.syncFromStorage()
    assert.equal(b.removed, true)
    await b.uninstall()
    await b.install('0.6.0-beta.1')
    assert.equal(s.calls.length, 2, 'only original confirmation and uninstall')
    const old = new ReleaseManager(s.env)
    await old.ready
    assert.equal(old.removed, true)
    disk = '0.5.1'
    const restarted = new ReleaseManager(s.env)
    await restarted.ready
    assert.equal(restarted.removed, false)
    assert.equal(restarted.pending, null)
    assert.match(restarted.notice, /changed outside this page/)
})

test('disk reconciliation catches an external version change before an old window can install', async () => {
    let disk = '0.5.1'
    const s = setup({ diskVersion: () => disk })
    await s.manager.ready
    await s.manager.setChannel('preview')
    disk = '0.6.0-beta.1'
    await s.manager.install('0.6.0-rc.1')
    assert.equal(s.calls.length, 0)
    assert.equal(s.manager.pending, '0.6.0-beta.1')
    assert.match(s.manager.notice, /changed outside this page/)
})

test('a downgrade reports progress and completes only after verifying the installed package', async () => {
    let disk = '0.5.2'
    let finish!: () => void
    const progress: PackageChangeProgress[] = []
    const s = setup({ running: disk, diskVersion: () => disk, progress: state => progress.push(state),
        install: async () => { await new Promise<void>(resolve => { finish = resolve }); disk = '0.5.1' } })
    const install = s.manager.install('0.5.1')
    while (!finish) { await new Promise(resolve => setImmediate(resolve)) }
    assert.equal(progress.at(-1)?.phase, 'installing')
    assert.equal(s.saved().previous, undefined)
    finish()
    await install
    assert.deepEqual(progress.map(state => state.phase), ['preparing', 'installing', 'verifying', 'success'])
    assert.ok(progress.every(state => state.version === '0.5.1' && state.action === 'install'))
    assert.equal(s.manager.pending, '0.5.1')
    assert.equal(s.saved().previous, '0.5.2')
})

test('an installer that resolves without installing the requested version reports failure without successful history', async () => {
    for (const disk of ['0.5.2', null]) {
        let installed: string | null = '0.5.2'
        const progress: PackageChangeProgress[] = []
        const s = setup({ running: '0.5.2', diskVersion: () => installed, progress: state => progress.push(state),
            install: async () => { installed = disk } })
        await s.manager.install('0.5.1')
        assert.deepEqual(progress.map(state => state.phase), ['preparing', 'installing', 'verifying', 'error'])
        assert.match(progress.at(-1)!.message!, /expected 0.5.1|package is missing/)
        assert.equal(s.saved().previous, undefined)
        assert.equal(s.manager.pending, null)
    }
})

test('cancellation and installer rejection produce distinct dialog results', async () => {
    const progress: PackageChangeProgress[] = []
    const s = setup({ running: '0.5.2', progress: state => progress.push(state), confirm: async () => false })
    await s.manager.install('0.5.1')
    assert.deepEqual(progress.map(state => state.phase), ['preparing', 'cancelled'])
    assert.equal(s.calls.length, 0)
    progress.length = 0
    s.env.confirm = async () => true
    s.env.install = async () => { throw new Error('Installer unavailable') }
    await s.manager.install('0.5.1')
    assert.deepEqual(progress.map(state => state.phase), ['preparing', 'installing', 'error'])
    assert.match(progress.at(-1)!.message!, /Installer unavailable/)
    assert.equal(s.manager.pending, null)
})

test('uninstall verifies package removal before reporting success', async () => {
    const progress: PackageChangeProgress[] = []
    const s = setup({ diskVersion: () => '0.5.1', progress: state => progress.push(state) })
    await s.manager.uninstall()
    assert.deepEqual(progress.map(state => state.phase), ['preparing', 'uninstalling', 'verifying', 'error'])
    assert.match(progress.at(-1)!.message!, /still installed/)
    assert.equal(s.manager.removed, false)
})
