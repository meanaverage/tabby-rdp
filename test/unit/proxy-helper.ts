// The plugin's side of its channel to the network helper (src/proxyHelper.ts), against a stand-in helper: a script
// that says hello and then, once the plugin sends it anything, sends what a broken helper might (or asks the plugin
// things whose answers are awkward to send). The real helper's side of the channel is tested in helper/internal/ipc.
// Runs against the built plugin: npm run build && npm run test:unit
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const { Helper, CodedError } = require('../../dist/proxyHelper.js')

// The stand-in runs as a program of its own, as the helper does: on Windows, a script isn't one.
const skip = process.platform === 'win32' && 'a script stands in for the helper, which Windows can\'t start as a program'

const STAND_IN = `#!${process.execPath}
const frame = (type, id, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(9)
    header.writeUInt32BE(5 + payload.length, 0)
    header[4] = type
    header.writeUInt32BE(id, 5)
    return Buffer.concat([header, payload])
}
const json = (text, rest = Buffer.alloc(0)) => {
    const body = Buffer.from(text)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    return frame(1, 0, Buffer.concat([length, body, rest]))
}
const message = envelope => json(JSON.stringify(envelope))
const broken = {
    'a short acknowledgement': frame(3, 1, Buffer.from([0, 1])),
    'a frame of an unknown type': frame(9, 0),
    'a data frame larger than one may be': frame(2, 1, Buffer.alloc((64 << 10) + 1)),
    'a message shorter than its length': frame(1, 0, Buffer.from([0, 1])),
    'JSON longer than the message': frame(1, 0, Buffer.from([0, 0, 0, 100, 0x7b, 0x7d])),
    'JSON that isn\\'t': json('{"type":'),
    'JSON that isn\\'t an object': json('[1,2]'),
    'blobs longer than the message': json('{"type":"event","event":"x","blobs":[10]}', Buffer.alloc(4)),
    'bytes no blob accounts for': json('{"type":"event","event":"x"}', Buffer.alloc(4)),
    'a blob of a negative size': json('{"type":"event","event":"x","blobs":[-4,8]}', Buffer.alloc(4)),
    'a message of an unknown type': message({ type: 'gossip' }),
    'a request with no method': message({ type: 'request', id: 7 }),
    'an event its handler can\\'t take': message({ type: 'event', event: 'flow', body: { read: 'lots' } }),
}
const mode = process.env.TRD_STAND_IN
process.stdout.write(message({ type: 'hello', body: { protocol: 2, version: 'stand-in' } }))
let input = Buffer.alloc(0)
let started = false
process.stdin.on('data', chunk => {
    if (mode === 'ask') {
        if (!started) {
            started = true
            for (const [id, method] of [[1, 'bigint'], [2, 'coded'], [3, 'textless'], [4, 'blobs']]) {
                process.stdout.write(message({ type: 'request', id, method, body: {} }))
            }
        }
        // Each answer, told back as an event.
        input = Buffer.concat([input, chunk])
        while (input.length >= 4 && input.length >= 4 + input.readUInt32BE(0)) {
            const length = input.readUInt32BE(0)
            const payload = input.subarray(9, 4 + length)
            if (input[4] === 1) {
                const envelope = JSON.parse(payload.subarray(4, 4 + payload.readUInt32BE(0)).toString())
                if (envelope.type === 'response') {
                    process.stdout.write(message({ type: 'event', event: 'heard', body: { ...envelope, size: payload.length } }))
                } else if (envelope.type === 'request' && envelope.method === 'shutdown') {
                    process.stdout.write(message({ type: 'response', id: envelope.id, body: {} }))
                }
            }
            input = input.subarray(4 + length)
        }
        return
    }
    if (!started) {
        started = true
        // What breaks the channel, and after it, in the same write, an event the plugin mustn't hear.
        process.stdout.write(Buffer.concat([broken[mode], message({ type: 'event', event: 'after' })]))
    }
})
process.stdin.on('end', () => process.exit(0))
`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-stand-in-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))
const standIn = path.join(dir, 'tabby-rdp-proxy')
fs.writeFileSync(standIn, STAND_IN, { mode: 0o755 })

