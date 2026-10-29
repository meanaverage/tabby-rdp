#!/usr/bin/env node
// Turns FreeRDP's own log of its graphics pipeline and display control channels into the PDU trace's events, and
// merges them with the plugin's trace of the same connection (the resize requests, the canvas), so that a FreeRDP
// session can be laid out and checked in tools/pdu-trace like an IronRDP one. FreeRDP's helper doesn't pass the
// plugin's proxy (TLS is its own), so the wire can't be tapped; FreeRDP logs each graphics command it receives
// instead (channels/rdpgfx/client/rdpgfx_main.c), at DEBUG, with End Frame and Frame Acknowledge at TRACE.
//
// Getting the log: run Tabby (or the pdu-trace suite) with FreeRDP's logging aimed at a file; the plugin hands these
// through to the helper (src/freerdp.ts, helperEnvironment):
//
//   WLOG_APPENDER=FILE WLOG_FILEAPPENDER_OUTPUT_FILE_PATH=<folder> WLOG_FILEAPPENDER_OUTPUT_FILE_NAME=freerdp.log
//   WLOG_FILTER='com.freerdp.channels.rdpgfx.client:TRACE,com.freerdp.channels.disp.client:DEBUG'
//
//   node tools/pdu-trace/from-freerdp-log.mjs <freerdp.log> [<plugin trace .otlp.json>] [<out.otlp.json>]
//
// FreeRDP stamps lines with the local time of day only; the date (and the clock) is taken from the plugin's trace
// when one is given, else from the file's modification time.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const { exportOtlp } = require(path.join(root, 'dist', 'pduTrace.js'))

const CODECS = { 0: 'Uncompressed', 3: 'RemoteFX', 8: 'ClearCodec', 9: 'Progressive', 10: 'Planar', 11: 'AVC420', 12: 'Alpha', 13: 'ProgressiveV2', 14: 'AVC444', 15: 'AVC444v2' }

/** The plugin's trace events (flattened) and its start, from an OTLP file; null without one. */
export function readPluginTrace (file) {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rs = o.resourceSpans[0]
    const attrs = l => Object.fromEntries((l ?? []).map(a => [a.key, 'intValue' in a.value ? Number(a.value.intValue) : 'doubleValue' in a.value ? a.value.doubleValue : 'boolValue' in a.value ? a.value.boolValue : a.value.stringValue]))
    const spans = rs.scopeSpans.flatMap(ss => ss.spans)
    const root = spans.find(s => s.name === 'rdp.connection') ?? spans[0]
    const ms = v => Number(BigInt(v) / 1000n) / 1000
    const events = spans.flatMap(s => s.events.map(e => {
        const { seq, dir, layer, bytes, repeat, untilUnixNano, ...rest } = attrs(e.attributes)
        return { seq, t: ms(e.timeUnixNano), dir, layer, name: e.name, bytes: bytes ?? 0, attrs: rest, ...repeat ? { repeat, until: ms(untilUnixNano) } : {} }
    })).sort((a, b) => a.seq - b.seq)
    return { events, startedAt: ms(root.startTimeUnixNano), endedAt: ms(root.endTimeUnixNano), meta: attrs(rs.resource.attributes) }
}

/**
 * FreeRDP's log lines as trace events. `day`: a Date on the day the log was written (its local midnight is where
 * the times of day start). Lines of other modules, and lines not understood, are left out.
 */
