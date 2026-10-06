import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** The provider's supported file-size limit. Files are streamed; this much memory is never reserved. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const HANDLE_PENDING_BYTES = 16 * 1024 * 1024
const WINDOW_PENDING_BYTES = 64 * 1024 * 1024
const MIN_WRITE_COST = 64 * 1024
const MAX_HANDLES = 32
const INIT_TIMEOUT_MS = 15000 // earlier than the provider's 30-second initialization deadline

/** Both bytes and tasks are bounded: tiny chunks must not make an arbitrarily long promise queue. */
export class DownloadBudget {
    private pending = 0
    constructor (private readonly limit = WINDOW_PENDING_BYTES) { }
    reserve (bytes: number): () => void {
        const cost = Math.max(MIN_WRITE_COST, bytes)
        if (cost > this.limit - this.pending) { throw new Error('Too much download data is waiting to be saved.') }
        this.pending += cost
        let held = true
        return () => { if (held) { held = false; this.pending -= cost } }
    }
}
const windowBudget = new DownloadBudget()
export const DISK_PATH = Symbol('tabby-rdp download')

class DownloadFile {
    bytesWritten = 0
    private accepted = 0
    private state: 'open' | 'finalizing' | 'finalized' | 'aborting' | 'aborted' = 'open'
    private failure?: Error
    private tail: Promise<void> = Promise.resolve()
    private closed?: Promise<void>
    private finalized?: Promise<Blob>
    private aborted?: Promise<void>

    constructor (
        private file: string, private handle: fs.promises.FileHandle, private expected: number,
        private ownBudget: DownloadBudget, private sharedBudget: DownloadBudget, private ended: () => void,
    ) { }

    private get cancelled (): boolean { return this.state === 'aborting' || this.state === 'aborted' }

    write (chunk: Uint8Array): Promise<void> {
        let releaseOwn: (() => void) | undefined
        let releaseShared: (() => void) | undefined
        let data: Uint8Array
        try {
            if (this.state !== 'open') { throw new Error('The download is closed for writing.') }
            if (!(chunk instanceof Uint8Array) || !chunk.byteLength) { throw new Error('A download write must contain bytes.') }
            if (chunk.byteLength > this.expected - this.accepted) { throw new Error('The download exceeds its expected size.') }
            releaseOwn = this.ownBudget.reserve(chunk.byteLength)
            releaseShared = this.sharedBudget.reserve(chunk.byteLength)
            // Hold only the admitted bytes, not a small view retaining a much larger backing buffer.
            data = Uint8Array.from(chunk)
            this.accepted += data.byteLength
        } catch (error) {
            releaseOwn?.()
            releaseShared?.()
            if (this.state === 'open') { this.fail(error) }
            return Promise.reject(error)
        }
        const writing = this.tail.then(async () => {
            if (this.failure || this.cancelled) { throw this.failure ?? new Error('The download was cancelled.') }
            await this.handle.appendFile(data)
            this.bytesWritten += data.byteLength
            if (this.cancelled) { throw new Error('The download was cancelled.') }
        }).finally(() => { releaseOwn!(); releaseShared!() })
        this.tail = writing.catch(error => { this.fail(error) })
        return writing
    }

    private fail (error: unknown): void {
        this.failure ??= error instanceof Error ? error : new Error('The download could not be written.')
        // Cleanup waits for already-started native I/O. The error is returned by write/finalize; dispose retries cleanup.
        void this.abort().catch(() => null)
    }

    private close (): Promise<void> {
        return this.closed ??= this.handle.close().finally(this.ended)
    }

    finalize (): Promise<Blob> {
        if (this.cancelled) { return Promise.reject(this.failure ?? new Error('The download was cancelled.')) }
        if (this.finalized) { return this.finalized }
        if (this.state !== 'open') { return Promise.reject(this.failure ?? new Error('The download is closed.')) }
        this.state = 'finalizing' // no further admission; writes already accepted still finish in order
        this.finalized = this.tail.then(async () => {
            if (this.failure || this.state !== 'finalizing') { throw this.failure ?? new Error('The download was cancelled.') }
            if (this.bytesWritten !== this.expected) { throw new Error('The download ended before its expected size.') }
            await this.close()
            if (this.state !== 'finalizing') { throw new Error('The download was cancelled.') }
            this.state = 'finalized'
            return Object.assign(new Blob([]), { [DISK_PATH]: this.file })
        }).catch(async error => { await this.abort().catch(() => null); throw error })
        return this.finalized
    }

    abort (): Promise<void> {
        if (this.aborted) { return this.aborted }
        this.state = 'aborting'
        this.aborted = this.tail.then(async () => {
            try { await this.close() } finally { await fs.promises.rm(this.file, { force: true }) }
            this.state = 'aborted'
        })
        return this.aborted
    }
}

/** Private temporary storage, bounded before asynchronous I/O, with ordered completion and cancellation. */
export class DiskStorage {
    readonly name = 'disk'
    private dir: Promise<string> | null = null
    private count = 0
    private disposed = false
    private disposing?: Promise<void>
    private files = new Set<DownloadFile>()
    private creating = new Set<Promise<DownloadFile>>()

    /** Smaller budgets/deadlines can be supplied by local filesystem tests without large allocations. */
    constructor (private options: { pendingBytes?: number, budget?: DownloadBudget, initTimeoutMs?: number } = {}) { }

    createWriteHandle (_fileName: string, expectedSize: number): Promise<DownloadFile> {
        if (this.disposed) { return Promise.reject(new Error('The download storage is closed.')) }
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_DOWNLOAD_BYTES) {
            return Promise.reject(new Error('The download has no supported expected size.'))
        }
        if (this.creating.size + this.files.size >= MAX_HANDLES) { return Promise.reject(new Error('Too many downloads are open.')) }
        let expired = false
        let timer: ReturnType<typeof setTimeout>
        const making = (async () => {
            this.dir ??= fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-rdp-'))
            const dir = await this.dir
            if (this.disposed || expired) { throw new Error('Download initialization was cancelled.') }
            const file = path.join(dir, String(++this.count))
            let handle: DownloadFile | undefined
            try {
                const opened = await fs.promises.open(file, 'wx', 0o600)
                handle = new DownloadFile(file, opened, expectedSize, new DownloadBudget(this.options.pendingBytes ?? HANDLE_PENDING_BYTES),
                    this.options.budget ?? windowBudget, () => this.files.delete(handle!))
                this.files.add(handle)
                if (this.disposed || expired) { throw new Error('Download initialization was cancelled.') }
                return handle
            } catch (error) {
                await handle?.abort().catch(() => null)
                await fs.promises.rm(file, { force: true }).catch(() => null)
                throw error
            }
        })()
        this.creating.add(making)
        void making.then(() => this.creating.delete(making), () => this.creating.delete(making))
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { expired = true; reject(new Error('Download storage did not open in time.')) }, this.options.initTimeoutMs ?? INIT_TIMEOUT_MS)
        })
        return Promise.race([making, deadline]).finally(() => clearTimeout(timer))
    }

    dispose (): Promise<void> {
        this.disposed = true // also invalidates initialization still waiting on native filesystem work
        this.disposing ??= (async () => {
            // Abort before awaiting initialization: accepted writes stop taking more data immediately.
            const aborting = [...this.files].map(file => file.abort())
            await Promise.allSettled([...this.creating, ...aborting])
            if (this.dir) { await this.dir.then(dir => fs.promises.rm(dir, { recursive: true, force: true }), () => null) }
        })()
        // The provider does not await dispose(); callers that do still receive its actual cleanup result.
        void this.disposing.catch(() => null)
        return this.disposing
    }
}
