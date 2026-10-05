// The form a desktop behind an SSH host is added and edited with (src/desktopForm.ts), as far as whose word its kind is:
// a VM saved from a host's list is xrdp on the host's word, and asks before signing in without Network Level
// Authentication, until the user picks a kind there; a kind picked is the user's. Runs against the built plugin, with
// just enough of the DOM for the form: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const g = globalThis as any

/** A form field, a label or a list, as the form uses them. */
class Element {
    value = ''
    hidden = false
    readOnly = false
    title = ''
    textContent = ''
    className = ''
    readonly style: Record<string, string> = {}
    readonly options: { text: string, value: string }[] = []
    readonly listeners: Record<string, ((event: any) => void)[]> = {}
    readonly fields: Record<string, Element> = {}

    set innerHTML (_: string) { }
    append (...options: { text: string, value: string }[]): void { this.options.push(...options) }
    prepend (...options: { text: string, value: string }[]): void { this.options.unshift(...options) }
    addEventListener (type: string, listener: (event: any) => void): void { (this.listeners[type] ??= []).push(listener) }
    removeEventListener (): void { }
    querySelector (selector: string): Element {
        const name = /^\[name="(.+)"\]$/.exec(selector)?.[1] ?? selector
        return this.fields[name] ??= new Element()
    }
    querySelectorAll (): Element[] { return [] }
    appendChild (child: Element): Element { return child }
    contains (): boolean { return false }
    focus (): void { }
    remove (): void { }
}
const overlay = new Element()
const form = overlay.querySelector('form')
g.document = { createElement: () => overlay, activeElement: null }
g.getComputedStyle = () => ({ position: 'relative' })
g.Option = class { constructor (readonly text = '', readonly value = text) { } }

const { askDesktop } = require('../../dist/desktopForm.js')
const { specOf, xrdpUnasked } = require('../../dist/desktops.js')

/** Opens the form on `entry`, lets `edit` change its fields as the user would, and submits it. */
async function submitted (entry: Record<string, unknown>, edit: (field: (name: string) => Element) => void = () => { }): Promise<any> {
    for (const name of Object.keys(form.fields)) {
        delete form.fields[name]
    }
    const result = askDesktop(new Element(), { title: 'Edit', action: 'Save', entry, clipboard: 'both' })
    edit(name => form.querySelector(`[name="${name}"]`))
    form.listeners.submit.at(-1)!({ preventDefault () { } })
    return await result
}

// As 0.3.0 to 0.5.0 saved a VM from a host's list: no mark, the host's kind, started by its name.
const legacy = { name: 'FakeVM', via: 'h', host: '10.9.9.9', port: 3389, kind: 'xrdp', wake: { vm: 'FakeVM' } }

test('a VM saved from a host\'s list shows its kind as the host\'s, and keeps it so when saved unchanged', async () => {
    let kind: Element | undefined
    const entry = await submitted(legacy, field => { kind = field('kind') })
    assert.equal(kind!.options[0].value, '')
    assert.match(kind!.options[0].text, /^xrdp, as h reported \(asks before signing in without NLA\)$/)
    assert.deepEqual([entry.kind, entry.kindFromHost], ['xrdp', true])
    assert.equal(xrdpUnasked(specOf(entry)), false)
    // A name changed, the rest left: the same.
    const renamed = await submitted({ ...legacy, kindFromHost: true }, field => { field('name').value = 'Build box' })
    assert.deepEqual([renamed.name, renamed.kind, renamed.kindFromHost], ['Build box', 'xrdp', true])
})

test('a kind picked in the form is the user\'s, xrdp too', async () => {
    const picked = await submitted(legacy, field => { field('kind').value = 'xrdp' })
    // Still started by the VM's name: marked as the user's, or it would read as a VM saved before the mark.
    assert.deepEqual([picked.kind, picked.kindFromHost], ['xrdp', false])
    assert.equal(xrdpUnasked(specOf(picked)), true)
    // Saved again: no question about its kind any more, and it stays the user's.
    let kind: Element | undefined
    const again = await submitted(picked, field => { kind = field('kind') })
    assert.ok(!kind!.options.some(o => o.value === ''))
    assert.equal(again.kindFromHost, false)
    assert.equal(xrdpUnasked(specOf(again)), true)
    // Marked by the save, without a VM to start: no mark needed.
    const marked = await submitted({ ...legacy, wake: undefined, kindFromHost: true }, field => { field('kind').value = 'xrdp' })
    assert.equal('kindFromHost' in marked, false)
    assert.equal(xrdpUnasked(specOf(marked)), true)
    // Another kind: the user's as well.
    const windows = await submitted(legacy, field => { field('kind').value = 'windows' })
    assert.deepEqual([windows.kind, 'kindFromHost' in windows], ['windows', false])
})

test('a desktop the user added stays the user\'s, a VM to start by its name or not', async () => {
    const added = await submitted({ via: 'h', host: '127.0.0.1', port: 3389 }, field => {
        field('name').value = 'Lab VM'
        field('address').value = '192.168.122.20'
        field('kind').value = 'xrdp'
        field('wake').value = 'labvm'
    })
    assert.deepEqual([added.kind, added.wake, added.kindFromHost], ['xrdp', { vm: 'labvm' }, false])
    assert.equal(xrdpUnasked(specOf(added)), true)
    const plain = await submitted({ name: 'Mine', via: 'h', host: '10.0.0.7', port: 3389, kind: 'xrdp' })
    assert.equal('kindFromHost' in plain, false)
    assert.equal(xrdpUnasked(specOf(plain)), true)
})
