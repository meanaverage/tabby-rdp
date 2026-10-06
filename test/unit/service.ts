// The desktop service's decisions that stand between a password and whatever answers (src/desktop.service.ts), with
// Tabby's modules stubbed: the stop at a server without Network Level Authentication, what is allowed there, which
// certificate that is held to and when it is taken back, and which machine Desktop opens where a host says ssh runs in
// its console. The service's own methods run on a stand-in config; nothing connects. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { authority, selfSigned } from './support/certificates.js'
import { FakeElement, installDocument } from './support/dom.js'

const require = createRequire(import.meta.url)

// Tabby and Angular, as far as loading the service and the profile provider needs them; and the system keychain,
// as a map (see keychain).
const decorator = () => () => undefined
const classes = new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } })
const keychain = new Map<string, string>()
const stubs: Record<string, unknown> = {
    '@angular/core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : decorator }),
    'tabby-core': classes,
    'tabby-settings': classes,
    'tabby-terminal': classes,
    keytar: {
        getPassword: async (_s: string, key: string) => keychain.get(key) ?? null,
        setPassword: async (_s: string, key: string, value: string) => { keychain.set(key, value) },
        deletePassword: async (_s: string, key: string) => keychain.delete(key),
        findCredentials: async () => [...keychain].map(([account, password]) => ({ account, password })),
    },
}
// The proxy as the service starts it, where a test stands in for it (see the test of what it is started with).
let startProxy: ((...args: any[]) => Promise<unknown>) | null = null
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    if (request === './rdcleanpath') {
        const proxy = load.call(this, request, ...rest)
        return new Proxy(proxy, { get: (real, name) => name === 'startRDCleanPathProxy' && startProxy ? startProxy : real[name] })
    }
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { RemoteDesktopService, DesktopSession, GATEWAY_PASSWORDS_MARK } = require('../../dist/desktop.service.js')
const { specOf, sessionKey, xrdpUnasked, hyperVSpec } = require('../../dist/desktops.js')
const { vmSpec } = require('../../dist/vms.js')
const signin = require('../../dist/signin.js')

const A = Array(32).fill('AA').join(':')
const B = Array(32).fill('BB').join(':')
const C = Array(32).fill('CC').join(':')

/**
 * The service on a config of its own (`remoteDesktop` as given, and `profiles`), with what else it is handed for these
 * tests; `saves` counts the config's saves.
 */
function service (remoteDesktop: Record<string, unknown> = {}, deps: { targets?: unknown, selector?: unknown, app?: unknown, profiles?: unknown[] } = {}) {
    const config = {
        store: { remoteDesktop: { trustedCertificates: [], withoutNla: [], nestedSSH: [], desktops: [], accounts: [], desktopSharpness: [], ...remoteDesktop }, profiles: deps.profiles ?? [] },
        saves: 0,
        save () { this.saves++ },
        // Tabby's config says when it changes (the service follows it: see test/unit/clipboard-service.ts); here only
        // when a test calls `changed`.
        changes: [] as (() => void)[],
        changed$: { subscribe (f: () => void) { config.changes.push(f) } },
        changed () { this.changes.forEach(f => f()) },
    }
    const notifications = { notice () { }, info () { }, error () { } }
    const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
    const svc = new RemoteDesktopService(deps.app ?? {}, deps.targets ?? {}, notifications, config, zone, {}, {}, deps.selector ?? {}, {})
    const revisions = new Map<string, string>()
    svc.accountRevisions = new (require('../../dist/accountRevisions.js').AccountRevisions)(() => ({
        getItem: (key: string) => revisions.get(key) ?? null, setItem: (key: string, value: string) => revisions.set(key, value),
    }), () => true)
    return { svc, store: config.store.remoteDesktop as any, config }
}

/**
 * A desktop session as these methods see it; its layer answers a question with any of `answers`, and keeps what it
 * showed and the buttons it offered.
 */
function session (spec: any, key: string, ...answers: (string | undefined)[]) {
    return {
        spec, key, authKey: key, log: [] as string[], visible: false, withoutNla: false, sendAnyway: false, certificateProblem: null as any,
        disposed: new Promise<void>(() => { }), shown: [] as string[], offered: [] as { label: string, default?: boolean }[][],
        status (text: string, actions: { label: string, run: () => void, default?: boolean }[] = []) {
            this.shown.push(text)
            this.offered.push(actions.map(a => ({ label: a.label, ...a.default ? { default: true } : {} })))
            actions.find(a => answers.includes(a.label))?.run()
        },
    }
}

/** What the proxy's certificate check does with the session, for a server without NLA: goes on, or stops to ask. */
function held (svc: any, s: ReturnType<typeof session>, fingerprint: string): 'goes on' | 'asks' {
    svc.checkCertificate(s, fingerprint)
    try {
        svc.holdWithoutNla(s, fingerprint)
        return 'goes on'
    } catch (e: any) {
        assert.match(e.message, /Network Level Authentication/)
        assert.equal(s.withoutNla, true)
        return 'asks'
    }
}

/** What the proxy's stop does with the session: goes on, or stops to ask. */
function stop (svc: any, s: ReturnType<typeof session>): 'goes on' | 'asks' {
    try {
        svc.checkWithoutNla(s)
        return 'goes on'
    } catch (e: any) {
        assert.match(e.message, /Network Level Authentication/)
        assert.equal(s.withoutNla, true)
        return 'asks'
    }
}

const foundXrdp = vmSpec({ name: 'FakeVM', state: 'running', windows: false, address: '10.9.9.9', rdp: true })

test('the stop at a server without NLA: only a desktop the user made xrdp goes on unasked', async () => {
    const { svc } = service()
    // What the host found and calls xrdp (the audit's relabelled VM) asks, as a Windows desktop does.
    assert.equal(stop(svc, session(foundXrdp, 'alice@h:22#10.9.9.9:3389')), 'asks')
    assert.equal(stop(svc, session(specOf({ host: '10.0.0.7', kind: 'windows' }), 'alice@h:22#10.0.0.7:3389')), 'asks')
    assert.equal(stop(svc, session(specOf({ host: '10.9.9.9', kind: 'xrdp', kindFromHost: true }), 'alice@h:22#10.9.9.9:3389')), 'asks')
    assert.equal(stop(svc, session(specOf({ host: '10.0.0.7', kind: 'xrdp' }), 'alice@h:22#10.0.0.7:3389')), 'goes on')

    // The own desktop's kind comes from the setup: the host's word about itself, or, for a machine reached with ssh
    // typed on a host, that host's word. Neither spares the question. (The sign-in form is answered with Cancel.)
    const titles: string[] = []
    signin.askCredentials = async (_layer: unknown, options: { title: string }) => { titles.push(options.title); return null }
    const host = { key: 'alice@h:22', label: 'h', exec: async () => 'RD_XRDP port=3389 user=alice\n' }
    const there = { key: 'alice@h:22>bob@x:22', label: 'x', via: 'h', exec: async () => 'RD_XRDP port=3389 user=bob\n' }
    const own: Record<string, unknown> = {}
    for (const target of [host, there]) {
        const spec = svc.desktopsOf(target)[0]
        const s = session(spec, sessionKey(target, spec))
        const pane = {}
        svc.sessions.set(pane, s)
        assert.equal(await svc.endpointFor(pane, target, spec, s, false), null)
        own[target.label] = { kind: spec.kind, stop: stop(svc, session(spec, s.key)) }
    }
    assert.deepEqual(own, { h: { kind: 'xrdp', stop: 'asks' }, x: { kind: 'xrdp', stop: 'asks' } })
    // And the sign-in says which host leads there.
    assert.deepEqual(titles, ['Sign in to h desktop', 'Sign in to x desktop (via h)'])
})

