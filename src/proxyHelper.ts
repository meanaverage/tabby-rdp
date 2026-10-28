// The plugin's side of its channel to the network helper (helper/, a Go program shipped prebuilt in bin/): the helper
// runs the RDCleanPath proxy and the connections behind it, and asks the plugin for what it decides (see
// rdcleanpath.ts). Binary frames on the helper's stdin and stdout: a 4-byte big-endian length (of everything after
// it), a type byte, a 4-byte big-endian id, then the payload. Messages are JSON, with any binary data they carry (a
// certificate chain, trust roots) after the JSON as raw bytes, listed by length in its `blobs`; a stream's bytes go
// in frames of their own, never in JSON. The helper's side is helper/internal/ipc; PROTOCOL says which version both
// speak.
import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Duplex } from 'stream'
import { ByteQueue } from './byteQueue'

/** The version of the channel this plugin speaks (helper/internal/ipc's Protocol). */
export const PROTOCOL = 2

const TYPE_MESSAGE = 1
const TYPE_DATA = 2
const TYPE_ACK = 3
const TYPE_END = 4
const TYPE_CLOSE = 5
const HEADER = 9
/** What a frame's payload may be at most. */
const MAX_FRAME = 16 << 20
/** What a data frame carries at most. */
const MAX_DATA = 64 << 10
/** A stream's bytes sent and not yet acknowledged, each way. */
const WINDOW = 1 << 20
/** How long the helper has to say hello. */
const HELLO_TIMEOUT_MS = 10_000
/** How long the helper has to stop once asked, before it is killed. */
const SHUTDOWN_GRACE_MS = 2_000
/** What is kept of the helper's error output (a crash's), for the failure it reports. */
const STDERR_TAIL = 4096

/** The helper for this computer: bin/<platform>-<arch>/ next to dist/. */
export function helperPath (): string {
    const name = process.platform === 'win32' ? 'tabby-rdp-proxy.exe' : 'tabby-rdp-proxy'
    return path.join(__dirname, '..', 'bin', `${process.platform}-${process.arch}`, name)
}

export interface Envelope {
    type: 'hello' | 'request' | 'response' | 'event'
    id?: number
    method?: string
    event?: string
    error?: string
    code?: string
    body?: any
    blobs?: number[]
}

/** A request's answer: a body and blobs, or an error (its text, and what kind of error it is where that matters). */
export interface Answer {
    body?: unknown
    blobs?: Buffer[]
}

/** An error a request's handler throws, with a code for the helper (gateway sign-in refusals, say). */
export class CodedError extends Error {
    constructor (message: string, readonly code: string) { super(message) }
}

/** How the helper ended: its exit code or signal, and the end of what it wrote to its error output. */
export interface HelperExit {
    code: number | null
    signal: NodeJS.Signals | null
    stderr: string
    /** It was asked to stop (close()), or it ended on its own. */
    expected: boolean
}

/**
 * A byte stream the plugin opened (an SSH channel, say) carried for the helper. Each way, the sender keeps within
 * WINDOW bytes the receiver hasn't acknowledged: what the helper sends is acknowledged once the stream has taken it
 * (its write's callback), and what the stream gives is sent as far as the helper's credit goes. The rest waits here,
 * with the stream paused, until the helper takes some: a stream can give a great deal at once (SSHChannelStream hands
 * over all it held while its reader paused, in one piece), and the helper ends a stream sent more than its window.
 */
class Bridge {
    private unacked = 0
    /** What the stream gave and the helper has no credit for yet, oldest first. */
    private waiting: Buffer[] = []
    private waitingBytes = 0
    private paused = false
    /** The stream ended: the END goes once what waits has gone. */
    private ending = false
    private ended = false
    /** The stream closed after it ended: the CLOSE goes after the END, so that what waits isn't lost. */
    private closing = false
    private closed = false

    constructor (private helper: Helper, readonly id: number, readonly stream: Duplex) {
        stream.on('data', (chunk: Buffer) => {
            this.waiting.push(chunk)
            this.waitingBytes += chunk.length
            this.pump()
        })
        stream.on('end', () => {
            this.ending = true
            this.pump()
        })
        stream.on('error', (e: Error) => this.closeWith(e.message || 'the stream failed'))
        stream.on('close', () => {
            if (this.ending && !this.ended) {
                this.closing = true
            } else {
                this.closeWith('')
            }
        })
    }

