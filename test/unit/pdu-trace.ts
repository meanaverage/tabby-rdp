// The PDU trace (src/pduTrace.ts): the stream framed and decoded into events, from PDUs built here the way a
// Windows server and IronRDP send them (MCS data on the I/O channel, share control and data, fast-path updates,
// static channel chunks, drdynvc, display control, the graphics pipeline under ZGFX); the spans derived from them
// (a resize settling, a frame and its acknowledgement, an H.264 access unit); the OTLP form; and that nothing
// secret is kept. Runs against the built plugin: npm run build && npm run test:unit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PduTrace, deriveSpans, exportOtlp, inspectH264, MAX_EVENTS } = require('../../dist/pduTrace.js')

// ---- builders ------------------------------------------------------------------------------------

const u8 = (n: number) => Buffer.from([n & 0xff])
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
const cat = (...parts: (Buffer | number[])[]) => Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)))

/** A TPKT + X.224 Data + MCS Send Data Indication (in) or Request (out) on `channel`. */
function mcsData (dir: 'in' | 'out', channel: number, payload: Buffer): Buffer {
    const length = payload.length < 128 ? u8(payload.length) : cat([0x80 | (payload.length >> 8), payload.length & 0xff])
    const mcs = cat([dir === 'in' ? 0x68 : 0x64], u16be(1002 - 1001), u16be(channel), [0x70], length, payload)
    const body = cat([0x02, 0xf0, 0x80], mcs)
    return cat([0x03, 0x00], u16be(4 + body.length), body)
}

/** A Share Data PDU (share control type 7) of `type2`. */
function shareData (dir: 'in' | 'out', type2: number, body: Buffer, shareId = 0x1234): Buffer {
    const data = cat(u32(shareId), [0, 1], u16(body.length + 4), [type2, 0], u16(0), body)
    const total = 6 + data.length
    return mcsData(dir, 1003, cat(u16(total), u16(0x17), u16(1002), data))
}

/** A Demand Active with a Bitmap capability set for `w`x`h` and a Frame Acknowledge set. */
function demandActive (w: number, h: number): Buffer {
    const bitmap = cat(u16(2), u16(28), u16(32), u16(1), u16(1), u16(1), u16(w), u16(h), Buffer.alloc(12))
    const frameAck = cat(u16(30), u16(8), u32(2))
    const caps = cat(u16(2), u16(0), bitmap, frameAck)
    const data = cat(u32(0x1234), u16(4), u16(caps.length), Buffer.from('RDP\0'), caps)
    return mcsData('in', 1003, cat(u16(6 + data.length), u16(0x11), u16(1002), data))
}

/** One static channel message, chunked at `chunk` bytes with FIRST/LAST flags. */
function svc (dir: 'in' | 'out', channel: number, message: Buffer, chunk = 1600): Buffer[] {
    const out: Buffer[] = []
    for (let at = 0; at < message.length; at += chunk) {
        const part = message.subarray(at, at + chunk)
        const flags = (at === 0 ? 1 : 0) | (at + chunk >= message.length ? 2 : 0)
        out.push(mcsData(dir, channel, cat(u32(message.length), u32(flags), part)))
    }
    return out
}

const dvcCreate = (id: number, name: string) => cat([0x10 | 0], [id], Buffer.from(name + '\0'))
const dvcData = (id: number, data: Buffer) => cat([0x30], [id], data)
const dvcDataFirst = (id: number, total: number, data: Buffer) => cat([0x20 | (1 << 2)], [id], u16(total), data)

/** An EGFX PDU with its RDPGFX_HEADER. */
const gfx = (cmd: number, body: Buffer) => cat(u16(cmd), u16(0), u32(8 + body.length), body)
/** A WireToSurface1 body on surface 0, AVC420, with `bitmap` as its data. */
const wire1 = (bitmap: Buffer, dest: Buffer) => cat(u16(0), u16(0x0b), [0x20], dest, u32(bitmap.length), bitmap)
/** EGFX PDUs as the wire carries them: one uncompressed ZGFX segment. */
const zgfxPlain = (pdus: Buffer) => cat([0xe0, 0x04], pdus)
const rect = (l: number, t: number, r: number, b: number) => cat(u16(l), u16(t), u16(r), u16(b))

