// The PDU flow of a connection and of live resizes, read back from the PDU trace (src/pduTrace.ts) a desktop writes
// while the diagnostic log is on: the connection sequence; for each resize to a larger size, that the server answers
// the monitor layout with a graphics reset to that size (or a deactivation and reactivation), creates a surface of
// that size, and that a frame at the new size is acknowledged; that the canvas is resized before the first picture
// at the new size is drawn; and that the picture then holds still (no half-drawn frame left behind). The trace's
// checks are the ones tools/pdu-trace shows; the trace file is left for it.
//
// The desktop: TRD_TEST_RDS (host[:port], a Windows server; TRD_TEST_RDS_USER, TRD_TEST_RDS_PASSWORD) or, without
// it, TRD_TEST_DIRECT (any RDP server; TRD_TEST_DIRECT_USER, TRD_TEST_DIRECT_PASSWORD, TRD_TEST_DIRECT_KIND), as a
// direct remote desktop tab. Skipped with neither. Set TRD_TEST_DUMP to keep pictures of the display before and after
// each resize and a copy of the trace file.
//
// TRD_TEST_CLIENT=freerdp runs the same resizes with the FreeRDP helper. Its traffic doesn't pass the plugin's proxy,
// so the wire checks are skipped; the graphics commands come from FreeRDP's own log instead, which the suite points
// at TRD_TEST_DUMP (WLOG_*; see tools/pdu-trace/from-freerdp-log.mjs) and reads back after the connection ends, merged
// with the plugin's trace, so the resize checks are the same.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { suite, type CanvasInfo } from '../lib/harness.js'
import { parseFreeRdpLog, readPluginTrace, merge } from '../../tools/pdu-trace/from-freerdp-log.mjs'
import { createRequire } from 'node:module'

const NAME = 'PDU trace desktop (test)'
const CLIENT = process.env.TRD_TEST_CLIENT === 'freerdp' ? 'freerdp' : 'ironrdp'
const FREERDP_LOG = process.env.WLOG_FILEAPPENDER_OUTPUT_FILE_PATH && process.env.WLOG_FILEAPPENDER_OUTPUT_FILE_NAME
    ? path.join(process.env.WLOG_FILEAPPENDER_OUTPUT_FILE_PATH, process.env.WLOG_FILEAPPENDER_OUTPUT_FILE_NAME) : null

