// The update check (src/updates.ts) reads npm's answer within limits of size and time: whoever answers in npm's name
// can't keep it waiting for good, or have Tabby keep all it sends. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as http from 'node:http'
import * as net from 'node:net'
import { Subject } from 'rxjs'

const require = createRequire(import.meta.url)
// What updates.ts imports from Tabby needs a running Tabby, and none of it is used here: stand-ins let it load.
class StandIn { }
for (const [name, exports] of Object.entries({
    'tabby-core': { AppService: StandIn, ConfigService: StandIn, PlatformService: StandIn, SplitTabComponent: StandIn },
    'tabby-settings': { SettingsTabComponent: StandIn },
})) {
    const id = require.resolve(name)
    require.cache[id] = { id, filename: id, loaded: true, exports } as any
}
const { latestVersion, newer, UpdateCheck } = require('../../dist/updates.js')
const { RELEASE_STATE_KEY } = require('../../dist/releases.js')

/** A stand-in registry that answers each request with `answer`: where it is, and closing it. */
async function registry (answer: (response: http.ServerResponse) => void) {
    const server = http.createServer((_request, response) => answer(response))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return {
        url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/tabby-rdp/latest`,
        close: () => {
            server.closeAllConnections()
            server.close()
        },
    }
}

test('the latest version, as the registry says', async t => {
    const npm = await registry(response => response.end(JSON.stringify({ name: 'tabby-rdp', version: '9.8.7' })))
    t.after(npm.close)
    assert.equal(await latestVersion(npm.url), '9.8.7')
    assert.equal(newer('9.8.7', '0.5.0'), true)
})

test('an answer that doesn\'t end is cut off at its limit', async t => {
    const npm = await registry(response => {
        response.write('{"version":"9.9.9","pad":"')
        const more = setInterval(() => response.write('x'.repeat(64 * 1024)), 5)
        response.on('close', () => clearInterval(more))
    })
    t.after(npm.close)
    const started = Date.now()
    await assert.rejects(latestVersion(npm.url, 10000, 256 * 1024), /too large/)
    assert.ok(Date.now() - started < 5000)
})

test('a registry that never answers is given up on', async t => {
    const npm = await registry(() => { })
    t.after(npm.close)
    const started = Date.now()
    await assert.rejects(latestVersion(npm.url, 300))
    assert.ok(Date.now() - started < 5000)
})

test('registry HTTP failures cannot be mistaken for a version', async t => {
    const npm = await registry(response => { response.statusCode = 503; response.end('{"version":"9.8.7"}') })
    t.after(npm.close)
    await assert.rejects(latestVersion(npm.url), /503/)
})

test('malformed registry JSON is reported as a failure', async t => {
    const npm = await registry(response => response.end('not JSON'))
    t.after(npm.close)
    await assert.rejects(latestVersion(npm.url))
})

test('startup waits for configuration and migrates the old update switch without replacing local preferences', async t => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    t.after(() => {
        for (const [name, descriptor] of [['window', windowDescriptor], ['navigator', navigatorDescriptor]] as const) {
            if (descriptor) { Object.defineProperty(globalThis, name, descriptor) }
            else { delete (globalThis as any)[name] }
        }
    })
    for (const [legacyCheck, savedPause, expectedPause] of [[true, undefined, false], [false, undefined, true], [false, false, false]] as const) {
        let saved = savedPause === undefined ? null : JSON.stringify({ channel: 'stable', paused: savedPause, rollbackFloor: '0.5.1' })
        Object.defineProperty(globalThis, 'window', { configurable: true, value: {
            localStorage: { getItem: (key: string) => { assert.equal(key, RELEASE_STATE_KEY); return saved }, setItem: (_key: string, value: string) => { saved = value } },
            addEventListener: () => {},
        } })
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, run: () => Promise<void>) => run() } } })
        const config: any = { store: undefined, ready$: new Subject<boolean>() }
        const updates = new UpdateCheck(config, {}, {}, { getAppVersion: () => assert.fail('host metadata comes from compatibility') }, {}, { info: { version: '1.0.238' } })
        await updates.ready
        assert.equal(updates.state.paused, savedPause ?? true)
        config.store = { remoteDesktop: { checkUpdates: legacyCheck } }
        config.ready$.next(true)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(updates.state.paused, expectedPause)
        assert.equal(JSON.parse(saved!).paused, expectedPause)
    }
})
