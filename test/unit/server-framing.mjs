// The proxy's server framing (src/rdcleanpath.ts, serverFraming): one server PDU per WebSocket message, whatever
// the TLS reads look like. Runs against the built plugin: npm run build && node --test test/unit/*.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { serverFraming } = require('../../dist/rdcleanpath.js')

const hex = pdus => pdus.map(p => Buffer.from(p).toString('hex'))
const b = bytes => Buffer.from(bytes)

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
    assert.deepEqual(hex(frames(b(STREAM.flat()))), hex(STREAM))
})

test('PDUs split at every byte are joined', () => {
    const frames = serverFraming(true)
    const out = []
    for (const byte of STREAM.flat()) {
        out.push(...frames(b([byte])))
    }
    assert.deepEqual(hex(out), hex(STREAM))
})

test('without HYBRID_EX there is no Early User Authorization Result', () => {
    const frames = serverFraming(false)
    const pdus = [[0x30, 3, 2, 1, 6], [3, 0, 0, 5, 1], [0, 3, 9]]
    assert.deepEqual(hex(frames(b(pdus.flat()))), hex(pdus))
})

test('activation and the start of channel negotiation in one read stay two messages', () => {
    // As GNOME sends them: the last activation PDU (Font Map) and the drdynvc capabilities request.
    const fontMap = [3, 0, 0, 8, 1, 2, 3, 4]
    const drdynvc = [3, 0, 0, 7, 5, 6, 7]
    const frames = serverFraming(false)
    assert.deepEqual(hex(frames(b([...fontMap, ...drdynvc.slice(0, 2)]))), hex([fontMap]))
    assert.deepEqual(hex(frames(b(drdynvc.slice(2)))), hex([drdynvc]))
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
