/** Runs one FreeRDP WASM instance and its pthreads away from Tabby's renderer. */
import { parentPort, workerData } from 'worker_threads'
import { boundedWebSocket } from './freerdpWasmSocket'
let utilityChannel: any
const utilityPort = (process as NodeJS.Process & { parentPort?: any }).parentPort
const port: { postMessage: (message: any, transfer?: ArrayBuffer[]) => void, on: (event: string, listener: (message: any) => void) => void } = parentPort ? {
    postMessage: (message, transfer) => parentPort!.postMessage(message, transfer ?? []),
    on: (event, listener) => parentPort!.on(event, listener),
} : {
    postMessage: message => utilityChannel?.postMessage(message),
    on: (event, listener) => utilityPort.on(event, (message: any) => {
        if (message.data?.type !== 'port' || utilityChannel) return
        utilityChannel = message.ports[0]
        utilityChannel.on('close', ownerGone)
        utilityChannel.on('message', (message: any) => listener(message.data))
        utilityChannel.start()
        utilityChannel.postMessage({ type: 'ready' })
    }),
}
const SIZE = 1024 * 1024
let moduleInstance: any
let starting = false
let inputAddress = 0, outputAddress = 0
let input: { data: Uint8Array, offset: number } | undefined
let outputWaiting = false
let timer: ReturnType<typeof setInterval> | undefined
let stopping = false

/** Wake blocked certificate/input/output waits when the renderer or pipe disappears. */
function closeRings (): void {
    if (!moduleInstance || !inputAddress || !outputAddress) { return }
    for (const address of [inputAddress, outputAddress]) {
        const counters = new Int32Array(moduleInstance.HEAPU8.buffer, address, 3)
        Atomics.store(counters, 2, 1)
        Atomics.notify(counters, 0); Atomics.notify(counters, 1)
    }
}
function ownerGone (): void {
    if (stopping) { return }
    stopping = true
    clearInterval(timer)
    input = undefined
    closeRings()
    // A thread blocked outside the rings must not keep an ownerless session alive.
    setTimeout(() => process.exit(0), 250)
}
parentPort?.on('close', ownerGone)
utilityPort?.on('close', ownerGone)

function pumpInput (): void {
    if (!input || !moduleInstance) { return }
    const heap: Uint8Array = moduleInstance.HEAPU8
    const counters = new Int32Array(heap.buffer, inputAddress, 3)
    let read = Atomics.load(counters, 0) >>> 0, write = Atomics.load(counters, 1) >>> 0
    while (input.offset < input.data.length) {
        const available = SIZE - ((write - read) >>> 0)
        if (!available) { return }
        const count = Math.min(available, SIZE - write % SIZE, input.data.length - input.offset)
        heap.set(input.data.subarray(input.offset, input.offset + count), inputAddress + 12 + write % SIZE)
        input.offset += count; write = (write + count) >>> 0
        Atomics.store(counters, 1, write); Atomics.notify(counters, 1)
        read = Atomics.load(counters, 0) >>> 0
    }
    input = undefined
    port.postMessage({ type: 'input-ack' })
}
function pumpOutput (ending = false): void {
    if (!moduleInstance || outputWaiting && !ending) { return }
    const heap: Uint8Array = moduleInstance.HEAPU8
    const counters = new Int32Array(heap.buffer, outputAddress, 3)
    let read = Atomics.load(counters, 0) >>> 0
    const write = Atomics.load(counters, 1) >>> 0
    while (read !== write) {
        const count = Math.min((write - read) >>> 0, SIZE - read % SIZE)
        const bytes = new Uint8Array(count)
        bytes.set(heap.subarray(outputAddress + 12 + read % SIZE, outputAddress + 12 + read % SIZE + count))
        read = (read + count) >>> 0
        Atomics.store(counters, 0, read); Atomics.notify(counters, 0)
        outputWaiting = true
        port.postMessage({ type: 'output', data: bytes }, [bytes.buffer])
        if (!ending) { break }
    }
}
port.on('message', message => {
    if (message.type === 'eof') { ownerGone(); return }
    if (stopping) { return }
    if (message.type === 'init' && !starting) {
        starting = true
        start(message.config).catch(failed)
    } else if (message.type === 'input') {
        if (input) { throw new Error('FreeRDP WASM input queue overflow') }
        input = { data: message.data, offset: 0 }; pumpInput()
    } else if (message.type === 'output-ack') { outputWaiting = false; pumpOutput() }
})
async function start (config: { module: string, websocket: string }): Promise<void> {
    // Emscripten's nonblocking socket shim calls ws.send in this isolated worker. Bound that
    // final queue as well as the IPC rings: a peer can request file ranges without reading them.
    const wsPath = require.resolve('ws')
    const Socket = require(wsPath)
    require.cache[wsPath]!.exports = boundedWebSocket(Socket, () => failed('FreeRDP stopped: the server is not reading uploaded data'))
    const createFreeRDP = require(config.module)
    moduleInstance = await createFreeRDP({
        noInitialRun: true,
        websocket: { url: config.websocket, subprotocol: 'binary' },
        // FreeRDP logs can contain authentication details. Only framed IPC leaves this worker.
        print: () => {}, printErr: () => {},
        onAbort: () => failed('FreeRDP WebAssembly aborted'),
        onExit: (code: number) => {
            clearInterval(timer)
            if (!stopping) { pumpOutput(true); port.postMessage({ type: 'exit', code }) }
            stopping = true
            setTimeout(() => process.exit(code), 0)
        },
    })
    inputAddress = moduleInstance._tabby_input_buffer()
    outputAddress = moduleInstance._tabby_output_buffer()
    if (stopping) { closeRings(); return }
    timer = setInterval(() => { pumpInput(); pumpOutput() }, 1)
    pumpInput()
    moduleInstance.callMain([])
}
function failed (reason?: unknown): void {
    if (stopping) { return }
    try { port.postMessage({ type: 'failure', message: typeof reason === 'string' ? reason : 'Could not initialise FreeRDP WebAssembly' }) } finally { ownerGone() }
}
if (workerData) { starting = true; start(workerData).catch(failed) }