test('a desktop a host calls xrdp asks in xrdp\'s terms; the answer is kept with the certificate of the server that gets it', async () => {
    const { svc, store } = service()
    const key = 'alice@h:22#10.9.9.9:3389'
    const pane = {}
    const s = session(foundXrdp, key, 'Send the password anyway')
    svc.sessions.set(pane, s)
    assert.equal(stop(svc, s), 'asks')
    assert.equal(await svc.refusedWithoutNla(pane, { key: 'alice@h:22', label: 'h' }, foundXrdp, s), true)
    const question = s.shown.find(t => /Network Level Authentication/.test(t)) ?? ''
    assert.match(question, /xrdp signs in this way by design\. That FakeVM is xrdp is what h reported/)
    assert.match(question, /Your password hasn't been sent\./)
    assert.doesNotMatch(question, /set its kind|edit form|Nothing has been sent/)
    // Cancel is what Enter picks, as for the certificate questions: sending the password is the risk.
    assert.deepEqual(s.offered[0], [{ label: 'Send the password anyway' }, { label: 'Cancel', default: true }])
    // Nothing is kept before a certificate shows: the next attempt goes on to TLS, and the permission is kept with the
    // certificate of the server that answers it.
    assert.deepEqual(store.withoutNla, [])
    assert.equal(stop(svc, s), 'goes on')
    assert.equal(held(svc, s, A), 'goes on')
    assert.deepEqual(store.withoutNla, [{ desktop: key, sha256: A }])
    // Later connections: that server goes on; one with another certificate (a first use: nothing else remembered) stops
    // before the password goes.
    const later = session(foundXrdp, key)
    assert.equal(stop(svc, later), 'goes on')
    assert.equal(held(svc, later, A), 'goes on')
    store.trustedCertificates = []
    const other = session(foundXrdp, key)
    assert.equal(stop(svc, other), 'goes on')
    assert.equal(held(svc, other, B), 'asks')
    // The host's own xrdp is asked about the same way: that it is xrdp is the host's word too.
    const ownXrdp = svc.desktopsOf({ key: 'alice@h:22', label: 'h' })[0]
    ownXrdp.kind = 'xrdp'
    const asOwn = session(ownXrdp, 'alice@h:22', 'Cancel')
    svc.sessions.set(pane, asOwn)
    assert.equal(stop(svc, asOwn), 'asks')
    assert.equal(await svc.refusedWithoutNla(pane, { key: 'alice@h:22', label: 'h' }, ownXrdp, asOwn), false)
    assert.match(asOwn.shown[0], /That h desktop is xrdp is what h reported, not a setting of yours/)
    // A VM saved from h's list as h reported it: told how its kind becomes the user's.
    const kept = session(specOf({ name: 'Build VM', host: '10.9.9.7', kind: 'xrdp', kindFromHost: true }), 'alice@h:22#10.9.9.7:3389', 'Cancel')
    svc.sessions.set(pane, kept)
    assert.equal(stop(svc, kept), 'asks')
    assert.equal(await svc.refusedWithoutNla(pane, { key: 'alice@h:22', label: 'h' }, kept.spec, kept), false)
    assert.match(kept.shown[0], /That Build VM is xrdp is what h reported, not a setting of yours: send the password if you know it is, or pick its kind in its edit form, which makes it one\./)
    // A desktop the user configured as Windows is told it can be made an xrdp one; the host's own Windows can't.
    const asked = session(specOf({ host: '10.0.0.7' }), 'alice@h:22#10.0.0.7:3389', 'Cancel')
    svc.sessions.set(pane, asked)
    assert.equal(await svc.refusedWithoutNla(pane, { key: 'alice@h:22', label: 'h' }, asked.spec, asked), false)
    assert.match(asked.shown[0], /set its kind to xrdp instead/)
})

test('a found VM saved to the host\'s desktops keeps its kind as the host\'s word', () => {
    const { svc, store } = service()
    const pane = {}
    svc.sessions.set(pane, { spec: foundXrdp, remote: { label: 'h', key: 'alice@h:22' } })
    svc.saveFoundDesktop(pane)
    const windows = vmSpec({ name: 'Win', state: 'running', windows: true, address: '10.9.9.8', rdp: true })
    svc.sessions.set(pane, { spec: windows, remote: { label: 'h', key: 'alice@h:22' } })
    svc.saveFoundDesktop(pane)
    assert.deepEqual(store.desktops.map((d: any) => [d.name, d.kind, d.kindFromHost]), [['FakeVM', 'xrdp', true], ['Win', 'windows', undefined]])
    assert.equal(xrdpUnasked(specOf(store.desktops[0])), false)
    // One found on a machine reached with ssh typed on h isn't offered for keeping: kept behind the name h gave that
    // machine ("prod", say), it would show in tabs connected to whatever host goes by that name.
    assert.equal(svc.canSaveFoundDesktop(pane), true)
    svc.sessions.set(pane, { spec: windows, remote: { label: 'prod', key: 'alice@h:22>admin@prod:22', via: 'h' } })
    assert.equal(svc.canSaveFoundDesktop(pane), false)
    svc.saveFoundDesktop(pane)
    assert.equal(store.desktops.length, 2)
})

test('trusting a changed certificate takes back signing in without NLA; a gateway\'s certificate doesn\'t', async () => {
    const key = 'rdp#10.0.0.5:3389'
    const { svc, store } = service({ trustedCertificates: [{ desktop: key, sha256: A }], withoutNla: [{ desktop: key, sha256: A }, { desktop: 'rdp#10.0.0.6:3389', sha256: A }] })
    const spec = specOf({ host: '10.0.0.5', name: 'WIN-OLD' })
    const target = { key: 'rdp', label: 'WIN-OLD', direct: spec }
    const pane = {}
    // As the proxy goes: the stop (allowed earlier), then the certificate, which has changed.
    const s = session(spec, key, 'Trust the new certificate')
    svc.sessions.set(pane, s)
    assert.equal(stop(svc, s), 'goes on')
    assert.throws(() => svc.checkCertificate(s, B), /not the one remembered/)
    assert.equal(await svc.refusedCertificate(pane, target, spec, s, { port: 3389 }, s.certificateProblem), true)
    // Trusted by the user: a direct desktop's certificate an authority didn't vouch for.
    assert.deepEqual(store.trustedCertificates, [{ desktop: key, sha256: B, authority: false }])
    assert.deepEqual(store.withoutNla, [{ desktop: 'rdp#10.0.0.6:3389', sha256: A }])
    assert.match(s.shown.find(t => /has changed/.test(t)) ?? '', /allowed to sign in without Network Level Authentication, which goes with the old certificate/)
    // The next attempt stops at the question again, before anything more goes to the new server.
    const retry = session(spec, key)
    svc.sessions.set(pane, retry)
    assert.equal(stop(svc, retry), 'asks')

    // The desktop's gateway presenting a new certificate: nothing to do with how the desktop signs in.
    store.withoutNla = [{ desktop: key, sha256: B }]
    const viaGateway = session(spec, key, 'Trust the new certificate')
    svc.sessions.set(pane, viaGateway)
    const problem = { expected: A, actual: B, pinned: false, gateway: { address: 'gw.example:443', key: 'gateway#gw.example:443' } }
    assert.equal(await svc.refusedCertificate(pane, target, spec, viaGateway, { port: 3389 }, problem), true)
    assert.deepEqual(store.withoutNla, [{ desktop: key, sha256: B }])
})

test('a gateway\'s first certificate is confirmed in its own words, with why it can\'t be verified, and leaves how the desktop signs in alone', async () => {
    const key = 'rdp#10.0.0.5:3389'
    const { svc, store } = service({ withoutNla: [{ desktop: key }] })
    const spec = specOf({ host: '10.0.0.5', name: 'WIN', gateway: 'gw.example' })
    const target = { key: 'rdp', label: 'WIN', direct: spec }
    const pane = {}
    // Why it isn't valid, as the TLS library said (Node's code): each said so, none claimed to be an authority's verdict
    // on the issuer when it is about the name or the dates.
    const reasons: [string, RegExp][] = [
        ['DEPTH_ZERO_SELF_SIGNED_CERT', /it is self-signed/],
        ['ERR_TLS_CERT_ALTNAME_INVALID', /it was issued for another name than gw\.example/],
        ['CERT_HAS_EXPIRED', /it has expired/],
        ['CERT_NOT_YET_VALID', /it isn't valid yet/],
        ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /no certificate authority (this computer trusts|Tabby checks against) [^.]*vouches for it from what the server sent/],
        ['SOMETHING_ELSE', /it couldn't be verified \(SOMETHING_ELSE\)/],
    ]
    for (const [reason, why] of reasons) {
        const s = session(spec, key, 'Cancel')
        svc.sessions.set(pane, s)
        assert.throws(() => svc.checkGatewayCertificate(s, { host: 'gw.example', port: 443 }, B, false, reason), /hasn't been seen before/)
        assert.equal(await svc.refusedCertificate(pane, target, spec, s, { port: 3389 }, s.certificateProblem), false)
        assert.match(s.shown[0], /^WIN's gateway gw\.example:443 has a certificate this computer can't verify: /)
        assert.match(s.shown[0], why, reason)
        if (reason !== 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
            assert.doesNotMatch(s.shown[0], /authority this computer trusts|Tabby checks against/, reason)
        }
    }
    assert.deepEqual(store.trustedCertificates, [], 'nothing remembered while cancelled')
    const s = session(spec, key, 'Trust the certificate')
    svc.sessions.set(pane, s)
    // Never seen, and not valid for its name: asked about before the sign-in goes to the gateway.
    assert.throws(() => svc.checkGatewayCertificate(s, { host: 'gw.example', port: 443 }, B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT'), /hasn't been seen before/)
    assert.equal(await svc.refusedCertificate(pane, target, spec, s, { port: 3389 }, s.certificateProblem), true)
    assert.match(s.shown[0], /proof of your password, which a server posing as the gateway could try to crack offline/)
    assert.ok(s.shown[0].includes(B.slice(0, 47)), 'its fingerprint')
    assert.deepEqual(s.offered[0], [{ label: 'Trust the certificate' }, { label: 'Cancel', default: true }], 'Cancel is what Enter picks')
    assert.doesNotMatch(s.shown[0], /Network Level Authentication/)
    assert.deepEqual(store.trustedCertificates, [{ desktop: 'gateway#gw.example:443', sha256: B, authority: false }])
    assert.deepEqual(store.withoutNla, [{ desktop: key }])
    // Remembered now: the next connection goes on.
    svc.checkGatewayCertificate(s, { host: 'gw.example', port: 443 }, B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT')
})

test('a desktop\'s new address takes its certificate along and leaves it at the old one, not the permission to sign in without NLA', async () => {
    const at = (id: string) => `alice@h:22#${id}`
    const { svc, store } = service({
        trustedCertificates: [{ desktop: at('10.0.0.5:3389'), sha256: A }],
        withoutNla: [{ desktop: at('10.0.0.5:3389') }, { desktop: at('10.0.0.6:3389') }],
    })
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.9:3389', false, false, {})
    assert.deepEqual(store.trustedCertificates, [{ desktop: at('10.0.0.5:3389'), sha256: A }, { desktop: at('10.0.0.9:3389'), sha256: A }])
    assert.deepEqual(store.withoutNla, [{ desktop: at('10.0.0.6:3389') }])
    // A direct desktop the same.
    store.trustedCertificates = [{ desktop: 'rdp#10.0.0.5:3389', sha256: A }]
    store.withoutNla = [{ desktop: 'rdp#10.0.0.5:3389' }]
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.9:3389', false, true, {})
    assert.deepEqual(store.trustedCertificates, [{ desktop: 'rdp#10.0.0.5:3389', sha256: A }, { desktop: 'rdp#10.0.0.9:3389', sha256: A }])
    assert.deepEqual(store.withoutNla, [])
})

test('a new address doesn\'t take the place of what a desktop there has: its certificate, sharpness and saved password stay its own', async () => {
    keychain.clear()
    const at = (host: string, id: string) => `${host}#${id}`
    const { svc, store } = service({
        trustedCertificates: [
            { desktop: at('rdp', '10.0.0.5:3389'), sha256: A },
            { desktop: at('rdp', '10.0.0.9:3389'), sha256: B, authority: false },
            // Behind hosts: host B has desktops at both addresses; host A only at the old one.
            { desktop: at('alice@a:22', '10.0.0.20:3389'), sha256: A },
            { desktop: at('bob@b:22', '10.0.0.20:3389'), sha256: B },
            { desktop: at('bob@b:22', '10.0.0.30:3389'), sha256: C },
        ],
        desktopSharpness: [{ desktop: at('rdp', '10.0.0.5:3389'), sharpness: 'retina' }, { desktop: at('rdp', '10.0.0.9:3389'), sharpness: 'standard' }],
    })
    await signin.saveCredentials(at('rdp', '10.0.0.5:3389'), { username: 'moved', password: 'its-old' })
    await signin.saveCredentials(at('rdp', '10.0.0.9:3389'), { username: 'there', password: 'its-own' })
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.9:3389', false, true, {})
    // The desktop already at the new address keeps its certificate and sharpness, and nothing else is found under its key.
    const under = (key: string) => store.trustedCertificates.filter((e: any) => e.desktop === key)
    assert.deepEqual(under(at('rdp', '10.0.0.9:3389')), [{ desktop: at('rdp', '10.0.0.9:3389'), sha256: B, authority: false }])
    assert.deepEqual(under(at('rdp', '10.0.0.5:3389')), [{ desktop: at('rdp', '10.0.0.5:3389'), sha256: A }], 'the old address keeps its own')
    assert.deepEqual(store.desktopSharpness, [{ desktop: at('rdp', '10.0.0.9:3389'), sharpness: 'standard' }])
    // Its saved password too: the edited desktop's goes, and it asks at its new address.
    assert.deepEqual(await signin.loadCredentials(at('rdp', '10.0.0.9:3389')), { username: 'there', password: 'its-own' })
    assert.equal(await signin.loadCredentials(at('rdp', '10.0.0.5:3389')), null)
    // Behind hosts: host A's moves; host B keeps the certificate of its own desktop at the new address.
    await svc.desktopEdited('10.0.0.20:3389', '10.0.0.30:3389', false, false, {})
    assert.deepEqual(under(at('alice@a:22', '10.0.0.30:3389')), [{ desktop: at('alice@a:22', '10.0.0.30:3389'), sha256: A }])
    assert.deepEqual(under(at('bob@b:22', '10.0.0.30:3389')), [{ desktop: at('bob@b:22', '10.0.0.30:3389'), sha256: C }])
    // Each host's certificate stays at the old address as well.
    assert.deepEqual(under(at('alice@a:22', '10.0.0.20:3389')), [{ desktop: at('alice@a:22', '10.0.0.20:3389'), sha256: A }])
    assert.deepEqual(under(at('bob@b:22', '10.0.0.20:3389')), [{ desktop: at('bob@b:22', '10.0.0.20:3389'), sha256: B }])
})

test('an address edit leaves the certificate at the old address, where another desktop\'s password stays: another machine there is asked about', async () => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    const host = 'alice@h:22'
    const { svc, store } = service({ trustedCertificates: [{ desktop: `${host}#10.0.0.5:3389`, sha256: A }], gatewayPasswordsMigrated: true })
    keychain.set(GATEWAY_PASSWORDS_MARK, 'done')
    // Two desktops at .5 behind the host, one reached directly and one through a gateway: a password each, kept for the
    // way there; the certificate is the address's, one for both.
    await signin.saveCredentials(`${host}#10.0.0.5:3389`, { username: 'u', password: 'direct-secret' })
    await signin.saveCredentials(`${host}#10.0.0.5:3389@gateway#gw.example:443`, { username: 'u', password: 'gateway-secret' })
    // The one through the gateway is edited to .9: its password goes along, with the certificate.
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.9:3389', false, false, { from: 'gw.example', to: 'gw.example' })
    assert.deepEqual(await signin.loadCredentials(`${host}#10.0.0.9:3389@gateway#gw.example:443`), { username: 'u', password: 'gateway-secret' })
    assert.deepEqual(store.trustedCertificates.map((e: any) => e.desktop), [`${host}#10.0.0.5:3389`, `${host}#10.0.0.9:3389`])
    // The other keeps its password at .5, and its certificate: the same machine goes on, another is asked about, where
    // without the certificate it would be trusted as a first use and get that password.
    assert.deepEqual(await signin.loadCredentials(`${host}#10.0.0.5:3389`), { username: 'u', password: 'direct-secret' })
    const at = () => session(specOf({ host: '10.0.0.5' }), `${host}#10.0.0.5:3389`)
    svc.checkCertificate(at(), A)
    assert.throws(() => svc.checkCertificate(at(), B), /is not the one remembered/)
})

test('a certificate remembered for the new address while the stores are listed keeps the password from moving there', async () => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    const host = 'alice@h:22'
    const { svc, store } = service({ trustedCertificates: [{ desktop: `${host}#10.0.0.5:3389`, sha256: A }], gatewayPasswordsMigrated: true })
    keychain.set(GATEWAY_PASSWORDS_MARK, 'done')
    await signin.saveCredentials(`${host}#10.0.0.5:3389`, { username: 'u', password: 'secret' })
    // The stores take their time to list (a Vault's passphrase prompt), and meanwhile another connection remembers the
    // certificate of the machine at the new address.
    const keytar = stubs.keytar as any
    const list = keytar.findCredentials
    keytar.findCredentials = async (...args: unknown[]) => {
        const found = await list(...args)
        store.trustedCertificates.push({ desktop: `${host}#10.0.0.9:3389`, sha256: B })
        return found
    }
    try {
        await svc.desktopEdited('10.0.0.5:3389', '10.0.0.9:3389', false, false, {})
    } finally {
        keytar.findCredentials = list
    }
    // That machine would check out with its own certificate and get the password unasked: it doesn't move.
    assert.equal(await signin.loadCredentials(`${host}#10.0.0.9:3389`), null)
    assert.equal(await signin.loadCredentials(`${host}#10.0.0.5:3389`), null)
    assert.deepEqual(store.trustedCertificates.find((e: any) => e.desktop === `${host}#10.0.0.9:3389`), { desktop: `${host}#10.0.0.9:3389`, sha256: B })
})

test('Desktop where a host says ssh runs in its console: asks, the tab\'s own first, and opens a machine at once only once told to', async () => {
    const own = { key: 'alice@h:22', label: 'h' }
    const dc = { cmd: { options: [], destination: 'corp-dc01' }, tty: 'pts/0' }
    const other = { cmd: { options: [], destination: 'other' }, tty: 'pts/0' }
    let nested = [dc]
    const targets: Record<string, any> = {
        targetOf: async () => own,
        nestedSSH: async () => nested,
        nestedTarget: async (_pane: unknown, n: typeof dc) => ({ key: `${own.key}>${n.cmd.destination}`, label: n.cmd.destination, via: own.label }),
    }
    const asked: string[][] = []
    type Option = { name: string, result: unknown }
    let pick = (options: Option[]) => options[1].result
    const selector = { show: async (_title: string, options: Option[]) => { asked.push(options.map(o => o.name)); return pick(options) } }
    const { svc, store } = service({}, { targets, selector })
    const pane = { profile: { type: 'ssh' }, element: { nativeElement: {} } }
    const fromNowOn = (options: Option[]) => options.find(o => /, from now on$/.test(o.name))!.result

    // One ssh, never chosen from this host: the tab's own connection first (Enter opens it), then the machine, this
    // time or from now on.
    assert.equal((await svc.remoteFor(pane)).key, 'alice@h:22>corp-dc01')
    assert.deepEqual(asked, [['h', 'corp-dc01', 'corp-dc01, from now on']])
    // Chosen this time only: asked again the next time, and Enter is the tab's own.
    assert.deepEqual(store.nestedSSH, [])
    pick = options => options[0].result
    assert.equal(await svc.remoteFor(pane), own)
    assert.equal(asked.length, 2)
    // From now on: remembered, and opened at once after that.
    pick = fromNowOn
    assert.equal((await svc.remoteFor(pane)).key, 'alice@h:22>corp-dc01')
    assert.deepEqual(store.nestedSSH, [{ via: 'alice@h:22', destination: 'corp-dc01' }])
    assert.equal((await svc.remoteFor(pane)).key, 'alice@h:22>corp-dc01')
    assert.equal(asked.length, 3)
    // Somewhere else: asked again.
    nested = [other]
    pick = options => options[0].result
    assert.equal(await svc.remoteFor(pane), own)
    assert.equal(asked.length, 4)
    // A machine the host couldn't resolve isn't remembered, even "from now on": the tab's own desktop opens instead.
    targets.nestedTarget = async () => { throw new Error('ssh -G failed') }
    pick = fromNowOn
    assert.equal(await svc.remoteFor(pane), own)
    assert.deepEqual(store.nestedSSH, [{ via: 'alice@h:22', destination: 'corp-dc01' }])
    // Cancelled: nothing opens.
    pick = () => { throw new Error('cancelled') }
    assert.equal(await svc.remoteFor(pane), undefined)
    // The same destination from another host is another choice.
    const elsewhere = { key: 'carol@g:22', label: 'g' }
    targets.targetOf = async () => elsewhere
    nested = [dc]
    pick = options => options[0].result
    await svc.remoteFor(pane)
    assert.equal(asked.length, 7)
})

test('"Send the password anyway" is kept only with a certificate: an attempt that never got one leaves nothing behind', async () => {
    const key = 'rdp#10.0.0.5:3389'
    const spec = specOf({ host: '10.0.0.5', name: 'WIN' })
    const target = { key: 'rdp', label: 'WIN', direct: spec }
    // As development builds kept it, without a certificate (0.5.0 never saved it at all): no permission now.
    const { svc, store } = service({ withoutNla: [{ desktop: key }] })
    const pane = {}
    const first = session(spec, key, 'Send the password anyway')
    svc.sessions.set(pane, first)
    assert.equal(stop(svc, first), 'asks')
    assert.equal(await svc.refusedWithoutNla(pane, target, spec, first), true)
    // The attempt after it doesn't get as far as a certificate (the server went away, the tab was closed).
    svc.sessions.delete(pane)
    // Whatever answers at that address the next time is asked about again, rather than let through to a first use.
    const later = session(spec, key)
    assert.equal(stop(svc, later), 'asks')
    assert.deepEqual(store.withoutNla.filter((e: any) => e?.sha256), [])
    assert.equal(svc.signsInWithoutNla(key), false)
})

test('a connection let on before its permission was taken back stops before the password goes', async () => {
    const key = 'rdp#10.0.0.5:3389'
    const spec = specOf({ host: '10.0.0.5', name: 'WIN' })
    const target = { key: 'rdp', label: 'WIN', direct: spec }
    const { svc, store } = service({ trustedCertificates: [{ desktop: key, sha256: A }], withoutNla: [{ desktop: key, sha256: A }] })
    assert.equal(svc.signsInWithoutNla(key), true)
    const pane = {}
    // Two connections of the desktop at once (a reconnect overlapping the one it replaces): the first is let on to TLS
    // by the permission given for certificate A.
    const one = session(spec, key)
    assert.equal(stop(svc, one), 'goes on')
    // The second meets certificate B, which is trusted: that takes the permission back.
    const two = session(spec, key, 'Trust the new certificate')
    svc.sessions.set(pane, two)
    assert.throws(() => svc.checkCertificate(two, B), /not the one remembered/)
    assert.equal(await svc.refusedCertificate(pane, target, spec, two, { port: 3389 }, two.certificateProblem), true)
    assert.deepEqual(store.withoutNla, [])
    // The first then gets B too: the certificate checks out now, the permission doesn't.
    assert.equal(held(svc, one, B), 'asks')

    // "Send the password anyway" answered just now, then a changed certificate trusted: that answer went with the
    // server before it, and the question comes again.
    const three = session(spec, key, 'Send the password anyway', 'Trust the new certificate')
    svc.sessions.set(pane, three)
    assert.equal(stop(svc, three), 'asks')
    assert.equal(await svc.refusedWithoutNla(pane, target, spec, three), true)
    assert.equal(stop(svc, three), 'goes on')
    assert.throws(() => svc.checkCertificate(three, A), /not the one remembered/)
    assert.equal(await svc.refusedCertificate(pane, target, spec, three, { port: 3389 }, three.certificateProblem), true)
    assert.match(three.shown.find((text: string) => /has changed/.test(text)) ?? '', /Nothing of your sign-in has been sent to it\.[^]*allowed to sign in without Network Level Authentication, which goes with the old certificate/)
    assert.equal(stop(svc, three), 'asks')
    assert.deepEqual(store.withoutNla, [])
})

test('a desktop picked by id replaces the one open in the pane when it is another remote\'s, even with the same id', async t => {
    // Just enough of the DOM for a desktop's layer to be made; nothing connects.
    const g = globalThis as any
    const saved = { document: g.document, getComputedStyle: g.getComputedStyle }
    t.after(() => Object.assign(g, saved))
    const element = (): any => ({
        style: {}, className: '', classList: { toggle () { }, add () { }, remove () { } },
        set innerHTML (_: string) { },
        querySelector: () => element(), querySelectorAll: () => [], addEventListener () { }, appendChild (child: unknown) { return child },
    })
    g.document = { createElement: element }
    g.getComputedStyle = () => ({ position: 'relative' })

    const own = { key: 'alice@h:22', label: 'h', exec: async () => '' }
    const there = { key: 'alice@h:22>bob@x:22', label: 'x', via: 'h', exec: async () => '' }
    const subscription = { subscribe: () => ({ unsubscribe () { } }) }
    const pane = { profile: { type: 'ssh' }, element: { nativeElement: element() }, destroyed$: subscription, focused$: subscription }
    const targets = { targetOf: async () => own, nestedSSH: async () => [], cached: () => own }
    const { svc } = service({}, { targets, app: { tabs: [pane] } })
    svc.connect = async () => { }
    const opened = (key: string) => {
        let disposed = false
        svc.sessions.set(pane, { spec: { id: 'own' }, key, state: 'connected', visible: false, dispose: () => { disposed = true } })
        return () => disposed
    }

    // The machine's own desktop, reached with ssh typed on h, is open; the menus' "h desktop" (the id 'own') is asked for.
    let gone = opened(there.key)
    await svc.showDesktop(pane, 'own', { background: true })
    assert.equal(gone(), true)
    assert.equal(svc.sessions.get(pane).key, own.key)
    // The other way, as desk asks for the machine it ran on: the host's own desktop is open.
    gone = opened(own.key)
    await svc.showDesktop(pane, 'own', { background: true, target: there })
    assert.equal(gone(), true)
    assert.equal(svc.sessions.get(pane).key, there.key)
    // The same desktop asked for again: kept.
    gone = opened(own.key)
    await svc.showDesktop(pane, 'own', { background: true })
    assert.equal(gone(), false)
    assert.equal(svc.sessions.get(pane).key, own.key)
})

test('the Desktops menu offers the host\'s own desktop while a machine reached through it has its own open in the pane', () => {
    const { desktopChoices, toggleLabel } = require('../../dist/ui.js')
    const own = { key: 'alice@h:22', label: 'h' }
    const pane = { profile: { type: 'ssh' }, element: { nativeElement: {} } }
    const { svc } = service({ desktops: [{ name: 'Win VM', via: 'h', host: '10.0.0.5' }] }, { targets: { cached: () => own }, app: { tabs: [pane] } })
    const labels = () => desktopChoices(svc, pane, 'h').map((item: any) => item.label)
    // Nothing open: the toggle opens the host's own; the menu offers the rest.
    assert.deepEqual(labels(), ['Open Win VM', 'Add a desktop behind h…'])
    // x's own desktop, reached with ssh typed on h, open in the pane: its id is the host's own's too, but it isn't h's.
    svc.sessions.set(pane, { spec: { id: 'own', name: 'x desktop', kind: 'xrdp' }, key: 'alice@h:22>bob@x:22', state: 'connected', visible: false, dispose () { },
        remote: { key: 'alice@h:22>bob@x:22', label: 'x', via: 'h' } })
    assert.deepEqual(labels(), ['Open h desktop', 'Open Win VM', 'Add a desktop behind h…'])
    assert.equal(toggleLabel(svc, pane), 'Show x desktop')
    // h's own desktop open: not offered again.
    svc.sessions.set(pane, { spec: { id: 'own', name: 'h desktop', kind: 'xrdp' }, key: 'alice@h:22', state: 'connected', visible: false, dispose () { }, remote: own })
    assert.deepEqual(labels(), ['Open Win VM', 'Add a desktop behind h…'])
})

test('the Desktops menu finds the desktop the toggle opens once, not again for each of the many a host lists', () => {
    const { desktopChoices } = require('../../dist/ui.js')
    const own = { key: 'alice@h:22', label: 'h' }
    const pane = { profile: { type: 'ssh' }, element: { nativeElement: {} } }
    const desktops = Array.from({ length: 100 }, (_, i) => ({ name: `D${i}`, via: 'h', host: `10.0.1.${i}` }))
    const { svc } = service({ desktops }, { targets: { cached: () => own }, app: { tabs: [pane] } })
    // As many VMs as a host's are listed (MAX_VMS), found on it a moment ago.
    const vms = Array.from({ length: 256 }, (_, i) => vmSpec({ name: `VM${i}`, state: 'running', windows: false, address: `10.1.${i}.1`, rdp: true }))
    svc.vms.set(own.key, { at: Date.now(), specs: vms, host: {} })
    // Each time the host's desktops are put together, every configured entry and profile is read again.
    let built = 0
    const desktopsOf = svc.desktopsOf.bind(svc)
    svc.desktopsOf = (target: unknown) => { built++; return desktopsOf(target) }
    const items = desktopChoices(svc, pane, 'h')
    // Every desktop but the toggle's (the host's own, nothing being open), and "Add a desktop".
    assert.equal(items.length, 100 + 256 + 1)
    assert.ok(built <= 2, `the host's desktops were put together ${built} times for one menu`)
})

test('a Hyper-V VM\'s sign-in through a machine reached with ssh says which host leads there, and suggests that machine\'s user', async () => {
    const asked: { title: string, username?: string }[] = []
    signin.askCredentials = async (_layer: unknown, options: { title: string, username?: string }) => { asked.push(options); return null }
    const { svc } = service()
    const there = { key: 'alice@h:22>bob%23ops@hv:22', label: 'hv', via: 'h', exec: async () => 'TRD_HV_STATE Running|2\n' }
    const spec = hyperVSpec('5f05e000-c4d4-499c-8cca-429587811556', 'Build VM')
    const s = session(spec, sessionKey(there, spec))
    const pane = {}
    svc.sessions.set(pane, s)
    assert.equal(await svc.endpointFor(pane, there, spec, s, false), null)
    assert.deepEqual(asked.map(o => [o.title, o.username]), [['Sign in to hv (via h), to open Build VM', 'bob#ops']])
})

test('a machine reached through a host gets none of the desktops configured behind the host it is named like', () => {
    // A desktop behind host g that signs in with a saved account, whose password goes wherever the desktop does.
    const { svc } = service({ desktops: [{ name: 'Payroll', via: 'g', host: '10.0.0.6', account: 'k3f9x2ab' }] })
    assert.ok(svc.desktopsOf({ key: 'admin@g.corp:22', label: 'g' }).some((s: any) => s.account === 'k3f9x2ab'))
    // Host h says ssh to "g" runs in its console, and answers ssh -G as g would: only that machine's own desktop.
    const posing = { key: 'alice@h:22>admin@g.corp:22', label: 'g', via: 'h' }
    assert.deepEqual(svc.desktopsOf(posing).map((s: any) => s.id), ['own'])
    assert.equal(svc.defaultDesktop(posing).id, 'own')
})

test('a desktop\'s proxy stops at a server without NLA, and the answer is held to the certificate that server then shows', async t => {
    // What the service starts the proxy with, and a proxy that does nothing itself.
    let options: any
    startProxy = async (_open: unknown, check: (fingerprint: string) => void, _log: unknown, given: any) => {
        options = { ...given, check }
        return { url: 'ws://127.0.0.1:9/token', token: 'token', failure: null, stats: { bytesIn: 0, bytesOut: 0 }, close () { } }
    }
    t.after(() => { startProxy = null })
    const key = 'alice@h:22#10.0.0.5:3389'
    const { svc, store } = service()
    const spec = specOf({ host: '10.0.0.5', name: 'WIN' })
    const target = { key: 'alice@h:22', label: 'h' }
    const pane = {}
    const s: any = { ...session(spec, key, 'Send the password anyway'), proxy: null, state: 'connecting' }
    svc.sessions.set(pane, s)
    svc.endpointFor = async () => ({ host: '10.0.0.5', port: 3389, credentials: { username: 'alice', password: 'secret' }, remember: false })
    svc.loadIronRDP = async () => ({})
    svc.afterEnd = () => { }
    // Each attempt as the proxy makes it with a server that chose TLS without NLA and shows certificate A: the stop
    // before TLS, the certificate check, then the hold, all before the client would hear back and send the password.
    const attempts: string[] = []
    svc.run = async (_pane: unknown, _target: unknown, _spec: unknown, attempt: any) => {
        attempt.withoutNla = false
        try {
            await options.withoutNla()
            await options.check(A)
            await options.withoutNlaCertificate(A)
            attempts.push('the password goes')
            return { connected: true }
        } catch (e: any) {
            attempts.push(e.message)
            return { connected: false, withoutNla: attempt.withoutNla }
        }
    }
    await svc.connect(pane, target, spec, s)
    // Stopped, asked, and on "Send the password anyway" the same account again: remembered with A.
    assert.deepEqual(attempts, ['the server doesn\'t use Network Level Authentication', 'the password goes'])
    assert.match(s.shown.find((text: string) => /Network Level Authentication/.test(text)) ?? '', /Your password hasn't been sent/)
    assert.deepEqual(store.withoutNla, [{ desktop: key, sha256: A }])
    assert.equal(options.autologon, false)
})

test('a direct desktop without NLA: its proxy checks the name and holds the answer, and a first certificate trusted keeps the answer just given', async t => {
    // What the service starts the proxy with, and a proxy that does nothing itself.
    let options: any
    startProxy = async (_open: unknown, check: (fingerprint: string, valid: boolean, reason: string) => void, _log: unknown, given: any) => {
        options = { ...given, check }
        return { url: 'ws://127.0.0.1:9/token', token: 'token', failure: null, stats: { bytesIn: 0, bytesOut: 0 }, close () { } }
    }
    t.after(() => { startProxy = null })
    const { svc, store } = service()
    const spec = specOf({ host: 'win.example', name: 'PC' })
    const key = `rdp#${spec.id}`
    const target = { key: 'rdp', label: 'PC', direct: spec }
    const pane = {}
    const s: any = { ...session(spec, key, 'Send the password anyway', 'Trust the certificate'), proxy: null, state: 'connecting' }
    svc.sessions.set(pane, s)
    svc.endpointFor = async () => ({ host: 'win.example', port: 3389, credentials: { username: 'alice', password: 'secret' }, remember: false })
    svc.loadIronRDP = async () => ({})
    svc.afterEnd = () => { }
    // Each attempt as the proxy makes it with a server that chose TLS without NLA and shows a self-signed certificate
    // B: the stop before TLS, the certificate check (by the desktop's name), then the hold.
    const attempts: string[] = []
    svc.run = async (_pane: unknown, _target: unknown, _spec: unknown, attempt: any) => {
        attempt.withoutNla = false
        try {
            await options.withoutNla()
            await options.check(B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT')
            await options.withoutNlaCertificate(B)
            attempts.push('the password goes')
            return { connected: true }
        } catch (e: any) {
            attempts.push(e.message)
            return { connected: false, withoutNla: attempt.withoutNla, certificate: attempt.certificateProblem ?? undefined }
        }
    }
    await svc.connect(pane, target, spec, s)
    assert.equal(options.serverName, 'win.example')
    // Stopped and asked about NLA; then about the certificate, first seen after that answer, which stays; then the
    // password goes, the answer kept with the certificate trusted.
    assert.deepEqual(attempts, [
        'the server doesn\'t use Network Level Authentication',
        `certificate SHA-256 ${B} can't be verified (DEPTH_ZERO_SELF_SIGNED_CERT), and hasn't been seen before`,
        'the password goes',
    ])
    assert.deepEqual(store.trustedCertificates, [{ desktop: key, sha256: B, authority: false }])
    assert.deepEqual(store.withoutNla, [{ desktop: key, sha256: B }])
    // That certificate's question said what trusting it lets go: the password itself, not a proof of it.
    const question = s.shown.find((text: string) => /has a certificate this computer can't verify/.test(text)) ?? ''
    assert.match(question, /This server doesn't use Network Level Authentication: signing in sends it your password itself, readable to a server posing as PC\./)
    assert.doesNotMatch(question, /proof of your password/)
})

/** A desktop connected to directly at `host` (a profile's), its key, and a pane whose session answers with `answer`. */
function direct (svc: any, host: string, answer?: string, gateway?: string) {
    const spec = specOf({ host, name: 'PC', ...gateway ? { gateway } : {} })
    const key = `rdp#${spec.id}`
    const s = session(spec, key, answer)
    const pane = {}
    svc.sessions.set(pane, s)
    return { spec, key, s, pane, target: { key: 'rdp', label: 'PC', direct: spec } }
}

/** The question for a certificate the check refused on `d`'s session, answered as `d` answers; whether it connects again. */
const ask = (svc: any, d: ReturnType<typeof direct>) => svc.refusedCertificate(d.pane, d.target, d.spec, d.s, { port: 3389 }, d.s.certificateProblem)

test('a desktop connected to directly: one valid for its name connects unasked; any other is asked about before anything goes to it', async () => {
    const { svc, store } = service()
    // Valid for its name by this computer's certificate authorities: connects, remembered as the authority's.
    const valid = direct(svc, 'pc.example')
    svc.checkCertificate(valid.s, A, true, '')
    assert.deepEqual(store.trustedCertificates, [{ desktop: valid.key, sha256: A, authority: true }])
    assert.ok(valid.s.log.some(l => l === `certificate: SHA-256 ${A}, valid for pc.example, remembered`), valid.s.log.join('\n'))

    // Not valid, never seen: stopped at the proxy, and asked about, with the address, the gateway, why, and the fingerprint.
    const first = direct(svc, 'win.example', 'Cancel', 'rdgw.example.com')
    assert.throws(() => svc.checkCertificate(first.s, B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT'), /can't be verified \(DEPTH_ZERO_SELF_SIGNED_CERT\), and hasn't been seen before/)
    assert.deepEqual(first.s.certificateProblem, { expected: '', actual: B, pinned: false, valid: false, name: 'win.example', reason: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    // An automatic reconnect stops at the question too.
    svc.reconnects.set(first.pane, { attempts: 1, since: Date.now() })
    assert.equal(await ask(svc, first), false)
    assert.equal(svc.reconnects.has(first.pane), false)
    const question = first.s.shown[0]
    assert.match(question, /^PC \(win\.example:3389, through the gateway rdgw\.example\.com\) has a certificate this computer can't verify: it is self-signed/)
    // Nothing went to the desktop; its gateway has had the sign-in, as its own certificate allowed, and that is said.
    assert.match(question, /Nothing of your sign-in has been sent to it yet; only the gateway has had your sign-in\. Signing in gives PC a proof of your password, which a server posing as PC could try to crack offline\./)
    assert.ok(question.includes(B.slice(0, 47)) && question.includes(B.slice(48)), 'the fingerprint, whole')
    assert.deepEqual(first.s.offered[0], [{ label: 'Trust the certificate' }, { label: 'Cancel', default: true }], 'Cancel is what Enter picks')
    // Cancelled: not connected, nothing remembered.
    assert.match(first.s.shown[1], /^Not connected: the certificate was not trusted\./)
    assert.equal(store.trustedCertificates.length, 1)

    // Trusted: remembered as the user's, and the next connection goes on, as long as it is the same certificate.
    const trusted = direct(svc, 'win.example', 'Trust the certificate', 'rdgw.example.com')
    assert.throws(() => svc.checkCertificate(trusted.s, B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT'))
    assert.equal(await ask(svc, trusted), true)
    assert.deepEqual(store.trustedCertificates[1], { desktop: trusted.key, sha256: B, authority: false })
    svc.checkCertificate(direct(svc, 'win.example').s, B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT')
    // An address is checked the same way (against the certificate's addresses).
    assert.throws(() => svc.checkCertificate(direct(svc, '10.0.0.5').s, C, false, 'ERR_TLS_CERT_ALTNAME_INVALID'), /hasn't been seen before/)

    // Named as the certificate is checked for it, as the .rdp import shows names: an international name as its punycode
    // (and without a trailing dot, which SNI doesn't take), the gateway in its one form.
    const named = direct(svc, 'Bücher.example.', 'Cancel', 'RDGW.Example.com.')
    assert.throws(() => svc.checkCertificate(named.s, C, false, 'ERR_TLS_CERT_ALTNAME_INVALID'), /hasn't been seen before/)
    assert.equal(named.s.certificateProblem.name, 'xn--bcher-kva.example')
    await ask(svc, named)
    assert.match(named.s.shown[0], /^PC \(xn--bcher-kva\.example:3389, through the gateway rdgw\.example\.com\) has a certificate this computer can't verify: it was issued for another name than xn--bcher-kva\.example\./)
    // A host no name is (a character no host name has) is checked as it is: never as the part a URL parser would make of it.
    const odd = direct(svc, 'pc.example?.corp.example')
    assert.throws(() => svc.checkCertificate(odd.s, C, false, 'ERR_TLS_CERT_ALTNAME_INVALID'), /hasn't been seen before/)
    assert.equal(odd.s.certificateProblem.name, 'pc.example?.corp.example')
})

test('a direct desktop\'s certificate that changes: an authority\'s may be renewed by one it vouches for; one the user trusted stops the connection, whatever replaces it', async () => {
    const { svc, store } = service({
        trustedCertificates: [
            { desktop: 'rdp#ca.example:3389', sha256: A, authority: true },
            { desktop: 'rdp#mine.example:3389', sha256: A, authority: false },
            { desktop: 'rdp#yours.example:3389', sha256: A, authority: false },
            // Remembered before the two were told apart (trusted on first use, unasked).
            { desktop: 'rdp#old.example:3389', sha256: A },
            { desktop: 'rdp#same.example:3389', sha256: A },
        ],
    })
    const entry = (host: string) => store.trustedCertificates.find((e: any) => e.desktop === `rdp#${host}:3389`)
    // An authority's, renewed by one valid for the name: connects, and the log says what it replaced.
    const renewed = direct(svc, 'ca.example')
    svc.checkCertificate(renewed.s, B, true, '')
    assert.ok(renewed.s.log.includes(`certificate: SHA-256 ${B}, valid for ca.example, in place of ${A} (renewed)`), renewed.s.log.join('\n'))
    assert.deepEqual(entry('ca.example'), { desktop: 'rdp#ca.example:3389', sha256: B, authority: true })
    // An authority's, replaced by one that isn't valid: asked about, saying why.
    const broken = direct(svc, 'ca.example', 'Cancel')
    assert.throws(() => svc.checkCertificate(broken.s, C, false, 'CERT_HAS_EXPIRED'), /is not the one remembered/)
    assert.equal(await ask(svc, broken), false)
    assert.match(broken.s.shown[0], /^The certificate of PC has changed since it was last used\..*The new one can't be verified: it has expired\./s)
    assert.deepEqual(broken.s.offered[0], [{ label: 'Trust the new certificate' }, { label: 'Cancel', default: true }])
    // One the user trusted, replaced by one an authority vouches for: still asked about, saying so.
    const mine = direct(svc, 'mine.example', 'Trust the new certificate')
    assert.throws(() => svc.checkCertificate(mine.s, B, true, ''), /is not the one remembered/)
    assert.equal(await ask(svc, mine), true)
    assert.match(mine.s.shown[0], /The new one is valid for mine\.example by this computer's certificate authorities, but the one it replaces is one you trusted yourself\./)
    // Trusted then, it is held as the authority's from now on: a renewal by one goes through.
    assert.deepEqual(entry('mine.example'), { desktop: 'rdp#mine.example:3389', sha256: B, authority: true })
    svc.checkCertificate(direct(svc, 'mine.example').s, C, true, '')
    // One the user trusted that an authority turns out to vouch for stays the user's: its replacement is asked about.
    svc.checkCertificate(direct(svc, 'yours.example').s, A, true, '')
    assert.deepEqual(entry('yours.example'), { desktop: 'rdp#yours.example:3389', sha256: A, authority: false })
    assert.throws(() => svc.checkCertificate(direct(svc, 'yours.example').s, B, true, ''), /is not the one remembered/)
    // Remembered before: held to the one remembered, as before, even against one an authority vouches for, and the
    // question says it was remembered unasked...
    const old = direct(svc, 'old.example', 'Cancel')
    assert.throws(() => svc.checkCertificate(old.s, B, true, ''), /is not the one remembered/)
    assert.equal(await ask(svc, old), false)
    assert.match(old.s.shown[0], /The new one is valid for old\.example by this computer's certificate authorities, but the one it replaces was remembered the first time it was seen, without that check\./)
    assert.deepEqual(entry('old.example'), { desktop: 'rdp#old.example:3389', sha256: A })
    // ...until the one remembered turns out to be valid for the name: from then on, the authority's.
    svc.checkCertificate(direct(svc, 'same.example').s, A, true, '')
    assert.equal(entry('same.example').authority, true)
    svc.checkCertificate(direct(svc, 'same.example').s, B, true, '')
    assert.equal(entry('same.example').sha256, B)
})

test('a certificate remembered on an authority\'s word that no longer holds is asked about as a first use; the user\'s own and older ones still connect', async () => {
    const { svc, store } = service({
        trustedCertificates: [
            { desktop: 'rdp#ca.example:3389', sha256: A, authority: true },
            { desktop: 'rdp#mine.example:3389', sha256: A, authority: false },
            // Remembered before the two were told apart (trusted on first use, unasked).
            { desktop: 'rdp#old.example:3389', sha256: A },
            { desktop: 'gateway#gw.example:443', sha256: A, authority: true },
        ],
    })
    const entry = (key: string) => store.trustedCertificates.find((e: any) => e.desktop === key)
    // The same certificate that an authority vouched for, which has expired since (or whose authority this computer no
    // longer trusts): it connects while valid, as before...
    svc.checkCertificate(direct(svc, 'ca.example').s, A, true, '')
    // ...and otherwise stops and is asked about, worded as one that can't be verified (nothing to compare it with).
    const lapsed = direct(svc, 'ca.example', 'Cancel')
    assert.throws(() => svc.checkCertificate(lapsed.s, A, false, 'CERT_HAS_EXPIRED'), /can't be verified \(CERT_HAS_EXPIRED\), and was remembered on an authority's word, which no longer holds/)
    assert.deepEqual(lapsed.s.certificateProblem, { expected: '', actual: A, pinned: false, valid: false, name: 'ca.example', reason: 'CERT_HAS_EXPIRED' })
    assert.ok(lapsed.s.log.includes(`certificate: SHA-256 ${A}, as remembered, but no longer valid for ca.example: CERT_HAS_EXPIRED`), lapsed.s.log.join('\n'))
    assert.equal(await ask(svc, lapsed), false)
    assert.match(lapsed.s.shown[0], /^PC \(ca\.example:3389\) has a certificate this computer can't verify: it has expired\./)
    assert.deepEqual(lapsed.s.offered[0], [{ label: 'Trust the certificate' }, { label: 'Cancel', default: true }])
    // Not trusted: it stays as it was, and is asked about again.
    assert.deepEqual(entry('rdp#ca.example:3389'), { desktop: 'rdp#ca.example:3389', sha256: A, authority: true })
    const again = direct(svc, 'ca.example', 'Trust the certificate')
    assert.throws(() => svc.checkCertificate(again.s, A, false, 'CERT_HAS_EXPIRED'), /can't be verified/)
    // Trusted: the user's own from then on, which connects as it is, valid or not.
    assert.equal(await ask(svc, again), true)
    assert.deepEqual(entry('rdp#ca.example:3389'), { desktop: 'rdp#ca.example:3389', sha256: A, authority: false })
    svc.checkCertificate(direct(svc, 'ca.example').s, A, false, 'CERT_HAS_EXPIRED')
    // One the user trusted, and one remembered before the two were told apart, connect on their fingerprint.
    svc.checkCertificate(direct(svc, 'mine.example').s, A, false, 'CERT_HAS_EXPIRED')
    svc.checkCertificate(direct(svc, 'old.example').s, A, false, 'DEPTH_ZERO_SELF_SIGNED_CERT')
    assert.deepEqual(entry('rdp#old.example:3389'), { desktop: 'rdp#old.example:3389', sha256: A })
    // A gateway's certificate is held the same way.
    const through = session(specOf({ host: 'pc', gateway: 'gw.example' }), 'rdp#pc:3389')
    svc.checkGatewayCertificate(through, { host: 'gw.example', port: 443 }, A, true, '')
    assert.throws(() => svc.checkGatewayCertificate(through, { host: 'gw.example', port: 443 }, A, false, 'CERT_HAS_EXPIRED'), /the gateway's certificate SHA-256 \S+ can't be verified \(CERT_HAS_EXPIRED\)/)
    assert.deepEqual(through.certificateProblem?.expected, '')
    assert.ok(through.log.some((l: string) => l === `gateway certificate: SHA-256 ${A}, as remembered, but no longer valid for gw.example: CERT_HAS_EXPIRED`), through.log.join('\n'))
})

test('a desktop behind an SSH host is still trusted on first use, whatever an authority would say', () => {
    const { svc, store } = service()
    const key = 'alice@h:22#10.0.0.5:3389'
    svc.checkCertificate(session(specOf({ host: '10.0.0.5' }), key), A, false, '')
    assert.deepEqual(store.trustedCertificates, [{ desktop: key, sha256: A }])
    assert.throws(() => svc.checkCertificate(session(specOf({ host: '10.0.0.5' }), key), B, true, ''), /is not the one remembered/)
})

test('trusting a certificate never allows signing in without NLA, nor takes back what was allowed before the first one was seen', async () => {
    const { svc, store } = service()
    // The stop at a server without NLA comes before TLS, so before its certificate: allowed there first, for the
    // attempt that follows (see holdWithoutNla)...
    const nla = direct(svc, 'plain.example')
    const s = session(nla.spec, nla.key, 'Send the password anyway', 'Trust the certificate')
    svc.sessions.set(nla.pane, s)
    assert.equal(stop(svc, s), 'asks')
    assert.equal(await svc.refusedWithoutNla(nla.pane, nla.target, nla.spec, s), true)
    // ...then, on that attempt, its first certificate, trusted: that answer stays (it was given for this server, before
    // any certificate showed), and is kept with this certificate.
    assert.equal(stop(svc, s), 'goes on')
    assert.throws(() => svc.checkCertificate(s, B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT'))
    assert.equal(await svc.refusedCertificate(nla.pane, nla.target, nla.spec, s, { port: 3389 }, s.certificateProblem), true)
    assert.equal(stop(svc, s), 'goes on')
    svc.checkCertificate(s, B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT')
    svc.holdWithoutNla(s, B)
    assert.equal(stop(svc, direct(svc, 'plain.example').s), 'goes on')
    // A desktop never allowed: trusting its certificate, the first or a new one, allows nothing.
    for (const answer of ['Trust the certificate', 'Trust the new certificate']) {
        const other = direct(svc, 'other.example', answer)
        assert.throws(() => svc.checkCertificate(other.s, answer === 'Trust the certificate' ? B : C, false, 'DEPTH_ZERO_SELF_SIGNED_CERT'))
        assert.equal(await ask(svc, other), true)
        assert.equal(stop(svc, direct(svc, 'other.example').s), 'asks')
    }
    assert.deepEqual(store.withoutNla, [{ desktop: 'rdp#plain.example:3389', sha256: B }])
})

test('a gateway\'s certificate: one remembered before is still replaced by one an authority vouches for; one the user trusted is not', () => {
    const { svc, store } = service({ trustedCertificates: [{ desktop: 'gateway#old.example:443', sha256: A }, { desktop: 'gateway#mine.example:443', sha256: A, authority: false }] })
    const s = session(specOf({ host: 'pc', gateway: 'old.example' }), 'rdp#pc:3389')
    svc.checkGatewayCertificate(s, { host: 'old.example', port: 443 }, B, true, '')
    assert.deepEqual(store.trustedCertificates.find((e: any) => e.desktop === 'gateway#old.example:443'), { desktop: 'gateway#old.example:443', sha256: B, authority: true })
    assert.throws(() => svc.checkGatewayCertificate(s, { host: 'mine.example', port: 443 }, B, true, ''), /the gateway's certificate SHA-256 \S+ is not the one remembered/)
})

// The gateway's certificate as the service decides on it, in front of a stand-in gateway (TLS, then whatever comes):
// nothing of the sign-in goes to a gateway before its certificate is decided on.
const gatewayAuthority = authority()
const gatewayIssued = gatewayAuthority?.issue(['127.0.0.1'])
const gatewaySelfSigned = selfSigned('gateway.test')

/** A stand-in gateway: TLS with `certificate`, keeping what comes after the handshake. */
async function standInGateway (certificate: { key: Buffer, cert: Buffer }) {
    const got: Buffer[] = []
    const sockets = new Set<net.Socket>()
    const server = tls.createServer({ key: certificate.key, cert: certificate.cert }, socket => {
        sockets.add(socket)
        socket.on('error', () => { })
        socket.on('data', (d: Buffer) => got.push(d))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    return { port, got: () => Buffer.concat(got).toString('latin1'), close: () => { server.close(); sockets.forEach(s => s.destroy()) } }
}

test('a gateway\'s certificate is decided on before any of the sign-in goes to the gateway', { skip: !gatewayAuthority || !gatewayIssued || !gatewaySelfSigned }, async t => {
    const { openThroughGateway } = require('../../dist/gateway.js')
    const { svc, store } = service()
    const through = (gateway: { host: string, port: number }, s: any, options: Record<string, unknown> = {}) => openThroughGateway(
        () => new Promise<net.Socket>(resolve => { const socket = net.connect(gateway.port, '127.0.0.1', () => resolve(socket)) }), gateway,
        { username: 'alice', password: 'Secret1' }, { host: 'pc.corp', port: 3389 },
        (fingerprint: string, valid: boolean, reason: string) => svc.checkGatewayCertificate(s, gateway, fingerprint, valid, reason), { timeoutMs: 300, ...options })
    const self = await standInGateway(gatewaySelfSigned!)
    const issued = await standInGateway(gatewayIssued!)
    t.after(() => { self.close(); issued.close() })
    const spec = specOf({ host: 'pc.corp', name: 'PC', gateway: '127.0.0.1' })
    const target = { key: 'rdp', label: 'PC', direct: spec }
    const pane = {}
    // Self-signed and never seen: refused at the check; the gateway got nothing after TLS, not even the sign-in's first message.
    const s = session(spec, 'rdp#pc.corp:3389', 'Trust the certificate')
    svc.sessions.set(pane, s)
    const gateway = { host: '127.0.0.1', port: self.port }
    await assert.rejects(through(gateway, s), /hasn't been seen before/)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(self.got(), '')
    assert.equal(s.certificateProblem.reason, 'DEPTH_ZERO_SELF_SIGNED_CERT')
    // Trusted: the next attempt goes on to the sign-in (NTLM's first message reaches the gateway, which doesn't answer here).
    assert.equal(await svc.refusedCertificate(pane, target, spec, s, { port: 3389 }, s.certificateProblem), true)
    await assert.rejects(through(gateway, s), /didn't answer in time/)
    assert.match(self.got(), /^RDG_OUT_DATA [^\r]*\r\n(.*\r\n)*Authorization: NTLM /)
    // Changed since: stopped again before the sign-in.
    store.trustedCertificates = [{ desktop: `gateway#127.0.0.1:${self.port}`, sha256: A, authority: false }]
    const before = self.got().length
    await assert.rejects(through(gateway, s), /is not the one remembered/)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(self.got().length, before)
    // One this computer's certificate authorities vouch for (here the test's own): no question, remembered as theirs.
    const valid = { host: '127.0.0.1', port: issued.port }
    const fresh = session(spec, 'rdp#pc.corp:3389')
    await assert.rejects(through(valid, fresh, { tls: { ca: gatewayAuthority!.ca } }), /didn't answer in time/)
    assert.equal(fresh.certificateProblem, null)
    assert.match(issued.got(), /Authorization: NTLM /)
    assert.equal(store.trustedCertificates.find((e: any) => e.desktop === `gateway#127.0.0.1:${issued.port}`)?.authority, true)
})

/** A session with the real keys (DesktopSession's authKey and credentialKey), its layer stood in for as session()'s. */
function keyed (spec: any, key: string): any {
    const { authKey: _, ...layer } = session(spec, key)
    return Object.assign(Object.create(DesktopSession.prototype), layer)
}

test('a saved desktop password is kept for the way it goes: through that gateway, in any spelling of it, or through none', async () => {
    keychain.clear()
    const { svc } = service({ accounts: [{ id: 'k1', name: 'Admin', username: 'admin', domain: 'CORP' }] })
    const at = (gateway?: string, more: Record<string, string> = {}) => keyed(specOf({ host: 'pc.corp', name: 'PC', ...gateway ? { gateway } : {}, ...more }), 'rdp#pc.corp:3389')
    assert.equal(at().credentialKey, 'rdp#pc.corp:3389')
    assert.equal(at('gw-a.example').credentialKey, 'rdp#pc.corp:3389@gateway#gw-a.example:443')
    assert.equal(at('GW-A.Example.').credentialKey, at('gw-a.example:443').credentialKey)
    // A gateway with an account of its own: the desktop's password still goes through that gateway's tunnel, and is kept for it.
    assert.equal(at('gw-a.example', { gatewayAccount: 'k1' }).credentialKey, at('gw-a.example').credentialKey)
    // What a connection signs in with (the sign-in form, where it comes to that, is cancelled): saved through A, used through A only.
    signin.askCredentials = async () => null
    const signIn = async (s: any) => {
        const pane = {}
        svc.sessions.set(pane, s)
        return (await svc.endpointFor(pane, { key: 'rdp', label: 'PC', direct: s.spec }, s.spec, s, false))?.credentials ?? null
    }
    await signin.saveCredentials(at('gw-a.example').credentialKey, { username: 'alice', password: 'for-a' })
    assert.deepEqual(await signIn(at('gw-a.example')), { username: 'alice', password: 'for-a' })
    assert.deepEqual(await signIn(at('GW-A.example.')), { username: 'alice', password: 'for-a' })
    assert.deepEqual(await signIn(at('gw-a.example', { gatewayAccount: 'k1' })), { username: 'alice', password: 'for-a' })
    assert.equal(await signIn(at('gw-b.example')), null, 'another gateway: asked')
    assert.equal(await signIn(at()), null, 'no gateway: asked')
    // A saved account is one password for every desktop that names it, wherever each goes: its own entry.
    await signin.saveCredentials('account#k1', { username: 'CORP\\admin', password: 'shared' })
    assert.deepEqual(await signIn(at('gw-b.example', { account: 'k1' })), { username: 'CORP\\admin', password: 'shared' })
    // An imported profile's account (null): none, whatever the defaults; its own saved password for that way there, or the form.
    assert.equal(specOf({ host: 'pc.corp', account: null }).account, undefined)
})

test('editing a desktop: its saved password goes with its way there, and only its own', async () => {
    keychain.clear()
    // The desktop behind host h has its certificate remembered, which a moved password goes along with.
    const { svc } = service({ trustedCertificates: [{ desktop: 'alice@h:22#10.0.0.7:3389', sha256: A }] })
    const saved = () => [...keychain.keys()].sort()
    const gw = '@gateway#rdgw.example.com:443'
    const old = { username: 'olduser', password: 'old-secret' }
    // A profile through a gateway, next to a direct profile at the same address with a password of its own.
    await signin.saveCredentials(`rdp#10.0.0.5:3389${gw}`, old)
    await signin.saveCredentials('rdp#10.0.0.5:3389', { username: 'direct', password: 'its-own' })
    // A new user name (or domain, or account): the gateway profile's saved password is forgotten; the other's stays.
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.5:3389', true, true, { from: 'rdgw.example.com', to: 'rdgw.example.com' })
    assert.deepEqual(saved(), ['rdp#10.0.0.5:3389'])
    // A new address: taken along, through the same gateway (another spelling of it is the same), and only that one.
    await signin.saveCredentials(`rdp#10.0.0.5:3389${gw}`, old)
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.6:3389', false, true, { from: 'rdgw.example.com', to: 'RDGW.example.com.' })
    assert.deepEqual(saved(), ['rdp#10.0.0.5:3389', `rdp#10.0.0.6:3389${gw}`])
    // Another gateway, or none: asked for again; what was saved for the old one is forgotten.
    await svc.desktopEdited('10.0.0.6:3389', '10.0.0.6:3389', false, true, { from: 'rdgw.example.com', to: 'other.example.com' })
    assert.deepEqual(saved(), ['rdp#10.0.0.5:3389'])
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.5:3389', false, true, { from: '', to: 'rdgw.example.com' })
    assert.deepEqual(saved(), [])
    // Behind an SSH host, the same, for the desktop's own way there.
    await signin.saveCredentials(`alice@h:22#10.0.0.7:3389${gw}`, old)
    await signin.saveCredentials('alice@h:22#10.0.0.7:3389', old)
    await svc.desktopEdited('10.0.0.7:3389', '10.0.0.8:3389', false, false, { from: 'rdgw.example.com', to: 'rdgw.example.com' })
    assert.deepEqual(saved(), ['alice@h:22#10.0.0.7:3389', `alice@h:22#10.0.0.8:3389${gw}`])
    await svc.desktopEdited('10.0.0.8:3389', '10.0.0.8:3389', true, false, { from: 'rdgw.example.com', to: 'rdgw.example.com' })
    assert.deepEqual(saved(), ['alice@h:22#10.0.0.7:3389'])
})

test('a direct profile\'s removal, or its move behind an SSH profile, forgets its saved passwords through any gateway', async () => {
    keychain.clear()
    const { RDPProfileSettingsComponent, RDPProfilesService } = require('../../dist/rdpProfile.js')
    const { svc, store } = service({ trustedCertificates: [{ desktop: 'rdp#10.0.0.5:3389', sha256: A }, { desktop: 'gateway#gw.example:443', sha256: B }] })
    const injector = { get: () => svc }
    const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 5)) }
    const keys = ['rdp#10.0.0.5:3389', 'rdp#10.0.0.5:3389@gateway#gw.example:443', 'rdp#10.0.0.5:3389@gateway#before.example:443', 'rdp#10.0.0.50:3389', 'alice@h:22#10.0.0.5:3389']
    for (const key of keys) {
        await signin.saveCredentials(key, { username: 'u', password: 'p' })
    }
    // Removed: what it saved under its gateway now, under one it had before, and without one; not another desktop's.
    new RDPProfilesService(injector, { save () { } }).deleteProfile({ options: { host: '10.0.0.5', port: 3389, via: '', gateway: 'gw.example' } })
    await settle()
    assert.deepEqual([...keychain.keys()].sort(), ['alice@h:22#10.0.0.5:3389', 'rdp#10.0.0.50:3389'])
    assert.deepEqual(store.trustedCertificates, [{ desktop: 'gateway#gw.example:443', sha256: B }], 'its certificate too, not its gateway\'s')
    // Its editor: moved behind an SSH profile, it is another desktop, and its own passwords go.
    for (const key of keys.slice(0, 3)) {
        await signin.saveCredentials(key, { username: 'u', password: 'p' })
    }
    const settings = new RDPProfileSettingsComponent({ nativeElement: null }, injector)
    settings.profile = { options: { host: '10.0.0.5', port: 3389, username: 'u', domain: '', account: '', via: 'ssh:jump', gateway: 'gw.example' } }
    settings.before = { id: '10.0.0.5:3389', account: 'u\n\n', via: '', gateway: 'gw.example' }
    settings.save()
    await settle()
    assert.deepEqual([...keychain.keys()].sort(), ['alice@h:22#10.0.0.5:3389', 'rdp#10.0.0.50:3389'])
    // Its gateway changed in the editor: what was saved for the old one is forgotten.
    await signin.saveCredentials('rdp#10.0.0.50:3389@gateway#gw.example:443', { username: 'u', password: 'p' })
    settings.profile = { options: { host: '10.0.0.50', port: 3389, username: 'u', domain: '', account: '', via: '', gateway: 'gw2.example' } }
    settings.before = { id: '10.0.0.50:3389', account: 'u\n\n', via: '', gateway: 'gw.example' }
    settings.save()
    await settle()
    assert.deepEqual([...keychain.keys()].sort(), ['alice@h:22#10.0.0.5:3389', 'rdp#10.0.0.50:3389'])
})

test('profiles imported before imports had an account of their own ask now; profiles made otherwise keep what their group gives them', () => {
    // As 0.5.0 and 0.3.0 imported them (the desktop icon, a domain, an empty via, nothing the import didn't set).
    const imported05 = { type: 'rdp', name: 'office', icon: 'fas fa-desktop', group: 'g1', options: { host: 'pc.example', port: 3389, kind: 'windows', username: 'alice', domain: '', via: '', gateway: 'gw.example', gatewayAccount: '' } }
    const imported03 = { type: 'rdp', name: 'old', icon: 'fas fa-desktop', options: { host: 'pc2.example', port: 3389, kind: 'windows', username: '', domain: 'CORP', via: '' } }
    // Saved in Tabby's profile editor (options equal to their defaults dropped), written by hand as the README shows, given
    // an account, or given its own clipboard: left as they are.
    const edited = { type: 'rdp', name: 'edited', icon: 'fas fa-desktop', group: 'g1', options: { host: 'pc3.example', username: 'bob' } }
    const readme = { type: 'rdp', name: 'Office PC', options: { host: '192.168.1.20', port: 3389, kind: 'windows', username: 'alice', via: '', gateway: '', gatewayAccount: '' } }
    const chosen = { ...imported05, options: { ...imported05.options, account: 'k1' } }
    const clipboard = { ...imported05, options: { ...imported05.options, clipboard: 'off' } }
    const ssh = { type: 'ssh', name: 'ssh', icon: 'fas fa-desktop', options: { host: 'h', domain: '', via: '' } }
    const { svc, config } = service({}, { profiles: [imported05, imported03, edited, readme, chosen, clipboard, ssh] })
    svc.migrateConfig()
    // No account, gateway account or kind from the defaults either: none of them (a default kind of xrdp would sign in
    // without NLA, unasked), and Windows.
    for (const p of [imported05, imported03]) {
        assert.deepEqual([(p.options as any).account, (p.options as any).gatewayAccount, (p.options as any).kind], [null, null, null], p.name)
    }
    for (const p of [edited, readme, clipboard, ssh]) {
        assert.ok(!('account' in p.options), p.name)
    }
    assert.deepEqual([readme.options.gatewayAccount, readme.options.kind, clipboard.options.gatewayAccount, clipboard.options.kind], ['', 'windows', '', 'windows'])
    assert.equal(chosen.options.account, 'k1')
    assert.equal(config.saves, 1)
    // Once is all it takes.
    svc.migrateConfig()
    assert.equal(config.saves, 1)
    // One that arrives later, by config sync from a computer with an older version, the same once the config changes.
    const synced = { type: 'rdp', name: 'synced', icon: 'fas fa-desktop', options: { host: 'pc4.example', port: 3389, kind: 'windows', username: '', domain: '', via: '' } }
    config.store.profiles.push(synced as any)
    config.changed()
    assert.equal((synced.options as any).account, null)
    assert.equal(config.saves, 2)
})

test('gateway certificates remembered under another spelling than the gateway\'s one form are dropped, not moved', () => {
    const { svc, store, config } = service({
        trustedCertificates: [
            { desktop: 'gateway#RDGW.Example.com:443', sha256: A },
            { desktop: 'gateway#rdgw.example.com.:443', sha256: A },
            { desktop: 'gateway#rdgw.example.com:443', sha256: B },
            { desktop: 'gateway#0:0::1:443', sha256: A },
            { desktop: 'gateway#::1:443', sha256: B },
            { desktop: 'gateway#gw..example:443', sha256: A },
            { desktop: 'rdp#RDGW.Example.com:3389', sha256: A },
            { desktop: 'alice@h:22#10.0.0.5:3389', sha256: A },
        ],
    })
    svc.migrateConfig()
    assert.deepEqual(store.trustedCertificates.map((e: any) => e.desktop),
        ['gateway#rdgw.example.com:443', 'gateway#::1:443', 'rdp#RDGW.Example.com:3389', 'alice@h:22#10.0.0.5:3389'])
    assert.equal(config.saves, 1)
})

test('the certificate question says what the certificate says of itself, under its fingerprint, as the log does, and that nothing checked it', async () => {
    const { svc } = service({
        trustedCertificates: [
            { desktop: 'rdp#changed.example:3389', sha256: A, authority: false }, { desktop: 'alice@h:22#10.0.0.5:3389', sha256: A },
            { desktop: 'rdp#renewed.example:3389', sha256: A, authority: false },
        ],
    })
    // The server's word: a name that would show in another order, and more names than a line takes.
    const details = {
        subject: 'pc.corp\u202efdp.exe', names: ['pc.corp', '10.0.0.5', ...Array.from({ length: 20 }, (_, i) => `n${i}.corp`)],
        issuer: 'Corp Issuing CA (Corp)', validFrom: 'Oct  4 12:00:00 2026 GMT', validTo: 'Oct  4 12:00:00 2027 GMT',
    }
    const what = 'pc.corp\ufffdfdp.exe (pc.corp, 10.0.0.5, n0.corp, n1.corp, n2.corp, n3.corp, n4.corp, n5.corp, and 14 more) ' +
        'by Corp Issuing CA (Corp), valid 2026-10-04 12:00 UTC to 2027-10-04 12:00 UTC'
    const line = `Issued to ${what}.`
    // Where no authority vouched for it, the question marks all of it as the certificate's own word: anyone can make
    // one that names the organisation's own issuer.
    const unchecked = `It says it was issued to ${what}: its own word, which nothing here has checked; a certificate anyone made can say the same.`
    // A first use, connected to directly: under its fingerprint, and in the desktop's log.
    const first = direct(svc, 'pc.corp', 'Cancel')
    assert.throws(() => svc.checkCertificate(first.s, B, false, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', details))
    assert.equal(await ask(svc, first), false)
    assert.ok(first.s.shown[0].includes(`SHA-256:\n${B.slice(0, 47)}\n${B.slice(48)}\n${unchecked}\n\n`), first.s.shown[0])
    assert.ok(first.s.log.includes(`certificate: ${unchecked}`), first.s.log.join('\n'))
    // An intermediate the server leaves out is no likelier than an issuer named by a certificate it never signed.
    assert.match(first.s.shown[0], /vouches for it from what the server sent \(a server can leave out an intermediate certificate, which Tabby doesn't fetch, but any server can name any issuer\)/)
    assert.doesNotMatch(first.s.shown[0], /, or the server leaves out the intermediate certificate that leads to one/)
    // A changed one: under the new fingerprint.
    const changed = direct(svc, 'changed.example', 'Cancel')
    assert.throws(() => svc.checkCertificate(changed.s, B, false, 'DEPTH_ZERO_SELF_SIGNED_CERT', details), /is not the one remembered/)
    assert.equal(await ask(svc, changed), false)
    assert.ok(changed.s.shown[0].includes(`Now:\n${B.slice(0, 47)}\n${B.slice(48)}\n${unchecked}\n\n`), changed.s.shown[0])
    // Behind a host, changed: nothing checked it there either (trusted on first use).
    const behind = session(specOf({ host: '10.0.0.5', name: 'VM' }), 'alice@h:22#10.0.0.5:3389', 'Cancel')
    const pane = {}
    svc.sessions.set(pane, behind)
    assert.throws(() => svc.checkCertificate(behind, B, false, '', details), /is not the one remembered/)
    assert.equal(await svc.refusedCertificate(pane, { key: 'alice@h:22', label: 'h' }, behind.spec, behind, { port: 3389 }, behind.certificateProblem), false)
    assert.ok(behind.shown[0].includes(`\n${unchecked}\n\n`), behind.shown[0])
    // A gateway's: the same, in its own log line.
    const viaGateway = direct(svc, 'pc.corp', 'Cancel', 'gw.example')
    assert.throws(() => svc.checkGatewayCertificate(viaGateway.s, { host: 'gw.example', port: 443 }, B, false, 'ERR_TLS_CERT_ALTNAME_INVALID', details))
    assert.equal(await ask(svc, viaGateway), false)
    assert.ok(viaGateway.s.shown[0].includes(`\n${unchecked}\n\n`), viaGateway.s.shown[0])
    assert.ok(viaGateway.s.log.includes(`gateway certificate: ${unchecked}`))
    // One an authority vouches for in place of one the user trusted: asked about all the same, and what it says of
    // itself is the authority's word too, shown as it is.
    const renewed = direct(svc, 'renewed.example', 'Cancel')
    assert.throws(() => svc.checkCertificate(renewed.s, B, true, '', details), /is not the one remembered/)
    assert.equal(await ask(svc, renewed), false)
    assert.ok(renewed.s.shown[0].includes(`Now:\n${B.slice(0, 47)}\n${B.slice(48)}\n${line}\n\n`), renewed.s.shown[0])
    assert.doesNotMatch(renewed.s.shown[0], /nothing here has checked/)
    // One an authority vouches for connects, its issuer in the log (an authority one wouldn't expect shows there).
    const valid = direct(svc, 'valid.example')
    svc.checkCertificate(valid.s, C, true, '', { ...details, subject: 'valid.example', names: ['valid.example'] })
    assert.ok(valid.s.log.some(l => /^certificate: Issued to valid\.example \(valid\.example\) by Corp Issuing CA \(Corp\)/.test(l)), valid.s.log.join('\n'))
})

test('why a certificate can\'t be verified starts from where its chain stands, which the TLS library\'s last code can hide', async () => {
    const { svc } = service()
    // A certificate marked for the Remote Desktop use only, as an organisation's template makes them, and as anyone can
    // make one: the library reports that (INVALID_PURPOSE) whoever issued it. Valid from yesterday for a year, unless
    // said otherwise.
    const day = 24 * 60 * 60 * 1000
    const details = (chain?: string, more: Record<string, unknown> = {}) => ({
        subject: 'pc17.corp.example', names: ['pc17.corp.example'], issuer: 'Corp Issuing CA 02 (Corp)', extendedKeyUsage: ['1.3.6.1.4.1.311.54.1.2'],
        validFrom: new Date(Date.now() - day).toUTCString(), validTo: new Date(Date.now() + 365 * day).toUTCString(), ...chain ? { chain } : {}, ...more,
    })
    const question = async (reason: string, chain?: string, gateway?: string, more?: Record<string, unknown>) => {
        const d = direct(svc, 'pc17.corp.example', 'Cancel', gateway)
        assert.throws(() => gateway
            ? svc.checkGatewayCertificate(d.s, { host: gateway, port: 443 }, B, false, reason, details(chain, more))
            : svc.checkCertificate(d.s, B, false, reason, details(chain, more)))
        assert.equal(await ask(svc, d), false)
        return d.s.shown[0]
    }
    const untrusted = /can't verify: it isn't from a certificate authority (this computer trusts|Tabby checks against)/
    const marked = /It says it was issued to pc17\.corp\.example \(pc17\.corp\.example\) by Corp Issuing CA 02 \(Corp\), [^\n]*: its own word, which nothing here has checked/
    // A made-up authority the server sends along: not one this computer trusts, whatever the code says, and no word of
    // organisations' certificates.
    for (const gateway of [undefined, 'gw.example']) {
        const made = await question('INVALID_PURPOSE', 'unknown authority', gateway)
        assert.match(made, untrusted, gateway)
        assert.match(made, /, and it is marked for other uses than a server's \(its extended key usage\)\./, gateway)
        assert.doesNotMatch(made, /as some organisations'/, gateway)
        assert.match(made, marked, gateway)
    }
    // An issuer named, its certificate not sent (or never the one that signed): the same, in its own words.
    const named = await question('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'incomplete', 'gw.example')
    assert.match(named, /no certificate authority (this computer trusts|Tabby checks against) [^.]*vouches for it from what the server sent \([^)]*any server can name any issuer\)/)
    assert.match(named, marked)
    // Self-signed and expired: self-signed first, the dates by the certificate's own, whatever the code.
    const expired = { validFrom: new Date(Date.now() - 3 * day).toUTCString(), validTo: new Date(Date.now() - day).toUTCString() }
    assert.match(await question('CERT_HAS_EXPIRED', 'self-signed', undefined, { extendedKeyUsage: undefined, ...expired }),
        /can't verify: it is self-signed \([^)]*\), so no certificate authority vouches for it, and it has expired\./)
    assert.match(await question('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'self-signed', undefined, { extendedKeyUsage: undefined, ...expired }),
        /can't verify: it is self-signed \([^)]*\), so no certificate authority vouches for it, and it has expired\./)
    // Its chain leads to an authority this computer trusts: an organisation's Remote Desktop certificate, said so, and
    // what it says of itself is that authority's word.
    const organisation = await question('INVALID_PURPOSE', 'authority', undefined, { forName: true })
    assert.match(organisation, /can't verify: it is marked for other uses than a server's \(its extended key usage\), as some organisations' Remote Desktop certificates are\./)
    assert.match(organisation, /\nIssued to pc17\.corp\.example \(pc17\.corp\.example\) by Corp Issuing CA 02 \(Corp\), valid [^\n]*UTC\.\n/)
    assert.doesNotMatch(organisation, /nothing here has checked/)
    // The same, for another name: another machine's, which its names show; no word of organisations.
    const another = await question('INVALID_PURPOSE', 'authority', 'gw.example', { forName: false })
    assert.match(another, /can't verify: it was issued for another name than gw\.example, and it is marked for other uses than a server's \(its extended key usage\)\./)
    assert.match(another, /\nIssued to pc17\.corp\.example \(pc17\.corp\.example\) by Corp Issuing CA 02 \(Corp\), valid /)
    // Where nothing says (no chain checked): the code may hide the rest, and that is said.
    const unknown = await question('INVALID_PURPOSE')
    assert.doesNotMatch(unknown, /as some organisations'/)
    assert.match(unknown, /its extended key usage\); it may also be self-signed, or not from a certificate authority this computer trusts/)
    assert.match(unknown, marked)
})

// Certificates as the proxy and the gateway read them, for the question: Windows' own RDP certificate, and another
// machine's from the authority this computer trusts (the tests' own).
const questionAuthority = authority()
const windowsOwn = selfSigned('PC17', 'keyUsage=critical,keyEncipherment,dataEncipherment', 'extendedKeyUsage=serverAuth')
const anotherMachines = questionAuthority?.issue(['attacker-box.corp.example'], { extendedKeyUsage: '1.3.6.1.4.1.311.54.1.2' })

test('the certificate question, from what the proxy reads of a certificate: Windows\' own is self-signed; another machine\'s names it', { skip: !windowsOwn || !anotherMachines }, async () => {
    const { certificateDetails } = require('../../dist/authorities.js')
    /** The certificate as a connection to pc17.corp.example reads it, checked as the proxy checks one that isn't valid. */
    const read = async (certificate: { key: Buffer, cert: Buffer }) => {
        const server = tls.createServer({ key: certificate.key, cert: certificate.cert }, socket => socket.on('error', () => { }))
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        try {
            const socket = tls.connect({ socket: net.connect((server.address() as net.AddressInfo).port, '127.0.0.1'), host: 'pc17.corp.example', servername: 'pc17.corp.example',
                rejectUnauthorized: false, ca: questionAuthority!.ca })
            await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject) })
            assert.equal(socket.authorized, false)
            const reason = String(socket.authorizationError)
            const read = { reason, details: certificateDetails(socket.getPeerCertificate(true), { name: 'pc17.corp.example', authorities: questionAuthority!.ca, reason }) }
            socket.destroy()
            return read
        } finally {
            server.close()
        }
    }
    const { svc } = service()
    const asked = async (certificate: { key: Buffer, cert: Buffer }) => {
        const { reason, details } = await read(certificate)
        const d = direct(svc, 'pc17.corp.example', 'Cancel')
        assert.throws(() => svc.checkCertificate(d.s, B, false, reason, details))
        assert.equal(await ask(svc, d), false)
        return d.s.shown[0]
    }
    const windows = await asked(windowsOwn!)
    assert.match(windows, /^PC \(pc17\.corp\.example:3389\) has a certificate this computer can't verify: it is self-signed \(made by the server itself, as RDP servers make theirs unless given one\), so no certificate authority vouches for it, and it was issued for another name than pc17\.corp\.example\. /)
    assert.match(windows, /\nIt says it was issued to PC17 by PC17, valid [^\n]*: its own word, which nothing here has checked/)
    const another = await asked(anotherMachines!)
    assert.match(another, /^PC \(pc17\.corp\.example:3389\) has a certificate this computer can't verify: it was issued for another name than pc17\.corp\.example, and it is marked for other uses than a server's \(its extended key usage\)\. /)
    assert.doesNotMatch(another, /organisations/)
    assert.match(another, /\nIssued to attacker-box\.corp\.example \(attacker-box\.corp\.example\) by tabby-rdp test authority, valid [^\n]*UTC\.\n/)
})

test('the certificate question of a server without NLA says that the password itself would go, a changed one\'s too', async () => {
    const { svc } = service({ trustedCertificates: [{ desktop: 'rdp#build.example:3389', sha256: A, authority: false }] })
    // An xrdp desktop of the user's, which signs in that way unasked: met for the first time, then with a changed certificate.
    for (const [host, fingerprint] of [['fresh.example', B], ['build.example', B]]) {
        const spec = specOf({ host, name: 'Build', kind: 'xrdp' })
        const key = `rdp#${spec.id}`
        const s = session(spec, key, 'Cancel')
        const pane = {}
        svc.sessions.set(pane, s)
        assert.equal(stop(svc, s), 'goes on')
        assert.throws(() => svc.checkCertificate(s, fingerprint, false, 'DEPTH_ZERO_SELF_SIGNED_CERT'))
        assert.equal(await svc.refusedCertificate(pane, { key: 'rdp', label: 'Build', direct: spec }, spec, s, { port: 3389 }, s.certificateProblem), false)
        assert.match(s.shown[0], /This server doesn't use Network Level Authentication: signing in sends it your password itself, readable to a server posing as Build\./, host)
        assert.doesNotMatch(s.shown[0], /proof of your password/, host)
    }
})

test('a new address doesn\'t take a saved password to a desktop known there, which would sign in with it unasked', async () => {
    // Behind hosts: host B has a password at .9, and at .10 only the certificate of its own desktop there. Host A's .9
    // is edited to .10 (an edit applies to that address behind every host, see desktopEdited).
    keychain.clear()
    const behind = service({ trustedCertificates: [{ desktop: 'bob@hostb:22#10.0.0.10:3389', sha256: B }] })
    await signin.saveCredentials('bob@hostb:22#10.0.0.9:3389', { username: 'b9admin', password: 'secret-of-b9' })
    await behind.svc.desktopEdited('10.0.0.9:3389', '10.0.0.10:3389', false, false, {})
    // B's desktop at .10 checks out with its own certificate: it would get b9admin's password without a question.
    assert.equal(await signin.loadCredentials('bob@hostb:22#10.0.0.10:3389'), null)
    assert.deepEqual(behind.store.trustedCertificates, [{ desktop: 'bob@hostb:22#10.0.0.10:3389', sha256: B }])
    // Direct: .9 has a password and certificate A; .10 only certificate B, another profile's machine.
    keychain.clear()
    const { svc, store } = service({ trustedCertificates: [{ desktop: 'rdp#10.0.0.9:3389', sha256: A, authority: false }, { desktop: 'rdp#10.0.0.10:3389', sha256: B, authority: false }] })
    await signin.saveCredentials('rdp#10.0.0.9:3389', { username: 'admin9', password: 'secret-of-9' })
    await svc.desktopEdited('10.0.0.9:3389', '10.0.0.10:3389', false, true, {})
    assert.equal(await signin.loadCredentials('rdp#10.0.0.10:3389'), null)
    assert.equal(await signin.loadCredentials('rdp#10.0.0.9:3389'), null)
    assert.deepEqual(store.trustedCertificates, [{ desktop: 'rdp#10.0.0.9:3389', sha256: A, authority: false }, { desktop: 'rdp#10.0.0.10:3389', sha256: B, authority: false }])
    // Where nothing is known at the new address, it moves along, as before.
    await signin.saveCredentials('rdp#10.0.0.11:3389', { username: 'admin11', password: 'secret-of-11' })
    await svc.desktopEdited('10.0.0.11:3389', '10.0.0.12:3389', false, true, {})
    assert.deepEqual(await signin.loadCredentials('rdp#10.0.0.12:3389'), { username: 'admin11', password: 'secret-of-11' })
})

test('passwords 0.5.0 saved for a desktop reached through a gateway are forgotten once, before any password is used', async () => {
    // Whatever an earlier test left to be done first is done now.
    await signin.loadCredentials('nothing')
    keychain.clear()
    // 0.5.0 kept a desktop's password under its key alone, through a gateway or not.
    const old = { username: 'admin', password: 'for-the-gateway-profile' }
    await signin.saveCredentials('rdp#pc17.corp.example:3389', old)
    await signin.saveCredentials('alice@h:22#10.0.0.7:3389', old)
    await signin.saveCredentials('alice@h:22#10.0.0.8:3389', { username: 'other', password: 'no-gateway-there' })
    await signin.saveCredentials('rdp#pc17.corp.example:3389@gateway#rdgw.example.com:443', { username: 'admin', password: 'saved-since' })
    // A direct profile reaching pc17 through a gateway (its group's), and a desktop behind a host through one.
    const profiles = [{ type: 'rdp', name: 'PC17', group: 'g1', options: { host: 'pc17.corp.example', port: 3389, via: '' } }]
    const { svc, store, config } = service({ desktops: [{ via: 'h', host: '10.0.0.7', gateway: 'rdgw.example.com' }] }, { profiles })
    svc.profiles = { getConfigProxyForProfile: (p: any) => ({ ...p, options: { gateway: 'RDGW.example.com', ...p.options } }) }
    svc.migrateConfig()
    // Nothing goes yet: the store isn't asked for anything at startup (a locked Vault would ask for its passphrase).
    assert.equal(keychain.has('rdp#pc17.corp.example:3389'), true)
    assert.equal(store.gatewayPasswordsMigrated, undefined)
    // A desktop at that address without the gateway (a quick connect, an .rdp file naming it) asks.
    assert.equal(await signin.loadCredentials('rdp#pc17.corp.example:3389'), null)
    assert.equal(await signin.loadCredentials('alice@h:22#10.0.0.7:3389'), null)
    // What another desktop has, and what was saved for the gateway since, stay.
    assert.deepEqual(await signin.loadCredentials('alice@h:22#10.0.0.8:3389'), { username: 'other', password: 'no-gateway-there' })
    assert.deepEqual(await signin.loadCredentials('rdp#pc17.corp.example:3389@gateway#rdgw.example.com:443'), { username: 'admin', password: 'saved-since' })
    // Done in the keychain, marked there; and in the Vault, off here, marked in the config.
    assert.equal(keychain.get(GATEWAY_PASSWORDS_MARK), 'done')
    assert.equal(store.gatewayPasswordsMigrated, true)
    assert.ok(config.saves >= 1)
    // Done once: a password saved there afterwards is found, by this Tabby and the next.
    await signin.saveCredentials('rdp#pc17.corp.example:3389', { username: 'direct', password: 'its-own' })
    svc.migrateConfig()
    const next = service({ ...store }, { profiles })
    next.svc.migrateConfig()
    assert.deepEqual(await signin.loadCredentials('rdp#pc17.corp.example:3389'), { username: 'direct', password: 'its-own' })
})

/**
 * The 0.5.0 password of pc17, which a direct profile reaches through a gateway, in a keychain cleared of what earlier
 * tests left; and that profile's service, with `remoteDesktop` as given, its migrateConfig run.
 */
async function legacyGatewayPassword (remoteDesktop: Record<string, unknown> = {}) {
    // Whatever an earlier test left to be done first is done now.
    await signin.loadCredentials('nothing')
    keychain.clear()
    await signin.saveCredentials('rdp#pc17.corp.example:3389', { username: 'admin', password: 'for-the-gateway-profile' })
    const profiles = [{ type: 'rdp', name: 'PC17', options: { host: 'pc17.corp.example', port: 3389, via: '', gateway: 'rdgw.example.com' } }]
    const made = service(remoteDesktop, { profiles })
    made.svc.profiles = { getConfigProxyForProfile: (p: any) => p }
    made.svc.migrateConfig()
    return made
}

test('a keychain that can\'t list what it holds when 0.5.0\'s gateway passwords are to go: not marked done, nothing of them used meanwhile', async () => {
    const { store } = await legacyGatewayPassword()
    const keytar = stubs.keytar as any
    const find = keytar.findCredentials
    // A locked keyring that times out, a keychain prompt dismissed.
    keytar.findCredentials = async () => { throw new Error('the keychain did not answer') }
    try {
        assert.equal(await signin.loadCredentials('rdp#pc17.corp.example:3389'), null)
        assert.equal(keychain.has('rdp#pc17.corp.example:3389'), true, 'not gone: the keychain said nothing of it')
        assert.equal(keychain.has(GATEWAY_PASSWORDS_MARK), false, 'not marked done')
    } finally {
        keytar.findCredentials = find
    }
    // The next use goes through the keychain, and marks it done.
    assert.equal(await signin.loadCredentials('rdp#pc17.corp.example:3389'), null)
    assert.equal(keychain.has('rdp#pc17.corp.example:3389'), false)
    assert.equal(keychain.get(GATEWAY_PASSWORDS_MARK), 'done')
    assert.equal(store.gatewayPasswordsMigrated, true)
})

test('0.5.0\'s gateway passwords go from each computer\'s keychain, whatever the config, which config sync brings from another, says', async () => {
    // The Vault's mark, set on the computer that updated first: this one's keychain is its own.
    await legacyGatewayPassword({ gatewayPasswordsMigrated: true })
    assert.equal(await signin.loadCredentials('rdp#pc17.corp.example:3389'), null)
    assert.equal(keychain.has('rdp#pc17.corp.example:3389'), false)
    assert.equal(keychain.get(GATEWAY_PASSWORDS_MARK), 'done')
})

test('a Vault that can\'t be read when 0.5.0\'s gateway passwords are to go: the keychain\'s part is done, and the Vault\'s isn\'t used meanwhile', async t => {
    const { store } = await legacyGatewayPassword()
    // The same password in the Vault, which can't be read (its prompt cancelled), and then can.
    const secrets = new Map([['rdp#pc17.corp.example:3389', JSON.stringify({ username: 'admin', password: 'in-the-vault' })]])
    let readable = false
    const refused = async () => { throw new Error('the passphrase prompt was cancelled') }
    signin.useVault({
        isEnabled: () => true,
        isOpen: () => false,
        load: async () => readable ? { secrets: [...secrets].map(([key, value]) => ({ type: signin.VAULT_SECRET_TYPE, key: { key }, value })) } : refused(),
        getSecret: async (_type: string, key: { key: string }) => readable ? (secrets.has(key.key) ? { value: secrets.get(key.key) } : null) : refused(),
        removeSecret: async (_type: string, key: { key: string }) => { secrets.delete(key.key) },
    })
    t.after(() => signin.useVault(null))
    assert.equal(await signin.loadCredentials('rdp#pc17.corp.example:3389'), null)
    // The keychain's part, done all the same, before the Vault's: its entry is gone, and it is marked.
    assert.equal(keychain.has('rdp#pc17.corp.example:3389'), false)
    assert.equal(keychain.get(GATEWAY_PASSWORDS_MARK), 'done')
    assert.equal(store.gatewayPasswordsMigrated, undefined)
    // The Vault opens for a sign-in (its passphrase entered this time) before the work is tried again: what the work
    // would forget there isn't used.
    readable = true
    assert.equal(await signin.loadCredentials('rdp#pc17.corp.example:3389'), null)
    assert.equal(secrets.has('rdp#pc17.corp.example:3389'), false)
    assert.equal(store.gatewayPasswordsMigrated, true)
})

test('0.5.0\'s gateway passwords: done by another Tabby window since this one asked for it, the work finds nothing to do', async () => {
    const { store } = await legacyGatewayPassword()
    // That window forgot it, marked both stores, and has saved a password under that key since, for a desktop at that
    // address reached without a gateway.
    store.gatewayPasswordsMigrated = true
    keychain.set(GATEWAY_PASSWORDS_MARK, 'done')
    keychain.set('rdp#pc17.corp.example:3389', JSON.stringify({ username: 'direct', password: 'its-own' }))
    assert.deepEqual(await signin.loadCredentials('rdp#pc17.corp.example:3389'), { username: 'direct', password: 'its-own' })
})

test('a host whose user name has a `#`: its desktops\' 0.5.0 passwords are forgotten rather than moved, and none comes back', async () => {
    const { RemoteTargets } = require('../../dist/targets.js')
    await signin.loadCredentials('nothing')
    keychain.clear()
    // 0.5.0's keys for that host's desktops: they split at the user's `#`, and read as no desktop's.
    await signin.saveCredentials('alice#ops@h:22#10.0.0.5:3389', { username: 'alice', password: 'for-the-gateway' })
    await signin.saveCredentials('alice#ops@h:22#10.0.0.6:3389', { username: 'alice', password: 'before-the-edit' })
    // Its own desktop's (a Windows host's), and one through a gateway.
    await signin.saveCredentials('alice#ops@h:22', { username: 'alice', password: 'its-own' })
    await signin.saveCredentials('alice#ops@h:22#10.0.0.7:3389@gateway#gw.example:443', { username: 'alice', password: 'through-gw' })
    // Others': another user's on that host, one under the host's key now, and a host whose key only starts the same.
    const others = ['bob@h:22#10.0.0.9:3389', 'alice%23ops@h:22#10.0.0.8:3389', 'alice#ops@h:2222#10.0.0.9:3389']
    for (const key of others) {
        await signin.saveCredentials(key, { username: 'other', password: key })
    }
    // .5 is reached through a gateway: its 0.5.0 password is to go (see the gateway passwords). .6's user name is
    // changed in its edit form: its passwords go.
    const { svc } = service({ desktops: [{ via: 'h', host: '10.0.0.5', gateway: 'gw.example' }, { via: 'h', host: '10.0.0.6' }] })
    svc.migrateConfig()
    await svc.desktopEdited('10.0.0.6:3389', '10.0.0.6:3389', true, false, {})
    // The host's key, resolved, reads otherwise now: none comes back under it, and none stays under the old one.
    new RemoteTargets({ store: { remoteDesktop: {} }, save () { } }, {}).keyChanged('alice#ops@h:22', 'alice%23ops@h:22')
    assert.equal(await signin.loadCredentials('alice%23ops@h:22#10.0.0.5:3389'), null)
    assert.equal(await signin.loadCredentials('alice%23ops@h:22#10.0.0.6:3389'), null)
    assert.equal(await signin.loadCredentials('alice%23ops@h:22'), null)
    assert.deepEqual([...keychain.keys()].filter(key => key !== GATEWAY_PASSWORDS_MARK).sort(), [...others].sort())
})

test('an address edit hands no password to a machine unasked: behind a host, one goes only along with its desktop\'s certificate', async () => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    // Host 1's desktop at .5 is known (its certificate remembered). Host 2's desktop at .5 has a saved password, its
    // certificate forgotten in Settings › Certificates (which keeps the password).
    const { svc, store } = service({ trustedCertificates: [{ desktop: 'alice@h1:22#10.0.0.5:3389', sha256: A }], gatewayPasswordsMigrated: true })
    keychain.set(GATEWAY_PASSWORDS_MARK, 'done')
    await signin.saveCredentials('alice@h1:22#10.0.0.5:3389', { username: 'alice', password: 'h1-secret' })
    await signin.saveCredentials('bob@h2:22#10.0.0.5:3389', { username: 'bob', password: 'h2-secret' })
    // Host 1's desktop is edited: .5 becomes .9. Its keys don't say which host it is behind (its `via` can be an alias).
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.9:3389', false, false, {})
    // Host 1's password goes along with its certificate, so only that machine gets it at .9.
    assert.deepEqual(await signin.loadCredentials('alice@h1:22#10.0.0.9:3389'), { username: 'alice', password: 'h1-secret' })
    assert.deepEqual(store.trustedCertificates, [{ desktop: 'alice@h1:22#10.0.0.5:3389', sha256: A }, { desktop: 'alice@h1:22#10.0.0.9:3389', sha256: A }])
    // Host 2's doesn't go where a machine behind host 2 would get it, its first certificate trusted unasked: dropped.
    assert.equal(await signin.loadCredentials('bob@h2:22#10.0.0.9:3389'), null)
    assert.deepEqual([...keychain.keys()].filter(key => key !== GATEWAY_PASSWORDS_MARK), ['alice@h1:22#10.0.0.9:3389'])
})

test('a password not to be used until 0.5.0\'s gateway passwords are gone isn\'t moved to a new address meanwhile', async () => {
    // pc17's 0.5.0 password is to go (a direct profile reaches pc17 through a gateway), and the keychain wouldn't delete
    // it when that was tried: it is withheld until then.
    await legacyGatewayPassword()
    const keytar = stubs.keytar as any
    const remove = keytar.deletePassword
    keytar.deletePassword = async () => { throw new Error('the keychain did not answer') }
    try {
        assert.equal(await signin.loadCredentials('rdp#pc17.corp.example:3389'), null)
        // A gateway-less direct profile at that address is edited to another: it isn't taken along.
        const { svc } = service()
        await svc.desktopEdited('pc17.corp.example:3389', 'pc18.corp.example:3389', false, true, {})
        assert.equal(keychain.has('rdp#pc18.corp.example:3389'), false)
        assert.equal(await signin.loadCredentials('rdp#pc18.corp.example:3389'), null)
    } finally {
        keytar.deletePassword = remove
    }
    await signin.loadCredentials('nothing')
    assert.equal(keychain.has('rdp#pc17.corp.example:3389'), false)
})

test('a desktop\'s user name changed while Tabby\'s Vault can\'t be read: the old one\'s password isn\'t used, and goes once the Vault opens', async t => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    const secrets = new Map([
        ['rdp#pc.corp:3389', JSON.stringify({ username: 'olduser', password: 'old' })],
        ['rdp#other.corp:3389', JSON.stringify({ username: 'u', password: 'other' })],
    ])
    // Locked, its passphrase prompt cancelled; then unlocked for a sign-in.
    let open = false
    const cancelled = async () => { throw new Error('the passphrase prompt was cancelled') }
    signin.useVault({
        isEnabled: () => true,
        isOpen: () => open,
        load: async () => open ? { secrets: [...secrets].map(([key, value]) => ({ type: signin.VAULT_SECRET_TYPE, key: { key }, value })) } : cancelled(),
        getSecret: async (_type: string, key: { key: string }) => open ? (secrets.has(key.key) ? { value: secrets.get(key.key) } : null) : cancelled(),
        addSecret: async (secret: { key: { key: string }, value: string }) => { if (!open) await cancelled(); secrets.set(secret.key.key, secret.value) },
        removeSecret: async (_type: string, key: { key: string }) => { if (!open) await cancelled(); secrets.delete(key.key) },
    })
    t.after(() => signin.useVault(null))
    const { svc } = service({ gatewayPasswordsMigrated: true })
    keychain.set(GATEWAY_PASSWORDS_MARK, 'done')
    // The keychain has one for it too, from before the Vault was turned on.
    keychain.set('rdp#pc.corp:3389', JSON.stringify({ username: 'olduser', password: 'in-the-keychain' }))
    const notes: string[] = []
    svc.notifications.info = (text: string) => { notes.push(text) }
    // Its profile's user name is changed.
    await svc.desktopEdited('pc.corp:3389', 'pc.corp:3389', true, true, {})
    assert.equal(notes.length, 1)
    assert.match(notes[0], /^If a password was saved for this desktop before the change, it couldn't be removed from Tabby's Vault just now\. It won't be used in this window, and is removed once the Vault is unlocked/)
    // The keychain's part, which doesn't wait for the Vault, is done at once.
    assert.equal(keychain.has('rdp#pc.corp:3389'), false)
    // Not used meanwhile: the next connection asks for the new user's password, without a prompt of its own for the Vault.
    assert.equal(await signin.loadCredentials('rdp#pc.corp:3389'), null)
    // Opened for another desktop's sign-in: the old password goes then, the other one's stays.
    open = true
    assert.deepEqual(await signin.loadCredentials('rdp#other.corp:3389'), { username: 'u', password: 'other' })
    assert.deepEqual([...secrets.keys()], ['rdp#other.corp:3389'])
})

/** Every call of the keychain's fails at once until the test ends, as on Linux without a Secret Service. */
function keychainUnavailable (t: any): void {
    const keytar = stubs.keytar as any
    const real = { ...keytar }
    const fail = async () => { throw new Error('The name org.freedesktop.secrets was not provided by any .service files') }
    Object.assign(keytar, { getPassword: fail, setPassword: fail, deletePassword: fail, findCredentials: fail })
    t.after(() => { Object.assign(keytar, real) })
}

/**
 * Tabby's Vault, open, over `secrets` (each key's value), with a keychain that doesn't answer (see
 * keychainUnavailable): Linux without a Secret Service, where the Vault is what keeps the passwords. Until the test
 * ends.
 */
function vaultWithoutKeychain (t: any, secrets: Map<string, string>) {
    const vault = {
        isEnabled: () => true,
        isOpen: () => true,
        load: async () => ({ secrets: [...secrets].map(([key, value]) => ({ type: signin.VAULT_SECRET_TYPE, key: { key }, value })) }),
        getSecret: async (_type: string, key: { key: string }) => secrets.has(key.key) ? { value: secrets.get(key.key) } : null,
        addSecret: async (secret: { key: { key: string }, value: string }) => { secrets.set(secret.key.key, secret.value) },
        removeSecret: async (_type: string, key: { key: string }) => { secrets.delete(key.key) },
    }
    signin.useVault(vault)
    t.after(() => signin.useVault(null))
    keychainUnavailable(t)
    return vault
}

/** The sign-in module of a Tabby started again: what waited for a store went with the one before. */
function signinAfresh (): any {
    const file = require.resolve('../../dist/signin.js')
    const loaded = require.cache[file]
    delete require.cache[file]
    try {
        return require(file)
    } finally {
        // The service, and the tests after this one, keep the module they have.
        require.cache[file] = loaded
    }
}

test('the Vault open and the keychain not answering: an edit or a removal forgets the Vault\'s password at once, for good', async t => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    const secrets = new Map([
        ['rdp#pc.corp:3389', JSON.stringify({ username: 'olduser', password: 'old' })],
        ['alice@h:22#10.0.0.5:3389', JSON.stringify({ username: 'alice', password: 'five' })],
    ])
    const vault = vaultWithoutKeychain(t, secrets)
    const { svc } = service({ gatewayPasswordsMigrated: true, desktops: [{ via: 'h', host: '10.0.0.5' }] })
    const notes: string[] = []
    svc.notifications.info = (text: string) => { notes.push(text) }
    // A direct profile's user name is changed: the old user's password goes from the Vault now.
    await svc.desktopEdited('pc.corp:3389', 'pc.corp:3389', true, true, {})
    assert.equal(secrets.has('rdp#pc.corp:3389'), false)
    // Only the keychain's part waits, and only the keychain is named, without saying it had one.
    assert.equal(notes.length, 1)
    assert.match(notes[0], /^If a password was saved for this desktop before the change, it couldn't be removed from the system keychain just now\. It won't be used in this window, and is removed once the keychain answers/)
    assert.doesNotMatch(notes[0], /Vault/)
    // A desktop behind a host removed: its password goes from the Vault as well.
    svc.removeDesktop(0)
    for (let i = 0; i < 100 && secrets.has('alice@h:22#10.0.0.5:3389'); i++) {
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(secrets.has('alice@h:22#10.0.0.5:3389'), false)
    // Tabby started again: neither comes back.
    const fresh = signinAfresh()
    fresh.useVault(vault)
    assert.equal(await fresh.loadCredentials('rdp#pc.corp:3389'), null)
    assert.equal(await fresh.loadCredentials('alice@h:22#10.0.0.5:3389'), null)
})

test('the Vault open and the keychain not answering: an address edit moves the Vault\'s password with its certificate, which stays at the old address too', async t => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    const secrets = new Map([['alice@h:22#10.0.0.5:3389', JSON.stringify({ username: 'alice', password: 'five' })]])
    const vault = vaultWithoutKeychain(t, secrets)
    const { svc, store } = service({ gatewayPasswordsMigrated: true, trustedCertificates: [{ desktop: 'alice@h:22#10.0.0.5:3389', sha256: A }] })
    const notes: string[] = []
    svc.notifications.info = (text: string) => { notes.push(text) }
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.9:3389', false, false, {})
    // The Vault's password went along with its desktop's certificate, and none of it is left at the old address, also
    // once Tabby is started again.
    assert.deepEqual([...secrets.keys()], ['alice@h:22#10.0.0.9:3389'])
    const fresh = signinAfresh()
    fresh.useVault(vault)
    assert.deepEqual(await fresh.loadCredentials('alice@h:22#10.0.0.9:3389'), { username: 'alice', password: 'five' })
    assert.equal(await fresh.loadCredentials('alice@h:22#10.0.0.5:3389'), null)
    // Whatever the keychain has at the old address waits, and would be found there again should Tabby close first: the
    // certificate stays there as well, so that it would go only to the machine it was saved for.
    assert.equal(notes.length, 1)
    assert.match(notes[0], /couldn't be removed from the system keychain just now/)
    assert.deepEqual(store.trustedCertificates, [{ desktop: 'alice@h:22#10.0.0.5:3389', sha256: A }, { desktop: 'alice@h:22#10.0.0.9:3389', sha256: A }])
})

test('the keychain not answering and nothing saved: an edit\'s notice doesn\'t say that a password was there', async t => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    keychainUnavailable(t)
    const { svc } = service({ gatewayPasswordsMigrated: true })
    const notes: string[] = []
    svc.notifications.info = (text: string) => { notes.push(text) }
    // A new address, then a new user name.
    await svc.desktopEdited('10.0.0.5:3389', '10.0.0.9:3389', false, false, {})
    await svc.desktopEdited('10.0.0.9:3389', '10.0.0.9:3389', true, false, {})
    assert.equal(notes.length, 2)
    for (const note of notes) {
        assert.match(note, /^If a password was saved for this desktop before the change, it couldn't be removed from the system keychain just now\./)
    }
})

test('removing a desktop forgets its certificate once no store of passwords waits; with one that can\'t be read, it stays, and the user is told', async t => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    const certificates = [
        { desktop: 'alice@h:22#10.0.0.5:3389', sha256: A }, { desktop: 'bob@h2:22#10.0.0.5:3389', sha256: B },
        { desktop: 'alice@h:22#10.0.0.6:3389', sha256: C }, { desktop: 'gateway#gw.example:443', sha256: C },
    ]
    const desktops = () => [{ name: 'Office PC', via: 'h', host: '10.0.0.5' }, { name: 'Lab', via: 'h', host: '10.0.0.6' }]
    // Nothing waits: the passwords go, then the certificates of that address (behind every host, not its neighbours').
    const answering = service({ gatewayPasswordsMigrated: true, desktops: desktops(), trustedCertificates: certificates.map(e => ({ ...e })) })
    answering.svc.notifications.info = (text: string) => { throw new Error(`told: ${text}`) }
    keychain.set(GATEWAY_PASSWORDS_MARK, 'done')
    await signin.saveCredentials('alice@h:22#10.0.0.5:3389', { username: 'alice', password: 'five' })
    await answering.svc.removeDesktop(0)
    assert.equal(keychain.has('alice@h:22#10.0.0.5:3389'), false)
    assert.deepEqual(answering.store.trustedCertificates.map((e: any) => e.desktop), ['alice@h:22#10.0.0.6:3389', 'gateway#gw.example:443'])
    assert.deepEqual(answering.store.desktops.map((d: any) => d.name), ['Lab'])

    // The keychain doesn't answer (the Vault, open, forgets its password at once): that store's part waits, and with it
    // the certificates, which keep a password that may still be there from going to whatever answers at that address.
    const secrets = new Map([['alice@h:22#10.0.0.5:3389', JSON.stringify({ username: 'alice', password: 'five' })]])
    vaultWithoutKeychain(t, secrets)
    const { svc, store } = service({ gatewayPasswordsMigrated: true, desktops: desktops(), trustedCertificates: certificates.map(e => ({ ...e })) })
    const notes: string[] = []
    svc.notifications.info = (text: string) => { notes.push(text) }
    await svc.removeDesktop(0)
    assert.equal(secrets.size, 0)
    assert.deepEqual(store.desktops.map((d: any) => d.name), ['Lab'], 'the desktop itself is gone')
    assert.deepEqual(store.trustedCertificates.map((e: any) => e.desktop), certificates.map(e => e.desktop))
    assert.deepEqual(notes, [
        'If a password was saved for "Office PC", it couldn\'t be removed from the system keychain just now. It won\'t be used in this window, ' +
        'and is removed once the keychain answers, while the window stays open. Its remembered certificate stays, so that the ' +
        'password can only go to that machine: Settings › Remote Desktop › Certificates can forget it.',
    ])
})

test('a direct profile deleted, or moved behind an SSH profile, while a store of passwords can\'t be read: its certificate stays, and the user is told', async t => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    keychainUnavailable(t)
    const { RDPProfileSettingsComponent, RDPProfilesService } = require('../../dist/rdpProfile.js')
    const { svc, store } = service({ gatewayPasswordsMigrated: true, trustedCertificates: [{ desktop: 'rdp#10.0.0.5:3389', sha256: A }, { desktop: 'rdp#10.0.0.6:3389', sha256: B }] })
    const notes: string[] = []
    svc.notifications.info = (text: string) => { notes.push(text) }
    const injector = { get: () => svc }
    const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 5)) }
    new RDPProfilesService(injector, { save () { } }).deleteProfile({ name: 'Office', options: { host: '10.0.0.5', port: 3389, via: '' } })
    await settle()
    const settings = new RDPProfileSettingsComponent({ nativeElement: null }, injector)
    settings.profile = { name: 'Lab', options: { host: '10.0.0.6', port: 3389, username: 'u', domain: '', account: '', via: 'ssh:jump', gateway: '' } }
    settings.before = { id: '10.0.0.6:3389', account: 'u\n\n', via: '', gateway: '' }
    settings.save()
    await settle()
    assert.deepEqual(store.trustedCertificates.map((e: any) => e.desktop), ['rdp#10.0.0.5:3389', 'rdp#10.0.0.6:3389'])
    assert.equal(notes.length, 2)
    assert.match(notes[0], /^If a password was saved for "Office", it couldn't be removed from the system keychain just now\..* Its remembered certificate stays/)
    assert.match(notes[1], /^If a password was saved for "Lab", it couldn't be removed/)
})

test('removing a saved account: the profiles that used it ask, a group\'s default is none, desktops lose it, and its password goes', async () => {
    await signin.loadCredentials('nothing')
    keychain.clear()
    const profiles = [
        { type: 'rdp', name: 'A', options: { host: 'a.corp', account: 'k1', gatewayAccount: 'k1' } },
        { type: 'rdp', name: 'B', options: { host: 'b.corp', account: 'k2', gatewayAccount: '' } },
        // Not a remote desktop profile: not this plugin's to change.
        { type: 'ssh', name: 'S', options: { host: 's.corp', account: 'k1' } },
    ]
    const { svc, store, config } = service({
        accounts: [{ id: 'k1', name: 'Admin', username: 'admin' }, { id: 'k2', name: 'Other', username: 'other' }],
        desktops: [{ via: 'h', host: '10.0.0.5', account: 'k1', gatewayAccount: 'k1', gateway: 'gw.example' }, { via: 'h', host: '10.0.0.6', account: 'k2' }],
    }, { profiles })
    ;(config.store as any).groups = [{ id: 'g1', defaults: { rdp: { options: { account: 'k1' } } } }, { id: 'g2', defaults: { rdp: { options: { account: 'k2' } } } }]
    await signin.saveCredentials('account#k1', { username: 'admin', password: 'p1' })
    await signin.saveCredentials('account#k2', { username: 'other', password: 'p2' })
    await svc.removeAccount('k1')
    assert.deepEqual(store.accounts.map((a: any) => a.id), ['k2'])
    // Null, which Tabby's profile editor keeps and its config proxy takes as the profile's own: no account, so it asks,
    // rather than take the group's default ('' would).
    assert.deepEqual(profiles.map(p => [p.options.account, p.options.gatewayAccount]), [[null, null], ['k2', ''], ['k1', undefined]])
    // A group's default: none.
    assert.deepEqual((config.store as any).groups.map((g: any) => g.defaults.rdp.options.account), ['', 'k2'])
    // A desktop behind a host: neither key, so its own sign-in, for the gateway too.
    assert.deepEqual(store.desktops, [{ via: 'h', host: '10.0.0.5', gateway: 'gw.example' }, { via: 'h', host: '10.0.0.6', account: 'k2' }])
    assert.deepEqual([keychain.has('account#k1'), keychain.has('account#k2')], [false, true])
    assert.ok(config.saves >= 1)
})

test('reopening the desktop of a machine reached through a host goes there again, also when it ended before signing in', async t => {
    const page = installDocument()
    t.after(page.restore)
    const { Subject } = require('rxjs')
    const own = { key: 'alice@h:22', label: 'h', exec: async () => '' }
    const there = { key: 'alice@h:22>bob@x:22', label: 'x', via: 'h', exec: async () => '' }
    const pane = { profile: { type: 'ssh' }, element: { nativeElement: new FakeElement() }, destroyed$: new Subject(), focused$: new Subject() }
    const targets = { targetOf: async () => own, nestedSSH: async () => [], cached: () => own }
    const { svc } = service({}, { targets, app: { tabs: [pane], activeTab: pane } })
    // Each connection ends before a sign-in (the form cancelled, a setup that failed): "Sign in", "Try again".
    const opened: string[] = []
    svc.connect = async (_pane: unknown, _target: unknown, _spec: unknown, s: any) => { opened.push(s.key) }
    await svc.showDesktop(pane, 'own', { target: there, background: true })
    await svc.reopen(pane, svc.sessions.get(pane).spec)
    assert.deepEqual(opened, [there.key, there.key])
    svc.disconnect(pane)
})

test('ending a backend releases its browser resources and references, even when WASM shutdown throws', t => {
    const page = installDocument()
    t.after(page.restore)
    const desktop = new DesktopSession(new FakeElement(), 'test', specOf({ host: 'host' }))
    const closed: string[] = []
    desktop.host.appendChild(new FakeElement('iron-remote-desktop'))
    desktop.ui = { shutdown () { closed.push('ui'); throw new WebAssembly.RuntimeError('synthetic trap') } }
    desktop.stopSending = () => { }
    for (const name of ['audio', 'h264', 'mic', 'files', 'drives']) {
        desktop[name] = { close: () => closed.push(name), dispose: () => closed.push(name) }
    }
    desktop.onConnectionEnd(() => closed.push('observer'))
    desktop.endConnection()
    assert.deepEqual(closed, ['observer', 'ui', 'audio', 'h264', 'mic', 'files', 'drives'])
    assert.equal(desktop.host.children.length, 0)
    for (const name of ['ui', 'stopSending', 'audio', 'h264', 'mic', 'files', 'drives']) assert.equal(desktop[name], null)
    desktop.endConnection()
    assert.equal(closed.length, 7)
    desktop.dispose()
})

test('an asynchronous trap ends only its desktop even when Rust run never settles', async t => {
    const page = installDocument()
    t.after(page.restore)
    const { svc } = service()
    const spec = specOf({ host: 'host' })
    const pane = {}
    const otherPane = {}
    const desktop = new DesktopSession(new FakeElement(), 'first', spec)
    const other = new DesktopSession(new FakeElement(), 'second', spec)
    t.after(() => { desktop.dispose(); other.dispose() })
    desktop.state = other.state = 'connected'
    let closed = 0
    let otherClosed = 0
    desktop.proxy = { close: () => closed++ }
    other.proxy = { close: () => otherClosed++ }
    svc.sessions.set(pane, desktop)
    svc.sessions.set(otherPane, other)
    // Stand in for a Rust session whose async run hangs after an event callback traps.
    svc.runConnection = async () => new Promise(() => { })
    let fault: (error: Error) => void = () => { }
    let unwatched = false
    const backend = { runtime: { onTrap: (callback: (error: Error) => void) => { fault = callback; return () => { unwatched = true } } } }
    const running = svc.run(pane, {}, spec, desktop, backend, {})
    fault(new WebAssembly.RuntimeError('synthetic trap'))
    assert.deepEqual(await running, { connected: true, error: 'WebAssembly instance failed: synthetic trap' })
    assert.equal(unwatched, true)
    assert.equal(desktop.proxy, null)
    assert.equal(closed, 1)
    assert.equal(otherClosed, 0)
    assert.equal(svc.sessions.get(otherPane), other)
    // Existing reconnect policy is bounded and scoped to the failed pane.
    svc.scheduleReconnect(pane, { isOpen: () => true }, spec, desktop, 'failed')
    assert.equal(svc.reconnects.has(pane), true)
    assert.equal(svc.reconnects.has(otherPane), false)
    svc.cancelReconnect(pane)
})
