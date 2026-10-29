#!/usr/bin/env node
// Turns a tabby-rdp diagnostic log file (Settings › Diagnostics › Write a log file, at debug or trace) into the
// PDU trace's OTLP/JSON form, for logs written before the trace existed, or by a build without it. What a log
// holds is coarser than the wire: the plugin's lines (resize requests, connection), and what IronRDP logs
// (the display control layout sent, the graphics pipeline's resets, surfaces and mappings, the dynamic channels
// opened, the activation PDUs, auto-detect requests). Frames and their acknowledgements are not in a debug log.
//
//   node tools/pdu-trace/from-log.mjs <log file> [<out.otlp.json>]
//
// Needs the plugin built (npm run build): it uses dist/pduTrace.js for the spans and the OTLP form.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const { exportOtlp } = require(path.join(root, 'dist', 'pduTrace.js'))

const [input, output] = process.argv.slice(2)
if (!input) {
    console.error('usage: from-log.mjs <log file> [<out.otlp.json>]')
    process.exit(2)
}

const lines = fs.readFileSync(input, 'utf8').split('\n')
const events = []
let seq = 0
const meta = { pluginVersion: '', desktop: path.basename(input), destination: '', client: 'ironrdp', graphics: '', platform: '' }
const autoDetectRun = new Map()
const add = (t, dir, layer, name, attrs = {}) => {
    // A run of auto-detect PDUs folds into one event per kind with a count (as the trace itself does).
    if (layer === 'sec' && name.startsWith('AutoDetect.')) {
        const run = autoDetectRun.get(`${dir}:${name}`)
        if (run) {
            run.repeat = (run.repeat ?? 1) + 1
            run.until = t
            return
        }
    } else {
        autoDetectRun.clear()
    }
    const event = { seq: seq++, t, dir, layer, name, bytes: 0, attrs }
    if (layer === 'sec' && name.startsWith('AutoDetect.')) {
        autoDetectRun.set(`${dir}:${name}`, event)
    }
    events.push(event)
}
const num = (s, key) => { const m = new RegExp(`${key}[=:] ?(-?\\d+)`).exec(s); return m ? Number(m[1]) : undefined }