/** An AVC420 bitmap stream: one region covering `rect`, and an H.264 access unit (Annex B) with an SPS for w x h. */
function avc420 (w: number, h: number, region: Buffer, idr: boolean): Buffer {
    const sps = spsFor(w, h)
    const nal = (type: number, body: number[]) => cat([0, 0, 0, 1, 0x60 | type], body)
    const h264 = cat(nal(7, sps), nal(8, [0xce, 0x38, 0x80]), nal(idr ? 5 : 1, [0x88, 0x84, 0x00]))
    return cat(u32(1), region, [0x16, 0x64], h264)
}

/** A High profile SPS declaring `w` x `h` (macroblock-aligned with cropping), as a bit string. */
function spsFor (w: number, h: number): number[] {
    const bits: number[] = []
    const put = (value: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1) }
    const ue = (v: number) => { const len = Math.floor(Math.log2(v + 1)); put(0, len); put(v + 1, len + 1) }
    put(100, 8); put(0, 8); put(51, 8); ue(0)       // profile, constraints, level, sps id
    ue(1); ue(0); ue(0); put(0, 1); put(0, 1)        // chroma 4:2:0, bit depths, qpprime, no scaling matrix
    ue(4); ue(0); ue(4); ue(1)                       // log2_max_frame_num, poc type 0, log2_max_poc_lsb, max_num_ref_frames
    put(0, 1)
    const mbw = Math.ceil(w / 16), mbh = Math.ceil(h / 16)
    ue(mbw - 1); ue(mbh - 1)
    put(1, 1); put(1, 1)                             // frame_mbs_only, direct_8x8
    const cropR = (mbw * 16 - w) / 2, cropB = (mbh * 16 - h) / 2
    if (cropR || cropB) { put(1, 1); ue(0); ue(cropR); ue(0); ue(cropB) } else { put(0, 1) }
    put(0, 1)                                        // no VUI
    put(1, 1)                                        // rbsp stop bit
    while (bits.length % 8) bits.push(0)
    const out: number[] = []
    for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2))
    return out
}

/** Fast-path update PDU with one or more updates (code, data). */
function fastPath (updates: { code: number, data: Buffer }[]): Buffer {
    const body = cat(...updates.map(u => cat([u.code & 0x0f], u16(u.data.length), u.data)))
    const len = 2 + body.length
    return cat([0x00], len < 128 ? u8(len) : cat([0x80 | ((len + 1) >> 8), (len + 1) & 0xff]), body)
}

/** A trace fed with a clock of its own. */
function tracing (): { trace: any, tick: (ms: number) => void } {
    let now = 1_700_000_000_000
    const trace = new PduTrace(() => now)
    return { trace, tick: ms => { now += ms } }
}

const names = (trace: any) => trace.events.map((e: any) => `${e.dir}:${e.name}`)

/** The connection's start on the I/O channel: a Connect Response naming the channels, so static channels are known. */
function channelsKnown (trace: any): void {
    // GCC Conference Create Request with "Duca" and the client's network data: drdynvc, cliprdr.
    const net = cat(u16(0xc003), u16(4 + 4 + 24), u32(2), Buffer.from('drdynvc\0'), u32(0), Buffer.from('cliprdr\0'), u32(0))
    const core = cat(u16(0xc001), u16(4 + 4 + 4 + 2 + 2 + 4 + 4 + 32), u32(0x80004), u16(1202), u16(746), u16(0xca01), u16(0xaa03), u32(0x409), u32(2600), Buffer.alloc(32))
    const request = cat(Buffer.from('Duca'), [0x80, 0x00], core, net)
    const initial = cat([0x7f, 0x65, 0x82, 0x00, 0x00], request)
    trace.stream('out', cat([0x03, 0x00], u16be(7 + initial.length), [0x02, 0xf0, 0x80], initial))
    const snet = cat(u16(0x0c03), u16(4 + 4 + 4), u16(1003), u16(2), u16(1004), u16(1005))
    const scoreBlock = cat(u16(0x0c01), u16(4 + 12), u32(0x80004), u32(0x0a), u32(0))
    const response = cat(Buffer.from('McDn'), [0x80, 0x00], scoreBlock, snet)
    const conf = cat([0x7f, 0x66, 0x82, 0x00, 0x00], response)
    trace.stream('in', cat([0x03, 0x00], u16be(7 + conf.length), [0x02, 0xf0, 0x80], conf))
}

// ---- tests ---------------------------------------------------------------------------------------

