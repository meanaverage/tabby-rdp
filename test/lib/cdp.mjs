// A minimal Chrome DevTools Protocol client for driving a Tabby window started with --remote-debugging-port.
// Node >= 22 (global WebSocket and fetch). No dependencies.

/** Connects to the Tabby page on `port` (default: $TRD_CDP_PORT). */
export async function connect (port = Number(process.env.TRD_CDP_PORT)) {
    if (!port) {
        throw new Error('No DevTools port: set TRD_CDP_PORT, or run the suites with `npm test`')
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'))
    if (!page) {
        throw new Error(`No Tabby page on DevTools port ${port}`)
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const pending = new Map()
    const listeners = new Map()
    ws.onmessage = event => {
        const message = JSON.parse(event.data)
        if (message.id && pending.has(message.id)) {
            const { resolve, reject } = pending.get(message.id)
            pending.delete(message.id)
            message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
        } else if (message.method) {
            listeners.get(message.method)?.forEach(f => f(message.params))
        }
    }
    /** Calls `f` with each event's params (e.g. 'Page.screencastFrame'); returns a function that stops it. */
    const on = (method, f) => {
        const set = listeners.get(method) ?? new Set()
        set.add(f)
        listeners.set(method, set)
        return () => set.delete(f)
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const n = ++id
        pending.set(n, { resolve, reject })
        ws.send(JSON.stringify({ id: n, method, params }))
    })
    /** Evaluates an expression in the page (awaiting promises) and returns its value. */
    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
        }
        return result.result.value
    }
    return { send, evaluate, on, close: () => ws.close() }
}

/** Waits until a DevTools port answers (Tabby starting up). */
export async function waitForPort (port, seconds = 60) {
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
