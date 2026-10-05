// The proxy's server framing (src/rdcleanpath.ts, serverFraming): one server PDU per WebSocket message, whatever
// the TLS reads look like. Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
/** The built plugin's framing: given whether HYBRID_EX is in play, a splitter for what the server sends. */
const { serverFraming } = require('../../dist/rdcleanpath.js') as { serverFraming: (withEarlyUserAuthResult: boolean) => (chunk: Buffer) => Buffer[] }

const hex = (pdus: Uint8Array[]) => pdus.map(p => Buffer.from(p).toString('hex'))
const b = (bytes: number[]) => Buffer.from(bytes)

// CredSSP (short and long DER lengths), HYBRID_EX's Early User Authorization Result, then TPKT and fast-path
// (short and two-byte lengths).
const STREAM = [
    [0x30, 3, 2, 1, 6],
    [0x30, 0x81, 2, 0xaa, 0xbb],
    [0, 0, 0, 0],
    [3, 0, 0, 6, 0xaa, 0xbb],
    [0, 4, 0xcc, 0xdd],
    [0x80, 0x80, 5, 0xee, 0xff],
]

test('one PDU per message when the server coalesces them', () => {
    const frames = serverFraming(true)
    assert.deepEqual(hex(frames(b(STREAM.flat()))), hex(STREAM.map(b)))
})

test('PDUs split at every byte are joined', () => {
    const frames = serverFraming(true)
    const out = []
    for (const byte of STREAM.flat()) {
        out.push(...frames(b([byte])))
    }
    assert.deepEqual(hex(out), hex(STREAM.map(b)))
})

test('without HYBRID_EX there is no Early User Authorization Result', () => {
    const frames = serverFraming(false)
    const pdus = [[0x30, 3, 2, 1, 6], [3, 0, 0, 5, 1], [0, 3, 9]]
    assert.deepEqual(hex(frames(b(pdus.flat()))), hex(pdus.map(b)))
})

test('activation and the start of channel negotiation in one read stay two messages', () => {
    // As GNOME sends them: the last activation PDU (Font Map) and the drdynvc capabilities request.
    const fontMap = [3, 0, 0, 8, 1, 2, 3, 4]
    const drdynvc = [3, 0, 0, 7, 5, 6, 7]
    const frames = serverFraming(false)
    assert.deepEqual(hex(frames(b([...fontMap, ...drdynvc.slice(0, 2)]))), hex([b(fontMap)]))
    assert.deepEqual(hex(frames(b(drdynvc.slice(2)))), hex([b(drdynvc)]))
})

/** How many bytes Buffer.concat and Buffer.from (of bytes) copy while `f` runs. */
function copiedBy (f: () => void): number {
    const { concat, from } = Buffer
    let copied = 0
    Buffer.concat = ((list: readonly Uint8Array[], length?: number) => {
        const out = concat.call(Buffer, list, length)
        copied += out.length
        return out
    }) as typeof Buffer.concat
    Buffer.from = ((value: any, ...rest: any[]) => {
        const out = (from as any).call(Buffer, value, ...rest)
        copied += value instanceof Uint8Array ? out.length : 0
        return out
    }) as typeof Buffer.from
    try {
        f()
    } finally {
        Buffer.concat = concat
        Buffer.from = from
    }
    return copied
}

test('a server message that comes a byte at a time costs its size in copying, not its square', () => {
    // A server can send one-byte TLS records, each its own read: Tabby's window waits while they are joined.
    const size = 64 * 1024
    const frames = serverFraming(false)
    const pdus: Buffer[] = []
    const copied = copiedBy(() => {
        for (const byte of [0x30, 0x83, size >> 16, size >> 8 & 0xff, size & 0xff]) {
            pdus.push(...frames(b([byte])))
        }
        const one = Buffer.alloc(1, 0x41)
        for (let i = 0; i < size; i++) {
            pdus.push(...frames(one))
        }
    })
    assert.equal(pdus.length, 1)
    assert.equal(pdus[0].length, 5 + size)
    assert.ok(copied < 16 * size, `${copied} bytes copied for a message of ${size}`)
})

test('a server\'s CredSSP message larger than any is refused, before any of it is kept', () => {
    // A quarter of a megabyte goes through; more is no server's.
    const fits = 256 * 1024
    const frames = serverFraming(false)
    assert.equal(frames(Buffer.concat([b([0x30, 0x83, fits >> 16, fits >> 8 & 0xff, fits & 0xff]), Buffer.alloc(fits)])).length, 1)
    assert.throws(() => serverFraming(false)(b([0x30, 0x83, (fits + 1) >> 16, (fits + 1) >> 8 & 0xff, (fits + 1) & 0xff])), /invalid RDP server frame/)
})

test('malformed server data is refused', () => {
    for (const bad of [[0x30, 0x80], [0x30, 0x85], [0x30, 0x84, 0xff, 0xff, 0xff, 0xff], [3, 0, 0, 3], [3, 1, 0, 4]]) {
        assert.throws(() => serverFraming(false)(b(bad)), /invalid RDP server frame/, `${bad}`)
    }
    // Fast-path only once RDP has started, and not shorter than its header.
    assert.throws(() => serverFraming(false)(b([0, 4, 1, 2])), /invalid/)
    const frames = serverFraming(false)
    frames(b([3, 0, 0, 4]))
    assert.throws(() => frames(b([0, 1])), /invalid/)
})
