import { Injectable } from '@angular/core'
import { execFile, spawn } from 'child_process'
import * as net from 'net'
import { Duplex } from 'stream'
import { BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { DesktopSpec, DIRECT_KEY, specOf } from './desktops'
import { formatAddress } from './desktopForm'
import { shq } from './deskScript'
import { probesIn } from './probe'
import { execRemote, execStream, isConnected, isSSHTab, openTcpStream, pingRemote, SSHTab } from './ssh'

/** Tabby profile type of remote desktop tabs (see rdpProfile.ts). */
export const RDP_PROFILE_TYPE = 'rdp'

/** Somewhere a remote desktop can be reached: a remote account, plus how to talk to it. */
export interface RemoteTarget {
    /** Canonical `user@hostname:port` (resolved with `ssh -G`); one desktop per key. DIRECT_KEY for a direct connection. */
    key: string
    /** Short name for status messages, the on-screen display and menus: what the user calls it (a profile's name). */
    label: string
    /** The host's address or name, where the protocol wants one rather than a label (e.g. the RDP destination). */
    hostname?: string
    /** A stream to host:port as the remote sees it: its own 127.0.0.1, or a machine it can reach (a VM). */
    openTcp (host: string, port: number): Promise<Duplex>
    /** Runs a command on the remote with stdin, returns stdout. */
    exec (command: string, stdin: string): Promise<string>
    /** Whether the SSH connection is up now (false: wait for it before reconnecting). */
    isOpen (): boolean
    /** Asks the SSH connection to come back, where Tabby owns it. */
    reconnectSSH?: () => Promise<void>
    /** The Tabby SSH profile the connection was opened from (RDP profiles going through it are among its desktops). */
    profileId?: string
    /** A remote desktop tab's one desktop, connected to directly: no SSH host, no console, no desktop of its own. */
    direct?: DesktopSpec
    /** Round-trip time to the SSH server in ms, where it is cheap to measure (Tabby's own connection). */
    ping?: () => Promise<number>
    /** The SSH tab's host this is reached through, where it isn't that host itself (ssh typed in its console). */
    via?: string
}

/** A terminal pane the desktop can be layered over (an SSH tab, or a local terminal running `ssh`), or a remote desktop tab. */
export interface DesktopPane extends BaseTabComponent {
    element: { nativeElement: HTMLElement }
    frontend?: { focus (): void } | null
    profile?: { type?: string, name?: string, options?: { host?: string, user?: string, port?: number } }
    /** tabby-local session: getChildProcesses(): Promise<{ pid, ppid, command }[]> */
    session?: any
}

function isLocalTerminal (tab: BaseTabComponent | null | undefined): tab is DesktopPane {
    const t = tab as DesktopPane | null
    return t?.profile?.type === 'local' && !!t.element?.nativeElement && typeof t.session?.getChildProcesses === 'function'
}

/** A remote desktop tab (RDP profile, connecting directly): the desktop fills it, there is no terminal under it. */
export function isRDPTab (tab: BaseTabComponent | null | undefined): boolean {
    const t = tab as DesktopPane | null
    return t?.profile?.type === RDP_PROFILE_TYPE && !!t.element?.nativeElement
}

/** The pane a tab or tab-header action refers to: the pane itself, or a split's focused pane. */
export function desktopPaneOf (tab: BaseTabComponent | null | undefined): DesktopPane | null {
    const pane = tab instanceof SplitTabComponent ? tab.getFocusedTab() : tab
    return isSSHTab(pane) || isLocalTerminal(pane) || isRDPTab(pane) ? pane as DesktopPane : null
}

// ---- system ssh --------------------------------------------------------------------------------

function run (file: string, args: string[], timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error((stderr || err.message).toString().trim().split('\n').pop()))
            } else {
                resolve(stdout.toString())
            }
        })
    })
}

