// `desk` requests in terminal output (src/deskScript.ts, used by src/desk.ts): what is taken out of the output, what a
// request says, its key, and the one-at-a-time gate. Anything a terminal shows can carry these bytes, so a request
// counts only with desk's key, and a burst of them costs no more than one. And the probes that come the same way
// (src/probe.ts). Runs against the built plugin: npm run build && npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)
const { takeDeskMessages, parseDeskRequest, deskKeyDigest, DeskGate, DeskRequests } = require('../../dist/deskScript.js')
const { probeArrived, probesIn, MAX_PROBES } = require('../../dist/probe.js')
v8.setFlagsFromString('--expose-gc')
const gc: () => void = vm.runInNewContext('gc')

const b64 = (s: string) => Buffer.from(s).toString('base64')
const KEY = '0123456789abcdef0123456789abcdef'
/** Another well-formed key: one no host gave (or another host's). */
const OTHER = 'fedcba9876543210fedcba9876543210'
/** What bin/desk prints (see remoteSetup.ts), with `fields` in its order. */
const desk = (...fields: string[]) => `\x1b]7777;desk;${fields.map(b64).join(';')}\x07`

test('a request: its fields and desk\'s key', () => {
    const { output, desk: request, probes } = takeDeskMessages(Buffer.from(`before ${desk('ab12cd34', '/run/x.sock', '/home/u', 'native', 'm1', 'host', KEY)} after`))
    assert.equal(output.toString(), 'before  after')
    assert.deepEqual(request, { session: 'ab12cd34', socket: '/run/x.sock', cwd: '/home/u', kind: 'native', machine: 'm1', hostname: 'host', key: KEY })
    assert.deepEqual(probes, [])
})

test('a request without a well-formed key has none: desk from before keys, or not desk at all', () => {
    assert.equal(parseDeskRequest(['s', 'k', '/', 'native', 'm', 'h'].map(b64).join(';')).key, '')
    assert.equal(parseDeskRequest(['s', 'k', '/', 'native', 'm', 'h', KEY.toUpperCase()].map(b64).join(';')).key, '')
    assert.equal(parseDeskRequest(['s', 'k', '/', 'native', 'm', 'h', KEY + '0'].map(b64).join(';')).key, '')
    assert.equal(parseDeskRequest(['s', 'k', '/', 'native', 'm', 'h', `${KEY}\n`].map(b64).join(';')).key, '')
    assert.equal(parseDeskRequest('').key, '')
    assert.deepEqual(parseDeskRequest(''), { session: '', socket: '', cwd: '', kind: '', machine: '', hostname: '', key: '' })
})

test('the key is kept as a digest, and only a well-formed one', () => {
    assert.match(deskKeyDigest(KEY), /^[0-9a-f]{64}$/)
    assert.equal(deskKeyDigest(KEY), deskKeyDigest(KEY))
    assert.notEqual(deskKeyDigest(KEY), deskKeyDigest('f' + KEY.slice(1)))
    for (const bad of ['', undefined, 'not-a-key', KEY.slice(1), KEY.toUpperCase()]) {
        assert.equal(deskKeyDigest(bad), '')
    }
})

test('output passes through byte for byte; both terminators; probes; an unfinished sequence stays', () => {
    const other = Buffer.from([0x1b, 0x5d, 0x30, 0x3b, 0x74, 0x07, 0xc3, 0xa9, 0x00, 0xff])  // a title (OSC 0), UTF-8, binary
    const data = Buffer.concat([other, Buffer.from(`${desk('a')}x\x1b]7777;probe;trd1-2\x1b\\y\x1b]7777;desk;${b64('z')}\x1b\\`), other])
    const { output, desk: request, probes } = takeDeskMessages(data)
    assert.deepEqual(output, Buffer.concat([other, Buffer.from('xy'), other]))
    assert.equal(request.session, 'z')
    assert.deepEqual(probes, ['trd1-2'])
    const open = Buffer.from(`text \x1b]7777;desk;${b64('a')}`)
    const unfinished = takeDeskMessages(open)
    assert.equal(unfinished.output, open)
    assert.equal(unfinished.desk, null)
    const plain = Buffer.from('nothing here')
    assert.equal(takeDeskMessages(plain).output, plain)
})

