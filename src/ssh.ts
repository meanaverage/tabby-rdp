import { BaseTabComponent } from 'tabby-core'
import { Duplex } from 'stream'
import { SSHChannelStream } from './sshChannelStream'

/** An SSH terminal tab (tabby-ssh), duck-typed so this plugin doesn't import tabby-ssh. */
export interface SSHTab extends BaseTabComponent {
    sshSession?: { ssh?: any, open?: boolean, willDestroy$?: { subscribe (o: (() => void) | { next?: () => void, complete?: () => void }): { unsubscribe (): void } } } | null
    /** Reconnects the tab's SSH session (tabby-ssh). */
    reconnect?: () => Promise<void>
    profile?: { type?: string, name?: string, options?: { host?: string, user?: string, port?: number } }
    element: { nativeElement: HTMLElement }
    frontend?: { focus (): void } | null
}

export function isSSHTab (tab: BaseTabComponent | null | undefined): tab is SSHTab {
    // The profile is set when the tab is created; sshSession only once it connects.
    return (tab as SSHTab | null)?.profile?.type === 'ssh' && !!(tab as SSHTab).element?.nativeElement
}

// SSH sessions Tabby has torn down. They still say `open` afterwards, and the tab keeps them until it reconnects.
const destroyed = new WeakSet<object>()
const watched = new WeakSet<object>()

/** Whether the tab's SSH connection is up (not closed, not torn down). */
export function isConnected (tab: SSHTab): boolean {
    const session = tab.sshSession
    if (!session) {
        return false
    }
    if (!watched.has(session)) {
        watched.add(session)
        // willDestroy$ completes after it fires, so subscribing late still reports it.
        const mark = () => destroyed.add(session)
        session.willDestroy$?.subscribe({ next: mark, complete: mark })
    }
    return !!session.open && !destroyed.has(session)
}

function client (tab: SSHTab): any {
    const ssh = tab.sshSession?.ssh
    if (!isConnected(tab) || typeof ssh?.openTCPForwardChannel !== 'function') {
        throw new Error('The SSH connection is not open')
    }
    return ssh
}

/** A direct-tcpip channel to host:port as the remote sees it (e.g. its own 127.0.0.1), as a Node stream. */
export async function openTcpStream (tab: SSHTab, host: string, port: number): Promise<Duplex> {
    const ssh = client(tab)
    const session = tab.sshSession
    const channel = await ssh.activateChannel(await ssh.openTCPForwardChannel({
        addressToConnectTo: host,
        portToConnectTo: port,
        originatorAddress: '127.0.0.1',
        originatorPort: 0,
    }))
    const stream = new SSHChannelStream(channel)
    // When Tabby tears the SSH session down (dropped connection, Reconnect), its channels don't report closing:
    // end the stream then, so the desktop notices instead of freezing.
    const gone = session?.willDestroy$?.subscribe(() => stream.destroy(new Error('the SSH connection closed')))
    stream.once('close', () => gone?.unsubscribe())
    return stream
}

/**
 * A command on the remote whose stdin and stdout are the stream (a session channel, no PTY): e.g. `ssh -W` run there,
 * for a tunnel that goes on from the remote. Its stderr is not part of it.
 */
export async function execStream (tab: SSHTab, command: string): Promise<Duplex> {
    const ssh = client(tab)
    const session = tab.sshSession
    const channel = await ssh.activateChannel(await ssh.openSessionChannel())
    const stream = new SSHChannelStream(channel)
    await channel.requestExec(command)
    const gone = session?.willDestroy$?.subscribe(() => stream.destroy(new Error('the SSH connection closed')))
    stream.once('close', () => gone?.unsubscribe())
    return stream
}

/**
 * One round trip to the SSH server: opening a session channel waits for the server's confirmation, and nothing
 * runs on the remote until a command is requested on it, so this costs next to nothing there.
 */
export async function pingRemote (tab: SSHTab): Promise<number> {
    const ssh = client(tab)
    const started = performance.now()
    const channel = await ssh.openSessionChannel()
    const ms = performance.now() - started
    ssh.activateChannel(channel).then((c: any) => c.close()).catch(() => null)
    return ms
}

// Printed after a command's output, so that execRemote knows all of it arrived.
const END = '__trd_exec_end__'

/**
 * What a command's output may be at most. The plugin's commands print a few lines (a host's VMs: a line each); a host
 * that sends more is sending what it likes, which would otherwise all be kept, and parsed, on the thread that runs
 * Tabby's window.
 */
export const MAX_OUTPUT = 4 * 1024 * 1024

/** What a command that printed more than MAX_OUTPUT fails with. */
export function tooMuchOutput (): Error {
    return new Error(`Remote command printed more than ${MAX_OUTPUT / 1024 / 1024} MB where a few lines were expected: stopped reading it`)
}

