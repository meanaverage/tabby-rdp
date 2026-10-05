// The scripts the plugin runs on SSH hosts (src/remoteSetup.ts, src/deskScript.ts, src/wake.ts), run here under /bin/sh
// against a fake host: a temporary home, and stand-ins for GNOME's tools that keep their state in files. The scripts'
// PATH has only those and wrappers around real commands, all of which log their arguments: what other users of a host
// see in its process list. Runs against the built plugin: npm run build && npm run test:unit (TRD_TEST_SH=/bin/dash
// runs them under dash, Debian's and Ubuntu's sh, where the default sh is another).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { prepareRemoteDesktop } = require('../../dist/remoteSetup.js')
const { consoleScript, takeDeskMessages } = require('../../dist/deskScript.js')
const { shutDownWhenIdle } = require('../../dist/wake.js')

const SH = process.env.TRD_TEST_SH || '/bin/sh'
const HOOK = '[ -f "$HOME/.local/share/tabby-rdp/login.sh" ] && . "$HOME/.local/share/tabby-rdp/login.sh"  # tabby-rdp'

/** Commands the scripts run that any Unix has: the real ones, behind a wrapper that logs. */
const REAL = ['awk', 'base64', 'cat', 'chmod', 'cp', 'date', 'grep', 'head', 'hostname', 'id', 'ln', 'ls', 'mkdir', 'mktemp', 'mv',
    'od', 'readlink', 'rm', 'sed', 'sort', 'tail', 'tr', 'uname', 'wc']

// Each command's arguments, one line, and its environment (what /proc/<pid>/environ would hold) to a second log.
const logLine = (name: string) => String.raw`{ printf '%s' '` + name + String.raw`'; for a; do printf ' %s' "$a"; done; printf '\n'; } >> "$ARGV_LOG"; export -p >> "$ARGV_LOG.env"`

/** Stand-ins: GNOME's and systemd's tools, and ones a test machine may not have. */
const FAKES: Record<string, string> = {
    // grd's settings, in files: `status` prints them as grdctl does (tab-indented). A password left off set-credentials
    // is read from the input where FAKE_GRD_PROMPT=1, as newer grdctl does; older ones want both arguments.
    grdctl: String.raw`S="$FAKE_ROOT/grd"
[ -d "$S" ] || mkdir "$S"
[ "$1" = --headless ] && shift
case $1 in
status)
    printf 'RDP:\n\tStatus: %s\n\tPort: 3389\n' "$(cat "$S/status" 2>/dev/null || echo disabled)"
    [ -f "$S/key" ] && printf '\tTLS key: %s\n' "$(cat "$S/key")"
    [ -f "$S/cert" ] && printf '\tTLS certificate: %s\n' "$(cat "$S/cert")"
    printf '\tView-only: %s\n' "$(cat "$S/viewonly" 2>/dev/null || echo yes)"
    if [ "$2" = --show-credentials ]; then
        printf '\tUsername: %s\n\tPassword: %s\n' "$(cat "$S/user" 2>/dev/null)" "$(cat "$S/pass" 2>/dev/null)"
    fi ;;
rdp)
    case $2 in
    set-tls-key) printf '%s' "$3" > "$S/key" ;;
    set-tls-cert) printf '%s' "$3" > "$S/cert" ;;
    disable-view-only) echo no > "$S/viewonly" ;;
    enable) echo enabled > "$S/status" ;;
    set-credentials)
        if [ $# = 4 ]; then printf '%s' "$3" > "$S/user"; printf '%s' "$4" > "$S/pass"
        elif [ $# = 3 ] && [ "$FAKE_GRD_PROMPT" = 1 ]; then printf 'Password: '; IFS= read -r p; printf '%s' "$3" > "$S/user"; printf '%s' "$p" > "$S/pass"
        else echo 'Usage: grdctl rdp set-credentials <username> <password>' >&2; exit 1; fi ;;
    esac ;;
esac`,
    'gnome-shell': 'exit 0',
    // Not the desktop-session grd; everything else runs, or does what it is asked.
    systemctl: String.raw`case $* in *'is-active -q gnome-remote-desktop.service'*) exit 1 ;; esac`,
    pgrep: 'exit 1',
    // grd listens; no X11 display, no clients.
    ss: String.raw`case $* in *-ltnH*) echo 'LISTEN 0 4096 *:3389 *:*' ;; esac`,
    busctl: 'exit 0',
    'systemd-run': 'exit 0',
    'dbus-update-activation-environment': 'exit 0',
    openssl: String.raw`case $1 in
req) while [ $# -gt 0 ]; do case $1 in -keyout) echo key > "$2"; shift ;; -out) echo cert > "$2"; shift ;; esac; shift; done ;;
x509) echo 'sha256 Fingerprint=00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF' ;;
esac`,
    // FAKE_CAT_CUT: a file whose path starts so is copied only in part, then the copy fails (as on a disk filling up).
    cat: String.raw`if [ -n "$FAKE_CAT_CUT" ]; then case $1 in "$FAKE_CAT_CUT"*) head -c 8 "$1"; exit 1 ;; esac; fi
for d in /usr/bin /bin; do [ -x "$d/cat" ] && exec "$d/cat" "$@"; done`,
    // FAKE_OD_DELAY: random bytes take a while, so that two setups at once both get to make a key.
    od: String.raw`[ -z "$FAKE_OD_DELAY" ] || sleep "$FAKE_OD_DELAY"
for d in /usr/bin /bin; do [ -x "$d/od" ] && exec "$d/od" "$@"; done`,
    'gnome-terminal': 'exit 0',
    tmux: String.raw`case $* in *list-clients*) echo client ;; esac`,
    virsh: String.raw`case $* in *domstate*) echo running ;; esac`,
    getent: 'exit 2',
    // FAKE_NO_CHMOD: it fails, as on a file system that keeps no modes.
    chmod: String.raw`[ -z "$FAKE_NO_CHMOD" ] || exit 1
for d in /usr/bin /bin /usr/sbin /sbin; do [ -x "$d/chmod" ] && exec "$d/chmod" "$@"; done`,
    // FAKE_UID: the user id the host says, for a folder in /tmp of a name no real user's has.
    id: String.raw`[ -n "$FAKE_UID" ] && [ "$1" = -u ] && { echo "$FAKE_UID"; exit 0; }
for d in /usr/bin /bin /usr/sbin /sbin; do [ -x "$d/id" ] && exec "$d/id" "$@"; done`,
    nohup: 'exec "$@"',
    setsid: 'exec "$@"',
    // With FAKE_SLEEP_LOG: what the idle watcher's folder holds when it first sleeps, then it ends.
    sleep: String.raw`if [ -n "$FAKE_SLEEP_LOG" ]; then ls -ln "$HOME/.local/share/tabby-rdp" > "$FAKE_SLEEP_LOG.part" && mv "$FAKE_SLEEP_LOG.part" "$FAKE_SLEEP_LOG"; exit 1; fi
for d in /usr/bin /bin; do [ -x "$d/sleep" ] && exec "$d/sleep" "$@"; done`,
}

