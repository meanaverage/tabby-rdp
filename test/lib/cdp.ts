// A minimal Chrome DevTools Protocol client for driving a Tabby window started with --remote-debugging-port.
// Node >= 22 (global WebSocket and fetch). No dependencies.
//
// The raw protocol is `any` where modelling CDP's own shapes would be a lot of type for no check; what a caller
// sees is `CdpMethods` (`send`) and `evaluate<T>`, which is where a mistake is worth catching.

/** A target as the DevTools HTTP endpoint (`/json/list`) reports it. */
interface CdpTarget {
    type: string
    url: string
    webSocketDebuggerUrl: string
}

/** A mouse event as the suites dispatch it (`Input.dispatchMouseEvent`). */
export interface MouseEventParams {
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
    x: number
    y: number
    button: 'none' | 'left'
    clickCount?: number
}

/** A key event as the suites dispatch it (`Input.dispatchKeyEvent`). */
export interface KeyEventParams {
    type: 'keyDown' | 'keyUp'
    key: string
    code: string
    windowsVirtualKeyCode: number
    /** CDP's modifier bitmask (Alt 1, Control 2, Meta 4, Shift 8). */
    modifiers: number
    text?: string
}

/**
 * The CDP methods this client and the suites call, with their parameters and results: `send` is typed against this,
 * so a misspelled method or a wrong parameter is a compile error. Add an entry here to call another one.
 */
export interface CdpMethods {
    'Runtime.enable': { params: Record<string, never>, result: unknown }
    'Inspector.enable': { params: Record<string, never>, result: unknown }
    'Runtime.evaluate': {
        params: { expression: string, awaitPromise: boolean, returnByValue: boolean }
        result: { result: { value: any }, exceptionDetails?: { exception?: { description?: string } } }
    }
    'Emulation.setFocusEmulationEnabled': { params: { enabled: boolean }, result: unknown }
    'Emulation.setDeviceMetricsOverride': { params: { width: number, height: number, deviceScaleFactor: number, mobile: boolean }, result: unknown }
    'Emulation.clearDeviceMetricsOverride': { params: Record<string, never>, result: unknown }
    'HeapProfiler.collectGarbage': { params: Record<string, never>, result: unknown }
    'Input.dispatchMouseEvent': { params: MouseEventParams, result: unknown }
    'Input.dispatchKeyEvent': { params: KeyEventParams, result: unknown }
    'Page.captureScreenshot': { params: { format: 'png' }, result: { data: string } }
    'Page.startScreencast': { params: { format: 'jpeg', quality: number, maxWidth: number, maxHeight: number, everyNthFrame: number }, result: unknown }
    'Page.stopScreencast': { params: Record<string, never>, result: unknown }
    'Page.screencastFrameAck': { params: { sessionId: number }, result: unknown }
}

/** A CDP event listener: called with each event's parameters. */
export type CdpListener = (params: any) => void

/** A connected DevTools session for one page. */
export interface CdpClient {
    /** Calls a CDP method and resolves with its result. */
    send: <M extends keyof CdpMethods>(method: M, params?: CdpMethods[M]['params']) => Promise<CdpMethods[M]['result']>
    /** Evaluates an expression in the page (awaiting promises) and returns its value. */
    evaluate: <T = unknown>(expression: string) => Promise<T>
    /** Calls `f` with each event's params (e.g. 'Page.screencastFrame'); returns a function that stops it. */
    on: (method: string, f: CdpListener) => () => void
    close: () => void
}

/** Connects to the Tabby page on `port` (default: $TRD_CDP_PORT). */
export async function connect (port = Number(process.env.TRD_CDP_PORT)): Promise<CdpClient> {
    if (!port) {
        throw new Error('No DevTools port: set TRD_CDP_PORT, or run the suites with `npm test`')
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CdpTarget[]
    const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'))
    if (!page) {
        throw new Error(`No Tabby page on DevTools port ${port}`)
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const pending = new Map<number, { resolve: (value: any) => void, reject: (reason: Error) => void }>()
    const listeners = new Map<string, Set<CdpListener>>()
    // Tabby's window gone (its renderer crashed, or the window closed): every call waiting for it fails, as every later
    // one does, rather than wait for an answer that never comes.
    let gone: Error | null = null
    const lose = (why: string) => {
        gone ??= new Error(why)
        for (const waiting of pending.values()) {
            waiting.reject(gone)
        }
        pending.clear()
    }
    ws.onclose = () => lose('the DevTools connection to Tabby\'s window closed (the window crashed or was closed)')
    ws.onmessage = event => {
        const message: { id?: number, method?: string, params?: any, error?: unknown, result?: any } = JSON.parse(event.data)
        if (message.id !== undefined) {
            const waiting = pending.get(message.id)
            if (!waiting) return
            pending.delete(message.id)
            message.error ? waiting.reject(new Error(JSON.stringify(message.error))) : waiting.resolve(message.result)
        } else if (message.method === 'Inspector.targetCrashed') {
            lose('Tabby\'s window crashed (its renderer process is gone)')
        } else if (message.method) {
            listeners.get(message.method)?.forEach(f => f(message.params))
        }
    }
    const on = (method: string, f: CdpListener) => {
        const set = listeners.get(method) ?? new Set<CdpListener>()
        set.add(f)
        listeners.set(method, set)
        return () => set.delete(f)
    }
    const send = <M extends keyof CdpMethods>(method: M, params?: CdpMethods[M]['params']): Promise<CdpMethods[M]['result']> =>
        new Promise((resolve, reject) => {
            if (gone) {
                return reject(gone)
            }
            const n = ++id
            pending.set(n, { resolve, reject })
            ws.send(JSON.stringify({ id: n, method, params: params ?? {} }))
        })
    const evaluate = async <T = unknown>(expression: string): Promise<T> => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
        }
        return result.result.value
    }
    // Reports a crash of the window (Inspector.targetCrashed), for the calls above.
    await send('Inspector.enable')
    return { send, evaluate, on, close: () => ws.close() }
}

/** Waits until a DevTools port answers (Tabby starting up). */
export async function waitForPort (port: number, seconds = 60): Promise<boolean> {
    for (let i = 0; i < seconds; i++) {
        try {
            await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
            return true
        } catch {
            await new Promise(r => setTimeout(r, 1000))
        }
    }
    return false
}
