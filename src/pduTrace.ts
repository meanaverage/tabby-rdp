/**
 * The PDU trace: every RDP PDU that passes the plugin's RDCleanPath proxy (see rdcleanpath.ts), decoded and stamped,
 * with what the client does with them on this side (the H.264 decoder, the canvas, the plugin's resize requests),
 * exported as an OpenTelemetry trace (OTLP/JSON, `resourceSpans`) next to the diagnostic log file, for
 * tools/pdu-trace (a viewer of the exact PDU flow of a connection and of a resize) and for the tests that check the
 * flow (test/unit/pdu-trace.ts, test/suites/pdu-trace.ts).
 *
 * Where it reads: between the proxy and IronRDP in Tabby's window, the RDP stream is in the clear (TLS is the
 * proxy's, toward the server), so the trace sees X.224, MCS, the share control and data PDUs, the fast-path updates
 * and input, the static channels and, inside drdynvc, the dynamic channels: the graphics pipeline (ZGFX-compressed,
 * decompressed here with src/zgfx.ts) and display control among them. It decodes structure and sizes, never content
 * that could be a secret: no CredSSP tokens, licensing material, keystrokes or clipboard data go into a trace, only
 * their kinds and lengths. Bitmap and H.264 payloads are described (codec, rectangle, bytes, key frame), not kept.
 *
 * What it costs: a few microseconds a PDU, and memory for the events (bounded: the oldest go once there are
 * MAX_EVENTS, and the trace says how many went). The ZGFX histories are 2.5 MB each way. Only while the diagnostic
 * log is on.
 */
import { ZgfxDecompressor } from './zgfx'

export type Direction = 'in' | 'out'

export type Layer = 'x224' | 'mcs' | 'sec' | 'share' | 'fastpath' | 'svc' | 'dvc' | 'egfx' | 'displaycontrol' | 'plugin' | 'decoder' | 'canvas' | 'trace'

export type AttrValue = string | number | boolean

export interface TraceEvent {
    seq: number
    /** Milliseconds since the epoch, with a fraction. */
    t: number
    /** `in`: from the server; `out`: from the client; `local`: this side (the plugin, the decoder, the canvas). */
    dir: Direction | 'local'
    layer: Layer
    name: string
    /** Bytes on the wire (0 for a local event). */
    bytes: number
    attrs: Record<string, AttrValue>
    /** How many identical events in a row this one stands for (see coalesce). */
    repeat?: number
    /** The time of the last of them. */
    until?: number
}

export interface TraceSpan {
    id: string
    parent?: string
    name: string
    start: number
    end: number
    attrs: Record<string, AttrValue>
    events: TraceEvent[]
    status?: { code: 'ok' | 'error', message?: string }
}

/** What the plugin says about the connection, for the trace's resource attributes. */
export interface TraceMeta {
    pluginVersion: string
    desktop: string
    destination: string
    client: string
    graphics?: string
    platform: string
    electron?: string
}

/** The most events kept; the oldest go past it. */
export const MAX_EVENTS = 150_000

const TPKT_VERSION = 0x03

// ---- byte reading ----------------------------------------------------------------------------

class Reader {
    pos = 0
    private readonly view: DataView
    constructor (readonly data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    }

    get remaining (): number { return this.data.length - this.pos }

    need (n: number): void {
        if (this.pos + n > this.data.length) {
            throw new RangeError(`needs ${n} more bytes at ${this.pos}, ${this.remaining} left`)
        }
    }

    u8 (): number { this.need(1); return this.data[this.pos++] }
    u16 (): number { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v }
    u16be (): number { this.need(2); const v = this.view.getUint16(this.pos, false); this.pos += 2; return v }
    i32 (): number { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v }
    u32 (): number { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v }
    u64 (): bigint { this.need(8); const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return v }
    skip (n: number): void { this.need(n); this.pos += n }
    bytes (n: number): Uint8Array { this.need(n); const out = this.data.subarray(this.pos, this.pos + n); this.pos += n; return out }
    rest (): Uint8Array { return this.data.subarray(this.pos) }
    /** A PER length determinant: one byte under 128, else two with the high bits 10. */
    perLength (): number {
        const b = this.u8()
        if ((b & 0xc0) === 0x80) {
            return ((b & 0x3f) << 8) | this.u8()
        }
        return b
    }
}

function rect16 (r: Reader): string {
    const left = r.u16(), top = r.u16(), right = r.u16(), bottom = r.u16()
    return `${left},${top}-${right},${bottom}`
}

function hex (n: number): string {
    return '0x' + n.toString(16)
}

// ---- framing (one PDU at a time out of a byte stream) ----------------------------------------

/**
 * Splits one direction of the relayed stream into PDUs: CredSSP's DER messages first, then (after the server chose
 * HYBRID_EX) the four-byte Early User Authorization Result from the server, then TPKT-framed X.224 and fast-path
 * PDUs. The same rules the proxy frames the server's bytes with (rdcleanpath.ts, serverFraming), for both ways.
 */
class Framer {
    private buf: Uint8Array = new Uint8Array(0)
    private rdp = false
    private earlyDone = false
    constructor (private readonly earlyAuth: () => boolean, private readonly dir: Direction) { }

    push (data: Uint8Array): { kind: FrameKind, data: Uint8Array }[] {
        this.buf = this.buf.length ? concat(this.buf, data) : data
        const out: { kind: FrameKind, data: Uint8Array }[] = []
        for (;;) {
            const [kind, len] = this.lengthOf(this.buf)
            if (!len || this.buf.length < len) {
                break
            }
            out.push({ kind, data: this.buf.subarray(0, len) })
            this.buf = this.buf.subarray(len)
            if (kind === 'tpkt' || kind === 'fastpath') {
                this.rdp = true
            } else if (kind === 'early') {
                this.earlyDone = true
            }
        }
        return out
    }

    private lengthOf (b: Uint8Array): [FrameKind, number] {
        if (b.length < 2) {
            return ['unknown', 0]
        }
        if (!this.rdp && b[0] === 0x30) {
            if (!(b[1] & 0x80)) {
                return ['der', 2 + b[1]]
            }
            const octets = b[1] & 0x7f
            if (b.length < 2 + octets) {
                return ['der', 0]
            }
            let content = 0
            for (let i = 0; i < octets; i++) {
                content = content * 256 + b[2 + i]
            }
            return ['der', 2 + octets + content]
        }
        // The Early User Authorization Result: four bytes (a u32: 0 success, 5 access denied), once, before any TPKT.
        if (!this.rdp && !this.earlyDone && this.dir === 'in' && this.earlyAuth() && b[0] !== TPKT_VERSION) {
            return ['early', 4]
        }
        if (b[0] === TPKT_VERSION) {
            if (b.length < 4) {
                return ['tpkt', 0]
            }
            return ['tpkt', (b[2] << 8) | b[3]]
        }
        if ((b[0] & 0x03) === 0) {
            // Fast-path: a one- or two-byte length (the high bit says two).
            if (!(b[1] & 0x80)) {
                return ['fastpath', b[1]]
            }
            if (b.length < 3) {
                return ['fastpath', 0]
            }
            return ['fastpath', ((b[1] & 0x7f) << 8) | b[2]]
        }
        // Not RDP as this trace knows it: take the byte so the stream goes on.
        return ['unknown', 1]
    }
}

type FrameKind = 'der' | 'early' | 'tpkt' | 'fastpath' | 'unknown'

function concat (a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
}

// ---- names ------------------------------------------------------------------------------------

const SHARE_DATA_TYPES: Record<number, string> = {
    0x02: 'Update', 0x14: 'Control', 0x1b: 'Pointer', 0x1c: 'Input', 0x1f: 'Synchronize', 0x21: 'RefreshRectangle',
    0x22: 'PlaySound', 0x23: 'SuppressOutput', 0x24: 'ShutdownRequest', 0x25: 'ShutdownDenied', 0x26: 'SaveSessionInfo',
    0x27: 'FontList', 0x28: 'FontMap', 0x29: 'SetKeyboardIndicators', 0x2b: 'BitmapCachePersistentList',
    0x2c: 'BitmapCacheError', 0x2d: 'SetKeyboardImeStatus', 0x2e: 'OffscreenCacheError', 0x2f: 'SetErrorInfo',
    0x30: 'DrawNineGridError', 0x31: 'DrawGdiPlusError', 0x32: 'ArcStatus', 0x36: 'StatusInfo', 0x37: 'MonitorLayout',
    0x38: 'FrameAcknowledge',
}

const CAPABILITY_SETS: Record<number, string> = {
    1: 'General', 2: 'Bitmap', 3: 'Order', 4: 'BitmapCache', 5: 'Control', 7: 'WindowActivation', 8: 'Pointer', 9: 'Share',
    10: 'ColorCache', 12: 'Sound', 13: 'Input', 14: 'Font', 15: 'Brush', 16: 'GlyphCache', 17: 'OffscreenBitmapCache',
    18: 'BitmapCacheHostSupport', 19: 'BitmapCacheRev2', 20: 'VirtualChannel', 21: 'DrawNineGridCache', 22: 'DrawGdiPlus',
    23: 'Rail', 24: 'Window', 25: 'CompDesk', 26: 'MultifragmentUpdate', 27: 'LargePointer', 28: 'SurfaceCommands',
    29: 'BitmapCodecs', 30: 'FrameAcknowledge',
}

const CODEC_GUIDS: Record<string, string> = {
    'ca8d1bb9-000f-154f-589f-ae2d1a87e2d6': 'NSCodec',
    '76772f12-bd72-4463-afb3-b73c9c6f7886': 'RemoteFX',
    '2744ccd4-9d8a-4e74-803c-0ecbeea19c54': 'RemoteFX Image',
    '9c4351a6-3535-42ae-910c-cdfce5760b58': 'Ignore',
}

