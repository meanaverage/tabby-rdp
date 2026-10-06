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
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForPort } from './lib/cdp.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LINUX_SUITES = ['e2e', 'desk', 'resize', 'keyboard', 'actions', 'clipboard', 'files', 'audio', 'microphone', 'graphics', 'reconnect', 'desktops', 'profiles', 'certificates', 'status', 'wake', 'help', 'nested', 'vms', 'headless', 'takeover']
const ALL_SUITES = [...LINUX_SUITES, 'windows', 'winhost', 'hyperv', 'gateway', 'xrdp', 'trd-pty', 'screenshots', 'demo', 'smoke-host', 'smoke-rdp']

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const suites = args.filter((a, i) => !a.startsWith('--') && !['--port', '--tabby', '--expect-xterm'].includes(args[i - 1]))
const expectedXterm = option('--expect-xterm')
if (args.includes('--expect-xterm') && (!expectedXterm || !/^[1-9]\d*$/.test(expectedXterm))) {
    console.error('--expect-xterm needs a major version, such as 5 or 6')
    process.exit(2)
}
for (const s of suites) {
    if (!ALL_SUITES.includes(s)) {
        console.error(`Unknown suite "${s}". Suites: ${ALL_SUITES.join(', ')}`)
        process.exit(2)
    }
}
const selected = suites.length ? suites : LINUX_SUITES
const smoke = selected.some(s => s.startsWith('smoke-'))
if (flag('--require-rdp') && selected.includes('smoke-rdp') && !process.env.TRD_TEST_HOST) {
    console.error('--require-rdp needs TRD_TEST_HOST; live RDP coverage cannot be skipped')
    process.exit(2)
}

function tabbyBinary (): string {
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

function freePort (): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                reject(new Error('the test server has no address'))
                return
            }
            server.close(() => resolve(address.port))
        })
        server.on('error', reject)
    })
}

/** A fresh Tabby profile directory with this plugin installed (linked, or packed like npm would). */
function makeSandbox (): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-rdp-test-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), [
        'enableWelcomeTab: false',
        'enableAnalytics: false',
        'recoverTabs: false',
        // It runs the installed Tabby: its updater would try to replace that app (macOS asks about it, or blocks it).
        'enableAutomaticUpdates: false',
        'remoteDesktop:',
        '  desk: true',
        // The one-time tip would sit over the desktop in every suite's first connection (the help suite shows it).
        '  tipShown: true',
        // No suite depends on what npm has now (the help suite tells it a version).
        '  checkUpdates: false',
        '',
    ].join('\n'))
    const plugins = path.join(dir, 'plugins')
    fs.mkdirSync(path.join(plugins, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(plugins, 'package.json'), '{}')
    if (flag('--packed')) {
        const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: ROOT }).toString().trim().split('\n').at(-1)
        if (!tarball) {
            throw new Error('npm pack printed no file name')
        }
        execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', path.join(dir, tarball)], { cwd: plugins, stdio: 'inherit' })
    } else {
        fs.symlinkSync(ROOT, path.join(plugins, 'node_modules', 'tabby-rdp'), 'dir')
    }
    if (smoke) {
        // Install after npm, which prunes unlisted plugins. The host application and its signature stay intact.
        const guard = path.join(plugins, 'node_modules', 'tabby-aaa-smoke-credentials')
        fs.mkdirSync(guard)
        fs.writeFileSync(path.join(guard, 'package.json'), JSON.stringify({
            name: 'tabby-aaa-smoke-credentials', version: '1.0.0', author: 'tabby-rdp tests',
            main: 'index.js', keywords: ['tabby-plugin'],
        }))
        fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'smoke-credentials.cjs'), path.join(guard, 'index.js'))
    }
    return dir
}

let tabby: ChildProcess | null = null
let sandbox: string | null = null
function teardown () {
    if (tabby && !flag('--keep')) {
        // Detached: the whole process group goes, so a Tabby that started helpers doesn't leave them behind.
        if (tabby.pid !== undefined) {
            try { process.kill(-tabby.pid, 'SIGKILL') } catch { }
        }
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
function runTrdPty (): number {
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

const results: [string, number, number, boolean][] = []
let port = Number(option('--port') || 0)
if (selected.some(s => s !== 'trd-pty') && !port) {
    sandbox = makeSandbox()
    port = await freePort()
    tabby = spawn(tabbyBinary(), [
        // Unmapped Linux/Windows windows can stop animation frames even with timer throttling disabled.
        // Terminal fit uses those frames. Keep the window mapped there; use Xvfb for unattended Linux runs.
        ...(flag('--hidden') && process.platform === 'darwin' ? ['--hidden'] : []),
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
    const skipped = name === 'smoke-rdp' && !process.env.TRD_TEST_HOST
    if (skipped) console.log('SKIP  smoke-rdp: set TRD_TEST_HOST (see test/README.md)')
    const code = skipped ? 0 : name === 'trd-pty'
        ? runTrdPty()
        : await new Promise<number>(resolve => {
            // tsx, not this Node alone: the suites are TypeScript (see tsconfig.test.json). Node 22.18+ could strip the
            // types itself, but the suites run on any Node 22 (lib/cdp.ts) and this keeps it that way. Resolved from
            // here: by name, Node would look for it from the current directory, which need not be this checkout.
            const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(ROOT, 'test', 'suites', `${name}.ts`)], {
                env: {
                    ...process.env, TRD_CDP_PORT: String(port),
                    ...(expectedXterm ? { TRD_SMOKE_EXPECT_XTERM: expectedXterm } : {}),
                    ...(flag('--require-rdp') ? { TRD_SMOKE_REQUIRE_RDP: '1' } : {}),
                },
                stdio: 'inherit',
            })
            child.on('exit', code => resolve(code ?? 1))
        })
    results.push([name, code, Math.round((Date.now() - started) / 1000), skipped])
}

console.log('\n=== summary')
for (const [name, code, seconds, skipped] of results) {
    console.log(`${skipped ? 'SKIP' : code === 0 ? 'ok  ' : 'FAIL'}  ${name.padEnd(10)} ${seconds} s`)
}
teardown()
process.exit(results.some(([, code]) => code !== 0) ? 1 : 0)
