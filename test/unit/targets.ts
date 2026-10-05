// What RemoteTargets (src/targets.ts) makes of what ssh says. A target's key is how ssh resolved it, written so that no
// two targets get the same one (keyFromConfig in src/desktops.ts). Up to 0.5.0 the fields went into it as they were, so
// a host whose user or host name has a character now written as `%xx` (the `%` of an IPv6 address's zone, a `#` in a
// user name) has another key now. It is the same target, resolved by ssh on this computer, so what was kept for it
// moves along: its desktops' remembered certificates and sharpness when its key is resolved, its saved passwords the
// first time they are looked for, but for a `#` in its user name, whose passwords nothing could forget by their
// desktop. And the `ssh` a host says runs in a console is offered only under a name that shows as it is, by the
// import's measure of one. Runs against the built plugin with Tabby's modules and the keychain stubbed, and `ssh -G`
// answered by a stand-in on PATH: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const require = createRequire(import.meta.url)

let keytar: Record<string, (...args: string[]) => Promise<unknown>> = {}
const decorator = () => () => undefined
const stubs: Record<string, unknown> = {
    '@angular/core': { Injectable: decorator },
    'tabby-core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request === 'keytar' ? keytar : request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { RemoteTargets } = require('../../dist/targets.js')
const { probeArrived } = require('../../dist/probe.js')
// The same module the targets use: it keeps which keys changed.
const signin = require('../../dist/signin.js')

const A = Array(32).fill('AA').join(':')
const B = Array(32).fill('BB').join(':')

/** A keytar standing in for the OS keychain, holding JSON credential values in a map. */
function keychain (entries: Record<string, unknown>): Map<string, string> {
    const saved = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
    keytar = {
        getPassword: async (_s, key) => saved.get(key) ?? null,
        setPassword: async (_s, key, value) => { saved.set(key, value) },
        deletePassword: async (_s, key) => { saved.delete(key) },
        findCredentials: async () => [...saved].map(([account, password]) => ({ account, password })) as any,
    }
    return saved
}

/** `ssh` on PATH, answering `ssh -G` with these fields, as the system's would after reading its config. */
function sshAnswering (t: any, fields: Record<string, string>): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-ssh-'))
    fs.writeFileSync(path.join(dir, 'answer'), Object.entries(fields).map(([k, v]) => `${k} ${v}`).join('\n') + '\n')
    fs.writeFileSync(path.join(dir, 'ssh'), `#!/bin/sh\ncat '${path.join(dir, 'answer')}'\n`, { mode: 0o755 })
    const before = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${before}`
    t.after(() => {
        process.env.PATH = before
        fs.rmSync(dir, { recursive: true, force: true })
    })
}

/** A Tabby config with these `remoteDesktop` lists, counting its saves. */
function tabbyConfig (remoteDesktop: Record<string, unknown>) {
    return { store: { remoteDesktop, profiles: [] }, saves: 0, save () { this.saves++ } }
}

const sshTab = (name: string) => ({ profile: { type: 'ssh', name, options: { host: name, user: 'jane', port: 22 } }, element: { nativeElement: {} } })

test('a host whose key reads otherwise now keeps its certificates, sharpness and saved passwords', { skip: process.platform === 'win32' }, async t => {
    sshAnswering(t, { user: 'Jane Doe', hostname: 'fe80::1%en0', port: '22' })
    const before = 'Jane Doe@fe80::1%en0:22'
    const now = 'Jane Doe@fe80::1%25en0:22'
    const config = tabbyConfig({
        trustedCertificates: [{ desktop: before, sha256: A }, { desktop: `${before}#10.0.0.5:3389`, sha256: B }, { desktop: 'bob@other:22', sha256: A }],
        desktopSharpness: [{ desktop: `${before}#10.0.0.5:3389`, sharpness: 'retina' }],
        withoutNla: [{ desktop: `${before}#10.0.0.5:3389`, sha256: B }],
    })
    const own = { username: 'Jane Doe', password: 'p1' }
    const behind = { username: 'jane', password: 'p2' }
    const saved = keychain({ [before]: own, [`${before}#10.0.0.5:3389@gateway#gw.example:443`]: behind, 'bob@other:22': { username: 'bob', password: 'p3' } })
    const targets = new RemoteTargets(config, {})
    const target = await targets.targetOf(sshTab('lab'))
    assert.equal(target.key, now)
    // Its certificates (the host's own desktop's, and one behind it) and its sharpness: moved at once, and saved.
    assert.deepEqual(config.store.remoteDesktop.trustedCertificates,
        [{ desktop: now, sha256: A }, { desktop: `${now}#10.0.0.5:3389`, sha256: B }, { desktop: 'bob@other:22', sha256: A }])
    assert.deepEqual(config.store.remoteDesktop.desktopSharpness, [{ desktop: `${now}#10.0.0.5:3389`, sharpness: 'retina' }])
    // The permission to sign in without NLA, which holds for that certificate only, goes with it.
    assert.deepEqual(config.store.remoteDesktop.withoutNla, [{ desktop: `${now}#10.0.0.5:3389`, sha256: B }])
    assert.equal(config.saves, 1)
    // Its saved passwords: found under the new key the first time they are looked for there, and moved.
    assert.deepEqual(await signin.loadCredentials(now), own)
    assert.deepEqual(await signin.loadCredentials(`${now}#10.0.0.5:3389@gateway#gw.example:443`), behind)
    assert.deepEqual([...saved.keys()].sort(), ['bob@other:22', now, `${now}#10.0.0.5:3389@gateway#gw.example:443`].sort())
    // Nothing for a desktop it never had, or another gateway's.
    assert.equal(await signin.loadCredentials(`${now}#10.0.0.9:3389`), null)
    assert.equal(await signin.loadCredentials(`${now}#10.0.0.5:3389@gateway#other.example:443`), null)
})