/** The scripts' PATH: the wrappers and stand-ins, made once (a new executable's first run is slow on macOS). */
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-bin-'))
after(() => fs.rmSync(bin, { recursive: true, force: true }))
const write = (name: string, body: string, dir = bin) => fs.writeFileSync(path.join(dir, name), `#!${SH}\n${logLine(name)}\n${body}\n`, { mode: 0o755 })
for (const name of REAL) {
    write(name, `for d in /usr/bin /bin /usr/sbin /sbin; do [ -x "$d/${name}" ] && exec "$d/${name}" "$@"; done\necho "${name}: not found" >&2\nexit 127`)
}
write('sh', `exec ${SH} "$@"`)
for (const [name, body] of Object.entries(FAKES)) {
    write(name, body)
}
// timeout, in a folder of its own: FAKE_NO_TIMEOUT leaves that off PATH, as on a host without it (coreutils' or
// busybox's).
const timeoutBin = path.join(bin, 'timeout.d')
fs.mkdirSync(timeoutBin)
write('timeout', 'shift; exec "$@"', timeoutBin)

/** A fake host in a temporary folder (see above). `target(env)` is a RemoteTarget that runs scripts there. */
function host () {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trd-host-')))
    const home = path.join(root, 'home'), log = path.join(root, 'argv.log')
    for (const dir of [home, path.join(root, 'run')]) {
        fs.mkdirSync(dir, { mode: 0o700 })
    }
    const env = (extra: Record<string, string>) => ({
        HOME: home, PATH: extra.FAKE_NO_TIMEOUT ? bin : `${bin}:${timeoutBin}`, ARGV_LOG: log, FAKE_ROOT: root,
        XDG_RUNTIME_DIR: path.join(root, 'run'), LC_ALL: 'C', ...extra,
    })
    // stderr: in the error when a script fails, quiet otherwise (no GNOME Shell runs here to read /proc of).
    const sh = (script: string, extra: Record<string, string> = {}) => execFileSync(SH, ['-s'], {
        input: script, env: env(extra), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
    return {
        root, home, log, sh,
        D: path.join(home, '.local/share/tabby-rdp'),
        target: (extra: Record<string, string> = {}) => ({
            key: 'u@host:22', label: 'host',
            exec: async (command: string, stdin: string) => {
                assert.equal(command, 'sh -s')
                return sh(stdin, extra)
            },
        }),
        /** The same, with scripts that run side by side (two panes, or two computers, at once). */
        targetAsync: (extra: Record<string, string> = {}) => ({
            key: 'u@host:22', label: 'host',
            exec: (command: string, stdin: string) => new Promise<string>((resolve, reject) => {
                assert.equal(command, 'sh -s')
                const child = execFile(SH, ['-s'], { env: env(extra), encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout))
                child.stdin!.end(stdin)
            }),
        }),
        /** Every command line the scripts ran, one per line. */
        argv: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
        /** The environments those commands got. */
        environments: () => fs.existsSync(`${log}.env`) ? fs.readFileSync(`${log}.env`, 'utf8') : '',
        // Retried: an idle watcher started in the background can still be writing there for a moment.
        cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    }
}

test('setup: the password and desk\'s key never go on a command line; the key comes back to the plugin', async () => {
    const h = host()
    try {
        const t = h.target({ FAKE_GRD_PROMPT: '1' })
        const first = await prepareRemoteDesktop(t, true, 'native', 'pane1')
        const password = fs.readFileSync(path.join(h.D, 'rdp-password'), 'utf8')
        const key = fs.readFileSync(path.join(h.D, 'desk-key'), 'utf8')
        assert.match(password, /^[0-9a-f]{36}$/)
        assert.match(key, /^[0-9a-f]{32}$/)
        assert.equal(first.kind, 'gnome')
        assert.equal(first.password, password)
        assert.equal(first.deskKey, key)
        assert.equal(fs.statSync(path.join(h.D, 'desk-key')).mode & 0o777, 0o600)
        assert.equal(fs.statSync(h.D).mode & 0o777, 0o700)
        // grd took the password from its input.
        assert.equal(fs.readFileSync(path.join(h.root, 'grd', 'pass'), 'utf8'), password)
        assert.match(h.argv(), /^grdctl --headless rdp set-credentials tabby$/m)
        // The next connect: credentials checked, not set again; the same key.
        const second = await prepareRemoteDesktop(t, true, 'native', 'pane1')
        assert.equal(second.deskKey, key)
        assert.equal(h.argv().match(/set-credentials/g)?.length, 2)  // timeout, then grdctl: the first connect only
        const argv = h.argv()
        assert.ok(argv.split('\n').length > 50, 'the wrappers logged')
        assert.ok(!argv.includes(password), 'the password is on no command line')
        assert.ok(!argv.includes(key), 'desk\'s key is on no command line')
        const environments = h.environments()
        assert.match(environments, /ARGV_LOG/)
        assert.ok(!environments.includes(password) && !environments.includes(key), 'nor in any command\'s environment')
    } finally {
        h.cleanup()
    }
})

test('setup: where grdctl takes the password only as an argument, only setting it puts it there', async () => {
    const h = host()
    try {
        const t = h.target({ FAKE_GRD_PROMPT: '0' })
        await prepareRemoteDesktop(t, false, 'native', 'pane1')
        const password = fs.readFileSync(path.join(h.D, 'rdp-password'), 'utf8')
        assert.equal(fs.readFileSync(path.join(h.root, 'grd', 'pass'), 'utf8'), password)
        assert.deepEqual(h.argv().split('\n').filter(l => l.includes(password)), [`grdctl --headless rdp set-credentials tabby ${password}`])
        fs.writeFileSync(h.log, '')
        const again = await prepareRemoteDesktop(t, false, 'native', 'pane1')
        assert.equal(again.password, password)
        assert.equal(again.deskKey, undefined)
        assert.ok(!h.argv().includes(password), 'checking the credentials puts the password on no command line')
    } finally {
        h.cleanup()
    }
})

test('desk\'s login hook: one exact line, added and removed through a linked rc file; the user\'s own lines stay', async () => {
    const h = host()
    try {
        const t = h.target({ FAKE_GRD_PROMPT: '1' })
        // ~/.bashrc links to a dotfiles folder, and has a line of the user's that merely ends like the hook.
        const dotfiles = path.join(h.home, 'dotfiles')
        fs.mkdirSync(dotfiles)
        const bashrc = path.join(dotfiles, 'bashrc')
        const bashOriginal = 'export A=1\nalias x=y  # tabby-rdp\n'
        fs.writeFileSync(bashrc, bashOriginal)
        fs.chmodSync(bashrc, 0o640)
        fs.symlinkSync(bashrc, path.join(h.home, '.bashrc'))
        // ~/.zshrc has the hook from before 0.2 (sourced from the old folder), and a line that merely ends like it.
        const zshrc = path.join(h.home, '.zshrc')
        const legacy = '[ -f "$HOME/.local/share/tabby-remote-desktop/login.sh" ] && . "$HOME/.local/share/tabby-remote-desktop/login.sh"  # tabby-remote-desktop'
        const zshKept = 'setopt x\necho mine  # tabby-remote-desktop\n'
        fs.writeFileSync(zshrc, `setopt x\n${legacy}\necho mine  # tabby-remote-desktop\n`)

        await prepareRemoteDesktop(t, true, 'native', 'pane1')
        assert.ok(fs.lstatSync(path.join(h.home, '.bashrc')).isSymbolicLink(), '~/.bashrc is still a link')
        assert.equal(fs.readFileSync(bashrc, 'utf8'), `${bashOriginal}${HOOK}\n`)
        assert.equal(fs.readFileSync(zshrc, 'utf8'), `${zshKept}${HOOK}\n`)
        await prepareRemoteDesktop(t, true, 'native', 'pane1')
        assert.equal(fs.readFileSync(bashrc, 'utf8'), `${bashOriginal}${HOOK}\n`, 'still one hook')

        const off = await prepareRemoteDesktop(t, false, 'native', 'pane1')
        assert.equal(off.deskKey, undefined)
        assert.ok(fs.lstatSync(path.join(h.home, '.bashrc')).isSymbolicLink(), '~/.bashrc is still a link')
        assert.equal(fs.readFileSync(bashrc, 'utf8'), bashOriginal)
        assert.equal(fs.statSync(bashrc).mode & 0o777, 0o640)
        assert.equal(fs.readFileSync(zshrc, 'utf8'), zshKept)
        assert.deepEqual(fs.readdirSync(dotfiles), ['bashrc'], 'no temporary file left')
        for (const gone of ['desk-key', 'login.sh', 'bin/desk', 'bin/trd-pty']) {
            assert.ok(!fs.existsSync(path.join(h.D, gone)), `${gone} removed`)
        }
    } finally {
        h.cleanup()
    }
})

test('turning desk off keeps every other byte of an rc file, whether it reads as text there or not', async () => {
    const h = host()
    try {
        // In the host's own locale (UTF-8, where a 0xE9 byte alone isn't a character), with a NUL byte too, and no
        // newline at the end.
        const t = h.target({ FAKE_GRD_PROMPT: '1', LC_ALL: 'C.UTF-8' })
        const bashrc = path.join(h.home, '.bashrc')
        const mine = Buffer.concat([Buffer.from('export A=1\n# caf'), Buffer.from([0xe9]), Buffer.from(' (latin-1)\nx=\0y\nexport B=2')])
        fs.writeFileSync(bashrc, mine)
        // The last byte a NUL: the hook still goes on a line of its own.
        const zshrc = path.join(h.home, '.zshrc')
        const zshMine = Buffer.from('setopt x\0')
        fs.writeFileSync(zshrc, zshMine)
        await prepareRemoteDesktop(t, true, 'native', 'pane1')
        assert.deepEqual(fs.readFileSync(bashrc), Buffer.concat([mine, Buffer.from(`\n${HOOK}\n`)]))
        assert.deepEqual(fs.readFileSync(zshrc), Buffer.concat([zshMine, Buffer.from(`\n${HOOK}\n`)]))
        const off = await prepareRemoteDesktop(t, false, 'native', 'pane1')
        // The newline added before the hook stays, so that turning desk on and off again leaves the file as it is now.
        assert.deepEqual(fs.readFileSync(bashrc), Buffer.concat([mine, Buffer.from('\n')]))
        assert.deepEqual(fs.readFileSync(zshrc), Buffer.concat([zshMine, Buffer.from('\n')]))
        assert.deepEqual(off.notes, [])
    } finally {
        h.cleanup()
    }
})

// (root can write a read-only file.)
test('turning desk off writes into the rc file itself: its other names stay the same file, a read-only one stays as it is', { skip: process.getuid?.() === 0 }, async () => {
    const h = host()
    try {
        const t = h.target({ FAKE_GRD_PROMPT: '1' })
        // ~/.bashrc is another name (a hard link) for a file kept with the user's dotfiles.
        const dotfiles = path.join(h.home, 'dotfiles')
        fs.mkdirSync(dotfiles)
        const kept = path.join(dotfiles, 'bashrc')
        fs.writeFileSync(kept, 'export A=1\n')
        fs.linkSync(kept, path.join(h.home, '.bashrc'))
        // ~/.zshrc is read-only: no hook goes in, and the setup says so.
        const zshrc = path.join(h.home, '.zshrc')
        fs.writeFileSync(zshrc, 'setopt x\n')
        fs.chmodSync(zshrc, 0o444)
        const on = await prepareRemoteDesktop(t, true, 'native', 'pane1')
        assert.equal(fs.readFileSync(kept, 'utf8'), `export A=1\n${HOOK}\n`)
        assert.equal(fs.readFileSync(zshrc, 'utf8'), 'setopt x\n')
        assert.deepEqual(on.notes, [`desk's line couldn't be added to ${zshrc} (read-only?): logins there don't start in a shared session`])
        // Made writable, it gets the hook; then the user makes it read-only again, hook and all.
        fs.chmodSync(zshrc, 0o644)
        await prepareRemoteDesktop(t, true, 'native', 'pane1')
        fs.chmodSync(zshrc, 0o444)
        const inode = fs.statSync(zshrc).ino

        const off = await prepareRemoteDesktop(t, false, 'native', 'pane1')
        assert.equal(fs.readFileSync(kept, 'utf8'), 'export A=1\n')
        assert.equal(fs.statSync(path.join(h.home, '.bashrc')).ino, fs.statSync(kept).ino, 'still one file')
        assert.equal(fs.readFileSync(zshrc, 'utf8'), `setopt x\n${HOOK}\n`)
        assert.equal(fs.statSync(zshrc).ino, inode)
        assert.equal(fs.statSync(zshrc).mode & 0o777, 0o444)
        // Said in the setup's result (the desktop's log), for that file only.
        assert.deepEqual(off.notes, [`desk's line stays in ${zshrc}: it can't be written (read-only?)`])
        assert.deepEqual(fs.readdirSync(h.D).filter(f => f.startsWith('rc.')), [], 'no temporary file left')
    } finally {
        h.cleanup()
    }
})

test('turning desk off: where writing the rc file fails part way, what it should hold is kept, and the log says where', async () => {
    const h = host()
    try {
        const bashrc = path.join(h.home, '.bashrc')
        const mine = 'export A=1\nexport B=2\n'
        fs.writeFileSync(bashrc, mine)
        await prepareRemoteDesktop(h.target({ FAKE_GRD_PROMPT: '1' }), true, 'native', 'pane1')
        assert.equal(fs.readFileSync(bashrc, 'utf8'), `${mine}${HOOK}\n`)
        const off = await prepareRemoteDesktop(h.target({ FAKE_GRD_PROMPT: '1', FAKE_CAT_CUT: path.join(h.D, 'rc.') }), false, 'native', 'pane1')
        // The file got 8 bytes before the disk was full; the rest of it is in the plugin's folder.
        assert.equal(fs.readFileSync(bashrc, 'utf8'), mine.slice(0, 8))
        const kept = fs.readdirSync(h.D).filter(f => f.startsWith('rc.')).map(f => path.join(h.D, f))
        assert.equal(kept.length, 1)
        assert.equal(fs.readFileSync(kept[0], 'utf8'), mine)
        assert.deepEqual(off.notes, [`writing ${bashrc} failed; what it should hold (without desk's line) is in ${kept[0]}`])
    } finally {
        h.cleanup()
    }
})

test('the hook from before 0.2 goes as it was written, and its login.sh with it; a line that only mentions its folder stays', async () => {
    const h = host()
    try {
        const t = h.target({ FAKE_GRD_PROMPT: '1' })
        // The plugin's folder was made already (by the idle watcher, say), so the old one isn't moved over.
        const old = path.join(h.home, '.local/share/tabby-remote-desktop')
        fs.mkdirSync(old, { recursive: true })
        fs.writeFileSync(path.join(old, 'login.sh'), 'tmux new-session\n')
        fs.writeFileSync(path.join(old, 'rdp-password'), 'old\n')
        fs.mkdirSync(h.D, { recursive: true })
        // What 0.1 wrote, exactly (src/remoteSetup.ts at v0.1.0), and a line of the user's own.
        const legacy = '[ -f "$HOME/.local/share/tabby-remote-desktop/login.sh" ] && . "$HOME/.local/share/tabby-remote-desktop/login.sh"  # tabby-remote-desktop'
        const mine = 'echo "$HOME/.local/share/tabby-remote-desktop/cache" # tabby-remote-desktop'
        const zshrc = path.join(h.home, '.zshrc')
        fs.writeFileSync(zshrc, `setopt x\n${legacy}\n${mine}\n`)
        await prepareRemoteDesktop(t, false, 'native', 'pane1')
        assert.equal(fs.readFileSync(zshrc, 'utf8'), `setopt x\n${mine}\n`)
        assert.ok(!fs.existsSync(path.join(old, 'login.sh')), 'an old hook left anywhere sources nothing')
        assert.equal(fs.readFileSync(path.join(old, 'rdp-password'), 'utf8'), 'old\n')
    } finally {
        h.cleanup()
    }
})

test('desk\'s key: two setups at once both report the one that stays; only a file of the user\'s is taken for one', async () => {
    const h = host()
    try {
        // Two panes (or computers) opening the desktop at once, on a host without a key yet.
        const t2 = h.targetAsync({ FAKE_GRD_PROMPT: '1', FAKE_OD_DELAY: '0.3' })
        const both = await Promise.all(['pane1', 'pane2'].map(pane => prepareRemoteDesktop(t2, true, 'native', pane)))
        const key = fs.readFileSync(path.join(h.D, 'desk-key'), 'utf8')
        assert.match(key, /^[0-9a-f]{32}$/)
        assert.deepEqual(both.map(e => e.deskKey), [key, key])
        // A key file loosened since is made private again.
        const t = h.target({ FAKE_GRD_PROMPT: '1' })
        fs.chmodSync(path.join(h.D, 'desk-key'), 0o644)
        assert.equal((await prepareRemoteDesktop(t, true, 'native', 'pane1')).deskKey, key)
        assert.equal(fs.statSync(path.join(h.D, 'desk-key')).mode & 0o777, 0o600)
        // A link is no key, even to a well-formed one: replaced, and what it led to is left alone.
        const elsewhere = path.join(h.root, 'elsewhere')
        fs.writeFileSync(elsewhere, '0123456789abcdef0123456789abcdef')
        fs.rmSync(path.join(h.D, 'desk-key'))
        fs.symlinkSync(elsewhere, path.join(h.D, 'desk-key'))
        const fresh = (await prepareRemoteDesktop(t, true, 'native', 'pane1')).deskKey
        assert.match(fresh, /^[0-9a-f]{32}$/)
        assert.notEqual(fresh, '0123456789abcdef0123456789abcdef')
        assert.ok(!fs.lstatSync(path.join(h.D, 'desk-key')).isSymbolicLink())
        assert.equal(fs.readFileSync(path.join(h.D, 'desk-key'), 'utf8'), fresh)
        assert.equal(fs.readFileSync(elsewhere, 'utf8'), '0123456789abcdef0123456789abcdef')
        assert.deepEqual(fs.readdirSync(h.D).filter(f => f.startsWith('desk-key.')), [], 'no temporary file left')
    } finally {
        h.cleanup()
    }
})

test('setup: without a timeout command, grd still gets its credentials, through its input where grdctl reads them there', async () => {
    const h = host()
    try {
        const ready = await prepareRemoteDesktop(h.target({ FAKE_GRD_PROMPT: '1', FAKE_NO_TIMEOUT: '1' }), false, 'native', 'pane1')
        assert.equal(fs.readFileSync(path.join(h.root, 'grd', 'pass'), 'utf8'), ready.password)
        assert.match(h.argv(), /^grdctl --headless rdp set-credentials tabby$/m)
        assert.ok(!h.argv().includes(ready.password), 'the password is on no command line')
        assert.ok(!/^timeout /m.test(h.argv()), 'no timeout ran')
    } finally {
        h.cleanup()
    }
    // And where grdctl takes it only as an argument, it goes there, once.
    const old = host()
    try {
        const ready = await prepareRemoteDesktop(old.target({ FAKE_GRD_PROMPT: '0', FAKE_NO_TIMEOUT: '1' }), false, 'native', 'pane1')
        assert.equal(fs.readFileSync(path.join(old.root, 'grd', 'pass'), 'utf8'), ready.password)
        assert.deepEqual(old.argv().split('\n').filter(l => l.includes(ready.password)), [`grdctl --headless rdp set-credentials tabby ${ready.password}`])
    } finally {
        old.cleanup()
    }
})

test('bin/desk sends the key, and the plugin reads its request', async () => {
    const h = host()
    try {
        const { deskKey } = await prepareRemoteDesktop(h.target({ FAKE_GRD_PROMPT: '1' }), true, 'native', 'pane1')
        fs.writeFileSync(h.log, '')
        const printed = h.sh('cd /tmp && exec sh "$HOME/.local/share/tabby-rdp/bin/desk"', { TRD_SESSION: 'abcd1234', TRD_SOCKET: '/run/x.sock' })
        const { output, desk } = takeDeskMessages(Buffer.from(printed))
        assert.equal(output.length, 0)
        assert.equal(desk.key, deskKey)
        assert.equal(desk.session, 'abcd1234')
        assert.equal(desk.kind, 'native')
        assert.equal(desk.cwd, '/tmp')
        assert.ok(!h.argv().includes(deskKey), 'the key is on no command line')
    } finally {
        h.cleanup()
    }
})

/** A listening Unix socket at `file`, bound from its folder (a socket's path must be short, on macOS especially). */
async function socketAt (file: string): Promise<net.Server> {
    const server = net.createServer()
    const cwd = process.cwd()
    process.chdir(path.dirname(file))
    try {
        await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path.basename(file), () => resolve()))
    } finally {
        process.chdir(cwd)
    }
    return server
}