await suite('pdu-trace', async t => {
    const { ev, check, sleep } = t
    const rds = process.env.TRD_TEST_RDS || ''
    const address = rds || process.env.TRD_TEST_DIRECT || ''
    const user = (rds ? process.env.TRD_TEST_RDS_USER : process.env.TRD_TEST_DIRECT_USER) || ''
    const password = (rds ? process.env.TRD_TEST_RDS_PASSWORD : process.env.TRD_TEST_DIRECT_PASSWORD) || ''
    const kind = rds ? 'windows' : process.env.TRD_TEST_DIRECT_KIND || 'gnome'
    if (!address || !user) {
        t.skip('a desktop', 'set TRD_TEST_RDS or TRD_TEST_DIRECT (with their user and password)')
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
        /** The trace's events so far, as the plugin holds them. */
        trace (p) { const s = H.session(p); return s?.trace ? { events: s.trace.events, startedAt: s.trace.startedAt, file: s.traceFile } : null },
        /** A sample of the display: how many colors, and how much of it is black. */
        picture (p) {
            const cv = H.canvasElement(p)
            if (!cv || !cv.width) return null
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
            let black = 0, n = 0
            const colors = new Set()
            for (let i = 0; i < d.length; i += 4 * 101) { n++; if (d[i] < 8 && d[i + 1] < 8 && d[i + 2] < 8) black++; colors.add(d[i] >> 3 << 10 | d[i + 1] >> 3 << 5 | d[i + 2] >> 3) }
            return { w: cv.width, h: cv.height, colors: colors.size, black: black / n }
        },
        /** How much of a rectangle of the display is black (0..1), and whether the display is that big. */
        blackIn (p, x0, y0, x1, y1) {
            const cv = H.canvasElement(p)
            if (!cv || cv.width < x1 || cv.height < y1) return null
            const d = cv.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data
            let black = 0, n = 0
            for (let i = 0; i < d.length; i += 4 * 13) { n++; if (d[i] < 8 && d[i + 1] < 8 && d[i + 2] < 8) black++ }
            return Math.round(black / n * 1000) / 1000
        },
        /** A digest of the display, to see whether it changes. */
        digest (p) {
            const cv = H.canvasElement(p)
            if (!cv || !cv.width) return ''
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
            let h = 0
            for (let i = 0; i < d.length; i += 4 * 7) { h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0 }
            return cv.width + 'x' + cv.height + ':' + h
        },
    })`)

    const key = `rdp#${host}:${port}`
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    const profilesBefore = await ev('return JSON.stringify(H.config.store.profiles ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.store.profiles = ${profilesBefore}; H.config.save() })`))
    await ev(`H.inZone(() => { const r = H.config.store.remoteDesktop; r.trustedCertificates = (r.trustedCertificates ?? []).filter(e => e?.desktop !== ${JSON.stringify(key)}); H.config.save() })`)

    // The diagnostic log (and with it the PDU trace) on, live resizes, H.264 as the setting has it.
    await t.settings({ diagnosticLog: 'debug', resize: 'live', sharpness: 'standard' })
    if (CLIENT === 'freerdp' && !FREERDP_LOG) {
        t.skip('FreeRDP\'s log', 'set WLOG_APPENDER=FILE, WLOG_FILEAPPENDER_OUTPUT_FILE_PATH, WLOG_FILEAPPENDER_OUTPUT_FILE_NAME and WLOG_FILTER (see tools/pdu-trace/from-freerdp-log.mjs)')
        return
    }
    const profile = { type: 'rdp', name: NAME, options: { host, port, kind, username: user, via: '', client: CLIENT } }
    const advance = async (): Promise<string | null> => {
        const connections = await ev<number>('return H.connections(H.rdp)')
        for (let i = 0; i < 300; i++) {
            const state = await ev<string | null>(`return H.state(H.rdp, ${connections})`)
            if (state === 'form') {
                await ev(`H.submit(H.rdp, ${JSON.stringify(password)})`)
                await sleep(500)
                continue
            }
            if (state === 'question') {
                await ev(`H.inZone(() => H.clickStatus(H.rdp, 'Trust the certificate'))`)
                await sleep(500)
                continue
            }
            if (state) {
                return state
            }
            await sleep(200)
        }
        return null
    }
    const setPane = (width: number, height: number) => ev(`const el = H.rdp.element.nativeElement; el.style.flex = 'none'; el.style.width = '${width}px'; el.style.height = '${height}px'`)
    const settle = async (): Promise<CanvasInfo> => {
        let last = ''
        for (let i = 0; i < 40; i++) {
            await sleep(300)
            const now = JSON.stringify(await ev('const c = H.canvas(H.rdp); return c && { w: c.w, h: c.h, paneW: c.paneW, paneH: c.paneH }'))
            if (now === last) return JSON.parse(now)
            last = now
        }
        return JSON.parse(last)
    }
    const events = () => ev<{ events: any[], startedAt: number, file: string } | null>('return H.trace(H.rdp)')

    check('a remote desktop tab opens', await ev(`H.rdp = await H.openProfile(${JSON.stringify(profile)}); return !!H.rdp`))
    await setPane(900, 600)
    const state = await advance()
    check('the desktop connects', state === 'connected', state)
    if (state !== 'connected') {
        return
    }
    const a = await settle()
    check('the trace is being written', !!(await events())?.file, (await events())?.file)
    await sleep(1500)

    // The connection sequence, as the wire shows it (IronRDP: the proxy's tap; FreeRDP's traffic isn't tapped).
    const connect = CLIENT === 'ironrdp' ? (await events())!.events : []
    const names = connect.map((e: any) => e.name)
    const has = (name: string, dir?: string) => connect.some((e: any) => e.name === name && (!dir || e.dir === dir))
    if (CLIENT === 'ironrdp') {
    check('X.224 negotiation traced (request and confirm)', has('ConnectionRequest', 'out') && has('ConnectionConfirm', 'in'), names.slice(0, 6))
    check('MCS connect and the channel names', has('ConnectInitial', 'out') && has('ConnectResponse', 'in') && connect.some((e: any) => e.name === 'ConnectInitial' && /drdynvc/.test(String(e.attrs.channels))))
    check('activation: Demand Active, Confirm Active, Font Map', has('DemandActive', 'in') && has('ConfirmActive', 'out') && has('FontMap', 'in'))
    const egfx = has('EGFX.CapsConfirm', 'in')
    check('the graphics pipeline, or legacy updates', egfx || has('FrameMarker.Begin', 'in') || has('Bitmap', 'in'), { egfx, names: [...new Set(names)].slice(0, 40) })
    if (egfx) {
        check('EGFX: reset, surface and a mapped output', has('EGFX.ResetGraphics', 'in') && has('EGFX.CreateSurface', 'in') && (has('EGFX.MapSurfaceToOutput', 'in') || has('EGFX.MapSurfaceToScaledOutput', 'in')))
        check('EGFX: frames end and are acknowledged by the client', has('EGFX.EndFrame', 'in') && has('EGFX.FrameAcknowledge', 'out'))
    }
    check('no decode errors in the trace', !connect.some((e: any) => e.name === 'DecodeError' || e.name === 'EGFX.ZgfxError' || e.name === 'EGFX.Malformed'), connect.filter((e: any) => /Error|Malformed/.test(e.name)).slice(0, 3))
    }
    await t.dump('H.rdp', 'pdu-trace-before')

    /** The checks on one resize's events (from the request on) against the size the display settled at. */
    const resizeChecks = (w: number, h: number, fresh: any[], after: CanvasInfo) => {
        const layout = fresh.find((e: any) => e.name === 'DisplayControl.MonitorLayout')
        check(`resize ${w}x${h}: a monitor layout was sent for ${after.w}x${after.h}`, !!layout && layout.attrs.width === after.w && layout.attrs.height === after.h, layout?.attrs)
        const reset = fresh.find((e: any) => e.name === 'EGFX.ResetGraphics' && e.attrs.width === after.w && e.attrs.height === after.h)
        const reactivated = fresh.some((e: any) => e.name === 'DeactivateAll') && fresh.some((e: any) => e.name === 'DemandActive' && e.attrs.bitmapDesktop === `${after.w}x${after.h}`)
        check(`resize ${w}x${h}: the server reset the graphics to the new size (or reactivated at it)`, !!reset || reactivated, fresh.filter((e: any) => /ResetGraphics|DeactivateAll|DemandActive|CreateSurface/.test(e.name)).map((e: any) => [e.name, e.attrs]))
        if (!reset || !layout) {
            return
        }
        check(`resize ${w}x${h}: the reset came within 2 s of the request`, reset.t - layout.t < 2000, Math.round(reset.t - layout.t) + ' ms')
        const surface = fresh.find((e: any) => e.name === 'EGFX.CreateSurface' && e.t >= reset.t)
        check(`resize ${w}x${h}: a surface of the new size was created after the reset`, !!surface && surface.attrs.width === after.w && surface.attrs.height === after.h, surface?.attrs)
        const edge = (e: any) => /-(\d+),(\d+)$/.exec(String(e.attrs.dest))
        const stale = fresh.filter((e: any) => e.name === 'EGFX.WireToSurface1' && e.t >= (surface?.t ?? reset.t) && edge(e) && (Number(edge(e)![1]) > after.w || Number(edge(e)![2]) > after.h))
        check(`resize ${w}x${h}: no surface command past the new surface's edge`, stale.length === 0, stale.slice(0, 3).map((e: any) => e.attrs))
        const firstEnd = fresh.find((e: any) => e.name === 'EGFX.EndFrame' && e.t >= (surface?.t ?? reset.t))
        const ack = firstEnd && fresh.find((e: any) => e.name === 'EGFX.FrameAcknowledge' && e.attrs.frameId === firstEnd.attrs.frameId)
        check(`resize ${w}x${h}: the first frame at the new size was acknowledged`, !!ack, { firstEnd: firstEnd?.attrs, ack: ack?.attrs })
        const commands = firstEnd ? fresh.filter((e: any) => e.t >= (surface?.t ?? reset.t) && e.t <= firstEnd.t && /^EGFX\.(WireToSurface1|WireToSurface2|SolidFill|CacheToSurface|SurfaceToSurface)$/.test(e.name)) : []
        const pastes = commands.filter((e: any) => e.name === 'EGFX.CacheToSurface')
        t.time(`resize ${w}x${h}: first frame ${firstEnd?.attrs.frameId ?? '?'}: ${commands.length} commands, ${pastes.length} cache pastes (slots ${[...new Set(pastes.map((e: any) => e.attrs.cacheSlot))].slice(0, 6).join(',')})`, 0)
        const avc = commands.filter((e: any) => /^AVC/.test(String(e.attrs.codec)))
        if (avc.length) {
            check(`resize ${w}x${h}: the first H.264 frame on the new surface is a key frame`, avc[0].attrs.keyFrame === true, avc[0].attrs)
            check(`resize ${w}x${h}: its picture is the surface's size`, !avc[0].attrs.picture || avc[0].attrs.picture === `${after.w}x${after.h}`, avc[0].attrs.picture)
        }
        const canvasResized = fresh.find((e: any) => e.name === 'Canvas.Resized' && e.attrs.width === after.w && e.attrs.height === after.h)
        const drawn = fresh.find((e: any) => e.name === 'Canvas.Draw' && e.t >= (canvasResized?.t ?? Infinity))
        if (canvasResized || fresh.some((e: any) => e.name === 'Canvas.Draw')) {
            check(`resize ${w}x${h}: the canvas was resized to the new size and then drawn`, !!canvasResized && !!drawn, { canvasResized: canvasResized?.attrs, drawn: drawn?.attrs })
        }
        const decodes = fresh.filter((e: any) => e.name === 'H264.Decoded')
        const errors = fresh.filter((e: any) => e.name === 'H264.Error' || e.name === 'H264.Skipped')
        if (decodes.length || errors.length) {
            check(`resize ${w}x${h}: H.264 decoded without errors or skipped frames`, errors.length === 0, errors.slice(0, 3).map((e: any) => e.attrs))
            const slow = decodes.filter((e: any) => Number(e.attrs.latencyMs) > 500)
            check(`resize ${w}x${h}: no H.264 picture took over 500 ms`, slow.length === 0, slow.slice(0, 3).map((e: any) => e.attrs))
        }
    }
    const pending: { w: number, h: number, after: CanvasInfo, since: number }[] = []

    // Two resizes to larger sizes, each checked against the trace and the picture.
    const sizes: [number, number][] = [[1240, 780], [1500, 940]]
    for (const [w, h] of sizes) {
        const before = (await events())!.events.length
        const t0 = Date.now()
        const previous = await ev<CanvasInfo | null>('return H.canvas(H.rdp)')
        await setPane(w, h)
        // How the picture evolves while the resize settles: a dump at each change (up to eight), and how black the
        // strip between the old right edge and the next 64-pixel tile boundary is (where debris was seen).
        const strip = previous ? [previous.w, 0, Math.ceil(previous.w / 64) * 64, Math.floor(previous.h / 64) * 64] : null
        let lastDigest = ''
        let dumps = 0
        const evolution: string[] = []
        for (let i = 0; i < 30; i++) {
            await sleep(100)
            const digest = await ev<string>('return H.digest(H.rdp)')
            if (digest !== lastDigest) {
                lastDigest = digest
                const black = strip && strip[2] > strip[0] ? await ev<number | null>(`return H.blackIn(H.rdp, ${strip.join(', ')})`) : null
                evolution.push(`+${Date.now() - t0} ms ${digest.split(':')[0]}${black !== null ? ` strip-black ${black}` : ''}`)
                if (dumps++ < 8) {
                    await t.dump('H.rdp', `pdu-trace-${w}x${h}-step${dumps}`)
                }
            }
        }
        t.time(`resize ${w}x${h}: picture evolution: ${evolution.join(' | ')}`, 0)
        const after = await settle()
        t.time(`live resize to ${w}x${h} settled`, Date.now() - t0)
        check(`resize ${w}x${h}: the resolution follows the pane`, after.w > a.w && Math.abs(after.w - after.paneW) <= 2, { before: a, after })
        await sleep(1500)
        const all = (await events())!
        const fresh = all.events.slice(before)
        const since = fresh.find((e: any) => e.name === 'Resize.Requested')?.t ?? (all.events[before - 1]?.t ?? 0)
        if (CLIENT === 'ironrdp') {
            resizeChecks(w, h, fresh, after)
        } else {
            pending.push({ w, h, after, since })
        }
        // The picture: drawn (not black), and still after it settled (nothing half-drawn waiting for more).
        const picture = await ev<{ w: number, h: number, colors: number, black: number } | null>('return H.picture(H.rdp)')
        check(`resize ${w}x${h}: the picture is drawn at the new size (not black)`, !!picture && picture.w === after.w && picture.colors > 10 && picture.black < 0.9, picture)
        const d1 = await ev<string>('return H.digest(H.rdp)')
        await sleep(2000)
        const d2 = await ev<string>('return H.digest(H.rdp)')
        const d3 = await (async () => { await sleep(1500); return ev<string>('return H.digest(H.rdp)') })()
        check(`resize ${w}x${h}: the picture holds still once settled`, d1 === d2 || d2 === d3, { d1, d2, d3 })
        await t.dump('H.rdp', `pdu-trace-after-${w}x${h}`)
    }

    // The trace file is written at the end of the connection; keep a copy with the dump.
    const file = (await events())!.file
    await ev('await H.inZone(() => RD.desktop.disconnect(H.rdp))')
    await sleep(1500)
    const written = fs.existsSync(file)
    check('the trace file was written at the end of the connection', written, file)
    // The diagnostic log beside it: IronRDP's warnings say when a delta was dropped or a decode failed.
    const logFile = file.replace(/\.otlp\.json$/, '.log')
    if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n')
        const warnings = lines.filter(l => / (WARN|ERROR) /.test(l))
        check('no IronRDP warnings in the diagnostic log', warnings.length === 0, warnings.slice(0, 5).map(l => l.slice(0, 200)))
        if (process.env.TRD_TEST_DUMP) {
            fs.copyFileSync(logFile, path.join(process.env.TRD_TEST_DUMP, `pdu-trace-${CLIENT}.log`))
        }
    }
    if (written) {
        const otlp = JSON.parse(fs.readFileSync(file, 'utf8'))
        const spans = otlp.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? []
        const resizes = spans.filter((s: any) => s.name === 'rdp.resize')
        if (CLIENT === 'ironrdp') {
            check('the trace has a span per resize, each settled', resizes.length >= sizes.length && resizes.every((s: any) => s.status?.code === 1), resizes.map((s: any) => [s.status, s.attributes.find((a: any) => a.key === 'settledAfterMs')?.value]))
        }
        check('no secret-looking content in the trace file', !/password|mstshash|Cookie/.test(fs.readFileSync(file, 'utf8')))
        if (process.env.TRD_TEST_DUMP) {
            fs.copyFileSync(file, path.join(process.env.TRD_TEST_DUMP, `pdu-trace-${CLIENT}.otlp.json`))
        }
    }
    // FreeRDP: its own log of the graphics commands, merged with the plugin's trace, checked the same way.
    if (CLIENT === 'freerdp' && written && FREERDP_LOG) {
        const logged = fs.existsSync(FREERDP_LOG)
        check('FreeRDP wrote its graphics log', logged, FREERDP_LOG)
        if (logged) {
            const plugin = readPluginTrace(file)
            const freerdp = parseFreeRdpLog(fs.readFileSync(FREERDP_LOG, 'utf8'), new Date(plugin.startedAt))
            check('FreeRDP\'s log has graphics commands', freerdp.some((e: any) => e.name === 'EGFX.StartFrame') && freerdp.some((e: any) => e.name === 'EGFX.FrameAcknowledge'), freerdp.slice(0, 5).map((e: any) => e.name))
            const all = merge(plugin.events, freerdp)
            for (const r of pending) {
                resizeChecks(r.w, r.h, all.filter((e: any) => e.t >= r.since - 50), r.after)
            }
            const { exportOtlp } = createRequire(import.meta.url)('../../dist/pduTrace.js')
            const merged = exportOtlp(all, { pluginVersion: plugin.meta['service.version'], desktop: plugin.meta['rdp.desktop'], destination: plugin.meta['rdp.destination'], client: 'freerdp', graphics: plugin.meta['rdp.graphics'], platform: plugin.meta['os.type'] }, plugin.startedAt, plugin.endedAt, 0)
            const out = file.replace(/\.otlp\.json$/, '') + '.freerdp.otlp.json'
            fs.writeFileSync(out, JSON.stringify(merged))
            if (process.env.TRD_TEST_DUMP) {
                fs.copyFileSync(out, path.join(process.env.TRD_TEST_DUMP, 'pdu-trace-freerdp-merged.otlp.json'))
                fs.copyFileSync(FREERDP_LOG, path.join(process.env.TRD_TEST_DUMP, 'freerdp.log'))
            }
        }
    }
}, { needsHost: false })
