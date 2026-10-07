import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
class StandIn {}
for (const [name, exports] of Object.entries({
    'tabby-core': { AppService: StandIn, ConfigService: StandIn, PlatformService: StandIn },
    'tabby-settings': { SettingsTabComponent: StandIn },
})) {
    const id = require.resolve(name)
    require.cache[id] = { id, filename: id, loaded: true, exports } as any
}
const { RemoteDesktopHelp, TROUBLESHOOTING, TROUBLESHOOTING_URL, entryFor } = require('../../dist/help.js')

test('every error-specific help entry has a real Markdown anchor', () => {
    const doc = readFileSync(new URL('../../TROUBLESHOOTING.md', import.meta.url), 'utf8')
    for (const entry of TROUBLESHOOTING) {
        assert.ok(doc.includes(`<a id="${entry.id}"></a>`), entry.id)
    }
    assert.ok(doc.includes('<a id="recovery"></a>'))
    assert.equal(entryFor('Wrong user name or password').id, 'sign-in')
})

test('troubleshooting help opens only the fixed guide URL and known anchors, without opening a settings panel', () => {
    const opened: string[] = []
    const receiver = {
        platform: { openExternal: (url: string) => opened.push(url) },
        zone: { run: () => assert.fail('external help must not open a settings tab') },
    }
    RemoteDesktopHelp.prototype.open.call(receiver, 'troubleshooting', 'certificate')
    RemoteDesktopHelp.prototype.open.call(receiver, 'troubleshooting', 'unknown?url=other')
    assert.deepEqual(opened, [`${TROUBLESHOOTING_URL}#certificate`, TROUBLESHOOTING_URL])
})
