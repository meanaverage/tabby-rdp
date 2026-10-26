/**
 * ZGFX (RDP 8.0 bulk compression, MS-RDPEGFX 3.1.9.1) decompression, for the PDU trace (see pduTrace.ts): the
 * graphics pipeline's messages come ZGFX-compressed over its dynamic channel, and the trace decodes them to show the
 * exact graphics commands on the wire. A port of IronRDP's decompressor (ironrdp-graphics, zgfx/mod.rs); its test
 * vectors are in test/fixtures/zgfx and test/unit/zgfx.ts.
 *
 * The history is a 2,500,000-byte ring shared by every segment the same stream sends: one decompressor per direction
 * of a channel, fed every message in order, or matches into the history come out wrong. Not for the data path: the
 * client decodes for itself; this only reads along.
 */

/** Sliding window size (MS-RDPEGFX 3.1.9.1.1). */
export const HISTORY_SIZE = 2_500_000

/** The most one segment decompresses to (a resource limit, as IronRDP's). */
const MAX_DECOMPRESSED_PER_SEGMENT = 64 * 1024 * 1024

const SEGMENTED_SINGLE = 0xe0
const SEGMENTED_MULTIPART = 0xe1
const COMPRESSION_TYPE_RDP8 = 0x04
const PACKET_COMPRESSED = 0x20

interface Token {
    prefix: string
    kind: 'null' | 'literal' | 'match'
    value: number
    /** Match tokens: how many bits of distance follow, and the base distance. */
    bits: number
}

const TOKENS: Token[] = [
    { prefix: '0', kind: 'null', value: 0, bits: 0 },
    { prefix: '11000', kind: 'literal', value: 0x00, bits: 0 },
    { prefix: '11001', kind: 'literal', value: 0x01, bits: 0 },
    { prefix: '110100', kind: 'literal', value: 0x02, bits: 0 },
    { prefix: '110101', kind: 'literal', value: 0x03, bits: 0 },
    { prefix: '110110', kind: 'literal', value: 0xff, bits: 0 },
    { prefix: '1101110', kind: 'literal', value: 0x04, bits: 0 },
    { prefix: '1101111', kind: 'literal', value: 0x05, bits: 0 },
    { prefix: '1110000', kind: 'literal', value: 0x06, bits: 0 },
    { prefix: '1110001', kind: 'literal', value: 0x07, bits: 0 },
    { prefix: '1110010', kind: 'literal', value: 0x08, bits: 0 },
    { prefix: '1110011', kind: 'literal', value: 0x09, bits: 0 },
    { prefix: '1110100', kind: 'literal', value: 0x0a, bits: 0 },
    { prefix: '1110101', kind: 'literal', value: 0x0b, bits: 0 },
    { prefix: '1110110', kind: 'literal', value: 0x3a, bits: 0 },
    { prefix: '1110111', kind: 'literal', value: 0x3b, bits: 0 },
    { prefix: '1111000', kind: 'literal', value: 0x3c, bits: 0 },
    { prefix: '1111001', kind: 'literal', value: 0x3d, bits: 0 },
    { prefix: '1111010', kind: 'literal', value: 0x3e, bits: 0 },
    { prefix: '1111011', kind: 'literal', value: 0x3f, bits: 0 },
    { prefix: '1111100', kind: 'literal', value: 0x40, bits: 0 },
    { prefix: '1111101', kind: 'literal', value: 0x80, bits: 0 },
    { prefix: '11111100', kind: 'literal', value: 0x0c, bits: 0 },
    { prefix: '11111101', kind: 'literal', value: 0x38, bits: 0 },
    { prefix: '11111110', kind: 'literal', value: 0x39, bits: 0 },
    { prefix: '11111111', kind: 'literal', value: 0x66, bits: 0 },
    { prefix: '10001', kind: 'match', value: 0, bits: 5 },
    { prefix: '10010', kind: 'match', value: 32, bits: 7 },
    { prefix: '10011', kind: 'match', value: 160, bits: 9 },
    { prefix: '10100', kind: 'match', value: 672, bits: 10 },
    { prefix: '10101', kind: 'match', value: 1_696, bits: 12 },
    { prefix: '101100', kind: 'match', value: 5_792, bits: 14 },
    { prefix: '101101', kind: 'match', value: 22_176, bits: 15 },
    { prefix: '1011100', kind: 'match', value: 54_944, bits: 18 },
    { prefix: '1011101', kind: 'match', value: 317_088, bits: 20 },
    { prefix: '10111100', kind: 'match', value: 1_365_664, bits: 20 },
    { prefix: '10111101', kind: 'match', value: 2_414_240, bits: 21 },
    { prefix: '101111100', kind: 'match', value: 4_511_392, bits: 22 },
    { prefix: '101111101', kind: 'match', value: 8_705_696, bits: 23 },
    { prefix: '101111110', kind: 'match', value: 17_094_304, bits: 24 },
]

