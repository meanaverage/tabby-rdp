// The ZGFX decompressor (src/zgfx.ts) against IronRDP's test vectors (test/fixtures/zgfx: five single-segment
// messages, decompressed in order through one history), and its own small cases. Runs against the built plugin:
// npm run build && npm run test:unit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { ZgfxDecompressor, ZgfxError } = require('../../dist/zgfx.js')

const fixtures = fileURLToPath(new URL('../fixtures/zgfx/', import.meta.url))
const read = (name: string) => new Uint8Array(fs.readFileSync(fixtures + name))

test('decompresses IronRDP\'s five messages through one history', () => {
    const zgfx = new ZgfxDecompressor()
    for (let i = 0; i < 5; i++) {
        const out = zgfx.decompress(read(`encoded.${i}.bin`))
        assert.deepEqual(Buffer.from(out), Buffer.from(read(`decoded.${i}.bin`)), `message #${i}`)
    }
})

test('a single compressed segment with one literal', () => {
    // SINGLE, RDP8 compressed, prefix 11001 = literal 0x01, 3 unused bits in the byte before the trailer.
    const out = new ZgfxDecompressor().decompress(Uint8Array.from([0xe0, 0x24, 0b1100_1000, 0x03]))
    assert.deepEqual([...out], [0x01])
    // The reserved high bits of the trailer are ignored.
    const same = new ZgfxDecompressor().decompress(Uint8Array.from([0xe0, 0x24, 0b1100_1000, 0x03 | 0b1010_0000]))
    assert.deepEqual([...same], [0x01])
})

test('an uncompressed segment passes through and feeds the history for the next match', () => {
    const zgfx = new ZgfxDecompressor()
    const plain = zgfx.decompress(Uint8Array.from([0xe0, 0x04, 0x41, 0x42, 0x43]))
    assert.equal(Buffer.from(plain).toString(), 'ABC')
    // A match of 3 bytes at distance 3: token 10001 (base 0, 5 distance bits = 3), then length prefix "0" (= 3).
    // Bits: 10001 00011 0 → 1000 1000 1100 0000: 0x88 0xC0, with 5 unused bits in the last data byte → trailer 0x05.
    const copied = zgfx.decompress(Uint8Array.from([0xe0, 0x24, 0x88, 0xc0, 0x05]))
    assert.equal(Buffer.from(copied).toString(), 'ABC')
})

test('a multipart message concatenates its segments and checks the declared size', () => {
    const header = [0xe1, 0x02, 0x00, 0x06, 0x00, 0x00, 0x00]
    const seg = (bytes: number[]) => [bytes.length + 1, 0, 0, 0, 0x04, ...bytes]
    const out = new ZgfxDecompressor().decompress(Uint8Array.from([...header, ...seg([1, 2, 3]), ...seg([4, 5, 6])]))
    assert.deepEqual([...out], [1, 2, 3, 4, 5, 6])
    const wrong = [0xe1, 0x01, 0x00, 0x09, 0x00, 0x00, 0x00, ...seg([1, 2, 3])]
    assert.throws(() => new ZgfxDecompressor().decompress(Uint8Array.from(wrong)), ZgfxError)
})

test('malformed input is refused rather than read past', () => {
    assert.throws(() => new ZgfxDecompressor().decompress(Uint8Array.from([0xe2])), ZgfxError)
    assert.throws(() => new ZgfxDecompressor().decompress(Uint8Array.from([0xe0, 0x05, 1])), ZgfxError)
    // A match into an empty history.
    assert.throws(() => new ZgfxDecompressor().decompress(Uint8Array.from([0xe0, 0x24, 0x88, 0xc0, 0x05])), ZgfxError)
})