let first = null
let last = null
for (const line of lines) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (log|plugin|ironrdp) (.*)$/.exec(line)
    if (!m) {
        continue
    }
    const t = Date.parse(m[1])
    first ??= t
    last = t
    const [, , source, text] = m
    if (source === 'log') {
        const v = /^tabby-rdp (\S+) on (\S+ \S+ \(\S+\)); Electron (\S+)/.exec(text)
        if (v) {
            meta.pluginVersion = v[1]
            meta.platform = v[2]
            meta.electron = v[3]
        }
        const d = /diagnostic log, level (\w+): (.*)$/.exec(text)
        if (d) {
            meta.desktop = d[2]
        }
        continue
    }
    if (source === 'plugin') {
        let r
        if ((r = /^resize: (\d+)x(\d+) @(\d+)%/.exec(text))) {
            add(t, 'local', 'plugin', 'Resize.Requested', { width: +r[1], height: +r[2], scale: +r[3] })
        } else if ((r = /^connected: (\d+)x(\d+)/.exec(text))) {
            add(t, 'local', 'plugin', 'Connected', { width: +r[1], height: +r[2] })
        } else if ((r = /^graphics: (.*)$/.exec(text))) {
            meta.graphics = r[1]
            add(t, 'local', 'plugin', 'Graphics', { mode: r[1] })
        } else if ((r = /^client: (.*)$/.exec(text))) {
            meta.client = r[1].toLowerCase()
        } else if ((r = /^RDCleanPath relay up to (.*)$/.exec(text))) {
            meta.destination = r[1]
            add(t, 'local', 'plugin', 'Relay.Up', { destination: r[1] })
        } else if ((r = /^(h264: failed: .*)$/.exec(text))) {
            add(t, 'local', 'decoder', 'H264.Error', { error: r[1] })
        } else if (/^(TLS|certificate|diagnostics|clipboard|drives|Connecting|pdu trace)/.test(text) || text.trim() === '') {
            add(t, 'local', 'plugin', text.split(':')[0].trim(), { text: text.slice(0, 160) })
        } else {
            add(t, 'local', 'plugin', 'Log', { text: text.slice(0, 160) })
        }
        continue
    }
    // IronRDP's lines: "LEVEL [spans:] target: message key=value…"
    const i = / (TRACE|DEBUG|INFO|WARN|ERROR) (.*)$/.exec(' ' + text)
    if (!i) {
        continue
    }
    const msg = i[2]
    let r
    if ((r = /Sending monitor layout pdu=.*?width: (\d+), height: (\d+).*?desktop_scale_factor: (\d+)/.exec(msg))) {
        add(t, 'out', 'displaycontrol', 'DisplayControl.MonitorLayout', { width: +r[1], height: +r[2], desktopScale: +r[3] })
    } else if ((r = /Received DisplayControlCapabilities \{ max_num_monitors: (\d+)/.exec(msg))) {
        add(t, 'in', 'displaycontrol', 'DisplayControl.Caps', { maxNumMonitors: +r[1] })
    } else if ((r = /Graphics reset width=(\d+) height=(\d+)/.exec(msg))) {
        add(t, 'in', 'egfx', 'EGFX.ResetGraphics', { width: +r[1], height: +r[2] })
    } else if ((r = /Surface created surface_id=(\d+) width=(\d+) height=(\d+)/.exec(msg))) {
        add(t, 'in', 'egfx', 'EGFX.CreateSurface', { surfaceId: +r[1], width: +r[2], height: +r[3] })
    } else if ((r = /Surface deleted surface_id=(\d+)/.exec(msg))) {
        add(t, 'in', 'egfx', 'EGFX.DeleteSurface', { surfaceId: +r[1] })
    } else if ((r = /Surface mapped to scaled output surface_id=(\d+) origin_x=(\d+) origin_y=(\d+) target_width=(\d+) target_height=(\d+)/.exec(msg))) {
        add(t, 'in', 'egfx', 'EGFX.MapSurfaceToScaledOutput', { surfaceId: +r[1], origin: `${r[2]},${r[3]}`, target: `${r[4]}x${r[5]}` })
    } else if ((r = /Surface mapped to output surface_id=(\d+) origin_x=(\d+) origin_y=(\d+)/.exec(msg))) {
        add(t, 'in', 'egfx', 'EGFX.MapSurfaceToOutput', { surfaceId: +r[1], origin: `${r[2]},${r[3]}` })
    } else if ((r = /EGFX capabilities confirmed cap=(\S+) .*?avc420=(\w+) avc444=(\w+)/.exec(msg))) {
        add(t, 'in', 'egfx', 'EGFX.CapsConfirm', { version: r[1], avc420: r[2] === 'true', avc444: r[3] === 'true' })
    } else if ((r = /StartFrame.*frame_id=(\d+)|frame_id=(\d+) .*StartFrame/.exec(msg))) {
        add(t, 'in', 'egfx', 'EGFX.StartFrame', { frameId: +(r[1] ?? r[2]) })
    } else if ((r = /Sending FrameAcknowledge.*frame_id=(\d+)|frame_id=(\d+).*Sending FrameAcknowledge/.exec(msg))) {
        add(t, 'out', 'egfx', 'EGFX.FrameAcknowledge', { frameId: +(r[1] ?? r[2]) })
    } else if ((r = /H\.264 access unit handed out/.exec(msg))) {
        add(t, 'local', 'decoder', 'H264.Handed', { id: num(msg, 'id'), surfaceId: num(msg, 'surface_id'), keyFrame: /key_frame=true/.test(msg), regions: num(msg, 'regions') })
    } else if ((r = /Got DVC Create Request PDU: .*channel_id: (\d+), channel_name: "([^"]+)"/.exec(msg))) {
        add(t, 'in', 'dvc', 'DVC.CreateRequest', { channelId: +r[1], name: r[2] })
    } else if ((r = /Send DVC Create Response PDU: .*channel_id: (\d+), creation_status: CreationStatus\((\d+)\)/.exec(msg))) {
        add(t, 'out', 'dvc', 'DVC.CreateResponse', { channelId: +r[1], status: r[2] === '0' ? 'ok' : '0x' + Number(r[2]).toString(16) })
    } else if (/Got DVC Capabilities Request/.test(msg)) {
        add(t, 'in', 'dvc', 'DVC.CapabilitiesRequest', {})
    } else if (/Send DVC Capabilities Response/.test(msg)) {
        add(t, 'out', 'dvc', 'DVC.CapabilitiesResponse', {})
    } else if ((r = /Received ServerDemandActive/.exec(msg))) {
        const size = /desktop_width: (\d+), desktop_height: (\d+)/.exec(msg)
        add(t, 'in', 'share', 'DemandActive', { bitmapDesktop: size ? `${size[1]}x${size[2]}` : '' })
    } else if (/Send ClientConfirmActive/.test(msg)) {
        add(t, 'out', 'share', 'ConfirmActive', {})
    } else if (/ServerDeactivateAll|Deactivate All/.test(msg)) {
        add(t, 'in', 'share', 'DeactivateAll', {})
    } else if ((r = /Received MonitorLayout\(MonitorLayoutPdu \{ monitors: \[(.*?)\]/.exec(msg))) {
        add(t, 'in', 'share', 'MonitorLayout', { monitors: r[1].replace(/Monitor \{ |flags: \w+\(.*?\) \}/g, '').slice(0, 120) })
    } else if ((r = /Received (Synchronize|ControlCooperate|GrantedControl|FontMap|ServerSynchronize|ServerControl)/i.exec(msg))) {
        add(t, 'in', 'share', r[1].replace(/^Server/, ''), {})
    } else if ((r = /Send (Synchronize|ControlCooperate|RequestControl|FontList|ClientInfoPdu|ConnectInitial|ErectDomainRequest|AttachUserRequest)/.exec(msg))) {
        add(t, 'out', /Pdu$/.test(r[1]) || r[1] === 'ConnectInitial' ? 'sec' : 'share', r[1].replace(/Pdu$/, ''), {})
    } else if ((r = /Auto-detect request not yet implemented req=(\w+)/.exec(msg))) {
        add(t, 'in', 'sec', `AutoDetect.Request.${r[1]}`, {})
    } else if ((r = /Received (ServerLicenseRequest|ServerPlatformChallenge|ServerNewLicense|ServerUpgradeLicense|LicensingErrorMessage)/.exec(msg))) {
        add(t, 'in', 'sec', `Licensing.${r[1].replace(/^Server/, '')}`, {})
    } else if (/Send ClientNewLicenseRequest|Send ClientPlatformChallengeResponse|Send ClientLicenseInfo/.test(msg)) {
        add(t, 'out', 'sec', 'Licensing.ClientMessage', {})
    } else if (/Received TsRequest/.test(msg)) {
        add(t, 'in', 'sec', 'CredSSP.TSRequest', {})
    } else if (/Send TsRequest/.test(msg)) {
        add(t, 'out', 'sec', 'CredSSP.TSRequest', {})
    } else if ((r = /Resize event received width=(\d+) height=(\d+)/.exec(msg))) {
        add(t, 'local', 'plugin', 'Resize.Received', { width: +r[1], height: +r[2] })
    } else if (/Resize event ignored|Could not encode a resize/.test(msg)) {
        add(t, 'local', 'plugin', 'Resize.Ignored', { why: msg.replace(/^.*?: /, '').slice(0, 120) })
    } else if (/Received None server error|Got Session Save Info/.test(msg)) {
        add(t, 'in', 'share', /Save Info/.test(msg) ? 'SaveSessionInfo' : 'SetErrorInfo', {})
    } else if (/^(WARN|ERROR)/.test(i[1]) || i[1] === 'WARN' || i[1] === 'ERROR') {
        add(t, 'local', 'trace', i[1], { text: msg.slice(0, 200) })
    } else if (/Connected!|RDP login complete|Canvas initialized|Deactivation-Reactivation/.test(msg)) {
        add(t, 'local', 'plugin', msg.replace(/^.*?: /, '').slice(0, 60), {})
    }
}

const otlp = exportOtlp(events, meta, first ?? Date.now(), last ?? Date.now(), 0)
const out = output ?? input.replace(/\.log$/, '') + '.from-log.otlp.json'
fs.writeFileSync(out, JSON.stringify(otlp))
console.log(`${events.length} events, ${otlp.resourceSpans[0].scopeSpans[0].spans.length} spans → ${out}`)