/** The tokens as a lookup: for each prefix length, a map from the prefix's value to the token. */
const BY_LENGTH: Map<number, Token>[] = []
for (const token of TOKENS) {
    const len = token.prefix.length
    BY_LENGTH[len] ??= new Map()
    BY_LENGTH[len].set(parseInt(token.prefix, 2), token)
}
const MAX_PREFIX = Math.max(...TOKENS.map(t => t.prefix.length))

export class ZgfxError extends Error { }

/** Reads bits, most significant first, from a byte array up to a bit count. */
class BitReader {
    private pos = 0
    constructor (private readonly data: Uint8Array, private readonly bitCount: number) { }

    get remaining (): number { return this.bitCount - this.pos }
    get bitInByte (): number { return this.pos & 7 }

    bits (count: number): number {
        if (count > this.remaining) {
            throw new ZgfxError(`incomplete bit stream: needed ${count} bits, ${this.remaining} remaining`)
        }
        let value = 0
        for (let i = 0; i < count; i++) {
            const byte = this.data[this.pos >> 3]
            const bit = (byte >> (7 - (this.pos & 7))) & 1
            value = value * 2 + bit
            this.pos++
        }
        return value
    }

    /** Looks at the next `count` bits without taking them; -1 when fewer remain. */
    peek (count: number): number {
        if (count > this.remaining) {
            return -1
        }
        const at = this.pos
        const value = this.bits(count)
        this.pos = at
        return value
    }

    /** Counts the 1 bits ahead, up to the end. */
    leadingOnes (): number {
        let n = 0
        while (n < this.remaining && ((this.data[(this.pos + n) >> 3] >> (7 - ((this.pos + n) & 7))) & 1)) {
            n++
        }
        return n
    }

    alignToByte (): void {
        const over = this.bitInByte
        if (over) {
            this.bits(8 - over)
        }
    }

    /** The next `count` whole bytes (the reader is byte-aligned). */
    bytes (count: number): Uint8Array {
        if (count * 8 > this.remaining) {
            throw new ZgfxError(`incomplete bit stream: needed ${count} bytes`)
        }
        const start = this.pos >> 3
        this.pos += count * 8
        return this.data.subarray(start, start + count)
    }
}

export class ZgfxDecompressor {
    private readonly history = new Uint8Array(HISTORY_SIZE)
    private at = 0
    private filled = 0

    /** Decompresses one RDP_SEGMENTED_DATA message (MS-RDPEGFX 2.2.5.1). */
    decompress (input: Uint8Array): Uint8Array {
        if (input.length < 1) {
            throw new ZgfxError('empty segmented data')
        }
        const descriptor = input[0]
        const out: Uint8Array[] = []
        if (descriptor === SEGMENTED_SINGLE) {
            out.push(this.segment(input.subarray(1)))
        } else if (descriptor === SEGMENTED_MULTIPART) {
            if (input.length < 7) {
                throw new ZgfxError('truncated multipart header')
            }
            const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
            const count = view.getUint16(1, true)
            const uncompressedSize = view.getUint32(3, true)
            let offset = 7
            let total = 0
            for (let i = 0; i < count; i++) {
                if (offset + 4 > input.length) {
                    throw new ZgfxError('truncated multipart segment')
                }
                const size = view.getUint32(offset, true)
                offset += 4
                if (offset + size > input.length) {
                    throw new ZgfxError('multipart segment longer than the message')
                }
                const part = this.segment(input.subarray(offset, offset + size))
                offset += size
                total += part.length
                out.push(part)
            }
            if (total !== uncompressedSize) {
                throw new ZgfxError(`multipart decompressed to ${total} bytes, ${uncompressedSize} declared`)
            }
        } else {
            throw new ZgfxError(`unknown segmented descriptor 0x${descriptor.toString(16)}`)
        }
        return concat(out)
    }

