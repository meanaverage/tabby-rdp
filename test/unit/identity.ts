// What an SSH host can say about the desktops it offers (src/desktops.ts, src/vms.ts): the keys that saved accounts,
// remembered certificates and the permission to sign in without NLA are kept under, and whose word a desktop's kind is.
// A host can name machines reached through it (ssh typed there, its VMs) only within its own keys, and its word that one
// is xrdp, its own desktop included, doesn't spare it the question before a password goes to a server without Network
// Level Authentication. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
    keyFromConfig, legacyKeyFromConfig, keyFields, isTargetKey, nestedKey, keyUser, keyParts, rekeyed, sessionKey, specOf, desktopsFor, viaMatches, xrdpUnasked,
    xrdpFromHost,
    OWN_DESKTOP,
} = require('../../dist/desktops.js')
const { scanVMs, vmSpec } = require('../../dist/vms.js')
const { parseGateway } = require('../../dist/gateway.js')

const config = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${k} ${v}`).join('\n') + '\n'

test('keys of hosts reached directly are as before: user@hostname:port, as ssh -G resolves it', () => {
    assert.equal(keyFromConfig(config({ user: 'alice', hostname: 'Build.Example.COM', port: '2222' }), 'build'), 'alice@build.example.com:2222')
    assert.equal(keyFromConfig(config({ hostname: 'h' }), 'h'), '@h:22')
    // Windows user names with spaces, a domain or a backslash, and IPv6: untouched, so nothing saved under them moves.
    for (const fields of [{ user: 'Jane Doe', hostname: 'winhost', port: '22' }, { user: 'alice@corp.example', hostname: 'winhost', port: '22' },
        { user: 'CORP\\bob', hostname: 'winhost', port: '22' }, { user: 'carol', hostname: 'fe80::1', port: '2222' }]) {
        assert.equal(keyFromConfig(config(fields), 'x'), legacyKeyFromConfig(config(fields), 'x'), fields.user)
    }
    assert.equal(keyFromConfig(config({ user: 'alice@corp.example', hostname: 'winhost', port: '22' }), 'x'), 'alice@corp.example@winhost:22')
    // An IPv6 address with a zone has a `%`, the escape itself: written %25, so that no other key reads the same. What
    // was kept under the key it had up to 0.5.0 is moved (test/unit/targets.ts).
    assert.equal(keyFromConfig(config({ user: 'Jane Doe', hostname: 'fe80::1%en0', port: '22' }), 'x'), 'Jane Doe@fe80::1%25en0:22')
    assert.equal(legacyKeyFromConfig(config({ user: 'Jane Doe', hostname: 'fe80::1%en0', port: '22' }), 'x'), 'Jane Doe@fe80::1%en0:22')
})

test('no two answers of ssh -G give the same key: every field reads back from it as it was', () => {
    // The audit's collision: a user name with '#', and one with what it used to be written as.
    assert.notEqual(keyFromConfig(config({ user: 'alice#ops', hostname: 'h' }), 'h'), keyFromConfig(config({ user: 'alice%23ops', hostname: 'h' }), 'h'))
    // Where the user ends, and where the host name does.
    assert.notEqual(keyFromConfig(config({ user: 'a@b', hostname: 'c' }), 'x'), keyFromConfig(config({ user: 'a', hostname: 'b@c' }), 'x'))
    assert.notEqual(keyFromConfig(config({ user: 'a', hostname: 'b:22', port: '22' }), 'x'), keyFromConfig(config({ user: 'a', hostname: 'b', port: '22:22' }), 'x'))
    // Whatever the fields hold, the key reads back to them (so no two sets of fields share one), keeps its shape, and
    // a machine reached through a host reads back the same under the host's key.
    const pieces = ['a', 'B', '%', '%23', '%3E', '%25', '#', '>', '@', ':', ' ', '\\', '41', 'f', '\u0007', '\x7f', 'é']
    // 32-bit arithmetic: in doubles, seed * 1103515245 loses its low bits, and the sequence falls into a cycle (about half
    // of the 5000 cases repeated).
    let seed = 7
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296
    const field = () => Array.from({ length: 1 + Math.floor(random() * 6) }, () => pieces[Math.floor(random() * pieces.length)]).join('').trim() || 'x'
    for (let i = 0; i < 5000; i++) {
        const fields = { user: field(), hostname: field(), port: field() }
        const key = keyFromConfig(config(fields), 'x')
        const expected = { user: fields.user, host: fields.hostname.toLowerCase(), port: fields.port }
        assert.deepEqual(keyFields(key), expected, JSON.stringify(fields))
        assert.deepEqual(keyFields(nestedKey('alice@h:22', config(fields), 'x')), expected)
        assert.equal(isTargetKey(key), true)
        assert.equal(isTargetKey(nestedKey(key, config(fields), 'x')), true)
        assert.doesNotMatch(key, /[#>\x00-\x1f\x7f]/)
        assert.equal(keyParts(`${key}#10.0.0.5:3389`).target, key)
    }
})

