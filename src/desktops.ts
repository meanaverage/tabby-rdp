import { RemoteTarget } from './targets'

/**
 * What kind of RDP server a desktop is. 'gnome': the SSH host's own desktop, set up automatically (headless
 * GNOME Remote Desktop, generated credentials). 'windows': a Windows machine the SSH host can reach (e.g. a
 * VM with its RDP port forwarded to the host's loopback), or the SSH host itself when it runs Windows; signs in
 * with the Windows account.
 */
export type DesktopKind = 'gnome' | 'windows'

/** A desktop reachable through an SSH connection. */
export interface DesktopSpec {
    /** 'own' for the SSH host's own desktop, otherwise `host:port`. */
    id: string
    /** For menus and status messages. */
    name: string
    kind: DesktopKind
    /** Where the RDP server is, as seen from the SSH host (unused for GNOME's own desktop: the setup reports the port). */
    host: string
    port: number
    username?: string
    domain?: string
}

/**
 * An entry of `remoteDesktop.desktops` in Tabby's config: another desktop behind an SSH host.
 *
 *     remoteDesktop:
 *       desktops:
 *         - name: Windows VM
 *           via: myhost            # SSH host alias, hostname, user@hostname or user@hostname:port
 *           host: 192.168.122.20   # as seen from that host
 *           port: 3389
 *           kind: windows
 *           username: alice
 */
export interface ExtraDesktopConfig {
    name?: string
    via?: string
    host?: string
    port?: number
    kind?: string
    username?: string
    domain?: string
}

export const OWN_DESKTOP = 'own'

/** Whether a `via` value names this SSH target: its alias (label), hostname, user@hostname, or full key. */
export function viaMatches (via: string, target: RemoteTarget): boolean {
    const v = via.trim().toLowerCase()
    const key = target.key.toLowerCase()  // user@hostname:port
    const userHost = key.replace(/:\d+$/, '')
    const hostname = userHost.replace(/^[^@]*@/, '')
    return !!v && [key, userHost, hostname, target.label.toLowerCase()].includes(v)
}

/** The desktop an entry describes (a `remoteDesktop.desktops` entry, or an RDP profile's options), or null if unusable. */
export function specOf (extra: ExtraDesktopConfig): DesktopSpec | null {
    const port = Number(extra?.port || 3389)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return null
    }
    const host = String(extra.host || '127.0.0.1')
    return {
        id: `${host}:${port}`,
        name: extra.name ? String(extra.name) : `${host}:${port}`,
        kind: extra.kind === 'gnome' ? 'gnome' : 'windows',
        host,
        port,
        username: extra.username ? String(extra.username) : undefined,
        domain: extra.domain ? String(extra.domain) : undefined,
    }
}

/**
 * The SSH host's own desktop, then the configured desktops behind it, then `more` (RDP profiles going through this
 * host). The own desktop of a Windows host (`ownKind`) is its RDP server, signed in to with the Windows account (the
 * SSH user, to start with).
 */
export function desktopsFor (target: RemoteTarget, extras: ExtraDesktopConfig[] | undefined, ownKind: DesktopKind = 'gnome', more: ExtraDesktopConfig[] = []): DesktopSpec[] {
    const own: DesktopSpec = ownKind === 'windows'
        ? { id: OWN_DESKTOP, name: `${target.label} desktop`, kind: 'windows', host: '127.0.0.1', port: 3389, username: target.key.replace(/@[^@]*$/, '') || undefined }
        : { id: OWN_DESKTOP, name: `${target.label} desktop`, kind: 'gnome', host: '127.0.0.1', port: 0 }
    const specs: DesktopSpec[] = [own]
    const behind = (Array.isArray(extras) ? extras : []).filter(extra => extra?.via && viaMatches(extra.via, target))
    for (const extra of [...behind, ...more]) {
        const spec = specOf(extra)
        if (spec && !specs.some(s => s.id === spec.id)) {
            specs.push(spec)
        }
    }
    return specs
}

/** The target key of direct connections (remote desktop tabs); their session keys are `rdp#<address>`. */
export const DIRECT_KEY = 'rdp'

/** The id of a configured desktop (`host:port`), as its DesktopSpec and session keys have it. */
export function desktopIdOf (extra: ExtraDesktopConfig): string {
    return `${extra.host || '127.0.0.1'}:${extra.port || 3389}`
}

/**
 * One desktop per key: the remote account for its own desktop, plus the RDP server for one behind it (`rdp#<address>`
 * for a direct one).
 */
export function sessionKey (target: RemoteTarget, spec: DesktopSpec): string {
    return spec.id === OWN_DESKTOP ? target.key : `${target.key}#${spec.id}`
}
