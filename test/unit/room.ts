// The room in a desktop's connection (ServerFlow in src/rdcleanpath.ts), end to end: the desktop's real proxy in front
// of a stand-in RDP server that reads what it is sent slowly, or not at all, or at once; a WebSocket client standing in
// for the connection the proxy relays; and what answers the remote's requests, FileTransfer over IronRDP's own provider
// (src/fileTransfer.ts) and SharedDrives (src/drives.ts), each answer sent through that client. What they hand the
// connection stays within FLOW_WINDOW, and one answer more, of what the proxy has read from it, however much the remote
// asks for; and a paste or a shared folder's copy still goes through. Runs against the built plugin: npm run build &&
// npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { selfSigned } from './support/certificates.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))

// What FileTransfer finds of the page and of Electron: an element for its messages, the browser's FileReader (as the
// provider reads what it hands out with it), a clipboard with nothing on it.
const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request === 'electron' ? { clipboard: { read: () => '', readBuffer: () => Buffer.alloc(0) } } : load.call(this, request, ...rest)
}
class FakeElement {
    className = ''
    textContent = ''
    title = ''
    readonly children: FakeElement[] = []
    append (...nodes: FakeElement[]) { this.children.push(...nodes) }
    addEventListener () { }
    remove () { }
}
;(globalThis as any).document = { createElement: () => new FakeElement() }
;(globalThis as any).FileReader = class {
    result: ArrayBuffer | null = null
    error: unknown = null
    onload?: () => void
    onerror?: () => void
    readAsArrayBuffer (blob: Blob) {
        blob.arrayBuffer().then(b => { this.result = b; this.onload?.() }, e => { this.error = e; this.onerror?.() })
    }
    abort () { }
}

// Timers of a minute or more are the provider's watchdogs: they don't keep this file's process up once its tests are
// done.
const setTimer = globalThis.setTimeout
;(globalThis as any).setTimeout = (fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const timer = setTimer(fn, ms, ...args)
    if ((ms ?? 0) >= 30000) {
        timer.unref()
    }
    return timer
}

const { FileTransfer, entriesFor, MAX_RANGE } = require('../../dist/fileTransfer.js')
const { SharedDrives } = require('../../dist/drives.js')
const { startRDCleanPathProxy } = require('../../dist/rdcleanpath.js')
const WebSocket = require('ws')
let rdp: any

before(async () => {
    rdp = await import(pathToFileURL(root + 'vendor/iron-remote-desktop-rdp.js').href)
    await rdp.init('ERROR', fs.readFileSync(root + 'vendor/ironrdp_web_bg.wasm'))
})

const MB = 1024 * 1024
/** The room (FLOW_WINDOW), and the most one answer is: a part of a file (MAX_RANGE); a drive's read is 4 MB. */
const WINDOW = 64 * MB
const soon = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A file of `size` bytes with something different in each part of it, in a folder of the tests' own. */
const made: string[] = []
after(() => made.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))
function onDisk (size: number): { dir: string, file: string, bytes: Buffer } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trd-room-')))
    made.push(dir)
    const bytes = Buffer.alloc(size)
    for (let i = 0; i < size; i += 4096) {
        bytes.writeUInt32LE(i, i)
    }
    const file = path.join(dir, 'big.bin')
    fs.writeFileSync(file, bytes)
    return { dir, file, bytes }
}

const der = (tag: number, content: Buffer) => {
    const n = content.length
    const length = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
    return Buffer.concat([Buffer.from([tag, ...length]), content])
}
/** An RDCleanPath request: version 3390, a destination, the token, an X.224 request. */
const request = (token: string) => der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x0d, 0x3e]))),
    der(0xa2, der(0x0c, Buffer.from('server:3389'))),
    der(0xa3, der(0x0c, Buffer.from(token))),
    der(0xa6, der(0x04, Buffer.from([3, 0, 0, 11, 6, 0xe0, 0, 0, 0, 0, 0]))),
]))
/** The server's answer to the connection request: CredSSP chosen. */
const CONFIRM = Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 2, 0, 8, 0, 2, 0, 0, 0])
const certificate = selfSigned('server.test')

/**
 * The desktop's proxy, relaying to a stand-in server that, past TLS, reads `step` bytes every `period` ms (0: nothing
 * at all, Infinity: all it is sent, at once), and a client connected through it: what the server has read.
 */
