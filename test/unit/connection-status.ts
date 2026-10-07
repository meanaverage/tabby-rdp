// Canvas hook ownership: hiding, ending or replacing a desktop releases its component/backend, and showing it
// again counts frames without stacking wrappers. Runs against the built plugin; no browser or server is needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { FakeElement, installDocument } from './support/dom.js'

const require = createRequire(import.meta.url)
const { ConnectionStatus } = require('../../dist/connectionStatus.js')

function canvas () {
    const calls: unknown[][] = []
    const context = { putImageData (...args: unknown[]) { assert.equal(this, context); calls.push(args) } }
    const original = context.putImageData
    return { element: { getContext: () => context }, context, original, calls }
}

test('statistics release their canvas when hidden and rehook it without stacking frame counters', async t => {
    const page = installDocument()
    t.after(page.restore)
    const overlay = new FakeElement()
    const indicator = new ConnectionStatus(overlay, { runOutsideAngular: (f: () => void) => f() }, { path: () => 'desktop', bytes: () => null })
    t.after(() => indicator.dispose())
    const frame = canvas()
    indicator.setActive(true, frame.element)
    const wrapper = frame.context.putImageData
    indicator.setActive(true, frame.element)
    assert.equal(frame.context.putImageData, wrapper)
    frame.context.putImageData('one', 0, 0)
    frame.context.putImageData('two', 1, 1)
    assert.equal(indicator.frames, 1, 'one synchronous batch is one frame')
    await Promise.resolve()
    frame.context.putImageData('three', 2, 2)
    assert.equal(indicator.frames, 2)
    assert.deepEqual(frame.calls, [['one', 0, 0], ['two', 1, 1], ['three', 2, 2]])

    indicator.setActive(false)
    assert.equal(frame.context.putImageData, frame.original)
    assert.equal(indicator.frameHook, null)
    assert.equal(indicator.timer, null)
    assert.equal(overlay.querySelector('.trd-stats'), null)
    frame.context.putImageData('hidden', 0, 0)
    assert.equal(indicator.frames, 2)

    indicator.setActive(true, frame.element)
    frame.context.putImageData('shown again', 0, 0)
    assert.equal(indicator.frames, 3)
    indicator.dispose()
    indicator.dispose()
    assert.equal(frame.context.putImageData, frame.original)
    assert.equal(indicator.frameHook, null)
})

test('statistics release a replaced canvas and leave another owner\'s method intact', t => {
    const page = installDocument()
    t.after(page.restore)
    const indicator = new ConnectionStatus(new FakeElement(), { runOutsideAngular: (f: () => void) => f() }, { path: () => '', bytes: () => null })
    t.after(() => indicator.dispose())
    const first = canvas(), replacement = canvas()
    indicator.setActive(true, first.element)
    indicator.setActive(true, replacement.element)
    assert.equal(first.context.putImageData, first.original)
    first.context.putImageData('old', 0, 0)
    replacement.context.putImageData('new', 0, 0)
    assert.equal(indicator.frames, 1)
    const laterOwner = () => { }
    replacement.context.putImageData = laterOwner
    indicator.dispose()
    assert.equal(replacement.context.putImageData, laterOwner)
    assert.equal(indicator.frameHook, null)
})
