import { Duplex } from 'stream'
import { ByteQueue } from './byteQueue'

// The subset of russh's Channel (tabby-ssh) this module uses.
export interface SSHChannel {
    data$: { subscribe (o: { next: (d: Uint8Array) => void, error?: (e: any) => void }): unknown }
    eof$: { subscribe (f: () => void): unknown }
    closed$: { subscribe (f: () => void): unknown }
    write (data: Uint8Array): Promise<void>
    eof (): Promise<void>
    close (): Promise<void>
}

/**
 * What may wait in the stream for its reader. The channel can't be told to slow down (russh hands the data over as
 * it arrives), so a reader that has stopped for good would otherwise have the whole of what the server sends pile up
 * here.
 */
const MAX_PENDING = 64 * 1024 * 1024

/** Node Duplex over an SSH channel, so tls.connect() can run on top of it. */
export class SSHChannelStream extends Duplex {
    /**
     * What arrived while the reader wasn't reading, in one queue rather than as the pieces it came in: the server (or
     * the host on the way) decides how small those are, and each one kept as it came costs far more than its bytes (a
     * byte at a time, hundreds of times as much). Handed on in one piece once the reader asks again.
     */
    private held = new ByteQueue()
    /** The reader said to stop (push returned false): what comes is held until it asks again. */
    private waiting = false
    /** The channel ended while something was held: the end goes after it. */
    private ending = false

    constructor (private channel: SSHChannel) {
        super()
        channel.data$.subscribe({
            next: d => {
                const piece = Buffer.from(d.buffer, d.byteOffset, d.byteLength)
                if (!this.waiting) {
                    this.waiting = !this.push(piece)
                    return
                }
                this.held.push(piece)
                if (this.held.length + this.readableLength > MAX_PENDING) {
                    this.destroy(new Error('the desktop\'s data isn\'t being read: connection closed'))
                }
            },
            error: e => this.destroy(e instanceof Error ? e : new Error(String(e))),
        })
        channel.eof$.subscribe(() => this.channelEnded())
        channel.closed$.subscribe(() => {
            this.channelEnded()
            this.destroy()
        })
    }

    /** The channel's end: after what is held, if anything is. */
    private channelEnded (): void {
        if (this.held.length) {
            this.ending = true
        } else {
            this.push(null)
        }
    }

    // The channel pushes whenever data arrives; the reader asking again only takes what was held meanwhile.
    override _read (): void {
        this.waiting = false
        if (this.held.length) {
            this.waiting = !this.push(this.held.take(this.held.length))
        }
        if (this.ending && !this.held.length) {
            this.ending = false
            this.push(null)
        }
    }

    override _write (chunk: Buffer, _encoding: BufferEncoding, callback: (e?: Error | null) => void): void {
        this.channel.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)).then(() => callback(), callback)
    }

    override _final (callback: (e?: Error | null) => void): void {
        this.channel.eof().then(() => callback(), () => callback())
    }

    override _destroy (error: Error | null, callback: (e?: Error | null) => void): void {
        this.channel.close().catch(() => null)
        callback(error)
    }
}
