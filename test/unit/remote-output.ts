// What an SSH host sends back to the plugin's commands (src/ssh.ts, execRemote; src/vms.ts and src/hyperv.ts, the
// VM scans that run on their own while an SSH tab is active): kept up to a limit, and parsed in time that grows with
// it, not its square. A host decides what it sends, whatever the command asked for. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)

// Tabby and Angular, as far as loading the desktop service and its menus needs them (for the VM list's menu).
const decorator = () => () => undefined
const stubs: Record<string, unknown> = {
    '@angular/core': { Injectable: decorator, NgZone: class { } },
    'tabby-core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-settings': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
    'tabby-terminal': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { execRemote, MAX_OUTPUT } = require('../../dist/ssh.js')
const { scanVMs } = require('../../dist/vms.js')
const { scanHyperV, hyperVState, MAX_VMS } = require('../../dist/hyperv.js')
const { Subject } = require('rxjs')

v8.setFlagsFromString('--expose-gc')
const gc: () => void = vm.runInNewContext('gc')
const soon = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * An SSH tab whose host answers each command with `answer` (pieces of output, in order) and then closes the channel,
 * whatever the command was; `late` arrives after the close, where Tabby's russh binding keeps it (see execRemote).
 */
function host (answer: () => Iterable<Uint8Array>, late: Uint8Array[] = []) {
    const seen = { closedByClient: false, sent: 0 }
    const channel = {
        id: 1,
        data$: new Subject(),
        closed$: new Subject(),
        async requestExec () { },
        async write () { },
        async eof () {
            setImmediate(async () => {
                for (const piece of answer()) {
                    // A host that is told to stop stops: the channel is closed.
                    if (seen.closedByClient) {
                        break
                    }
                    seen.sent += piece.byteLength
                    channel.data$.next(piece)
                    await new Promise(resolve => setImmediate(resolve))
                }
                channel.closed$.next()
            })
        },
        async close () { seen.closedByClient = true },
    }
    const events = {
        data$: {
            subscribe: () => ({ subscribe: (take: (d: Uint8Array) => void) => { late.splice(0).forEach(take); return { unsubscribe () { } } } }),
            closeChannel () { },
        },
    }
    const ssh = { events, openTCPForwardChannel () { }, async openSessionChannel () { return {} }, async activateChannel () { return channel } }
    return { seen, tab: { profile: { type: 'ssh' }, element: { nativeElement: {} }, sshSession: { open: true, ssh } } }
}

const text = (s: string) => new TextEncoder().encode(s)

test('a command\'s output: up to the end marker, which can come in two pieces', async () => {
    const { tab } = host(() => [text('one\ntwo\n__trd_ex'), text('ec_end__\n')])
    assert.equal(await execRemote(tab, 'true'), 'one\ntwo\n')
})

test('output that comes after the channel closed is still picked up', async () => {
    const { tab } = host(() => [text('first\n')], [text('second\n__trd_exec_end__\n')])
    assert.equal(await execRemote(tab, 'true'), 'first\nsecond\n')
})

test('a host that sends more than a command prints gets an error, and is stopped', async () => {
    const megabyte = new Uint8Array(1024 * 1024).fill(0x41)
    const { tab, seen } = host(function * () {
        for (let i = 0; i < 64; i++) {
            yield megabyte
        }
    })
    await assert.rejects(execRemote(tab, 'sh -s'), /more than 4 MB/)
    assert.ok(seen.closedByClient, 'the channel was closed')
    assert.ok(seen.sent <= MAX_OUTPUT + megabyte.length, `stopped at the limit, not after ${seen.sent} bytes`)
})

/** A host whose shell answers each command with the next of `answers`. */
const target = (...answers: string[]) => ({ key: 'u@h:22', label: 'h', exec: async () => answers.shift() ?? '' })

test('a VM scan answered with a great many VMs: a few hundred are listed, and quickly', async () => {
    const lines: string[] = ['TRD_SH']
    for (let i = 0; i < 100000; i++) {
        lines.push(`TRD_VM vm${i}|off|http://microsoft.com/win/10|10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}|`)
    }
    const started = performance.now()
    const found = await scanVMs(target(lines.join('\n')), {})
    assert.equal(found.length, MAX_VMS)
    assert.ok(performance.now() - started < 2000, `took ${performance.now() - started} ms`)
    // Repeated names count once.
    assert.equal((await scanVMs(target('TRD_SH\n' + 'TRD_VM a|off|http://microsoft.com/win/10|10.0.0.1|\n'.repeat(1000)), {})).length, 1)
})

test('a Hyper-V scan answered with a great many VMs: a few hundred are listed, and quickly', async () => {
    const lines: string[] = []
    for (let i = 0; i < 100000; i++) {
        lines.push(`TRD_HV ${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000|Off|vm${i}`)
    }
    const started = performance.now()
    const listed: { cut?: boolean } = {}
    const found = await scanHyperV(target(lines.join('\r\n')), listed)
    assert.equal(found.length, MAX_VMS)
    assert.ok(performance.now() - started < 2000, `took ${performance.now() - started} ms`)
    assert.equal(listed.cut, true)
    // Exactly as many as are listed: none left out.
    assert.equal((await scanHyperV(target(lines.slice(0, MAX_VMS).join('\r\n')), listed)).length, MAX_VMS)
    assert.equal(listed.cut, false)
})

test('a host with more VMs than a menu lists: the first ones are listed, and the menu says that only so many are', async () => {
    const { RemoteDesktopService } = require('../../dist/desktop.service.js')
    const { desktopChoices } = require('../../dist/ui.js')
    const vms = (count: number) => ['TRD_SH', ...Array.from({ length: count }, (_, i) => `TRD_VM vm${i}|running|http://microsoft.com/win/10|10.0.${i >> 8}.${i & 255}|2`)].join('\n')
    // Exactly as many as are listed: none left out, nothing said.
    for (const [count, listed, said] of [[300, MAX_VMS, true], [MAX_VMS + 1, MAX_VMS, true], [MAX_VMS, MAX_VMS, false], [MAX_VMS - 1, MAX_VMS - 1, false]] as const) {
        const host = { key: 'u@h:22', label: 'h', exec: async () => vms(count), isOpen: () => true }
        const config = { store: { remoteDesktop: { desktops: [], accounts: [] }, profiles: [] }, save () { }, changed$: { subscribe () { } } }
        const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() }
        const svc = new RemoteDesktopService({ tabs: [] }, { cached: () => host }, {}, config, zone, {}, {}, {}, {})
        await svc.discoverVMs(host)
        const items = desktopChoices(svc, {}, 'h')
        assert.equal(items.filter((item: any) => / \(VM\)$/.test(item.label)).length, listed, `${count} VMs`)
        assert.equal(items.some((item: any) => item.label === `Only the first ${MAX_VMS} VMs found are listed` && item.enabled === false), said, `${count} VMs`)
    }
})