test('desk attaches a desktop terminal only to a session of this user\'s own', async () => {
    const h = host()
    const servers: net.Server[] = []
    try {
        const uid = process.getuid!()
        const tmuxIn = async (folder: string, mode: number) => {
            fs.mkdirSync(folder, { recursive: true })
            fs.chmodSync(folder, mode)
            servers.push(await socketAt(path.join(folder, 'default')))
            return path.join(folder, 'default')
        }
        // As tmux makes it: tmux-<uid>, 0700, the socket ours.
        const good = await tmuxIn(path.join(h.root, `tmux-${uid}`), 0o700)
        const trd = path.join(h.D, 'bin', 'trd-pty')
        fs.mkdirSync(path.dirname(trd), { recursive: true })
        fs.writeFileSync(trd, `#!/bin/sh\n${logLine('trd-pty')}\ncase $1 in clients) echo 1 ;; esac\n`, { mode: 0o755 })

        const open = (request: Record<string, string>) => {
            fs.writeFileSync(h.log, '')
            const out = h.sh(consoleScript({ session: '', socket: '', cwd: h.home, kind: '', machine: '', hostname: '', key: '', ...request })).trim()
            const lines = h.argv().split('\n')
            return { out, terminal: lines.find(l => l.startsWith('gnome-terminal ')), trd: lines.some(l => l.startsWith('trd-pty ')) }
        }
        const folder = { out: 'RD_OK opened-folder', terminal: `gnome-terminal --maximize --working-directory=${h.home}` }

        assert.deepEqual(open({ kind: 'tmux', session: '0', socket: good }),
            { out: 'RD_OK opened', terminal: `gnome-terminal --maximize -- tmux -S ${good} attach-session -t =0`, trd: false })
        assert.deepEqual(open({ kind: 'native', session: 'abcd1234' }),
            { out: 'RD_OK opened', terminal: `gnome-terminal --maximize -- ${trd} attach abcd1234`, trd: true })
        // Any name tmux gives a session of the user's: it only picks among them.
        for (const session of ['my proj', "x'y", 'ü-1']) {
            assert.deepEqual(open({ kind: 'tmux', session, socket: good }),
                { out: 'RD_OK opened', terminal: `gnome-terminal --maximize -- tmux -S ${good} attach-session -t =${session}`, trd: false }, session)
        }
        // A folder anyone can make things in, but sticky (like /tmp), further up: nobody else can move what is in it.
        fs.mkdirSync(path.join(h.root, 'sticky'))
        fs.chmodSync(path.join(h.root, 'sticky'), 0o1777)
        fs.mkdirSync(path.join(h.root, 'sticky', 'mine'), { mode: 0o755 })
        const underSticky = await tmuxIn(path.join(h.root, 'sticky', 'mine', `tmux-${uid}`), 0o700)
        assert.equal(open({ kind: 'tmux', session: '0', socket: underSticky }).out, 'RD_OK opened')

        // Sockets that aren't in tmux's own folder for this user, or that the attach might not find again.
        fs.mkdirSync(path.join(h.root, 'open'), { mode: 0o777 })
        fs.chmodSync(path.join(h.root, 'open'), 0o777)
        fs.mkdirSync(path.join(h.root, 'open', 'mine'), { mode: 0o755 })
        const elsewhere = [
            await tmuxIn(path.join(h.root, 'shared'), 0o700),  // not tmux's folder
            await tmuxIn(path.join(h.root, 'loose', `tmux-${uid}`), 0o755),  // others can look in
            await tmuxIn(path.join(h.root, 'open', `tmux-${uid}`), 0o700),  // in a folder anyone can rename things in
            // ... or further up: another user could rename open/mine, and put a tree of theirs in its place.
            await tmuxIn(path.join(h.root, 'open', 'mine', `tmux-${uid}`), 0o700),
        ]
        fs.symlinkSync(good, path.join(h.root, `tmux-${uid}`, 'link'))
        elsewhere.push(path.join(h.root, `tmux-${uid}`, 'link'))  // a link to a good one
        fs.symlinkSync(h.root, path.join(h.root, 'via'))
        elsewhere.push(path.join(h.root, 'via', `tmux-${uid}`, 'default'))  // a link on the way
        elsewhere.push(path.join(h.root, `tmux-${uid}`, 'missing'))
        for (const socket of elsewhere) {
            assert.deepEqual(open({ kind: 'tmux', session: '0', socket }), { ...folder, trd: false }, socket)
        }
        // Session names tmux and trd-pty don't make (tmux puts _ for : and .), and a kind of its own, are not looked up.
        for (const session of ['', '../0', 'a:0', 'a.b']) {
            assert.deepEqual(open({ kind: 'tmux', session, socket: good }), { ...folder, trd: false }, session)
        }
        for (const session of ['', 'ABCD1234', '../abcd', 'abcd1234 x', '-h']) {
            assert.deepEqual(open({ kind: 'native', session, socket: good }), { ...folder, trd: false }, session)
        }
        assert.deepEqual(open({ kind: 'other', session: '0', socket: good }), { ...folder, trd: false })
    } finally {
        servers.forEach(s => s.close())
        h.cleanup()
    }
})

