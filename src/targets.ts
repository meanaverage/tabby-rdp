import { Injectable } from '@angular/core'
import { execFile, spawn } from 'child_process'
import { Duplex } from 'stream'
import { BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { execRemote, isConnected, isSSHTab, openTcpStream, SSHTab } from './ssh'

/** Somewhere a remote desktop can be reached: a remote account, plus how to talk to it. */
export interface RemoteTarget {
    /** Canonical `user@hostname:port` (resolved with `ssh -G`); one desktop per key. */
    key: string
    /** Short name for status messages. */
    label: string
    /** A stream to host:port as the remote sees it: its own 127.0.0.1, or a machine it can reach (a VM). */
    openTcp (host: string, port: number): Promise<Duplex>
    /** Runs a command on the remote with stdin, returns stdout. */
    exec (command: string, stdin: string): Promise<string>
    /** Whether the SSH connection is up now (false: wait for it before reconnecting). */
    isOpen (): boolean
    /** Asks the SSH connection to come back, where Tabby owns it. */
    reconnectSSH?: () => Promise<void>
}

/** A terminal pane the desktop can be layered over: an SSH tab, or a local terminal running `ssh`. */
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

/** The pane a tab or tab-header action refers to: the pane itself, or a split's focused pane. */
export function desktopPaneOf (tab: BaseTabComponent | null | undefined): DesktopPane | null {
    const pane = tab instanceof SplitTabComponent ? tab.getFocusedTab() : tab
    return isSSHTab(pane) || isLocalTerminal(pane) ? pane as DesktopPane : null
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

/** `user@hostname:port` as ssh itself resolves it (config aliases, defaults). */
async function resolveKey (options: string[], destination: string): Promise<string> {
    const out = await run('ssh', [...options, '-G', destination])
    const get = (k: string) => new RegExp(`^${k} (.+)$`, 'm').exec(out)?.[1]?.trim()
    return `${get('user') ?? ''}@${(get('hostname') ?? destination).toLowerCase()}:${get('port') ?? '22'}`
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
    constructor (readonly key: string, readonly label: string, private tab: SSHTab) { }
    openTcp (host: string, port: number): Promise<Duplex> { return openTcpStream(this.tab, host, port) }
    exec (command: string, stdin: string): Promise<string> { return execRemote(this.tab, command, stdin) }
    isOpen (): boolean { return isConnected(this.tab) }
    get reconnectSSH (): (() => Promise<void>) | undefined {
        return typeof this.tab.reconnect === 'function' ? () => this.tab.reconnect!() : undefined
    }
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
            if (isSSHTab(pane)) {
                const o = pane.profile?.options ?? {}
                const known = this.cache.get(pane)?.target
                target = known ?? new TabbySSHTarget(
                    await this.key(['-l', o.user ?? '', '-p', String(o.port ?? 22)], o.host ?? ''),
                    o.host ?? 'remote', pane)
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