    /** Sends what waits, as far as the credit goes; pauses the stream while anything is left. */
    private pump (): void {
        if (this.closed) {
            return
        }
        while (this.waiting.length && this.unacked < WINDOW) {
            const head = this.waiting[0]
            const piece = head.subarray(0, Math.min(MAX_DATA, WINDOW - this.unacked))
            if (piece.length === head.length) {
                this.waiting.shift()
            } else {
                this.waiting[0] = head.subarray(piece.length)
            }
            this.waitingBytes -= piece.length
            this.unacked += piece.length
            this.helper.write(TYPE_DATA, this.id, piece)
        }
        if (this.waiting.length) {
            if (!this.paused) {
                this.paused = true
                this.stream.pause()
            }
        } else {
            if (this.paused) {
                this.paused = false
                this.stream.resume()
            }
            if (this.ending && !this.ended) {
                this.ended = true
                this.helper.write(TYPE_END, this.id)
                if (this.closing) {
                    this.closeWith('')
                }
            }
        }
    }

    private closeWith (why: string): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.waiting = []
        this.waitingBytes = 0
        this.helper.forgetBridge(this.id)
        this.helper.write(TYPE_CLOSE, this.id, Buffer.from(why))
    }

    /** The helper's bytes for the stream. */
    data (payload: Buffer): void {
        if (this.closed || this.stream.destroyed) {
            return
        }
        this.stream.write(payload, () => this.helper.write(TYPE_ACK, this.id, count(payload.length)))
    }

    /** The helper took `n` of the stream's bytes: room for what waits. */
    ack (n: number): void {
        this.unacked = Math.max(0, this.unacked - n)
        this.pump()
    }

    /** The helper has no more bytes for the stream. */
    end (): void {
        if (!this.stream.destroyed) {
            this.stream.end()
        }
    }

    /** The helper is done with the stream. */
    destroy (): void {
        this.closed = true
        this.waiting = []
        this.waitingBytes = 0
        this.helper.forgetBridge(this.id)
        this.stream.destroy()
    }
}

function count (n: number): Buffer {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32BE(n >>> 0)
    return b
}

/**
 * A running helper: requests to it and from it, its events, and the streams the plugin carries for it. It ends when
 * close() is called, when it fails, or when it is killed; `exited` says how.
 */
export class Helper {
    /** Answers the helper's requests: a body (and blobs), or a thrown error whose text is the answer. */
    onRequest: (method: string, body: any, blobs: Buffer[]) => Promise<Answer | void> = async method => { throw new Error(`unknown method ${method}`) }
    /** Hears the helper's events; throws for one it can't take, which stops the helper (see fail). */
    onEvent: (event: string, body: any, blobs: Buffer[]) => void = () => null
    /** Resolves once the helper process has ended. */
    readonly exited: Promise<HelperExit>

    private queue = new ByteQueue()
    private nextId = 0
    private pending = new Map<number, { resolve: (m: { envelope: Envelope, blobs: Buffer[] }) => void, reject: (e: Error) => void }>()
    private bridges = new Map<number, Bridge>()
    /** Stream numbers the helper asked a stream for, which the plugin hasn't opened yet (see expect). */
    private opening = new Set<number>()
    /** Of those, the ones the helper has given up on meanwhile: closed as soon as they are opened. */
    private abandoned = new Set<number>()
    private stderr = ''
    private dead = false
    /** The helper sent something that isn't the protocol: it is being killed, and nothing more it sends is read. */
    private broken = false
    private closing = false
    private hello: ((e: Envelope) => void) | null = null

