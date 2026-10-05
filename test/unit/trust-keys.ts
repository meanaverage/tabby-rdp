// Trust and credential keys are matched on their parts, not by a bare endsWith('#'+id): a gateway pin
// (`gateway#host:port`) or a desktop whose id is a suffix of another's must not be swept up when one desktop is
// removed, edited or its password forgotten. A credential key may also carry a gateway suffix (`…@gateway#host:port`),
// which scopes a saved password to the gateway it is sent to; the id inside still compares equal.
// keyParts reads the built plugin; the signin tests stub keytar. npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { keyParts } = require('../../dist/desktops.js')

let keytar: Record<string, (...args: string[]) => Promise<unknown>> = {}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request === 'keytar' ? keytar : load.call(this, request, ...rest)
}
function signin (): any {
    const file = require.resolve('../../dist/signin.js')
    delete require.cache[file]
    return require(file)
}

test('keyParts splits a key into its target, desktop id and any gateway suffix', () => {
    assert.deepEqual(keyParts('rdp#10.0.0.9:3389'), { target: 'rdp', desktopId: '10.0.0.9:3389', gateway: '' })
    assert.deepEqual(keyParts('gateway#10.0.0.9:3389'), { target: 'gateway', desktopId: '10.0.0.9:3389', gateway: '' })
    assert.deepEqual(keyParts('alice@hostA:22#10.0.0.9:3389'), { target: 'alice@hostA:22', desktopId: '10.0.0.9:3389', gateway: '' })
    assert.deepEqual(keyParts('alice@hostA:22'), { target: 'alice@hostA:22', desktopId: '', gateway: '' })
    assert.deepEqual(keyParts('rdp#10.0.0.9:3389@gateway#gw.corp:443'),
        { target: 'rdp', desktopId: '10.0.0.9:3389', gateway: '@gateway#gw.corp:443' })
    assert.deepEqual(keyParts('bob@h:22#pc:3389@gateway#gw:443'),
        { target: 'bob@h:22', desktopId: 'pc:3389', gateway: '@gateway#gw:443' })
})

/** A keytar standing in for the OS keychain, holding JSON credential values in a map. */
function store (): Map<string, string> {
    const saved = new Map<string, string>()
    keytar = {
        getPassword: async (_s, key) => saved.get(key) ?? null,
        setPassword: async (_s, key, value) => { saved.set(key, value) },
        deletePassword: async (_s, key) => { saved.delete(key) },
        findCredentials: async () => [...saved].map(([account, password]) => ({ account, password })) as any,
    }
    return saved
}

test('forgetting a desktop\'s saved passwords is anchored on the id, gateway suffix included', async () => {
    const saved = store()
    const { saveCredentials, forgetCredentialsFor } = signin()
    const creds = { username: 'u', password: 'p' }
    for (const key of [
        'rdp#10.0.0.9:3389',                                  // a direct desktop at the same address: its own
        'gateway#10.0.0.9:3389',                              // a gateway certificate's address (never a credential, but excluded regardless)
        'alice@hostA:22#10.0.0.9:3389',                       // the desktop behind host A
        'bob@hostB:22#10.0.0.9:3389',                         // the same address behind host B (cross-host, by design)
        'alice@hostA:22#10.0.0.9:3389@gateway#gw.corp:443',   // behind host A, reached through a gateway
        'carol@hostC:22#10.0.0.50:3389',                      // a different desktop
    ]) {
        await saveCredentials(key, creds)
    }
    await forgetCredentialsFor('10.0.0.9:3389')
    assert.deepEqual([...saved.keys()].sort(), ['carol@hostC:22#10.0.0.50:3389', 'gateway#10.0.0.9:3389', 'rdp#10.0.0.9:3389'])
})

