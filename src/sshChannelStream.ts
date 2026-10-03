import { Duplex } from 'stream'

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
    constructor (private channel: SSHChannel) {
        super()
        channel.data$.subscribe({
            next: d => {
                if (!this.push(Buffer.from(d.buffer, d.byteOffset, d.byteLength)) && this.readableLength > MAX_PENDING) {
                    this.destroy(new Error('the desktop\'s data isn\'t being read: connection closed'))
                }
            },
            error: e => this.destroy(e instanceof Error ? e : new Error(String(e))),
        })
        channel.eof$.subscribe(() => this.push(null))
        channel.closed$.subscribe(() => {
            this.push(null)
            this.destroy()
        })
    }

    // The channel pushes whenever data arrives; there is no pull side to drive.
    override _read (): void { }

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