// ssh(1) options that take an argument.
const WITH_ARG = new Set('BbcDEeFIiJLlmOopQRSWw')
// Options worth carrying over to our own connections (identity, config, jump hosts, port, …).
// Everything else (forwards, TTY, background, control-master, verbosity, X11) is dropped.
const KEEP_WITH_ARG = new Set('BbcFIiJlmopS')
const KEEP_FLAG = new Set('46AaCgKkq')
// -o settings that would make our extra connections do something other than a plain exec/-W.
const DROP_O = /^(LocalForward|RemoteForward|DynamicForward|RequestTTY|RemoteCommand|SessionType|ControlMaster|ControlPersist|ForkAfterAuthentication|StdinNull|PermitLocalCommand|LocalCommand|ClearAllForwardings|ExitOnForwardFailure|BatchMode)\b/i

export interface SSHCommand {
    /** Options for our own connections, derived from the user's. */
    options: string[]
    destination: string
}

/** Parses an ssh(1) command line (without the leading `ssh`); null if it has no destination. */
export function parseSSHCommand (tokens: string[]): SSHCommand | null {
    const options: string[] = []
    let i = 0
    for (; i < tokens.length; i++) {
        const t = tokens[i]
        if (t === '--') {
            i++
            break
        }
        if (!t.startsWith('-') || t === '-') {
            break
        }
        for (let j = 1; j < t.length; j++) {
            const flag = t[j]
            if (WITH_ARG.has(flag)) {
                const value = j + 1 < t.length ? t.slice(j + 1) : tokens[++i]
                if (value === undefined) {
                    return null
                }
                if (KEEP_WITH_ARG.has(flag) && !(flag === 'o' && DROP_O.test(value))) {
                    options.push(`-${flag}`, value)
                }
                break
            }
            if (KEEP_FLAG.has(flag)) {
                options.push(`-${flag}`)
            }
        }
    }
    const destination = tokens[i]
    return destination ? { options, destination } : null
}

/** `user@hostname:port` from `ssh -G` output (config aliases, defaults resolved). */
function keyFromConfig (out: string, destination: string): string {
    const get = (k: string) => new RegExp(`^${k} (.+)$`, 'm').exec(out)?.[1]?.trim()
    return `${get('user') ?? ''}@${(get('hostname') ?? destination).toLowerCase()}:${get('port') ?? '22'}`
}

/** `user@hostname:port` as ssh itself resolves it (config aliases, defaults). */
async function resolveKey (options: string[], destination: string): Promise<string> {
    return keyFromConfig(await run('ssh', [...options, '-G', destination]), destination)
}

/** A target reached with the system `ssh`, non-interactively (keys/agent/control master only). */
class SystemSSHTarget implements RemoteTarget {
    constructor (readonly key: string, readonly label: string, private cmd: SSHCommand) { }

    private args (...extra: string[]): string[] {
        return [...this.cmd.options, '-o', 'BatchMode=yes', ...extra, this.cmd.destination]
    }

    async openTcp (host: string, port: number): Promise<Duplex> {
        const child = spawn('ssh', this.args('-o', 'ExitOnForwardFailure=yes', '-W', `${host.includes(':') ? `[${host}]` : host}:${port}`), { stdio: ['pipe', 'pipe', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', d => { stderr += d })
        const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
        stream.on('close', () => child.kill())
        child.on('exit', () => stream.destroy())
        // Fail fast if ssh can't connect (e.g. it would need a password).
        await new Promise<void>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', code => reject(new Error(sshFailure(this.label, stderr, code))))
            child.stdout.once('readable', () => resolve())
            setTimeout(resolve, 1500)
        })
        return stream
    }

    // Each tunnel and command is its own ssh process.
    isOpen (): boolean { return true }

    exec (command: string, stdin: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn('ssh', [...this.args('-T'), command], { stdio: ['pipe', 'pipe', 'pipe'] })
            let stdout = ''
            let stderr = ''
            child.stdout.on('data', d => { stdout += d })
            child.stderr.on('data', d => { stderr += d })
            const timer = setTimeout(() => child.kill(), 60000)
            child.on('error', reject)
            child.on('exit', code => {
                clearTimeout(timer)
                code === 255 ? reject(new Error(sshFailure(this.label, stderr, code))) : resolve(stdout)
            })
            child.stdin.end(stdin)
        })
    }
}

