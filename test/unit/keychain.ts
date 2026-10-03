// The keychain behind saved sign-ins (src/signin.ts), with a stand-in for keytar: calls go to it one at a time, and
// a keychain that never answers (Linux without an unlocked keyring) is given up on after one call, not one per
// caller: each waiting call holds one of Node's four worker threads, which Tabby needs for files and name lookups.
// Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** What the plugin's `require('keytar')` gets while a test runs. */
let keytar: Record<string, (...args: string[]) => Promise<unknown>> = {}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request === 'keytar' ? keytar : load.call(this, request, ...rest)
}

/** The module afresh: what it knows about the keychain (that it didn't answer) starts over. */
function signin (): any {
    const file = require.resolve('../../dist/signin.js')
    delete require.cache[file]
    return require(file)
}

const turn = () => new Promise(resolve => setImmediate(resolve))

test('keychain calls go one at a time, each with its own answer', async () => {
    const saved = new Map<string, string>()
    let inFlight = 0
    let most = 0
    const slowly = async <T>(answer: () => T): Promise<T> => {
        most = Math.max(most, ++inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight--
        return answer()
    }
    keytar = {
        getPassword: (_service, key) => slowly(() => saved.get(key) ?? null),
        setPassword: (_service, key, value) => slowly(() => { saved.set(key, value) }),
        deletePassword: (_service, key) => slowly(() => saved.delete(key)),
        findCredentials: () => slowly(() => [...saved].map(([account, password]) => ({ account, password }))),
    }
    const { saveCredentials, loadCredentials, hasCredentials, forgetCredentials } = signin()
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(k => saveCredentials(k, { username: `user-${k}`, password: `secret-${k}` })))
    const [a, c, missing, has, hasNot] = await Promise.all([loadCredentials('a'), loadCredentials('c'), loadCredentials('z'), hasCredentials('e'), hasCredentials('z')])
    assert.deepEqual(a, { username: 'user-a', password: 'secret-a' })
    assert.deepEqual(c, { username: 'user-c', password: 'secret-c' })
    assert.equal(missing, null)
    assert.equal(has, 'yes')
    assert.equal(hasNot, 'no')
    await forgetCredentials('a')
    assert.equal(await loadCredentials('a'), null)
    assert.equal(most, 1, 'never two calls in the keychain at once')
})

test('a keychain that never answers keeps one call waiting, not one per caller', async t => {
    let started = 0
    const never = () => { started++; return new Promise<never>(() => { }) }
    keytar = { getPassword: never, setPassword: never, deletePassword: never, findCredentials: never }
    const { loadCredentials, hasCredentials, saveCredentials, forgetCredentialsOrFail } = signin()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // A list of saved accounts, each asking whether it has a password, and a desktop signing in meanwhile.
    const asked = [hasCredentials('account#1'), hasCredentials('account#2'), hasCredentials('account#3'), hasCredentials('account#4'), loadCredentials('desk')]
    await turn()
    assert.equal(started, 1, 'only the first reached the keychain')
    t.mock.timers.tick(10000)
    assert.deepEqual(await Promise.all(asked), ['unknown', 'unknown', 'unknown', 'unknown', null])
    assert.equal(started, 1, 'the others were never made')
    // From then on nothing goes to it: reads find nothing, and what would change it says why it can't.
    assert.equal(await loadCredentials('desk'), null)
    assert.equal(await hasCredentials('account#1'), 'unknown')
    await assert.rejects(saveCredentials('desk', { username: 'u', password: 'p' }), /did not answer/)
    await assert.rejects(forgetCredentialsOrFail('desk'), /did not answer/)
    assert.equal(started, 1)
})

test('no keychain at all: nothing is remembered, and nothing fails', async () => {
    keytar = null as any
    ;(Module as any)._load = function (request: string, ...rest: unknown[]) {
        if (request === 'keytar') {
            throw new Error('Cannot find module \'keytar\'')
        }
        return load.call(this, request, ...rest)
    }
    const { loadCredentials, saveCredentials, forgetCredentialsOrFail, hasCredentials } = signin()
    await saveCredentials('desk', { username: 'u', password: 'p' })
    assert.equal(await loadCredentials('desk'), null)
    assert.equal(await hasCredentials('desk'), 'no')
    await forgetCredentialsOrFail('desk')
})