async function start (mode: string) {
    process.env.TRD_STAND_IN = mode
    try {
        return await Helper.start(standIn)
    } finally {
        delete process.env.TRD_STAND_IN
    }
}

const broken: Record<string, RegExp> = {
    'a short acknowledgement': /an acknowledgement of 2 bytes/,
    'a frame of an unknown type': /a frame of type 9/,
    'a data frame larger than one may be': /a data frame of 65537 bytes/,
    'a message shorter than its length': /a message that isn't one/,
    'JSON longer than the message': /a message that isn't one/,
    'JSON that isn\'t': /a message that isn't one/,
    'JSON that isn\'t an object': /a message that isn't one/,
    'blobs longer than the message': /a message that isn't one/,
    'bytes no blob accounts for': /a message that isn't one/,
    'a blob of a negative size': /a message that isn't one/,
    'a message of an unknown type': /a message that isn't one/,
    'a request with no method': /a message that isn't one/,
    'an event its handler can\'t take': /a flow event the plugin couldn't take: a count of lots/,
}

for (const [mode, why] of Object.entries(broken)) {
    test(`a helper that sends ${mode} is stopped, says so, and isn't heard further; what waits on it fails`, { skip }, async () => {
        const helper = await start(mode)
        const events: string[] = []
        // As the proxy's handler does with a count that isn't one (see startRDCleanPathProxy).
        helper.onEvent = (event: string, body: any) => {
            if (event === 'flow' && typeof body?.read !== 'number') {
                throw new Error(`a count of ${body?.read}`)
            }
            events.push(event)
        }
        // Anything the plugin sends sets the stand-in off: a request here, which is then waiting.
        const asked = helper.request('anything', {})
        await assert.rejects(asked, /the network helper stopped unexpectedly/)
        const exit = await helper.exited
        assert.equal(exit.signal, 'SIGKILL')
        assert.equal(exit.expected, false)
        assert.match(exit.stderr, why)
        assert.deepEqual(events, [])
    })
}

test('the helper\'s requests are answered whatever the handler does: an answer JSON can\'t hold, a coded error, an error with no text, blobs', { skip }, async () => {
    const helper = await start('ask')
    const heard: any[] = []
    let all = () => { }
    const done = new Promise<void>(resolve => { all = resolve })
    helper.onEvent = (event: string, body: any) => {
        if (event === 'heard') {
            heard.push(body)
            if (heard.length === 4) {
                all()
            }
        }
    }
    helper.onRequest = async (method: string) => {
        switch (method) {
            case 'bigint':
                return { body: { n: 1n } }
            case 'coded':
                throw new CodedError('the gateway refused the sign-in', 'signIn')
            case 'textless':
                // eslint-disable-next-line no-throw-literal
                throw { message: undefined, toString () { throw new Error('no text either') } }
            case 'blobs':
                return { body: { ok: true }, blobs: [Buffer.from('abc'), Buffer.from('defg')] }
        }
    }
    helper.send({ type: 'event', event: 'go' })
    await done
    heard.sort((a, b) => a.id - b.id)
    assert.match(heard[0].error, /^the plugin couldn't answer bigint: .*BigInt/)
    assert.equal(heard[0].body, undefined)
    assert.deepEqual([heard[1].error, heard[1].code], ['the gateway refused the sign-in', 'signIn'])
    assert.equal(heard[2].error, 'an error that has no text')
    assert.deepEqual([heard[3].error, heard[3].body, heard[3].blobs], [undefined, { ok: true }, [3, 4]])
    helper.close()
    const exit = await helper.exited
    assert.equal(exit.expected, true)
})
