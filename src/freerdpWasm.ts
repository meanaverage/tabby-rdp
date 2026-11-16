import { existsSync } from 'fs'
import { join } from 'path'
import { connect } from 'net'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import { Worker } from 'worker_threads'

export function freeRDPWasmPath (): string { return join(__dirname, '..', 'wasm/freerdp/tabby-freerdp.js') }
export function hasFreeRDPWasm (): boolean { return existsSync(freeRDPWasmPath()) && existsSync(freeRDPWasmPath().replace(/\.js$/, '.wasm')) }
export function requireFreeRDPWasm (): void {
    if (!hasFreeRDPWasm()) { throw new Error('The FreeRDP WebAssembly build is missing. Install a complete tabby-rdp package or choose another client.') }
}

/** Same bounded framed transport as the native client, backed by a WASM worker instead of a helper executable. */
export class FreeRDPWasmProcess extends EventEmitter {
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
    readonly stdin: Writable
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    private worker?: { postMessage: (message: any) => void, terminate: () => Promise<unknown> }
    private server: any
    private connections = new Set<any>()
    private inputDone?: (error?: Error | null) => void
    private ended = false

    private constructor () {
        super()
        this.stdin = new Writable({ write: (data, _encoding, done) => {
            if (!this.worker || this.ended) { done(new Error('FreeRDP WebAssembly stopped')); return }
            this.inputDone = done
            this.worker.postMessage({ type: 'input', data: new Uint8Array(data) })
        } })
    }

    static async create (relay: { port: number, token: string }, env: NodeJS.ProcessEnv): Promise<FreeRDPWasmProcess> {
        requireFreeRDPWasm()
        const child = new FreeRDPWasmProcess()
        const { WebSocketServer } = require('ws')
        // Only this worker knows the path; browser origins are never accepted. The TCP relay independently
        // authenticates the 64-byte token before opening SSH, RD Gateway, or a direct remote connection.
        child.server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false,
            verifyClient: (info: any) => !info.origin && info.req.url === `/${relay.token}` })
        child.server.on('connection', (websocket: any) => {
            const socket = connect({ host: '127.0.0.1', port: relay.port })
            child.connections.add(websocket); child.connections.add(socket)
            const close = () => { websocket.terminate(); socket.destroy(); child.connections.delete(websocket); child.connections.delete(socket) }
            websocket.on('error', close); websocket.on('close', close); socket.on('error', close); socket.on('close', close)
            websocket.on('message', (data: Buffer, binary: boolean) => {
                if (!binary) { close(); return }
                if (!socket.write(data)) { websocket.pause() }
            })
            socket.on('drain', () => websocket.resume())
            socket.on('data', data => { socket.pause(); websocket.send(data, (error: Error | undefined) => error ? close() : socket.resume()) })
        })
        await new Promise<void>((resolve, reject) => { child.server.once('listening', resolve); child.server.once('error', reject) })
        child.server.on('error', () => { child.emit('error', new Error('FreeRDP WebAssembly transport failed')); child.kill() })
        try {
            const config = { module: freeRDPWasmPath(), websocket: `ws://127.0.0.1:${child.server.address().port}/${relay.token}` }
            let events: any
            if ((process as NodeJS.Process & { type?: string }).type === 'renderer') {
                // Electron's renderer cannot host Node pthreads. A utility process can, and contains runtime failures.
                const utility = require('@electron/remote').getBuiltin('utilityProcess')
                    .fork(join(__dirname, 'freerdpWasmWorker.js'), [], { env, stdio: 'pipe', serviceName: 'tabby-rdp FreeRDP WebAssembly' })
                utility.stdout?.on('data', () => {})
                utility.stderr?.on('data', () => {})
                child.worker = { postMessage: message => utility.postMessage(message), terminate: async () => utility.kill() }
                events = utility

            } else {
                events = new Worker(join(__dirname, 'freerdpWasmWorker.js'), { env, workerData: config })
                child.worker = events
            }
            events.on('message', (message: any) => {
                if (message.type === 'ready') { child.worker?.postMessage({ type: 'init', config }) }
                else if (message.type === 'input-ack') { const done = child.inputDone; child.inputDone = undefined; done?.() }
                else if (message.type === 'output') {
                    const accepted = child.stdout.write(Buffer.from(message.data))
                    const ack = () => child.worker?.postMessage({ type: 'output-ack' })
                    if (accepted) { ack() } else { child.stdout.once('drain', ack) }
                } else if (message.type === 'failure') {
                    child.emit('error', new Error(message.message)); child.kill()
                } else if (message.type === 'exit') { child.exitCode = message.code; child.kill() }
            })
            events.on('error', () => { child.emit('error', new Error('FreeRDP WebAssembly worker failed')); child.kill() })
            events.on('exit', (code: number) => {
                child.exitCode ??= code
                child.kill()
                child.stdout.end(); child.stderr.end()
                child.emit('close', child.exitCode, child.signalCode)
            })
        } catch (error) { child.kill(); throw error }
        return child
    }

    kill (signal: NodeJS.Signals = 'SIGTERM'): boolean {
        if (this.ended) { return false }
        this.ended = true
        this.signalCode = this.exitCode === null ? signal : null
        this.server?.close()
        for (const connection of this.connections) { connection.terminate?.(); connection.destroy?.() }
        this.connections.clear()
        this.worker?.terminate().catch(() => undefined)
        const done = this.inputDone; this.inputDone = undefined
        done?.(new Error('FreeRDP WebAssembly stopped'))
        return true
    }
}