function sshFailure (label: string, stderr: string, code: number | null): string {
    const last = stderr.trim().split('\n').pop() ?? ''
    if (/permission denied|password|keyboard-interactive/i.test(last)) {
        return `Couldn't open a second SSH connection to ${label} without a password. Use an SSH key or agent (or a ControlMaster), or open the host as a Tabby SSH profile.`
    }
    return `ssh to ${label} failed${last ? `: ${last}` : ` (exit ${code})`}`
}

// ---- Tabby SSH tabs ----------------------------------------------------------------------------

class TabbySSHTarget implements RemoteTarget {
    constructor (readonly key: string, readonly label: string, private tab: SSHTab, readonly hostname?: string) { }
    openTcp (host: string, port: number): Promise<Duplex> { return openTcpStream(this.tab, host, port) }
    exec (command: string, stdin: string): Promise<string> { return execRemote(this.tab, command, stdin) }
    isOpen (): boolean { return isConnected(this.tab) }
    ping (): Promise<number> { return pingRemote(this.tab) }
    execStream (command: string): Promise<Duplex> { return execStream(this.tab, command) }
    get reconnectSSH (): (() => Promise<void>) | undefined {
        return typeof this.tab.reconnect === 'function' ? () => this.tab.reconnect!() : undefined
    }
    get profileId (): string | undefined { return (this.tab.profile as { id?: string } | undefined)?.id }
}

// ---- ssh typed in an SSH tab ---------------------------------------------------------------------

/** An `ssh` running in the foreground of a terminal on an SSH tab's host (typed at its prompt). */
export interface NestedSSH {
    cmd: SSHCommand
    /** Its terminal there. */
    tty: string
}

/**
 * Remote script: the user's `ssh` clients in the foreground of a terminal, one `TRD_SSH <n>|<tty>|<args>` line each, the
 * arguments separated by \037 (from /proc where there is one, so that quoted ones stay whole). Each one's terminal gets a
 * probe, `$PROBE-<n>` (see probe.ts), which shows which Tabby pane that terminal is.
 */
const nestedSSHScript = (probe: string) => `PROBE=${shq(probe)}\n` + String.raw`
n=0
for p in $(pgrep -u "$(id -u)" -x ssh 2>/dev/null); do
    set -- $(ps -o tty= -o stat= -p "$p" 2>/dev/null)
    case "$1:$2" in ?*:*+*) ;; *) continue ;; esac
    [ "$1" = "?" ] && continue
    n=$((n + 1))
    if [ -r "/proc/$p/cmdline" ]; then args=$(tr '\000' '\037' < "/proc/$p/cmdline"); else args=$(ps -o args= -p "$p" | tr ' ' '\037'); fi
    printf 'TRD_SSH %s|%s|%s\n' "$n" "$1" "$args"
    printf '\033]7777;probe;%s-%s\007' "$PROBE" "$n" > "/dev/$1" 2>/dev/null || true
done
`

/**
 * A machine reached from an SSH tab's host with the `ssh` typed there: each command and tunnel runs that host's own
 * ssh, non-interactively (its keys, or a forwarded agent). Like SystemSSHTarget, one hop further.
 */
class NestedSSHTarget implements RemoteTarget {
    constructor (readonly key: string, readonly label: string, private outer: TabbySSHTarget, private cmd: SSHCommand) { }

    get via (): string { return this.outer.label }

    private ssh (...extra: string[]): string {
        return ['ssh', ...this.cmd.options, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...extra, this.cmd.destination].map(shq).join(' ')
    }

    openTcp (host: string, port: number): Promise<Duplex> {
        return this.outer.execStream(`exec ${this.ssh('-o', 'ExitOnForwardFailure=yes', '-W', `${host.includes(':') ? `[${host}]` : host}:${port}`)} 2>/dev/null`)
    }

