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

// Printed after a command's output, so that execRemote knows all of it arrived.
const END = '__trd_exec_end__'

/**
 * Picks up data for a closed channel that Tabby's russh binding received after the close. Its data, EOF and close
 * events come through separate callbacks, in no fixed order, and the close drops the channel's data subscription:
 * later data waits in a new buffer that nothing reads (seen with Tabby 1.0.237 on Windows).
 * Reported upstream: https://github.com/Eugeny/russh-napi/issues/3
 */
function drainLateData (ssh: any, id: unknown, out: Buffer[]) {
    const data = ssh.events?.data$
    if (typeof data?.subscribe !== 'function') {
        return
    }
    data.subscribe(id).subscribe((d: Uint8Array) => out.push(Buffer.from(d))).unsubscribe()
    data.closeChannel?.(id)
}

/** Runs `command` on the remote with `stdin`, returns stdout. No PTY, no exit status (russh doesn't expose it). */
export async function execRemote (tab: SSHTab, command: string, stdin = '', timeoutMs = 60000): Promise<string> {
    const ssh = client(tab)
    const channel = await ssh.activateChannel(await ssh.openSessionChannel())
    const out: Buffer[] = []
    const text = () => Buffer.concat(out).toString('utf8')
    const closed = new Promise<void>(resolve => channel.closed$.subscribe(() => resolve()))
    channel.data$.subscribe((d: Uint8Array) => out.push(Buffer.from(d)))
    await channel.requestExec(`${command}\necho ${END}`)
    if (stdin) {
        await channel.write(new Uint8Array(Buffer.from(stdin)))
    }
    await channel.eof()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Remote command timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    })
    try {
        await Promise.race([closed, timeout])
    } finally {
        clearTimeout(timer)
        channel.close().catch(() => null)
    }
    for (let i = 0; i < 40 && !text().includes(END); i++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        drainLateData(ssh, channel.id, out)
    }
    const result = text()
    const end = result.lastIndexOf(END)
    return end < 0 ? result : result.slice(0, end)
}