const ERROR_INFO: Record<number, string> = {
    0x0: 'NONE', 0x1: 'RPC_INITIATED_DISCONNECT', 0x2: 'RPC_INITIATED_LOGOFF', 0x3: 'IDLE_TIMEOUT', 0x4: 'LOGON_TIMEOUT',
    0x5: 'DISCONNECTED_BY_OTHERCONNECTION', 0x6: 'OUT_OF_MEMORY', 0x7: 'SERVER_DENIED_CONNECTION', 0x9: 'SERVER_INSUFFICIENT_PRIVILEGES',
    0xa: 'SERVER_FRESH_CREDENTIALS_REQUIRED', 0xb: 'RPC_INITIATED_DISCONNECT_BYUSER', 0xc: 'LOGOFF_BY_USER',
    0x10c9: 'LICENSE_INTERNAL', 0x10ca: 'LICENSE_NO_LICENSE_SERVER', 0x10cb: 'LICENSE_NO_LICENSE', 0x10cc: 'LICENSE_BAD_CLIENT_MSG',
    0x10cd: 'LICENSE_HWID_DOESNT_MATCH_LICENSE', 0x10ce: 'LICENSE_BAD_CLIENT_LICENSE', 0x10cf: 'LICENSE_CANT_FINISH_PROTOCOL',
    0x10d0: 'LICENSE_CLIENT_ENDED_PROTOCOL', 0x10d1: 'LICENSE_BAD_CLIENT_ENCRYPTION', 0x10d2: 'LICENSE_CANT_UPGRADE_LICENSE',
    0x10d3: 'LICENSE_NO_REMOTE_CONNECTIONS', 0x1192: 'GRAPHICS_SUBSYSTEM_FAILED',
}

const AUTODETECT_TYPES: Record<number, string> = {
    0x0001: 'RttMeasureRequest', 0x1001: 'RttMeasureRequest', 0x0014: 'BandwidthMeasureStart', 0x0114: 'BandwidthMeasureStart',
    0x1014: 'BandwidthMeasureStart', 0x0002: 'BandwidthMeasurePayload', 0x002b: 'BandwidthMeasureStop', 0x0429: 'BandwidthMeasureStop',
    0x042b: 'BandwidthMeasureStop', 0x0840: 'NetworkCharacteristicsResult', 0x0000: 'RttMeasureResponse', 0x0003: 'BandwidthMeasureResults',
    0x000b: 'BandwidthMeasureResults', 0x0018: 'NetworkCharacteristicsSync',
}

const LICENSE_TYPES: Record<number, string> = {
    0x01: 'LicenseRequest', 0x02: 'PlatformChallenge', 0x03: 'NewLicense', 0x04: 'UpgradeLicense', 0x12: 'LicenseInfo',
    0x13: 'NewLicenseRequest', 0x15: 'PlatformChallengeResponse', 0xff: 'ErrorAlert',
}

const FASTPATH_UPDATES: Record<number, string> = {
    0: 'Orders', 1: 'Bitmap', 2: 'Palette', 3: 'Synchronize', 4: 'SurfaceCommands', 5: 'HiddenPointer', 6: 'DefaultPointer',
    8: 'PositionPointer', 9: 'ColorPointer', 10: 'CachedPointer', 11: 'NewPointer', 12: 'LargePointer',
}

const SURFACE_CODECS: Record<number, string> = { 0: 'Uncompressed', 1: 'NSCodec', 3: 'RemoteFX' }

const EGFX_COMMANDS: Record<number, string> = {
    0x01: 'WireToSurface1', 0x02: 'WireToSurface2', 0x03: 'DeleteEncodingContext', 0x04: 'SolidFill', 0x05: 'SurfaceToSurface',
    0x06: 'SurfaceToCache', 0x07: 'CacheToSurface', 0x08: 'EvictCacheEntry', 0x09: 'CreateSurface', 0x0a: 'DeleteSurface',
    0x0b: 'StartFrame', 0x0c: 'EndFrame', 0x0d: 'FrameAcknowledge', 0x0e: 'ResetGraphics', 0x0f: 'MapSurfaceToOutput',
    0x10: 'CacheImportOffer', 0x11: 'CacheImportReply', 0x12: 'CapsAdvertise', 0x13: 'CapsConfirm', 0x15: 'MapSurfaceToWindow',
    0x16: 'QoeFrameAcknowledge', 0x17: 'MapSurfaceToScaledOutput', 0x18: 'MapSurfaceToScaledWindow',
}

const EGFX_CODECS: Record<number, string> = {
    0x0: 'Uncompressed', 0x3: 'RemoteFX', 0x8: 'ClearCodec', 0x9: 'Progressive', 0xa: 'Planar', 0xb: 'AVC420', 0xc: 'Alpha',
    0xd: 'ProgressiveV2', 0xe: 'AVC444', 0xf: 'AVC444v2',
}

const EGFX_CAP_VERSIONS: Record<number, string> = {
    0x80004: 'V8', 0x80105: 'V8.1', 0xa0002: 'V10', 0xa0100: 'V10.1', 0xa0200: 'V10.2', 0xa0301: 'V10.3', 0xa0400: 'V10.4',
    0xa0502: 'V10.5', 0xa0600: 'V10.6', 0xa0601: 'V10.6err', 0xa0700: 'V10.7',
}

const CLIPRDR_TYPES: Record<number, string> = {
    1: 'MonitorReady', 2: 'FormatList', 3: 'FormatListResponse', 4: 'FormatDataRequest', 5: 'FormatDataResponse',
    6: 'TempDirectory', 7: 'Capabilities', 8: 'FileContentsRequest', 9: 'FileContentsResponse', 10: 'LockClipData', 11: 'UnlockClipData',
}

const RDPDR_PACKETS: Record<number, string> = {
    0x496e: 'ServerAnnounce', 0x4343: 'ClientIdConfirm', 0x434e: 'ClientName', 0x4441: 'DeviceListAnnounce', 0x6472: 'DeviceReply',
    0x4952: 'DeviceIoRequest', 0x4943: 'DeviceIoCompletion', 0x5350: 'ServerCapability', 0x4350: 'ClientCapability',
    0x444d: 'DeviceListRemove', 0x554c: 'UserLoggedOn',
}

const RDPSND_TYPES: Record<number, string> = {
    1: 'Close', 2: 'Wave', 3: 'SetVolume', 4: 'SetPitch', 5: 'WaveConfirm', 6: 'Training', 7: 'Formats', 8: 'CryptKey',
    9: 'WaveEncrypt', 10: 'UdpWave', 11: 'UdpWaveLast', 12: 'QualityMode', 13: 'Wave2',
}

const DVC_COMMANDS: Record<number, string> = {
    1: 'Create', 2: 'DataFirst', 3: 'Data', 4: 'Close', 5: 'Capabilities', 6: 'DataFirstCompressed', 7: 'DataCompressed',
    8: 'SoftSyncRequest', 9: 'SoftSyncResponse',
}

// ---- H.264 stream inspection ------------------------------------------------------------------

/** What an H.264 access unit shows from the outside: its NAL unit types, and the picture size its SPS declares. */
export function inspectH264 (data: Uint8Array): { keyFrame: boolean, sps: boolean, width?: number, height?: number, nals: number } {
    let keyFrame = false
    let sps = false
    let nals = 0
    let size: { width: number, height: number } | undefined
    for (const nal of nalUnits(data)) {
        nals++
        const type = nal[0] & 0x1f
        if (type === 5) {
            keyFrame = true
        } else if (type === 7) {
            sps = true
            size ??= parseSps(nal) ?? undefined
        }
    }
    return { keyFrame, sps, nals, ...size }
}

function* nalUnits (data: Uint8Array): Generator<Uint8Array> {
    // Annex B (start codes), or four-byte length prefixes.
    const starts: number[] = []
    for (let i = 0; i + 3 <= data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            starts.push(i + 3)
            i += 2
        }
    }
    if (starts.length) {
        for (let k = 0; k < starts.length; k++) {
            let end = k + 1 < starts.length ? starts[k + 1] - 3 : data.length
            while (end > starts[k] && data[end - 1] === 0) {
                end--
            }
            if (end > starts[k]) {
                yield data.subarray(starts[k], end)
            }
        }
        return
    }
    let at = 0
    while (at + 4 <= data.length) {
        const len = (data[at] << 24 | data[at + 1] << 16 | data[at + 2] << 8 | data[at + 3]) >>> 0
        at += 4
        if (len === 0 || at + len > data.length) {
            return
        }
        yield data.subarray(at, at + len)
        at += len
    }
}

/** The picture size from a sequence parameter set (its cropping applied). */
function parseSps (nal: Uint8Array): { width: number, height: number } | null {
    try {
        const rbsp: number[] = []
        for (let i = 1; i < nal.length; i++) {
            if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) {
                continue  // emulation prevention
            }
            rbsp.push(nal[i])
        }
        let pos = 0
        const bit = () => { const b = (rbsp[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return b }
        const bits = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v }
        const ue = () => { let zeros = 0; while (bit() === 0 && zeros < 32) zeros++; return (1 << zeros) - 1 + bits(zeros) }
        const se = () => { const v = ue(); return v & 1 ? (v + 1) / 2 : -v / 2 }
        const profile = bits(8)
        bits(8)  // constraints
        bits(8)  // level
        ue()  // sps id
        let chromaFormat = 1
        if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
            chromaFormat = ue()
            if (chromaFormat === 3) bit()
            ue(); ue(); bit()
            if (bit()) {
                for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
                    if (bit()) {
                        const size = i < 6 ? 16 : 64
                        let last = 8, next = 8
                        for (let j = 0; j < size; j++) {
                            if (next) { next = (last + se() + 256) % 256 }
                            last = next === 0 ? last : next
                        }
                    }
                }
            }
        }
        ue()  // log2_max_frame_num
        const pocType = ue()
        if (pocType === 0) {
            ue()
        } else if (pocType === 1) {
            bit(); se(); se()
            const n = ue()
            for (let i = 0; i < n; i++) se()
        }
        ue()  // max_num_ref_frames
        bit()
        const widthMbs = ue() + 1
        const heightMapUnits = ue() + 1
        const frameMbsOnly = bit()
        if (!frameMbsOnly) bit()
        bit()
        let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0
        if (bit()) {
            cropLeft = ue(); cropRight = ue(); cropTop = ue(); cropBottom = ue()
        }
        const subW = chromaFormat === 3 ? 1 : 2
        const subH = chromaFormat === 1 ? 2 : 1
        const unitY = subH * (2 - frameMbsOnly)
        const width = widthMbs * 16 - subW * (cropLeft + cropRight)
        const height = (2 - frameMbsOnly) * heightMapUnits * 16 - unitY * (cropTop + cropBottom)
        return width > 0 && height > 0 ? { width, height } : null
    } catch {
        return null
    }
}

