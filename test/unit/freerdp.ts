import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { once } from 'node:events'
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createSecureContext, TLSSocket } from 'node:tls'
import { selfSigned } from './support/certificates.js'

const require = createRequire(import.meta.url)
const { FreeRDPFrames, ipcFrame, numbers, freeRDPStart, decodeNativeFrame, freeRDPRelay, FreeRDPProcess, FreeRDPError, nativeHelperPath, helperEnvironment, freeRDPAuthorities } = require('../../dist/freerdp.js')
const { nativeKey } = require('../../dist/freerdpView.js')
const { ownRDPClient, rdpClient } = require('../../dist/rdpClient.js')
const { specOf, sessionKey } = require('../../dist/desktops.js')

test('distributed native helpers retain their recorded source, artifact hashes and license notices', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const binaries = join(root, 'native/bin')
    const hash = (name: string) => createHash('sha256').update(readFileSync(join(root, name))).digest('hex')
    // Source-only development checkouts may not have built a helper yet.
    if (!existsSync(binaries)) return
    for (const platform of readdirSync(binaries)) {
        const dir = join(binaries, platform)
        const record = JSON.parse(readFileSync(join(dir, 'BUILD.json'), 'utf8'))
        assert.deepEqual(record.source, JSON.parse(readFileSync(join(root, 'native/freerdp-source.json'), 'utf8')))
        assert.equal(platform, `${record.platform}-${record.arch}`)
        for (const [source, expected] of Object.entries(record.buildSources)) assert.equal(hash(source), expected, `${source} changed; rebuild FreeRDP`)
        for (const file of record.files) {
            assert.equal(hash(`native/bin/${platform}/${file.path}`), file.sha256, `${platform}/${file.path} changed since build`)
        }
        const listed = record.files.map((f: { path: string }) => f.path).sort()
        const files = (dir: string, prefix = ''): string[] => readdirSync(dir).flatMap(name => {
            const path = join(dir, name), stat = lstatSync(path)
            assert.ok(!stat.isSymbolicLink(), `native bundle cannot contain a link: ${path}`)
            return stat.isDirectory() ? files(path, `${prefix}${name}/`) : [`${prefix}${name}`]
        })
        assert.deepEqual(files(dir).filter(name => name !== 'BUILD.json').sort(), listed)
        for (const license of ['FreeRDP-LICENSE', 'FreeRDP-NOTICE', 'OpenSSL-LICENSE', 'Unicode-NOTICE', 'NOTICE']) assert.ok(listed.includes(`licenses/${license}`))
        assert.ok(listed.includes(`tabby-freerdp${record.platform === 'win32' ? '.exe' : ''}`))
    }
})

test('each platform package.json names for a FreeRDP package has a build in native/bin, and each build is named', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    // Source-only development checkouts may not have built a helper yet.
    if (!existsSync(join(root, 'native/bin'))) return
    const expected = process.env.TRD_SINGLE_NATIVE_BUILD === '1' ? [`${process.platform}-${process.arch}`] : pkg.tabbyRdp.freerdpPlatforms
    assert.deepEqual([...expected].sort(), readdirSync(join(root, 'native/bin')).filter(name => !name.startsWith('.')).sort(),
        'scripts/pack.mjs makes a package per platform named, from its build')
})

