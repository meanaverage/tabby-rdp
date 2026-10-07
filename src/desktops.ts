import { ClipboardMode, narrowest, ownClipboard } from './clipboard'
import { HYPERV_PORT, vmId } from './hyperv'
import { configNumber } from './osd'
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
    /**
     * The kind is the user's word: a configured desktop or an RDP profile, of the kind the user gave it (not a VM saved
     * from a host's list as the host reported it, see xrdpFromHost). Only then does an xrdp desktop sign in without
     * Network Level Authentication unasked (see xrdpUnasked). What a host reports is its word: about the VMs it finds,
     * the machines reached through it with ssh, and its own desktop too, whose kind its setup reports. A host could
     * otherwise call any server it offers xrdp, its own included, and have the password sent to it as it is; and a host
     * the user signs in to with an SSH key need not have that password.
     */
    kindTrusted?: boolean
    /** The ways the clipboard goes with this desktop, in place of the setting's (see clipboard.ts). */
    clipboard?: ClipboardMode
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
 *           clipboard: off              # optional: both, fromRemote or off, in place of the setting `clipboard`
 */
export interface ExtraDesktopConfig {
    name?: string
    via?: string
    host?: string
    port?: number
    /** 'windows' (also what null, an imported RDP profile's, and anything else is), 'xrdp' or 'gnome'. */
    kind?: string | null
    username?: string
    domain?: string
    /** A saved account's id; null (an imported RDP profile's options) is none, as are '' and its absence. */
    account?: string | null
    wake?: { vm?: string, mac?: string, broadcast?: string, port?: number, hyperv?: string }
    hyperv?: string
    gateway?: string
    /** A saved account's id or ASK_GATEWAY_ACCOUNT for a separate prompt; null, '' and absence use the desktop's. */
    gatewayAccount?: string | null
    /**
     * Saved from a VM the host found (see saveFoundDesktop): `kind` is what the host reported, not the user's choice
     * (true), until the user picks a kind in the form (false, where xrdpFromHost would otherwise take it for the
     * host's).
     */
    kindFromHost?: boolean
    clipboard?: string
}

export const OWN_DESKTOP = 'own'

/**
 * Whether a `via` value names this SSH target: its alias (label), hostname, user@hostname, or user@hostname:port, as ssh
 * resolved them (or the key itself). Never a machine reached with ssh typed in a host's console: its name, its user and
 * its hostname there are that host's word, which could name any host the user configured desktops behind (and with them
 * their saved accounts). Only its own desktop opens through that host.
 */
export function viaMatches (via: unknown, target: RemoteTarget): boolean {
    const v = configText(via).trim().toLowerCase()
    if (!v || target.via !== undefined) {
        return false
    }
    const { user, host, port } = keyFields(target.key)
    // Also what the add form wrote up to 0.5.0 for a user name with an `@` (alice@corp.example): all after the first.
    const written = `${user}@${host}`.replace(/^[^@]*@/, '')
    return [target.key, `${user}@${host}:${port}`, `${user}@${host}`, host, written, target.label].some(name => name.toLowerCase() === v)
}

/**
 * A config value as text: a string as it is, a number written out. Anything else is none: String() of an object (a
 * hand edit, config sync) runs its own conversions, which can throw, and every desktop listed with it would fail, as
 * would every menu or list that shows it.
 */
export function configText (value: unknown): string {
    return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

/** The desktop an entry describes (a `remoteDesktop.desktops` entry, or an RDP profile's options), or null if unusable. */
export function specOf (extra: ExtraDesktopConfig): DesktopSpec | null {
    // Its own clipboard sharing, or none (the setting's).
    const clipboard = ownClipboard(extra?.clipboard)
    const own = clipboard ? { clipboard } : {}
    const hyperv = vmId(extra?.hyperv)
    if (hyperv) {
        return hyperVSpec(hyperv, configText(extra.name) || hyperv, {
            username: configText(extra.username) || undefined,
            domain: configText(extra.domain) || undefined,
            account: configText(extra.account) || undefined,
            ...own,
        })
    }
    // From a number or text only: Number() of an object from the config runs its conversions, and can throw.
    const port = configNumber(extra?.port || 3389)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return null
    }
    const host = extra.host ? configText(extra.host) : '127.0.0.1'
    // No '#' in a host: it is part of the session and trust keys, which are split on '#' (see keyParts).
    if (!host || host.includes('#')) {
        return null
    }
    const gateway = typeof extra.gateway === 'string' ? extra.gateway.trim() : ''
    return {
        id: `${host}:${port}`,
        name: configText(extra.name) || `${host}:${port}`,
        kind: extra.kind === 'gnome' || extra.kind === 'xrdp' ? extra.kind : 'windows',
        kindTrusted: !xrdpFromHost(extra),
        host,
        port,
        username: configText(extra.username) || undefined,
        domain: configText(extra.domain) || undefined,
        account: configText(extra.account) || undefined,
        wake: parseWake(extra.wake),
        ...gateway ? { gateway, gatewayAccount: configText(extra.gatewayAccount) || undefined } : {},
        ...own,
    }
}

