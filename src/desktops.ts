import { HYPERV_PORT, vmId } from './hyperv'
import { RemoteTarget } from './targets'
import { parseWake, WakeSpec } from './wake'

/**
 * What kind of RDP server a desktop is. 'gnome': the SSH host's own desktop, set up automatically (headless
 * GNOME Remote Desktop, generated credentials). 'windows': a Windows machine the SSH host can reach (e.g. a
 * VM with its RDP port forwarded to the host's loopback), or the SSH host itself when it runs Windows; signs in
 * with the Windows account. 'xrdp': a Linux desktop other than GNOME (KDE, XFCE, MATE, …) served by xrdp; signs in
 * with the Linux account.
 */
export type DesktopKind = 'gnome' | 'windows' | 'xrdp'

/**
 * What the remote setup found on an SSH host (see remoteSetup.ts): which desktop is its own (GNOME, xrdp, or Windows'
 * RDP server when the host runs Windows), and xrdp's port and the account to suggest when xrdp runs there.
 */
export interface OwnDesktopFound {
    kind: 'gnome' | 'xrdp' | 'windows'
    xrdpPort?: number
    xrdpUser?: string
}

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
    /** A saved account's id (see accounts.ts): signs in with it, in place of `username` and `domain`. */
    account?: string
    /** How to start it when it doesn't answer (a VM on the SSH host, or Wake-on-LAN). */
    wake?: WakeSpec
    /** A VM found on the SSH host (see vms.ts), not configured: whether it was running or off when found. */
    found?: 'running' | 'off'
    /**
     * A Hyper-V VM's id: its console, reached through its host (the SSH host, port 2179; see hyperv.ts) rather than a
     * desktop with an address of its own. The sign-in is the host's.
     */
    hyperv?: string
    /**
     * An RD Gateway's address (`host` or `host:port`, see gateway.ts) to reach the desktop through: `host` is then as
     * the gateway sees it, and the gateway as the SSH host (or this computer, for a direct desktop) sees it.
     */
    gateway?: string
    /** A saved account's id to sign in to the gateway with; without it, the desktop's own sign-in is the gateway's too. */
    gatewayAccount?: string
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
 *           kind: windows          # or xrdp, or gnome
 *           username: alice
 *           account: k3f9x2ab      # or a saved account's id, in place of username and domain
 *           wake: { vm: win11 }    # optional: start it when it's off; or { mac: "aa:bb:cc:dd:ee:ff" }
 *         - name: Build VM
 *           via: hyperv-host       # a Windows SSH host running Hyper-V
 *           hyperv: 5f05e000-...   # the VM's id (Get-VM): its console through the host, started when it's off
 *         - name: Office PC
 *           via: myhost
 *           host: pc17.corp.example # as the gateway sees it
 *           gateway: rdgw.example.com   # an RD Gateway (port 443, or host:port), as seen from the SSH host
 *           gatewayAccount: k3f9x2ab    # optional: a saved account for the gateway, when not the desktop's sign-in
 */
export interface ExtraDesktopConfig {
    name?: string
    via?: string
    host?: string
    port?: number
    kind?: string
    username?: string
    domain?: string
    account?: string
    wake?: { vm?: string, mac?: string, broadcast?: string, port?: number, hyperv?: string }
    hyperv?: string
    gateway?: string
    gatewayAccount?: string
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
    const hyperv = vmId(extra?.hyperv)
    if (hyperv) {
        return hyperVSpec(hyperv, extra.name ? String(extra.name) : hyperv, {
            username: extra.username ? String(extra.username) : undefined,
            domain: extra.domain ? String(extra.domain) : undefined,
            account: extra.account ? String(extra.account) : undefined,
        })
    }
    const port = Number(extra?.port || 3389)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return null
    }
    const host = String(extra.host || '127.0.0.1')
    const gateway = typeof extra.gateway === 'string' ? extra.gateway.trim() : ''
    return {
        id: `${host}:${port}`,
        name: extra.name ? String(extra.name) : `${host}:${port}`,
        kind: extra.kind === 'gnome' || extra.kind === 'xrdp' ? extra.kind : 'windows',
        host,
        port,
        username: extra.username ? String(extra.username) : undefined,
        domain: extra.domain ? String(extra.domain) : undefined,
        account: extra.account ? String(extra.account) : undefined,
        wake: parseWake(extra.wake),
        ...gateway ? { gateway, gatewayAccount: extra.gatewayAccount ? String(extra.gatewayAccount) : undefined } : {},
    }
}

/** A Hyper-V VM's console as a desktop of its host: the host's VMConnect port, the VM's id, started when it's off. */
export function hyperVSpec (id: string, name: string, more: Partial<DesktopSpec> = {}): DesktopSpec {
    return { id: `hyperv:${id}`, name, kind: 'windows', host: '127.0.0.1', port: HYPERV_PORT, hyperv: id, wake: { hyperv: id }, ...more }
}

/**
 * The SSH host's own desktop, then the configured desktops behind it, then `more` (RDP profiles going through this
 * host). `found`: what the setup found there the last time (none yet: GNOME, as the setup will try first). A host
 * with only xrdp has it as its own desktop; one with both GNOME and xrdp also offers xrdp, as a desktop at its
 * loopback port. A Windows host's own desktop is its RDP server, signed in to with the Windows account (the SSH user,
 * to start with).
 */
export function desktopsFor (target: RemoteTarget, extras: ExtraDesktopConfig[] | undefined, found?: OwnDesktopFound, more: ExtraDesktopConfig[] = []): DesktopSpec[] {
    const own: DesktopSpec = found?.kind === 'xrdp'
        ? { id: OWN_DESKTOP, name: `${target.label} desktop`, kind: 'xrdp', host: '127.0.0.1', port: found.xrdpPort ?? 3389, username: found.xrdpUser }
        : found?.kind === 'windows'
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
    // Configured entries come first: one for the same port keeps its name.
    if (found?.kind === 'gnome' && found.xrdpPort && !specs.some(s => s.id === `127.0.0.1:${found.xrdpPort}`)) {
        specs.push({
            id: `127.0.0.1:${found.xrdpPort}`,
            name: `${target.label} desktop (xrdp)`,
            kind: 'xrdp',
            host: '127.0.0.1',
            port: found.xrdpPort,
            username: found.xrdpUser,
        })
    }
    return specs
}

/** The target key of direct connections (remote desktop tabs); their session keys are `rdp#<address>`. */
export const DIRECT_KEY = 'rdp'

/** The id of a configured desktop (`host:port`), as its DesktopSpec and session keys have it. */
export function desktopIdOf (extra: ExtraDesktopConfig): string {
    return vmId(extra.hyperv) ? `hyperv:${vmId(extra.hyperv)}` : `${extra.host || '127.0.0.1'}:${extra.port || 3389}`
}

/**
 * One desktop per key: the remote account for its own desktop, plus the RDP server for one behind it (`rdp#<address>`
 * for a direct one).
 */
export function sessionKey (target: RemoteTarget, spec: DesktopSpec): string {
    return spec.id === OWN_DESKTOP ? target.key : `${target.key}#${spec.id}`
}