test('the helper is a build in native/bin, or else the one in its platform\'s package, named as the packaging names it', async t => {
    const { freeRDPPackage, helperPath } = require('../../dist/freerdp.js')
    const scripts = await import('../../scripts/package-metadata.mjs')
    assert.equal(freeRDPPackage('linux-x64'), scripts.freeRDPPackage('linux-x64'))
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
    const scratch = mkdtempSync(join(require('node:os').tmpdir(), 'trd-helper-'))
    t.after(() => rmSync(scratch, { recursive: true, force: true }))
    const own = join(scratch, 'plugin/native/bin/linux-x64/tabby-freerdp')
    const installed = join(scratch, 'node_modules/@tabby-rdp/freerdp-linux-x64')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), '{}')
    const asked: string[] = []
    const resolve = (id: string) => {
        asked.push(id)
        if (id !== '@tabby-rdp/freerdp-linux-x64/package.json') throw new Error(`Cannot find module '${id}'`)
        return join(installed, 'package.json')
    }
    // The plugin as npm installs it: no native/bin, the platform's package beside it.
    assert.equal(helperPath('linux-x64', own, resolve), join(installed, 'tabby-freerdp'))
    assert.deepEqual(asked, ['@tabby-rdp/freerdp-linux-x64/package.json'])
    // Neither: the path in native/bin, which hasFreeRDP finds missing.
    assert.equal(helperPath('linux-x64', own, () => { throw new Error('Cannot find module') }), own)
    // A build of one's own wins.
    mkdirSync(join(scratch, 'plugin/native/bin/linux-x64'), { recursive: true })
    writeFileSync(own, '')
    assert.equal(helperPath('linux-x64', own, resolve), own)
})

test('client choice defaults to IronRDP; invalid config never runs an arbitrary backend', () => {
    for (const value of [undefined, null, '', 'auto', 'FreeRDP', 'toString', {}, { toString () { throw new Error('not text') } }]) {
        assert.equal(rdpClient(value), 'ironrdp')
        assert.equal(ownRDPClient(value), undefined)
    }
    assert.equal(rdpClient('freerdp'), 'freerdp')
    const a = specOf({ host: 'pc', client: 'ironrdp' }), b = specOf({ host: 'pc', client: 'freerdp' })
    assert.equal(b.client, 'freerdp')
    assert.equal(sessionKey('rdp', a), sessionKey('rdp', b), 'client changes do not create new credentials/certificate identities')
})

test('the helper receives OS paths and locale without inheriting application/test credentials', t => {
    const before = process.env.TRD_TEST_DIRECT_PASSWORD
    t.after(() => { if (before === undefined) delete process.env.TRD_TEST_DIRECT_PASSWORD; else process.env.TRD_TEST_DIRECT_PASSWORD = before })
    process.env.TRD_TEST_DIRECT_PASSWORD = 'test-only-secret'
    const env = helperEnvironment()
    assert.equal(env.TRD_TEST_DIRECT_PASSWORD, undefined)
    assert.equal(env.PATH, process.env.PATH)
    assert.equal(env.OPENSSL_MODULES, require('node:path').dirname(nativeHelperPath()))
    assert.ok(!Object.keys(env).some(key => /PASSWORD|TOKEN|SECRET|API_KEY/.test(key)))
})

test('IPC handles split headers/bodies, coalesced frames and rejects oversized frames before allocating them', () => {
    const stream = Buffer.concat([ipcFrame('D', numbers(1280, 720)), ipcFrame('N'), ipcFrame('X', numbers(0, 0))])
    const result: unknown[] = []
    const decoder = new FreeRDPFrames()
    for (const byte of stream) decoder.push(Buffer.from([byte]), (type: string, data: Buffer) => result.push([type, data.toString('hex')]))
    assert.deepEqual(result, [['D', numbers(1280, 720).toString('hex')], ['N', ''], ['X', numbers(0, 0).toString('hex')]])
    assert.throws(() => decoder.push(Buffer.from([70, 127, 255, 255, 255]), () => {}), /oversized/)
})

test('IPC start keeps glyph caching, bitmap caching and relaxed checks independent, all off by default', () => {
    const options = { host: 'pc', username: 'user', password: 'pass', domain: '', width: 800, height: 600, pipeline: false }
    const relay = { port: 1234, token: 'a'.repeat(64) }
    const strict = freeRDPStart(options, relay)
    assert.deepEqual(strict.subarray(-32), numbers(1234, 800, 600, 0, 0, 0, 0, 0))
    for (const glyphCache of [false, true]) {
        for (const bitmapCache of [false, true]) {
            for (const relaxOrderChecks of [false, true]) {
                const start = freeRDPStart({ ...options, glyphCache, bitmapCache, relaxOrderChecks }, relay)
                assert.deepEqual(start.subarray(-32), numbers(1234, 800, 600, 0, 0, +relaxOrderChecks, +glyphCache, +bitmapCache))
                assert.deepEqual(strict.subarray(0, -32), start.subarray(0, -32))
            }
        }
    }
})