test('the user a desktop suggests for its sign-in is the one ssh resolved, not the key\'s way of writing it', () => {
    for (const user of ['alice#ops', 'bob>x', '50%off', 'Jane Doe', 'alice@corp.example', 'CORP\\carol', 'dave%23']) {
        const key = keyFromConfig(config({ user, hostname: 'winhost', port: '22' }), 'winhost')
        assert.equal(keyUser(key), user, key)
        // A Windows host's own desktop, and a machine with its own Windows desktop reached through a host.
        assert.equal(desktopsFor({ key, label: 'winhost' }, [], { kind: 'windows' })[0].username, user)
        const there = nestedKey('alice@h:22', config({ user, hostname: 'winvm', port: '22' }), 'winvm')
        assert.equal(desktopsFor({ key: there, label: 'winvm', via: 'h' }, [], { kind: 'windows' })[0].username, user)
    }
})

test('a desktop\'s via names its host as ssh resolved it, whatever the key writes; a machine reached through a host, never', () => {
    const key = keyFromConfig(config({ user: 'Jane Doe', hostname: 'fe80::1%en0', port: '22' }), 'x')
    const target = { key, label: 'lab' }
    for (const via of ['lab', 'fe80::1%en0', 'Jane Doe@fe80::1%en0', 'jane doe@FE80::1%en0:22', key]) {
        assert.equal(viaMatches(via, target), true, via)
    }
    for (const via of ['', 'fe80::1', 'fe80::1%25en0x', 'other']) {
        assert.equal(viaMatches(via, target), false, via)
    }
    const upn = { key: keyFromConfig(config({ user: 'alice@corp.example', hostname: 'winhost' }), 'w'), label: 'w' }
    assert.equal(viaMatches('winhost', upn), true)
    assert.equal(viaMatches('alice@corp.example@winhost', upn), true)
    // As "Add a desktop" wrote it up to 0.5.0 (it now writes the host name, winhost): still that host's.
    assert.equal(viaMatches('corp.example@winhost', upn), true)
    assert.equal(viaMatches('corp.example', upn), false)
    // A machine reached with ssh typed on host H: its name and everything ssh -G says about it are H's word, and could
    // name another host the user configured desktops behind (with a saved account). None of them is its.
    const configured = [
        { name: 'Payroll', via: 'g', host: '10.0.0.6', account: 'k3f9x2ab' },
        { name: 'Payroll 2', via: 'g.corp', host: '10.0.0.7', account: 'k3f9x2ab' },
        { name: 'Payroll 3', via: 'admin@g.corp:22', host: '10.0.0.8', account: 'k3f9x2ab' },
    ]
    const g = { key: keyFromConfig(config({ user: 'admin', hostname: 'g.corp', port: '22' }), 'g'), label: 'g' }
    assert.equal(desktopsFor(g, configured).length, 4)
    const posing = { key: nestedKey('alice@h:22', config({ user: 'admin', hostname: 'g.corp', port: '22' }), 'g'), label: 'g', via: 'h' }
    assert.deepEqual(desktopsFor(posing, configured).map((s: any) => s.id), [OWN_DESKTOP])
    assert.ok(configured.every(c => !viaMatches(c.via, posing)))
})