async function connection (t: any, step: number, period = 100) {
    const secureContext = tls.createSecureContext({ key: certificate!.key, cert: certificate!.cert })
    const read = { bytes: 0 }
    const server = net.createServer(socket => {
        socket.on('error', () => { })
        socket.once('data', () => {
            socket.write(CONFIRM)
            const secure = new tls.TLSSocket(socket, { isServer: true, secureContext })
            secure.on('error', () => { })
            if (!step) {
                return
            }
            let allowed = step
            secure.on('data', (d: Buffer) => {
                read.bytes += d.length
                if (read.bytes >= allowed) {
                    secure.pause()
                    setTimeout(() => { allowed = read.bytes + step; secure.resume() }, period)
                }
            })
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const log: string[] = []
    const proxy = await startRDCleanPathProxy(() => new Promise(resolve => {
        const socket: net.Socket = net.connect(port, '127.0.0.1', () => resolve(socket))
    }), () => { }, (m: string) => log.push(m), { withoutNla: () => { } })
    const ws = new WebSocket(proxy.url)
    ws.on('error', () => { })
    t.after(() => { ws.terminate(); proxy.close(); server.close() })
    await new Promise(resolve => ws.once('open', resolve))
    const response = new Promise(resolve => ws.once('message', resolve))
    ws.send(request(proxy.token))
    await response
    for (let i = 0; i < 80 && !log.some(l => /relay up/.test(l)); i++) {
        await soon(25)
    }
    assert.ok(log.some(l => /relay up/.test(l)), log.join('\n'))
    const link = {
        proxy, ws, handed: 0,
        get serverRead () { return read.bytes },
        /** The most handed to the connection and not read from it by the proxy, and what the client held unsent. */
        most: 0, buffered: 0,
        /** An answer, sent through the connection as the client would, a megabyte at a time. */
        hand (data: Uint8Array) {
            for (let at = 0; at < data.length; at += MB) {
                ws.send(Buffer.from(data.buffer, data.byteOffset + at, Math.min(MB, data.length - at)))
            }
            link.handed += data.length
            link.sample()
        },
        sample () {
            link.most = Math.max(link.most, link.handed - proxy.stats.bytesOut)
            link.buffered = Math.max(link.buffered, ws.bufferedAmount)
        },
    }
    return link
}

/** FileTransfer for the desktop behind `link`'s proxy, each answer of its provider's sent through the connection. */
function transfer (link: Awaited<ReturnType<typeof connection>>) {
    const shown: string[] = []
    const layer = {
        addEventListener () { }, removeEventListener () { }, contains: () => false, classList: { add () { }, remove () { }, toggle () { } },
        appendChild: (el: FakeElement) => { shown.push(el.children[0]?.textContent ?? '') },
    }
    const files = new FileTransfer(rdp, layer, () => null, () => ({ toRemote: true, fromRemote: true }), link.proxy)
    files.provider.setSession({ invokeExtension () { } })
    // Each answer as it reaches the connection, under the remote's number for its request.
    const answers: { streamId: number, isError: boolean, data: Uint8Array | null }[] = []
    const submit = files.submit.bind(files)
    files.submit = (streamId: number, isError: boolean, data: Uint8Array) => {
        answers.push({ streamId, isError, data: isError ? null : data })
        if (!isError) {
            link.hand(data)
        }
        submit(streamId, isError, data)
    }
    let streams = 0
    return {
        files, shown, answers,
        ask: (position: number, size: number) => {
            const streamId = ++streams
            files.provider.handleFileContentsRequest({ streamId, index: 0, flags: rdp.FileContentsFlags.RANGE, position, size })
            return streamId
        },
    }
}

/**
 * The remote keeps asking for parts of 16 MB of the file offered, four every 50 ms, each on a stream of its own, for
 * `ms`: what was handed to the connection and not read from it never passes the room and a part more.
 */
async function keepAsking (link: Awaited<ReturnType<typeof connection>>, c: ReturnType<typeof transfer>, ms: number): Promise<void> {
    for (const end = Date.now() + ms; Date.now() < end && link.most <= WINDOW + MAX_RANGE;) {
        for (let i = 0; i < 4; i++) {
            c.ask(i * MAX_RANGE, MAX_RANGE)
        }
        await soon(50)
        link.sample()
    }
}

/** What the tests check of every run: the bound, in what was handed and what the client held. */
function withinRoom (link: Awaited<ReturnType<typeof connection>>, what: string, answer = MAX_RANGE): void {
    assert.ok(link.most <= WINDOW + answer, `${what}: ${(link.most / MB).toFixed(0)} MB handed to the connection and not read from it`)
    // Node's WebSocket counts what it is still writing whole, so it can say twice as much.
    assert.ok(link.buffered <= 2 * (WINDOW + answer), `${what}: the client held ${(link.buffered / MB).toFixed(0)} MB`)
}

for (const how of ['pasted', 'dropped']) {
    test(`a ${how} file asked for again and again, the server reading 10 MB every 100 ms: no more is handed than the room`, { skip: !certificate }, async t => {
        const { file, bytes } = onDisk(4 * MAX_RANGE)
        const link = await connection(t, 10 * MB)
        const c = transfer(link)
        t.after(() => c.files.dispose())
        c.files.send(how === 'pasted' ? entriesFor([file]).entries : [new File([new Uint8Array(bytes)], 'big.bin')], how === 'pasted')
        await keepAsking(link, c, 2000)
        withinRoom(link, how)
        // It moved on as the server read.
        assert.ok(link.serverRead > 50 * MB, `the server read ${link.serverRead / MB} MB`)
    })
}

test('a server that reads nothing at all gets the room and a part, and no more', { skip: !certificate }, async t => {
    const { file } = onDisk(4 * MAX_RANGE)
    const link = await connection(t, 0)
    const c = transfer(link)
    t.after(() => c.files.dispose())
    c.files.send(entriesFor([file]).entries, true)
    await keepAsking(link, c, 1500)
    withinRoom(link, 'never read')
})

test('the connection\'s other messages make room as the proxy reads them: what waits grows past the room by no more than they are', { skip: !certificate, timeout: 30000 }, async t => {
    const { file } = onDisk(4 * MAX_RANGE)
    const link = await connection(t, 2 * MB)
    const c = transfer(link)
    t.after(() => c.files.dispose())
    c.files.send(entriesFor([file]).entries, true)
    // Half a megabyte of other messages every 100 ms (more than the microphone's sound would be), besides the answers,
    // while the remote keeps asking and the server reads 2 MB every 100 ms.
    let other = 0
    const chunk = Buffer.alloc(64 * 1024)
    const timer = setInterval(() => {
        for (let sent = 0; sent < MB / 2; sent += chunk.length) {
            link.ws.send(chunk)
        }
        other += MB / 2
    }, 100)
    t.after(() => clearInterval(timer))
    for (const end = Date.now() + 3000; Date.now() < end;) {
        for (let i = 0; i < 4; i++) {
            c.ask(i * MAX_RANGE, MAX_RANGE)
        }
        await soon(50)
        // All that was handed to the connection and not read from it yet: the room and a part, and those messages.
        const waiting = link.handed + other - link.proxy.stats.bytesOut
        assert.ok(waiting <= WINDOW + MAX_RANGE + other, `${(waiting / MB).toFixed(0)} MB waits, of which ${(other / MB).toFixed(0)} MB was sent besides answers`)
    }
    clearInterval(timer)
    // The paste went on meanwhile, as the server read.
    assert.ok(link.handed > 20 * MB, `${(link.handed / MB).toFixed(0)} MB handed`)
})

test('a shared folder read again and again, the server reading 10 MB every 100 ms: no more is handed than the room', { skip: !certificate, timeout: 30000 }, async t => {
    const { dir } = onDisk(64 * MB)
    const link = await connection(t, 10 * MB)
    const drives = new SharedDrives([{ path: dir, name: 'S', readOnly: true }], () => null, link.proxy)
    const h = await drives.open(1, '\\big.bin', { write: false, create: false, exclusive: false, truncate: false })
    t.after(() => drives.dispose())
    // A read at a time, each answer sent through the connection as it comes.
    let reads = 0
    for (const end = Date.now() + 2000; Date.now() < end && link.most <= WINDOW + 4 * MB; reads++) {
        link.hand(await drives.read(h, (reads % 16) * 4 * MB, 4 * MB))
        await new Promise(resolve => setImmediate(resolve))
    }
    withinRoom(link, 'shared folder', 4 * MB)
    assert.ok(link.serverRead > 50 * MB, `the server read ${link.serverRead / MB} MB`)
})

test('with a server that reads at once, a paste and a shared folder\'s copy go through whole', { skip: !certificate, timeout: 60000 }, async t => {
    const { dir, file, bytes } = onDisk(96 * MB)
    const link = await connection(t, Infinity)
    const c = transfer(link)
    t.after(() => c.files.dispose())
    c.files.send(entriesFor([file]).entries, true)
    // As FUSE reads a pasted file: twelve requests of 1 MB at a time, the next asked as each is answered.
    const parts = new Map<number, number>()
    let next = 0
    const ask = () => { parts.set(c.ask(next * MB, MB), next * MB); next++ }
    for (let i = 0; i < 12; i++) {
        ask()
    }
    let seen = 0
    for (const end = Date.now() + 20000; c.answers.length < 96 && Date.now() < end;) {
        await soon(5)
        for (const answer of c.answers.slice(seen)) {
            assert.equal(answer.isError, false)
            assert.ok(Buffer.from(answer.data!).equals(bytes.subarray(parts.get(answer.streamId)!, parts.get(answer.streamId)! + MB)))
            if (next < 96) {
                ask()
            }
        }
        seen = c.answers.length
    }
    assert.equal(c.answers.length, 96)
    for (let i = 0; i < 100 && c.shown.at(-1) !== 'Copied 1 file to the remote desktop'; i++) {
        await soon(10)
    }
    assert.equal(c.shown.at(-1), 'Copied 1 file to the remote desktop')
    // The same file, from a shared folder, 4 MB at a time.
    const drives = new SharedDrives([{ path: dir, name: 'S', readOnly: true }], () => null, link.proxy)
    t.after(() => drives.dispose())
    const h = await drives.open(1, '\\big.bin', { write: false, create: false, exclusive: false, truncate: false })
    const copied: Uint8Array[] = []
    for (let at = 0; at < bytes.length; at += 4 * MB) {
        const data: Uint8Array = await drives.read(h, at, 4 * MB)
        link.hand(data)
        copied.push(data)
    }
    assert.equal(createHash('sha256').update(Buffer.concat(copied)).digest('hex'), createHash('sha256').update(bytes).digest('hex'))
    withinRoom(link, 'at once')
})