test('certificate stores can exceed one IPC frame while retaining a bounded total', () => {
    const text = 'certificate\n'.repeat(100000)
    assert.equal(freeRDPAuthorities([text]).toString(), text)
    assert.throws(() => freeRDPAuthorities(['x'.repeat(16 * 1024 * 1024 + 1)]), /authority store exceeds/)
})

test('native display updates must fit both the tile and the bounded remote screen', () => {
    const frame = Buffer.concat([numbers(10, 20, 2, 1, 800, 600), Buffer.from([255, 0, 0, 255, 0, 255, 0, 255])])
    const decoded = decodeNativeFrame(frame)
    assert.deepEqual([decoded.x, decoded.y, decoded.width, decoded.screenWidth, ...decoded.rgba], [10, 20, 2, 800, 255, 0, 0, 255, 0, 255, 0, 255])
    for (const data of [Buffer.alloc(0), frame.subarray(0, -1), Buffer.concat([numbers(799, 0, 2, 1, 800, 600), Buffer.alloc(8)]),
        Buffer.concat([numbers(0, 0, 1, 1, 0xffffffff, 600), Buffer.alloc(4)])]) assert.throws(() => decodeNativeFrame(data), /display update/)
})

test('native keys retain physical shortcuts and extended scan codes; Unicode supports non-BMP characters', () => {
    const key = { code: 'KeyA', key: 'ä', ctrlKey: false, altKey: false, metaKey: false }
    assert.deepEqual(nativeKey(key, false), { scan: 0x1e, text: '' })
    assert.deepEqual(nativeKey(key, true), { scan: 0, text: 'ä' })
    assert.deepEqual(nativeKey({ ...key, key: '😀' }, true), { scan: 0, text: '😀' })
    assert.deepEqual(nativeKey({ ...key, ctrlKey: true }, true), { scan: 0x1e, text: '' })
    assert.deepEqual(nativeKey({ ...key, code: 'Delete', key: 'Delete' }, true), { scan: 0x153, text: '' })
    assert.equal(nativeKey({ ...key, code: 'Unknown', key: 'Unidentified' }, true), null)
})

test('Unicode typing preserves synthetic held-modifier shortcuts and local AltGr characters', () => {
    const key = { code: 'KeyQ', key: '@', ctrlKey: false, altKey: false, metaKey: false }
    for (const held of ['MetaLeft', 'MetaRight', 'ControlLeft', 'AltLeft', 'AltRight']) {
        assert.deepEqual(nativeKey(key, true, [held]), { scan: 0x10, text: '' }, held)
    }
    const altGr = { ...key, ctrlKey: true, altKey: true, getModifierState: (name: string) => name === 'AltGraph' }
    assert.deepEqual(nativeKey(altGr, true, ['ControlLeft', 'AltRight']), { scan: 0, text: '@' })
    assert.deepEqual(nativeKey({ ...altGr, key: '€' }, true), { scan: 0, text: '€' })
    assert.deepEqual(nativeKey(altGr, true, ['MetaLeft', 'AltRight']), { scan: 0x10, text: '' }, 'Super remains a shortcut even with AltGr')
    assert.deepEqual(nativeKey({ ...altGr, getModifierState: () => false }, true), { scan: 0x10, text: '' }, 'Ctrl+Alt remains a shortcut')
})

test('physical input covers JIS, ABNT2, Korean, numpad and extended function keys', () => {
    const codes = { IntlRo: 0x73, IntlYen: 0x7d, KanaMode: 0x70, Convert: 0x79, NonConvert: 0x7b,
        Lang1: 0x72, Lang2: 0x71, NumpadEqual: 0x59, NumpadComma: 0x7e, Pause: 0x146 }
    for (let i = 13; i <= 24; i++) Object.assign(codes, { [`F${i}`]: 0x64 + i - 13 })
    for (const [code, scan] of Object.entries(codes)) {
        assert.deepEqual(nativeKey({ code, key: 'Unidentified', ctrlKey: false, altKey: false, metaKey: false }, false), { scan, text: '' }, code)
    }
})

