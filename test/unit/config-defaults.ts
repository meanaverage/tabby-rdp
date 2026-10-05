// Tabby's config proxy keeps only the keys a plugin's defaults name: a value written under any other key of
// `remoteDesktop` lasts until Tabby restarts and is never saved. 0.5.0 asked "Send the password anyway" again on every
// connection because `withoutNla` was missing from the defaults. Every key the plugin writes must be in its defaults
// (src/ui.ts). Reads the sources, nothing to build: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../../src/', import.meta.url))
const read = (file: string) => readFileSync(src + file, 'utf8')

/** The top-level keys of the `remoteDesktop: { … }` defaults in src/ui.ts. */
function defaultKeys (): Set<string> {
    const text = read('ui.ts')
    const start = text.indexOf('remoteDesktop: {')
    assert.ok(start >= 0, 'the remoteDesktop defaults are in src/ui.ts')
    const keys = new Set<string>()
    let depth = 0
    for (const line of text.slice(start).split('\n')) {
        const code = line.replace(/\/\/.*$/, '')
        const key = depth === 1 && /^\s*(\w+):/.exec(code)
        if (key) {
            keys.add(key[1])
        }
        for (const ch of code) {
            depth += '{['.includes(ch) ? 1 : '}]'.includes(ch) ? -1 : 0
        }
        if (depth === 0) {
            break
        }
    }
    return keys
}

/** The `remoteDesktop` keys the plugin assigns, directly or through `const store = this.config.store.remoteDesktop`. */
function writtenKeys (): Map<string, Set<string>> {
    const written = new Map<string, Set<string>>()
    const add = (key: string, file: string) => written.set(key, (written.get(key) ?? new Set()).add(file))
    for (const file of readdirSync(src).filter(f => f.endsWith('.ts'))) {
        const text = read(file)
        for (const match of text.matchAll(/config\.store\.remoteDesktop\.(\w+)\s*=(?!=)/g)) {
            add(match[1], file)
        }
        if (/const store = this\.config\.store\.remoteDesktop\b/.test(text)) {
            for (const match of text.matchAll(/\bstore\.(\w+)\s*=(?!=)/g)) {
                add(match[1], file)
            }
        }
    }
    return written
}

/** The keys of DesktopSettings (src/desktop.service.ts): what the settings page and the menus change, through updateSettings. */
function settingsKeys (): Set<string> {
    const text = read('desktop.service.ts')
    const start = text.indexOf('export interface DesktopSettings {')
    assert.ok(start >= 0, 'DesktopSettings is in src/desktop.service.ts')
    const body = text.slice(start, text.indexOf('\n}', start))
    return new Set([...body.matchAll(/^\s*(\w+)\??:/gm)].map(m => m[1]))
}

test('every setting the settings page and the menus change is in the defaults: updateSettings writes them all', () => {
    const keys = settingsKeys()
    assert.ok(keys.has('clipboard') && keys.has('sound') && keys.has('osd'), 'reads the settings')
    const defaults = defaultKeys()
    assert.deepEqual([...keys].filter(key => !defaults.has(key)), [])
})

test('every remoteDesktop setting the plugin writes is in its defaults, so Tabby saves it', () => {
    const defaults = defaultKeys()
    const missing = [...writtenKeys()].filter(([key]) => !defaults.has(key)).map(([key, files]) => `${key} (${[...files].join(', ')})`)
    assert.deepEqual(missing, [])
})

test('the scan finds the writes it guards', () => {
    const written = writtenKeys()
    for (const key of ['withoutNla', 'trustedCertificates', 'desktopSharpness', 'desktops', 'accounts']) {
        assert.ok(written.has(key), `finds writes of ${key}`)
    }
    assert.ok(defaultKeys().has('trustedCertificates') && defaultKeys().has('tipShown'), 'reads the defaults')
})