    /** One RDP8_BULK_ENCODED_DATA segment. */
    private segment (segment: Uint8Array): Uint8Array {
        if (segment.length < 1) {
            throw new ZgfxError('empty bulk encoded data')
        }
        const header = segment[0]
        if ((header & 0x0f) !== COMPRESSION_TYPE_RDP8) {
            throw new ZgfxError(`unknown compression type 0x${(header & 0x0f).toString(16)}`)
        }
        const data = segment.subarray(1)
        if (data.length === 0) {
            return new Uint8Array(0)
        }
        if (!(header & PACKET_COMPRESSED)) {
            this.write(data)
            return data
        }
        return this.decompressSegment(data)
    }

    private decompressSegment (encoded: Uint8Array): Uint8Array {
        // The low 3 bits of the last byte say how many bits of the byte before it are unused; the last byte itself
        // holds no data.
        const trailing = encoded[encoded.length - 1] & 0x07
        const bitCount = 8 * (encoded.length - 1) - trailing
        if (bitCount < 0) {
            throw new ZgfxError('invalid trailing bit count')
        }
        const bits = new BitReader(encoded, bitCount)
        const out: number[] = []
        while (bits.remaining > 0) {
            let token: Token | undefined
            for (let len = 1; len <= MAX_PREFIX; len++) {
                const candidates = BY_LENGTH[len]
                if (!candidates) {
                    continue
                }
                const value = bits.peek(len)
                if (value < 0) {
                    break
                }
                token = candidates.get(value)
                if (token) {
                    bits.bits(len)
                    break
                }
            }
            if (!token) {
                throw new ZgfxError('token bits not found')
            }
            if (token.kind === 'null') {
                const value = bits.bits(8)
                this.writeByte(value)
                out.push(value)
            } else if (token.kind === 'literal') {
                this.writeByte(token.value)
                out.push(token.value)
            } else {
                const distance = token.value + bits.bits(token.bits)
                if (distance === 0) {
                    // An unencoded run: a 15-bit count, byte-aligned bytes.
                    const length = bits.bits(15)
                    bits.alignToByte()
                    const raw = bits.bytes(length)
                    this.write(raw)
                    for (const b of raw) {
                        out.push(b)
                    }
                } else {
                    if (distance > HISTORY_SIZE) {
                        throw new ZgfxError(`match distance ${distance} beyond the history`)
                    }
                    const ones = bits.leadingOnes()
                    bits.bits(ones + 1)  // the 1s and the 0 that ends them
                    let length: number
                    if (ones === 0) {
                        length = 3
                    } else {
                        const valueBits = ones + 1
                        if (valueBits > 30) {
                            throw new ZgfxError('match length token too large')
                        }
                        length = (1 << valueBits) + bits.bits(valueBits)
                    }
                    if (out.length + length > MAX_DECOMPRESSED_PER_SEGMENT) {
                        throw new ZgfxError('segment decompresses beyond the limit')
                    }
                    this.copyMatch(distance, length, out)
                }
            }
            if (out.length > MAX_DECOMPRESSED_PER_SEGMENT) {
                throw new ZgfxError('segment decompresses beyond the limit')
            }
        }
        return Uint8Array.from(out)
    }

    private writeByte (value: number): void {
        this.history[this.at] = value
        this.at = (this.at + 1) % HISTORY_SIZE
        if (this.filled < HISTORY_SIZE) {
            this.filled++
        }
    }

    private write (data: Uint8Array): void {
        for (const b of data) {
            this.writeByte(b)
        }
    }

    /** Copies `length` bytes from `distance` back in the history (overlapping as a match may), to the output and history. */
    private copyMatch (distance: number, length: number, out: number[]): void {
        if (distance > this.filled) {
            throw new ZgfxError(`match distance ${distance} beyond what the history holds (${this.filled})`)
        }
        let from = (this.at - distance + HISTORY_SIZE) % HISTORY_SIZE
        for (let i = 0; i < length; i++) {
            const b = this.history[from]
            from = (from + 1) % HISTORY_SIZE
            this.writeByte(b)
            out.push(b)
        }
    }
}

function concat (parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) {
        return parts[0]
    }
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
        out.set(p, at)
        at += p.length
    }
    return out
}
