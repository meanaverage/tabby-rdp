/** Runs one FreeRDP WASM instance and its pthreads away from Tabby's renderer. */
import { parentPort, workerData } from 'worker_threads'
const utilityPort = (process as NodeJS.Process & { parentPort?: any }).parentPort
const port: { postMessage: (message: any, transfer?: ArrayBuffer[]) => void, on: (event: string, listener: (message: any) => void) => void } = parentPort ? {
    postMessage: (message, transfer) => parentPort!.postMessage(message, transfer ?? []),
    on: (event, listener) => parentPort!.on(event, listener),
} : {
    postMessage: message => utilityPort.postMessage(message),
    on: (event, listener) => utilityPort.on(event, (message: any) => listener(message.data)),
}
const SIZE = 1024 * 1024
let moduleInstance: any
let starting = false
let inputAddress = 0, outputAddress = 0
let input: { data: Uint8Array, offset: number } | undefined
let outputWaiting = false
let timer: ReturnType<typeof setInterval> | undefined

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
        const count = Math.min((write - read) >>> 0, SIZE - read % SIZE, 64 * 1024)
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
    if (message.type === 'init' && !starting) {
        starting = true
        start(message.config).catch(failed)
    } else if (message.type === 'input') {
        if (input) { throw new Error('FreeRDP WASM input queue overflow') }
        input = { data: message.data, offset: 0 }; pumpInput()
    } else if (message.type === 'output-ack') { outputWaiting = false; pumpOutput() }
})
async function start (config: { module: string, websocket: string }): Promise<void> {
    const createFreeRDP = require(config.module)
    moduleInstance = await createFreeRDP({
        noInitialRun: true,
        websocket: { url: config.websocket, subprotocol: 'binary' },
        // FreeRDP logs can contain authentication details. Only framed IPC leaves this worker.
        print: () => {}, printErr: () => {},
        onAbort: () => port.postMessage({ type: 'failure', message: 'FreeRDP WebAssembly aborted' }),
        onExit: (code: number) => { clearInterval(timer); pumpOutput(true); port.postMessage({ type: 'exit', code }) },
    })
    inputAddress = moduleInstance._tabby_input_buffer()
    outputAddress = moduleInstance._tabby_output_buffer()
    timer = setInterval(() => { pumpInput(); pumpOutput() }, 1)
    pumpInput()
    moduleInstance.callMain([])
}
function failed (): void { port.postMessage({ type: 'failure', message: 'Could not initialise FreeRDP WebAssembly' }) }
if (workerData) { starting = true; start(workerData).catch(failed) } else { port.postMessage({ type: 'ready' }) }