    async exec (command: string, stdin: string): Promise<string> {
        // ssh's exit status and last error line come after the output, so a failed login says why.
        const out = await this.outer.exec(`e=$(mktemp); ${this.ssh('-T')} ${shq(command)} 2>"$e"; r=$?; ` +
            `printf '\n__trd_hop %s %s\n' "$r" "$(tail -n 1 "$e")"; rm -f "$e"`, stdin)
        const m = /\n__trd_hop (\d+) ?(.*)\n?$/.exec(out)
        if (m?.[1] === '255') {
            throw new Error(/permission denied|password|keyboard-interactive|host key/i.test(m[2])
                ? `${this.outer.label} couldn't log in to ${this.label} by itself (${m[2].trim()}). The desktop goes through ${this.outer.label}'s own ssh, which needs a key for ${this.label} there, or agent forwarding.`
                : `ssh from ${this.outer.label} to ${this.label} failed${m[2] ? `: ${m[2].trim()}` : ''}`)
        }
        return m ? out.slice(0, m.index) : out
    }

    isOpen (): boolean { return this.outer.isOpen() }
    ping (): Promise<number> { return this.outer.ping() }
}

// ---- direct connections ------------------------------------------------------------------------

/** A remote desktop tab's RDP server, reached with a plain TCP connection from this computer (LAN, VPN). */
class DirectTarget implements RemoteTarget {
    readonly key = DIRECT_KEY
    constructor (readonly label: string, readonly direct: DesktopSpec) { }

    openTcp (host: string, port: number): Promise<Duplex> {
        return new Promise((resolve, reject) => {
            const socket = net.connect({ host, port })
            const timer = setTimeout(() => socket.destroy(new Error(`${formatAddress(host, port)} did not answer`)), 15000)
            socket.once('connect', () => {
                clearTimeout(timer)
                socket.setNoDelay(true)
                // Notices a dead peer (sleep, a dropped VPN) where the SSH path has the SSH connection's keepalive.
                socket.setKeepAlive(true, 10000)
                resolve(socket)
            })
            socket.once('error', e => {
                clearTimeout(timer)
                reject(e)
            })
        })
    }

    exec (): Promise<string> { return Promise.reject(new Error('A direct connection runs no commands')) }
    // Each connection is its own socket; there is nothing to wait for between them.
    isOpen (): boolean { return true }
}

// ---- detection ---------------------------------------------------------------------------------

/**
 * Works out which remote a pane is logged into. SSH tabs: their profile. Local terminals: an `ssh`
 * process running under the shell. Results are cached so the header can be updated synchronously.
 */
@Injectable({ providedIn: 'root' })
export class RemoteTargets {
    private cache = new WeakMap<DesktopPane, { target: RemoteTarget | null, pid?: number }>()
    private keys = new Map<string, Promise<string>>()

    /** Last known target of a pane (undefined: not looked up yet). */
    cached (pane: DesktopPane): RemoteTarget | null | undefined {
        return this.cache.get(pane)?.target
    }

    async targetOf (pane: DesktopPane): Promise<RemoteTarget | null> {
        let target: RemoteTarget | null = null
        let pid: number | undefined
        try {
            if (isRDPTab(pane)) {
                // Made afresh each time (it holds no state), so that an edited profile applies on the next connection.
                const profile = pane.profile as { name?: string, options?: any }
                // No `wake` for a direct one: starting a machine takes an SSH host to do it from.
                const spec = specOf({ ...profile.options, name: profile.name, wake: undefined })
                target = spec && new DirectTarget(formatAddress(spec.host, spec.port), spec)
            } else if (isSSHTab(pane)) {
                const o = pane.profile?.options ?? {}
                const known = this.cache.get(pane)?.target
                // Named as its profile is (Tabby's imports end in "(.ssh/config)"), else by its address.
                const named = (pane.profile?.name ?? '').replace(/\s*\(\.ssh\/config\)$/, '').trim()
                target = known ?? new TabbySSHTarget(
                    await this.key(['-l', o.user ?? '', '-p', String(o.port ?? 22)], o.host ?? ''),
                    named || o.host || 'remote', pane, o.host || undefined)
            } else {
                const found = await this.localSSH(pane)
                pid = found?.pid
                const known = this.cache.get(pane)
                if (found && known?.target && known.pid === found.pid) {
                    target = known.target
                } else if (found) {
                    target = new SystemSSHTarget(await this.key(found.cmd.options, found.cmd.destination), found.cmd.destination, found.cmd)
                }
            }
        } catch {
            target = null
        }
        this.cache.set(pane, { target, pid })
        return target
    }