test('the idle watcher keeps its folder and pid file to the user', async () => {
    const h = host()
    try {
        const seen = path.join(h.root, 'seen')
        const said = await shutDownWhenIdle(h.target({ FAKE_SLEEP_LOG: seen }), 'win11', '192.168.122.5', 3389, 300)
        assert.match(said, /^win11 shuts down after 5 min without a desktop open/)
        assert.equal(fs.statSync(h.D).mode & 0o777, 0o700)
        // The watcher writes its pid, then sleeps: what the folder holds then.
        for (let i = 0; i < 100 && !fs.existsSync(seen); i++) {
            await new Promise(resolve => setTimeout(resolve, 50))
        }
        assert.match(fs.readFileSync(seen, 'utf8'), /^-rw-------[@+.]? .* idle-win11\.pid$/m)
    } finally {
        h.cleanup()
    }
})

test('... also in /tmp, where the home folder can\'t keep them, and a folder there that others could read is made private', { skip: process.platform === 'win32' }, async t => {
    const h = host()
    // /tmp, under a user id no real user has: a folder an earlier version made there, 0755 (mkdir -m only sets the mode
    // of one it makes), and a home folder where the plugin's own folder can't be made (.local is a file).
    const uid = String(4_000_000_000 + (process.pid % 1000))
    const tmp = `/tmp/tabby-rdp-${uid}`
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { mode: 0o755 })
    fs.chmodSync(tmp, 0o755)
    fs.writeFileSync(path.join(h.home, '.local'), 'a file, not a folder')
    try {
        const seen = path.join(h.root, 'seen')
        const said = await shutDownWhenIdle(h.target({ FAKE_UID: uid, FAKE_SLEEP_LOG: seen }), 'win11', '192.168.122.5', 3389, 300)
        assert.match(said, /^win11 shuts down after 5 min without a desktop open/)
        assert.equal(fs.statSync(tmp).mode & 0o777, 0o700)
        // The watcher, in the background, writes its pid, then sleeps (and ends here): not removed under it.
        for (let i = 0; i < 100 && !fs.existsSync(seen); i++) {
            await new Promise(resolve => setTimeout(resolve, 50))
        }
    } finally {
        h.cleanup()
    }
})

