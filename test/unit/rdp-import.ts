// .rdp import parsing (src/rdpFile.ts) and the shape of the profile the import builds (src/desktop.service.ts):
//  - a crafted key like `__proto__` or `constructor` names an inherited member of the notes object, not a note, so
//    the lookup must be by own property or the import throws (and fails silently) or shows the attacker's text;
//  - a host with '#' would fork the session and trust keys, so it isn't a usable address;
//  - the imported profile must set every option the provider has a default for, so none is silently inherited from
//    the "Remote desktops" group's (or the global) defaults, a saved account above all; all but the clipboard, which
//    is left to them on purpose (test/unit/clipboard-service.ts). The account stays its own after a save in Tabby's
//    profile editor, which drops options equal to their defaults;
//  - what the confirmation shows can't be dressed up: names that would hide or reorder part of themselves are refused
//    (in the file's name, shown as such), international ones are their punycode, a gateway's port is kept, and the
//    account is named with its domain.
// Runs against the built plugin, the import through the service itself with Tabby's modules stubbed:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Tabby and Angular, as far as loading the service and the profile provider needs them.
const decorator = () => () => undefined
const classes = new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } })
const stubs: Record<string, unknown> = {
    '@angular/core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : decorator }),
    'tabby-core': classes,
    'tabby-terminal': classes,
    'tabby-settings': classes,
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { parseRdpFile } = require('../../dist/rdpFile.js')
const { RemoteDesktopService } = require('../../dist/desktop.service.js')
const { RDPProfilesService } = require('../../dist/rdpProfile.js')
const rdp = (text: string) => parseRdpFile(new TextEncoder().encode(text))

test('a crafted inherited-member key is no note and doesn\'t throw', () => {
    // Object.prototype is truthy but not a function; the Object constructor is a function that would return its text.
    for (const key of ['__proto__', '__PROTO__', 'constructor', 'hasOwnProperty', 'toString']) {
        const parsed = rdp(`full address:s:pc.example\r\n${key}:s:Call IT at 555-0100`)
        assert.ok(parsed, `${key}: still parses`)
        assert.equal(parsed.host, 'pc.example')
        assert.deepEqual(parsed.ignored, [], `${key}: no note, nothing injected`)
    }
    // Object.prototype keys are untouched (no pollution through the parse).
    assert.equal(({} as any).x, undefined)
    rdp('full address:s:pc.example\r\n__proto__:s:{"x":1}')
    assert.equal(({} as any).x, undefined)
})

test('a note the file does ask for still comes through', () => {
    const parsed = rdp('full address:s:pc.example\r\naudiocapturemode:i:1')
    assert.ok(parsed.ignored.some((n: string) => /microphone/.test(n)))
})

test('a host with # is not a usable address (keys are split on #)', () => {
    assert.equal(rdp('full address:s:a#b'), null)
    assert.equal(rdp('full address:s:[a#b]:3389'), null)
    assert.ok(rdp('full address:s:pc.example'))
})

/**
 * Imports `file` as "Add only" would, the "Remote desktops" group (where imports go) having `defaults` for its RDP
 * profiles: the profile made, and its options as Tabby opens it, the group's defaults under its own (as
 * ProfilesService.getConfigProxyForProfile resolves them).
 */
async function imported (file: string, defaults: Record<string, unknown>, more: { fileName?: string, existing?: any[] } = {}) {
    const result = await importing(file, defaults, more)
    assert.equal(result.made.length, 1, 'a profile was made')
    return { profile: result.made[0], options: result.opened(result.made[0]).options, detail: result.detail, message: result.message }
}

/**
 * Imports `file` as importRdp does, "Add only" answered, where profiles (`existing`) and the "Remote desktops" group's
 * `defaults` are as given: what was made, the question, what was opened, and the errors shown.
 */
async function importing (file: string, defaults: Record<string, unknown>, more: { fileName?: string, existing?: any[] } = {}) {
    const groups = [{ id: 'g1', name: 'Remote desktops', defaults: { rdp: { options: defaults } } }]
    const opened = (profile: any) => ({ ...profile, options: { ...profile.group === 'g1' ? defaults : {}, ...profile.options } })
    const made: any[] = []
    const tabs: any[] = []
    const errors: string[] = []
    const profiles = {
        getProfileGroups: async () => groups,
        newProfile: async (profile: any) => { made.push(profile) },
        getConfigProxyForProfile: opened,
        openNewTabForProfile: async (profile: any) => { tabs.push(profile) },
    }
    let detail = ''
    let message = ''
    const platform = { showMessageBox: async (box: { message: string, detail: string }) => { detail = box.detail; message = box.message; return { response: 1 } } }
    const config = {
        store: { remoteDesktop: { desktops: [], accounts: [], desktopSharpness: [] }, profiles: more.existing ?? [] },
        changed$: { subscribe () { } },
        save () { },
    }
    const notifications = { notice () { }, info () { }, error (text: string) { errors.push(text) } }
    const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
    const svc = new RemoteDesktopService({}, {}, notifications, config, zone, profiles, {}, {}, platform)
    await svc.importRdp(new TextEncoder().encode(file), more.fileName ?? 'office.rdp')
    assert.deepEqual(errors.filter(() => made.length), [], 'no error where a profile was made')
    return { made, opened, detail, message, tabs, errors }
}

test('an imported profile sets every option the provider defaults name, but the clipboard, so none is inherited', async () => {
    // What the provider has a default for: each of them can also come from a group's defaults.
    const keys = Object.keys(new RDPProfilesService({}, {}).configDefaults.options)
    assert.ok(keys.includes('account') && keys.includes('clipboard'), keys.join(', '))
    // A group whose defaults differ from what the file says in every one of them: a saved account (whose password would
    // go to the file's address without a sign-in prompt), a gateway, an SSH profile to go through, and so on.
    const defaults = {
        host: 'elsewhere.example', port: 3390, kind: 'xrdp', username: 'admin', domain: 'CORP', account: 'k3f9x2ab',
        via: 'ssh:custom:jump', gateway: 'rdgw.example.com', gatewayAccount: 'k3f9x2ab', clipboard: 'fromRemote',
    }
    assert.deepEqual(Object.keys(defaults).sort(), [...keys].sort(), 'a default for each')
    const { profile, options } = await imported('full address:s:pc17.corp.example\r\nusername:s:alice', defaults)
    const own = keys.filter(k => Object.prototype.hasOwnProperty.call(profile.options, k))
    assert.deepEqual(keys.filter(k => !own.includes(k)), ['clipboard'], 'the import sets all of them but the clipboard')
    // In particular `account`, whose absence would adopt the group's or the global default saved account, the gateway's
    // account (its proof would go to the gateway the file named) and the kind (an xrdp one signs in without NLA, unasked):
    // null, none of them whatever the defaults, and Windows.
    assert.equal(options.account, null)
    assert.deepEqual([options.host, options.port, options.kind, options.username, options.domain, options.via, options.gateway, options.gatewayAccount],
        ['pc17.corp.example', 3389, null, 'alice', '', '', '', null])
    const { specOf } = require('../../dist/desktops.js')
    const spec = specOf(options)
    assert.deepEqual([spec.kind, spec.account, spec.gatewayAccount], ['windows', undefined, undefined])
    // The clipboard is the group's: the user's own word for where imports go, and named in the import's question.
    assert.equal(options.clipboard, 'fromRemote')
})

/**
 * A profile's options as Tabby's profile editor leaves them when it saves: any equal to its default (the provider's,
 * under the group's) is dropped, compared as Tabby's ConfigProxy does (deep-equal, not strict: '' and null differ).
 */
function savedInEditor (options: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
    // eslint-disable-next-line eqeqeq
    return Object.fromEntries(Object.entries(options).filter(([key, value]) => !(key in defaults && value == defaults[key])))
}

test('an imported profile\'s own account, gateway account and kind outlast a save in the profile editor, and defaults set later', async () => {
    const provider = new RDPProfilesService({}, {}).configDefaults.options
    // No group default yet: an empty account would be dropped as the default, and a default set later taken. The file
    // names a gateway: one of the user's saved accounts as a default gateway account would send its proof there.
    const { profile } = await imported('full address:s:pc17.corp.example\r\nusername:s:alice\r\ngatewayhostname:s:gw.attacker.example\r\ngatewayusagemethod:i:1', {})
    const kept = savedInEditor(profile.options, provider)
    for (const key of ['account', 'gatewayAccount', 'kind']) {
        assert.ok(key in kept, `${key} is still the profile's own`)
    }
    const later = { ...provider, account: 'k3f9x2ab', gatewayAccount: 'k1', kind: 'xrdp' }
    const resolved = { ...later, ...kept }
    assert.deepEqual([resolved.account, resolved.gatewayAccount, resolved.kind], [null, null, null], 'defaults set afterwards aren\'t taken')
    const { specOf, xrdpUnasked } = require('../../dist/desktops.js')
    const spec = specOf(resolved)
    assert.deepEqual([spec.gateway, spec.gatewayAccount, spec.kind, xrdpUnasked(spec)], ['gw.attacker.example', undefined, 'windows', false])
    // What empty ones (and the import's earlier 'windows') would have come to.
    const before = { ...later, ...savedInEditor({ ...profile.options, account: '', gatewayAccount: '', kind: 'windows' }, provider) }
    assert.deepEqual([before.account, before.gatewayAccount, before.kind], ['k3f9x2ab', 'k1', 'xrdp'])
})

test('an international gateway with its port: its punycode, the port kept', async () => {
    const { profile, detail } = await imported('full address:s:pc.example\r\ngatewayhostname:s:bücher.example:8443\r\ngatewayusagemethod:i:1', {})
    assert.equal(profile.options.gateway, 'xn--bcher-kva.example:8443')
    assert.match(detail, /through the gateway xn--bcher-kva\.example:8443/)
    assert.match(detail, /A name in the file uses international characters, shown here as the punycode it resolves to/)
    // Capitals and one trailing dot are the same name, said plainly: no note about international characters.
    const plain = await imported('full address:s:pc.example\r\ngatewayhostname:s:RDGW.Example.COM.\r\ngatewayusagemethod:i:1', {})
    assert.equal(plain.profile.options.gateway, 'rdgw.example.com')
    assert.doesNotMatch(plain.detail, /international/)
})

test('a gateway that names no host, or a name with characters that could hide or reorder part of it: not imported', async () => {
    for (const gateway of ['gw.example..', 'gw..example', '.']) {
        const { made, errors } = await importing(`full address:s:pc.example\r\ngatewayhostname:s:${gateway}\r\ngatewayusagemethod:i:1`, {})
        assert.equal(made.length, 0, gateway)
        assert.match(errors.join(), /its RD Gateway isn't an address that can be reached/, gateway)
    }
    // Default-ignorable and blank characters that don't show: the combining grapheme joiner, a Mongolian vowel separator,
    // a variation selector, a tag, a Hangul filler, the braille blank, a no-break space; and the bidi override.
    for (const ch of ['͏', '᠎', '️', '\u{e0041}', 'ㅤ', '⠀', ' ', '‮']) {
        for (const field of ['username', 'domain']) {
            const { made, errors } = await importing(`full address:s:pc.example\r\n${field}:s:adm${ch}in`, {})
            assert.equal(made.length, 0, `${field} with U+${ch.codePointAt(0)!.toString(16)}`)
            assert.match(errors.join(), /has characters that can't be shown safely/)
        }
    }
    // Letters of any script are names like any other, and so are the joiners between letters that Persian and Indic
    // scripts write words with; not elsewhere in a name, nor in an address.
    assert.equal((await imported('full address:s:pc.example\r\nusername:s:José Müller', {})).profile.options.username, 'José Müller')
    for (const name of ['\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645', '\u0915\u094d\u200d\u0937', '\u0d28\u0d4d\u200d\u0d28', '\u0dc1\u0dca\u200d\u0dbb\u0dd3']) {
        assert.equal((await imported(`full address:s:pc.example\r\nusername:s:${name}\r\ndomain:s:${name}`, {})).profile.options.username, name)
    }
    // Nor between letters of a script that doesn't write words with them, where they don't show at all ('ad‍min' reads as
    // 'admin'), nor between two scripts.
    for (const file of ['username:s:admin\u200c', 'username:s:\u200dadmin', 'domain:s:CORP\u200c\u200cX', 'full address:s:pc\u200c.example',
        'username:s:ad\u200dmin', 'username:s:ad\u200cmin', 'domain:s:CO\u200dRP', 'username:s:\u0430d\u200cmin', 'username:s:\u0645\u06cc\u200c\u0915\u094d']) {
        const { made, errors } = await importing(`full address:s:pc.example\r\n${file}`, {})
        assert.equal(made.length, 0, JSON.stringify(file))
        assert.match(errors.join(), /has characters that can't be shown safely/)
    }
})

test('the question names the account with its domain, and the file as it is, without what would reorder or hide part of its name', async () => {
    const { detail, message, profile } = await imported('full address:s:pc.example\r\nusername:s:alice\r\ndomain:s:CORP', {}, { fileName: '/tmp/Invoice‮txt.rdp' })
    assert.match(detail, /, as CORP\\alice\./)
    assert.equal(message, 'Add a remote desktop from Invoice�txt.rdp?')
    assert.equal(profile.name, 'Invoice�txt')
    assert.match((await imported('full address:s:pc.example\r\nusername:s:bob@corp.example\r\ndomain:s:CORP', {})).detail, /, as bob@corp\.example\./)
    assert.match((await imported('full address:s:pc.example\r\ndomain:s:CORP', {})).detail, /, with an account of the domain CORP\./)
    // The gateway's part, plainly.
    assert.match((await imported('full address:s:pc.example\r\ngatewayhostname:s:gw.example\r\ngatewayusagemethod:i:1', {})).detail,
        /The gateway is signed in to first, before the desktop is reached, and is given a proof of your password that whoever runs it could try to crack offline\./)
})

test('a file that leads where a profile already does opens that profile, as it resolves, its group\'s gateway included', async () => {
    const mine = { id: 'p1', type: 'rdp', name: 'Office PC', group: 'g1', options: { host: 'pc.example', port: 3389, username: 'alice' } }
    // The file names the gateway the profile gets from its group, in another spelling: the same.
    const same = await importing('full address:s:pc.example\r\nusername:s:alice\r\ngatewayhostname:s:RDGW.example.com\r\ngatewayusagemethod:i:1', { gateway: 'rdgw.example.com' }, { existing: [mine] })
    assert.deepEqual([same.made.length, same.tabs.map(p => p.id)], [0, ['p1']])
    // Without the gateway the profile goes through: another desktop, asked about.
    const other = await importing('full address:s:pc.example\r\nusername:s:alice', { gateway: 'rdgw.example.com' }, { existing: [mine] })
    assert.deepEqual([other.made.length, other.tabs.length], [1, 0])
})

test('a file that names another domain than the profile that leads where it does is another desktop, asked about; the same domain in any case is the same', async () => {
    const mine = { id: 'p1', type: 'rdp', name: 'Office PC', group: 'g1', options: { host: 'pc.example', port: 3389, username: 'alice', domain: 'CORP' } }
    const file = (domain: string) => `full address:s:pc.example\r\nusername:s:alice${domain ? `\r\ndomain:s:${domain}` : ''}`
    // Windows takes a domain's name in any case: the same account, so the profile opens.
    for (const domain of ['CORP', 'corp', 'Corp']) {
        const same = await importing(file(domain), {}, { existing: [mine] })
        assert.deepEqual([same.made.length, same.tabs.map(p => p.id)], [0, ['p1']], domain)
    }
    // Another domain, or none, is another account: the question names the domain it would sign in to.
    for (const domain of ['OTHER', '']) {
        const other = await importing(file(domain), {}, { existing: [mine] })
        assert.deepEqual([other.made.length, other.tabs.length], [1, 0], domain || 'none')
    }
    // A profile without a domain, a file without one: the same, as before.
    const bare = { ...mine, options: { host: 'pc.example', port: 3389, username: 'alice' } }
    const same = await importing(file(''), {}, { existing: [bare] })
    assert.deepEqual([same.made.length, same.tabs.map(p => p.id)], [0, ['p1']])
    assert.equal((await importing(file('CORP'), {}, { existing: [bare] })).made.length, 1)
})

test('"Import an .rdp file…": a file that can\'t be read or imported is reported, not left to fail in silence', async () => {
    // importRdpFile is importRdp's one caller (the menus, the settings page and the command palette call it): what
    // fails in either is shown, rather than becoming an unhandled rejection.
    const errors: string[] = []
    const config = { store: { remoteDesktop: { desktops: [], accounts: [] }, profiles: [] }, changed$: { subscribe () { } }, save () { } }
    const notifications = { notice () { }, info () { }, error (text: string) { errors.push(text) } }
    const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
    const svc = new RemoteDesktopService({}, {}, notifications, config, zone, {}, {}, {}, {})
    // The file picker, as the page gives it: an input that "changes" to the file picked.
    let picked: any = null
    const g = globalThis as any
    const page = g.document
    g.document = {
        body: { appendChild () { } },
        createElement () {
            const listeners: Record<string, () => void> = {}
            const input: any = {
                style: {}, files: null, remove () { },
                addEventListener (type: string, f: () => void) { listeners[type] = f },
                click () { input.files = [picked]; listeners.change() },
            }
            return input
        },
    }
    try {
        picked = { name: 'unreadable.rdp', arrayBuffer: async () => { throw new Error('the disk said no') } }
        await svc.importRdpFile()
        assert.deepEqual(errors, ['unreadable.rdp: couldn\'t be imported (the disk said no)'])
        picked = { name: 'failing.rdp', arrayBuffer: async () => new TextEncoder().encode('full address:s:pc.example').buffer }
        svc.importRdp = async () => { throw new Error('something broke') }
        await svc.importRdpFile()
        assert.deepEqual(errors.slice(1), ['failing.rdp: couldn\'t be imported (something broke)'])
    } finally {
        g.document = page
    }
})