test('a burst of requests in a chunk is one request, the last, and costs its length, not its square', () => {
    const many = Buffer.from(desk('first', '', '', '', '', '', KEY).repeat(5) + desk('last') + 'shown')
    const { output, desk: request } = takeDeskMessages(many)
    assert.equal(output.toString(), 'shown')
    assert.equal(request.session, 'last')
    // 60,000 requests (780 KB) in one chunk: one pass, about 20 ms. The earlier loop copied the rest of the chunk for
    // each one, and scheduled each: 18 s on the same machine.
    const flood = Buffer.from(desk('').repeat(60000) + 'end')
    const t0 = performance.now()
    const result = takeDeskMessages(flood)
    assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`)
    assert.equal(result.output.toString(), 'end')
})

test('the request a chunk gets is the last one whose key counts: a look-alike after it can\'t take its place', () => {
    const data = Buffer.from(`${desk('real', '', '', '', '', '', KEY)}${desk('keyless')}${desk('other', '', '', '', '', '', OTHER)}shown`)
    const { output, desk: request, ignored } = takeDeskMessages(data, (r: { key: string }) => r.key === KEY)
    assert.equal(output.toString(), 'shown')
    assert.equal(request.session, 'real')
    assert.equal(ignored, 2)
    // None that counts: none at all.
    assert.equal(takeDeskMessages(Buffer.from(desk('keyless') + desk('x', '', '', '', '', '', OTHER)), () => false).desk, null)
})

test('a terminal\'s requests: only with a known key, one per cooldown, however many chunks bring them', () => {
    let now = 0
    const warnings: string[] = []
    const looked: string[] = []
    const requests = new DeskRequests((key: string) => { looked.push(key); return key === KEY }, 2000, () => now, (m: string) => warnings.push(m))
    // Look-alikes, chunk after chunk (a log being followed, say), for 5 s: nothing goes further, and the developer
    // console hears of them once per cooldown, not once per chunk.
    for (let i = 0; i < 1000; i++, now += 5) {
        const { output, desk: request, probes } = requests.take(Buffer.from(`line ${i}\n${desk('a')}${desk('b', '', '', '', '', '', OTHER).repeat(3)}\x1b]7777;probe;p${i}\x07`))
        assert.equal(output.toString(), `line ${i}\n`)
        assert.equal(request, null)
        assert.deepEqual(probes, [`p${i}`])
    }
    assert.equal(warnings.length, 3)
    assert.match(warnings[0], /^desk: ignored 4 requests without a key/)
    // The key is looked up once per chunk, not once per request: a flood repeats one.
    assert.equal(looked.length, 1000)

    // The real one, among look-alikes, in the same chunk: let through; then nothing for the cooldown, whatever comes.
    now = 10000
    assert.equal(requests.take(Buffer.from(desk('real', '', '', '', '', '', KEY) + desk('fake'))).desk.session, 'real')
    let through = 0
    for (let i = 0; i < 50; i++, now += 100) {
        through += requests.take(Buffer.from(desk('again', '', '', '', '', '', KEY))).desk ? 1 : 0
    }
    // 5 s of a request every 100 ms after the first: at 12000 and 14000.
    assert.equal(through, 2)
})

test('a flood that alternates between keys looks each of them up once per chunk, and keeps only a few', () => {
    const looked: string[] = []
    const requests = new DeskRequests((key: string) => { looked.push(key); return false }, 2000, () => 0, () => undefined)
    // Two keys no host gave, in turn, 1,000 times each (every request is looked at, the last first, as none counts):
    // one lookup each, where a change of key was a lookup before.
    const THIRD = 'abcdefabcdefabcdefabcdefabcdefab'
    const alternating = Buffer.from((desk('a', '', '', '', '', '', OTHER) + desk('b', '', '', '', '', '', THIRD)).repeat(1000))
    const { desk: request } = requests.take(alternating)
    assert.equal(request, null)
    assert.deepEqual([...looked].sort(), [OTHER, THIRD].sort())
    // The next chunk looks them up again: what is kept is the chunk's alone.
    looked.length = 0
    requests.take(alternating)
    assert.equal(looked.length, 2)
    // A flood of different keys costs a lookup each, which nothing kept could save, and only a few are kept: the same
    // keys again look up the ones past those again.
    looked.length = 0
    const keys = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(32, '0'))
    requests.take(Buffer.from([...keys, ...keys].map(key => desk('x', '', '', '', '', '', key)).join('')))
    assert.equal(new Set(looked).size, 200)
    assert.ok(looked.length > 200 && looked.length < 400, `${looked.length} lookups`)
})

test('floods and oversized requests in one chunk cost about their length', () => {
    let looked = 0
    const requests = new DeskRequests(() => { looked++; return false }, 2000, () => 0, () => undefined)
    // 60,000 requests with a key no host gave (2.6 MB), 60,000 probes, and one request of a megabyte.
    const flood = Buffer.from(desk('', '', '', '', '', '', OTHER).repeat(60000) + '\x1b]7777;probe;x\x07'.repeat(60000) +
        desk('', '', '/'.repeat(1 << 20), '', '', '', OTHER) + 'end')
    const t0 = performance.now()
    const { output, desk: request, probes } = requests.take(flood)
    assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`)
    assert.equal(output.toString(), 'end')
    assert.equal(request, null)
    assert.equal(probes.length, 60000)
    assert.equal(looked, 1)
})

