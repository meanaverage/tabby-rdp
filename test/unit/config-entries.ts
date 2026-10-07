// A desktop's entry in `remoteDesktop.desktops`, or an RDP profile's options, holds whatever a hand edit or config sync
// puts there: a map whose `toString` and `valueOf` aren't functions, which neither String() nor a template can make text
// of, or an item that is no map at all. Where the plugin shows or keys an entry (its Edit and Remove menus, part of
// every SSH tab's right-click menu; the settings page's lists; the question before removing one; the edit form; what
// Tabby's profile selector shows of a profile), each field is read as text: the entry shows what it has, or its address,
// and the other entries, and the rest of the menu or the page, are there as before. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const g = globalThis as any

// Tabby and Angular, as far as loading the plugin needs them; the system keychain, as a map.
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
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}

/**
 * An element, as the edit form and the settings page's lists use one. What a field, a text or an option is given is
 * made text, as the page makes it (String()), which throws for a value that can't be.
 */
class Element {
    className = ''
    hidden = false
    title = ''
    readonly style: Record<string, string> = {}
    readonly children: Element[] = []
    readonly options: { text: string, value: string }[] = []
    readonly listeners: Record<string, ((event: any) => void)[]> = {}
    /** The form's parts, made as it asks for them. */
    readonly parts: Record<string, Element> = {}
    private texts = { value: '', textContent: '', innerHTML: '' }

    get value (): string { return this.texts.value }
    set value (value: unknown) { this.texts.value = String(value) }
    get textContent (): string { return this.texts.textContent }
    set textContent (value: unknown) { this.texts.textContent = String(value) }
    get innerHTML (): string { return this.texts.innerHTML }
    set innerHTML (value: unknown) { this.texts.innerHTML = String(value) }

