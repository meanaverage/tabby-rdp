// Account revision and store ordering contracts, with dummy credentials/stores and an isolated lock fixture.
import { test, TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { AccountRevisions } = require('../../dist/accountRevisions.js')
let keytar: any
const load = (Module as any)._load
;(Module as any)._load = function (name: string, ...args: unknown[]) { return name === 'keytar' ? keytar : load.call(this, name, ...args) }
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred () { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function fresh () { delete require.cache[require.resolve('../../dist/signin.js')]; return require('../../dist/signin.js') }

function fixture (t: TestContext, kind = 'keychain') {
    const tails = new Map<string, Promise<unknown>>()
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
        request: (name: string, options: { signal?: AbortSignal }, work: () => Promise<unknown>) => {
            const next = (tails.get(name) ?? Promise.resolve()).then(() => {
                if (options.signal?.aborted) { throw new Error('lock cancelled') }
                return work()
            })
            tails.set(name, next.catch(() => null))
            return next
        },
    } } })
    t.after(() => { if (before) { Object.defineProperty(globalThis, 'navigator', before) } else { delete (globalThis as any).navigator } })
    const shared = new Map<string, string>()
    const storage = { getItem: (key: string) => shared.get(key) ?? null, setItem: (key: string, value: string) => shared.set(key, value) }
    const a = new AccountRevisions(() => storage)
    const b = new AccountRevisions(() => storage)
    const saved = new Map<string, string>()
    const events: string[] = []
    let hold: Promise<void> | undefined
    const put = async (key: string, value: string) => { events.push('begin ' + JSON.parse(value).password); await hold; saved.set(key, value); events.push('saved ' + JSON.parse(value).password) }
    const remove = async (key: string) => { events.push('remove'); saved.delete(key) }
    keytar = kind === 'keychain' ? { getPassword: async (_: string, key: string) => saved.get(key) ?? null,
        setPassword: (_: string, key: string, value: string) => put(key, value), deletePassword: (_: string, key: string) => remove(key) }
        : { getPassword: async () => null, deletePassword: async () => false }
    const vault = { isEnabled: () => true, addSecret: (secret: any) => put(secret.key.key, secret.value),
        removeSecret: (_: unknown, key: any) => remove(key.key), getSecret: async (_: unknown, key: any) => ({ value: saved.get(key.key) }) }
    return { a, b, saved, events, vault, block: (promise?: Promise<void>) => { hold = promise } }
}

test('account revisions invalidate stale config and fail closed when shared coordination is unavailable', async t => {
    const { a, b, events } = fixture(t)
    const account = { id: 'a', username: 'user', name: 'Account' }
    const old = a.capture(account)
    assert.equal(old, '')
    const revision = b.change('a')
    assert.equal(a.current('a', old), false)
    assert.equal(a.capture(account), undefined, 'a newly opened form on stale config must not adopt the newer marker')
    assert.equal(a.capture({ ...account, credentialRevision: revision }), revision)
    const denied = new AccountRevisions(() => { throw new Error('storage unavailable') })
    assert.equal(denied.capture(account), undefined)
    assert.throws(() => denied.change('a'), /unavailable/)
    const unsupported = new AccountRevisions(() => ({}), () => false)
    assert.equal(unsupported.capture(account), undefined)
    assert.throws(() => unsupported.change('a'), /Restart or update Tabby/)
    const signin = fresh()
    for (const revisions of [denied, unsupported]) {
        const captured = revisions.capture(account)
        assert.equal(await signin.saveCredentialsIf('account#a', { username: 'user', password: 'unused' }, () => revisions.current('a', captured)), false)
    }
    assert.deepEqual(events, [], 'an unavailable guard must not start a store write')
})

for (const kind of ['keychain', 'vault']) {
    test(`${kind}: conditional stale cleanup completes under the lock before a newer window's replacement`, async t => {
        const f = fixture(t, kind)
        const a = fresh(), b = fresh()
        if (kind === 'vault') { a.useVault(f.vault); b.useVault(f.vault) }
        const account = { id: 'a', username: 'user', name: 'Account' }
        const old = f.a.capture(account)
        const gate = deferred(); f.block(gate.promise)
        const first = a.saveCredentialsIf('account#a', { username: 'user', password: 'before' }, () => f.a.current('a', old))
        await turn()
        assert.deepEqual(f.events, ['begin before'])
        const revision = f.b.change('a')
        const next = b.saveCredentialsIf('account#a', { username: 'user', password: 'after' }, () => f.b.current('a', revision))
        await turn()
        assert.deepEqual(f.events, ['begin before'], 'second module is waiting on the shared lock')
        gate.resolve()
        assert.deepEqual(await Promise.all([first, next]), [false, true])
        assert.equal(JSON.parse(f.saved.get('account#a')!).password, 'after')
        assert.deepEqual(f.events.slice(0, 5), ['begin before', 'saved before', 'remove', 'begin after', 'saved after'])
        const count = f.events.length
        assert.equal(await a.saveCredentialsIf('account#a', { username: 'user', password: 'late' }, () => f.a.current('a', old)), false)
        assert.equal(f.events.length, count)
    })

    test(`${kind}: account removal and rename invalidate an active write; a delayed forget cannot remove a newer replacement`, async t => {
        const f = fixture(t, kind)
        const a = fresh(), b = fresh()
        if (kind === 'vault') { a.useVault(f.vault); b.useVault(f.vault) }
        for (const change of ['removed', 'renamed']) {
            const revision = f.a.change('a')
            const gate = deferred(); f.block(gate.promise)
            const saving = a.saveCredentialsIf('account#a', { username: 'user', password: change }, () => f.a.current('a', revision))
            await turn()
            const edited = f.b.change('a')
            const forgetting = b.forgetCredentialsIf('account#a', () => f.b.current('a', edited))
            gate.resolve()
            await Promise.all([saving, forgetting])
            assert.equal(f.saved.has('account#a'), false)
        }
        const revoked = f.a.change('a')
        const gate = deferred(); f.block(gate.promise)
        const writing = a.saveCredentialsIf('account#a', { username: 'user', password: 'blocked' }, () => f.a.current('a', revoked))
        await turn()
        const forgetting = b.forgetCredentialsIf('account#a', () => f.b.current('a', revoked))
        const current = f.b.change('a')
        const replacement = b.saveCredentialsIf('account#a', { username: 'new-user', password: 'current' }, () => f.b.current('a', current))
        gate.resolve()
        await Promise.all([writing, forgetting, replacement])
        assert.deepEqual(JSON.parse(f.saved.get('account#a')!), { username: 'new-user', password: 'current' })
    })
}

test('an outward keychain timeout leaves the native write holding the cross-window lock until it settles', async t => {
    const f = fixture(t)
    const a = fresh(), b = fresh()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const gate = deferred(); f.block(gate.promise)
    const old = f.a.change('a')
    const timedOut = assert.rejects(a.saveCredentialsIf('account#a', { username: 'user', password: 'old' }, () => f.a.current('a', old)), /did not answer/)
    await turn()
    t.mock.timers.tick(10000)
    await timedOut
    await assert.rejects(a.saveCredentials('account#a', { username: 'user', password: 'unused' }), /did not answer earlier/)
    const revision = f.b.change('a')
    const next = b.saveCredentialsIf('account#a', { username: 'user', password: 'new' }, () => f.b.current('a', revision))
    await turn()
    assert.deepEqual(f.events, ['begin old'], 'the caller timed out, but the native operation has not been cancelled')
    gate.resolve()
    assert.equal(await next, true)
    assert.equal(JSON.parse(f.saved.get('account#a')!).password, 'new')
})