test('the X.224 exchange and the connect PDUs name the protocol and the channels', () => {
    const { trace } = tracing()
    const negReq = cat([0x01, 0x00], u16(8), u32(0x0b))
    const cookie = Buffer.from('Cookie: mstshash=user\r\n')
    const request = cat([0x03, 0x00], u16be(11 + cookie.length + negReq.length), [6 + cookie.length + negReq.length, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00], cookie, negReq)
    trace.x224('out', request)
    const negRsp = cat([0x02, 0x1f], u16(8), u32(0x08))
    trace.x224('in', cat([0x03, 0x00], u16be(11 + negRsp.length), [0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00], negRsp))
    channelsKnown(trace)
    const [req, rsp, initial, response] = trace.events
    assert.equal(req.name, 'ConnectionRequest')
    assert.equal(req.attrs.requestedProtocols, 'SSL|HYBRID|HYBRID_EX')
    assert.equal(rsp.attrs.selectedProtocol, 'HYBRID_EX')
    assert.match(String(rsp.attrs.flags), /DYNVC_GFX/)
    assert.equal(initial.name, 'ConnectInitial')
    assert.equal(initial.attrs.desktop, '1202x746')
    assert.equal(initial.attrs.channels, 'drdynvc,cliprdr')
    assert.equal(response.name, 'ConnectResponse')
    assert.equal(response.attrs.channelIds, '1004,1005')
    assert.equal(response.attrs.ioChannel, 1003)
})

test('CredSSP and the early user authorization result are framed, with nothing of their content', () => {
    const { trace } = tracing()
    const negRsp = cat([0x02, 0x1f], u16(8), u32(0x08))
    trace.x224('in', cat([0x03, 0x00], u16be(11 + negRsp.length), [0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00], negRsp))
    const token = cat([0x30, 0x10], Buffer.alloc(16, 0xaa))
    trace.stream('out', token.subarray(0, 5))
    trace.stream('out', token.subarray(5))
    trace.stream('in', cat([0x30, 0x05], Buffer.alloc(5, 0xbb), [0x00, 0x00, 0x00, 0x00]))
    assert.deepEqual(names(trace).slice(1), ['out:CredSSP.TSRequest', 'in:CredSSP.TSRequest', 'in:EarlyUserAuthorizationResult'])
    assert.equal(trace.events[3].attrs.result, 0)
    assert.ok(!JSON.stringify(trace.events).includes('aa'.repeat(8)))
})

test('share control and share data PDUs on the I/O channel', () => {
    const { trace } = tracing()
    trace.stream('in', demandActive(1202, 746))
    trace.stream('in', shareData('in', 0x37, cat(u32(1), u32(0), u32(0), u32(1201), u32(745), u32(1))))
    trace.stream('out', shareData('out', 0x38, u32(7)))
    trace.stream('in', shareData('in', 0x2f, u32(0x1192)))
    trace.stream('in', mcsData('in', 1003, cat(u16(6 + 4), u16(0x16), u16(1002), u32(0x1234))))
    const [demand, layout, ack, error, deactivate] = trace.events
    assert.equal(demand.name, 'DemandActive')
    assert.equal(demand.attrs.bitmapDesktop, '1202x746')
    assert.equal(demand.attrs.maxUnacknowledgedFrames, 2)
    assert.equal(demand.attrs.capabilitySets, 'Bitmap,FrameAcknowledge')
    assert.equal(layout.name, 'MonitorLayout')
    assert.equal(layout.attrs.monitors, '0,0-1201,745*')
    assert.equal(ack.name, 'FrameAcknowledge')
    assert.equal(ack.dir, 'out')
    assert.equal(ack.attrs.frameId, 7)
    assert.equal(error.attrs.errorInfo, 'GRAPHICS_SUBSYSTEM_FAILED')
    assert.equal(deactivate.name, 'DeactivateAll')
})