test('a host whose key reads as before moves nothing, and an entry already under the new key stays', { skip: process.platform === 'win32' }, async t => {
    sshAnswering(t, { user: 'alice', hostname: 'h.example', port: '22' })
    const config = tabbyConfig({ trustedCertificates: [{ desktop: 'alice@h.example:22', sha256: A }], desktopSharpness: [] })
    const targets = new RemoteTargets(config, {})
    assert.equal((await targets.targetOf(sshTab('h'))).key, 'alice@h.example:22')
    assert.equal(config.saves, 0)

    sshAnswering(t, { user: 'ops#1', hostname: 'g.example', port: '22' })
    const both = tabbyConfig({
        trustedCertificates: [{ desktop: 'ops#1@g.example:22', sha256: A }, { desktop: 'ops%231@g.example:22', sha256: B }],
        desktopSharpness: [],
    })
    assert.equal((await new RemoteTargets(both, {}).targetOf(sshTab('g'))).key, 'ops%231@g.example:22')
    assert.deepEqual(both.store.remoteDesktop.trustedCertificates, [{ desktop: 'ops#1@g.example:22', sha256: A }, { desktop: 'ops%231@g.example:22', sha256: B }])
    assert.equal(both.saves, 0)
})

test('nothing moves from a former key that is another target\'s key now', { skip: process.platform === 'win32' }, async t => {
    // The user `alice%23ops` had the key `alice%23ops@h.example:22`, which is `alice#ops`'s now: what is kept under it
    // may be that one's. This one's desktops ask again instead.
    sshAnswering(t, { user: 'alice%23ops', hostname: 'h.example', port: '22' })
    const theirs = 'alice%23ops@h.example:22'
    const config = tabbyConfig({ trustedCertificates: [{ desktop: theirs, sha256: A }, { desktop: `${theirs}#10.0.0.5:3389`, sha256: B }], desktopSharpness: [] })
    const saved = keychain({ [theirs]: { username: 'alice#ops', password: 'theirs' } })
    const target = await new RemoteTargets(config, {}).targetOf(sshTab('h'))
    assert.equal(target.key, 'alice%2523ops@h.example:22')
    assert.deepEqual(config.store.remoteDesktop.trustedCertificates, [{ desktop: theirs, sha256: A }, { desktop: `${theirs}#10.0.0.5:3389`, sha256: B }])
    assert.equal(config.saves, 0)
    assert.equal(await signin.loadCredentials(target.key), null)
    assert.deepEqual([...saved.keys()], [theirs])
})

test('a host whose user name has a `#` keeps its certificates, and its desktops ask for their passwords again', { skip: process.platform === 'win32' }, async t => {
    sshAnswering(t, { user: 'alice#ops', hostname: 'h.example', port: '22' })
    const before = 'alice#ops@h.example:22'
    const now = 'alice%23ops@h.example:22'
    const config = tabbyConfig({ trustedCertificates: [{ desktop: `${before}#10.0.0.5:3389`, sha256: A }], desktopSharpness: [] })
    // Under that key, a desktop's password reads as no desktop's: removing the desktop at .6 since left it in place.
    keychain({ [before]: { username: 'alice#ops', password: 'own' }, [`${before}#10.0.0.6:3389`]: { username: 'alice', password: 'removed' } })
    await signin.forgetCredentialsFor('10.0.0.6:3389')
    const target = await new RemoteTargets(config, {}).targetOf(sshTab('h'))
    assert.equal(target.key, now)
    assert.deepEqual(config.store.remoteDesktop.trustedCertificates, [{ desktop: `${now}#10.0.0.5:3389`, sha256: A }])
    assert.equal(await signin.loadCredentials(`${now}#10.0.0.6:3389`), null)
    assert.equal(await signin.loadCredentials(now), null)
})

test('an ssh the host says runs in the console is offered only under a name that shows as it is', { skip: process.platform === 'win32' }, async t => {
    sshAnswering(t, { user: 'jane', hostname: 'h.example', port: '22' })
    const targets = new RemoteTargets(tabbyConfig({ trustedCertificates: [], desktopSharpness: [] }), {})
    const pane = sshTab('h')
    const outer = await targets.targetOf(pane)
    // The host answers the look for ssh clients with these, and its terminal echoes each one's probe in this pane. Of
    // characters that don't show besides controls and format characters: a Hangul filler, the braille blank, a no-break
    // and an em space, a variation selector, the combining grapheme joiner.
    const destinations = ['build', 'corp\u202egpj.exe', 'dc01\u200b', 'line\u2028break', 'soft\u00adhyphen', 'bell\u0007', 'corp\u3164evil',
        'corp\u2800evil', 'corp\u00a0evil', 'corp\u2003evil', 'corp\ufe0fevil', 'corp\u034fevil', 'other.example']
    outer.exec = async (_command: string, script: string) => {
        const probe = /^PROBE='([^']+)'/.exec(script)![1]
        destinations.forEach((_, i) => probeArrived(`${probe}-${i + 1}`, pane))
        return destinations.map((d, i) => `TRD_SSH ${i + 1}|pts/0|ssh\x1f${d}`).join('\n') + '\n'
    }
    const found = await targets.nestedSSH(pane)
    assert.deepEqual(found.map((n: any) => n.cmd.destination), ['build', 'other.example'])
})
