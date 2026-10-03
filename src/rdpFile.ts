/**
 * .rdp files (Remote Desktop Connection's format): one `key:type:value` setting per line, type `s` (string), `i`
 * (integer) or `b` (binary). Where to connect and as whom is taken, and the few settings the plugin keeps per desktop;
 * the rest is either the plugin's own business (settings that apply to every desktop) or not supported, and the
 * import says which of those the file asked for.
 */
export interface RdpFile {
    host: string
    port: number
    username?: string
    domain?: string
    /** `desktopscalefactor` of 150 or more: the desktop wants a high-DPI scale, which is this plugin's Retina sharpness. */
    sharpness?: 'retina' | 'standard'
    /** `gatewayhostname`, kept for when the plugin connects through RD Gateways. */
    gateway?: string
    /** Settings the file carries that the plugin doesn't apply, in words, for the import's note. */
    ignored: string[]
}

/** What a setting in the file would mean here, when it isn't applied: by key, for the values that ask for something. */
const NOTES: Record<string, (value: string, all: Map<string, string>) => string | null> = {
    'audiomode': v => v === '1' ? 'sound left on the remote (sound plays here; Settings › Remote Desktop › Sound)' : v === '2' ? 'sound off (Settings › Remote Desktop › Sound)' : null,
    'audiocapturemode': v => v === '1' ? 'the microphone (Settings › Remote Desktop › Microphone)' : null,
    'redirectclipboard': v => v === '0' ? 'the clipboard turned off (it is always on)' : null,
    'redirectdrives': v => v === '1' ? 'drive redirection (not supported yet)' : null,
    'drivestoredirect': v => v ? 'drive redirection (not supported yet)' : null,
    'redirectprinters': v => v === '1' ? 'printer redirection (not supported)' : null,
    'redirectsmartcards': v => v === '1' ? 'smart card redirection (not supported)' : null,
    'redirectcomports': v => v === '1' ? 'serial port redirection (not supported)' : null,
    'usbdevicestoredirect': v => v ? 'USB redirection (not supported)' : null,
    'use multimon': v => v === '1' ? 'several monitors (one screen per desktop here)' : null,
    'screen mode id': (v, all) => v === '1' && (all.get('desktopwidth') || all.get('desktopheight'))
        ? `a fixed ${all.get('desktopwidth') ?? '?'}×${all.get('desktopheight') ?? '?'} window (the desktop follows the pane; Settings › Remote Desktop › When the pane is resized)` : null,
    'gatewayhostname': v => v ? `the RD Gateway ${v} (not supported yet; the address is connected to directly)` : null,
    'remoteapplicationmode': v => v === '1' ? 'RemoteApp (not supported; the whole desktop opens)' : null,
    'alternate shell': v => v ? 'a program to start instead of the desktop (not supported)' : null,
    'enablecredsspsupport': v => v === '0' ? 'sign-in without Network Level Authentication (it is always used)' : null,
}

/** mstsc writes UTF-16LE with a byte order mark; other tools write UTF-8, with or without one. */
function decode (data: Uint8Array): string {
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (b[0] === 0xff && b[1] === 0xfe) {
        return b.subarray(2).toString('utf16le')
    }
    if (b[0] === 0xfe && b[1] === 0xff) {
        return Buffer.from(b.subarray(2)).swap16().toString('utf16le')
    }
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
        return b.subarray(3).toString('utf8')
    }
    // UTF-16LE without a byte order mark: the first character is ASCII, followed by a zero byte.
    if (b.length >= 2 && b[0] !== 0 && b[1] === 0) {
        return b.subarray(0, b.length & ~1).toString('utf16le')
    }
    return b.toString('utf8')
}

/** The connection a .rdp file describes, or null without a usable `full address`. */
export function parseRdpFile (data: Uint8Array): RdpFile | null {
    const settings = new Map<string, string>()
    for (const line of decode(data).split(/\r?\n/)) {
        const m = /^\s*([^:]+?)\s*:\s*([sib])\s*:(.*)$/i.exec(line)
        if (m) {
            settings.set(m[1].toLowerCase(), m[3].trim())
        }
    }
    const full = settings.get('full address') ?? ''
    // host, host:port, [v6]:port, or a bare IPv6 address (colons, no brackets).
    const m = /^\[([^\]]+)\](?::(\d+))?$|^([^:\s]+)(?::(\d+))?$/.exec(full)
    const host = m?.[1] ?? m?.[3] ?? (/^[0-9a-f:.]+$/i.test(full) && (full.match(/:/g)?.length ?? 0) > 1 ? full : null)
    // A port in the address wins over `server port`, as in mstsc.
    const port = Number(m?.[2] ?? m?.[4] ?? (settings.get('server port') || 3389))
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        return null
    }
    const scale = Number(settings.get('desktopscalefactor'))
    const ignored = [...settings].map(([key, value]) => NOTES[key]?.(value, settings) ?? null).filter((n): n is string => !!n)
    return {
        host,
        port,
        ...settings.get('username') ? { username: settings.get('username') } : {},
        ...settings.get('domain') ? { domain: settings.get('domain') } : {},
        ...Number.isFinite(scale) && scale >= 100 ? { sharpness: scale >= 150 ? 'retina' as const : 'standard' as const } : {},
        ...settings.get('gatewayhostname') ? { gateway: settings.get('gatewayhostname') } : {},
        ignored: [...new Set(ignored)],
    }
}