export function parseFreeRdpLog (text, day) {
    const base = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
    const events = []
    let seq = 0
    let last = -Infinity
    for (const line of text.split('\n')) {
        // "[hh:mm:ss:mmm] [pid:tid] [LEVEL][module] - message", or the same with a WLOG_PREFIX of its own.
        const m = /^\[(\d\d):(\d\d):(\d\d):(\d{1,3})\]\s*(?:\[[^\]]*\]\s*)*?\[(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]\s*\[([^\]]+)\]\s*-?\s*(.*)$/.exec(line)
        if (!m) {
            continue
        }
        let t = base + ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4]
        if (t < last - 12 * 3600 * 1000) {
            t += 24 * 3600 * 1000  // past midnight
        }
        last = t
        const module = m[5]
        // FreeRDP prefixes each message with the function it came from: "[rdpgfx_recv_end_frame_pdu]: ...".
        const msg = m[6].replace(/^\[[\w:]+\]:\s*/, '')
        const add = (dir, layer, name, attrs = {}) => events.push({ seq: seq++, t, dir, layer, name, bytes: 0, attrs })
        const n = key => { const r = new RegExp(`${key}:? ?(-?\\d+)`).exec(msg); return r ? Number(r[1]) : undefined }
        if (/rdpgfx/.test(module)) {
            let r
            if ((r = /^RecvResetGraphicsPdu: width: (\d+) height: (\d+) count: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.ResetGraphics', { width: +r[1], height: +r[2], monitors: +r[3] })
            else if (/^RecvResetGraphicsPdu: monitor/.test(msg)) continue
            else if ((r = /^RecvCreateSurfacePdu: surfaceId: (\d+) width: (\d+) height: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.CreateSurface', { surfaceId: +r[1], width: +r[2], height: +r[3] })
            else if ((r = /^RecvDeleteSurfacePdu: surfaceId: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.DeleteSurface', { surfaceId: +r[1] })
            else if ((r = /^RecvStartFramePdu: frameId: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.StartFrame', { frameId: +r[1] })
            else if ((r = /^RecvEndFramePdu: frameId: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.EndFrame', { frameId: +r[1] })
            else if ((r = /^SendFrameAcknowledgePdu: (\d+)/.exec(msg))) add('out', 'egfx', 'EGFX.FrameAcknowledge', { frameId: +r[1] })
            else if ((r = /^RecvWireToSurface1Pdu: surfaceId: (\d+) codecId: (\S+) \(0x([0-9A-Fa-f]+)\)/.exec(msg))) {
                const left = n('left'), top = n('top'), right = n('right'), bottom = n('bottom')
                add('in', 'egfx', 'EGFX.WireToSurface1', { surfaceId: +r[1], codec: CODECS[parseInt(r[3], 16)] ?? r[2], dest: `${left},${top}-${right},${bottom}`, bitmapBytes: n('bitmapDataLength') ?? 0 })
            } else if ((r = /^RecvWireToSurface2Pdu: surfaceId: (\d+) codecId: (\S+) \(0x([0-9A-Fa-f]+)\)/.exec(msg))) add('in', 'egfx', 'EGFX.WireToSurface2', { surfaceId: +r[1], codec: CODECS[parseInt(r[3], 16)] ?? r[2], contextId: n('codecContextId'), bitmapBytes: n('bitmapDataLength') ?? 0 })
            else if ((r = /^RecvSolidFillPdu: surfaceId: (\d+) fillRectCount: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.SolidFill', { surfaceId: +r[1], rectangles: +r[2] })
            else if ((r = /^RecvSurfaceToSurfacePdu: surfaceIdSrc: (\d+) surfaceIdDest: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.SurfaceToSurface', { sourceSurfaceId: +r[1], surfaceId: +r[2], points: n('destPtsCount') })
            else if ((r = /^RecvSurfaceToCachePdu: surfaceId: (\d+) .*?cacheSlot: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.SurfaceToCache', { surfaceId: +r[1], cacheSlot: +r[2], source: `${n('left')},${n('top')}-${n('right')},${n('bottom')}` })
            else if ((r = /^RdpGfxRecvCacheToSurfacePdu: cacheSlot: (\d+) surfaceId: (\d+) destPtsCount: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.CacheToSurface', { cacheSlot: +r[1], surfaceId: +r[2], points: +r[3] })
            else if ((r = /^RecvMapSurfaceToOutputPdu: surfaceId: (\d+) outputOriginX: (\d+) outputOriginY: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.MapSurfaceToOutput', { surfaceId: +r[1], origin: `${r[2]},${r[3]}` })
            else if ((r = /^RecvMapSurfaceToScaledOutputPdu: surfaceId: (\d+) outputOriginX: (\d+) outputOriginY: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.MapSurfaceToScaledOutput', { surfaceId: +r[1], origin: `${r[2]},${r[3]}`, target: `${n('targetWidth')}x${n('targetHeight')}` })
            else if ((r = /^RecvCapsConfirmPdu: version: (\S+)/.exec(msg))) add('in', 'egfx', 'EGFX.CapsConfirm', { version: r[1] })
            else if ((r = /^SendCapsAdvertisePdu (\d+)/.exec(msg))) add('out', 'egfx', 'EGFX.CapsAdvertise', { sets: +r[1] })
            else if ((r = /^RecvEvictCacheEntryPdu: cacheSlot: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.EvictCacheEntry', { cacheSlot: +r[1] })
            else if ((r = /^RecvCacheImportReplyPdu: importedEntriesCount: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.CacheImportReply', { imported: +r[1] })
            else if ((r = /^RecvDeleteEncodingContextPdu: surfaceId: (\d+) codecContextId: (\d+)/.exec(msg))) add('in', 'egfx', 'EGFX.DeleteEncodingContext', { surfaceId: +r[1], contextId: +r[2] })
            else if (/^Sending /.test(msg)) continue
            else add('in', 'egfx', 'EGFX.Log', { text: msg.slice(0, 160) })
        } else if (/disp/.test(module)) {
            let r
            if ((r = /^NumMonitors=(\d+)/.exec(msg))) add('out', 'displaycontrol', 'DisplayControl.MonitorLayout', { monitors: +r[1] })
            else if ((r = /W\/H=(\d+)x(\d+)/.exec(msg))) {
                // The monitors follow the count, one line each (the first is the primary), then their scale.
                const layout = events.findLast(e => e.name === 'DisplayControl.MonitorLayout')
                if (layout && layout.attrs.width === undefined) {
                    layout.attrs.width = +r[1]
                    layout.attrs.height = +r[2]
                }
            } else if ((r = /DesktopScaleFactor=(\d+)/.exec(msg))) {
                const layout = events.findLast(e => e.name === 'DisplayControl.MonitorLayout')
                if (layout && layout.attrs.desktopScale === undefined) layout.attrs.desktopScale = +r[1]
            } else if (/MaxNumMonitors/.test(msg)) add('in', 'displaycontrol', 'DisplayControl.Caps', { text: msg.slice(0, 120) })
        }
    }
    return events
}

/** The two sets of events as one trace, in time order. */
export function merge (plugin, freerdp) {
    const all = [...plugin ?? [], ...freerdp].sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0))
    all.forEach((e, i) => { e.seq = i })
    return all
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [logFile, pluginFile, outFile] = process.argv.slice(2)
    if (!logFile) {
        console.error('usage: from-freerdp-log.mjs <freerdp.log> [<plugin trace .otlp.json>] [<out.otlp.json>]')
        process.exit(2)
    }
    const plugin = pluginFile ? readPluginTrace(pluginFile) : null
    const day = plugin ? new Date(plugin.startedAt) : fs.statSync(logFile).mtime
    const freerdp = parseFreeRdpLog(fs.readFileSync(logFile, 'utf8'), day)
    const events = merge(plugin?.events, freerdp)
    const started = Math.min(plugin?.startedAt ?? Infinity, events[0]?.t ?? Date.now())
    const ended = Math.max(plugin?.endedAt ?? -Infinity, events.at(-1)?.t ?? started)
    const meta = { pluginVersion: plugin?.meta['service.version'] ?? '', desktop: plugin?.meta['rdp.desktop'] ?? path.basename(logFile), destination: plugin?.meta['rdp.destination'] ?? '', client: 'freerdp', graphics: plugin?.meta['rdp.graphics'] ?? '', platform: plugin?.meta['os.type'] ?? '' }
    const out = outFile ?? logFile.replace(/\.log$/, '') + '.otlp.json'
    fs.writeFileSync(out, JSON.stringify(exportOtlp(events, meta, started, ended, 0)))
    console.log(`${freerdp.length} FreeRDP events${plugin ? ` + ${plugin.events.length} plugin events` : ''} → ${out}`)
}