// ---- the trace -----------------------------------------------------------------------------------

interface ChannelState {
    /** Static channel ids to names, from the GCC conference create request/response. */
    staticNames: Map<number, string>
    ioChannel: number
    messageChannel: number | null
    /** Static channel chunks being reassembled, per direction and channel. */
    svcPending: Map<string, { total: number, parts: Uint8Array[], have: number }>
    /** Dynamic channel ids to names, from the DVC create requests. */
    dvcNames: Map<number, string>
    dvcPending: Map<string, { total: number, parts: Uint8Array[], have: number }>
    zgfx: { in: ZgfxDecompressor, out: ZgfxDecompressor }
    fastPathFragments: { in: Uint8Array[], out: Uint8Array[] }
    earlyAuth: boolean
}

export class PduTrace {
    readonly events: TraceEvent[] = []
    /** How many of the oldest events went past MAX_EVENTS. */
    dropped = 0
    readonly startedAt: number
    private seq = 0
    private readonly framers: { in: Framer, out: Framer }
    private readonly state: ChannelState
    private readonly epoch: number
    /** The time source: milliseconds since the epoch, with a fraction. */
    private readonly now: () => number

    constructor (now?: () => number) {
        this.epoch = Date.now()
        const origin = typeof performance !== 'undefined' ? performance.now() : 0
        this.now = now ?? (typeof performance !== 'undefined' ? () => this.epoch + (performance.now() - origin) : () => Date.now())
        this.startedAt = this.now()
        this.state = {
            staticNames: new Map(),
            ioChannel: 1003,
            messageChannel: null,
            svcPending: new Map(),
            dvcNames: new Map(),
            dvcPending: new Map(),
            zgfx: { in: new ZgfxDecompressor(), out: new ZgfxDecompressor() },
            fastPathFragments: { in: [], out: [] },
            earlyAuth: false,
        }
        this.framers = { in: new Framer(() => this.state.earlyAuth, 'in'), out: new Framer(() => this.state.earlyAuth, 'out') }
    }

    // ---- what goes in ----

    /** Bytes of the relayed stream, as they pass the proxy: `in` from the server, `out` from the client. */
    stream (dir: Direction, data: Uint8Array): void {
        const t = this.now()
        for (const { kind, data: pdu } of this.framers[dir].push(data)) {
            try {
                this.pdu(dir, kind, pdu, t)
            } catch (error: any) {
                this.add(t, dir, 'trace', 'DecodeError', pdu.length, { error: String(error?.message ?? error) })
            }
        }
    }

    /** The X.224 connection request and confirm the proxy exchanged with the server (its own; not in the stream). */
    x224 (dir: Direction, pdu: Uint8Array): void {
        const t = this.now()
        try {
            if (pdu.length < 11 || pdu[0] !== TPKT_VERSION) {
                this.add(t, dir, 'x224', dir === 'out' ? 'ConnectionRequest' : 'ConnectionConfirm', pdu.length, {})
                return
            }
            const code = pdu[5] & 0xf0
            const attrs: Record<string, AttrValue> = {}
            // RDP_NEG_REQ/RSP at the end: type u8, flags u8, length u16, value u32.
            let at = 11
            if (code === 0xe0) {
                const cookie = Buffer.from(pdu.subarray(11)).indexOf('\r\n')
                if (cookie >= 0 && pdu[11] === 0x43) {
                    at = 11 + cookie + 2
                    attrs.cookie = 'present'
                }
            }
            if (at + 8 <= pdu.length) {
                const type = pdu[at]
                const flags = pdu[at + 1]
                const value = pdu[at + 4] | pdu[at + 5] << 8 | pdu[at + 6] << 16 | pdu[at + 7] << 24
                if (type === 1) {
                    attrs.requestedProtocols = protocols(value)
                } else if (type === 2) {
                    attrs.selectedProtocol = protocols(value)
                    attrs.flags = negotiationFlags(flags)
                    this.state.earlyAuth = (value & 0x08) !== 0
                } else if (type === 3) {
                    attrs.failureCode = value
                }
            }
            this.add(t, dir, 'x224', code === 0xe0 ? 'ConnectionRequest' : code === 0xd0 ? 'ConnectionConfirm' : `X.224 ${hex(code)}`, pdu.length, attrs)
        } catch (error: any) {
            this.add(t, dir, 'trace', 'DecodeError', pdu.length, { error: String(error?.message ?? error) })
        }
    }

    /** Something this side did: the plugin, the decoder, the canvas. */
    local (layer: Layer, name: string, attrs: Record<string, AttrValue> = {}): void {
        this.add(this.now(), 'local', layer, name, 0, attrs)
    }

    /**
     * Wraps IronRDP's H.264 decoder object (decode/endSurfaces/close) so that each access unit handed to it and each
     * result coming back is in the trace, with the decoder's latency. The wrapper is what the session gets.
     */
    wrapH264Decoder<T extends { decode: (frame: any, done: (id: number, pixels: Uint8Array | null, error?: string) => void) => void, endSurfaces?: (ids: number[]) => void, close?: () => void }> (decoder: T): T {
        const trace = this
        const handed = new Map<number, number>()
        const wrapper = Object.create(decoder) as T
        wrapper.decode = (frame: any, done: (id: number, pixels: Uint8Array | null, error?: string) => void) => {
            const t = trace.now()
            handed.set(frame.id, t)
            const regions = Array.isArray(frame.regions) ? frame.regions : []
            trace.add(t, 'local', 'decoder', 'H264.Handed', 0, {
                id: frame.id, surfaceId: frame.surfaceId, keyFrame: !!frame.keyFrame, bytes: frame.data?.byteLength ?? 0,
                regions: regions.length, regionArea: regions.reduce((s: number, r: any) => s + (r.right - r.left) * (r.bottom - r.top), 0),
                destination: frame.destination ? `${frame.destination.left},${frame.destination.top}-${frame.destination.right},${frame.destination.bottom}` : '',
                endedSurfaces: (frame.endedSurfaces ?? []).join(',') || '',
            })
            decoder.decode(frame, (id, pixels, error) => {
                const at = trace.now()
                const since = handed.get(id)
                handed.delete(id)
                trace.add(at, 'local', 'decoder', error ? 'H264.Error' : pixels ? 'H264.Decoded' : 'H264.Skipped', 0, {
                    id, bytes: pixels?.byteLength ?? 0, latencyMs: since === undefined ? -1 : Math.round((at - since) * 1000) / 1000, ...error ? { error } : {},
                })
                done(id, pixels, error)
            })
        }
        if (typeof decoder.endSurfaces === 'function') {
            wrapper.endSurfaces = (ids: number[]) => {
                trace.add(trace.now(), 'local', 'decoder', 'H264.EndSurfaces', 0, { surfaces: ids.join(',') })
                decoder.endSurfaces!(ids)
            }
        }
        return wrapper
    }