test('security-header PDUs are named by kind only, and auto-detect runs fold into one event', () => {
    const { trace, tick } = tracing()
    trace.stream('out', mcsData('out', 1003, cat(u16(0x0040), u16(0), Buffer.from('secret password bytes'))))
    trace.stream('in', mcsData('in', 1003, cat(u16(0x0080), u16(0), [0x01, 0x03], u16(100), Buffer.alloc(96, 0x11))))
    for (let i = 0; i < 5; i++) {
        trace.stream('in', mcsData('in', 1003, cat(u16(0x1000), u16(0), [6, 0], u16(i), u16(0x0014))))
        tick(5)
    }
    trace.stream('in', mcsData('in', 1003, cat(u16(0x1000), u16(0), [6, 0], u16(9), u16(0x002b))))
    assert.deepEqual(names(trace), ['out:ClientInfo', 'in:Licensing.LicenseRequest', 'in:AutoDetect.Request.BandwidthMeasureStart', 'in:AutoDetect.Request.BandwidthMeasureStop'])
    assert.equal(trace.events[2].repeat, 5)
    assert.equal(trace.events[2].until - trace.events[2].t, 20)
    assert.ok(!JSON.stringify(trace.events).includes('secret'))
})

test('fast-path updates: surface commands, bitmaps, pointers and fragments; input is counted, never kept', () => {
    const { trace } = tracing()
    const marker = (action: number, id: number) => cat(u16(4), u16(action), u32(id))
    const bits = cat(u16(1), rect(0, 0, 64, 64), [32, 0, 0, 3], u16(64), u16(64), u32(5), Buffer.alloc(5))
    trace.stream('in', fastPath([{ code: 4, data: cat(marker(0, 3), bits, marker(1, 3)) }]))
    const bitmap = cat(u16(1), u16(2), rect(0, 0, 15, 15), u16(16), u16(16), u16(32), u16(0x401), u16(2), Buffer.alloc(2), rect(16, 0, 31, 15), u16(16), u16(16), u16(32), u16(0), u16(2), Buffer.alloc(2))
    trace.stream('in', fastPath([{ code: 1, data: bitmap }, { code: 8, data: cat(u16(10), u16(20)) }]))
    // A pointer in two fragments (first, last).
    const pointer = cat(u16(32), u16(1), u16(2), u16(3), u16(32), u16(32), Buffer.alloc(8))
    trace.stream('in', cat([0x00], u8(2 + 3 + 8), [0x2b], u16(8), pointer.subarray(0, 8)))
    trace.stream('in', cat([0x00], u8(2 + 3 + (pointer.length - 8)), [0x1b], u16(pointer.length - 8), pointer.subarray(8)))
    // Input: two scan codes and a mouse move.
    trace.stream('out', cat([0x0c], u8(2 + 2 + 2 + 7), [0x00, 0x1e], [0x00, 0x1e], [0x20, 0, 0, 0, 0, 0, 0]))
    assert.deepEqual(names(trace), [
        'in:FrameMarker.Begin', 'in:SetSurfaceBits', 'in:FrameMarker.End', 'in:Bitmap', 'in:PositionPointer',
        'in:NewPointer', 'in:NewPointer', 'out:Input',
    ])
    const [, surface, , bmp, pos, first, last, input] = trace.events
    assert.equal(surface.attrs.codec, 'RemoteFX')
    assert.equal(surface.attrs.dest, '0,0-64,64')
    assert.equal(bmp.attrs.rectangles, 2)
    assert.equal(bmp.attrs.union, '0,0-31,15')
    assert.equal(bmp.attrs.compressed, 1)
    assert.equal(pos.attrs.position, '10,20')
    assert.equal(first.attrs.fragment, 'first')
    assert.equal(last.attrs.size, '32x32')
    assert.equal(input.attrs.ScanCode, 2)
    assert.equal(input.attrs.Mouse, 1)
    assert.ok(!('scancode' in input.attrs) && !JSON.stringify(input).includes('"30"'))
})

