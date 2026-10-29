// Frame pacing under motion: opens testufo.com in Microsoft Edge on a Windows desktop (kiosk mode, through Win+R)
// and measures, for twelve seconds, how many frames the server sends, how many the client shows, and where each
// frame's time goes with IronRDP (wire → H.264 decoder → pixels → canvas → acknowledgement), from the PDU trace.
// The numbers go to the output as TIME lines; the one check is that frames keep coming. Run it with each client
// (TRD_TEST_CLIENT=freerdp for the FreeRDP helper; TRD_FREERDP_PIPELINE=1 puts that on the graphics pipeline) and
// compare. Set TRD_TEST_DUMP for a picture of the page with its own frame-rate readout.
//
// The desktop: TRD_TEST_RDS or TRD_TEST_DIRECT (a Windows desktop with Edge), as the pdu-trace suite takes them.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { suite } from '../lib/harness.js'

const NAME = 'Frame pacing desktop (test)'
const CLIENT = process.env.TRD_TEST_CLIENT === 'freerdp' ? 'freerdp' : 'ironrdp'
const SECONDS = Number(process.env.TRD_TEST_FPS_SECONDS || 12)

await suite('fps', async t => {
    const { ev, check, sleep } = t
    const rds = process.env.TRD_TEST_RDS || ''
    const address = rds || process.env.TRD_TEST_DIRECT || ''
    const user = (rds ? process.env.TRD_TEST_RDS_USER : process.env.TRD_TEST_DIRECT_USER) || ''
    const password = (rds ? process.env.TRD_TEST_RDS_PASSWORD : process.env.TRD_TEST_DIRECT_PASSWORD) || ''
    if (!address || !user) {
        t.skip('a Windows desktop', 'set TRD_TEST_RDS or TRD_TEST_DIRECT (with their user and password)')
        return
    }
    const parts = /^\[?(.*?)\]?(?::(\d+))?$/.exec(address)!
    const host = parts[1]
    const port = Number(parts[2] || 3389)
    await ev(`Object.assign(H, {
        profiles () { return RD.injector.get(require('tabby-core').ProfilesService) },
        async openProfile (profile) {
            const before = new Set(H.panes())
            await H.inZone(() => H.profiles().openNewTabForProfile(profile))
            for (let i = 0; i < 40; i++) {
                const pane = H.panes().find(p => !before.has(p))
                if (pane) { H.opened.push(pane); return pane }
                await new Promise(r => setTimeout(r, 100))
            }
            return null
        },
        signin (p) { return !!H.overlay(p)?.querySelector('.trd-signin form') },
        submit (p, password) {
            const f = H.overlay(p).querySelector('.trd-signin form')
            f.querySelector('[name=password]').value = password
            f.requestSubmit()
        },
        connections (p) { return RD.desktop.logOf(p).filter(l => /^connected: /.test(l)).length },
        state (p, connections) {
            if (H.signin(p)) return 'form'
            const s = H.status(p)
            if (s && /can't verify/.test(s.text)) return 'question'
            if (s && /failed|ended|refused/i.test(s.text)) return 'failed: ' + s.text
            if (H.connections(p) > connections) return 'connected'
            return null
        },
        /** The counters a moment's sample needs. */
        sample (p) {
            const s = H.session(p)
            const stats = s?.proxy?.stats ?? s?.ui?.stats ?? null
            return { at: performance.now(), frames: s?.ui?.frameCount ?? null, bytesIn: stats?.bytesIn ?? null, events: s?.trace?.events.length ?? 0, h264: s?.h264 ? { ...s.h264.stats } : null }
        },
        traceSince (p, index) { return H.session(p)?.trace?.events.slice(index) ?? [] },
    })`)

    const key = `rdp#${host}:${port}`
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    const profilesBefore = await ev('return JSON.stringify(H.config.store.profiles ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.store.profiles = ${profilesBefore}; H.config.save() })`))
    await ev(`H.inZone(() => { const r = H.config.store.remoteDesktop; r.trustedCertificates = (r.trustedCertificates ?? []).filter(e => e?.desktop !== ${JSON.stringify(key)}); H.config.save() })`)
    await t.settings({ diagnosticLog: 'debug', resize: 'live', sharpness: 'standard', connectionStatus: true })
    const profile = { type: 'rdp', name: NAME, options: { host, port, kind: 'windows', username: user, via: '', client: CLIENT } }
    const advance = async (): Promise<string | null> => {
        const connections = await ev<number>('return H.connections(H.rdp)')
        for (let i = 0; i < 300; i++) {
            const state = await ev<string | null>(`return H.state(H.rdp, ${connections})`)
            if (state === 'form') { await ev(`H.submit(H.rdp, ${JSON.stringify(password)})`); await sleep(500); continue }
            if (state === 'question') { await ev(`H.inZone(() => H.clickStatus(H.rdp, 'Trust the certificate'))`); await sleep(500); continue }
            if (state) { return state }
            await sleep(200)
        }
        return null
    }
    check('a remote desktop tab opens', await ev(`H.rdp = await H.openProfile(${JSON.stringify(profile)}); return !!H.rdp`))
    await ev(`const el = H.rdp.element.nativeElement; el.style.flex = 'none'; el.style.width = '1280px'; el.style.height = '800px'`)
    const state = await advance()
    check('the desktop connects', state === 'connected', state)
    if (state !== 'connected') {
        return
    }
    await sleep(4000)

    // Edge in kiosk mode on the UFO test, through the Run box.
    await t.clickDesktop('H.rdp')
    await t.escape()
    await t.press('r', ['Meta'])
    await sleep(2500)
    await t.type('msedge --kiosk --no-first-run www.testufo.com')
    await sleep(500)
    await t.enter()
    t.onCleanup(async () => {
        try { await t.key('F4', 'F4', 115, ['Alt']); await sleep(500) } catch { }
    })
    await sleep(8000)  // Edge starts (a first run may open its own pages first)
    // The address bar, whatever Edge opened with, then full screen so the test fills the picture.
    await t.press('l', ['Control'])
    await sleep(500)
    await t.type('testufo.com')
    await sleep(300)
    await t.enter()
    await sleep(6000)
    await t.key('F11', 'F11', 122)
    await sleep(6000)  // the page's counter settles
    await t.dump('H.rdp', `fps-${CLIENT}-page`)

    // The measurement window.
    const before = await ev<any>('return H.sample(H.rdp)')
    await sleep(SECONDS * 1000)
    const after = await ev<any>('return H.sample(H.rdp)')
    await t.dump('H.rdp', `fps-${CLIENT}-end`)
    const seconds = (after.at - before.at) / 1000
    const shown = after.frames !== null && before.frames !== null ? (after.frames - before.frames) / seconds : null
    const mbps = after.bytesIn !== null ? (after.bytesIn - before.bytesIn) * 8 / seconds / 1e6 : null
    t.time(`${CLIENT}: frames shown per second (the client's own frame counter): ${shown === null ? 'n/a' : shown.toFixed(1)}; ${mbps === null ? '' : mbps.toFixed(1) + ' Mbit/s from the server'}`, 0)
    check(`${CLIENT}: frames keep coming`, shown === null || shown > 5, shown)

    if (CLIENT === 'ironrdp') {
        const events = await ev<any[]>(`return H.traceSince(H.rdp, ${before.events})`)
        const t0 = events[0]?.t ?? 0
        const inWindow = events.filter(e => e.t - t0 <= seconds * 1000)
        const count = (name: string) => inWindow.filter(e => e.name === name).length
        const frames = count('EGFX.EndFrame')
        const acks = count('EGFX.FrameAcknowledge')
        const draws = count('Canvas.Draw')
        const avc = inWindow.filter(e => e.name === 'EGFX.WireToSurface1' && /^AVC/.test(String(e.attrs.codec)))
        const codecs: Record<string, number> = {}
        for (const e of inWindow.filter(e => /^EGFX\.(WireToSurface1|WireToSurface2|SolidFill|CacheToSurface)$/.test(e.name))) {
            const k = String(e.attrs.codec ?? e.name.slice(5))
            codecs[k] = (codecs[k] ?? 0) + 1
        }
        t.time(`ironrdp: server frames/s ${(frames / seconds).toFixed(1)}, acknowledged/s ${(acks / seconds).toFixed(1)}, canvas draws/s ${(draws / seconds).toFixed(1)}; commands: ${Object.entries(codecs).map(([k, v]) => `${k} ${v}`).join(', ')}`, 0)
        // Where a frame's time goes: Start Frame on the wire → the access unit handed to the decoder → its pixels →
        // the canvas drawn → the frame acknowledged. Medians over the frames that carried H.264.
        const byFrame = new Map<number, any>()
        let current: any = null
        for (const e of inWindow) {
            if (e.name === 'EGFX.StartFrame') { current = { id: e.attrs.frameId, start: e.t }; byFrame.set(current.id, current) }
            else if (e.name === 'EGFX.WireToSurface1' && current && /^AVC/.test(String(e.attrs.codec))) { current.avc = true; current.bytes = (current.bytes ?? 0) + Number(e.attrs.h264Bytes ?? 0); current.key = e.attrs.keyFrame === true }
            else if (e.name === 'EGFX.EndFrame' && current) { current.end = e.t; current = null }
            else if (e.name === 'H264.Handed') { const f = [...byFrame.values()].reverse().find(f => f.avc && f.handed === undefined); if (f) { f.handed = e.t; f.unit = e.attrs.id } }
            else if (e.name === 'H264.Decoded') { const f = [...byFrame.values()].find(f => f.unit === e.attrs.id); if (f) { f.decoded = e.t; f.latency = Number(e.attrs.latencyMs) } }
            else if (e.name === 'Canvas.Draw') { const f = [...byFrame.values()].reverse().find(f => f.decoded !== undefined && f.drawn === undefined); if (f) f.drawn = e.t }
            else if (e.name === 'EGFX.FrameAcknowledge') { const f = byFrame.get(Number(e.attrs.frameId)); if (f) { f.ack = e.t; f.queue = e.attrs.queueDepth } }
        }
        const done = [...byFrame.values()].filter(f => f.avc && f.ack !== undefined && f.decoded !== undefined)
        const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN }
        const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * 0.95)] : NaN }
        if (done.length) {
            const decode = done.map(f => f.decoded - f.handed)
            const toDraw = done.filter(f => f.drawn !== undefined).map(f => f.drawn - f.decoded)
            const toAck = done.map(f => f.ack - f.start)
            const gaps = done.slice(1).map((f, i) => f.start - done[i].start)
            t.time(`ironrdp: H.264 frames ${done.length} (${done.filter(f => f.key).length} key), median access unit ${(median(done.map(f => f.bytes)) / 1024).toFixed(0)} KiB; between frames median ${median(gaps).toFixed(1)} ms; decoder median ${median(decode).toFixed(1)} ms p95 ${p95(decode).toFixed(1)} ms; pixels → canvas median ${median(toDraw).toFixed(1)} ms; Start Frame → ack median ${median(toAck).toFixed(1)} ms p95 ${p95(toAck).toFixed(1)} ms; queue depth seen: ${[...new Set(done.map(f => f.queue))].join(',')}`, 0)
        } else {
            t.time(`ironrdp: no H.264 frames in the window (${avc.length} AVC commands); the server sent ${Object.keys(codecs).join(', ')}`, 0)
        }
        if (after.h264) {
            t.time(`ironrdp: decoder stats: ${JSON.stringify(after.h264)}`, 0)
        }
        if (process.env.TRD_TEST_DUMP) {
            fs.writeFileSync(path.join(process.env.TRD_TEST_DUMP, 'fps-ironrdp-window.json'), JSON.stringify(inWindow))
        }
    }
}, { needsHost: false })
