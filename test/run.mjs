#!/usr/bin/env node
// Runs the end-to-end suites (test/suites) against a fresh, isolated Tabby with this plugin, and closes it at the
// end, whatever happens. See test/README.md.
//
//   npm test                          # the Linux-desktop suites (needs TRD_TEST_HOST)
//   npm test -- keyboard files        # some suites
//   npm test -- windows               # the Windows suite (needs TRD_TEST_WIN_*)
//   npm test -- xrdp                  # the xrdp suite (needs TRD_TEST_XRDP_*)
//   npm test -- --packed              # install the plugin as npm would (npm pack), not linked
//   npm test -- --port 9334           # use a Tabby that is already running with DevTools on that port
//   npm test -- --keep                # leave the test Tabby open afterwards
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForPort } from './lib/cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LINUX_SUITES = ['e2e', 'desk', 'resize', 'keyboard', 'clipboard', 'files', 'audio', 'reconnect', 'desktops']
const ALL_SUITES = [...LINUX_SUITES, 'windows', 'xrdp', 'trd-pty', 'screenshots']

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const suites = args.filter((a, i) => !a.startsWith('--') && !['--port', '--tabby'].includes(args[i - 1]))
for (const s of suites) {
    if (!ALL_SUITES.includes(s)) {
        console.error(`Unknown suite "${s}". Suites: ${ALL_SUITES.join(', ')}`)
        process.exit(2)
    }
}
const selected = suites.length ? suites : LINUX_SUITES

function tabbyBinary () {
    const candidates = [
        option('--tabby'),
        process.env.TABBY_BIN,
        process.platform === 'darwin' ? '/Applications/Tabby.app/Contents/MacOS/Tabby' : undefined,
        process.platform === 'linux' ? '/opt/Tabby/tabby' : undefined,
        process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Tabby', 'Tabby.exe') : undefined,
    ]
    const found = candidates.find(c => c && fs.existsSync(c))
    if (!found) {
        console.error('Tabby not found: pass --tabby <path> or set TABBY_BIN')
        process.exit(2)
    }
    return found
}

function freePort () {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            server.close(() => resolve(port))
        })
        server.on('error', reject)
    })
}

/** A fresh Tabby profile directory with this plugin installed (linked, or packed like npm would). */
function makeSandbox () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-rdp-test-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), [
        'enableWelcomeTab: false',
        'enableAnalytics: false',
        'recoverTabs: false',
        'remoteDesktop:',
        '  desk: true',
        '',
    ].join('\n'))
    const plugins = path.join(dir, 'plugins')
    fs.mkdirSync(path.join(plugins, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(plugins, 'package.json'), '{}')
    if (flag('--packed')) {
        const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: ROOT }).toString().trim().split('\n').pop()
        execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', path.join(dir, tarball)], { cwd: plugins, stdio: 'inherit' })
    } else {
        fs.symlinkSync(ROOT, path.join(plugins, 'node_modules', 'tabby-rdp'), 'dir')
    }
    return dir
}

let tabby = null
let sandbox = null
function teardown () {
    if (tabby && !flag('--keep')) {
        try { process.kill(-tabby.pid, 'SIGKILL') } catch { }
        try { tabby.kill('SIGKILL') } catch { }
        tabby = null
    }
    if (sandbox && !flag('--keep')) {
        fs.rmSync(sandbox, { recursive: true, force: true })
        sandbox = null
    }
}
process.on('exit', teardown)
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { teardown(); process.exit(130) })
}

/** trd-pty's own tests run on the test host (Linux), over the system ssh. */
function runTrdPty () {
    // TRD_TEST_SSH: arguments for the system ssh (a destination, possibly with options such as -p).
    const e = process.env
    const destination = e.TRD_TEST_SSH || (e.TRD_TEST_HOST ? `${e.TRD_TEST_PORT ? `-p ${e.TRD_TEST_PORT} ` : ''}${e.TRD_TEST_USER || os.userInfo().username}@${e.TRD_TEST_HOST}` : '')
    if (!destination) {
        console.log('SKIP  trd-pty: set TRD_TEST_HOST (or TRD_TEST_SSH)')
        return 0
    }
    const script = 'd=$(mktemp -d) && trap "rm -rf $d" EXIT && tar -xf - -C "$d" && python3 "$d/test/unit/trd-pty.py" "$d/remote/trd-pty.py"'
    const tar = execFileSync('tar', ['-cf', '-', '-C', ROOT, 'remote/trd-pty.py', 'test/unit/trd-pty.py'])
    try {
        execFileSync('ssh', ['-o', 'BatchMode=yes', ...destination.split(/\s+/), script], { input: tar, stdio: ['pipe', 'inherit', 'inherit'] })
        return 0
    } catch {
        return 1
    }
}

const results = []
let port = Number(option('--port') || 0)
if (selected.some(s => s !== 'trd-pty') && !port) {
    sandbox = makeSandbox()
    port = await freePort()
    tabby = spawn(tabbyBinary(), [
        `--user-data-dir=${sandbox}`,
        `--remote-debugging-port=${port}`,
        // Keep timers and rendering going while the window is behind others.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
    ], { env: { ...process.env, TABBY_CONFIG_DIRECTORY: sandbox }, detached: true, stdio: 'ignore' })
    if (!await waitForPort(port)) {
        console.error('The test Tabby did not start')
        process.exit(1)
    }
    console.log(`Test Tabby: DevTools on ${port}, profile ${sandbox}${flag('--packed') ? ' (plugin installed from npm pack)' : ''}`)
}

for (const name of selected) {
    console.log(`\n=== ${name}`)
    const started = Date.now()
    const code = name === 'trd-pty'
        ? runTrdPty()
        : await new Promise(resolve => {
            const child = spawn(process.execPath, [path.join(ROOT, 'test', 'suites', `${name}.mjs`)], {
                env: { ...process.env, TRD_CDP_PORT: String(port) },
                stdio: 'inherit',
            })
            child.on('exit', code => resolve(code ?? 1))
        })
    results.push([name, code, Math.round((Date.now() - started) / 1000)])
}

console.log('\n=== summary')
for (const [name, code, seconds] of results) {
    console.log(`${code === 0 ? 'ok  ' : 'FAIL'}  ${name.padEnd(10)} ${seconds} s`)
}
teardown()
process.exit(results.some(([, code]) => code !== 0) ? 1 : 0)
