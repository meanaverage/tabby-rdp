// The user name and domain both clients sign in with (signInParts): DOMAIN\user is split, anything else goes as typed
// with the desktop's domain, and a PAM proxy's bracketed name (#122) is not split at the backslash inside its brackets.
// Reads the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { signInParts } = require('../../dist/accounts.js')

test('DOMAIN\\user is split at its backslash, its own domain over the desktop\'s', () => {
    assert.deepEqual(signInParts('CORP\\alice', ''), { username: 'alice', domain: 'CORP' })
    assert.deepEqual(signInParts('CORP\\alice', 'OTHER'), { username: 'alice', domain: 'CORP' })
    // Only the first backslash splits, and brackets after it are the user name's.
    assert.deepEqual(signInParts('CORP\\svc\\x', ''), { username: 'svc\\x', domain: 'CORP' })
    assert.deepEqual(signInParts('CORP\\svc[1]', ''), { username: 'svc[1]', domain: 'CORP' })
})

test('a name with no domain of its own goes as typed, with the desktop\'s domain', () => {
    assert.deepEqual(signInParts('alice', 'CORP'), { username: 'alice', domain: 'CORP' })
    assert.deepEqual(signInParts('alice', ''), { username: 'alice', domain: '' })
    assert.deepEqual(signInParts('alice@corp.example', 'CORP'), { username: 'alice@corp.example', domain: 'CORP' })
    // Nothing on one side of the backslash: not DOMAIN\user.
    assert.deepEqual(signInParts('\\alice', ''), { username: '\\alice', domain: '' })
    assert.deepEqual(signInParts('CORP\\', ''), { username: 'CORP\\', domain: '' })
})

test('a PAM proxy\'s bracketed name goes whole, its backslash and all (#122)', () => {
    // senhasegura: vault user, then the target's credential and device in brackets; the proxy reads the user name whole.
    assert.deepEqual(signInParts('pam-user[CORP\\vault-account@target-vm]', ''),
        { username: 'pam-user[CORP\\vault-account@target-vm]', domain: '' })
    assert.deepEqual(signInParts('pam-user[vault-account@target-vm]', ''),
        { username: 'pam-user[vault-account@target-vm]', domain: '' })
    // A desktop's domain still goes beside it, as with any name that isn't split.
    assert.deepEqual(signInParts('pam-user[CORP\\vault-account@target-vm]', 'CORP'),
        { username: 'pam-user[CORP\\vault-account@target-vm]', domain: 'CORP' })
    assert.deepEqual(signInParts('odd]name\\alice', ''), { username: 'odd]name\\alice', domain: '' })
})