test('whatever ssh -G replies, a key keeps its shape: no "#" or ">" from a field', () => {
    const key = keyFromConfig(config({ user: 'victim', hostname: 'h2.corp:22#10.9.9.9', port: '3389#x>y' }), 'x')
    assert.doesNotMatch(key, /[#>]/)
    assert.equal(key, 'victim@h2.corp:22%2310.9.9.9:3389%23x%3Ey')
    assert.doesNotMatch(keyFromConfig(config({ user: 'a\tb', hostname: 'c\u0007d' }), 'x'), /[\t\u0007]/)
})

test('a host can\'t give a machine reached through it another desktop\'s key (and with it its password and certificate)', () => {
    // The user's own hosts, resolved here: H, which turned hostile, and G, which H never had anything to do with.
    const h = { key: keyFromConfig(config({ user: 'victimuser', hostname: 'h.example', port: '22' }), 'h'), label: 'h' }
    const g = { key: keyFromConfig(config({ user: 'admin', hostname: 'g.corp', port: '22' }), 'g'), label: 'g' }
    const saved = [
        sessionKey(h, { id: '10.0.0.5:3389' }),   // a desktop behind H
        sessionKey(g, { id: '10.0.0.6:3389' }),   // a desktop behind G
        sessionKey(g, { id: OWN_DESKTOP }),       // G's own (Windows, xrdp) desktop
        'rdp#192.168.1.50:3389',                  // a remote desktop tab's
    ]
    // H fakes an ssh typed in its console, and answers `ssh -G` for it as it likes (the audit's replies).
    const replies = [
        config({ user: 'victimuser', hostname: 'h.example:22#10.0.0.5', port: '3389' }),
        config({ user: 'admin', hostname: 'g.corp:22#10.0.0.6', port: '3389' }),
        config({ user: 'admin', hostname: 'g.corp', port: '22' }),
        config({ user: '', hostname: 'rdp#192.168.1.50', port: '3389' }),
    ]
    for (const reply of replies) {
        const nested = { key: nestedKey(h.key, reply, 'victimdest'), label: 'victimdest', via: 'h' }
        assert.ok(nested.key.startsWith(`${h.key}>`), nested.key)
        for (const id of [OWN_DESKTOP, '10.0.0.5:3389', '10.0.0.6:3389']) {
            assert.ok(!saved.includes(sessionKey(nested, { id })), `${sessionKey(nested, { id })} is someone else's`)
        }
    }
    // The same machine reached through two hosts is two desktops: each host's word counts only for itself.
    const reply = config({ user: 'bob', hostname: 'h2.example', port: '22' })
    assert.notEqual(nestedKey(h.key, reply, 'h2'), nestedKey(g.key, reply, 'h2'))
    assert.notEqual(nestedKey(h.key, reply, 'h2'), keyFromConfig(reply, 'h2'))
    // Its own (Windows) desktop still suggests its own user, not the key it is kept under.
    const there = { key: nestedKey(h.key, reply, 'h2'), label: 'h2', via: 'h' }
    assert.equal(keyUser(there.key), 'bob')
    assert.equal(desktopsFor(there, [], { kind: 'windows' })[0].username, 'bob')
    assert.equal(desktopsFor(h, [], { kind: 'windows' })[0].username, 'victimuser')
    assert.equal(keyUser('alice@corp.example@winhost:22'), 'alice@corp.example')
})

test('an xrdp desktop signs in without NLA unasked only on the user\'s word', async () => {
    const host = { key: 'alice@host:22', label: 'host' }
    const throughHost = { key: 'alice@host:22>bob@other:22', label: 'other', via: 'host' }
    // Configured by the user (a desktop behind a host, an RDP profile): xrdp as they said.
    assert.equal(xrdpUnasked(specOf({ host: '10.0.0.7', kind: 'xrdp' })), true)
    assert.equal(xrdpUnasked(specOf({ host: '10.0.0.7', kind: 'windows' })), false)
    // A VM the host found and the user saved as it was: still the host's word.
    assert.equal(xrdpUnasked(specOf({ host: '10.0.0.7', kind: 'xrdp', kindFromHost: true })), false)
    // The host's own xrdp desktop, and its xrdp besides GNOME: what its setup reported. The host may have only the user's
    // SSH key, not the password typed for its desktop.
    assert.equal(xrdpUnasked(desktopsFor(host, [], { kind: 'xrdp', xrdpPort: 3389, xrdpUser: 'alice' })[0]), false)
    const besides = desktopsFor(host, [], { kind: 'gnome', xrdpPort: 3390, xrdpUser: 'alice' })
    assert.equal(xrdpUnasked(besides.find((s: any) => s.id === '127.0.0.1:3390')), false)
    // A machine reached with ssh typed on that host: everything about it, its kind too, is that host's word.
    assert.equal(xrdpUnasked(desktopsFor(throughHost, [], { kind: 'xrdp', xrdpPort: 3389, xrdpUser: 'bob' })[0]), false)
    const besidesThere = desktopsFor(throughHost, [], { kind: 'gnome', xrdpPort: 3390, xrdpUser: 'bob' })
    assert.equal(xrdpUnasked(besidesThere.find((s: any) => s.id === '127.0.0.1:3390')), false)
    // VMs found on the host, whatever it says they run (the audit's scan: a Windows VM relabelled as Linux).
    const scan = ['TRD_SH', 'TRD_VM win11|running|http://microsoft.com/win/11|192.168.122.10|2',
        'TRD_VM win11-relabelled|running|http://ubuntu.com/ubuntu/22.04|192.168.122.11|1'].join('\n')
    const found = (await scanVMs({ ...host, exec: async () => scan }, {})).map(vmSpec)
    assert.deepEqual(found.map((s: any) => [s.name, s.kind]), [['win11', 'windows'], ['win11-relabelled', 'xrdp']])
    assert.ok(found.every((s: any) => !xrdpUnasked(s)))
})

test('a VM saved from a host\'s list before the mark existed is still the host\'s word; a kind the user picked is theirs', () => {
    // As 0.3.0 to 0.5.0 saved one: the host's kind, and started by its name when it is off.
    const legacy = { name: 'FakeVM', via: 'h', host: '10.9.9.9', port: 3389, kind: 'xrdp', wake: { vm: 'FakeVM' } }
    assert.equal(xrdpFromHost(legacy), true)
    assert.equal(xrdpUnasked(specOf(legacy)), false)
    assert.equal(xrdpUnasked(desktopsFor({ key: 'alice@h:22', label: 'h' }, [legacy]).find((s: any) => s.id === '10.9.9.9:3389')), false)
    // Picked in the form: the user's (see test/unit/desktop-form.ts).
    assert.equal(xrdpUnasked(specOf({ ...legacy, kindFromHost: false })), true)
    // Without a VM to start, or of another kind: nothing tells it from the user's own.
    assert.equal(xrdpUnasked(specOf({ ...legacy, wake: undefined })), true)
    assert.equal(xrdpUnasked(specOf({ ...legacy, wake: { mac: 'aa:bb:cc:dd:ee:ff' } })), true)
    assert.equal(xrdpFromHost({ ...legacy, kind: 'windows' }), false)
    // An RDP profile has no wake: what its kind says is the user's.
    assert.equal(xrdpUnasked(specOf({ host: '10.0.0.7', kind: 'xrdp', name: 'Profile' })), true)
})

test('a VM\'s address is one the scan can find, an IPv4 address: it can\'t give the VM another desktop\'s key', async () => {
    const host = { key: 'alice@h.example:22', label: 'h' }
    // A desktop configured behind the host, reached through an RD Gateway on port 3389, whose sign-in is the
    // gateway's too: its password is saved under its key scoped to that gateway (DesktopSession.credentialKey).
    const configured = specOf({ host: '10.0.0.5', port: 3389, gateway: 'gw.example:3389' })
    const gateway = parseGateway(configured.gateway)
    const savedUnder = `${sessionKey(host, configured)}@gateway#${gateway.host}:${gateway.port}`
    // The host lists a "VM" at an address of its making: one that would have the VM's key (its saved password's too,
    // without a gateway) read as that one.
    const scan = ['TRD_SH',
        'TRD_VM Payroll|running|http://microsoft.com/win/11|10.0.0.5:3389@gateway#gw.example|2',
        'TRD_VM Spaced|running|http://microsoft.com/win/11|10.0.0.6 |2',
        'TRD_VM Named|running|http://microsoft.com/win/11|vm.example|2',
        'TRD_VM Six|running|http://microsoft.com/win/11|fe80::1|2',
        'TRD_VM Plain|running|http://microsoft.com/win/11|192.168.122.10|2'].join('\n')
    const found = (await scanVMs({ ...host, exec: async () => scan }, {})).map(vmSpec)
    assert.deepEqual(found.map((s: any) => s.name), ['Plain'])
    assert.ok(found.every((s: any) => sessionKey(host, s) !== savedUnder))
    assert.deepEqual(keyParts(sessionKey(host, found[0])), { target: host.key, desktopId: '192.168.122.10:3389', gateway: '' })
})

test('a key as made up to 0.5.0 is told from one a target can have now', () => {
    // Former keys with what is now escaped: none can be a target's key now, so what is under them is that target's.
    for (const former of ['Jane Doe@fe80::1%en0:22', 'ops#1@g.example:22', 'bob>x@h:22', 'a%2f@h:22', 'a%2F@h:22']) {
        assert.equal(isTargetKey(former), false, former)
    }
    // One that reads as a key now: another target's (alice#ops), as a machine reached through a host can be too.
    for (const key of ['alice%23ops@h:22', 'alice@h:22', 'a@b:22>c@h:22', 'jane doe@fe80::1%25en0:22']) {
        assert.equal(isTargetKey(key), true, key)
    }
    assert.equal(isTargetKey('rdp'), false)
})

test('keys of a target whose key changed: its own and its desktops\', and no other target\'s', () => {
    const from = 'Jane Doe@fe80::1%en0:22'
    const to = 'Jane Doe@fe80::1%25en0:22'
    assert.equal(rekeyed(from, from, to), to)
    assert.equal(rekeyed(`${from}#10.0.0.5:3389`, from, to), `${to}#10.0.0.5:3389`)
    assert.equal(rekeyed(`${from}#hyperv`, from, to), `${to}#hyperv`)
    assert.equal(rekeyed(`${from}#10.0.0.5:3389@gateway#gw.example:443`, from, to), `${to}#10.0.0.5:3389@gateway#gw.example:443`)
    for (const other of [`${from}x`, `${from}:22`, 'rdp#10.0.0.5:3389', `${from}#10.0.0.5:3389#more`, `x${from}`, `${from}>bob@b:22`]) {
        assert.equal(rekeyed(other, from, to), null, other)
    }
})