test('static channels reassemble their chunks; drdynvc opens channels, display control and the graphics pipeline decode', () => {
    const { trace } = tracing()
    channelsKnown(trace)
    const before = trace.events.length
    // cliprdr, in two chunks.
    for (const pdu of svc('in', 1005, cat(u16(1), u16(0), u32(2000), Buffer.alloc(2000)), 1600)) {
        trace.stream('in', pdu)
    }
    // drdynvc: capabilities, the Graphics and DisplayControl channels created, the client's answers.
    trace.stream('in', ...svc('in', 1004, cat([0x50, 0x00], u16(3), u16(0), u16(0), u16(0), u16(0))))
    trace.stream('out', ...svc('out', 1004, cat([0x50, 0x00], u16(3))))
    trace.stream('in', ...svc('in', 1004, dvcCreate(7, 'Microsoft::Windows::RDS::Graphics')))
    trace.stream('out', ...svc('out', 1004, cat([0x10], [7], u32(0))))
    trace.stream('in', ...svc('in', 1004, dvcCreate(10, 'Microsoft::Windows::RDS::DisplayControl')))
    trace.stream('in', ...svc('in', 1004, dvcData(10, cat(u32(5), u32(20), u32(16), u32(8192), u32(8192)))))
    // The client's monitor layout (one monitor) and capability advertisement.
    const layout = cat(u32(2), u32(8 + 8 + 40), u32(40), u32(1), u32(1), u32(0), u32(0), u32(2056), u32(1252), u32(0), u32(0), u32(0), u32(100), u32(100))
    trace.stream('out', ...svc('out', 1004, dvcData(10, layout)))
    const caps = gfx(0x12, cat(u16(1), u32(0xa0700), u32(4), u32(0x02)))
    trace.stream('out', ...svc('out', 1004, dvcData(7, zgfxPlain(caps))))
    // The server's EGFX, in a DataFirst + Data pair: caps confirm, reset, surface, map, a frame.
    const frame = cat(
        gfx(0x13, cat(u32(0xa0700), u32(4), u32(0x02))),
        gfx(0x0e, cat(u32(2056), u32(1252), u32(1), u32(0), u32(0), u32(2055), u32(1251), u32(1), Buffer.alloc(340 - 8 - 32))),
        gfx(0x09, cat(u16(0), u16(2056), u16(1252), [0x20])),
        gfx(0x17, cat(u16(0), u16(0), u32(0), u32(0), u32(2056), u32(1252))),
        gfx(0x0b, cat(u32(12345), u32(1))),
        gfx(0x01, wire1(avc420(2056, 1252, rect(0, 0, 2056, 1252), true), rect(0, 0, 2056, 1252))),
        gfx(0x04, cat(u16(0), [0x10, 0x20, 0x30, 0xff], u16(1), rect(0, 0, 10, 10))),
        gfx(0x0c, u32(1)),
    )
    const wire = zgfxPlain(frame)
    const half = Math.floor(wire.length / 2)
    trace.stream('in', ...svc('in', 1004, dvcDataFirst(7, wire.length, wire.subarray(0, half))))
    trace.stream('in', ...svc('in', 1004, dvcData(7, wire.subarray(half))))
    // IronRDP sends its own EGFX PDUs without the segmented wrapper; Windows takes them, and so does the trace.
    trace.stream('out', ...svc('out', 1004, dvcData(7, gfx(0x0d, cat(u32(0), u32(1), u32(1))))))
    assert.deepEqual(names(trace).slice(before), [
        'in:cliprdr.MonitorReady',
        'in:DVC.CapabilitiesRequest', 'out:DVC.CapabilitiesResponse',
        'in:DVC.CreateRequest', 'out:DVC.CreateResponse', 'in:DVC.CreateRequest',
        'in:DisplayControl.Caps', 'out:DisplayControl.MonitorLayout', 'out:EGFX.CapsAdvertise',
        'in:EGFX.CapsConfirm', 'in:EGFX.ResetGraphics', 'in:EGFX.CreateSurface', 'in:EGFX.MapSurfaceToScaledOutput',
        'in:EGFX.StartFrame', 'in:EGFX.WireToSurface1', 'in:EGFX.SolidFill', 'in:EGFX.EndFrame',
        'out:EGFX.FrameAcknowledge',
    ])
    const by = (name: string) => trace.events.find((e: any) => e.name === name).attrs
    assert.equal(by('DVC.CreateResponse').name, 'Microsoft::Windows::RDS::Graphics')
    assert.equal(by('DVC.CreateResponse').status, 'ok')
    assert.equal(by('DisplayControl.MonitorLayout').width, 2056)
    assert.match(String(by('DisplayControl.MonitorLayout').monitors), /^2056x1252@0,0\* 0x0mm 0° 100%\/100%$/)
    assert.equal(by('EGFX.CapsAdvertise').capabilitySets, 'V10.7:0x2')
    assert.equal(by('EGFX.CapsConfirm').version, 'V10.7')
    assert.equal(by('EGFX.ResetGraphics').width, 2056)
    assert.equal(by('EGFX.CreateSurface').height, 1252)
    assert.equal(by('EGFX.MapSurfaceToScaledOutput').target, '2056x1252')
    const avc = by('EGFX.WireToSurface1')
    assert.equal(avc.codec, 'AVC420')
    assert.equal(avc.regions, 1)
    assert.equal(avc.regionArea, 2056 * 1252)
    assert.equal(avc.keyFrame, true)
    assert.equal(avc.picture, '2056x1252')
    assert.equal(avc.qp, '22')
    assert.equal(by('EGFX.SolidFill').color, '#302010')
    assert.equal(by('EGFX.FrameAcknowledge').queueDepth, 'suspend')
    // No wire bytes of the H.264 or the bitmaps are kept.
    assert.ok(!JSON.stringify(trace.events).includes('bitmapData'))
})

