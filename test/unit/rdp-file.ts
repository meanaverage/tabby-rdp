// .rdp files (src/rdpFile.ts): what an import takes from one. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { parseRdpFile } = require('../../dist/rdpFile.js')
const { specOf } = require('../../dist/desktops.js')

/** A file as Remote Desktop Connection saves it: UTF-16LE with a byte order mark, CRLF lines. */
const rdp = (...lines: string[]) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]))

test('redirectclipboard:i:0 turns the clipboard off for that desktop, and isn\'t noted as not applied', () => {
    const parsed = parseRdpFile(rdp('full address:s:pc17.corp.example', 'redirectclipboard:i:0', 'redirectprinters:i:1'))
    assert.equal(parsed.host, 'pc17.corp.example')
    assert.equal(parsed.clipboard, 'off')
    assert.deepEqual(parsed.ignored, ['printer redirection (not supported)'])
    // The profile the import makes takes it (its options become the desktop's spec); without it, the profile has no
    // clipboard option at all, so that its group's and type's defaults apply (see test/unit/clipboard-service.ts).
    assert.equal(specOf({ host: parsed.host, port: parsed.port, ...parsed.clipboard ? { clipboard: parsed.clipboard } : {} }).clipboard, 'off')
    const imports = readFileSync(fileURLToPath(new URL('../../src/desktop.service.ts', import.meta.url)), 'utf8')
    assert.match(imports, /const fileClipboard = parsed\.clipboard \? \{ clipboard: parsed\.clipboard \} : \{\}/)
    assert.match(imports, /options: \{[^}]*,\s*\.\.\.fileClipboard,?\s*\}/)
})

test('a file never turns the clipboard on: redirectclipboard:i:1 (mstsc\'s default) leaves the setting to say', () => {
    for (const file of [rdp('full address:s:pc', 'redirectclipboard:i:1'), rdp('full address:s:pc'), rdp('full address:s:pc', 'redirectclipboard:i:')]) {
        const parsed = parseRdpFile(file)
        assert.equal(parsed.clipboard, undefined)
        assert.deepEqual(parsed.ignored, [])
        assert.equal(specOf({ host: parsed.host, port: parsed.port, ...parsed.clipboard ? { clipboard: parsed.clipboard } : {} }).clipboard, undefined)
    }
})

test('the clipboard is off however the file writes zero, and when any of its redirectclipboard lines says so', () => {
    for (const value of ['0', '00', '+0', '-0', ' 0 ']) {
        assert.equal(parseRdpFile(rdp('full address:s:pc', `redirectclipboard:i:${value}`)).clipboard, 'off', JSON.stringify(value))
    }
    // Said twice, differently, in either order: the narrower one.
    assert.equal(parseRdpFile(rdp('full address:s:pc', 'redirectclipboard:i:0', 'redirectclipboard:i:1')).clipboard, 'off')
    assert.equal(parseRdpFile(rdp('full address:s:pc', 'redirectclipboard:i:1', 'RedirectClipboard:i:0')).clipboard, 'off')
    // Any other number leaves the setting to say, as mstsc's default of 1 does.
    for (const value of ['1', '01', '2', '-1']) {
        assert.equal(parseRdpFile(rdp('full address:s:pc', `redirectclipboard:i:${value}`)).clipboard, undefined, value)
    }
})