test('synthetic Super shortcuts use physical down/up pairs even after the modifier is released', () => {
    const { FreeRDPView } = require('../../dist/freerdpView.js')
    const view = Object.create(FreeRDPView.prototype), packets: Buffer[] = []
    Object.assign(view, { unicode: true, pressed: new Map(), native: { send: (type: string, data: Buffer) => { assert.equal(type, 'K'); packets.push(data) } } })
    const send = (type: string, code: string, key: string) => view.sendKeyboardEvent({ type, code, key, ctrlKey: false, altKey: false, metaKey: false, preventDefault () {} })
    send('keydown', 'MetaLeft', 'Meta'); send('keydown', 'KeyR', 'R')
    send('keyup', 'MetaLeft', 'Meta'); send('keyup', 'KeyR', 'r')
    assert.deepEqual(packets.map(p => [...Array(3)].map((_, i) => p.readUInt32BE(i * 4))), [[0, 0x15b, 0], [0, 0x13, 0], [0x8000, 0x15b, 0], [0x8000, 0x13, 0]])
})

test('pointer chords, cancellation and view only release every held remote mouse button', () => {
    const { FreeRDPView } = require('../../dist/freerdpView.js')
    const view = Object.create(FreeRDPView.prototype), flags: number[] = []
    Object.assign(view, { visible: true, readOnly: false, buttons: 0, pointerId: null, pointerPosition: { x: 0, y: 0 }, pressed: new Map(),
        canvas: { width: 800, height: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
        native: { send: (type: string, data: Buffer) => { assert.equal(type, 'M'); flags.push(data.readUInt32BE(0)) } } })
    const move = (type: string, buttons: number) => { if (type === 'pointerdown') view.pointerId = 1; view.mouse({ type, buttons, pointerId: 1, clientX: 20, clientY: 30 }) }
    move('pointerdown', 1); move('pointermove', 3); move('pointermove', 2); move('pointerup', 0)
    assert.deepEqual(flags, [0x9000, 0xa000, 0x0800, 0x1000, 0x0800, 0x2000])
    flags.length = 0
    move('pointerdown', 5); view.releaseButtons()
    assert.deepEqual(flags, [0x9000, 0xc000, 0x1000, 0x4000], 'cancel releases both buttons')
    flags.length = 0
    move('pointerdown', 1); view.setReadOnly(true); move('pointermove', 1)
    for (const type of ['keydown', 'keyup']) view.sendKeyboardEvent({ type, code: 'KeyA', key: 'a', preventDefault () {} })
    assert.deepEqual(flags, [0x9000, 0x1000], 'view only releases the captured drag and ignores later moves')
    view.setReadOnly(false); move('pointerdown', 2); view.releaseInput()
    assert.deepEqual(flags.slice(-2), [0xa000, 0x2000], 'blur releases pointer state as well as keys')
    flags.length = 0
    move('pointermove', 1); move('pointerup', 0)
    assert.deepEqual(flags, [0x0800], 'a drag started outside the canvas only moves the remote pointer')
})

test('a missing Windows runtime has actionable startup guidance for signed and unsigned exit codes', () => {
    const { helperStopped } = require('../../dist/freerdp.js')
    for (const code of [0xc0000135, -1073741515]) assert.match(helperStopped(code, null, 'win32').message, /Visual C\+\+.*Redistributable/)
    assert.match(helperStopped(2, null, 'win32').message, /stopped \(2\)/)
    assert.match(helperStopped(null, 'SIGKILL', 'linux').message, /SIGKILL/)
})

test('only explicit credential rejection triggers a saved-password retry', () => {
    assert.equal(new FreeRDPError(0x20014).kind(), 2)
    assert.equal(new FreeRDPError(0x20015).kind(), 2)
    for (const code of [0x20009, 0x20008, 0x2000d]) assert.equal(new FreeRDPError(code).kind(), undefined)
})

test('native input waits until authentication has finished without delaying security decisions', () => {
    const native = new FreeRDPProcess(), writes: Buffer[] = []
    native.child = { stdin: { writableLength: 0, write: (data: Buffer) => writes.push(data) } }
    for (const type of ['M', 'K', 'R', 'N', 'C']) native.send(type, Buffer.from([1]))
    assert.deepEqual(writes.map(data => String.fromCharCode(data[0])), ['N', 'C'])
    native.receive('D', numbers(800, 600), {})
    for (const type of ['M', 'K', 'R']) native.send(type, Buffer.alloc(12))
    assert.deepEqual(writes.map(data => String.fromCharCode(data[0])), ['N', 'C', 'M', 'K', 'R'])
})

test('server-directed session endings do not become reconnectable transport failures', async () => {
    for (const reason of [0, 1, 2, 3, 4, 5, 11, 12]) {
        const native = new FreeRDPProcess()
        native.receive('D', numbers(800, 600), {})
        native.receive('X', numbers(reason ? 0x10000 | reason : 0, reason), {})
        const end = await native.run()
        assert.ok(end.reason())
    }
    for (const code of [0x2000d, 0x10006, 0x10007]) {
        const native = new FreeRDPProcess()
        native.receive('D', numbers(800, 600), {})
        native.receive('X', numbers(code, 0), {})
        await assert.rejects(native.run(), /FreeRDP connection failed/)
    }
})

test('the native relay authenticates before opening any remote stream and closes relayed sockets', async t => {
    const echo = createServer(socket => { socket.on('error', () => {}); socket.pipe(socket) })
    echo.listen(0, '127.0.0.1'); await once(echo, 'listening')
    let opens = 0
    const relay = await freeRDPRelay(async () => { opens++; const socket = connect((echo.address() as any).port, '127.0.0.1'); await once(socket, 'connect'); return socket })
    t.after(() => { relay.close(); echo.close() })
    const wrong = connect(relay.port, '127.0.0.1')
    wrong.on('error', () => {}); wrong.write(Buffer.alloc(64, 48)); await once(wrong, 'close')
    assert.equal(opens, 0)
    const right = connect(relay.port, '127.0.0.1')
    right.on('error', () => {})
    // Authentication can share the first packet with RDP bytes and arrive in multiple chunks.
    right.write(relay.token.slice(0, 30)); right.write(relay.token.slice(30) + 'hello')
    const [data] = await once(right, 'data')
    assert.equal(data.toString(), 'hello')
    assert.equal(opens, 1)
    assert.deepEqual(relay.stats, { bytesIn: 5, bytesOut: 5 })
    const closed = once(right, 'close'); relay.close(); await closed
})

const native = existsSync(nativeHelperPath())

test('a refused SSH/gateway transport preserves its reason for the connection log', async t => {
    const relay = await freeRDPRelay(async () => { throw new Error('SSH forwarding is disabled for this account') })
    t.after(relay.close)
    const socket = connect(relay.port, '127.0.0.1')
    socket.on('error', () => {})
    socket.write(relay.token)
    await once(socket, 'close')
    assert.equal(relay.failure?.message, 'SSH forwarding is disabled for this account')
})
for (const mode of ['without-nla', 'certificate-tls', 'certificate-nla', 'trusted-certificate', 'wrong-name', 'large-authorities'] as const) {
    test(`native helper refuses ${mode} before sending credentials and can be cancelled`, { skip: !native, timeout: 12000 }, async t => {
        const cert = selfSigned('native.test', 'subjectAltName=DNS:native.test')
        if (!cert) { t.skip('openssl is unavailable'); return }
        const sockets = new Set<any>()
        const requests: Buffer[] = [], application: Buffer[] = []
        const server = createServer(socket => {
            sockets.add(socket); socket.on('error', () => {})
            let request = Buffer.alloc(0)
            const receive = (data: Buffer) => {
                request = Buffer.concat([request, data])
                if (request.length < 4 || request.length < request.readUInt16BE(2)) return
                socket.removeListener('data', receive)
                requests.push(request)
                const response = Buffer.from('030000130ed000000000000200080001000000', 'hex')
                if (mode === 'certificate-nla') response[15] = 2
                socket.write(response)
                const tls = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key: cert.key, cert: cert.cert }) })
                sockets.add(tls); tls.on('error', () => {})
                tls.on('data', data => application.push(Buffer.from(data)))
            }
            socket.on('data', receive)
        })
        server.listen(0, '127.0.0.1'); await once(server, 'listening')
        const process = new FreeRDPProcess()
        t.after(() => { process.shutdown(); for (const socket of sockets) socket.destroy(); server.close() })
        let checked = false, withoutNla = 0, observedValid: boolean | undefined
        await assert.rejects(process.connect({
            host: mode === 'wrong-name' ? 'other.test' : 'native.test', username: 'private-test-username', password: 'private-test-password', domain: 'PRIVATE', width: 800, height: 600, pipeline: false,
            ...mode === 'trusted-certificate' || mode === 'wrong-name' || mode === 'large-authorities' ? { authorities: Array(mode === 'large-authorities' ? Math.ceil(1200000 / cert.cert.length) : 1).fill(cert.cert.toString()) } : {},
            open: async () => {
                const socket = connect((server.address() as any).port, '127.0.0.1'); await once(socket, 'connect')
                // Pointer/key activity while connecting must never be consumed as the certificate/NLA answer.
                process.send('M', numbers(0x0800, 10, 20)); process.send('K', numbers(0, 0x1e, 0))
                return socket
            },
            certificate: (_fp: string, valid: boolean) => { checked = true; observedValid = valid; throw new Error('reject test certificate') },
            withoutNla: () => { withoutNla++; if (mode === 'without-nla') throw new Error('reject TLS sign-in') },
            frame: () => { throw new Error('not connected') },
        }), /FreeRDP/)
        assert.equal(checked, mode !== 'without-nla')
        if (checked) assert.equal(observedValid, mode === 'trusted-certificate' || mode === 'large-authorities', 'trust anchors and the destination name are both verified')
        assert.equal(withoutNla, mode === 'certificate-nla' ? 0 : 1)
        assert.ok(requests.length)
        assert.ok(requests.every(r => !r.includes(Buffer.from('private-test-username')) && !r.includes(Buffer.from('PRIVATE'))))
        assert.equal(application.length, 0, 'no CredSSP or RDP credentials reach the rejected peer')
    })
}