    private constructor (private child: ChildProcess) {
        this.exited = new Promise(resolve => {
            child.once('exit', (code, signal) => {
                this.dead = true
                const error = new Error(this.closing ? 'the network helper was stopped' : 'the network helper stopped unexpectedly')
                for (const { reject } of this.pending.values()) {
                    reject(error)
                }
                this.pending.clear()
                for (const bridge of [...this.bridges.values()]) {
                    bridge.destroy()
                }
                resolve({ code, signal, stderr: this.stderr.trim(), expected: this.closing })
            })
        })
        child.stdout!.on('data', (chunk: Buffer) => this.read(chunk))
        child.stderr!.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL) })
        // A helper that has gone fails the writes to it: its exit says why.
        child.stdin!.on('error', () => null)
    }

    /**
     * Starts the helper (bin/<platform>-<arch>/) and waits for its hello. Fails, with the helper killed, where there
     * is none for this computer, it doesn't start, it doesn't say hello in time, or it speaks another protocol.
     */
    static async start (file = helperPath()): Promise<Helper> {
        const env = { ...process.env }
        // Its TLS and certificate checks are its own, not the environment's.
        delete env.GODEBUG
        const launch = () => spawn(file, ['--protocol', String(PROTOCOL)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
        const started = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve)
            child.once('error', reject)
        })
        let child = launch()
        try {
            await started(child)
        } catch (e: any) {
            // An installation that lost the executable's mode (npm keeps it; a copy may not): given back once.
            if (e?.code === 'EACCES' && process.platform !== 'win32' && fs.existsSync(file)) {
                fs.chmodSync(file, 0o755)
                child = launch()
                await started(child).catch(missing(file))
            } else {
                missing(file)(e)
            }
        }
        const helper = new Helper(child)
        let timer: NodeJS.Timeout | undefined
        // Ending later, once it has started, is no failure to start: handled here, heard of through `exited`.
        const ended = helper.exited.then(exit => Promise.reject(new Error(`the network helper didn't start (${describeExit(exit)})`)))
        ended.catch(() => null)
        try {
            const hello = await Promise.race([
                new Promise<Envelope>(resolve => { helper.hello = resolve }),
                ended,
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the network helper didn\'t start in time')), HELLO_TIMEOUT_MS) }),
            ])
            if (hello.body?.protocol !== PROTOCOL) {
                throw new Error(`the network helper speaks protocol ${hello.body?.protocol}, the plugin ${PROTOCOL}: reinstall the plugin`)
            }
            return helper
        } catch (e) {
            helper.kill()
            throw e
        } finally {
            clearTimeout(timer)
        }
    }

    /** Whether the helper process has ended. */
    get ended (): boolean { return this.dead }

    // ---- frames ------------------------------------------------------------------------------------------

    /** Writes a frame; nothing once the helper has ended. */
    write (type: number, id: number, ...parts: Buffer[]): void {
        if (this.dead || this.child.stdin!.destroyed) {
            return
        }
        const header = Buffer.allocUnsafe(HEADER)
        header.writeUInt32BE(5 + parts.reduce((n, p) => n + p.length, 0), 0)
        header[4] = type
        header.writeUInt32BE(id >>> 0, 5)
        const stdin = this.child.stdin!
        stdin.cork()
        stdin.write(header)
        for (const part of parts) {
            if (part.length) {
                stdin.write(part)
            }
        }
        stdin.uncork()
    }

    private read (chunk: Buffer): void {
        if (this.broken) {
            return
        }
        if (this.queue.length) {
            this.queue.push(chunk)
            this.drain()
            return
        }
        // Frames whole in the piece that came are taken as parts of it; only what is left waits in the queue.
        let at = 0
        while (chunk.length - at >= HEADER) {
            const length = chunk.readUInt32BE(at)
            if (!this.valid(length)) {
                return
            }
            if (chunk.length - at < 4 + length) {
                break
            }
            this.frame(chunk.subarray(at, at + 4 + length))
            at += 4 + length
            if (this.broken) {
                return
            }
        }
        if (at < chunk.length) {
            this.queue.push(chunk.subarray(at))
        }
    }

    private drain (): void {
        while (this.queue.length >= HEADER) {
            const length = this.queue.peek(4).readUInt32BE(0)
            if (!this.valid(length)) {
                return
            }
            if (this.queue.length < 4 + length) {
                return
            }
            this.frame(this.queue.take(4 + length))
            if (this.broken) {
                return
            }
        }
    }

    private valid (length: number): boolean {
        if (length < 5 || length - 5 > MAX_FRAME) {
            this.fail(`the helper sent a frame of ${length} bytes`)
            return false
        }
        return true
    }

    /**
     * The helper sent something that isn't the protocol: it is killed, with what it sent noted for the failure its
     * exit reports, and nothing more it sent is read. Its exit fails what waits on it.
     */
    private fail (why: string): void {
        if (this.broken) {
            return
        }
        this.broken = true
        this.queue = new ByteQueue()
        this.stderr += `\n(${why})`
        this.kill()
    }

    private frame (frame: Buffer): void {
        const type = frame[4]
        const id = frame.readUInt32BE(5)
        const payload = frame.subarray(HEADER)
        switch (type) {
            case TYPE_MESSAGE:
                return this.message(payload)
            case TYPE_DATA:
                if (payload.length > MAX_DATA) {
                    return this.fail(`the helper sent a data frame of ${payload.length} bytes`)
                }
                return this.bridges.get(id)?.data(payload)
            case TYPE_ACK:
                if (payload.length !== 4) {
                    return this.fail(`the helper sent an acknowledgement of ${payload.length} bytes`)
                }
                return this.bridges.get(id)?.ack(payload.readUInt32BE(0))
            case TYPE_END:
                return this.bridges.get(id)?.end()
            case TYPE_CLOSE: {
                const bridge = this.bridges.get(id)
                if (bridge) {
                    bridge.destroy()
                } else if (this.opening.has(id)) {
                    this.abandoned.add(id)
                }
                return
            }
            default:
                return this.fail(`the helper sent a frame of type ${type}`)
        }
    }

    private message (payload: Buffer): void {
        const envelope = this.envelope(payload)
        if (!envelope) {
            return this.fail('the helper sent a message that isn\'t one')
        }
        const blobs: Buffer[] = []
        let at = 4 + payload.readUInt32BE(0)
        for (const size of envelope.blobs ?? []) {
            blobs.push(payload.subarray(at, at + size))
            at += size
        }
        switch (envelope.type) {
            case 'hello':
                this.hello?.(envelope)
                this.hello = null
                return
            case 'response': {
                const waiting = this.pending.get(envelope.id!)
                this.pending.delete(envelope.id!)
                if (envelope.error !== undefined) {
                    waiting?.reject(envelope.code ? new CodedError(envelope.error, envelope.code) : new Error(envelope.error))
                } else {
                    waiting?.resolve({ envelope, blobs })
                }
                return
            }
            case 'request':
                void this.answer(envelope, blobs)
                return
            case 'event':
                // One its handler can't take (a field missing, a count that isn't one) is the helper's fault: it stops,
                // as for a frame that isn't the protocol, rather than throwing through the stream it is read from.
                try {
                    this.onEvent(envelope.event!, envelope.body, blobs)
                } catch (e: any) {
                    this.fail(`the helper sent a ${envelope.event} event the plugin couldn't take: ${describe(e)}`)
                }
        }
    }

    /**
     * A message's envelope, where it is one: its JSON's length, the JSON (an object of a known type, with the fields
     * that type needs), and the sizes of its blobs, which fill the rest of the message exactly. Null otherwise.
     */
    private envelope (payload: Buffer): Envelope | null {
        if (payload.length < 4) {
            return null
        }
        const length = payload.readUInt32BE(0)
        if (length > payload.length - 4) {
            return null
        }
        let envelope: any
        try {
            envelope = JSON.parse(payload.subarray(4, 4 + length).toString('utf8'))
        } catch {
            return null
        }
        if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
            return null
        }
        const sizes = envelope.blobs ?? []
        if (!Array.isArray(sizes) || !sizes.every(n => Number.isSafeInteger(n) && n >= 0) || sizes.reduce((a: number, n: number) => a + n, 0) !== payload.length - 4 - length) {
            return null
        }
        const id = Number.isSafeInteger(envelope.id)
        switch (envelope.type) {
            case 'hello':
                return envelope
            case 'response':
                return id ? envelope : null
            case 'request':
                return id && typeof envelope.method === 'string' ? envelope : null
            case 'event':
                return typeof envelope.event === 'string' ? envelope : null
        }
        return null
    }

    /**
     * Answers a request of the helper's, which waits for the answer: with the handler's answer, or its error, or, where
     * the answer can't be sent (a body JSON can't hold), with that.
     */
    private async answer (request: Envelope, blobs: Buffer[]): Promise<void> {
        let response: Envelope
        let out: Buffer[] | undefined
        try {
            const answer = await this.onRequest(request.method!, request.body, blobs)
            response = { type: 'response', id: request.id, body: answer?.body ?? {} }
            out = answer?.blobs
        } catch (e: any) {
            response = { type: 'response', id: request.id, error: describe(e), ...e instanceof CodedError ? { code: e.code } : {} }
        }
        try {
            this.send(response, out)
        } catch (e) {
            this.send({ type: 'response', id: request.id, error: `the plugin couldn't answer ${request.method}: ${describe(e)}` })
        }
    }

    // ---- messages ----------------------------------------------------------------------------------------

    /** Sends a message, with `blobs` after its JSON. */
    send (envelope: Envelope, blobs: Buffer[] = []): void {
        const json = Buffer.from(JSON.stringify({ ...envelope, ...blobs.length ? { blobs: blobs.map(b => b.length) } : {} }))
        this.write(TYPE_MESSAGE, 0, count(json.length), json, ...blobs)
    }

    /** Asks the helper something; the answer's body and blobs, or its error. */
    request (method: string, body: unknown, blobs: Buffer[] = []): Promise<{ body: any, blobs: Buffer[] }> {
        if (this.dead) {
            return Promise.reject(new Error('the network helper has stopped'))
        }
        const id = ++this.nextId
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: ({ envelope, blobs }) => resolve({ body: envelope.body, blobs }), reject })
            this.send({ type: 'request', id, method, body }, blobs)
        })
    }

    // ---- streams -----------------------------------------------------------------------------------------

    /** The helper asked for a stream, numbered `id`: the plugin is opening it (see bridge, unused). */
    expect (id: number): void {
        this.opening.add(id)
    }

    /**
     * Carries `stream` for the helper as its stream `id` (the number the helper gave it when it asked for it). One the
     * helper has given up on meanwhile is destroyed instead; false then.
     */
    bridge (id: number, stream: Duplex): boolean {
        this.opening.delete(id)
        if (this.abandoned.delete(id) || this.dead) {
            stream.destroy()
            return false
        }
        this.bridges.set(id, new Bridge(this, id, stream))
        return true
    }

    /** The plugin opens no stream for `id` (another way to the server, or a failure). */
    unused (id: number): void {
        this.opening.delete(id)
        this.abandoned.delete(id)
    }

    forgetBridge (id: number): void {
        this.bridges.delete(id)
    }

    // ---- the end -----------------------------------------------------------------------------------------

    /**
     * Asks the helper to stop: its proxy closes and its connections end. Its input then ends, which ends it; one that
     * hasn't ended after SHUTDOWN_GRACE_MS is killed.
     */
    close (): void {
        if (this.closing || this.dead) {
            return
        }
        this.closing = true
        for (const bridge of [...this.bridges.values()]) {
            bridge.destroy()
        }
        const kill = setTimeout(() => this.kill(), SHUTDOWN_GRACE_MS)
        this.exited.then(() => clearTimeout(kill))
        this.request('shutdown', {}).catch(() => null).finally(() => this.child.stdin!.end())
    }

    /** Ends the helper at once. */
    kill (): void {
        if (!this.dead) {
            this.child.kill('SIGKILL')
        }
    }
}

/** An error's text, whatever was thrown. */
function describe (e: any): string {
    try {
        return String(e?.message ?? e)
    } catch {
        return 'an error that has no text'
    }
}

function missing (file: string): (e: any) => never {
    return e => {
        throw new Error(e?.code === 'ENOENT'
            ? `the plugin has no network helper for ${process.platform}-${process.arch} (${file} is missing): reinstall the plugin, or see TROUBLESHOOTING.md`
            : `the network helper couldn't be started: ${e?.message ?? e}`)
    }
}

/** How a helper ended, in words: its exit code or signal, and the last line of what it wrote to its error output. */
export function describeExit (exit: HelperExit): string {
    const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`
    const last = exit.stderr.split('\n').filter(Boolean).pop()
    return last ? `${how}: ${last.slice(0, 300)}` : how
}