test('a desktop behind a machine reached through a host: its keys split on their parts, whatever that host says', async () => {
    const { keyFromConfig, nestedKey, sessionKey } = require('../../dist/desktops.js')
    const host = keyFromConfig('user alice\nhostname bastion\nport 22\n', 'bastion')
    // The host answers `ssh -G` with a '#' of its own, as if to end the target early: it is kept as %23.
    const there = nestedKey(host, 'user bob\nhostname build#10.0.0.7:3389\nport 22\n', 'build')
    assert.equal(there, 'alice@bastion:22>bob@build%2310.0.0.7:3389:22')
    const key = sessionKey({ key: there }, { id: '10.0.0.9:3389' })
    assert.deepEqual(keyParts(key), { target: there, desktopId: '10.0.0.9:3389', gateway: '' })
    assert.deepEqual(keyParts(`${key}@gateway#gw:443`), { target: there, desktopId: '10.0.0.9:3389', gateway: '@gateway#gw:443' })
    // Moving an address keeps a saved password under the target it was saved for, the host's or the machine's (each
    // with its desktop's certificate remembered, which moves along).
    const saved = store()
    const { saveCredentials, moveCredentialsFor } = signin()
    await saveCredentials(`${host}#10.0.0.9:3389`, { username: 'u', password: 'p' })
    await saveCredentials(`${key}@gateway#gw:443`, { username: 'u', password: 'p' })
    const known = new Set([`${host}#10.0.0.9:3389`, key])
    await moveCredentialsFor('10.0.0.9:3389', '10.0.0.50:3389', {}, (k: string) => known.has(k))
    assert.deepEqual([...saved.keys()].sort(), [`${host}#10.0.0.50:3389`, `${there}#10.0.0.50:3389@gateway#gw:443`].sort())
})

test('moving a desktop\'s address keeps its gateway suffix', async () => {
    const saved = store()
    const { saveCredentials, moveCredentialsFor } = signin()
    await saveCredentials('dave@hostD:22#10.0.0.9:3389@gateway#gw:443', { username: 'u', password: 'p' })
    await saveCredentials('dave@hostD:22#10.0.0.9:3389', { username: 'u', password: 'p' })
    await moveCredentialsFor('10.0.0.9:3389', '10.0.0.50:3390', {}, (key: string) => key === 'dave@hostD:22#10.0.0.9:3389')
    assert.deepEqual([...saved.keys()].sort(), ['dave@hostD:22#10.0.0.50:3390', 'dave@hostD:22#10.0.0.50:3390@gateway#gw:443'])
})

test('a saved password\'s gateway part names the gateway as it resolves, whatever the spelling', () => {
    const { gatewayScope } = signin()
    assert.equal(gatewayScope('RDGW.Example.com.'), '@gateway#rdgw.example.com:443')
    assert.equal(gatewayScope('rdgw.example.com:443'), '@gateway#rdgw.example.com:443')
    assert.equal(gatewayScope('bücher.example:8443'), '@gateway#xn--bcher-kva.example:8443')
    assert.equal(gatewayScope('[0:0::1]'), '@gateway#::1:443')
    assert.equal(gatewayScope(''), '')
    assert.equal(gatewayScope(undefined), '')
    assert.equal(gatewayScope('gw..example'), '')
})

test('a direct desktop\'s saved passwords: by the way there when one is given, every way there otherwise; never a saved account\'s', async () => {
    const saved = store()
    const { saveCredentials, forgetCredentialsFor, moveCredentialsFor } = signin()
    const creds = { username: 'u', password: 'p' }
    for (const key of ['rdp#10.0.0.9:3389', 'rdp#10.0.0.9:3389@gateway#gw:443', 'rdp#10.0.0.9:3389@gateway#other:443', 'alice@h:22#10.0.0.9:3389', 'account#10.0.0.9:3389']) {
        await saveCredentials(key, creds)
    }
    await moveCredentialsFor('10.0.0.9:3389', '10.0.0.10:3389', { direct: true, scope: '@gateway#gw:443' })
    assert.deepEqual([...saved.keys()].sort(), ['account#10.0.0.9:3389', 'alice@h:22#10.0.0.9:3389', 'rdp#10.0.0.10:3389@gateway#gw:443', 'rdp#10.0.0.9:3389', 'rdp#10.0.0.9:3389@gateway#other:443'])
    await forgetCredentialsFor('10.0.0.9:3389', { direct: true, scope: '' })
    assert.deepEqual([...saved.keys()].sort(), ['account#10.0.0.9:3389', 'alice@h:22#10.0.0.9:3389', 'rdp#10.0.0.10:3389@gateway#gw:443', 'rdp#10.0.0.9:3389@gateway#other:443'])
    await forgetCredentialsFor('10.0.0.9:3389', { direct: true })
    await forgetCredentialsFor('10.0.0.9:3389')
    assert.deepEqual([...saved.keys()].sort(), ['account#10.0.0.9:3389', 'rdp#10.0.0.10:3389@gateway#gw:443'])
})