    append (...items: any[]): void { items.forEach(item => item instanceof Element ? this.children.push(item) : this.options.push(item)) }
    prepend (...items: any[]): void { this.options.unshift(...items) }
    appendChild (child: Element): Element { this.children.push(child); return child }
    replaceChildren (...children: Element[]): void { this.children.splice(0, this.children.length, ...children) }
    addEventListener (type: string, listener: (event: any) => void): void { (this.listeners[type] ??= []).push(listener) }
    removeEventListener (): void { }
    querySelector (selector: string): Element | null {
        return /^(\[name="[^"]+"\]|form|datalist|button\[type=submit\]|\.trd-signin-(title|error))$/.test(selector) ? this.parts[selector] ??= new Element() : null
    }

    querySelectorAll (): Element[] { return [] }
    contains (): boolean { return false }
    focus (): void { }
    remove (): void { }
    click (): void { (this.listeners.click ?? []).forEach(listener => listener({})) }
}
g.document = { createElement: () => new Element(), activeElement: null }
g.getComputedStyle = () => ({ position: 'relative' })
g.Option = class { readonly text: string; readonly value: string; constructor (text: unknown = '', value: unknown = text) { this.text = String(text); this.value = String(value) } }
g.window = {}

const { RemoteDesktopService } = require('../../dist/desktop.service.js')
const { RemoteDesktopContextMenu, settingsMenu } = require('../../dist/ui.js')
const { RemoteDesktopSettingsComponent } = require('../../dist/settingsPage.js')
const { HostCompatibility } = require('../../dist/hostCompat.js')
const { RDPProfilesService } = require('../../dist/rdpProfile.js')
const { desktopIdOf, desktopsFor, entryText, specOf } = require('../../dist/desktops.js')
const signin = require('../../dist/signin.js')

/** A map from the config that no conversion can make text of: String() throws on it. */
const ODD = { valueOf: null, toString: null }
assert.throws(() => String(ODD))
const ID = '5f05e000-4d4b-4fd8-b0a7-0e8a3b11c2d4'

/** The entries: with each field that can't be made text in turn, items that are no entries, and plain ones around them. */
const ENTRIES: any[] = [
    { name: 'Before', via: 'h', host: '10.0.0.1' },
    { name: ODD, via: 'h', host: '10.0.0.5', port: 3390 },
    { name: 'Behind odd', via: ODD, host: '10.0.0.6' },
    { via: 'h', host: ODD, port: 3389 },
    { via: 'h', host: '10.0.0.8', port: ODD },
    { name: 'Odd fields', via: 'h', host: '10.0.0.9', username: ODD, domain: ODD, kind: ODD, gateway: ODD, account: ODD, wake: { vm: ODD, mac: ODD } },
    null,
    5,
    'a line of text',
    ['a', 'list'],
    { via: 'hv', hyperv: ID },
    { name: 'After', via: 'h', host: '10.0.0.2', port: '3391' },
]
/** What the menus and lists name them by, with their place in the list; the items that are no entries are left out. */
const SHOWN = [
    [0, 'Before (behind h)…'],
    [1, '10.0.0.5:3390 (behind h)…'],
    [2, 'Behind odd…'],
    [3, ':3389 (behind h)…'],
    [4, '10.0.0.8:NaN (behind h)…'],
    [5, 'Odd fields (behind h)…'],
    [10, `hyperv:${ID} (behind hv)…`],
    [11, 'After (behind h)…'],
]

/** Stands in for the service where the menus only read from it: the desktops configured are `entries`. */
function menuDesktop (entries: unknown[], calls: string[] = []) {
    return {
        settings: () => ({ resize: 'live', zoom: 'fit', sharpness: 'standard', clipboard: 'both', microphone: false }),
        desktopOf: () => null,
        ownSharpness: () => null,
        clipboardCapOf: () => 'both',
        hasConsole: () => true,
        configuredDesktops: () => [...entries],
        editDesktop: (_: unknown, i: number) => calls.push(`edit ${i}`),
        confirmRemoveDesktop: (i: number) => calls.push(`remove ${i}`),
        has: () => false,
        isVisible: () => false,
        isConnected: () => false,
        isOpenElsewhere: () => false,
        choicesOf: () => ({ specs: [], current: null }),
        vmsCut: () => false,
        discoverVMs: async () => undefined,
        canSaveFoundDesktop: () => false,
        canSignInAgain: () => false,
    }
}

test('Edit a desktop and Remove a desktop list every entry, by what of it is text, and act on that one', () => {
    const calls: string[] = []
    const menu = settingsMenu(menuDesktop(ENTRIES, calls), {})
    for (const label of ['Edit a desktop', 'Remove a desktop']) {
        const item = menu.find((i: any) => i.label === label)
        assert.equal(item.enabled, true, label)
        assert.deepEqual(item.submenu.map((i: any) => i.label), SHOWN.map(([, shown]) => shown), label)
        item.submenu.forEach((i: any) => i.click())
    }
    assert.deepEqual(calls, [...SHOWN.map(([i]) => `edit ${i}`), ...SHOWN.map(([i]) => `remove ${i}`)])
    // Nothing that is an entry: nothing to edit or remove.
    const none = settingsMenu(menuDesktop([null, 5]), {})
    assert.deepEqual(none.filter((i: any) => /a desktop$/.test(i.label ?? '')).map((i: any) => [i.label, i.enabled, i.submenu.length]),
        [['Edit a desktop', false, 0], ['Remove a desktop', false, 0]])
})

test('an SSH tab\'s right-click menu still builds, so Tabby\'s own items stay with it', async () => {
    // Tabby gathers every plugin's items for the menu at once (Promise.all): one that fails takes the whole menu.
    const target = { key: 'alice@h:22', label: 'h' }
    const menu = new RemoteDesktopContextMenu(menuDesktop(ENTRIES), { cached: () => target, targetOf: async () => target }, {}, {}, { tabs: [] }, {})
    const ssh = { profile: { type: 'ssh' }, element: { nativeElement: {} } }
    const [ours, tabbys] = await Promise.all([menu.getItems(ssh), Promise.resolve([{ label: 'Close' }])])
    const settings = ours.find((i: any) => i.label === 'Settings').submenu
    assert.deepEqual(settings.find((i: any) => i.label === 'Remove a desktop').submenu.map((i: any) => i.label), SHOWN.map(([, shown]) => shown))
    assert.deepEqual(tabbys, [{ label: 'Close' }])
})

/** The service on a config of its own; `asked` keeps the questions it asks, answered with `answer`. */
function service (remoteDesktop: Record<string, unknown>, profiles: unknown[] = [], answer = 0) {
    const asked: any[] = []
    const config = {
        store: { remoteDesktop: { trustedCertificates: [], withoutNla: [], desktops: [], accounts: [], ...remoteDesktop }, profiles, groups: [] },
        save () { },
        changed$: { subscribe () { } },
    }
    const platform = { showMessageBox: async (options: any) => { asked.push(options); return { response: answer } } }
    const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
    const notifications = { notice () { }, info () { }, error () { } }
    const svc = new RemoteDesktopService({ tabs: [] }, {}, notifications, config, zone, { getConfigProxyForProfile: (p: any) => p }, {}, {}, platform)
    const revisions = new Map<string, string>()
    svc.accountRevisions = new (require('../../dist/accountRevisions.js').AccountRevisions)(() => ({
        getItem: (key: string) => revisions.get(key) ?? null, setItem: (key: string, value: string) => revisions.set(key, value),
    }), () => true)
    return { svc, store: config.store.remoteDesktop as any, asked }
}

const ACCOUNTS = [{ id: 'acct1', name: 'Admin', username: 'admin' }]

test('the settings page lists every entry and profile by what of each is text, and the accounts list names their uses so', () => {
    const profiles = [
        { id: 'rdp:custom:odd:1', type: 'rdp', name: ODD, options: { host: '10.0.1.5', port: ODD, username: ODD, kind: ODD, gateway: ODD } },
        { id: 'rdp:custom:plain:1', type: 'rdp', name: 'Plain', options: { host: '10.0.1.6', port: 3389 } },
    ]
    const entries = [...ENTRIES, { name: 'Uses it', via: 'h', host: '10.0.0.3', account: 'acct1' }, { name: ODD, via: ODD, host: '10.0.0.4', gatewayAccount: 'acct1' }]
    const { svc } = service({ desktops: entries, accounts: ACCOUNTS }, profiles)
    const lists: Record<string, Element> = { '[data-list=desktops]': new Element(), '[data-list=accounts]': new Element() }
    const element = { nativeElement: { querySelector: (selector: string) => lists[selector] ?? null } }
    const injector = { get: () => ({ getConfigProxyForProfile: (p: any) => p }) }
    const zone = { run: (f: () => unknown) => f() }
    const page = new RemoteDesktopSettingsComponent(element, svc, {}, { store: { profiles, groups: [] } }, {}, injector, zone, {}, new HostCompatibility({}))
    page.renderDesktops()
    const rows = lists['[data-list=desktops]'].children.map(row => row.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    assert.deepEqual(rows, [
        '10.0.1.5: 10.0.1.5:',
        'Plain 10.0.1.6:3389',
        'Before 10.0.0.1:3389 behind h',
        '10.0.0.5:3390 10.0.0.5:3390 behind h',
        'Behind odd 10.0.0.6:3389',
        ':3389 :3389 behind h',
        '10.0.0.8:NaN 10.0.0.8:NaN behind h',
        'Odd fields 10.0.0.9:3389 behind h',
        `hyperv:${ID} Hyper-V VM on hv`,
        'After 10.0.0.2:3391 behind h',
        'Uses it 10.0.0.3:3389 behind h Signs in as Admin',
        '10.0.0.4:3389 10.0.0.4:3389',
    ])
    // The accounts list names the desktops that use an account the same way, and opens the right one's editor.
    page.renderAccounts()
    const [account] = lists['[data-list=accounts]'].children
    assert.match(account.innerHTML, /Used by <a data-desktop="12">Uses it<\/a>, <a data-desktop="13">10\.0\.0\.4:3389<\/a>/)
})

test('the service names, asks about and removes such an entry, and checks a new one against the others, without failing', async () => {
    keychain.clear()
    const entries = [...ENTRIES, { name: 'Uses it', via: ODD, host: '10.0.0.3', account: 'acct1', gatewayAccount: 'acct1' }]
    const { svc, store, asked } = service({ desktops: entries, accounts: ACCOUNTS }, [{ id: ODD, type: 'rdp', name: ODD, options: { host: '10.0.1.5', account: 'acct1' } }])
    // The desktops that use an account: by what of them is text.
    assert.deepEqual(svc.accountUses('acct1'), [{ name: 'Uses it', desktopIndex: 12 }, { name: '10.0.1.5', profileId: undefined }])
    // Another desktop at an address taken behind the same host is refused, whatever the others hold.
    assert.equal(svc.addressTaken({ name: 'New', via: 'h', host: '10.0.0.5', port: 3390 }, -1), 'There is already a desktop at 10.0.0.5:3390 behind h.')
    assert.equal(svc.addressTaken({ name: 'New', via: ODD, host: '10.0.0.7', port: 3389 }, -1), null)
    // The question before removing one names what of it is text; then it goes, and only it.
    assert.equal(await svc.confirmRemoveDesktop(1), true)
    assert.equal(asked[0].message, 'Remove the desktop "10.0.0.5:3390"?')
    assert.match(asked[0].detail, /^10\.0\.0\.5:3390 behind h\. Its saved password and remembered certificate are forgotten too\./)
    assert.equal(store.desktops.length, entries.length - 1)
    assert.equal(store.desktops.includes(entries[1]), false)
    assert.equal(await svc.confirmRemoveDesktop(1), true)
    assert.match(asked[1].detail, /^10\.0\.0\.6:3389\. Its saved password/)
    // An item that is no entry isn't asked about, nor removed.
    const before = store.desktops.length
    assert.equal(await svc.confirmRemoveDesktop(store.desktops.indexOf(null)), false)
    assert.equal(store.desktops.length, before)
    // Removing the account takes it out of the entries that used it; the items that are no entries stay as they were.
    await signin.saveCredentials('account#acct1', { username: 'admin', password: 'dummy' })
    const accountRevision = svc.accountRevisions.capture(ACCOUNTS[0])
    await svc.removeAccount('acct1')
    assert.equal(svc.accountRevisions.current('acct1', accountRevision), false)
    assert.equal(keychain.has('account#acct1'), false)
    const user = store.desktops.find((d: any) => d?.name === 'Uses it')
    assert.equal('account' in user, false)
    assert.equal(user.gatewayAccount, '@ask')
    assert.deepEqual(store.desktops.filter((d: any) => typeof d !== 'object' || d === null || Array.isArray(d)), [null, 5, 'a line of text', ['a', 'list']])
})

test('removing a Hyper-V VM\'s entry forgets nothing of another desktop\'s; removing another entry forgets that desktop\'s', async () => {
    keychain.clear()
    // A desktop at 127.0.0.1:3389 behind a host (a VM's RDP port forwarded to the host's loopback), with what is kept for
    // it, and the host's Hyper-V sign-in and certificate, which all its VMs use.
    const kept = { desktop: 'alice@h:22#127.0.0.1:3389', sha256: 'AA' }
    const hyperv = { desktop: 'alice@hv:22#hyperv', sha256: 'BB' }
    // And lists of what is kept with an item whose key isn't text, which forgetting reads past.
    const odd = { desktop: ODD, sha256: 'CC' }
    const { svc, store, asked } = service({
        desktops: [{ name: 'Loopback VM', via: 'h', host: '127.0.0.1', port: 3389 }, { name: 'Build VM', via: 'hv', hyperv: ID }],
        trustedCertificates: [kept, hyperv, odd],
        withoutNla: [odd],
    })
    await signin.saveCredentials('alice@h:22#127.0.0.1:3389', { username: 'u', password: 'p' })
    await signin.saveCredentials('alice@hv:22#hyperv', { username: 'hv', password: 'q' })
    assert.equal(await svc.confirmRemoveDesktop(1), true)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(store.desktops.map((d: any) => d.name), ['Loopback VM'])
    assert.deepEqual(store.trustedCertificates, [kept, hyperv, odd])
    assert.deepEqual([...keychain.keys()].sort(), ['alice@h:22#127.0.0.1:3389', 'alice@hv:22#hyperv'])
    // And the question said so.
    assert.equal(asked[0].detail, 'A Hyper-V VM on hv. The sign-in and certificate kept for its host stay, for its other VMs. ' +
        'To open it instead, use its host\'s SSH tab: right-click › Open.')
    // The other one's go with it.
    assert.equal(await svc.confirmRemoveDesktop(0), true)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual([store.desktops, store.trustedCertificates, store.withoutNla, [...keychain.keys()]], [[], [hyperv, odd], [odd], ['alice@hv:22#hyperv']])
})

test('a desktop at a host named hyperv is no Hyper-V VM: it is listed, asked about and removed as the desktop it is', async () => {
    keychain.clear()
    // A host named hyperv (a Hyper-V server's usual short name), as the add form writes it: the desktop's id is
    // hyperv:3389, which starts as a VM's does.
    const entry = { name: 'Hyper-V server', via: 'h', host: 'hyperv', port: 3389, gateway: 'gw.example.com' }
    const { svc, store, asked } = service({ desktops: [entry], trustedCertificates: [{ desktop: 'alice@h:22#hyperv:3389', sha256: 'AA' }] })
    await signin.saveCredentials('alice@h:22#hyperv:3389', { username: 'u', password: 'p' })
    const lists: Record<string, Element> = { '[data-list=desktops]': new Element(), '[data-list=accounts]': new Element() }
    const element = { nativeElement: { querySelector: (selector: string) => lists[selector] ?? null } }
    const injector = { get: () => ({ getConfigProxyForProfile: (p: any) => p }) }
    const page = new RemoteDesktopSettingsComponent(element, svc, {}, { store: { profiles: [], groups: [] } }, {}, injector, { run: (f: () => unknown) => f() }, {}, new HostCompatibility({}))
    page.renderDesktops()
    const rows = lists['[data-list=desktops]'].children.map(row => row.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    assert.equal(rows[0], 'Hyper-V server hyperv:3389 behind h Through the gateway gw.example.com')
    assert.equal(await svc.confirmRemoveDesktop(0), true)
    assert.match(asked[0].detail, /^hyperv:3389 behind h\. Its saved password and remembered certificate are forgotten too\./)
    // As they are.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual([store.trustedCertificates, [...keychain.keys()]], [[], []])
})

test('the edit form opens on such an entry, its fields as text, and saves it put right', async () => {
    keychain.clear()
    const entry = { name: ODD, via: ODD, host: '10.0.0.5', port: 3389, kind: 'xrdp', kindFromHost: true, username: ODD, domain: ODD, gateway: ODD, account: ODD, gatewayAccount: ODD, wake: { vm: ODD } }
    const { svc, store } = service({ desktops: [entry], accounts: ACCOUNTS })
    await signin.saveCredentials('alice@h:22#10.0.0.5:3389', { username: 'old', password: 'p' })
    const pane = new Element()
    const saved = svc.editDesktopIn(pane, 0)
    const form = pane.children[0].parts.form
    const field = (name: string) => form.parts[`[name="${name}"]`]
    assert.equal(form.parts['.trd-signin-title'].textContent, 'Edit 10.0.0.5:3389')
    assert.deepEqual(['name', 'via', 'address', 'username', 'domain', 'gateway', 'wake', 'account', 'gatewayAccount'].map(name => field(name).value),
        ['', '', '10.0.0.5:3389', '', '', '', '', '', ''])
    assert.match(field('kind').options[0].text, /^xrdp, as the host reported/)
    field('name').value = 'Lab'
    form.listeners.submit.at(-1)!({ preventDefault () { } })
    await saved
    assert.deepEqual(store.desktops.map((d: any) => [d.name, d.host, d.port, 'account' in d, 'username' in d]), [['Lab', '10.0.0.5', 3389, false, false]])
    // Then what is kept for it follows the edit, as for any other: its user name changed, so its saved password goes.
    assert.deepEqual([...keychain.keys()], [])
})

test('a desktop\'s id is its desktop\'s, whatever the entry holds: one that makes no desktop gets an id that none has', () => {
    const target = { key: 'alice@h:22', label: 'h' }
    for (const entry of [{ host: '10.0.0.5', port: '3390' }, { host: '10.0.0.5', port: ' 3390 ' }, { host: '', port: 0 }, { hyperv: ID }, {}]) {
        assert.equal(desktopIdOf(entry), specOf(entry).id, JSON.stringify(entry))
    }
    const ids = desktopsFor(target, ENTRIES).map((s: any) => s.id)
    for (const entry of [{ host: ODD }, { host: '10.0.0.5', port: ODD }, { host: '10.0.0.5', port: 70000 }, { host: 'a#b' }]) {
        assert.equal(specOf(entry), null)
        assert.ok(!ids.includes(desktopIdOf(entry)) && desktopIdOf(entry) !== '' && desktopIdOf(entry) !== '127.0.0.1:3389', desktopIdOf(entry))
    }
    assert.deepEqual(entryText({ name: ODD, via: ODD, host: ODD }), { name: ':3389', address: ':3389', via: '', hyperv: false })
})

test('a remote desktop profile through an SSH profile opens the desktop by the id it has, however its port is written', async () => {
    const ssh = { id: 'ssh1', type: 'ssh', name: 'h' }
    const profiles = { getProfiles: async () => [ssh], newTabParametersForProfile: async () => ({ inputs: {} }) }
    const provider = new RDPProfilesService({ get: () => profiles }, { store: { profiles: [ssh] } })
    for (const port of [3390, '3390', ' 3390', '03390']) {
        const options = { host: '10.0.0.5', port, via: 'ssh1' }
        const params = await provider.getNewTabParameters({ type: 'rdp', name: 'Through h', options })
        // The SSH tab opened for it shows the desktop with this id among the host's (see RDPProfileOpener).
        assert.equal(params.inputs.trdOpenDesktop, specOf(options).id, JSON.stringify(port))
    }
})

test('Tabby\'s profile selector can describe every RDP profile, whatever its options hold', () => {
    // Tabby asks every profile's provider for these as it fills the selector: one that throws keeps it from opening.
    const provider = new RDPProfilesService({}, { store: { profiles: [{ id: 'ssh1', name: ODD }] } })
    const odd = { type: 'rdp', name: 'Odd', options: { host: ODD, port: ODD, username: ODD, gateway: ODD, via: '' } }
    assert.equal(provider.getDescription(odd), '')
    assert.equal(provider.intoQuickConnectString(odd), ':NaN')
    const partly = { type: 'rdp', name: 'Partly', options: { host: '10.0.0.5', port: ODD, gateway: ODD, via: 'ssh1' } }
    assert.equal(provider.getDescription(partly), '10.0.0.5:NaN via an SSH profile')
    const plain = { type: 'rdp', name: 'Plain', options: { host: '10.0.0.5', port: 3390, username: 'alice', gateway: 'rdgw.example.com', via: '' } }
    assert.equal(provider.getDescription(plain), '10.0.0.5:3390 via the gateway rdgw.example.com')
    assert.equal(provider.intoQuickConnectString(plain), 'alice@10.0.0.5:3390')
})