test('inspectH264 reads the picture size out of an SPS with cropping, Annex B or length-prefixed', () => {
    const sps = Buffer.from(spsFor(1202, 746))
    const annexB = cat([0, 0, 0, 1, 0x67], sps, [0, 0, 0, 1, 0x65, 0x88])
    assert.deepEqual(inspectH264(annexB), { keyFrame: true, sps: true, nals: 2, width: 1202, height: 746 })
    const prefixed = cat(Buffer.from([0, 0, 0, sps.length + 1]), [0x67], sps, [0, 0, 0, 2, 0x41, 0x9a])
    assert.deepEqual(inspectH264(prefixed), { keyFrame: false, sps: true, nals: 2, width: 1202, height: 746 })
})

test('a resize to a larger size becomes a span that settles on the first acknowledged frame at the new size', () => {
    const { trace, tick } = tracing()
    channelsKnown(trace)
    trace.stream('in', ...svc('in', 1004, dvcCreate(7, 'Microsoft::Windows::RDS::Graphics')))
    trace.stream('in', ...svc('in', 1004, dvcCreate(10, 'Microsoft::Windows::RDS::DisplayControl')))
    const egfxIn = (pdus: Buffer) => trace.stream('in', ...svc('in', 1004, dvcData(7, zgfxPlain(pdus))))
    const egfxOut = (pdus: Buffer) => trace.stream('out', ...svc('out', 1004, dvcData(7, zgfxPlain(pdus))))
    const frame = (id: number, w: number, h: number, key: boolean) => cat(
        gfx(0x0b, cat(u32(0), u32(id))),
        gfx(0x01, wire1(avc420(w, h, rect(0, 0, w, h), key), rect(0, 0, w, h))),
        gfx(0x0c, u32(id)),
    )
    // Steady state at 1202x746.
    egfxIn(cat(gfx(0x0e, cat(u32(1202), u32(746), u32(0), Buffer.alloc(340 - 20))), gfx(0x09, cat(u16(0), u16(1202), u16(746), [0x20])), gfx(0x17, cat(u16(0), u16(0), u32(0), u32(0), u32(1202), u32(746)))))
    egfxIn(frame(1, 1202, 746, true))
    tick(3)
    egfxOut(gfx(0x0d, cat(u32(0), u32(1), u32(1))))
    tick(100)
    // The pane grows: the plugin asks, the server resets, a key frame at the new size comes and is acknowledged.
    trace.local('plugin', 'Resize.Requested', { width: 2056, height: 1252, scale: 100 })
    const layout = cat(u32(2), u32(8 + 8 + 40), u32(40), u32(1), u32(1), u32(0), u32(0), u32(2056), u32(1252), u32(0), u32(0), u32(0), u32(100), u32(100))
    trace.stream('out', ...svc('out', 1004, dvcData(10, layout)))
    tick(18)
    egfxIn(gfx(0x0a, u16(0)))
    tick(48)
    egfxIn(gfx(0x0e, cat(u32(2056), u32(1252), u32(0), Buffer.alloc(340 - 20))))
    tick(33)
    egfxIn(cat(gfx(0x09, cat(u16(0), u16(2056), u16(1252), [0x20])), gfx(0x17, cat(u16(0), u16(0), u32(0), u32(0), u32(2056), u32(1252)))))
    tick(40)
    egfxIn(frame(2, 2056, 1252, true))
    trace.local('decoder', 'H264.Handed', { id: 1, surfaceId: 0, keyFrame: true, bytes: 100, regions: 1 })
    tick(12)
    trace.local('decoder', 'H264.Decoded', { id: 1, bytes: 2056 * 1252 * 4, latencyMs: 12 })
    trace.local('canvas', 'Canvas.Resized', { width: 2056, height: 1252 })
    trace.local('canvas', 'Canvas.Draw', { x: 0, y: 0, width: 2056, height: 1252 })
    tick(2)
    egfxOut(gfx(0x0d, cat(u32(0), u32(2), u32(2))))
    tick(500)
    const spans = deriveSpans(trace.events, trace.startedAt, trace.startedAt + 2000)
    const resize = spans.find((s: any) => s.name === 'rdp.resize')
    assert.ok(resize, 'a resize span')
    assert.equal(resize.status?.code, 'ok')
    assert.equal(resize.attrs.width, 2056)
    assert.equal(resize.attrs.resetAfterMs, 66)
    assert.equal(resize.attrs.surface, '2056x1252')
    assert.equal(resize.attrs.firstFrameId, 2)
    assert.equal(resize.attrs.firstFrameKeyFrame, true)
    assert.equal(resize.attrs.settledAfterMs, 153)
    assert.equal(resize.attrs.deactivation, undefined)
    assert.deepEqual(resize.events.map((e: any) => e.name).filter((n: string) => !n.startsWith('H264') && !n.startsWith('Canvas')),
        ['DisplayControl.MonitorLayout', 'EGFX.DeleteSurface', 'EGFX.ResetGraphics', 'EGFX.CreateSurface', 'EGFX.MapSurfaceToScaledOutput'])
    const frames = spans.filter((s: any) => s.name === 'egfx.frame')
    assert.equal(frames.length, 2)
    assert.equal(frames[1].parent, resize.id)
    assert.equal(frames[1].attrs.ackAfterMs, 14)
    assert.equal(frames[1].attrs['codec.AVC420'], 1)
    assert.equal(frames[1].attrs.keyFrame, true)
    const decode = spans.find((s: any) => s.name === 'h264.decode')
    assert.equal(decode.attrs.outcome, 'decoded')
    assert.equal(decode.attrs.latencyMs, 12)
    assert.equal(decode.parent, frames[1].id)
    // Another request before the first settles fails the first; one the server never answers fails after ten seconds.
    trace.stream('out', ...svc('out', 1004, dvcData(10, layout)))
    tick(50)
    trace.stream('out', ...svc('out', 1004, dvcData(10, layout)))
    tick(11_000)
    trace.local('plugin', 'Connection.Ended')
    const again = deriveSpans(trace.events, trace.startedAt, trace.startedAt + 20_000).filter((s: any) => s.name === 'rdp.resize')
    assert.equal(again.length, 3)
    assert.match(again[1].status.message, /another resize/)
    assert.match(again[2].status.message, /did not reset/)
})