    /** Watches the canvas IronRDP draws on: its backing-store size, and each region drawn. */
    watchCanvas (canvas: HTMLCanvasElement): () => void {
        const trace = this
        const observer = new MutationObserver(() => {
            trace.add(trace.now(), 'local', 'canvas', 'Canvas.Resized', 0, { width: canvas.width, height: canvas.height })
        })
        observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] })
        const ctx = canvas.getContext('2d')
        let restore: (() => void) | null = null
        if (ctx) {
            const original = ctx.putImageData
            ctx.putImageData = function (this: CanvasRenderingContext2D, image: ImageData, dx: number, dy: number, ...rest: any[]) {
                // How much of what is drawn is black (every 97th pixel): a frame that paints nothing shows here.
                const d = image.data
                let black = 0
                let n = 0
                for (let i = 0; i < d.length; i += 4 * 97) {
                    n++
                    if (d[i] < 8 && d[i + 1] < 8 && d[i + 2] < 8) {
                        black++
                    }
                }
                trace.add(trace.now(), 'local', 'canvas', 'Canvas.Draw', 0, { x: dx, y: dy, width: image.width, height: image.height, black: n ? Math.round(black / n * 1000) / 1000 : 0 })
                return (original as any).call(this, image, dx, dy, ...rest)
            } as typeof ctx.putImageData
            restore = () => { ctx.putImageData = original }
        }
        trace.add(trace.now(), 'local', 'canvas', 'Canvas.Resized', 0, { width: canvas.width, height: canvas.height })
        return () => {
            observer.disconnect()
            restore?.()
        }
    }

    // ---- decoding ----

    /** The auto-detect events of the current run of them, by direction and name (see add). */
    private autoDetectRun = new Map<string, TraceEvent>()

    private add (t: number, dir: Direction | 'local', layer: Layer, name: string, bytes: number, attrs: Record<string, AttrValue>): TraceEvent {
        // A run of auto-detect PDUs (a Windows server measures bandwidth hundreds of times a second, start and stop
        // in turn) folds into one event per kind with a count, until something else comes.
        if (layer === 'sec' && name.startsWith('AutoDetect.')) {
            const key = `${dir}:${name}`
            const run = this.autoDetectRun.get(key)
            if (run && sameAttrs(run.attrs, attrs)) {
                run.repeat = (run.repeat ?? 1) + 1
                run.until = t
                run.bytes += bytes
                return run
            }
        } else {
            this.autoDetectRun.clear()
        }
        const event: TraceEvent = { seq: this.seq++, t, dir, layer, name, bytes, attrs }
        if (layer === 'sec' && name.startsWith('AutoDetect.')) {
            this.autoDetectRun.set(`${dir}:${name}`, event)
        }
        this.events.push(event)
        if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS)
            this.dropped++
        }
        return event
    }

    private pdu (dir: Direction, kind: FrameKind, pdu: Uint8Array, t: number): void {
        switch (kind) {
            case 'tpkt': this.tpkt(dir, pdu, t); break
            case 'der': this.add(t, dir, 'sec', 'CredSSP.TSRequest', pdu.length, {}); break
            case 'early': this.add(t, dir, 'sec', 'EarlyUserAuthorizationResult', 4, { result: pdu[0] | pdu[1] << 8 }); break
            case 'fastpath': this.fastPath(dir, pdu, t); break
            default: this.add(t, dir, 'trace', 'Unknown', pdu.length, { first: hex(pdu[0]) })
        }
    }

    private tpkt (dir: Direction, pdu: Uint8Array, t: number): void {
        const r = new Reader(pdu)
        r.skip(4)
        const li = r.u8()
        const code = r.u8() & 0xf0
        if (code !== 0xf0) {
            this.x224(dir, pdu)
            return
        }
        r.skip(li - 1)
        const mcs = r.rest()
        if (mcs.length < 1) {
            this.add(t, dir, 'mcs', 'Empty', pdu.length, {})
            return
        }
        if (mcs[0] === 0x7f && (mcs[1] === 0x65 || mcs[1] === 0x66)) {
            this.connect(dir, mcs, pdu.length, t)
            return
        }
        const choice = mcs[0] >> 2
        const m = new Reader(mcs)
        m.skip(1)
        switch (choice) {
            case 1: this.add(t, dir, 'mcs', 'ErectDomainRequest', pdu.length, {}); return
            case 8: this.add(t, dir, 'mcs', 'DisconnectProviderUltimatum', pdu.length, { reason: mcs.length > 1 ? (mcs[0] & 1) << 2 | mcs[1] >> 6 : -1 }); return
            case 10: this.add(t, dir, 'mcs', 'AttachUserRequest', pdu.length, {}); return
            case 11: this.add(t, dir, 'mcs', 'AttachUserConfirm', pdu.length, { initiator: mcs.length >= 4 ? 1001 + (mcs[2] << 8 | mcs[3]) : -1 }); return
            case 14: this.add(t, dir, 'mcs', 'ChannelJoinRequest', pdu.length, { channel: mcs.length >= 5 ? mcs[3] << 8 | mcs[4] : -1 }); return
            case 15: this.add(t, dir, 'mcs', 'ChannelJoinConfirm', pdu.length, { channel: mcs.length >= 8 ? mcs[6] << 8 | mcs[7] : -1 }); return
            case 25:
            case 26: {
                const initiator = m.u16be()
                const channel = m.u16be()
                m.skip(1)  // priority and segmentation
                const length = m.perLength()
                const data = m.bytes(Math.min(length, m.remaining))
                this.channelData(dir, channel, initiator, data, pdu.length, t)
                return
            }
            default: this.add(t, dir, 'mcs', `MCS ${choice}`, pdu.length, {})
        }
    }

    /** The GCC Conference Create Request/Response inside MCS Connect Initial/Response: the channels, the sizes. */
    private connect (dir: Direction, mcs: Uint8Array, bytes: number, t: number): void {
        const attrs: Record<string, AttrValue> = {}
        const key = Buffer.from(mcs).indexOf(dir === 'out' ? 'Duca' : 'McDn')
        const names: string[] = []
        if (key >= 0) {
            const r = new Reader(mcs)
            r.pos = key + 4
            try {
                r.perLength()
                while (r.remaining >= 4) {
                    const type = r.u16()
                    const length = r.u16()
                    if (length < 4 || length - 4 > r.remaining) {
                        break
                    }
                    const block = new Reader(r.bytes(length - 4))
                    if (type === 0xc001) {
                        block.u32()
                        attrs.desktop = `${block.u16()}x${block.u16()}`
                        block.skip(2 + 2 + 4 + 4)  // color depth, SAS sequence, keyboard layout, client build
                        const name = Buffer.from(block.bytes(32)).toString('utf16le').replace(/\0.*$/, '')
                        attrs.clientName = name ? 'present' : ''
                    } else if (type === 0xc003) {
                        const count = block.u32()
                        for (let i = 0; i < count && block.remaining >= 12; i++) {
                            names.push(Buffer.from(block.bytes(8)).toString('latin1').replace(/\0.*$/, '').toLowerCase())
                            block.u32()
                        }
                        attrs.channels = names.join(',')
                    } else if (type === 0xc005) {
                        const flags = block.u32()
                        const count = block.u32()
                        const monitors: string[] = []
                        for (let i = 0; i < count && block.remaining >= 20; i++) {
                            const left = block.i32(), top = block.i32(), right = block.i32(), bottom = block.i32(), f = block.u32()
                            monitors.push(`${left},${top}-${right},${bottom}${f & 1 ? '*' : ''}`)
                        }
                        attrs.monitors = monitors.join(' ')
                        attrs.monitorFlags = flags
                    } else if (type === 0x0c01) {
                        attrs.version = hex(block.u32())
                        if (block.remaining >= 4) {
                            attrs.clientRequestedProtocols = protocols(block.u32())
                        }
                        if (block.remaining >= 4) {
                            attrs.earlyCapabilityFlags = hex(block.u32())
                        }
                    } else if (type === 0x0c03) {
                        const io = block.u16()
                        const count = block.u16()
                        this.state.ioChannel = io
                        attrs.ioChannel = io
                        const ids: number[] = []
                        for (let i = 0; i < count && block.remaining >= 2; i++) {
                            ids.push(block.u16())
                        }
                        attrs.channelIds = ids.join(',')
                        this.pendingServerIds = ids
                    } else if (type === 0x0c04 || type === 0xc006) {
                        if (type === 0x0c04) {
                            this.state.messageChannel = block.u16()
                            attrs.messageChannel = this.state.messageChannel
                        }
                    } else if (type === 0xc008 || type === 0x0c08) {
                        attrs.multitransportFlags = hex(block.u32())
                    }
                }
            } catch {
                attrs.partial = true
            }
        }
        if (dir === 'out') {
            this.clientChannelNames = names
        } else if (this.pendingServerIds) {
            this.pendingServerIds.forEach((id, i) => this.state.staticNames.set(id, this.clientChannelNames[i] ?? `channel${i}`))
            this.pendingServerIds = null
        }
        this.add(t, dir, 'mcs', dir === 'out' ? 'ConnectInitial' : 'ConnectResponse', bytes, attrs)
    }

    private clientChannelNames: string[] = []
    private pendingServerIds: number[] | null = null

    private channelData (dir: Direction, channel: number, initiator: number, data: Uint8Array, bytes: number, t: number): void {
        if (channel === this.state.ioChannel || channel === this.state.messageChannel || !this.state.staticNames.has(channel)) {
            this.ioChannelPdu(dir, channel, data, bytes, t)
            return
        }
        const name = this.state.staticNames.get(channel)!
        const r = new Reader(data)
        const total = r.u32()
        const flags = r.u32()
        const chunk = r.rest()
        const key = `${dir}:${channel}`
        const pending = this.state.svcPending
        let message: Uint8Array | null = null
        if ((flags & 0x03) === 0x03) {
            message = chunk
        } else if (flags & 0x01) {
            pending.set(key, { total, parts: [chunk], have: chunk.length })
        } else {
            const p = pending.get(key)
            if (!p) {
                this.add(t, dir, 'svc', `${name}.Chunk`, bytes, { channel, total, flags, orphan: true })
                return
            }
            p.parts.push(chunk)
            p.have += chunk.length
            if (flags & 0x02) {
                pending.delete(key)
                message = joinParts(p.parts)
            }
        }
        if (!message) {
            return  // a chunk; the whole message is the event
        }
        this.svcMessage(dir, name, channel, message, bytes, t)
    }

    private ioChannelPdu (dir: Direction, channel: number, data: Uint8Array, bytes: number, t: number): void {
        const r = new Reader(data)
        if (data.length < 4) {
            this.add(t, dir, 'share', 'Short', bytes, { channel })
            return
        }
        const totalLength = r.u16()
        const pduType = r.u16()
        const shareControl = (pduType & 0xf0) === 0x10 && [1, 3, 6, 7, 0xa].includes(pduType & 0xf) && totalLength <= data.length && channel === this.state.ioChannel
        if (!shareControl) {
            this.securityPdu(dir, totalLength, pduType, data, bytes, t, channel)
            return
        }
        r.u16()  // pduSource
        const attrs: Record<string, AttrValue> = { channel }
        switch (pduType & 0xf) {
            case 1: {
                attrs.shareId = hex(r.u32())
                const lenSrc = r.u16()
                const lenCaps = r.u16()
                attrs.source = Buffer.from(r.bytes(lenSrc)).toString('latin1').replace(/\0.*$/, '')
                Object.assign(attrs, this.capabilities(new Reader(r.bytes(Math.min(lenCaps, r.remaining)))))
                this.add(t, dir, 'share', 'DemandActive', bytes, attrs)
                return
            }
            case 3: {
                attrs.shareId = hex(r.u32())
                attrs.originatorId = r.u16()
                const lenSrc = r.u16()
                const lenCaps = r.u16()
                attrs.source = Buffer.from(r.bytes(lenSrc)).toString('latin1').replace(/\0.*$/, '')
                Object.assign(attrs, this.capabilities(new Reader(r.bytes(Math.min(lenCaps, r.remaining)))))
                this.add(t, dir, 'share', 'ConfirmActive', bytes, attrs)
                return
            }
            case 6:
                if (r.remaining >= 4) {
                    attrs.shareId = hex(r.u32())
                }
                this.add(t, dir, 'share', 'DeactivateAll', bytes, attrs)
                return
            case 0xa:
                this.add(t, dir, 'share', 'ServerRedirection', bytes, attrs)
                return
            case 7: {
                attrs.shareId = hex(r.u32())
                r.u8()
                attrs.streamId = r.u8()
                attrs.uncompressedLength = r.u16()
                const type2 = r.u8()
                const compression = r.u8()
                r.u16()
                const name = SHARE_DATA_TYPES[type2] ?? `ShareData ${hex(type2)}`
                if (compression & 0x20) {
                    attrs.compressed = true
                    this.add(t, dir, 'share', name, bytes, attrs)
                    return
                }
                this.shareData(dir, type2, name, r, bytes, attrs, t)
                return
            }
        }
    }

    private securityPdu (dir: Direction, flags: number, flagsHi: number, data: Uint8Array, bytes: number, t: number, channel: number): void {
        const attrs: Record<string, AttrValue> = { channel, flags: hex(flags) }
        const r = new Reader(data)
        r.skip(4)
        if (flags & 0x0040) {
            this.add(t, dir, 'sec', 'ClientInfo', bytes, attrs)
        } else if (flags & 0x0080) {
            const type = r.remaining >= 1 ? r.u8() : -1
            attrs.type = LICENSE_TYPES[type] ?? hex(type)
            this.add(t, dir, 'sec', `Licensing.${attrs.type}`, bytes, attrs)
        } else if (flags & 0x1000 || flags & 0x2000) {
            if (r.remaining >= 6) {
                r.u8()
                r.u8()
                attrs.sequence = r.u16()
                const type = r.u16()
                attrs.type = AUTODETECT_TYPES[type] ?? hex(type)
            }
            const { sequence, ...rest } = attrs
            void sequence
            this.add(t, dir, 'sec', `AutoDetect.${flags & 0x1000 ? 'Request' : 'Response'}.${attrs.type ?? '?'}`, bytes, rest)
        } else if (flags & 0x4000) {
            this.add(t, dir, 'sec', 'Heartbeat', bytes, attrs)
        } else if (flags & 0x0400) {
            this.add(t, dir, 'sec', 'ServerRedirection', bytes, attrs)
        } else if (flags & 0x0002) {
            this.add(t, dir, 'sec', 'InitiateMultitransportRequest', bytes, attrs)
        } else if (flags & 0x0004) {
            this.add(t, dir, 'sec', 'InitiateMultitransportResponse', bytes, attrs)
        } else {
            this.add(t, dir, 'sec', 'Security', bytes, { ...attrs, flagsHi: hex(flagsHi) })
        }
    }

    private capabilities (r: Reader): Record<string, AttrValue> {
        const out: Record<string, AttrValue> = {}
        const count = r.remaining >= 4 ? r.u16() : 0
        r.remaining >= 2 && r.u16()
        const names: string[] = []
        for (let i = 0; i < count && r.remaining >= 4; i++) {
            const type = r.u16()
            const length = r.u16()
            if (length < 4 || length - 4 > r.remaining) {
                break
            }
            const c = new Reader(r.bytes(length - 4))
            const name = CAPABILITY_SETS[type] ?? `Cap${type}`
            names.push(name)
            try {
                switch (type) {
                    case 1: c.skip(8); out.generalExtraFlags = hex((c.skip(4), c.u16())); break
                    case 2: c.skip(8); out.bitmapDesktop = `${c.u16()}x${c.u16()}`; break
                    case 13: out.inputFlags = hex(c.u16()); break
                    case 20: out.virtualChannelFlags = hex(c.u32()); if (c.remaining >= 4) out.vcChunkSize = c.u32(); break
                    case 26: out.multifragmentMax = c.u32(); break
                    case 28: out.surfaceCommands = hex(c.u32()); break
                    case 29: {
                        const n = c.u8()
                        const codecs: string[] = []
                        for (let k = 0; k < n && c.remaining >= 19; k++) {
                            const guid = guidOf(c.bytes(16))
                            const id = c.u8()
                            const propLen = c.u16()
                            c.skip(Math.min(propLen, c.remaining))
                            codecs.push(`${CODEC_GUIDS[guid] ?? guid}=${id}`)
                        }
                        out.codecs = codecs.join(',')
                        break
                    }
                    case 30: out.maxUnacknowledgedFrames = c.u32(); break
                }
            } catch {
                out[`${name}Partial`] = true
            }
        }
        out.capabilitySets = names.join(',')
        return out
    }

    private shareData (dir: Direction, type: number, name: string, r: Reader, bytes: number, attrs: Record<string, AttrValue>, t: number): void {
        try {
            switch (type) {
                case 0x02: {
                    const updateType = r.u16()
                    attrs.updateType = ['Orders', 'Bitmap', 'Palette', 'Synchronize'][updateType] ?? updateType
                    if (updateType === 1 && r.remaining >= 2) {
                        attrs.rectangles = r.u16()
                    } else if (updateType === 0 && r.remaining >= 4) {
                        r.u16()
                        attrs.orders = r.u16()
                    }
                    break
                }
                case 0x14: {
                    const action = r.u16()
                    attrs.action = ({ 1: 'RequestControl', 2: 'GrantedControl', 4: 'Detach', 5: 'Cooperate' } as Record<number, string>)[action] ?? action
                    break
                }
                case 0x1b: attrs.messageType = r.u16(); break
                case 0x1c: attrs.events = r.u16(); break
                case 0x1f: attrs.messageType = r.u16(); attrs.targetUser = r.u16(); break
                case 0x21: attrs.areas = r.u8(); break
                case 0x23: attrs.allowDisplayUpdates = r.u8(); break
                case 0x26: {
                    const infoType = r.u32()
                    attrs.infoType = ['LogonInfoV1', 'LogonInfoV2', 'PlainNotify', 'LogonInfoExtended'][infoType] ?? infoType
                    break
                }
                case 0x2f: {
                    const code = r.u32()
                    attrs.errorInfo = ERROR_INFO[code] ?? hex(code)
                    break
                }
                case 0x36: attrs.statusCode = hex(r.u32()); break
                case 0x37: {
                    const count = r.u32()
                    const monitors: string[] = []
                    for (let i = 0; i < count && r.remaining >= 20; i++) {
                        const left = r.i32(), top = r.i32(), right = r.i32(), bottom = r.i32(), flags = r.u32()
                        monitors.push(`${left},${top}-${right},${bottom}${flags & 1 ? '*' : ''}`)
                    }
                    attrs.monitors = monitors.join(' ')
                    break
                }
                case 0x38: attrs.frameId = r.u32(); break
            }
        } catch {
            attrs.partial = true
        }
        this.add(t, dir, 'share', name, bytes, attrs)
    }

    // ---- fast path ----

    private fastPath (dir: Direction, pdu: Uint8Array, t: number): void {
        const r = new Reader(pdu)
        const header = r.u8()
        const flags = header >> 6
        let numEvents = (header >> 2) & 0x0f
        if (r.u8() & 0x80) {
            r.pos++
        }
        if (flags & 0x01) {
            r.skip(8)  // data signature
        }
        if (dir === 'out') {
            if (numEvents === 0 && r.remaining) {
                numEvents = r.u8()
            }
            const kinds: Record<string, number> = {}
            try {
                for (let i = 0; i < numEvents; i++) {
                    const eh = r.u8()
                    const code = eh >> 5
                    const name = ['ScanCode', 'Mouse', 'MouseX', 'Sync', 'Unicode', 'QoeTimestamp', 'RelativeMouse'][code] ?? `Event${code}`
                    kinds[name] = (kinds[name] ?? 0) + 1
                    r.skip([1, 6, 6, 0, 2, 4, 6][code] ?? 0)
                }
            } catch {
                kinds.partial = 1
            }
            this.add(t, dir, 'fastpath', 'Input', pdu.length, { events: numEvents, ...kinds })
            return
        }
        while (r.remaining >= 3) {
            const uh = r.u8()
            const code = uh & 0x0f
            const fragmentation = (uh >> 4) & 0x03
            const compression = (uh >> 6) & 0x03
            let compressionFlags = 0
            if (compression & 0x02) {
                compressionFlags = r.u8()
            }
            const size = r.u16()
            const data = r.bytes(Math.min(size, r.remaining))
            const name = FASTPATH_UPDATES[code] ?? `Update${code}`
            const attrs: Record<string, AttrValue> = { size }
            if (compressionFlags & 0x20) {
                attrs.compressed = ['8K', '64K', 'RDP6', 'RDP6.1'][compressionFlags & 0x0f] ?? compressionFlags & 0x0f
            }
            // Fragments: First, Next…, Last; decoded once whole, or counted alone.
            let whole: Uint8Array | null = null
            const frags = this.state.fastPathFragments[dir]
            if (fragmentation === 0) {
                whole = data
            } else if (fragmentation === 2) {
                frags.length = 0
                frags.push(data)
                attrs.fragment = 'first'
            } else if (fragmentation === 3) {
                frags.push(data)
                attrs.fragment = 'next'
            } else {
                frags.push(data)
                attrs.fragment = 'last'
                whole = joinParts(frags.splice(0))
            }
            if (whole && !(compressionFlags & 0x20)) {
                try {
                    this.fastPathUpdate(dir, code, name, whole, pdu.length, attrs, t)
                    continue
                } catch {
                    attrs.partial = true
                }
            }
            this.add(t, dir, 'fastpath', name, whole ? pdu.length : 0, attrs)
        }
    }

    private fastPathUpdate (dir: Direction, code: number, name: string, data: Uint8Array, bytes: number, attrs: Record<string, AttrValue>, t: number): void {
        const r = new Reader(data)
        switch (code) {
            case 0: attrs.orders = r.u16(); break
            case 1: {
                r.u16()
                const count = r.u16()
                attrs.rectangles = count
                let union: number[] | null = null
                let codecs: Record<string, number> = {}
                for (let i = 0; i < count && r.remaining >= 18; i++) {
                    const left = r.u16(), top = r.u16(), right = r.u16(), bottom = r.u16()
                    r.u16(); r.u16(); r.u16()
                    const flags = r.u16()
                    const len = r.u16()
                    r.skip(Math.min(len, r.remaining))
                    const kind = flags & 0x0001 ? 'compressed' : 'raw'
                    codecs[kind] = (codecs[kind] ?? 0) + 1
                    union = union ? [Math.min(union[0], left), Math.min(union[1], top), Math.max(union[2], right), Math.max(union[3], bottom)] : [left, top, right, bottom]
                }
                if (union) {
                    attrs.union = `${union[0]},${union[1]}-${union[2]},${union[3]}`
                }
                Object.assign(attrs, codecs)
                break
            }
            case 4: {
                // Surface commands: each is its own event, so a frame's markers and bits can be followed.
                while (r.remaining >= 2) {
                    const cmd = r.u16()
                    if (cmd === 4) {
                        const action = r.u16()
                        const frameId = r.u32()
                        this.add(t, dir, 'fastpath', action === 0 ? 'FrameMarker.Begin' : 'FrameMarker.End', bytes, { frameId })
                    } else if (cmd === 1 || cmd === 6) {
                        const dest = rect16(r)
                        const bpp = r.u8()
                        const flags = r.u8()
                        r.u8()
                        const codec = r.u8()
                        const width = r.u16()
                        const height = r.u16()
                        const len = r.u32()
                        if (flags & 0x01) {
                            r.skip(24)
                        }
                        r.skip(Math.min(len, r.remaining))
                        this.add(t, dir, 'fastpath', cmd === 1 ? 'SetSurfaceBits' : 'StreamSurfaceBits', bytes, {
                            dest, bpp, codec: SURFACE_CODECS[codec] ?? codec, size: `${width}x${height}`, bytes: len,
                        })
                    } else {
                        this.add(t, dir, 'fastpath', `SurfaceCommand ${hex(cmd)}`, bytes, {})
                        return
                    }
                }
                return
            }
            case 8: attrs.position = `${r.u16()},${r.u16()}`; break
            case 9: case 11: {
                if (code === 11) {
                    attrs.xorBpp = r.u16()
                }
                attrs.cacheIndex = r.u16()
                attrs.hotspot = `${r.u16()},${r.u16()}`
                attrs.size = `${r.u16()}x${r.u16()}`
                break
            }
            case 10: attrs.cacheIndex = r.u16(); break
        }
        this.add(t, dir, 'fastpath', name, bytes, attrs)
    }

    // ---- static channels ----

    private svcMessage (dir: Direction, name: string, channel: number, message: Uint8Array, bytes: number, t: number): void {
        const r = new Reader(message)
        const attrs: Record<string, AttrValue> = { channel, length: message.length }
        try {
            switch (name) {
                case 'drdynvc':
                    this.dvc(dir, r, bytes, t)
                    return
                case 'cliprdr': {
                    const type = r.u16()
                    attrs.flags = hex(r.u16())
                    attrs.dataLength = r.u32()
                    this.add(t, dir, 'svc', `cliprdr.${CLIPRDR_TYPES[type] ?? hex(type)}`, bytes, attrs)
                    return
                }
                case 'rdpdr': {
                    const component = r.u16()
                    const packet = r.u16()
                    attrs.component = hex(component)
                    this.add(t, dir, 'svc', `rdpdr.${RDPDR_PACKETS[packet] ?? hex(packet)}`, bytes, attrs)
                    return
                }
                case 'rdpsnd': {
                    const type = r.u8()
                    this.add(t, dir, 'svc', `rdpsnd.${RDPSND_TYPES[type] ?? hex(type)}`, bytes, attrs)
                    return
                }
            }
        } catch {
            attrs.partial = true
        }
        this.add(t, dir, 'svc', name, bytes, attrs)
    }

    private dvc (dir: Direction, r: Reader, bytes: number, t: number): void {
        const header = r.u8()
        const cmd = header >> 4
        const sp = (header >> 2) & 0x03
        const cbId = header & 0x03
        const sized = (field: number): number => field === 0 ? r.u8() : field === 1 ? r.u16() : r.u32()
        const attrs: Record<string, AttrValue> = {}
        const name = DVC_COMMANDS[cmd] ?? `Cmd${cmd}`
        if (cmd === 5) {
            r.u8()
            attrs.version = r.u16()
            this.add(t, dir, 'dvc', `DVC.Capabilities${dir === 'in' ? 'Request' : 'Response'}`, bytes, attrs)
            return
        }
        const channelId = sized(cbId)
        attrs.channelId = channelId
        switch (cmd) {
            case 1: {
                if (dir === 'in') {
                    const channelName = Buffer.from(r.rest()).toString('latin1').replace(/\0.*$/, '')
                    this.state.dvcNames.set(channelId, channelName)
                    attrs.name = channelName
                    this.add(t, dir, 'dvc', 'DVC.CreateRequest', bytes, attrs)
                } else {
                    const status = r.remaining >= 4 ? r.i32() : 0
                    attrs.name = this.state.dvcNames.get(channelId) ?? ''
                    attrs.status = status === 0 ? 'ok' : hex(status >>> 0)
                    this.add(t, dir, 'dvc', 'DVC.CreateResponse', bytes, attrs)
                }
                return
            }
            case 4:
                attrs.name = this.state.dvcNames.get(channelId) ?? ''
                this.add(t, dir, 'dvc', 'DVC.Close', bytes, attrs)
                return
            case 2:
            case 3: {
                const key = `${dir}:${channelId}`
                const pending = this.state.dvcPending
                let message: Uint8Array | null = null
                if (cmd === 2) {
                    const total = sized(sp)
                    const data = r.rest()
                    if (data.length >= total) {
                        message = data
                    } else {
                        pending.set(key, { total, parts: [data], have: data.length })
                    }
                } else {
                    const data = r.rest()
                    const p = pending.get(key)
                    if (!p) {
                        message = data
                    } else {
                        p.parts.push(data)
                        p.have += data.length
                        if (p.have >= p.total) {
                            pending.delete(key)
                            message = joinParts(p.parts)
                        }
                    }
                }
                if (!message) {
                    return  // a fragment; the whole message is the event
                }
                this.dvcMessage(dir, channelId, message, bytes, t)
                return
            }
            default:
                this.add(t, dir, 'dvc', `DVC.${name}`, bytes, attrs)
        }
    }

    private dvcMessage (dir: Direction, channelId: number, message: Uint8Array, bytes: number, t: number): void {
        const name = this.state.dvcNames.get(channelId) ?? `dvc${channelId}`
        const attrs: Record<string, AttrValue> = { channelId, length: message.length }
        if (name === 'Microsoft::Windows::RDS::Graphics') {
            // RDP_SEGMENTED_DATA (ZGFX) around the PDUs; IronRDP's client sends its own PDUs bare, which Windows takes.
            let decompressed: Uint8Array
            try {
                decompressed = message[0] === 0xe0 || message[0] === 0xe1 ? this.state.zgfx[dir].decompress(message) : message
            } catch (error: any) {
                this.add(t, dir, 'egfx', 'EGFX.ZgfxError', bytes, { ...attrs, error: String(error?.message ?? error) })
                return
            }
            this.egfx(dir, decompressed, bytes, t)
            return
        }
        if (name === 'Microsoft::Windows::RDS::DisplayControl') {
            this.displayControl(dir, message, bytes, t, attrs)
            return
        }
        this.add(t, dir, 'dvc', name, bytes, attrs)
    }

    private displayControl (dir: Direction, message: Uint8Array, bytes: number, t: number, attrs: Record<string, AttrValue>): void {
        const r = new Reader(message)
        try {
            const type = r.u32()
            r.u32()
            // MS-RDPEDISP 2.2.2: DISPLAYCONTROL_PDU_TYPE_CAPS is 0x05, DISPLAYCONTROL_PDU_TYPE_MONITOR_LAYOUT 0x02.
            if (type === 0x05) {
                attrs.maxNumMonitors = r.u32()
                attrs.maxMonitorAreaFactorA = r.u32()
                attrs.maxMonitorAreaFactorB = r.u32()
                this.add(t, dir, 'displaycontrol', 'DisplayControl.Caps', bytes, attrs)
                return
            }
            if (type === 0x02) {
                const entrySize = r.u32()
                const count = r.u32()
                const monitors: string[] = []
                for (let i = 0; i < count && r.remaining >= entrySize; i++) {
                    const m = new Reader(r.bytes(entrySize))
                    const flags = m.u32()
                    const left = m.i32(), top = m.i32(), width = m.u32(), height = m.u32()
                    const physW = m.u32(), physH = m.u32(), orientation = m.u32(), desktopScale = m.u32(), deviceScale = m.u32()
                    monitors.push(`${width}x${height}@${left},${top}${flags & 1 ? '*' : ''} ${physW}x${physH}mm ${orientation}° ${desktopScale}%/${deviceScale}%`)
                    if (i === 0) {
                        attrs.width = width
                        attrs.height = height
                        attrs.desktopScale = desktopScale
                    }
                }
                attrs.monitors = monitors.join('; ')
                this.add(t, dir, 'displaycontrol', 'DisplayControl.MonitorLayout', bytes, attrs)
                return
            }
            this.add(t, dir, 'displaycontrol', `DisplayControl.${hex(type)}`, bytes, attrs)
        } catch {
            this.add(t, dir, 'displaycontrol', 'DisplayControl', bytes, { ...attrs, partial: true })
        }
    }

    private egfx (dir: Direction, data: Uint8Array, bytes: number, t: number): void {
        const r = new Reader(data)
        let first = true
        while (r.remaining >= 8) {
            const cmdId = r.u16()
            r.u16()  // flags
            const length = r.u32()
            if (length < 8 || length - 8 > r.remaining) {
                this.add(t, dir, 'egfx', 'EGFX.Malformed', bytes, { cmdId: hex(cmdId), length })
                return
            }
            const body = new Reader(r.bytes(length - 8))
            const name = EGFX_COMMANDS[cmdId] ?? `EGFX ${hex(cmdId)}`
            // The message's wire bytes count once, on its first command.
            const attrs: Record<string, AttrValue> = { pduLength: length }
            try {
                switch (cmdId) {
                    case 0x01: {
                        attrs.surfaceId = body.u16()
                        const codec = body.u16()
                        attrs.codec = EGFX_CODECS[codec] ?? hex(codec)
                        attrs.pixelFormat = body.u8()
                        attrs.dest = rect16(body)
                        const len = body.u32()
                        attrs.bitmapBytes = len
                        const bitmap = body.bytes(Math.min(len, body.remaining))
                        if (codec === 0xb || codec === 0xe || codec === 0xf) {
                            this.avc(codec, bitmap, attrs)
                        }
                        break
                    }
                    case 0x02:
                        attrs.surfaceId = body.u16()
                        attrs.codec = EGFX_CODECS[body.u16()] ?? ''
                        attrs.contextId = body.u32()
                        attrs.pixelFormat = body.u8()
                        attrs.bitmapBytes = body.u32()
                        break
                    case 0x03: attrs.surfaceId = body.u16(); attrs.contextId = body.u32(); break
                    case 0x04: {
                        attrs.surfaceId = body.u16()
                        const b = body.u8(), g = body.u8(), rr = body.u8(); body.u8()
                        attrs.color = `#${[rr, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
                        const n = body.u16()
                        attrs.rectangles = n
                        const rects: string[] = []
                        for (let i = 0; i < n && i < 8 && body.remaining >= 8; i++) {
                            rects.push(rect16(body))
                        }
                        attrs.rects = rects.join(' ') + (n > 8 ? ' …' : '')
                        break
                    }
                    case 0x05: {
                        attrs.sourceSurfaceId = body.u16()
                        attrs.surfaceId = body.u16()
                        attrs.source = rect16(body)
                        const n = body.u16()
                        attrs.points = n
                        const at: string[] = []
                        for (let i = 0; i < n && i < 16 && body.remaining >= 4; i++) {
                            at.push(`${body.u16()},${body.u16()}`)
                        }
                        attrs.at = at.join(' ') + (n > 16 ? ' …' : '')
                        break
                    }
                    case 0x06:
                        attrs.surfaceId = body.u16()
                        body.u64()
                        attrs.cacheSlot = body.u16()
                        attrs.source = rect16(body)
                        break
                    case 0x07: {
                        attrs.cacheSlot = body.u16()
                        attrs.surfaceId = body.u16()
                        const n = body.u16()
                        attrs.points = n
                        // Where the tile goes (the first 48 points): a resize repaints from the cache, and where
                        // each paste lands says which tile the server thinks covers which part of the new surface.
                        const at: string[] = []
                        for (let i = 0; i < n && i < 48 && body.remaining >= 4; i++) {
                            at.push(`${body.u16()},${body.u16()}`)
                        }
                        attrs.at = at.join(' ') + (n > 48 ? ' …' : '')
                        break
                    }
                    case 0x08: attrs.cacheSlot = body.u16(); break
                    case 0x09:
                        attrs.surfaceId = body.u16()
                        attrs.width = body.u16()
                        attrs.height = body.u16()
                        attrs.pixelFormat = body.u8()
                        break
                    case 0x0a: attrs.surfaceId = body.u16(); break
                    case 0x0b: attrs.timestamp = body.u32(); attrs.frameId = body.u32(); break
                    case 0x0c: attrs.frameId = body.u32(); break
                    case 0x0d: {
                        const depth = body.u32()
                        attrs.queueDepth = depth === 0xffffffff ? 'unavailable' : depth === 0 ? 'suspend' : depth
                        attrs.frameId = body.u32()
                        attrs.totalFramesDecoded = body.u32()
                        break
                    }
                    case 0x0e: {
                        attrs.width = body.u32()
                        attrs.height = body.u32()
                        const n = body.u32()
                        attrs.monitors = n
                        const monitors: string[] = []
                        for (let i = 0; i < n && body.remaining >= 20; i++) {
                            const left = body.u32(), top = body.u32(), right = body.u32(), bottom = body.u32(), flags = body.u32()
                            monitors.push(`${left},${top}-${right},${bottom}${flags & 1 ? '*' : ''}`)
                        }
                        attrs.monitorRects = monitors.join(' ')
                        break
                    }
                    case 0x0f:
                        attrs.surfaceId = body.u16()
                        body.u16()
                        attrs.origin = `${body.u32()},${body.u32()}`
                        break
                    case 0x17:
                        attrs.surfaceId = body.u16()
                        body.u16()
                        attrs.origin = `${body.u32()},${body.u32()}`
                        attrs.target = `${body.u32()}x${body.u32()}`
                        break
                    case 0x15:
                    case 0x18:
                        attrs.surfaceId = body.u16()
                        body.u64()
                        attrs.mapped = `${body.u32()}x${body.u32()}`
                        if (cmdId === 0x18) {
                            attrs.target = `${body.u32()}x${body.u32()}`
                        }
                        break
                    case 0x10: attrs.entries = body.u16(); break
                    case 0x11: attrs.imported = body.u16(); break
                    case 0x12: {
                        const n = body.u16()
                        const sets: string[] = []
                        for (let i = 0; i < n && body.remaining >= 8; i++) {
                            const version = body.u32()
                            const len = body.u32()
                            const flags = len >= 4 && body.remaining >= len ? body.u32() : 0
                            body.skip(Math.max(0, Math.min(len - 4, body.remaining)))
                            sets.push(`${EGFX_CAP_VERSIONS[version] ?? hex(version)}:${hex(flags)}`)
                        }
                        attrs.capabilitySets = sets.join(' ')
                        break
                    }
                    case 0x13: {
                        const version = body.u32()
                        const len = body.u32()
                        attrs.version = EGFX_CAP_VERSIONS[version] ?? hex(version)
                        attrs.flags = len >= 4 && body.remaining >= 4 ? hex(body.u32()) : ''
                        break
                    }
                    case 0x16:
                        attrs.frameId = body.u32()
                        attrs.timestamp = body.u32()
                        attrs.timeDiffSE = body.u16()
                        attrs.timeDiffEDR = body.u16()
                        break
                }
            } catch {
                attrs.partial = true
            }
            this.add(t, dir, 'egfx', `EGFX.${name}`, first ? bytes : 0, attrs)
            first = false
        }
    }

    /** The AVC420/AVC444 bitmap stream of a WireToSurface1: its region rectangles and what the H.264 shows. */
    private avc (codec: number, bitmap: Uint8Array, attrs: Record<string, AttrValue>): void {
        const r = new Reader(bitmap)
        let streams: { data: Uint8Array, main: boolean }[]
        if (codec === 0xb) {
            streams = [{ data: bitmap, main: true }]
        } else {
            const info = r.u32()
            const len1 = info & 0x3fffffff
            const encoding = info >>> 30
            attrs.encoding = ['LumaAndChroma', 'Luma', 'Chroma'][encoding] ?? encoding
            if (len1 === 0) {
                streams = [{ data: r.rest(), main: encoding !== 2 }]
            } else {
                const first = r.bytes(Math.min(len1, r.remaining))
                streams = [{ data: first, main: true }]
                if (r.remaining) {
                    streams.push({ data: r.rest(), main: false })
                }
            }
        }
        streams.forEach((stream, index) => {
            const s = new Reader(stream.data)
            const suffix = index === 0 ? '' : '2'
            try {
                const n = s.u32()
                const rects: string[] = []
                let area = 0
                for (let i = 0; i < n; i++) {
                    const left = s.u16(), top = s.u16(), right = s.u16(), bottom = s.u16()
                    area += Math.max(0, right - left) * Math.max(0, bottom - top)
                    if (i < 6) {
                        rects.push(`${left},${top}-${right},${bottom}`)
                    }
                }
                const qp: number[] = []
                for (let i = 0; i < n; i++) {
                    const q = s.u8()
                    s.u8()
                    if (i < 3) {
                        qp.push(q & 0x3f)
                    }
                }
                attrs[`regions${suffix}`] = n
                attrs[`regionRects${suffix}`] = rects.join(' ') + (n > 6 ? ' …' : '')
                attrs[`regionArea${suffix}`] = area
                attrs[`qp${suffix}`] = qp.join(',')
                const h264 = s.rest()
                attrs[`h264Bytes${suffix}`] = h264.length
                const info = inspectH264(h264)
                attrs[`keyFrame${suffix}`] = info.keyFrame
                if (info.width) {
                    attrs[`picture${suffix}`] = `${info.width}x${info.height}`
                }
                attrs[`nals${suffix}`] = info.nals
            } catch {
                attrs[`avcPartial${suffix}`] = true
            }
        })
    }

    // ---- export ----

    /**
     * The trace as an OTLP/JSON ExportTraceServiceRequest: one resource (the plugin, the desktop), one scope, and
     * spans: the connection; its activations (Demand Active to Font Map); each resize (the monitor layout sent, to
     * the first acknowledged frame at the new size); each graphics-pipeline frame (Start Frame to its Frame
     * Acknowledge); each legacy frame (Frame Marker begin to end); each H.264 access unit (handed to the decoder, to
     * its pixels). Every event is on the innermost span it falls in.
     */
    toOtlp (meta: TraceMeta): object {
        return exportOtlp(this.events, meta, this.startedAt, this.now(), this.dropped)
    }
}

/** The OTLP/JSON form of `events` (see PduTrace.toOtlp); `dropped`: how many of the oldest events went. */
export function exportOtlp (events: TraceEvent[], meta: TraceMeta, startedAt: number, endedAt: number, dropped = 0): object {
    {
        const spans = deriveSpans(events, startedAt, endedAt)
        const attr = (key: string, value: AttrValue) => ({ key, value: typeof value === 'number' ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value } })
        const ns = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString()
        const traceId = randomHex(16)
        return {
            resourceSpans: [{
                resource: {
                    attributes: [
                        attr('service.name', 'tabby-rdp'),
                        attr('service.version', meta.pluginVersion),
                        attr('rdp.desktop', meta.desktop),
                        attr('rdp.destination', meta.destination),
                        attr('rdp.client', meta.client),
                        attr('rdp.graphics', meta.graphics ?? ''),
                        attr('os.type', meta.platform),
                        attr('process.runtime.version', meta.electron ?? ''),
                        attr('trace.events.dropped', dropped),
                    ],
                },
                scopeSpans: [{
                    scope: { name: 'tabby-rdp.pdu-trace', version: '1' },
                    spans: spans.map(span => ({
                        traceId,
                        spanId: span.id,
                        ...span.parent ? { parentSpanId: span.parent } : {},
                        name: span.name,
                        kind: 1,
                        startTimeUnixNano: ns(span.start),
                        endTimeUnixNano: ns(span.end),
                        attributes: Object.entries(span.attrs).map(([k, v]) => attr(k, v)),
                        events: span.events.map(e => ({
                            timeUnixNano: ns(e.t),
                            name: e.name,
                            attributes: [
                                attr('seq', e.seq), attr('dir', e.dir), attr('layer', e.layer), attr('bytes', e.bytes),
                                ...e.repeat ? [attr('repeat', e.repeat), attr('untilUnixNano', ns(e.until ?? e.t))] : [],
                                ...Object.entries(e.attrs).map(([k, v]) => attr(k, v)),
                            ],
                        })),
                        status: span.status ? { code: span.status.code === 'error' ? 2 : 1, ...span.status.message ? { message: span.status.message } : {} } : { code: 0 },
                    })),
                }],
            }],
        }
    }
}

// ---- spans ---------------------------------------------------------------------------------------

/** Groups the events into spans (see PduTrace.toOtlp). */
export function deriveSpans (events: TraceEvent[], startedAt: number, endedAt: number): TraceSpan[] {
    const root: TraceSpan = { id: randomHex(8), name: 'rdp.connection', start: startedAt, end: endedAt, attrs: {}, events: [] }
    const spans: TraceSpan[] = [root]
    let activation: TraceSpan | null = null
    let resize: TraceSpan | null = null
    let resizeState: { width: number, height: number, reset: boolean, created: boolean, frames: number } | null = null
    const egfxFrames = new Map<number, TraceSpan>()
    let currentEgfx: TraceSpan | null = null
    let legacy: TraceSpan | null = null
    const h264 = new Map<number, TraceSpan>()
    /** The latest frame that carried H.264 and is not yet acknowledged: what an access unit handed out belongs to. */
    let lastAvcFrame: TraceSpan | null = null
    let activations = 0
    let resizes = 0
    const innermost = (): TraceSpan => currentEgfx ?? legacy ?? resize ?? activation ?? root
    const finish = (span: TraceSpan, at: number) => { span.end = Math.max(span.start, at) }

    for (const e of events) {
        const a = e.attrs
        let placed: TraceSpan | null = null
        switch (e.name) {
            case 'DemandActive':
                if (e.dir === 'in') {
                    if (activation) {
                        finish(activation, e.t)
                    }
                    activation = { id: randomHex(8), parent: (resize ?? root).id, name: activations++ ? 'rdp.reactivation' : 'rdp.activation', start: e.t, end: e.t, attrs: { shareId: a.shareId ?? '', desktop: a.bitmapDesktop ?? '' }, events: [] }
                    spans.push(activation)
                    placed = activation
                }
                break
            case 'DeactivateAll':
                if (resize) {
                    resize.attrs.deactivation = true
                }
                break
            case 'FontMap':
                if (activation) {
                    activation.events.push(e)
                    finish(activation, e.t)
                    activation = null
                    continue
                }
                break
            case 'DisplayControl.MonitorLayout':
                if (resize) {
                    resize.status = { code: 'error', message: 'another resize was requested before this one settled' }
                    finish(resize, e.t)
                }
                resize = { id: randomHex(8), parent: root.id, name: 'rdp.resize', start: e.t, end: e.t, attrs: { index: resizes++, width: Number(a.width), height: Number(a.height), scale: Number(a.desktopScale ?? 100) }, events: [] }
                resizeState = { width: Number(a.width), height: Number(a.height), reset: false, created: false, frames: 0 }
                spans.push(resize)
                placed = resize
                break
            case 'EGFX.ResetGraphics':
                if (resize && resizeState) {
                    resizeState.reset = Number(a.width) === resizeState.width && Number(a.height) === resizeState.height
                    resize.attrs.resetAfterMs = round(e.t - resize.start)
                    if (!resizeState.reset) {
                        resize.attrs.resetSize = `${a.width}x${a.height}`
                    }
                }
                break
            case 'EGFX.CreateSurface':
                if (resize && resizeState?.reset) {
                    resizeState.created = true
                    resize.attrs.surface = `${a.width}x${a.height}`
                    resize.attrs.surfaceAfterMs = round(e.t - resize.start)
                }
                break
            case 'EGFX.StartFrame': {
                const span: TraceSpan = { id: randomHex(8), parent: (resize ?? root).id, name: 'egfx.frame', start: e.t, end: e.t, attrs: { frameId: Number(a.frameId), commands: 0, bitmapBytes: 0 }, events: [] }
                spans.push(span)
                egfxFrames.set(Number(a.frameId), span)
                currentEgfx = span
                placed = span
                break
            }
            case 'EGFX.WireToSurface1':
            case 'EGFX.WireToSurface2':
            case 'EGFX.SolidFill':
            case 'EGFX.SurfaceToSurface':
            case 'EGFX.CacheToSurface':
                if (currentEgfx) {
                    currentEgfx.attrs.commands = Number(currentEgfx.attrs.commands) + 1
                    currentEgfx.attrs.bitmapBytes = Number(currentEgfx.attrs.bitmapBytes) + Number(a.bitmapBytes ?? 0)
                    const codec = String(a.codec ?? e.name.replace('EGFX.', ''))
                    currentEgfx.attrs[`codec.${codec}`] = Number(currentEgfx.attrs[`codec.${codec}`] ?? 0) + 1
                    if (a.keyFrame === true) {
                        currentEgfx.attrs.keyFrame = true
                    }
                    if (/^AVC/.test(codec)) {
                        lastAvcFrame = currentEgfx
                    }
                }
                break
            case 'EGFX.EndFrame':
                if (currentEgfx && currentEgfx.attrs.frameId === Number(a.frameId)) {
                    currentEgfx.events.push(e)
                    currentEgfx.attrs.endAfterMs = round(e.t - currentEgfx.start)
                    finish(currentEgfx, e.t)
                    if (resize && resizeState?.created) {
                        resizeState.frames++
                        if (resizeState.frames === 1) {
                            resize.attrs.firstFrameId = Number(a.frameId)
                            resize.attrs.firstFrameAfterMs = round(e.t - resize.start)
                            resize.attrs.firstFrameCommands = currentEgfx.attrs.commands
                            resize.attrs.firstFrameKeyFrame = currentEgfx.attrs.keyFrame === true
                        }
                    }
                    currentEgfx = null
                    continue
                }
                break
            case 'EGFX.FrameAcknowledge': {
                const span = egfxFrames.get(Number(a.frameId))
                if (span) {
                    span.events.push(e)
                    span.attrs.ackAfterMs = round(e.t - span.start)
                    span.attrs.queueDepth = a.queueDepth ?? ''
                    finish(span, e.t)
                    egfxFrames.delete(Number(a.frameId))
                    if (lastAvcFrame === span) {
                        lastAvcFrame = null
                    }
                    if (resize && resizeState?.created && resize.attrs.firstFrameId === Number(a.frameId)) {
                        resize.attrs.settledAfterMs = round(e.t - resize.start)
                        resize.status = { code: 'ok' }
                        finish(resize, e.t)
                        resize = null
                        resizeState = null
                    }
                    continue
                }
                break
            }
            case 'FrameMarker.Begin':
                legacy = { id: randomHex(8), parent: (resize ?? root).id, name: 'fastpath.frame', start: e.t, end: e.t, attrs: { frameId: Number(a.frameId), updates: 0 }, events: [] }
                spans.push(legacy)
                placed = legacy
                break
            case 'SetSurfaceBits':
            case 'StreamSurfaceBits':
            case 'Bitmap':
                if (legacy) {
                    legacy.attrs.updates = Number(legacy.attrs.updates) + 1
                }
                if (resize && !resizeState?.reset && activation === null && e.dir === 'in') {
                    // A legacy (non-EGFX) resize: the first update after the reactivation ends it.
                    if (resize.attrs.deactivation === true) {
                        resize.attrs.settledAfterMs = round(e.t - resize.start)
                        resize.status = { code: 'ok' }
                        resize.events.push(e)
                        finish(resize, e.t)
                        resize = null
                        resizeState = null
                        continue
                    }
                }
                break
            case 'FrameMarker.End':
                if (legacy) {
                    legacy.events.push(e)
                    finish(legacy, e.t)
                    legacy = null
                    continue
                }
                break
            case 'H264.Handed': {
                const span: TraceSpan = { id: randomHex(8), parent: (lastAvcFrame ?? innermost()).id, name: 'h264.decode', start: e.t, end: e.t, attrs: { id: Number(a.id), surfaceId: Number(a.surfaceId), keyFrame: a.keyFrame === true, bytes: Number(a.bytes) }, events: [e] }
                spans.push(span)
                h264.set(Number(a.id), span)
                continue
            }
            case 'H264.Decoded':
            case 'H264.Skipped':
            case 'H264.Error': {
                const span = h264.get(Number(a.id))
                if (span) {
                    span.events.push(e)
                    span.attrs.outcome = e.name.replace('H264.', '').toLowerCase()
                    span.attrs.latencyMs = Number(a.latencyMs)
                    if (e.name === 'H264.Error') {
                        span.status = { code: 'error', message: String(a.error ?? '') }
                    }
                    finish(span, e.t)
                    h264.delete(Number(a.id))
                    continue
                }
                break
            }
        }
        if (resize && !placed && e.t - resize.start > 10_000) {
            // Nothing acknowledged at the new size within ten seconds: the resize is left open as failed.
            resize.status = { code: 'error', message: resizeState?.reset ? resizeState.created ? 'no frame was acknowledged at the new size' : 'no surface was created at the new size' : 'the server did not reset the graphics to the requested size' }
            finish(resize, resize.start + 10_000)
            resize = null
            resizeState = null
        }
        ;(placed ?? innermost()).events.push(e)
    }
    for (const span of [activation, resize, currentEgfx, legacy, ...egfxFrames.values(), ...h264.values()]) {
        if (span && span.end === span.start) {
            span.status ??= { code: 'error', message: 'unfinished' }
            finish(span, endedAt)
        }
    }
    root.attrs.events = events.length
    root.attrs.resizes = resizes
    root.attrs.activations = activations
    return spans
}

// ---- helpers ------------------------------------------------------------------------------------

function protocols (value: number): string {
    const names: string[] = []
    if (value & 1) names.push('SSL')
    if (value & 2) names.push('HYBRID')
    if (value & 4) names.push('RDSTLS')
    if (value & 8) names.push('HYBRID_EX')
    if (value & 16) names.push('RDSAAD')
    return names.join('|') || 'RDP'
}

function negotiationFlags (flags: number): string {
    const names: string[] = []
    if (flags & 1) names.push('EXTENDED_CLIENT_DATA')
    if (flags & 2) names.push('DYNVC_GFX')
    if (flags & 8) names.push('RESTRICTED_ADMIN')
    if (flags & 16) names.push('REDIRECTED_AUTH')
    return names.join('|')
}

function guidOf (b: Uint8Array): string {
    const h = (i: number) => b[i].toString(16).padStart(2, '0')
    return `${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`
}

function joinParts (parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
        out.set(p, at)
        at += p.length
    }
    return out
}

function sameAttrs (a: Record<string, AttrValue>, b: Record<string, AttrValue>): boolean {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k])
}

function round (ms: number): number {
    return Math.round(ms * 100) / 100
}

function randomHex (bytes: number): string {
    let out = ''
    for (let i = 0; i < bytes; i++) {
        out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    }
    return out
}