/**
 * A command's output as it arrives, up to MAX_OUTPUT: copied into one buffer of its own, grown by doubling, rather than
 * kept as the pieces it came in. A host can send its output a byte at a time, and millions of one-byte pieces take far
 * more memory as pieces than as bytes.
 */
export class Output {
    private buffer = Buffer.alloc(0)
    /** How much has come; past MAX_OUTPUT, more than it (the rest isn't kept). */
    size = 0

    get overflowed (): boolean {
        return this.size > MAX_OUTPUT
    }

    /** Adds what came; false once there is more than MAX_OUTPUT. */
    add (piece: Uint8Array): boolean {
        if (this.size + piece.byteLength > MAX_OUTPUT) {
            this.size = MAX_OUTPUT + 1
            return false
        }
        if (this.size + piece.byteLength > this.buffer.length) {
            const grown = Buffer.allocUnsafe(Math.min(MAX_OUTPUT, Math.max(this.buffer.length * 2, this.size + piece.byteLength, 64 * 1024)))
            this.buffer.copy(grown, 0, 0, this.size)
            this.buffer = grown
        }
        this.buffer.set(piece, this.size)
        this.size += piece.byteLength
        return true
    }

    /** What has come so far (not past MAX_OUTPUT). */
    bytes (): Buffer {
        return this.buffer.subarray(0, Math.min(this.size, MAX_OUTPUT))
    }
}

/**
 * Picks up data for a closed channel that Tabby's russh binding received after the close. Its data, EOF and close
 * events come through separate callbacks, in no fixed order, and the close drops the channel's data subscription:
 * later data waits in a new buffer that nothing reads (seen with Tabby 1.0.237 on Windows).
 * Reported upstream: https://github.com/Eugeny/russh-napi/issues/3
 */
function drainLateData (ssh: any, id: unknown, take: (d: Uint8Array) => void) {
    const data = ssh.events?.data$
    if (typeof data?.subscribe !== 'function') {
        return
    }
    data.subscribe(id).subscribe(take).unsubscribe()
    data.closeChannel?.(id)
}

/** Runs `command` on the remote with `stdin`, returns stdout. No PTY, no exit status (russh doesn't expose it). */
export async function execRemote (tab: SSHTab, command: string, stdin = '', timeoutMs = 60000): Promise<string> {
    const ssh = client(tab)
    // One limit on time for all of it, from opening the channel on: a server that never confirms the channel, or the
    // command, would otherwise keep whatever waits for the answer (a VM scan, a desktop's setup) waiting for good.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Remote command timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    })
    timeout.catch(() => null)
    const opening: Promise<any> = Promise.resolve().then(() => ssh.openSessionChannel()).then((c: any) => ssh.activateChannel(c))
    const output = new Output()
    // Whether END has come: looked for in what is new and the end of what came before, since it can straddle the two.
    let ended = false
    let overflow: (e: Error) => void = () => null
    const overflowed = new Promise<never>((_, reject) => { overflow = reject })
    overflowed.catch(() => null)
    let channel: any = null
    const take = (d: Uint8Array) => {
        if (output.overflowed) {
            return
        }
        const from = Math.max(0, output.size - (END.length - 1))
        if (!output.add(d)) {
            channel?.close().catch(() => null)
            return overflow(tooMuchOutput())
        }
        ended ||= output.bytes().includes(END, from)
    }
    try {
        channel = await Promise.race([opening, timeout])
        const closed = new Promise<void>(resolve => channel.closed$.subscribe(() => resolve()))
        channel.data$.subscribe(take)
        // What the host sends meanwhile counts too: past MAX_OUTPUT it ends this, whatever step it is at.
        const started = (async () => {
            await channel.requestExec(`${command}\necho ${END}`)
            if (stdin) {
                await channel.write(new Uint8Array(Buffer.from(stdin)))
            }
            await channel.eof()
        })()
        started.catch(() => null)
        await Promise.race([started, timeout, overflowed])
        await Promise.race([closed, timeout, overflowed])
    } finally {
        clearTimeout(timer)
        if (channel) {
            channel.close().catch(() => null)
        } else {
            // A channel that opens after the time is up is closed then.
            opening.then((c: any) => c?.close(), () => null).catch(() => null)
        }
    }
    for (let i = 0; i < 40 && !ended && !output.overflowed; i++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        drainLateData(ssh, channel.id, take)
    }
    if (output.overflowed) {
        throw tooMuchOutput()
    }
    // Decoded once, all of it: a character's bytes can straddle two pieces.
    const result = output.bytes().toString('utf8')
    const end = result.lastIndexOf(END)
    return end < 0 ? result : result.slice(0, end)
}