test('a moved password doesn\'t take the place of one a desktop at the new address has', async () => {
    const saved = store()
    const { saveCredentials, moveCredentialsFor } = signin()
    await saveCredentials('bob@hostB:22#10.0.0.20:3389', { username: 'twenty', password: 'p20' })
    await saveCredentials('bob@hostB:22#10.0.0.30:3389', { username: 'thirty', password: 'p30' })
    await saveCredentials('alice@hostA:22#10.0.0.20:3389', { username: 'alice', password: 'pa' })
    const known = new Set(['bob@hostB:22#10.0.0.20:3389', 'alice@hostA:22#10.0.0.20:3389'])
    await moveCredentialsFor('10.0.0.20:3389', '10.0.0.30:3389', {}, (key: string) => known.has(key))
    // Host B's desktop at .30 keeps its own; the one moved there from .20 is dropped. Host A's, with nothing there, moves.
    assert.deepEqual([...saved.keys()].sort(), ['alice@hostA:22#10.0.0.30:3389', 'bob@hostB:22#10.0.0.30:3389'])
    assert.deepEqual(JSON.parse(saved.get('bob@hostB:22#10.0.0.30:3389')!), { username: 'thirty', password: 'p30' })
})

test('a moved password doesn\'t go to an address where a desktop is known: its certificate would check out there', async () => {
    const saved = store()
    const { saveCredentials, moveCredentialsFor } = signin()
    // Host B has a password at .9 and, at .10, only its own desktop's remembered certificate; host A has neither there.
    // Both desktops at .9 have their certificates remembered.
    await saveCredentials('bob@hostB:22#10.0.0.9:3389', { username: 'b9admin', password: 'secret-of-b9' })
    await saveCredentials('alice@hostA:22#10.0.0.9:3389', { username: 'alice', password: 'pa' })
    const known = new Set(['bob@hostB:22#10.0.0.10:3389', 'bob@hostB:22#10.0.0.9:3389', 'alice@hostA:22#10.0.0.9:3389'])
    await moveCredentialsFor('10.0.0.9:3389', '10.0.0.10:3389', {}, (key: string) => known.has(key))
    // B's password is dropped, not put where B's desktop at .10 would sign in with it; A's, with nothing there, moves.
    assert.deepEqual([...saved.keys()].sort(), ['alice@hostA:22#10.0.0.10:3389'])
    // A gateway's suffix doesn't hide the address: the desktop there is known all the same.
    await saveCredentials('bob@hostB:22#10.0.0.9:3389@gateway#gw:443', { username: 'u', password: 'p' })
    await moveCredentialsFor('10.0.0.9:3389', '10.0.0.10:3389', {}, (key: string) => known.has(key))
    assert.deepEqual([...saved.keys()].sort(), ['alice@hostA:22#10.0.0.10:3389'])
})

