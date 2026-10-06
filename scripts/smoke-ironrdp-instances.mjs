// Exercise the shipped web component with separate real WASM backends in an isolated headless Chrome profile.
// No remote desktop connection is made. CHROME_BIN can name another Chromium executable.
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'

const html = `<!doctype html><html><body><pre id="result">PENDING</pre><script type="module">
try {
    const watched = [window, document].map(target => {
        // The component's seven owned listeners. Svelte's delegated DOM handlers are shared/refcounted separately.
        const owned = new Set(target === window ? ['resize', 'keydown', 'keyup', 'focus', 'focusin', 'blur'] : ['visibilitychange']);
        const listeners = new Map();
        const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
        target.addEventListener = (type, callback, options) => {
            if (owned.has(type)) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type).add(callback);
            }
            add(type, callback, options);
        };
        target.removeEventListener = (type, callback, options) => {
            listeners.get(type)?.delete(callback); remove(type, callback, options);
        };
        return () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    });
    const count = () => watched.reduce((sum, get) => sum + get(), 0);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    await import('/vendor/iron-remote-desktop.js');
    const { createBackend } = await import('/vendor/ironrdp-factory.js');
    const module = await WebAssembly.compile(await (await fetch('/vendor/ironrdp_web_bg.wasm')).arrayBuffer());
    const baseline = count();
    const mount = async () => {
        const backend = await createBackend(module, 'ERROR');
        const element = document.createElement('iron-remote-desktop');
        element.style.cssText = 'display:block;width:640px;height:480px';
        element.module = backend.Backend;
        const ready = new Promise(resolve => element.addEventListener('ready', e => resolve(e.detail.irgUserInteraction), { once: true }));
        document.body.append(element);
        return { backend, element, ui: await ready };
    };
    const first = await mount(), second = await mount();
    check(first.backend.runtime.memory !== second.backend.runtime.memory, 'shared memory');
    check(first.element.module.SessionBuilder !== second.element.module.SessionBuilder, 'shared backend classes');
    check(first.ui !== second.ui, 'shared component API');
    const withTwo = count() - baseline;
    check(withTwo > 0 && withTwo % 2 === 0, 'unexpected listener ownership');
    first.ui.shutdown(); first.element.remove();
    await new Promise(resolve => setTimeout(resolve, 50));
    check(count() - baseline === withTwo / 2, 'closing one component affected the other or leaked listeners: baseline=' + baseline + ', two=' + withTwo + ', after=' + (count() - baseline));
    window.dispatchEvent(new Event('resize'));
    check(second.element.isConnected && !!second.ui.configBuilder(), 'second component stopped working');
    const replacement = await mount();
    check(replacement.backend.runtime.memory !== first.backend.runtime.memory, 'replacement reused memory');
    check(count() - baseline === withTwo, 'replacement listener count differs');
    second.ui.shutdown(); second.element.remove(); replacement.ui.shutdown(); replacement.element.remove();
    await new Promise(resolve => setTimeout(resolve, 50));
    check(count() === baseline, 'global listeners remain after all components close');
    document.getElementById('result').textContent = JSON.stringify({ pass: true, listenersPerComponent: withTwo / 2,
        memoryBytesPerBackend: first.backend.runtime.memory.buffer.byteLength, componentReady: 3, remainingListeners: count() - baseline });
} catch (error) {
    document.getElementById('result').textContent = JSON.stringify({ pass: false, error: String(error), stack: error.stack });
}
</script></body></html>`
const files = new Set(['iron-remote-desktop.js', 'ironrdp-factory.js', 'ironrdp_web_bg.wasm'])
const server = createServer(async (request, response) => {
    try {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return }
        const name = request.url?.replace(/^\/vendor\//, '')
        if (!files.has(name)) { response.writeHead(404); response.end(); return }
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        response.end(await readFile(new URL('../vendor/' + name, import.meta.url)))
    } catch (error) { response.writeHead(500); response.end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const profile = await mkdtemp(join(tmpdir(), 'ironrdp-chrome-'))
let browser
let debuggerSocket
try {
    const binary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank'])
    const timer = setTimeout(() => browser.kill(), 30000)
    try {
        const url = await new Promise((resolve, reject) => {
            let stderr = ''
            browser.on('error', reject)
            browser.on('exit', () => reject(new Error('Chrome exited: ' + stderr)))
            browser.stderr.on('data', chunk => {
                stderr += chunk
                const found = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
                if (found) resolve(found[1])
            })
        })
        debuggerSocket = new WebSocket(url)
        await new Promise((resolve, reject) => { debuggerSocket.on('open', resolve); debuggerSocket.on('error', reject) })
        let sequence = 0
        const pending = new Map()
        let loaded
        let rejectLoad
        debuggerSocket.on('close', () => {
            const error = new Error('Chrome debugger closed')
            for (const entry of pending.values()) entry.reject(error)
            pending.clear()
            rejectLoad?.(error)
        })
        debuggerSocket.on('message', data => {
            const event = JSON.parse(String(data))
            if (event.id && pending.has(event.id)) {
                const { resolve, reject } = pending.get(event.id)
                pending.delete(event.id)
                if (event.error) reject(new Error(JSON.stringify(event.error)))
                else resolve(event.result)
            } else if (event.method === 'Page.loadEventFired') loaded?.()
        })
        const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
            const id = ++sequence
            pending.set(id, { resolve, reject })
            debuggerSocket.send(JSON.stringify({ id, method, params, sessionId }))
        })
        const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
        await call('Page.enable', {}, sessionId)
        const pageLoaded = new Promise((resolve, reject) => { loaded = resolve; rejectLoad = reject })
        await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' }, sessionId)
        await pageLoaded
        const result = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
            for (let tries = 0; tries < 200; tries++) {
                const text = document.getElementById('result')?.textContent;
                if (text && text !== 'PENDING') return JSON.parse(text);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('browser smoke did not finish');
        })()` }, sessionId)
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
        const report = result.result.value
        console.log(JSON.stringify(report, null, 2))
        if (!report.pass) process.exitCode = 1
        await call('Target.closeTarget', { targetId })
    } finally { clearTimeout(timer) }
} finally {
    debuggerSocket?.close()
    browser?.kill()
    await new Promise(resolve => server.close(resolve))
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
