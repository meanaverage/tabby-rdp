// FreeRDP's text clipboard (FreeRDPClipboard): this computer's text is read only while the desktop has the keyboard and
// may go there, only a change is sent, the server's text is written here only when it may come, and what came from the
// server isn't sent straight back. Reads the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { FreeRDPClipboard, freeRDPClipboardLog } = require('../../dist/freerdpClipboard.js')

/** A clipboard here, the sent text, and the ways and keyboard as a test sets them; polled by hand. */
function fixture (ways = { toRemote: true, fromRemote: true }) {
    const state = { local: '', sent: [] as string[], ways, keyboard: true, reads: 0, failing: false }
    const clipboard = new FreeRDPClipboard({
        read: () => { state.reads++; if (state.failing) { throw new Error('no clipboard') } return state.local },
        write: (text: string) => { state.local = text },
        send: (text: string) => { state.sent.push(text) },
    }, () => state.ways, () => state.keyboard, 1e9)
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

test('the server\'s text is written here and not sent straight back', t => {
    const { state, clipboard } = fixture()
    t.after(() => clipboard.stop())
    clipboard.remote('from there')
    assert.equal(state.local, 'from there')
    clipboard.poll()
    assert.deepEqual(state.sent, [])
    state.local = 'mine'
    clipboard.poll()
    assert.deepEqual(state.sent, ['mine'])
})

test('only from the remote desktop: this computer\'s clipboard is never read; off: nothing either way', t => {
    const from = fixture({ toRemote: false, fromRemote: true })
    t.after(() => from.clipboard.stop())
    from.state.local = 'secret'
    from.clipboard.poll()
    assert.equal(from.state.reads, 0)
    assert.deepEqual(from.state.sent, [])
    from.clipboard.remote('theirs')
    assert.equal(from.state.local, 'theirs')
    const off = fixture({ toRemote: false, fromRemote: false })
    t.after(() => off.clipboard.stop())
    off.state.local = 'secret'
    off.clipboard.poll()
    off.clipboard.remote('theirs')
    assert.equal(off.state.reads, 0)
    assert.equal(off.state.local, 'secret')
})

test('a narrowing while connected stops the sending at once, and a clipboard that can\'t be read sends nothing', t => {
    const { state, clipboard } = fixture()
    t.after(() => clipboard.stop())
    state.local = 'one'
    clipboard.poll()
    state.ways = { toRemote: false, fromRemote: true }
    state.local = 'two'
    clipboard.poll()
    assert.deepEqual(state.sent, ['one'])
    state.ways = { toRemote: true, fromRemote: true }
    state.failing = true
    clipboard.poll()
    assert.deepEqual(state.sent, ['one'])
})

test('the connection log says the ways, and that FreeRDP shares text only', () => {
    assert.equal(freeRDPClipboardLog('both'), 'clipboard: both ways; FreeRDP shares text only')
    assert.match(freeRDPClipboardLog('fromRemote'), /^clipboard: only from the remote desktop .*; FreeRDP shares text only$/)
    assert.equal(freeRDPClipboardLog('off'), 'clipboard: off (no clipboard channel)')
})