test('one request at a time per pane, then none for the cooldown', async () => {
    let now = 1000
    const gate = new DeskGate(2000, () => now)
    let release!: () => void
    const ran: string[] = []
    const first = gate.run(() => new Promise<void>(resolve => { ran.push('first'); release = resolve }))
    assert.equal(await gate.run(async () => { ran.push('while busy') }), false)
    release()
    assert.equal(await first, true)
    now += 1999
    assert.equal(await gate.run(async () => { ran.push('cooling down') }), false)
    now += 1
    assert.equal(await gate.run(async () => { ran.push('after') }), true)
    // A request that fails still ends its turn.
    now += 5000
    await assert.rejects(gate.run(async () => { throw new Error('host gone') }))
    now += 2000
    assert.equal(await gate.run(async () => { ran.push('again') }), true)
    assert.deepEqual(ran, ['first', 'after', 'again'])
})

test('the cooldowns go by a clock that only goes forward: the time of day set back doesn\'t keep desk quiet', async () => {
    // The time of day steps back an hour (set by hand, or corrected after sleep) right after a request.
    const realNow = Date.now
    let back = 0
    Date.now = () => realNow() - back
    try {
        const requests = new DeskRequests((key: string) => key === KEY, 20, undefined, () => undefined)
        const gate = new DeskGate(20)
        const chunk = () => Buffer.from(desk('ab12cd34', '', '/tmp', 'native', '', 'host', KEY))
        assert.ok(requests.take(chunk()).desk)
        assert.equal(await gate.run(async () => { }), true)
        back = 3600 * 1000
        await new Promise(resolve => setTimeout(resolve, 40))
        assert.ok(requests.take(chunk()).desk, 'a request after the cooldown, the clock set back meanwhile')
        assert.equal(await gate.run(async () => { }), true)
    } finally {
        Date.now = realNow
    }
})

test('a probe counts as the script prints one: the prefix it was given, a dash, and the number of an ssh', async () => {
    const pane = {}
    const prefix = 'trdabcd1234'
    const { ids } = await probesIn(pane, prefix, async () => {
        for (const id of [`${prefix}-1`, `${prefix}-999`, `${prefix}-0`, `${prefix}-01`, `${prefix}-1000`, `${prefix}-2x`, `${prefix}-`,
            `${prefix}3`, `${prefix}x-4`, `trdother-5`, `${prefix}-6\n`, `${prefix}-７`]) {
            probeArrived(id, pane)
        }
        // Another pane's, whatever it says.
        probeArrived(`${prefix}-7`, {})
    }, 0)
    assert.deepEqual([...ids], [`${prefix}-1`, `${prefix}-999`])
})

test('a host that floods a pane with probes while the plugin looks for an ssh there has a few of them kept, not all', async () => {
    // The host is given the prefix (in the script it runs, see targets.ts), and decides how long its answer takes, up
    // to a minute, and what its terminals print meanwhile: here a million probes, each with that prefix and a number of
    // its own, 30 MB of the pane's output, in chunks of 64 KB as an SSH channel brings them.
    const requests = new DeskRequests(() => false, 2000, () => 0, () => undefined)
    const pane = {}
    const prefix = 'trdabcd1234'
    let answer!: (output: string) => void
    const looking = probesIn(pane, prefix, () => new Promise<string>(resolve => { answer = resolve }), 0)
    gc()
    const before = process.memoryUsage().heapUsed
    const count = 1_000_000
    for (let n = 0; n < count;) {
        const probes: string[] = []
        for (let size = 0; size < 64 * 1024 && n < count; n++) {
            probes.push(`\x1b]7777;probe;${prefix}-${n}\x07`)
            size += probes[probes.length - 1].length
        }
        requests.take(Buffer.from(probes.join(''))).probes.forEach((id: string) => probeArrived(id, pane))
    }
    gc()
    const grown = process.memoryUsage().heapUsed - before
    assert.ok(grown < 4 * 1024 * 1024, `${Math.round(grown / 1024 / 1024)} MB kept while the host's command ran`)
    answer('')
    const { ids } = await looking
    assert.equal(ids.size, MAX_PROBES)
    assert.ok(ids.has(`${prefix}-1`))
})