    /**
     * `ssh` clients typed at a prompt in this pane, on its SSH tab's host: only those whose terminal there is this pane's
     * (see probe.ts), since other panes and tabs can be on the same host. Empty elsewhere.
     */
    async nestedSSH (pane: DesktopPane): Promise<NestedSSH[]> {
        const outer = await this.targetOf(pane)
        if (!(outer instanceof TabbySSHTarget)) {
            return []
        }
        const probe = `trd${Math.random().toString(36).slice(2, 10)}`
        const { result: out, ids } = await probesIn(pane, probe, () => outer.exec('sh -s', nestedSSHScript(probe)))
        const found: NestedSSH[] = []
        for (const line of out.split('\n')) {
            const m = /^TRD_SSH (\d+)\|([^|]*)\|(.*)$/.exec(line.trim())
            const args = m?.[3].split('\x1f').filter(Boolean) ?? []
            const cmd = /(^|\/)ssh$/.test(args[0] ?? '') ? parseSSHCommand(args.slice(1)) : null
            if (m && cmd && ids.has(`${probe}-${m[1]}`)) {
                found.push({ cmd, tty: m[2] })
            }
        }
        // One per destination.
        return found.filter((f, i, all) => all.findIndex(g => g.cmd.destination === f.cmd.destination) === i)
    }

    /** A target for an `ssh` found by nestedSSH(), going through the pane's SSH connection. */
    async nestedTarget (pane: DesktopPane, nested: NestedSSH): Promise<RemoteTarget | null> {
        const outer = await this.targetOf(pane)
        if (!(outer instanceof TabbySSHTarget)) {
            return null
        }
        const config = await outer.exec(`${['ssh', ...nested.cmd.options, '-G', nested.cmd.destination].map(shq).join(' ')} 2>/dev/null`, '')
        return new NestedSSHTarget(keyFromConfig(config, nested.cmd.destination), nested.cmd.destination, outer, nested.cmd)
    }

    private key (options: string[], destination: string): Promise<string> {
        const id = JSON.stringify([options, destination])
        let key = this.keys.get(id)
        if (!key) {
            key = resolveKey(options, destination)
            key.catch(() => this.keys.delete(id))
            this.keys.set(id, key)
        }
        return key
    }

    /**
     * The nearest `ssh` client running in the pane: a descendant of the terminal's own process.
     *
     * Found from one `ps` snapshot of the process tree rather than Tabby's child-process list: that list
     * starts from a "true PID" Tabby picks by following the shell's only child a couple of seconds after
     * start, which can be a short-lived helper (prompt/plugin startup) that is gone by the time you type
     * `ssh`, leaving the list empty for good.
     */
    private async localSSH (pane: DesktopPane): Promise<{ pid: number, cmd: SSHCommand } | null> {
        if (process.platform === 'win32') {
            return null
        }
        const root: number | undefined = await pane.session.pty?.getPID?.().catch(() => undefined)
        if (!root) {
            return null
        }
        // pid, ppid, full command line (ps loses quoting; ssh arguments rarely need it)
        const children = new Map<number, { pid: number, args: string[] }[]>()
        for (const line of (await run('ps', ['-ax', '-ww', '-o', 'pid=,ppid=,args='])).split('\n')) {
            const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
            if (m) {
                const list = children.get(Number(m[2])) ?? []
                list.push({ pid: Number(m[1]), args: m[3].trim().split(/\s+/) })
                children.set(Number(m[2]), list)
            }
        }
        // Breadth first, so the nearest ssh wins (e.g. the one typed at the prompt, not one it spawned).
        let level = [root]
        for (let depth = 0; depth < 6 && level.length; depth++) {
            const next: number[] = []
            for (const pid of level) {
                for (const child of children.get(pid) ?? []) {
                    if (/(^|\/)ssh$/.test(child.args[0] ?? '')) {
                        const cmd = parseSSHCommand(child.args.slice(1))
                        if (cmd) {
                            return { pid: child.pid, cmd }
                        }
                    }
                    next.push(child.pid)
                }
            }
            level = next
        }
        return null
    }
}