/**
 * Whether an entry is of the xrdp kind on a host's word rather than the user's (see DesktopSpec.kindTrusted): a VM
 * saved from the host's list as the host reported it (`kindFromHost`). Up to 0.5.0 those were saved without the mark,
 * and one then looks like this: xrdp, started by its name when it is off (`wake.vm`, which the save always set). Such
 * an entry is taken for the host's word too, unless the user has picked its kind in the form since (`kindFromHost:
 * false`); a desktop of the user's that looks the same asks once before signing in without NLA.
 */
export function xrdpFromHost (extra: ExtraDesktopConfig): boolean {
    return extra.kind === 'xrdp' && (extra.kindFromHost === true || extra.kindFromHost === undefined && !!extra.wake?.vm)
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
 * to start with). `clipboard`: the setting, which desktops without their own follow.
 */
export function desktopsFor (target: RemoteTarget, extras: ExtraDesktopConfig[] | undefined, found?: OwnDesktopFound, more: ExtraDesktopConfig[] = [], clipboard: ClipboardMode = 'both'): DesktopSpec[] {
    const own: DesktopSpec = found?.kind === 'xrdp'
        ? { id: OWN_DESKTOP, name: `${target.label} desktop`, kind: 'xrdp', host: '127.0.0.1', port: found.xrdpPort ?? 3389, username: found.xrdpUser }
        : found?.kind === 'windows'
            ? { id: OWN_DESKTOP, name: `${target.label} desktop`, kind: 'windows', host: '127.0.0.1', port: 3389, username: keyUser(target.key) || undefined }
            : { id: OWN_DESKTOP, name: `${target.label} desktop`, kind: 'gnome', host: '127.0.0.1', port: 0 }
    // What the setup found, the own desktop's kind and the xrdp besides GNOME below, is the host's word about itself,
    // never trusted (see DesktopSpec.kindTrusted).
    const specs: DesktopSpec[] = [own]
    const behind = (Array.isArray(extras) ? extras : []).filter(extra => extra?.via && viaMatches(extra.via, target))
    for (const extra of [...behind, ...more]) {
        const spec = specOf(extra)
        const kept = spec && specs.find(s => s.id === spec.id)
        if (spec && !kept) {
            specs.push(spec)
        } else if (spec && kept) {
            // The same desktop configured twice (an entry and an RDP profile through this host, say): the first is the
            // one that opens, and its clipboard goes no further than the other's would. Left following the setting
            // where the other lets as much through.
            const narrower = narrowest(kept.clipboard ?? clipboard, spec.clipboard ?? clipboard)
            if (narrower !== (kept.clipboard ?? clipboard)) {
                kept.clipboard = narrower
            }
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

/**
 * The id of a configured desktop (`host:port`), as its DesktopSpec and session keys have it (see specOf), whatever the
 * entry holds: a host or port that is neither text nor a number makes an id that no desktop has, and nothing is kept
 * under it.
 */
export function desktopIdOf (extra: ExtraDesktopConfig): string {
    const hyperv = vmId(extra?.hyperv)
    return hyperv ? `hyperv:${hyperv}` : `${extra?.host ? configText(extra.host) : '127.0.0.1'}:${configNumber(extra?.port || 3389)}`
}

/** Whether an item of `remoteDesktop.desktops` is an entry (a map) at all: anything else describes no desktop. */
export function isDesktopEntry (value: unknown): value is ExtraDesktopConfig {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A configured desktop's entry as menus and lists show it: its name, else its address (see desktopIdOf), and the host
 * it is behind ('' for none), each as text whatever the entry holds. A hand edit or config sync can put anything there,
 * and an entry that can't be shown must not take with it the menus and lists that show the others. `hyperv`: whether
 * it is a Hyper-V VM, told as specOf tells one, by its VM's id: not by its address, which a desktop at a host named
 * hyperv starts the same way.
 */
export function entryText (extra: ExtraDesktopConfig): { name: string, address: string, via: string, hyperv: boolean } {
    const address = desktopIdOf(extra)
    return { name: configText(extra?.name) || address, address, via: configText(extra?.via), hyperv: !!vmId(extra?.hyperv) }
}

/**
 * One desktop per key: the remote account for its own desktop, plus the RDP server for one behind it (`rdp#<address>`
 * for a direct one).
 */
export function sessionKey (target: Pick<RemoteTarget, 'key'>, spec: Pick<DesktopSpec, 'id'>): string {
    return spec.id === OWN_DESKTOP ? target.key : `${target.key}#${spec.id}`
}

/**
 * Whether a desktop signs in without Network Level Authentication without being asked about it first, as xrdp does by
 * design: an xrdp desktop whose kind is trusted (see DesktopSpec.kindTrusted). Every other desktop stops before the
 * password goes as it is to a server that doesn't use it.
 */
export function xrdpUnasked (spec: DesktopSpec): boolean {
    return spec.kind === 'xrdp' && spec.kindTrusted === true
}

/** What keyField writes as `%` and two hex digits, in a key's user, host name and port. */
const ESCAPED_USER = /[%#>\x00-\x1f\x7f]/g
const ESCAPED_HOST = /[%#>@\x00-\x1f\x7f]/g
const ESCAPED_PORT = /[%#>@:\x00-\x1f\x7f]/g

/**
 * A field of `ssh -G` output, fit for a key, so that whatever ssh replies a key keeps its shape and no two targets get
 * the same one: `%` (the escape itself), `#` (it joins a target's key and a desktop's address, see sessionKey), `>` (an
 * SSH tab's key and a machine reached from there, see nestedKey) and control characters are written as `%25`, `%23`,
 * `%3E`, …; so are an `@` in a host name and an `@` or `:` in a port, which would move where the user or the host name
 * ends (see keyFields). A user's own `@` (alice@corp.example), spaces and an IPv6 address's colons stay as they are.
 */
function keyField (value: string, escaped: RegExp): string {
    return value.replace(escaped, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** A field of `ssh -G` output, from the line that names it. */
function configField (out: string, name: string): string | undefined {
    return new RegExp(`^${name} (.+)$`, 'm').exec(out)?.[1]?.trim()
}

/** A target's key: `user@hostname:port` from `ssh -G` output (config aliases and defaults resolved; see keyOf). */
export function keyFromConfig (out: string, destination: string): string {
    return keyOf({ user: configField(out, 'user') ?? '', host: configField(out, 'hostname') ?? destination, port: configField(out, 'port') ?? '22' })
}

/** The key of a target with this user, host name and port (see keyField; keyFields takes it apart again). */
function keyOf (fields: { user: string, host: string, port: string }): string {
    return `${keyField(fields.user, ESCAPED_USER)}@${keyField(fields.host.toLowerCase(), ESCAPED_HOST)}:${keyField(fields.port, ESCAPED_PORT)}`
}

/**
 * Whether some target could have this key now, reached directly or with ssh typed in a tab's console (see nestedKey):
 * it reads the same taken apart and put back together. A key as the plugin made it up to 0.5.0 (see
 * legacyKeyFromConfig) that does could be another target's now (a user name `alice%23ops` then, `alice#ops`'s now).
 */
export function isTargetKey (key: string): boolean {
    const parts = key.split('>')
    return parts.length <= 2 && parts.every(part => keyOf(keyFields(part)) === part)
}

/**
 * A target's key as the plugin made it up to 0.5.0: the fields as ssh printed them. It reads as keyFromConfig's does
 * unless a field has a character keyField now writes as `%xx`; what was kept for the target before is under this one
 * (see RemoteTargets.keyChanged, which moves it).
 */
export function legacyKeyFromConfig (out: string, destination: string): string {
    return `${configField(out, 'user') ?? ''}@${(configField(out, 'hostname') ?? destination).toLowerCase()}:${configField(out, 'port') ?? '22'}`
}

/**
 * The user, host name and port in a target's key (for a machine reached through a host, see nestedKey, that machine's)
 * as ssh resolved them: the user is what comes before the last `@` and the port what comes after the last `:`, since
 * keyField leaves neither in a host name or a port, and every `%` in a field is one keyField wrote.
 */
export function keyFields (key: string): { user: string, host: string, port: string } {
    const fields = key.slice(key.lastIndexOf('>') + 1)
    const at = fields.lastIndexOf('@')
    const colon = fields.lastIndexOf(':')
    const end = colon > at ? colon : fields.length
    const unescape = (field: string) => field.replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    return { user: unescape(fields.slice(0, Math.max(at, 0))), host: unescape(fields.slice(at + 1, end)), port: unescape(fields.slice(end + 1)) }
}

/**
 * The key of a machine reached with `ssh` typed in an SSH tab's console: the tab's key, `>`, and the machine's own as
 * the host there resolves it (`ssh -G`, run there). Everything about that machine comes from that host, which can make
 * it out to be any machine: under the host's own key, what it names is one of its own desktops, never the key (and with
 * it the saved account, the remembered certificate, or the permission to sign in without NLA) of a desktop reached
 * another way.
 */
export function nestedKey (outerKey: string, configOut: string, destination: string): string {
    return `${outerKey}>${keyFromConfig(configOut, destination)}`
}

/**
 * A target's key as it reads, for a list of what is kept by it (Settings › Remote Desktop › Certificates): `%`, `#`,
 * `>`, `@` and `:` as they are rather than as keyField writes them (control characters stay written so), and a machine
 * reached through a host (see nestedKey) named first, through that host.
 */
export function shownKey (key: string): string {
    const fields = (part: string) => part.replace(/%(25|23|3E|40|3A)/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    const [outer, inner] = key.split('>')
    return inner === undefined ? fields(outer) : `${fields(inner)}, through ${fields(outer)}`
}

/**
 * The user in a target's key, as ssh resolved it (not as the key writes it, see keyField): for a machine reached through
 * a host (see nestedKey), that machine's.
 */
export function keyUser (key: string): string {
    return keyFields(key).user
}

/**
 * A session, trust or credential key split into the target it belongs to and the desktop id after it, so matching is
 * anchored on whole parts rather than an `endsWith('#'+id)` that a different key could also satisfy. A key is
 * `<target>#<id>`: the target is `rdp` for a direct desktop, `gateway` for a gateway certificate, or `user@host:port`
 * for a desktop behind an SSH host (`<tab's key>><user@host:port>` for a machine reached through one, see nestedKey;
 * no target's key has a `#`, see keyField); the own desktop's key is the bare target, with no id. A credential key
 * may carry a gateway suffix (`…@gateway#<host:port>`), which names where a password is sent rather than the desktop,
 * and is returned separately so the id still compares equal.
 */
export function keyParts (key: string): { target: string, desktopId: string, gateway: string } {
    const hash = key.indexOf('#')
    if (hash < 0) {
        return { target: key, desktopId: '', gateway: '' }
    }
    const rest = key.slice(hash + 1)
    const at = rest.indexOf('@gateway#')
    return at < 0
        ? { target: key.slice(0, hash), desktopId: rest, gateway: '' }
        : { target: key.slice(0, hash), desktopId: rest.slice(0, at), gateway: rest.slice(at) }
}

/**
 * A session, trust or credential key of the target `from`, as the same key of `to` (see RemoteTargets.keyChanged,
 * which moves what was kept under a target's former key): `from` itself (its own desktop), or `from#<id>`, with a
 * gateway suffix on a saved password's key. Null for any other key. Desktop ids have no `#` (see specOf), so a key that
 * has more of them isn't one of `from`'s desktops, whatever it starts with.
 */
export function rekeyed (key: string, from: string, to: string): string | null {
    if (key === from) {
        return to
    }
    const rest = key.startsWith(`${from}#`) ? key.slice(from.length + 1) : null
    return rest !== null && /^[^#]*(@gateway#[^#]*)?$/.test(rest) ? `${to}#${rest}` : null
}