test('a legacy resize goes through deactivation and reactivation, settling on the first update', () => {
    const { trace, tick } = tracing()
    channelsKnown(trace)
    trace.stream('in', ...svc('in', 1004, dvcCreate(10, 'Microsoft::Windows::RDS::DisplayControl')))
    trace.stream('in', demandActive(1202, 746))
    trace.stream('in', shareData('in', 0x28, u32(0)))
    const layout = cat(u32(2), u32(8 + 8 + 40), u32(40), u32(1), u32(1), u32(0), u32(0), u32(1600), u32(900), u32(0), u32(0), u32(0), u32(100), u32(100))
    trace.stream('out', ...svc('out', 1004, dvcData(10, layout)))
    tick(20)
    trace.stream('in', mcsData('in', 1003, cat(u16(10), u16(0x16), u16(1002), u32(0x1234))))
    tick(5)
    trace.stream('in', demandActive(1600, 900))
    tick(5)
    trace.stream('in', shareData('in', 0x28, u32(0)))
    tick(30)
    trace.stream('in', fastPath([{ code: 4, data: cat(u16(4), u16(0), u32(9), u16(1), rect(0, 0, 1600, 900), [32, 0, 0, 3], u16(1600), u16(900), u32(1), [0], u16(4), u16(1), u32(9)) }]))
    const spans = deriveSpans(trace.events, trace.startedAt, trace.startedAt + 1000)
    const resize = spans.find((s: any) => s.name === 'rdp.resize')
    assert.equal(resize.attrs.deactivation, true)
    assert.equal(resize.status?.code, 'ok')
    assert.equal(resize.attrs.settledAfterMs, 60)
    assert.deepEqual(spans.filter((s: any) => /activation/.test(s.name)).map((s: any) => [s.name, s.attrs.desktop]), [['rdp.activation', '1202x746'], ['rdp.reactivation', '1600x900']])
    assert.equal(spans.find((s: any) => s.name === 'rdp.reactivation').parent, resize.id)
    assert.equal(spans.find((s: any) => s.name === 'fastpath.frame').attrs.updates, 1)
})

