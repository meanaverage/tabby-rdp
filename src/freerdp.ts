import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes, timingSafeEqual, X509Certificate } from 'crypto'
import { existsSync } from 'fs'
import { createServer, Socket } from 'net'
import { basename, dirname, join } from 'path'
import { Duplex } from 'stream'
import { rootCertificates } from 'tls'
import { ByteQueue } from './byteQueue'
import { certificateAuthorities, certificateDetails, CertificateDetails } from './authorities'

const MAX_FRAME = 1024 * 1024
const MAX_AUTHORITIES = 16 * 1024 * 1024

export function freeRDPAuthorities (authorities: readonly string[]): Buffer {
    const text = authorities.join('\n')
    if (Buffer.byteLength(text) > MAX_AUTHORITIES) { throw new Error('FreeRDP certificate authority store exceeds 16 MiB') }
    return Buffer.from(text)
}

export function helperEnvironment (): NodeJS.ProcessEnv {
    // The helper needs OS paths/locale, not the parent app's API keys or the test runner's passwords.
    // WLOG_*: FreeRDP's own logging, for a diagnosis (see tools/pdu-trace/README.md): the helper keeps its log off
    // unless these ask for a channel's log into a file (WLOG_APPENDER=FILE); its console stays the IPC's.
    const keys = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
        'LANG', 'LC_ALL', 'TZ', 'OPENSSL_CONF', 'WLOG_FILTER', 'WLOG_APPENDER', 'WLOG_FILEAPPENDER_OUTPUT_FILE_PATH',
        'WLOG_FILEAPPENDER_OUTPUT_FILE_NAME', 'WLOG_PREFIX']
    return { ...Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
        OPENSSL_MODULES: dirname(nativeHelperPath()) }
}

/** The npm package with the FreeRDP helper for a platform (scripts/package-metadata.mjs names it the same). */
export function freeRDPPackage (platform = `${process.platform}-${process.arch}`): string {
    return `@tabby-rdp/freerdp-${platform}`
}

/**
 * Where the helper is: `own`, a build of one's own in native/bin (npm run build:freerdp, in a checkout), or else in the
 * platform's package, which npm installs beside the published plugin as one of its optional dependencies (a checkout
 * has none). `resolve` finds a package's file as require.resolve does. `own` when neither has it.
 */
export function helperPath (platform: string, own: string, resolve: (id: string) => string): string {
    if (existsSync(own)) { return own }
    try {
        return join(dirname(resolve(`${freeRDPPackage(platform)}/package.json`)), basename(own))
    } catch {
        return own
    }
}

export function nativeHelperPath (): string {
    const platform = `${process.platform}-${process.arch}`
    return helperPath(platform, join(__dirname, '..', 'native', 'bin', platform, `tabby-freerdp${process.platform === 'win32' ? '.exe' : ''}`), require.resolve)
}

export function requireFreeRDP (): void {
    if (!hasFreeRDP()) {
        const platform = `${process.platform}-${process.arch}`
        const platforms: unknown = require('../package.json').tabbyRdp?.freerdpPlatforms
        throw new Error(Array.isArray(platforms) && platforms.includes(platform)
            ? `FreeRDP's helper for ${platform} is not installed. npm installs it with the plugin, as ${freeRDPPackage(platform)}: reinstall tabby-rdp, or choose IronRDP in this desktop's settings.`
            : `FreeRDP is not available for ${platform}. Choose IronRDP in this desktop's settings.`)
    }
}

export function hasFreeRDP (): boolean { return existsSync(nativeHelperPath()) }

export function helperStopped (code: number | null, signal: string | null, platform = process.platform): Error {
    if (platform === 'win32' && code !== null && (code >>> 0) === 0xc0000135) {
        return new Error('FreeRDP could not load a required Windows DLL. Install the Microsoft Visual C++ 2015–2022 Redistributable for this computer’s architecture, then restart Tabby. See the plugin’s compatibility guide.')
    }
    return new Error(`The FreeRDP helper stopped (${signal ?? code ?? 'unknown'})`)
}

export function ipcFrame (type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
    if (type.length !== 1 || payload.length > MAX_FRAME) { throw new Error('Invalid FreeRDP IPC message') }
    const header = Buffer.alloc(5)
    header[0] = type.charCodeAt(0)
    header.writeUInt32BE(payload.length, 1)
    return Buffer.concat([header, payload])
}

