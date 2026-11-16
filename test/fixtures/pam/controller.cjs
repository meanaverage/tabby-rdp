// Disposable VM fixture. Only synthetic RDP credentials; restrict the firewall to the test client.
// TRD_PAM_BIND, TRD_PAM_CLIENT, TRD_PAM_SERVER, TRD_PAM_CERT, TRD_PAM_KEY; control port defaults to 8766.
const http = require('node:http')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { X509Certificate } = require('node:crypto')
const { isIP } = require('node:net')
const bind = process.env.TRD_PAM_BIND || '127.0.0.1'
const client = process.env.TRD_PAM_CLIENT || '127.0.0.1'
if (!isIP(bind) || !isIP(client)) throw new Error('Use explicit fixture/client IP addresses')
const cert = process.env.TRD_PAM_CERT, key = process.env.TRD_PAM_KEY
const fingerprint = new X509Certificate(fs.readFileSync(cert)).fingerprint256
let child, events = [], sequence = 0
const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.socket.remoteAddress !== client) { response.writeHead(403).end('{}'); return }
    const finish = (status, value) => response.writeHead(status).end(JSON.stringify(value))
    if (request.method === 'GET' && request.url === '/events') { finish(200, { sequence, events }); return }
    if (request.method === 'POST' && request.url === '/stop') {
        child?.kill(); child = null; finish(200, {}); return
    }
    if (request.method !== 'POST' || request.url !== '/case') { finish(404, {}); return }
    let body = ''
    for await (const chunk of request) { body += chunk; if (body.length > 256) { finish(413, {}); return } }
    let mode, announced
    try { ({ mode, announced } = JSON.parse(body)) } catch { finish(400, {}); return }
    if (typeof announced !== 'boolean') { finish(400, {}); return }
    if (!['opaque', 'transparent', 'partial', 'no-alpha', 'black'].includes(mode)) { finish(400, {}); return }
    child?.kill(); const caseEvents = events = []; const caseSequence = ++sequence
    const running = child = spawn(process.env.TRD_PAM_SERVER, [cert, key, mode, bind, announced ? 'announced' : 'unannounced'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let text = '', answered = false
    const timer = setTimeout(() => { if (!answered) { answered = true; finish(504, { error: 'Peer startup timed out' }); running.kill() } }, 8000)
    running.stdout.on('data', chunk => {
        text += chunk
        while (text.includes('\n')) {
            const n = text.indexOf('\n'), line = text.slice(0, n); text = text.slice(n + 1)
            let event; try { event = JSON.parse(line) } catch { continue }
            caseEvents.push(event)
            if (event.event === 'listening' && !answered) { answered = true; clearTimeout(timer); finish(200, { sequence: caseSequence, host: bind, port: event.port, fingerprint }) }
        }
    })
    running.on('error', () => { if (!answered) { answered = true; clearTimeout(timer); finish(500, { error: 'Peer failed to start' }) } })
    running.on('exit', code => { caseEvents.push({ event: 'exit', code }); if (child === running) child = null })
})
server.listen(Number(process.env.TRD_PAM_PORT || 8766), bind, () => console.log('PAM fixture controller ready'))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child?.kill(); server.close(); process.exit() })
