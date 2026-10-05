// A stand-in for a desktop's proxy and the server behind it, as what reads files and shared folders for the remote
// sees them (ServerFlow in src/rdcleanpath.ts): the room it gives, and what becomes of what is handed to the
// connection. Not a test file itself: test:unit runs test/unit/*.ts only.

/**
 * What is handed to the connection, and how far the proxy and the server have read it. The proxy reads what is handed
 * a message at a time, one in each turn of the event loop, as a socket's data comes in (after the promises already
 * settled have run), and stops once the server has more than `highWater` of it unread, until the server has read all
 * it was sent (as the real one does, on the server's 'drain'). The server reads only when let (`tick`). The room is as
 * the real proxy gives it (`window`, made again by every byte the proxy reads). `taking` and `whenTaking` say whether
 * the proxy is reading: what readers waited for before there was room, so that a test shows what that let through.
 */
export class Link {
    /** Bytes handed to the connection, read by the proxy, read by the server. */
    handed = 0
    proxyRead = 0
    serverRead = 0
    /** The most there has been handed to the connection and not read by the proxy: what waited in the window. */
    most = 0
    private owed = 0
    private stalled = false
    private reading = false
    private roomWaiters: (() => void)[] = []
    private takingWaiters: (() => void)[] = []

    constructor (private window: number, private highWater: number, private message = 1024 * 1024) { }

    room = (): boolean => this.owed < this.window
    spend = (bytes: number): void => {
        if (bytes > 0) {
            this.owed += bytes
        }
    }

    refund = (bytes: number): void => {
        if (bytes > 0) {
            this.owed = Math.max(0, this.owed - bytes)
            this.wake()
        }
    }

    whenRoom = (): Promise<void> => this.room() ? Promise.resolve() : new Promise<void>(resolve => this.roomWaiters.push(resolve))
    taking = (): boolean => !this.stalled
    whenTaking = (): Promise<void> => this.stalled ? new Promise<void>(resolve => this.takingWaiters.push(resolve)) : Promise.resolve()

    /** An answer of `bytes` handed to the connection. */
    hand (bytes: number): void {
        this.handed += bytes
        this.most = Math.max(this.most, this.handed - this.proxyRead)
        this.proxyReads()
    }

    /** The server reads up to `bytes` of what the proxy sent it. */
    tick (bytes: number): void {
        this.serverRead += Math.min(bytes, this.proxyRead - this.serverRead)
        if (this.stalled && this.serverRead === this.proxyRead) {
            this.stalled = false
            this.takingWaiters.splice(0).forEach(resolve => resolve())
        }
        this.proxyReads()
    }

    /** The proxy reads from the connection, a message in each turn, as long as it isn't waiting for the server. */
    private proxyReads (): void {
        if (this.reading || this.stalled || this.proxyRead >= this.handed) {
            return
        }
        this.reading = true
        setImmediate(() => {
            this.reading = false
            if (!this.stalled) {
                const read = Math.min(this.message, this.handed - this.proxyRead)
                this.proxyRead += read
                this.owed = Math.max(0, this.owed - read)
                this.stalled = this.proxyRead - this.serverRead > this.highWater
                this.wake()
            }
            this.proxyReads()
        })
    }

    private wake (): void {
        if (this.room()) {
            this.roomWaiters.splice(0).forEach(resolve => resolve())
        }
    }
}
