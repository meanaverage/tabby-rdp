// The plugin's commands and tunnels through an ssh it runs (src/targets.ts): the system `ssh`, for an ssh typed in a
// local terminal, and the `ssh` typed in an SSH tab's console, run on that tab's host. What comes back is the far
// host's to decide: it is kept up to a limit and read in time that grows with it, and ssh's own failures are told
// apart from the command's output. Tabby's modules are stubbed, and the system `ssh` is a stand-in script.
// Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)

// Tabby and Angular, as far as loading the targets needs them.
const decorator = () => () => undefined
const stubs: Record<string, unknown> = {
    '@angular/core': { Injectable: decorator },
    'tabby-core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } }),
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { RemoteTargets, SystemSSHTarget } = require('../../dist/targets.js')
const { MAX_OUTPUT } = require('../../dist/ssh.js')
const { Subject } = require('rxjs')

v8.setFlagsFromString('--expose-gc')
const gc: () => void = vm.runInNewContext('gc')

/** An SSH tab (as tabby-ssh has it) whose host answers each command with the next of `answers`, then closes the channel. */
function sshTab (...answers: string[]) {
    const commands: string[] = []
    const ssh = {
        events: { data$: { subscribe: () => ({ subscribe: () => ({ unsubscribe () { } }) }), closeChannel () { } } },
        openTCPForwardChannel () { },
        async openSessionChannel () { return {} },
        async activateChannel () {
            const channel = {
                id: 1,
                data$: new Subject(),
                closed$: new Subject(),
                async requestExec (command: string) { commands.push(command) },
                async write () { },
                async eof () {
                    setImmediate(() => {
                        channel.data$.next(new TextEncoder().encode(`${answers.shift() ?? ''}__trd_exec_end__\n`))
                        channel.closed$.next()
                    })
                },
                async close () { },
            }
            return channel
        },
    }
    return { commands, tab: { profile: { type: 'ssh', options: { host: 'h', user: 'u', port: 22 } }, element: { nativeElement: {} }, sshSession: { open: true, ssh } } }
}

/**
 * A machine reached with `ssh inner` typed in an SSH tab on host `h`, as the plugin finds it (RemoteTargets.nestedTarget);
 * `answers`: what each command run through it prints, ssh's line about how it ended included.
 */
async function nestedTarget (...answers: string[]) {
    const { tab, commands } = sshTab('user bob\nhostname inner.lan\nport 22\n', ...answers)
    const targets = new RemoteTargets({ store: {} }, {})
    // The tab's own key, as `ssh -G` resolves it on this computer (not run here).
    ;(targets as any).keys.set(JSON.stringify([['-l', 'u', '-p', '22'], 'h']), Promise.resolve('u@h:22'))
    const target = await targets.nestedTarget(tab, { cmd: { options: [], destination: 'inner' }, tty: 'pts/1' })
    return { target, commands }
}

test('through the host\'s ssh: the output, without the line that says how ssh ended', async () => {
    const { target, commands } = await nestedTarget('hello\n\n__trd_hop 0 \n', 'partial\n\n__trd_hop 1 \n')
    assert.equal(target.key, 'u@h:22>bob@inner.lan:22')
    assert.equal(await target.exec('echo hello', ''), 'hello\n')
    // The command's own failure is its output's business, not ssh's.
    assert.equal(await target.exec('false', ''), 'partial\n')
    assert.match(commands[1], /__trd_hop/)
})

test('ssh failing on the host is reported in its own words, though ssh ends them with CR LF', async () => {
    // OpenSSH writes its messages to stderr with CR LF; the CR stayed in the line and kept it from being recognized,
    // so the failure came back as if it were the command's output.
    const { target } = await nestedTarget('\n__trd_hop 255 bob@inner.lan: Permission denied (publickey).\r\n',
        '\n__trd_hop 255 ssh: connect to host inner.lan port 22: Connection refused\r\n')
    await assert.rejects(target.exec('true', ''), /^Error: h couldn't log in to inner by itself \(bob@inner\.lan: Permission denied \(publickey\)\.\)\./)
    await assert.rejects(target.exec('true', ''), /^Error: ssh from h to inner failed: ssh: connect to host inner\.lan port 22: Connection refused$/)
})

test('a long last line from the host is read in time that grows with it', async () => {
    // A pattern for ssh's line (its status, then its message) tried each way of splitting a long run of digits: seconds
    // for this line, hours for the 4 MB a host may send. Not a status: the output as it came.
    const out = `x\n__trd_hop ${'1'.repeat(65536)}a\r\n`
    const { target } = await nestedTarget(out)
    const started = performance.now()
    assert.equal(await target.exec('true', ''), out)
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`)
})

/**
 * Puts a stand-in for a system command first in PATH for `run`: a shell script given `script`, which writes what the
 * command would (for `ssh`, what a host would make it write).
 */
async function withCommand<T> (command: string, script: string, run: () => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-cmd-'))
    fs.writeFileSync(path.join(dir, command), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    const before = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${before}`
    try {
        return await run()
    } finally {
        process.env.PATH = before
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

const system = () => new SystemSSHTarget('u@h:22', 'h', { options: [], destination: 'h' })

test('a command through the system ssh: 4 MB of output at most', { skip: process.platform === 'win32' }, async () => {
    await withCommand('ssh', `head -c ${MAX_OUTPUT} /dev/zero | tr '\\0' A`, async () => {
        assert.equal((await system().exec('true', '')).length, MAX_OUTPUT)
    })
    await withCommand('ssh', `head -c ${MAX_OUTPUT + 1} /dev/zero | tr '\\0' A`, async () => {
        await assert.rejects(system().exec('true', ''), /more than 4 MB/)
    })
})

test('a command through the system ssh that fails says why in the host\'s words, 1,000 characters at most', { skip: process.platform === 'win32' }, async () => {
    // The host's refusal of a channel, or its banner, is what ssh prints last: as long as the host likes.
    await withCommand('ssh', `head -c 3000 /dev/zero | tr '\\0' r >&2; exit 255`, async () => {
        await assert.rejects(system().exec('true', ''), (e: Error) => e.message === `ssh to h failed: ${'r'.repeat(1000)}`)
    })
})

test('a tunnel through the system ssh keeps only the end of what ssh prints, however much the host has it print', { skip: process.platform === 'win32' }, async () => {
    // ssh prints a host's sign-in banners, for as long as the tunnel lasts, and the host decides how much: 32 MB here.
    // The tunnel says it is up once that is all printed, and lasts until it is closed.
    await withCommand('ssh', 'head -c 33554432 /dev/zero | tr \'\\0\' x >&2; echo up; exec sleep 30', async () => {
        gc()
        const before = process.memoryUsage().heapUsed
        const stream = await system().openTcp('10.0.0.1', 3389)
        // Closing it here ends its reading half early.
        stream.on('error', () => { })
        try {
            await new Promise<void>(resolve => {
                let seen = ''
                stream.on('data', (d: Buffer) => {
                    seen += d
                    if (seen.includes('up')) {
                        resolve()
                    }
                })
            })
            // What is in the pipe may still be on its way.
            await new Promise(resolve => setTimeout(resolve, 200))
            gc()
            const grown = process.memoryUsage().heapUsed - before
            assert.ok(grown < 8 * 1024 * 1024, `${Math.round(grown / 1024 / 1024)} MB kept of what ssh printed`)
        } finally {
            stream.destroy()
        }
    })
})

test('the ssh typed in a local terminal is found in the process list in time that grows with the list', { skip: process.platform === 'win32' }, async () => {
    // Any program on this computer decides what its arguments are, and with them its line in `ps`: here 100,000 spaces
    // and a character that ends a line for a pattern (U+2028, which macOS's ps prints as it is). A pattern whose parts
    // could take the same spaces tried each way of sharing them: seconds for this line, hours for the 1 MB read.
    const ps = ['1 0 /sbin/launchd', `300 1 ${' '.repeat(100000)}x y`, '100 1 -zsh', '200 100 ssh -p 2222 alice@example.com']
    await withCommand('ps', `cat <<'EOF'\n${ps.join('\n')}\nEOF`, async () => {
        const targets = new RemoteTargets({ store: {} }, {})
        // What `ssh -G` resolves it to on this computer (not run here).
        ;(targets as any).keys.set(JSON.stringify([['-p', '2222'], 'alice@example.com']), Promise.resolve('alice@example.com:2222'))
        // A local terminal whose shell is process 100.
        const pane = { profile: { type: 'local' }, element: { nativeElement: {} }, session: { getChildProcesses: async () => [], pty: { getPID: async () => 100 } } }
        const started = performance.now()
        const target = await targets.targetOf(pane)
        assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`)
        assert.deepEqual([target?.key, target?.label], ['alice@example.com:2222', 'alice@example.com'])
    })
})