/** A synthetic NTLMv2 challenge with sealing and both computer/domain names required by Windows SSPI. */
function credsspChallenge (): Buffer {
    const av = (id: number, value: Buffer) => { const h = Buffer.alloc(4); h.writeUInt16LE(id); h.writeUInt16LE(value.length, 2); return Buffer.concat([h, value]) }
    const timestamp = Buffer.alloc(8); timestamp.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n)
    const u16 = (text: string) => Buffer.from(text, 'utf16le')
    const info = Buffer.concat([av(2, u16('PRIVATE')), av(1, u16('NATIVE')), av(4, u16('native.test')), av(3, u16('native.test')),
        av(5, u16('native.test')), av(6, Buffer.alloc(4)), av(7, timestamp), av(0, Buffer.alloc(0))])
    const target = Buffer.from('GW', 'utf16le'), message = Buffer.alloc(56)
    message.write('NTLMSSP\0', 'latin1'); message.writeUInt32LE(2, 8); message.writeUInt16LE(target.length, 12); message.writeUInt16LE(target.length, 14); message.writeUInt32LE(56, 16)
    message.writeUInt32LE(0xe28a8235, 20); Buffer.from('0123456789abcdef', 'hex').copy(message, 24)
    message.writeUInt16LE(info.length, 40); message.writeUInt16LE(info.length, 42); message.writeUInt32LE(56 + target.length, 44)
    Buffer.from('0601b11d0000000f', 'hex').copy(message, 48)
    return Buffer.concat([message, target, info])
}
function der (tag: number, ...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts)
    assert.ok(body.length < 256)
    return Buffer.concat([Buffer.from(body.length < 128 ? [tag, body.length] : [tag, 0x81, body.length]), body])
}
for (const version of [0, 2, 3, 4, 5, 6, -1, 'overflow', 'missing'] as const) {
    test(`native CredSSP policy ${version}: authentication requires nonce-bound version 5 or newer`, { skip: !native, timeout: 12000 }, async t => {
        const cert = selfSigned('native.test', 'subjectAltName=DNS:native.test')
        if (!cert) { t.skip('openssl is unavailable'); return }
        const sockets = new Set<any>(), application: Buffer[] = []
        let challenged = false, initial = Buffer.alloc(0)
        const allowed = typeof version === 'number' && version >= 5
        const server = createServer(socket => {
            sockets.add(socket); socket.on('error', () => {})
            let request = Buffer.alloc(0)
            const receive = (data: Buffer) => {
                request = Buffer.concat([request, data])
                if (request.length < 4 || request.length < request.readUInt16BE(2)) return
                socket.removeListener('data', receive)
                socket.write(Buffer.from('030000130ed000000000000200080002000000', 'hex'))
                const tls = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext({ key: cert.key, cert: cert.cert }) })
                sockets.add(tls); tls.on('error', () => {})
                tls.on('data', data => {
                    if (challenged) {
                        application.push(Buffer.from(data))
                        const reply = Buffer.concat(application), at = reply.indexOf(Buffer.from('NTLMSSP\0', 'latin1'))
                        if (at >= 0 && reply.length >= at + 12) tls.destroy()
                        return
                    }
                    initial = Buffer.concat([initial, Buffer.from(data)])
                    const ntlm = initial.indexOf(Buffer.from('NTLMSSP\0', 'latin1'))
                    if (ntlm < 0 || initial.length < ntlm + 12) return
                    assert.equal(initial.readUInt32LE(ntlm + 8), 1)
                    challenged = true
                    const value = version === 'overflow' ? Buffer.from('0100000004', 'hex') : Buffer.from([typeof version === 'number' ? version & 255 : 6])
                    const challenge = credsspChallenge()
                    // Windows SSPI negotiates SPNEGO; WinPR's NTLM client sends a raw NTLM token. Reply in kind.
                    const spnego = initial.includes(Buffer.from('06062b0601050502', 'hex'))
                    const token = spnego ? der(0xa1, der(0x30, der(0xa0, der(0x0a, Buffer.from([1]))),
                        der(0xa1, Buffer.from('060a2b06010401823702020a', 'hex')), der(0xa2, der(0x04, challenge)))) : challenge
                    const reply = der(0x30, der(version === 'missing' ? 0xa2 : 0xa0, der(0x02, value)),
                        der(0xa1, der(0x30, der(0x30, der(0xa0, der(0x04, token))))))
                    // ReadPdu can return an incomplete read before it sees a whole TSRequest.
                    tls.write(reply.subarray(0, 3))
                    setTimeout(() => { if (!tls.destroyed) tls.write(reply.subarray(3)) }, 5)
                })
            }
            socket.on('data', receive)
        })
        server.listen(0, '127.0.0.1'); await once(server, 'listening')
        const client = new FreeRDPProcess()
        t.after(() => { client.shutdown(); for (const socket of sockets) socket.destroy(); server.close() })
        await assert.rejects(client.connect({
            host: 'native.test', username: 'private-test-username', password: 'private-test-password', domain: 'PRIVATE',
            width: 800, height: 600, pipeline: false, authorities: [cert.cert.toString()],
            open: async () => { const socket = connect((server.address() as any).port, '127.0.0.1'); await once(socket, 'connect'); return socket },
            certificate: () => {}, withoutNla: () => { throw new Error('NLA required') }, frame: () => { throw new Error('not connected') },
        }), /FreeRDP/)
        assert.ok(challenged, 'the synthetic peer reached the first CredSSP version decision')
        const reply = Buffer.concat(application), at = reply.indexOf(Buffer.from('NTLMSSP\0', 'latin1'))
        const authenticated = at >= 0 && reply.length >= at + 12 && reply.readUInt32LE(at + 8) === 3
        assert.equal(authenticated, allowed, allowed ? 'v5/v6 control must still reach NTLM authentication' : 'legacy/malformed versions must not receive NTLM AUTHENTICATE or public-key binding')
        if (!allowed) assert.equal(reply.length, 0, 'reject before any CredSSP authentication response')
    })
}
