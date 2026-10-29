// The keyboard's router (src/keyboard.ts), with Tabby's modules stubbed: a key typed while a desktop has the focus
// though its pane isn't the one the user is in goes nowhere, view only or not, rather than on to IronRDP, whose listener
// comes after the router's and only looks at the focus (security review, findings 7 and 8). Runs against the built
// plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const decorator = () => () => undefined
const stubs: Record<string, unknown> = {
    '@angular/core': { Injectable: decorator, Component: decorator, NgZone: class { }, ViewEncapsulation: {} },
    'tabby-core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-settings': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-terminal': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { DesktopKeyboard } = require('../../dist/keyboard.js')
import { FakeElement, installDocument } from './support/dom.js'

/** A pane of Tabby's, with a desktop's component in it. */
function pane (type: string) {
    const element = new FakeElement()
    const desktop = element.appendChild(new FakeElement('iron-remote-desktop'))
    return { profile: { type }, element: { nativeElement: element }, desktop }
}

/** A key event as the router gets it: whether it was stopped there. */
function key (type: string, code: string) {
    return {
        type, code, key: code.replace(/^Key/, '').toLowerCase(), location: 0, repeat: false,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
        stopped: false, prevented: false,
        stopImmediatePropagation () { this.stopped = true },
        preventDefault () { this.prevented = true },
    }
}

test('typing into all retains AltGraph character semantics for other Unicode desktops', t => {
    const page = installDocument(); t.after(page.restore)
    const current = pane('rdp'), app = { activeTab: current }, mirrored: any[] = []
    const desktop = { isVisible: () => true, isViewOnly: () => false, settings: () => ({ macShortcuts: false }),
        isBroadcast: () => false, pasteClipboardFiles: () => false,
        broadcastKey: (_pane: unknown, _type: string, init: unknown) => mirrored.push(init) }
    const keyboard = new DesktopKeyboard(app, {}, desktop, {})
    current.desktop.focus()
    keyboard.route(Object.assign(key('keydown', 'KeyQ'), { key: '@', ctrlKey: true, altKey: true, getModifierState: (name: string) => name === 'AltGraph' }))
    assert.equal(mirrored.length, 1)
    assert.equal(mirrored[0].modifierAltGraph, true)
})

test('a key typed while a desktop has the focus in a pane the user isn\'t in goes nowhere, view only or not', t => {
    const page = installDocument()
    t.after(page.restore)
    const app = { activeTab: null as unknown }
    const viewOnly = new Set<unknown>()
    const mirrored: string[] = []
    const desktop = {
        isVisible: () => true,
        isViewOnly: (p: unknown) => viewOnly.has(p),
        isBroadcast: () => false,
        pasteClipboardFiles: () => false,
        settings: () => ({ macShortcuts: false }),
        broadcastKey: (_p: unknown, type: string, init: { code: string }) => mirrored.push(`${type} ${init.code}`),
    }
    const keyboard = new DesktopKeyboard(app, {}, desktop, {})
    const route = (event: ReturnType<typeof key>) => {
        keyboard.route(event)
        return event.stopped && event.prevented
    }
    const office = pane('rdp')
    const lab = pane('rdp')
    const settings = { title: 'Settings' }

    // In the pane the user is in, the key goes on to IronRDP.
    app.activeTab = office
    office.desktop.focus()
    assert.equal(route(key('keydown', 'KeyA')), false)
    // Ctrl+Tab to Settings left the focus on the desktop (finding 8): stopped, keydown and keyup.
    app.activeTab = settings
    assert.equal(route(key('keydown', 'KeyP')), true)
    assert.equal(route(key('keyup', 'KeyP')), true)
    // The pointer passed over another pane's desktop (finding 7): stopped.
    app.activeTab = office
    lab.desktop.focus()
    assert.equal(route(key('keydown', 'KeyW')), true)
    // View only: stopped there as everywhere.
    viewOnly.add(lab)
    assert.equal(route(key('keydown', 'KeyW')), true)
    // Nothing else is the router's: a terminal's keys go on.
    const typing = new FakeElement('textarea')
    typing.focus()
    assert.equal(route(key('keydown', 'KeyL')), false)
    // Only the key typed in front went on to the desktop (and, typing into all, would to the others).
    assert.deepEqual(mirrored, ['keydown KeyA'])
})

test('a shortcut switching tabs between capture and routing does not reach the previous desktop', t => {
    const page = installDocument(); t.after(page.restore)
    const current = pane('rdp'), app = { activeTab: current as unknown }, mirrored: string[] = []
    const desktop = { isVisible: () => true, isViewOnly: () => false, settings: () => ({ macShortcuts: false }),
        isBroadcast: () => false, pasteClipboardFiles: () => false,
        broadcastKey: (_pane: unknown, _type: string, init: { code: string }) => mirrored.push(init.code) }
    const keyboard = new DesktopKeyboard(app, {}, desktop, {})
    const event = Object.assign(key('keydown', 'Digit3'), { key: '3', ctrlKey: true })
    current.desktop.focus()
    keyboard.startedOn.set(event, current)
    // The host's document listener has switched tabs, while the previous desktop still has DOM focus.
    app.activeTab = { title: 'Settings' }
    keyboard.route(event)
    assert.equal(event.stopped, true)
    assert.equal(event.prevented, true)
    assert.deepEqual(mirrored, [])
})
