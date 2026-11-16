import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { AudioPlayer } = require('../../dist/audio.js')

test('server volume before the first wave persists, preserves balance and uses logarithmic gain', t => {
    const gains: any[] = [], starts: number[] = []
    const node = () => ({ connect () {} })
    class Context {
        state = 'running'
        currentTime = 0
        destination = {}
        createGain () { const n = { ...node(), gain: { value: 1 } }; gains.push(n); return n }
        createChannelSplitter () { return node() }
        createChannelMerger () { return node() }
        createBuffer (channels: number, frames: number, rate: number) {
            return { duration: frames / rate, getChannelData: () => new Float32Array(frames) }
        }
        createBufferSource () { return { ...node(), start: (at: number) => starts.push(at) } }
        async close () {}
    }
    const previous = (globalThis as any).AudioContext
    ;(globalThis as any).AudioContext = Context
    t.after(() => { (globalThis as any).AudioContext = previous })
    const player = new AudioPlayer()
    t.after(() => player.close())
    player.callback({ type: 'volume', left: 0, right: 0.5 })
    assert.equal(gains.length, 0)
    player.callback({ type: 'wave', sampleRate: 48000, channels: 2, data: new Uint8Array([0, 127, 0, 127]) })
    assert.equal(gains[1].gain.value, 0)
    assert.ok(Math.abs(gains[2].gain.value - 0.0316227766) < 1e-9)
    assert.equal(starts.length, 1)
    player.callback({ type: 'volume', left: 1, right: 0 })
    assert.equal(gains[1].gain.value, 1)
    assert.equal(gains[2].gain.value, 0)
    player.callback({ type: 'volume', left: NaN, right: Infinity })
    assert.equal(gains[1].gain.value, 1)
    assert.equal(gains[2].gain.value, 0)
})
