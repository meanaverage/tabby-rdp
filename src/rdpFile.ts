/**
 * .rdp files (Remote Desktop Connection's format): one `key:type:value` setting per line, type `s` (string), `i`
 * (integer) or `b` (binary). Only where to connect and as whom is taken; display, devices, gateway and the rest are
 * the plugin's own business or not supported.
 */
export interface RdpFile {
    host: string
    port: number
    username?: string
    domain?: string
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
    return {
        host,
        port,
        ...settings.get('username') ? { username: settings.get('username') } : {},
        ...settings.get('domain') ? { domain: settings.get('domain') } : {},
    }
}