test('the OTLP export has the resource, one scope, nested spans and typed attributes', () => {
    const { trace, tick } = tracing()
    trace.local('plugin', 'Connected', { width: 1202, height: 746, fit: true, ratio: 1.5 })
    tick(10)
    const otlp: any = exportOtlp(trace.events, { pluginVersion: '0.6.0', desktop: 'Test', destination: 'host:3389', client: 'ironrdp', platform: 'darwin' }, trace.startedAt, trace.startedAt + 10, 3)
    const rs = otlp.resourceSpans[0]
    const resource = Object.fromEntries(rs.resource.attributes.map((a: any) => [a.key, a.value]))
    assert.deepEqual(resource['service.name'], { stringValue: 'tabby-rdp' })
    assert.deepEqual(resource['trace.events.dropped'], { intValue: '3' })
    assert.equal(rs.scopeSpans[0].scope.name, 'tabby-rdp.pdu-trace')
    const [root] = rs.scopeSpans[0].spans
    assert.equal(root.name, 'rdp.connection')
    assert.equal(root.parentSpanId, undefined)
    assert.match(root.startTimeUnixNano, /^\d+$/)
    assert.equal(BigInt(root.endTimeUnixNano) - BigInt(root.startTimeUnixNano), 10_000_000n)
    const event = root.events[0]
    const attrs = Object.fromEntries(event.attributes.map((a: any) => [a.key, a.value]))
    assert.deepEqual(attrs.width, { intValue: '1202' })
    assert.deepEqual(attrs.fit, { boolValue: true })
    assert.deepEqual(attrs.ratio, { doubleValue: 1.5 })
    assert.deepEqual(attrs.dir, { stringValue: 'local' })
})

test('the events are bounded', () => {
    const { trace } = tracing()
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
        trace.local('plugin', 'Tick', { i })
    }
    assert.equal(trace.events.length, MAX_EVENTS)
    assert.equal(trace.dropped, 5)
    assert.equal(trace.events[0].attrs.i, 5)
})

test('the H.264 decoder wrapper traces each access unit and its result, passing everything through', async () => {
    const { trace, tick } = tracing()
    const calls: any[] = []
    const decoder = {
        stats: { frames: 0 },
        decode (frame: any, done: (id: number, pixels: Uint8Array | null, error?: string) => void) { calls.push(['decode', frame.id]); tick(7); done(frame.id, frame.id === 2 ? null : new Uint8Array(16)) },
        endSurfaces (ids: number[]) { calls.push(['end', ids]) },
        close () { calls.push(['close']) },
    }
    const wrapped = trace.wrapH264Decoder(decoder)
    const results: any[] = []
    wrapped.decode({ id: 1, surfaceId: 0, keyFrame: true, data: new Uint8Array(100), destination: { left: 0, top: 0, right: 8, bottom: 8 }, regions: [{ left: 0, top: 0, right: 8, bottom: 8 }], endedSurfaces: [0] }, (id: number, pixels: any) => results.push([id, pixels?.length]))
    wrapped.decode({ id: 2, surfaceId: 0, keyFrame: false, data: new Uint8Array(10), destination: { left: 0, top: 0, right: 8, bottom: 8 }, regions: [] }, (id: number, pixels: any) => results.push([id, pixels]))
    wrapped.endSurfaces([0])
    assert.equal(wrapped.stats, decoder.stats)
    assert.deepEqual(calls, [['decode', 1], ['decode', 2], ['end', [0]]])
    assert.deepEqual(results, [[1, 16], [2, null]])
    assert.deepEqual(names(trace), ['local:H264.Handed', 'local:H264.Decoded', 'local:H264.Handed', 'local:H264.Skipped', 'local:H264.EndSurfaces'])
    assert.equal(trace.events[0].attrs.endedSurfaces, '0')
    assert.equal(trace.events[0].attrs.regionArea, 64)
    assert.equal(trace.events[1].attrs.latencyMs, 7)
})
