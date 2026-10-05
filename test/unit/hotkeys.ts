// How the desktop/console hotkey reads (src/help.ts, hotkeyLabel), from Tabby's config: a part named like something
// every object inherits ('constructor', 'toString') is text like any other, and a binding that isn't text is skipped
// rather than breaking the settings page or the first-connect tip. Runs against the built plugin: npm run build &&
// npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// help.js is an Angular service of Tabby's; only its plain functions are tested, so Tabby's packages are stand-ins.
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request === 'tabby-core' || request === 'tabby-settings' ? {} : load.call(this, request, ...rest)
}
const { hotkeyLabel } = require('../../dist/help.js')

/** hotkeyLabel as it reads on `platform`. */
function on (platform: string, binding: unknown): string | null {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform })
    try {
        return hotkeyLabel(binding)
    } finally {
        Object.defineProperty(process, 'platform', real)
    }
}

test('modifiers read as symbols on macOS, joined with + elsewhere', () => {
    assert.equal(on('darwin', ['⌘-Shift-G']), '⌘⇧G')
    assert.equal(on('darwin', ['Ctrl-Alt-Meta-Cmd-K']), '⌃⌥⌘⌘K')
    assert.equal(on('linux', ['Ctrl-Shift-G']), 'Ctrl+Shift+G')
    assert.equal(on('win32', [['Ctrl-K', 'Ctrl-D']]), 'Ctrl+K, Ctrl+D')
    assert.equal(on('darwin', []), null)
    assert.equal(on('darwin', undefined), null)
})

test('a part named like an inherited property is shown as written', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
        assert.equal(on('darwin', [`${name}-G`]), `${name}G`, name)
        assert.equal(on('linux', [`${name}-G`]), `${name}+G`, name)
    }
})

test('strokes that aren\'t text are skipped', () => {
    for (const binding of [[[1]], [[null]], [{}], [[{}, []]], [7]]) {
        assert.equal(on('darwin', binding), null, JSON.stringify(binding))
    }
    assert.equal(on('linux', [['Ctrl-K', 2, 'Ctrl-D']]), 'Ctrl+K, Ctrl+D')
})
