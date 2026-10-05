// The desktop name overlay (src/osd.ts): its settings come from Tabby's config, which a config sync or a hand edit can
// fill with anything, and Tabby's window runs with Node, so markup made from them would be code. Names of what plain
// objects inherit ('constructor', '__proto__') aren't fonts or sizes; a color is a plain color, and none of it is ever
// parsed as HTML. A value that can't be read as a number is no number, rather than an error, and nothing about the
// overlay fails the connection it names. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const g = globalThis as any

// Chromium's CSS.supports takes any value with var() in it (the variable could hold anything), whatever follows; for the
// rest, something shaped like a color stands in for the real check.
g.CSS = { supports: (property: string, value: string) => property === 'color' && (/var\(/i.test(value) || /^(#[0-9a-f]{3,8}|[a-z]+|[a-z-]+\(.*\))$/i.test(value)) }

/** Just enough of the DOM for renderOsd, which must build nodes and set styles: parsing markup fails the test. */
class FakeElement {
    className = ''
    textContent = ''
    children: (FakeElement | { text: string })[] = []
    readonly properties = new Map<string, string>()
    readonly style = {
        cssText: '',
        setProperty: (property: string, value: string) => { this.properties.set(property, value) },
    }

    constructor (readonly offsetWidth = 0) { }

    set innerHTML (_: string) {
        throw new Error('markup was parsed')
    }

    append (...nodes: (FakeElement | { text: string })[]): void {
        this.children.push(...nodes)
    }

    replaceChildren (...nodes: FakeElement[]): void {
        this.children = nodes
    }
}
g.document = {
    createElement: () => new FakeElement(),
    createTextNode: (text: string) => ({ text }),
}

const { configNumber, osdSettings, renderOsd, osdColor, OSD_DEFAULTS, OSD_FONTS, OSD_SIZES } = require('../../dist/osd.js')

const INHERITED = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']
const BREAKOUT = 'var(--z,A)"><img src=x onerror=window.fired=true>'

test('fonts and sizes are the overlay\'s own: inherited names give the defaults', () => {
    for (const name of INHERITED) {
        const settings = osdSettings({ font: name, size: name })
        assert.equal(settings.font, OSD_DEFAULTS.font, name)
        assert.equal(settings.size, OSD_DEFAULTS.size, name)
    }
    assert.equal(osdSettings({ font: 'slender', size: 'huge' }).font, 'slender')
    assert.equal(osdSettings({ font: 'slender', size: 'huge' }).size, 'huge')
    assert.equal(osdSettings({ font: 7, size: null }).font, OSD_DEFAULTS.font)
})

test('a color is a plain color, else the default; var() and anything after it is refused', () => {
    for (const color of [BREAKOUT, 'var(--accent)', 'var(--x, red)', 'red;background:url(https://example.com/x)', 'rgb(0, 0, 0); background: url(x)',
        '#fff"><b>x</b>', 'rgb(var(--r), 0, 0)', 'color-mix(in srgb, red 50%, blue)', 'red !important', 'expression(alert(1))', ' red', '', 42, null]) {
        assert.equal(osdSettings({ color }).color, '', String(color))
    }
    for (const color of ['#ffcc00', '#fff', '#ffcc0080', 'red', 'rebeccapurple', 'rgb(255, 204, 0)', 'rgb(255 204 0 / 50%)', 'hsl(48deg 100% 50%)', 'oklch(70% 0.1 200)']) {
        assert.equal(osdSettings({ color }).color, color, color)
        assert.equal(osdColor(color), color, color)
    }
})

test('the overlay is built from nodes, styled property by property, whatever the settings say', () => {
    const el = new FakeElement(800)
    // As if the config had been handed over unchecked.
    renderOsd(el, 'workstation', 'via jumphost', { show: 'always', font: 'constructor', size: 'valueOf', position: 'bottom-left', color: BREAKOUT, seconds: 2 })
    const [glow, box] = el.children as FakeElement[]
    assert.equal(glow.className, 'trd-osd-glow')
    assert.match(glow.style.cssText, /bottom: 0; left: 0/)
    assert.equal(box.className, 'trd-osd-box')
    assert.match(box.style.cssText, /bottom: 20px; left: 24px/)
    assert.equal(box.properties.get('font-family'), OSD_FONTS[OSD_DEFAULTS.font].family)
    assert.equal(box.properties.get('font-size'), `${OSD_SIZES[OSD_DEFAULTS.size]}px`)
    assert.equal(box.properties.has('color'), false)
    const [name, sub] = box.children as FakeElement[]
    assert.equal(name.textContent, 'workstation')
    assert.equal(sub.className, 'trd-osd-sub')
    assert.deepEqual(sub.children.slice(1), [{ text: 'via jumphost' }])
})

test('a chosen color and font are applied', () => {
    const el = new FakeElement(800)
    renderOsd(el, 'workstation', '', osdSettings({ font: 'system', size: 'small', color: '#ffcc00', position: 'top-right' }))
    const box = el.children[1] as FakeElement
    assert.equal(box.properties.get('color'), '#ffcc00')
    assert.equal(box.properties.get('font-family'), OSD_FONTS.system.family)
    assert.equal(box.properties.get('font-size'), `${OSD_SIZES.small}px`)
    assert.equal((box.children[1] as FakeElement).children.length, 0)  // no second line: empty, so hidden
})

/** Objects a config can hold (YAML maps) that Number() can't turn into a number: it throws on them. */
const UNCONVERTIBLE = [{ valueOf: null, toString: null }, { valueOf: 5, toString: 'x' }, Object.create(null)]

test('numbers in the config: only a number or a string counts, and nothing in it makes reading them throw', () => {
    for (const value of UNCONVERTIBLE) {
        assert.throws(() => Number(value))
        assert.ok(Number.isNaN(configNumber(value)))
        assert.equal(osdSettings({ seconds: value }).seconds, OSD_DEFAULTS.seconds)
    }
    // An array or a date isn't a number of seconds either, though Number() would make one of it.
    assert.equal(osdSettings({ seconds: [7] }).seconds, OSD_DEFAULTS.seconds)
    assert.equal(osdSettings({ seconds: new Date(7000) }).seconds, OSD_DEFAULTS.seconds)
    assert.equal(osdSettings({ seconds: 7 }).seconds, 7)
    assert.equal(osdSettings({ seconds: '7' }).seconds, 7)
    assert.equal(osdSettings({ seconds: 99 }).seconds, OSD_DEFAULTS.seconds)
})

test('a desktop\'s port, or its wake port, that is neither a number nor text leaves out that desktop alone, and the wake port its default', () => {
    const { specOf, desktopsFor } = require('../../dist/desktops.js')
    const { parseWake } = require('../../dist/wake.js')
    const target = { key: 'alice@host:22', label: 'host' }
    for (const value of UNCONVERTIBLE) {
        assert.equal(specOf({ host: '10.0.0.5', port: value }), null)
        // The others listed with it still are.
        assert.deepEqual(desktopsFor(target, [{ via: 'host', host: '10.0.0.5', port: value }, { via: 'host', host: '10.0.0.6' }]).map((s: any) => s.id),
            ['own', '10.0.0.6:3389'])
        assert.deepEqual(parseWake({ mac: '00:11:22:33:44:55', port: value }), { mac: '00:11:22:33:44:55' })
    }
})

test('any other field of a desktop that is neither a number nor text leaves out that desktop, or that field, not the others', () => {
    const { desktopsFor } = require('../../dist/desktops.js')
    const target = { key: 'alice@host:22', label: 'host' }
    for (const value of UNCONVERTIBLE) {
        // A host, the host it is behind, a VM's id: that desktop isn't one. A name or a user name: it has none.
        assert.deepEqual(desktopsFor(target, [{ via: 'host', host: value }, { via: value, host: '10.0.0.7' }, { via: 'host', hyperv: value, host: '10.0.0.8' },
            { via: 'host', host: '10.0.0.6', name: value, username: value }]).map((s: any) => [s.id, s.name, s.username]),
        [['own', 'host desktop', undefined], ['10.0.0.8:3389', '10.0.0.8:3389', undefined], ['10.0.0.6:3389', '10.0.0.6:3389', undefined]])
    }
})

// The service's settings and its overlay, with Tabby's modules stubbed.
const decorator = () => () => undefined
const stubs: Record<string, unknown> = {
    '@angular/core': { Injectable: decorator, NgZone: class { } },
    'tabby-core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-settings': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { RemoteDesktopService } = require('../../dist/desktop.service.js')

function service (remoteDesktop: object) {
    const config = { store: { remoteDesktop }, save () { }, changed$: { subscribe () { } } }
    return new RemoteDesktopService({ tabs: [] }, {}, {}, config, {}, {}, {}, {}, {})
}

test('the settings read from any config without throwing: what can\'t be read takes its default', () => {
    for (const value of UNCONVERTIBLE) {
        const settings = service({ osd: { seconds: value, show: value, font: value, color: value }, shutDownIdle: value }).settings()
        assert.deepEqual([settings.osd.seconds, settings.osd.show, settings.osd.font, settings.osd.color, settings.shutDownIdle],
            [OSD_DEFAULTS.seconds, OSD_DEFAULTS.show, OSD_DEFAULTS.font, '', 0])
    }
    assert.equal(service({ shutDownIdle: '15' }).settings().shutDownIdle, 15)
})

test('the overlay can\'t fail the connection it names, reading its settings included', () => {
    const svc: any = service({})
    const session = {
        state: 'connected', visible: true, log: [] as string[], remote: { key: 'alice@host:22', label: 'host' },
        spec: { id: '10.0.0.5:3389', name: 'Windows VM' }, remoteSize: { width: 1920, height: 1080 },
        flashed: [] as string[],
        flashLabel (name: string, sub: string) { this.flashed.push(`${name} · ${sub}`) },
    }
    svc.label({}, session)
    assert.deepEqual(session.flashed, ['Windows VM · via host · 1920×1080'])
    // A config that can't even be read (a getter that throws stands in for whatever might).
    svc.config.store = { get remoteDesktop () { throw new Error('unreadable config') } }
    assert.doesNotThrow(() => svc.label({}, session))
    assert.deepEqual(session.log, ['overlay: unreadable config'])
    // Drawing it fails: the same.
    svc.config.store = { remoteDesktop: {} }
    session.flashLabel = () => { throw new Error('no room') }
    assert.doesNotThrow(() => svc.label({}, session))
    assert.deepEqual(session.log, ['overlay: unreadable config', 'overlay: no room'])
})
