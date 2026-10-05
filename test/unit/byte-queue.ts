// The queue the proxy's and the gateway's readers keep what a server sends in until a message is whole
// (src/byteQueue.ts): what goes in comes out in order, however it is cut, and the queue keeps the bytes that wait, not
// the buffers they came in. And an SSH channel's stream (src/sshChannelStream.ts), which keeps what comes while its
// reader waits in such a queue, not as the pieces it came in. Runs against the built plugin:
// npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)
const { ByteQueue } = require('../../dist/byteQueue.js')
const { SSHChannelStream } = require('../../dist/sshChannelStream.js')

v8.setFlagsFromString('--expose-gc')
const gc: () => void = vm.runInNewContext('gc')

test('bytes come out as they went in, whatever the pieces and however they are taken', () => {
    // A fixed sequence of pseudo-random steps: pieces from empty to several slabs long, some of them parts of larger
    // buffers; headers peeked at; messages taken from a byte to several slabs.
    let seed = 7
    const random = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed % n
    }
    for (let round = 0; round < 20; round++) {
        const queue = new ByteQueue()
        let expected = Buffer.alloc(0)
        let next = 0
        for (let step = 0; step < 200; step++) {
            const what = random(10)
            if (what < 5) {
                const piece = Buffer.alloc(random(4) ? random(3000) : random(200000))
                for (let i = 0; i < piece.length; i++) {
                    piece[i] = next++ & 0xff
                }
                queue.push(random(2) ? piece : Buffer.concat([Buffer.alloc(7), piece, Buffer.alloc(5)]).subarray(7, 7 + piece.length))
                expected = Buffer.concat([expected, piece])
            } else if (what < 7) {
                const n = random(4) ? random(64) : random(300000)
                assert.ok(queue.peek(n).equals(expected.subarray(0, n)), `peek, round ${round}, step ${step}`)
            } else {
                const n = random(4) ? random(5000) : random(300000)
                const taken = Buffer.from(queue.take(n))
                assert.ok(taken.equals(expected.subarray(0, n)), `take, round ${round}, step ${step}`)
                expected = expected.subarray(taken.length)
            }
            assert.equal(queue.length, expected.length)
        }
    }
    // What was taken stays as it was while more comes.
    const queue = new ByteQueue()
    queue.push(Buffer.from('hello'))
    const hello = queue.take(5)
    queue.push(Buffer.alloc(100000, 0x7a))
    assert.equal(hello.toString(), 'hello')
})

/** Pushes one byte of each of `count` reads of 16 KiB (a buffer each) into `push`; the reads, weakly held. */
function oneByteOfEach (count: number, push: (piece: Buffer, i: number) => void): WeakRef<ArrayBufferLike>[] {
    const reads: WeakRef<ArrayBufferLike>[] = []
    for (let i = 0; i < count; i++) {
        const read = Buffer.alloc(16 * 1024, i)
        reads.push(new WeakRef(read.buffer))
        push(read.subarray(100, 101), i)
    }
    return reads
}

/** How many of `refs` are still there once garbage is collected. */
async function stillKept (refs: WeakRef<object>[]): Promise<number> {
    // A WeakRef keeps what it refers to until the job that made it is over.
    await new Promise(resolve => setImmediate(resolve))
    gc()
    return refs.filter(ref => ref.deref()).length
}

test('a byte from a large buffer doesn\'t keep that buffer', async () => {
    // As a TLS read that holds one byte of a message and other frames: kept as they came, 256 reads of 16 KiB would
    // keep 4 MiB for 256 bytes.
    const queue = new ByteQueue()
    const reads = oneByteOfEach(256, piece => queue.push(piece))
    const kept = await stillKept(reads)
    assert.equal(kept, 0, `${kept} of the reads are still kept`)
    assert.equal(queue.length, 256)
    assert.deepEqual([...queue.take(256)], Array.from({ length: 256 }, (_, i) => i))
})

test('what comes through an SSH channel while its reader waits is kept as bytes, not as the pieces it came in', async () => {
    // A channel as Tabby's SSH connection hands one over: data as it arrives (russh can't be told to slow down), and its end.
    let deliver: (d: Uint8Array) => void = () => { }
    let ended: () => void = () => { }
    const channel = {
        data$: { subscribe: (o: { next: (d: Uint8Array) => void }) => { deliver = o.next } },
        eof$: { subscribe: (f: () => void) => { ended = f } },
        closed$: { subscribe () { } },
        write: async () => { },
        eof: async () => { },
        close: async () => { },
    }
    const stream = new SSHChannelStream(channel)
    stream.pause()
    // A host (or a server behind it) sending a byte at a time to a reader that has stopped (TLS over the channel, paused
    // while the desktop's client doesn't keep up): each piece kept as it came would cost hundreds of times its byte.
    // Up to what the stream itself buffers (its high-water mark, which it asks for no more past), pieces are pieces.
    const count = 300_000
    for (let i = 0; i < count; i++) {
        deliver(Buffer.from([i & 0xff]))
    }
    ended()
    // Read again, it gets the bytes in a few pieces, in order, then the end.
    const pieces: Buffer[] = []
    const done = new Promise(resolve => stream.once('end', resolve))
    stream.on('data', (d: Buffer) => pieces.push(d))
    stream.resume()
    await done
    assert.ok(pieces.length <= stream.readableHighWaterMark + 2, `${pieces.length} pieces`)
    const all = Buffer.concat(pieces)
    assert.equal(all.length, count)
    assert.ok(all.every((b, i) => b === (i & 0xff)))
})
