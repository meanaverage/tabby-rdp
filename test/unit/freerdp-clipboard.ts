// FreeRDP's text clipboard (FreeRDPClipboard): the clipboard goes only while the desktop has the keyboard, this
// computer's text only when it changed and may go, the server's (the latest of it) only when it may come, nothing is
// sent straight back, a narrowing is passed on to the helper, and nothing is read before the connection is up.
// Reads the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { FreeRDPClipboard, freeRDPClipboardLog } = require('../../dist/freerdpClipboard.js')

type Ways = { toRemote: boolean, fromRemote: boolean }

/** A clipboard here, what was sent and narrowed, and the ways and keyboard as a test sets them; polled by hand. */
function fixture (ways: Ways = { toRemote: true, fromRemote: true }, interval = 1e9) {
    const state = { local: '', sent: [] as string[], narrowed: [] as Ways[], ways, keyboard: true, reads: 0, failing: false }
    const clipboard = new FreeRDPClipboard({
        read: () => { state.reads++; if (state.failing) { throw new Error('no clipboard') } return state.local },
        write: (text: string) => { state.local = text },
        send: (text: string) => { state.sent.push(text) },
        narrow: (next: Ways) => { state.narrowed.push(next) },
    }, () => state.ways, () => state.keyboard, interval)
    return { state, clipboard }
}

test('this computer\'s text goes once per change, only while the desktop has the keyboard', t => {
    const { state, clipboard } = fixture()
    t.after(() => clipboard.stop())
    state.local = 'one'
    clipboard.poll()
    clipboard.poll()
    assert.deepEqual(state.sent, ['one'])
    state.keyboard = false
    state.local = 'two'
    clipboard.poll()
    assert.deepEqual(state.sent, ['one'])
    assert.equal(state.reads, 2, 'not read at all without the keyboard')
    state.keyboard = true
    clipboard.poll()
    assert.deepEqual(state.sent, ['one', 'two'])
})

test('the server\'s text is written here with the keyboard, the latest of it, and not sent straight back', t => {
    const { state, clipboard } = fixture()
    t.after(() => clipboard.stop())
    state.local = 'mine'
    state.keyboard = false
    clipboard.remote('first')
    clipboard.remote('latest')
    clipboard.poll()
    assert.equal(state.local, 'mine', 'a desktop in the background leaves this computer\'s clipboard alone')
    state.keyboard = true
    clipboard.poll()
    assert.equal(state.local, 'latest')
    assert.deepEqual(state.sent, [])
    state.local = 'new here'
    clipboard.poll()
    assert.deepEqual(state.sent, ['new here'])
})

test('only from the remote desktop: this computer\'s clipboard is never read; off: nothing either way', t => {
    const from = fixture({ toRemote: false, fromRemote: true })
    t.after(() => from.clipboard.stop())
    from.state.local = 'secret'
    from.clipboard.remote('theirs')
    from.clipboard.poll()
    assert.equal(from.state.reads, 0)
    assert.deepEqual(from.state.sent, [])
    assert.equal(from.state.local, 'theirs')
    const off = fixture({ toRemote: false, fromRemote: false })
    t.after(() => off.clipboard.stop())
    off.state.local = 'secret'
    off.clipboard.remote('theirs')
    off.clipboard.poll()
    assert.equal(off.state.reads, 0)
    assert.equal(off.state.local, 'secret')
})

test('a narrowing while connected stops the sending at once and is passed on to the helper, keyboard or not', t => {
    const { state, clipboard } = fixture()
    t.after(() => clipboard.stop())
    state.local = 'one'
    clipboard.poll()
    state.keyboard = false
    state.ways = { toRemote: false, fromRemote: true }
    clipboard.poll()
    clipboard.poll()
    assert.deepEqual(state.narrowed, [{ toRemote: false, fromRemote: true }], 'passed on once')
    state.keyboard = true
    state.local = 'two'
    clipboard.poll()
    assert.deepEqual(state.sent, ['one'])
    clipboard.remote('pending')
    state.ways = { toRemote: false, fromRemote: false }
    clipboard.poll()
    assert.equal(state.local, 'two', 'what came before narrowing to off isn\'t written after it')
    assert.deepEqual(state.narrowed.at(-1), { toRemote: false, fromRemote: false })
})

test('a clipboard that can\'t be read sends nothing', t => {
    const { state, clipboard } = fixture()
    t.after(() => clipboard.stop())
    state.failing = true
    clipboard.poll()
    assert.deepEqual(state.sent, [])
})

test('nothing is read before the connection is up', async t => {
    const { state, clipboard } = fixture(undefined, 1)
    t.after(() => clipboard.stop())
    state.local = 'early'
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(state.reads, 0)
    clipboard.start()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(state.reads > 0)
    assert.deepEqual(state.sent, ['early'])
})

test('the connection log says the ways, and that FreeRDP shares text only', () => {
    assert.equal(freeRDPClipboardLog('both'), 'clipboard: both ways; FreeRDP shares text only')
    assert.match(freeRDPClipboardLog('fromRemote'), /^clipboard: only from the remote desktop .*; FreeRDP shares text only$/)
    assert.equal(freeRDPClipboardLog('off'), 'clipboard: off (no clipboard channel)')
})
