// Real TLS-only drawing peer; enabled by the native CI build, with no appliance or real credentials.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { selfSigned } from './support/certificates.js'
const require = createRequire(import.meta.url)
const { FreeRDPProcess, nativeHelperPath, helperEnvironment } = require('../../dist/freerdp.js')
const peerPath = join(process.cwd(), 'native-artifacts', `tabby-pam-test-server${process.platform === 'win32' ? '.exe' : ''}`)
const available = existsSync(peerPath)
const cert = available ? selfSigned('pam.test') : null
const scratch = available ? mkdtempSync(join(tmpdir(), 'trd-pam-')) : ''
after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })
if (cert) { writeFileSync(join(scratch, 'cert.pem'), cert.cert); writeFileSync(join(scratch, 'key.pem'), cert.key, { mode: 0o600 }) }
const cases = [
    ...['opaque', 'transparent', 'partial', 'no-alpha', 'black'].map(mode => ({ mode, announced: true, bitmap: true, relaxed: false })),
    { mode: 'transparent', announced: false, bitmap: true, relaxed: false },
    { mode: 'transparent', announced: false, bitmap: true, relaxed: true },
    { mode: 'transparent', announced: true, bitmap: false, relaxed: false },
    { mode: 'transparent', announced: false, bitmap: false, relaxed: true },
]
for (const runtime of ['native', 'wasm']) for (const item of cases) {
    test(`PAM ${runtime}: ${JSON.stringify(item)}`, { skip: !available, timeout: 20000 }, async t => {
        assert.ok(cert, 'The PAM build job requires openssl for its synthetic certificate')
        const peer = spawn(peerPath, [join(scratch, 'cert.pem'), join(scratch, 'key.pem'), item.mode, '127.0.0.1', item.announced ? 'announced' : 'unannounced'], {
            env: { ...helperEnvironment(), PATH: dirname(nativeHelperPath()) + delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        })
        const client = new FreeRDPProcess(runtime)
        t.after(() => { client.shutdown(); peer.kill() })
        const events: any[] = []
        const port = await new Promise<number>((resolve, reject) => {
            let pending = ''
            const timer = setTimeout(() => reject(new Error('PAM peer did not listen')), 8000)
            peer.once('error', error => { clearTimeout(timer); reject(error) })
            peer.stdout.on('data', chunk => {
                pending += chunk.toString()
                while (pending.includes('\n')) {
                    const at = pending.indexOf('\n'), line = pending.slice(0, at); pending = pending.slice(at + 1)
                    let event; try { event = JSON.parse(line) } catch { continue }
                    events.push(event)
                    if (event.event === 'listening') { clearTimeout(timer); resolve(event.port) }
                }
            })
        })
        let ended = false, nla = 0, certificates = 0
        const colors: number[][] = []
        client.run().then(() => { ended = true }, () => { ended = true })
        await client.connect({ host: 'pam.test', username: 'pam-user[CORP\\vault-account@target-vm]', password: 'synthetic-only', domain: '',
            width: 800, height: 600, pipeline: false, autologon: true, bitmapCache: item.bitmap, relaxOrderChecks: item.relaxed, authorities: [],
            withoutNla: () => { nla++ }, certificate: (fp: string) => { certificates++; assert.equal(fp, new X509Certificate(cert.cert).fingerprint256) },
            open: () => new Promise((resolve, reject) => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => resolve(socket)); socket.once('error', reject) }),
            frame: (frame: any) => {
                for (const [i, x] of [16, 48, 80, 112].entries()) if (x >= frame.x && x < frame.x + frame.width && 16 >= frame.y && 16 < frame.y + frame.height) {
                    const at = ((16 - frame.y) * frame.width + x - frame.x) * 4
                    colors[i] = [...frame.rgba.slice(at, at + 3)]
                }
            },
        })
        await delay(2300)
        assert.equal(nla, 1); assert.equal(certificates, 1)
        assert.ok(events.some(e => e.event === 'identity' && e.bracketedUsernamePreserved))
        assert.ok(events.some(e => e.event === 'capabilities' && e.announced === item.announced))
        const accepted = item.relaxed || item.bitmap && item.announced
        assert.equal(ended, !accepted)
        if (accepted) assert.deepEqual(colors, item.mode === 'black' ? Array(4).fill([0, 0, 0]) : [[224, 64, 224], [32, 192, 32], [96, 224, 96], [192, 32, 192]])
    })
}
