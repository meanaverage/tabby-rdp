// Hyper-V VMs on a Windows SSH host (src/hyperv.ts, and their place among a host's desktops): what the host's
// PowerShell says, parsed. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { scanHyperV, hyperVState, startHyperV, vmId } = require('../../dist/hyperv.js')
const { scanVMs, vmSpec } = require('../../dist/vms.js')
const { specOf, desktopIdOf } = require('../../dist/desktops.js')
const { parseWake } = require('../../dist/wake.js')

const ID = '5f05e000-c4d4-499c-8cca-429587811556'
/** A host whose SSH shell answers `answers` in turn, and keeps the commands it was given. */
function host (...answers: string[]) {
    const commands: string[] = []
    return {
        commands,
        key: 'admin@hyperv:22',
        label: 'hyperv',
        exec: async (command: string) => { commands.push(command); return answers.shift() ?? '' },
    }
}
/** The script inside a `powershell -EncodedCommand` command line. */
const script = (command: string) => Buffer.from(command.split(' ').pop()!, 'base64').toString('utf16le')

test('VM ids: GUIDs, with or without braces, in any case', () => {
    assert.equal(vmId(ID.toUpperCase()), ID)
    assert.equal(vmId(`{${ID}}`), ID)
    assert.equal(vmId('not-a-guid'), '')
    assert.equal(vmId(`${ID}'; Remove-VM x`), '')
    assert.equal(vmId(undefined), '')
})

test('the scan lists the host\'s VMs, running or not; names may hold bars and spaces', async () => {
    const target = host(`noise\r\nTRD_HV ${ID.toUpperCase()}|Running|Build VM\r\nTRD_HV 72faa050-80d1-48f7-9065-22bae9d70fd3|Off|odd|name\r\nTRD_HV bad|Running|x\r\n`)
    assert.deepEqual(await scanHyperV(target), [
        { id: ID, name: 'Build VM', state: 'running' },
        { id: '72faa050-80d1-48f7-9065-22bae9d70fd3', name: 'odd|name', state: 'off' },
    ])
    assert.match(target.commands[0], /^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    assert.match(script(target.commands[0]), /Get-VM/)
})

test('a host without a sh is asked for Hyper-V VMs; one with a sh is not', async () => {
    const windows = host('', `TRD_HV ${ID}|Off|Build VM\r\n`)
    const found = await scanVMs(windows)
    assert.equal(windows.commands.length, 2)
    assert.deepEqual(found.map(vmSpec), [{
        id: `hyperv:${ID}`, name: 'Build VM', kind: 'windows', host: '127.0.0.1', port: 2179, hyperv: ID, wake: { hyperv: ID }, found: 'off',
    }])
    const linux = host('TRD_SH\n')
    assert.deepEqual(await scanVMs(linux), [])
    assert.equal(linux.commands.length, 1)
    // Once known to run Windows, a host is asked for Hyper-V VMs only.
    const known = { windows: undefined as boolean | undefined }
    await scanVMs(host('', ''), known)
    assert.equal(known.windows, true)
    const again = host(`TRD_HV ${ID}|Running|Build VM\r\n`)
    assert.equal((await scanVMs(again, known)).length, 1)
    assert.equal(again.commands.length, 1)
    assert.match(again.commands[0], /^powershell /)
})

test('a VM\'s state: running or not, and whether it takes an enhanced session now', async () => {
    assert.deepEqual(await hyperVState(host('TRD_HV_STATE Running|2\r\n'), ID), { running: true, enhanced: true })
    assert.deepEqual(await hyperVState(host('TRD_HV_STATE Running|3\r\n'), ID), { running: true, enhanced: false })
    assert.deepEqual(await hyperVState(host('TRD_HV_STATE Off|\r\n'), ID), { running: false, enhanced: false })
    await assert.rejects(hyperVState(host('TRD_HV_ERR You do not have the required permission\r\n'), ID), /required permission/)
    await assert.rejects(hyperVState(host(''), ID), /didn't answer about the VM/)
    const target = host('TRD_HV_STATE Running|2')
    await hyperVState(target, ID.toUpperCase())
    assert.ok(script(target.commands[0]).includes(`Get-VM -Id '${ID}'`))
})

test('starting a VM says what was done, or why not', async () => {
    assert.equal(await startHyperV(host('TRD_HV_OK Build VM started\r\n'), ID), 'Build VM started')
    await assert.rejects(startHyperV(host('TRD_HV_ERR not enough memory\r\n'), ID), /not enough memory/)
})

test('a configured Hyper-V VM is a desktop of its host, started when off', () => {
    const spec = specOf({ name: 'Build VM', via: 'hyperv', hyperv: `{${ID.toUpperCase()}}`, account: 'k1' })
    assert.deepEqual(spec, { id: `hyperv:${ID}`, name: 'Build VM', kind: 'windows', host: '127.0.0.1', port: 2179, hyperv: ID, wake: { hyperv: ID }, username: undefined, domain: undefined, account: 'k1' })
    assert.equal(desktopIdOf({ hyperv: ID }), `hyperv:${ID}`)
    assert.deepEqual(parseWake({ hyperv: ID }), { hyperv: ID })
    assert.equal(parseWake({ hyperv: 'nope' }), undefined)
})