test('... and in /tmp a folder that can\'t be made private isn\'t used', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
    const h = host()
    const uid = String(4_000_000_000 + (process.pid % 1000) + 1000)
    const tmp = `/tmp/tabby-rdp-${uid}`
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { mode: 0o755 })
    fs.chmodSync(tmp, 0o755)
    fs.writeFileSync(path.join(h.home, '.local'), 'a file, not a folder')
    try {
        // A chmod that fails, as on a file system that keeps no modes: the check stops, as for another user's folder.
        await assert.rejects(shutDownWhenIdle(h.target({ FAKE_UID: uid, FAKE_NO_CHMOD: '1' }), 'win11', '192.168.122.5', 3389, 300),
            /could not create a folder for the watcher's pid file/)
        assert.equal(fs.statSync(tmp).mode & 0o777, 0o755)
    } finally {
        h.cleanup()
    }
})

test('... also where an earlier version made them readable to others', async () => {
    const h = host()
    try {
        // As a watcher before this left them: the folder 0755, and a pid file 0644 of one that has ended.
        fs.mkdirSync(h.D, { recursive: true, mode: 0o755 })
        fs.chmodSync(h.D, 0o755)
        fs.writeFileSync(path.join(h.D, 'idle-win11.pid'), 'none\n', { mode: 0o644 })
        fs.chmodSync(path.join(h.D, 'idle-win11.pid'), 0o644)
        const seen = path.join(h.root, 'seen')
        await shutDownWhenIdle(h.target({ FAKE_SLEEP_LOG: seen }), 'win11', '192.168.122.5', 3389, 300)
        assert.equal(fs.statSync(h.D).mode & 0o777, 0o700)
        for (let i = 0; i < 100 && !fs.existsSync(seen); i++) {
            await new Promise(resolve => setTimeout(resolve, 50))
        }
        assert.match(fs.readFileSync(seen, 'utf8'), /^-rw-------[@+.]? .* idle-win11\.pid$/m)
    } finally {
        h.cleanup()
    }
})