test('behind a host, a moved password goes along with its desktop\'s certificate, or not at all', async () => {
    const saved = store()
    const { saveCredentials, moveCredentialsFor } = signin()
    // Host 1's desktop at .5 has its certificate remembered; host 2's, at the same address, a saved password whose
    // certificate was forgotten (Settings › Certificates keeps the password). Editing host 1's desktop to .9 can't tell
    // which host's keys are its own: host 2's password goes to no address where a first certificate would be trusted
    // unasked. Dropped, it is asked for again.
    await saveCredentials('alice@h1:22#10.0.0.5:3389', { username: 'alice', password: 'h1-secret' })
    await saveCredentials('bob@h2:22#10.0.0.5:3389', { username: 'bob', password: 'h2-secret' })
    await saveCredentials('bob@h2:22#10.0.0.5:3389@gateway#gw:443', { username: 'bob', password: 'h2-gateway-secret' })
    const known = new Set(['alice@h1:22#10.0.0.5:3389'])
    assert.deepEqual(await moveCredentialsFor('10.0.0.5:3389', '10.0.0.9:3389', {}, (key: string) => known.has(key)), [])
    assert.deepEqual([...saved.keys()].sort(), ['alice@h1:22#10.0.0.9:3389'])
    // A direct desktop's moves without one: its first certificate at the new address is asked about, not trusted unasked.
    await saveCredentials('rdp#10.0.0.5:3389', { username: 'carol', password: 'direct' })
    await moveCredentialsFor('10.0.0.5:3389', '10.0.0.9:3389', { direct: true })
    assert.deepEqual([...saved.keys()].sort(), ['alice@h1:22#10.0.0.9:3389', 'rdp#10.0.0.9:3389'])
})

test('a sign-in ending later knows what was forgotten since it began, for the keys that forget covers', async () => {
    store()
    const { forgetMark, forgottenSince, forgetCredentialsFor, moveCredentialsFor, forgetCredentialsOrFail, forgetFormerKey } = signin()
    const desktop = 'alice@h:22#10.0.0.5:3389'
    const direct = 'rdp#10.0.0.5:3389'
    const gateway = 'alice@h:22#10.0.0.5:3389@gateway#gw:443'
    const other = 'alice@h:22#10.0.0.6:3389'
    const keys = [desktop, direct, gateway, other, 'account#k1']
    const covered = (mark: number) => keys.filter(key => forgottenSince(key, mark))
    // Nothing forgotten: nothing is.
    let mark = forgetMark()
    assert.deepEqual(covered(mark), [])
    // A desktop's edit or removal forgets what it saved, behind any host and through any gateway, not another's.
    await forgetCredentialsFor('10.0.0.5:3389')
    assert.deepEqual(covered(mark), [desktop, gateway])
    // Only the way there it names, for a direct desktop or one through a gateway.
    mark = forgetMark()
    await forgetCredentialsFor('10.0.0.5:3389', { direct: true, scope: '' })
    assert.deepEqual(covered(mark), [direct])
    // A new address: what was kept at the old one (the sign-in saves there), not what comes at the new.
    mark = forgetMark()
    await moveCredentialsFor('10.0.0.5:3389', '10.0.0.6:3389')
    assert.deepEqual(covered(mark), [desktop, gateway])
    // One key forgotten, as after a refused password.
    mark = forgetMark()
    await forgetCredentialsOrFail(other)
    assert.deepEqual(covered(mark), [other])
    // What was kept under a target's former key.
    mark = forgetMark()
    forgetFormerKey('alice@h:22')
    assert.deepEqual(covered(mark), [desktop, gateway, other])
    // A sign-in that began after a forget isn't held to it.
    assert.deepEqual(covered(forgetMark()), [])
})

test('a sign-in older than the forgets kept counts as forgotten for any key, a newer one only for what they cover', async () => {
    store()
    const { forgetMark, forgottenSince, forgetCredentialsOrFail } = signin()
    const old = forgetMark()
    for (let i = 0; i < 257; i++) {
        await forgetCredentialsOrFail(`rdp#n${i}:3389`)
    }
    // The first of them is gone from what is kept: whether it covered this key can't be told.
    assert.equal(forgottenSince('rdp#unrelated:3389', old), true)
    assert.equal(forgottenSince('rdp#unrelated:3389', old + 2), false)
    assert.equal(forgottenSince('rdp#n256:3389', old + 2), true)
})

