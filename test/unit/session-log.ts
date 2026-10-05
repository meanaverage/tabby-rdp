// A desktop's connection log (src/sessionLog.ts, DesktopSession.log): Copy log hands it out, and much of it is of the
// remote's making (an RD Gateway's messages, a server's), which decides how many lines there are and when, for as long
// as the desktop stays open. It keeps its first lines and its latest, says how many it left out between them, and cuts
// a long line, in time that grows with the lines and memory that doesn't. Runs against the built plugin, the desktop's
// layer on a stand-in page: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'
import { FakeElement, installDocument } from './support/dom.js'

const require = createRequire(import.meta.url)
v8.setFlagsFromString('--expose-gc')
const gc: () => void = vm.runInNewContext('gc')

// Tabby and Angular, as far as loading the service needs them.
const decorator = () => () => undefined
const classes = new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : class { } })
const stubs: Record<string, unknown> = {
    '@angular/core': new Proxy({}, { get: (_, key) => key === '__esModule' ? undefined : decorator }),
    'tabby-core': classes,
    'tabby-settings': classes,
    'tabby-terminal': classes,
}
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request in stubs ? stubs[request] : load.call(this, request, ...rest)
}
const { SessionLog } = require('../../dist/sessionLog.js')
const { DesktopSession } = require('../../dist/desktop.service.js')
const { specOf } = require('../../dist/desktops.js')

test('a log keeps its first lines and its latest, however many come, and says how many it left out between them', () => {
    const log = new SessionLog()
    const count = 1_000_000
    const started = performance.now()
    for (let i = 0; i < count; i++) {
        log.push(`line ${i}`)
    }
    assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)} ms`)
    assert.ok(log.length <= SessionLog.FIRST + 1 + 2 * SessionLog.LATEST, `${log.length} lines`)
    assert.deepEqual(log.slice(0, SessionLog.FIRST), Array.from({ length: SessionLog.FIRST }, (_, i) => `line ${i}`))
    const latest = log.slice(SessionLog.FIRST + 1)
    assert.ok(latest.length >= SessionLog.LATEST)
    assert.deepEqual(latest, latest.map((_: string, i: number) => `line ${count - latest.length + i}`))
    const left = /^\((\d+) lines left out here\)$/.exec(log[SessionLog.FIRST])
    assert.ok(left, log[SessionLog.FIRST])
    assert.equal(SessionLog.FIRST + Number(left[1]) + latest.length, count)
    // What is made from it is a plain array (the settings page's copy, a filter).
    assert.equal(Object.getPrototypeOf(log.filter(Boolean)), Array.prototype)
    assert.equal(Object.getPrototypeOf([...log]), Array.prototype)
    // A line as long as it likes is cut.
    log.push('x'.repeat(1_000_000))
    assert.equal(log.at(-1).length, SessionLog.MAX_LINE + 1)
})

test('a desktop\'s log is one: whatever is logged there, its questions and messages included, keeps to that', t => {
    const page = installDocument()
    t.after(page.restore)
    const session = new DesktopSession(new FakeElement(), 'rdp#10.0.0.5:3389', specOf({ host: '10.0.0.5' }))
    // An RD Gateway's administrator's message, or a server's, over and over, as the gateway and the proxy log them.
    const logged = (m: string) => session.log.push(m)
    for (let i = 0; i < 300_000; i++) {
        logged(`gateway: its administrator's message: ${i}`)
    }
    session.status('Remote desktop session ended: logged off')
    assert.ok(session.log.length <= SessionLog.FIRST + 1 + 2 * SessionLog.LATEST, `${session.log.length} lines`)
    assert.match(session.log.at(-1), /Remote desktop session ended: logged off$/)
    session.dispose()
})

test('a line keeps nothing of the text it was cut out of: a host\'s answer of megabytes goes once the line is made', async () => {
    const memory = () => process.memoryUsage().heapUsed + process.memoryUsage().external
    const settle = async () => {
        for (let i = 0; i < 4; i++) {
            gc()
            await new Promise(resolve => setImmediate(resolve))
        }
    }
    const lines = 64
    // The ways the service makes lines of a host's answer (desk's, scale's and wake's errors, the setup's notes),
    // each from a fresh answer of 4 MB, as the SSH channel decodes one.
    const shapes: [string, (answer: string) => string][] = [
        ['a short capture', answer => `desk: ${/^RD_ERR (.{0,1000})/m.exec(answer)![1]}`],
        ['a capture longer than a line', answer => `setup: ${/^RD_NOTE (.+)$/m.exec(answer)![1]}`],
        ['the answer itself', answer => answer],
    ]
    for (const [shape, line] of shapes) {
        let log = new SessionLog()
        await settle()
        const before = memory()
        for (let i = 0; i < lines; i++) {
            const answer = Buffer.alloc(4 << 20, 0x41).fill(`RD_ERR no terminal (attempt ${i})\nRD_NOTE `, 0, 40).toString('utf8')
            log.push(line(answer))
        }
        // The last match a pattern made keeps its input: another one's takes its place.
        assert.ok(/x/.test('x'))
        await settle()
        const grown = memory() - before
        assert.ok(grown < lines * SessionLog.MAX_LINE * 2 + 32 * 1024 * 1024, `${shape}: ${Math.round(grown / 1024 / 1024)} MB kept for ${lines} lines`)
        assert.equal(log.length, lines)
        log = new SessionLog()
    }
})