test('a Hyper-V scan answered with a name of 100,000 spaces is read at once, and that line passed over', async () => {
    // A pattern for the line (a name, then trailing spaces left out) tried each way of sharing the spaces between the
    // two when something other than a space followed them: seconds for this line, hours for the 4 MB a host may send.
    // A CR or a Unicode line separator in it is no name PowerShell prints either.
    for (const end of ['b', '\rX', ' X']) {
        const started = performance.now()
        const found = await scanHyperV(target(`TRD_HV 00000000-0000-4000-8000-000000000001|Off|a${' '.repeat(100000)}${end}\r\n` +
            'TRD_HV 00000000-0000-4000-8000-000000000002|Running|Build VM  \r\n'))
        assert.ok(performance.now() - started < 1000, `${JSON.stringify(end)}: took ${Math.round(performance.now() - started)} ms`)
        assert.deepEqual(found, [{ id: '00000000-0000-4000-8000-000000000002', name: 'Build VM', state: 'running' }])
    }
})

test('a VM\'s state, answered with a great many lines that aren\'t it, is read at once', async () => {
    // Read line by line: a pattern over the whole answer let a part of it run from each line to the end of the answer.
    const started = performance.now()
    await assert.rejects(hyperVState(target('TRD_HV_STATE abcdefgh\n'.repeat(16000)), '00000000-0000-4000-8000-000000000001'), /didn't answer about the VM/)
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`)
    // The host's reason for an error goes into what the desktop shows: as much of it as a line of the scan may be.
    await assert.rejects(hyperVState(target(`TRD_HV_ERR ${'x'.repeat(100000)}\r\n`), '00000000-0000-4000-8000-000000000001'), (e: Error) => e.message === 'x'.repeat(1024))
})

test('the setup\'s answer goes into the error it makes only as far as a status line shows it', async () => {
    const { prepareRemoteDesktop } = require('../../dist/remoteSetup.js')
    // A certificate's fingerprint that isn't one, as long as an answer may be: as much of it as a fingerprint takes.
    const cert = 'x'.repeat(MAX_OUTPUT - 100)
    await assert.rejects(prepareRemoteDesktop(target(`RD_OK port=3389 user=tabby pass=secret cert=${cert}\n`), false),
        (e: Error) => e.message === `Remote setup reported no usable certificate fingerprint (${'x'.repeat(100)})`)
    // The host's reason for an error: 1,000 characters.
    await assert.rejects(prepareRemoteDesktop(target(`RD_ERR ${'y'.repeat(100000)}\n`), false), (e: Error) => e.message === 'y'.repeat(1000))
})

/**
 * An SSH tab whose server stops answering at `stage`: it never confirms the channel (`open`, `activate`) or the
 * command (`exec`). `flood`: it sends more than a command may print while the command is being started.
 */
function stalling (stage: 'open' | 'activate' | 'exec', flood = false) {
    const never = new Promise<never>(() => { })
    const seen = { closedByClient: false }
    const channel = {
        id: 1,
        data$: new Subject(),
        closed$: new Subject(),
        requestExec () {
            for (let i = 0; flood && i < 5; i++) {
                channel.data$.next(new Uint8Array(1024 * 1024))
            }
            return stage === 'exec' ? never : Promise.resolve()
        },
        async write () { },
        async eof () { },
        async close () { seen.closedByClient = true },
    }
    const events = { data$: { subscribe: () => ({ subscribe: () => ({ unsubscribe () { } }) }), closeChannel () { } } }
    const ssh = {
        events,
        openTCPForwardChannel () { },
        openSessionChannel: () => stage === 'open' ? never : Promise.resolve({}),
        activateChannel: () => stage === 'activate' ? never : Promise.resolve(channel),
    }
    return { seen, tab: { profile: { type: 'ssh' }, element: { nativeElement: {} }, sshSession: { open: true, ssh } } }
}

/** What `exec` comes to within `ms`: its output, its error's message, or that it is still waiting. */
const within = (exec: Promise<string>, ms: number) => Promise.race([exec.then(out => `answered: ${out}`, (e: Error) => e.message), soon(ms).then(() => 'still waiting')])

test('a server that stops answering while a command is being started: the command\'s time runs out all the same', async () => {
    // A VM scan, or a desktop's setup, would otherwise wait for good: the time limit started only once the command had
    // been sent and its input closed.
    for (const stage of ['open', 'activate', 'exec'] as const) {
        assert.match(await within(execRemote(stalling(stage).tab, 'true', '', 200), 3000), /timed out after 0\.2s/, stage)
    }
})

test('a server that floods while a command is being started is stopped at the limit, not waited on', async () => {
    const { tab, seen } = stalling('exec', true)
    assert.match(await within(execRemote(tab, 'true'), 3000), /more than 4 MB/)
    assert.ok(seen.closedByClient, 'the channel was closed')
})

test('a command\'s output may be 4 MB, end marker and all; a byte more is an error', async () => {
    const answer = (size: number) => text('A'.repeat(size - '__trd_exec_end__\n'.length) + '__trd_exec_end__\n')
    assert.equal((await execRemote(host(() => [answer(MAX_OUTPUT)]).tab, 'true')).length, MAX_OUTPUT - '__trd_exec_end__\n'.length)
    await assert.rejects(execRemote(host(() => [answer(MAX_OUTPUT + 1)]).tab, 'true'), /more than 4 MB/)
})

test('output that comes a byte at a time is kept as bytes, not as a piece of memory per byte', async () => {
    // A host can send its answer a byte per message. Kept as it came, each byte cost a Buffer of its own: about 110 bytes
    // of Tabby's memory, 450 MB for the 4 MB an answer may be. Here 400,000 of them.
    let grown = 0
    const piece = new Uint8Array([0x41])
    const channel = {
        id: 1,
        data$: new Subject(),
        closed$: new Subject(),
        async requestExec () { },
        async write () { },
        async eof () {
            setImmediate(async () => {
                gc()
                const before = process.memoryUsage().heapUsed
                for (let i = 0; i < 400000; i++) {
                    channel.data$.next(piece)
                    if (i % 1000 === 0) {
                        await new Promise(resolve => setImmediate(resolve))
                    }
                }
                gc()
                grown = process.memoryUsage().heapUsed - before
                channel.data$.next(text('__trd_exec_end__\n'))
                channel.closed$.next()
            })
        },
        async close () { },
    }
    const events = { data$: { subscribe: () => ({ subscribe: () => ({ unsubscribe () { } }) }), closeChannel () { } } }
    const ssh = { events, openTCPForwardChannel () { }, async openSessionChannel () { return {} }, async activateChannel () { return channel } }
    const out = await execRemote({ profile: { type: 'ssh' }, element: { nativeElement: {} }, sshSession: { open: true, ssh } }, 'true')
    assert.equal(out, 'A'.repeat(400000))
    assert.ok(grown < 8 * 1024 * 1024, `${Math.round(grown / 1024 / 1024)} MB kept for 400,000 bytes`)
})