/** A frame is bounded before allocating its body, including when a pipe splits the header byte by byte. */
export class FreeRDPFrames {
    private readonly queue = new ByteQueue()

    push (chunk: Buffer, receive: (type: string, data: Buffer) => void): void {
        this.queue.push(chunk)
        while (this.queue.length >= 5) {
            const header = this.queue.peek(5)
            const length = header.readUInt32BE(1)
            if (length > MAX_FRAME) { throw new Error('FreeRDP sent an oversized IPC message') }
            if (this.queue.length < length + 5) { return }
            const type = String.fromCharCode(header[0])
            this.queue.take(5)
            receive(type, this.queue.take(length))
        }
    }
}

export function numbers (...values: number[]): Buffer {
    const out = Buffer.alloc(values.length * 4)
    values.forEach((v, i) => out.writeUInt32BE(v >>> 0, i * 4))
    return out
}

/** Only a process holding the per-attempt token can open the SSH channel or gateway connection. */
export async function freeRDPRelay (open: (signal: AbortSignal) => Promise<Duplex>): Promise<{
    port: number, token: string, stats: { bytesIn: number, bytesOut: number }, readonly failure?: Error, close: () => void,
}> {
    const token = randomBytes(32).toString('hex')
    const expected = Buffer.from(token)
    const pending = new AbortController()
    const sockets = new Set<Duplex>()
    const stats = { bytesIn: 0, bytesOut: 0 }
    let failure: Error | undefined
    let active: Socket | undefined
    const server = createServer(socket => {
        sockets.add(socket)
        socket.once('error', () => socket.destroy())
        socket.once('close', () => sockets.delete(socket))
        const timer = setTimeout(() => socket.destroy(), 3000)
        socket.once('close', () => clearTimeout(timer))
        let received = Buffer.alloc(0)
        const authenticate = (chunk: Buffer) => {
            const need = 64 - received.length
            received = Buffer.concat([received, chunk.subarray(0, need)])
            if (received.length !== 64) { return }
            socket.pause()
            socket.removeListener('data', authenticate)
            clearTimeout(timer)
            if (!timingSafeEqual(received, expected) || active && !active.destroyed || pending.signal.aborted) {
                socket.destroy()
                return
            }
            active = socket
            const rest = chunk.subarray(need)
            open(pending.signal).then(remote => {
                if (socket.destroyed || pending.signal.aborted) { remote.destroy(); return }
                failure = undefined
                sockets.add(remote)
                remote.on('error', error => {
                    if (!pending.signal.aborted) { failure = error }
                    socket.destroy()
                })
                remote.once('close', () => { sockets.delete(remote); socket.destroy() })
                socket.once('close', () => remote.destroy())
                remote.on('data', data => { stats.bytesIn += data.length })
                socket.on('data', data => { stats.bytesOut += data.length })
                if (rest.length) { socket.unshift(rest) }
                remote.pipe(socket).pipe(remote)
                socket.resume()
            }, error => { failure = error instanceof Error ? error : new Error('Could not open the RDP transport'); socket.destroy() })
        }
        socket.on('data', authenticate)
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    // A late accept/listen error ends only this connection attempt.
    server.on('error', () => { pending.abort(); for (const socket of sockets) { socket.destroy() } })
    return {
        port: (server.address() as { port: number }).port, token, stats,
        get failure () { return failure },
        close: () => { pending.abort(); server.close(); for (const socket of sockets) { socket.destroy() } },
    }
}

export interface NativeFrame { x: number, y: number, width: number, height: number, screenWidth: number, screenHeight: number, rgba: Uint8ClampedArray<ArrayBuffer> }
export function decodeNativeFrame (data: Buffer): NativeFrame {
    if (data.length < 24) { throw new Error('FreeRDP sent an incomplete display update') }
    const [x, y, width, height, screenWidth, screenHeight] = Array.from({ length: 6 }, (_, i) => data.readUInt32BE(i * 4))
    if (!width || !height || width > 256 || height > 256 || screenWidth < 200 || screenWidth > 7680 || screenHeight < 200 || screenHeight > 4320 ||
        x + width > screenWidth || y + height > screenHeight || data.length !== 24 + width * height * 4) {
        throw new Error('FreeRDP sent an invalid display update')
    }
    return { x, y, width, height, screenWidth, screenHeight, rgba: new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset + 24, width * height * 4) }
}

interface FreeRDPOptions {
    /** Explicit trust anchors, otherwise the same system/Node authorities used by the plugin's other TLS paths. */
    authorities?: readonly string[]
    host: string
    username: string
    password: string
    domain: string
    width: number
    height: number
    pipeline: boolean
    autologon?: boolean
    open: (signal: AbortSignal) => Promise<Duplex>
    certificate: (fingerprint: string, valid: boolean, reason: string, details?: CertificateDetails) => void
    withoutNla: () => void
    frame: (frame: NativeFrame) => void
}

export class FreeRDPError extends Error {
    constructor (readonly code: number) { super(`FreeRDP connection failed (0x${code.toString(16).padStart(8, '0')})`) }
    // Only explicit logon failure / wrong password should discard a remembered password. The generic
    // authentication error also covers CredSSP, unsupported mechanisms and transport failures.
    kind (): number | undefined { return [0x20014, 0x20015].includes(this.code) ? 2 : undefined }
}

const SESSION_END_REASONS: Record<number, string> = {
    0x10001: 'The server disconnected the session.',
    0x10002: 'The server signed out the session.',
    0x10003: 'The session reached its idle time limit.',
    0x10004: 'The session reached its sign-in time limit.',
    0x10005: 'Another connection took over the session.',
    0x1000b: 'The remote user disconnected the session.',
    0x1000c: 'The remote user signed out.',
}

/** One native process, relay and set of promises per attempt. A native crash cannot take another desktop down. */
export class FreeRDPProcess {
    frameCount = 0
    private child: ChildProcessWithoutNullStreams | null = null
    private relay: Awaited<ReturnType<typeof freeRDPRelay>> | null = null
    private closed = false
    private connected = false
    private ready!: (size: { width: number, height: number }) => void
    private failed!: (error: Error) => void
    private finish!: (end: { error?: Error, reason?: string }) => void
    private readonly started = new Promise<{ width: number, height: number }>((resolve, reject) => { this.ready = resolve; this.failed = reject })
    private readonly ended = new Promise<{ error?: Error, reason?: string }>(resolve => { this.finish = resolve })

    get stats (): { bytesIn: number, bytesOut: number } | null { return this.relay?.stats ?? null }

    async connect (options: FreeRDPOptions): Promise<{ width: number, height: number }> {
        // Attach the rejection handler before any async setup or child event can fail.
        const started = this.started
        started.catch(() => undefined)
        try {
            requireFreeRDP()
            const authorities = freeRDPAuthorities(options.authorities ?? certificateAuthorities() ?? rootCertificates)
            this.relay = await freeRDPRelay(options.open)
            if (this.closed) { this.relay.close(); throw new Error('FreeRDP connection cancelled') }
            const child = this.child = spawn(nativeHelperPath(), [], { stdio: 'pipe', windowsHide: true, env: helperEnvironment() })
            const frames = new FreeRDPFrames()
            const timer = setTimeout(() => this.fail(new Error('FreeRDP connection timed out')), 45000)
            started.then(() => clearTimeout(timer), () => clearTimeout(timer))
            child.once('error', () => this.fail(new Error('Could not start the FreeRDP helper. Rebuild it for this computer.')))
            child.stdin.on('error', () => this.fail(new Error('The FreeRDP helper stopped reading input' + (process.platform === 'win32' ? '. Check that the Microsoft Visual C++ 2015–2022 Redistributable is installed; see the compatibility guide.' : ''))))
            // Do not surface FreeRDP logs: native libraries can log authentication details.
            child.stderr.resume()
            child.stdout.on('data', data => {
                try { frames.push(data, (type, payload) => this.receive(type, payload, options)) } catch (error) { this.fail(error as Error) }
            })
            child.once('close', (code, signal) => {
                if (!this.closed) { this.fail(helperStopped(code, signal)) }
            })
            // Trust stores can exceed one IPC frame. Flush bounded chunks before the start frame; the helper
            // accumulates these under its own total limit before it opens any network connection.
            for (let at = 0; at < authorities.length; at += 64 * 1024) {
                if (this.closed) { throw new Error('FreeRDP connection cancelled') }
                await new Promise<void>((resolve, reject) => child.stdin.write(ipcFrame('A', authorities.subarray(at, at + 64 * 1024)), error => error ? reject(error) : resolve()))
            }
            const strings = [options.host, options.username, options.password, options.domain, '', this.relay.token]
            const fields = strings.map(value => {
                if (value.includes('\0')) { throw new Error('FreeRDP settings cannot contain a null character') }
                const text = Buffer.from(value)
                return Buffer.concat([numbers(text.length), text])
            })
            this.send('S', Buffer.concat([...fields, numbers(this.relay.port, options.width, options.height, +options.pipeline, +!!options.autologon)]))
        } catch (error) { this.fail(error as Error) }
        return started
    }

    private receive (type: string, data: Buffer, options: FreeRDPOptions): void {
        if (this.closed) { return }
        if (type === 'C') {
            let accepted = false
            try {
                if (data.length < 8 || data.readUInt32BE(4) > data.length - 8) { throw new Error('Invalid FreeRDP certificate message') }
                const reasonLength = data.readUInt32BE(4)
                const reason = data.subarray(8, 8 + reasonLength).toString()
                const cert = new X509Certificate(data.subarray(8 + reasonLength))
                const valid = data.readUInt32BE(0) === 1
                const details = certificateDetails(cert.toLegacyObject(), { name: options.host, reason, authorities: options.authorities ? [...options.authorities] : undefined })
                options.certificate(cert.fingerprint256, valid, reason, details)
                accepted = true
            } catch { /* The service records the problem and presents its existing certificate prompt after this attempt. */ }
            this.send('C', Buffer.from([+accepted]))
        } else if (type === 'N' && data.length === 0) {
            let accepted = false
            try { options.withoutNla(); accepted = true } catch { }
            this.send('N', Buffer.from([+accepted]))
        } else if (type === 'F') {
            options.frame(decodeNativeFrame(data))
        } else if (type === 'B' && data.length === 0) {
            this.frameCount++
        } else if (type === 'D' && data.length === 8 && !this.connected) {
            const width = data.readUInt32BE(0), height = data.readUInt32BE(4)
            if (width < 200 || width > 7680 || height < 200 || height > 4320) { throw new Error('Invalid FreeRDP desktop size') }
            this.connected = true
            this.ready({ width, height })
        } else if ((type === 'E' || type === 'X') && data.length === 8) {
            const code = data.readUInt32BE(0), reason = data.readUInt32BE(4)
            if (type === 'E' || code && !SESSION_END_REASONS[code]) { this.fail(this.relay?.failure ?? new FreeRDPError(code)); return }
            this.finish({ reason: SESSION_END_REASONS[code] ?? `FreeRDP ended the connection (0x${reason.toString(16)})` })
            this.shutdown()
        } else { throw new Error('FreeRDP sent an unexpected IPC message') }
    }

    send (type: string, payload: Buffer): void {
        if (this.closed || !this.child) { return }
        // During freerdp_connect the helper reads certificate/NLA decisions directly from stdin. User input
        // must not get ahead of those replies and be mistaken for a refusal.
        if (!this.connected && ['K', 'M', 'R'].includes(type)) { return }
        // A child that has stalled must not accumulate an unbounded queue of mouse/keyboard events.
        if (this.child.stdin.writableLength > MAX_FRAME) { this.fail(new Error('FreeRDP input stopped responding')); return }
        this.child.stdin.write(ipcFrame(type, payload))
    }

    async run (): Promise<{ reason: () => string | undefined }> {
        const end = await this.ended
        if (end.error) { throw end.error }
        return { reason: () => end.reason }
    }

    private fail (error: Error): void {
        if (this.closed) { return }
        this.failed(error)
        this.finish({ error })
        this.shutdown()
    }

    shutdown (): void {
        if (this.closed) { return }
        this.closed = true
        this.failed(new Error('FreeRDP connection cancelled'))
        this.finish({})
        this.relay?.close()
        this.child?.stdin.destroy()
        // Terminate the process even while freerdp_connect or a certificate callback is blocked.
        this.child?.kill()
        const child = this.child
        if (child) {
            const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL') } }, 1000)
            timer.unref()
            child.once('close', () => clearTimeout(timer))
        }
    }
}