test('a store that can\'t be listed: nothing moves or is left to use, and what was to go goes once it can be read', async () => {
    const saved = store()
    const { saveCredentials, loadCredentials, forgetCredentialsFor, moveCredentialsFor } = signin()
    await saveCredentials('alice@h:22#10.0.0.5:3389', { username: 'alice', password: 'old-user' })
    await saveCredentials('alice@h:22#10.0.0.6:3389', { username: 'alice', password: 'six' })
    // The keychain can be read but not listed (as a locked Vault can't be, its prompt cancelled).
    const listing = keytar.findCredentials
    keytar.findCredentials = async () => { throw new Error('locked') }
    assert.deepEqual(await forgetCredentialsFor('10.0.0.5:3389'), ['keychain'])
    assert.deepEqual(await moveCredentialsFor('10.0.0.6:3389', '10.0.0.7:3389', {}, () => true), ['keychain'])
    // Not used meanwhile: the desktops ask.
    assert.equal(await loadCredentials('alice@h:22#10.0.0.5:3389'), null)
    assert.equal(await loadCredentials('alice@h:22#10.0.0.6:3389'), null)
    assert.equal(await loadCredentials('alice@h:22#10.0.0.7:3389'), null)
    // A password saved since under one of those keys is the new one, and stays.
    await saveCredentials('alice@h:22#10.0.0.5:3389', { username: 'bob', password: 'new-user' })
    keytar.findCredentials = listing
    await loadCredentials('anything')
    assert.deepEqual([...saved.keys()].sort(), ['alice@h:22#10.0.0.5:3389'])
    assert.deepEqual(await loadCredentials('alice@h:22#10.0.0.5:3389'), { username: 'bob', password: 'new-user' })
})

test('Tabby\'s Vault open and a keychain that doesn\'t answer: the Vault\'s part is done at once, and only the keychain\'s waits', async () => {
    // Linux without a Secret Service, where the Vault is what keeps the passwords: every keychain call fails at once.
    const fail = async () => { throw new Error('The name org.freedesktop.secrets was not provided by any .service files') }
    keytar = { getPassword: fail, setPassword: fail, deletePassword: fail, findCredentials: fail }
    let s = signin()
    const secrets = new Map<string, string>()
    const vault = {
        isEnabled: () => true,
        isOpen: () => true,
        load: async () => ({ secrets: [...secrets].map(([key, value]) => ({ type: s.VAULT_SECRET_TYPE, key: { key }, value })) }),
        getSecret: async (_type: string, key: { key: string }) => secrets.has(key.key) ? { value: secrets.get(key.key) } : null,
        addSecret: async (secret: { key: { key: string }, value: string }) => { secrets.set(secret.key.key, secret.value) },
        removeSecret: async (_type: string, key: { key: string }) => { secrets.delete(key.key) },
    }
    s.useVault(vault)
    await s.saveCredentials('rdp#pc.corp:3389', { username: 'olduser', password: 'old' })
    await s.saveCredentials('alice@h:22#10.0.0.5:3389', { username: 'alice', password: 'five' })
    // A new user name: the old one's password goes from the Vault now. A new address behind a host, its desktop's
    // certificate remembered: that password moves in the Vault. Only the keychain's part of each waits.
    const forgot = await s.forgetCredentialsFor('pc.corp:3389', { direct: true, scope: '' })
    const moved = await s.moveCredentialsFor('10.0.0.5:3389', '10.0.0.9:3389', {}, (key: string) => key === 'alice@h:22#10.0.0.5:3389')
    assert.deepEqual([...secrets.keys()], ['alice@h:22#10.0.0.9:3389'])
    assert.deepEqual([forgot, moved], [['keychain'], ['keychain']])
    // Tabby started again, the forgets waiting for the keychain gone with it: the Vault holds what it did.
    s = signin()
    s.useVault(vault)
    assert.equal(await s.loadCredentials('rdp#pc.corp:3389'), null)
    assert.equal(await s.loadCredentials('alice@h:22#10.0.0.5:3389'), null)
    assert.deepEqual(await s.loadCredentials('alice@h:22#10.0.0.9:3389'), { username: 'alice', password: 'five' })
})
