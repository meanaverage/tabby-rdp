import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { AppService, ConfigService, NotificationsService, PlatformService, ProfilesService, SelectorService, SplitTabComponent } from 'tabby-core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { DesktopPane, desktopPaneOf, isRDPTab, RDP_PROFILE_TYPE, RemoteTarget, RemoteTargets } from './targets'
import { consoleScript, DeskRequest, MACHINE_ID_COMMAND } from './deskScript'
import { AudioPlayer } from './audio'
import { ConnectionStatus, STYLE as STATS_STYLE } from './connectionStatus'
import { Microphone } from './microphone'
import { SharedDrives, SharedFolder, sharedFolders } from './drives'
import { askDesktop } from './desktopForm'
import { accountKey, accountsOf, newAccountId, SavedAccount, signInName } from './accounts'
import { NewAccountInput, STYLE as ACCOUNT_FORM_STYLE } from './accountForm'
import { FileTransfer, STYLE as FILES_STYLE, uniquePath } from './fileTransfer'
import { desktopIdOf, DesktopSpec, desktopsFor, DIRECT_KEY, ExtraDesktopConfig, OWN_DESKTOP, OwnDesktopFound, sessionKey } from './desktops'
import { RemoteDesktopHelp } from './help'
import { OSD_STYLE, OsdSettings, osdSettings, renderOsd } from './osd'
import { parseRdpFile } from './rdpFile'
import { prepareRemoteDesktop } from './remoteSetup'
import { normalizeFingerprint, RDCleanPathProxy, startRDCleanPathProxy } from './rdcleanpath'
import {
    askCredentials, Credentials, forgetCredentials, forgetCredentialsFor, forgetCredentialsOrFail, hasCredentials, loadCredentials, moveCredentialsFor, saveCredentials,
    storeName, STYLE as SIGNIN_STYLE,
} from './signin'
import { isSSHTab } from './ssh'
import { rdpAnswers, shutDownWhenIdle, waitForRdp, wakeDesktop } from './wake'
import { scanVMs, vmSpec } from './vms'

/** How long a desktop that was started (`wake`) gets to answer. */
const WAKE_TIMEOUT_MS = 3 * 60 * 1000

// The vendored IronRDP bundles are ES modules. tsc turns import() into require(), and Node's import() is refused in
// Tabby on Windows (no dynamic import callback), so they go through a module script: the page's own loader.
let imports = 0
function importESM (url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const key = `__trdImport${imports++}`
        const w = window as any
        const timer = setTimeout(() => {
            delete w[key]
            reject(new Error(`could not load ${url}`))
        }, 20000)
        w[key] = {
            resolve: (m: any) => { clearTimeout(timer); resolve(m) },
            reject: (e: any) => { clearTimeout(timer); reject(e) },
        }
        const script = document.createElement('script')
        script.type = 'module'
        script.textContent = `const r = window.${key}; delete window.${key}; import(${JSON.stringify(url)}).then(r.resolve, r.reject)`
        document.head.appendChild(script)
        script.remove()
    })
}
const vendorFile = (f: string) => path.join(__dirname, '..', 'vendor', f)
const vendor = (f: string) => pathToFileURL(vendorFile(f)).href

const STYLE = `
.trd-overlay { position: absolute; inset: 0; z-index: 30; display: flex; background: #111; }
.trd-host { flex: auto; min-width: 0; min-height: 0; display: flex; }
.trd-host iron-remote-desktop { flex: auto; }
.trd-status { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 14px; align-items: center;
    justify-content: center; padding: 2em; text-align: center; color: #bbb; font-size: 13px; white-space: pre-line;
    pointer-events: none; }
.trd-status-actions { display: flex; gap: 8px; pointer-events: auto; }
.trd-status-actions:empty { display: none; }
.trd-status-help { pointer-events: auto; color: #8ab4f8; font-size: 12px; cursor: pointer; }
.trd-status-help:hover { text-decoration: underline; }
.trd-overlay.trd-dim .trd-host { opacity: 0.2; }
.trd-view-only { display: none; position: absolute; inset: 0; }
.trd-overlay.trd-view-only-on .trd-view-only { display: block; }
.trd-overlay.trd-broadcast-on::before { content: 'Typing into all desktops in this tab'; position: absolute; top: 8px; left: 50%;
    transform: translateX(-50%); z-index: 4; padding: 2px 10px; border-radius: 4px; background: rgba(214, 120, 0, 0.92); color: #fff;
    font-size: 11px; pointer-events: none; white-space: nowrap; }
.trd-view-only::after { content: 'View only'; position: absolute; top: 8px; left: 8px; padding: 2px 8px; border-radius: 4px;
    background: rgba(30, 30, 30, 0.85); color: #ddd; font-size: 11px; pointer-events: none; }
.trd-mic { position: absolute; top: 8px; right: 8px; width: 22px; height: 22px; border-radius: 50%; display: none;
    align-items: center; justify-content: center; background: rgba(220, 38, 38, 0.85); color: #fff; font-size: 11px;
    pointer-events: none; }
.trd-overlay.trd-mic-on .trd-mic { display: flex; }
`

/** A button in the desktop layer's status (Reconnect, Stop, …). */
interface StatusAction {
    label: string
    run: () => void
}

type SessionState = 'connecting' | 'connected' | 'ended'

/** Where a desktop is and how to sign in there (see endpointFor). */
interface Endpoint {
    host: string
    port: number
    credentials: Credentials
    remember: boolean
    /** Where remembering saves them, when not under the desktop's own key: a saved account's keychain entry. */
    saveKey?: string
    /** How the Vault lists them when saved under `saveKey`. */
    saveLabel?: string
    /** The account's sign-in name when the prompt was made: saved only while the account still has it. */
    saveFor?: string
    /** A saved account's domain (empty: none), in place of the desktop's own `domain`. */
    domain?: string
    /** The host's own desktop: the fingerprint of the certificate its setup made, the only one to accept. */
    certificate?: string
}

/** A server certificate the proxy refused (see checkCertificate). */
interface CertificateProblem {
    /** The certificate the setup made (the host's own desktop), or the one remembered (others). */
    expected: string
    actual: string
    /** The host's own desktop: its certificate is the plugin's, so a different one is never to be accepted. */
    pinned: boolean
}

/** A SHA-256 fingerprint on two lines of 16 bytes, so it fits a narrow pane. */
const showFingerprint = (fingerprint: string) => fingerprint ? `${fingerprint.slice(0, 47)}\n${fingerprint.slice(48)}` : '(none)'

/** `remoteDesktop` settings (Tabby config), editable from the menus' Settings and the settings page. */
export interface DesktopSettings {
    /** When the pane changes size: 'live' resizes the remote monitor in place, 'reconnect' reconnects at the new size, 'off' keeps the size. */
    resize: 'live' | 'reconnect' | 'off'
    /** 'standard': one remote pixel per CSS pixel. 'retina': device pixels with matching remote scaling (sharper). */
    sharpness: 'standard' | 'retina'
    /** `desk`: SSH logins run in a shareable session so `desk` can bring the console to the desktop (login hook on the remote). */
    desk: boolean
    /** macOS: ⌘ is sent as Ctrl (⌘C, ⌘V, … as on a Mac). Off: ⌘ is the Windows/Super key. */
    macShortcuts: boolean
    /** Play the remote desktop's sound here (applies on the next connect). */
    sound: boolean
    /** H.264 in the graphics pipeline, decoded by the browser (WebCodecs), where it can (applies on the next connect). */
    h264: boolean
    /** With resize 'off': 'fit' scales the picture to the pane, 'actual' shows it 1:1, scrolling when it's larger. */
    zoom: 'fit' | 'actual'
    /** A small indicator on the desktop: throughput, frames per second, SSH round trip, connection path. */
    connectionStatus: boolean
    /** Send the microphone to the remote desktop while an application there records (applies on the next connect). */
    microphone: boolean
    /** The on-screen display naming a desktop for a moment (see osd.ts). */
    osd: OsdSettings
    /** Look for virtual machines with a desktop on SSH hosts (libvirt), and offer them in the menus. */
    discoverVMs: boolean
    /** Ask npm once a day whether a newer tabby-rdp is out (see updates.ts). */
    checkUpdates: boolean
    /** Minutes without a desktop open after which a VM the plugin started is shut down again; 0: never (see wake.ts). */
    shutDownIdle: number
}

interface RemoteSize {
    width: number
    height: number
    /** Remote desktop scale factor in percent (100 = none). */
    scale: number
}

/**
 * grd ignores the scale factor in RDP monitor layouts, so a Retina-sized remote monitor would render its UI at
 * half size. This applies the scale through Mutter's DisplayConfig (temporarily, like GNOME's Display settings
 * before "Keep changes"), once the new mode is current. Usage: python3 - <width> <height> <scale>
 */
const SCALE_SCRIPT = `
import sys, time
from gi.repository import Gio, GLib
W, H, SCALE = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
def call(method, args=None, reply=None):
    return bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                         'org.gnome.Mutter.DisplayConfig', method, args, reply, 0, -1, None)
# grd can recreate its virtual monitor right after a resize, which resets the scale: keep it applied until it has
# stayed put for a while (about 2 s).
applied, steady = 0, 0
for _ in range(100):
    serial, monitors, logical, _ = call('GetCurrentState').unpack()
    if len(monitors) == 1:
        (connector, _, _, _), modes, _ = monitors[0]
        mode = next((m for m in modes if m[6].get('is-current')), None)
        if mode and (mode[1], mode[2]) == (W, H):
            if logical and abs(logical[0][2] - SCALE) < 0.01:
                steady += 1
                if steady >= 20 or (steady >= 5 and not applied):
                    print('RD_OK scaled' if applied else 'RD_OK scale already set'); sys.exit(0)
            else:
                steady = 0
                if not any(abs(s - SCALE) < 0.01 for s in mode[5]):
                    print('RD_ERR scale not supported for this mode'); sys.exit(0)
                if applied >= 5:
                    print('RD_ERR the scale kept being reset'); sys.exit(0)
                call('ApplyMonitorsConfig', GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
                     (serial, 1, [(0, 0, SCALE, 0, True, [(connector, mode[0], {})])], {})))
                applied += 1
    time.sleep(0.1)
print('RD_OK scaled' if applied else 'RD_ERR the new mode never became current')
`

/** The remote display size for a pane of this size under these settings. */
function remoteSizeFor (rect: { width: number, height: number }, settings: DesktopSettings): RemoteSize {
    const dpr = settings.sharpness === 'retina' ? Math.max(1, window.devicePixelRatio || 1) : 1
    const even = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(v / 2) * 2))
    return {
        width: rect.width ? even(rect.width * dpr, 640, 7680) : 1920,
        height: rect.height ? even(rect.height * dpr, 480, 4320) : 1080,
        scale: Math.round(dpr * 100),
    }
}

class DesktopSession {
    state: SessionState = 'connecting'
    visible = false
    readonly overlay: HTMLElement
    readonly host: HTMLElement
    readonly statusEl: HTMLElement
    proxy: RDCleanPathProxy | null = null
    ui: any = null
    readonly log: string[] = []
    /** What the remote display was last set to. */
    remoteSize: RemoteSize | null = null
    remote: RemoteTarget | null = null
    /** Plays the remote's sound, when the sound setting was on at connect. */
    audio: AudioPlayer | null = null
    /** Captures the microphone for the remote, when the microphone setting was on at connect. */
    mic: Microphone | null = null
    /** Files through the clipboard (drop on the desktop, or copy on the remote). */
    files: FileTransfer | null = null
    /** The shared folders as drives on the remote (see drives.ts), when there were any at connect. */
    drives: SharedDrives | null = null
    /** Decodes H.264 for the graphics pipeline (IronRDP's WebCodecsH264Decoder), when this connection uses it. */
    h264: any = null
    /** No keyboard or mouse input goes to the remote (keys: see keyboard.ts; the mouse: a layer over the picture). */
    viewOnly = false
    /** The host's own desktop: the certificate its setup reported for this connection. */
    pinnedCertificate: string | null = null
    /** Set when the proxy refused the server's certificate on the current connection attempt. */
    certificateProblem: CertificateProblem | null = null
    /** The connection-status indicator, made the first time it shows. */
    indicator: ConnectionStatus | null = null
    /** How the pictures come (for the indicator): the graphics pipeline, bitmaps, or IronRDP's choice. */
    graphics = ''
    /** "What does this mean?" under a message (see status()): opens help about it. */
    onHelp: ((message: string) => void) | null = null
    /** Resolves when the session is disposed (ends a pending sign-in). */
    readonly disposed: Promise<void>
    private markDisposed!: () => void

    /** `key`: see sessionKey(); one desktop per key. */
    constructor (container: HTMLElement, readonly key: string, readonly spec: DesktopSpec) {
        this.disposed = new Promise(resolve => { this.markDisposed = resolve })
        this.overlay = document.createElement('div')
        this.overlay.className = 'trd-overlay'
        this.overlay.innerHTML = `
            <div class="trd-host"></div>
            <div class="trd-view-only" title="View only: no keyboard or mouse input goes to the remote desktop"></div>
            <div class="trd-mic"><i class="fas fa-microphone"></i></div>
            <div class="trd-osd"></div>
            <div class="trd-status"><div class="trd-status-text"></div><div class="trd-status-actions"></div><a class="trd-status-help">What does this mean?</a></div>`
        this.host = this.overlay.querySelector('.trd-host')!
        this.statusEl = this.overlay.querySelector('.trd-status')!
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative'
        }
        container.appendChild(this.overlay)

        // IronRDP only sends keys while its element has focus, but Tabby re-focuses the terminal
        // (asynchronously) whenever the pane is focused, including on a click into the pane. See
        // setVisible(): the terminal can't take focus while the desktop shows; this catches the rest.
        this.container = container
        container.addEventListener('focusin', this.reclaimFocus, true)
        this.overlay.addEventListener('mousedown', () => this.focusDesktop())
        // View only: the layer takes the mouse, so the wheel scrolls an actual-size picture instead of the remote.
        this.overlay.querySelector('.trd-view-only')!.addEventListener('wheel', event => {
            const wheel = event as WheelEvent
            this.host.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('.screen-wrapper')?.scrollBy(wheel.deltaX, wheel.deltaY)
        }, { passive: true })
    }

    setViewOnly (viewOnly: boolean): void {
        this.viewOnly = viewOnly
        this.overlay.classList.toggle('trd-view-only-on', viewOnly)
        this.log.push(`view only: ${viewOnly ? 'on' : 'off'}`)
    }

    private labelTimer?: ReturnType<typeof setTimeout>

    /** Shows which desktop this is, for a moment (see osd.ts). */
    flashLabel (name: string, sub: string, settings: OsdSettings): void {
        const osd = this.overlay.querySelector<HTMLElement>('.trd-osd')!
        renderOsd(osd, name, sub, settings)
        osd.classList.add('trd-shown')
        clearTimeout(this.labelTimer)
        this.labelTimer = setTimeout(() => osd.classList.remove('trd-shown'), settings.seconds * 1000)
    }

    /** IronRDP's canvas: the remote frame, at the remote resolution. */
    canvas (): HTMLCanvasElement | null {
        return this.host.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas') ?? null
    }

    private readonly container: HTMLElement

    private readonly reclaimFocus = (event: FocusEvent): void => {
        if (this.visible && !this.overlay.contains(event.target as Node)) {
            setTimeout(() => this.visible && this.focusDesktop())
        }
    }

    /**
     * Shows or hides the desktop layer. While it shows, the terminal's input textarea is disabled so
     * nothing can focus it: keystrokes can't leak into the shell underneath, and Tabby's re-focus of
     * the terminal becomes a no-op.
     */
    setVisible (visible: boolean): void {
        this.visible = visible
        this.overlay.style.display = visible ? '' : 'none'
        this.container.querySelectorAll<HTMLTextAreaElement>('textarea.xterm-helper-textarea').forEach(input => {
            input.disabled = visible
        })
        if (visible) {
            setTimeout(() => this.visible && this.focusDesktop())
        }
    }

    /**
     * Shows a message over the desktop (empty: none), with buttons; with buttons the last picture is dimmed. `help`:
     * with a "What does this mean?" link, for messages that end the connection.
     */
    status (msg: string, actions: StatusAction[] = [], help = false): void {
        this.log.push(`${new Date().toISOString()} ${msg}`)
        this.statusEl.querySelector('.trd-status-text')!.textContent = msg
        const link = this.statusEl.querySelector<HTMLElement>('.trd-status-help')!
        link.style.display = help && this.onHelp ? '' : 'none'
        link.onclick = () => this.onHelp?.(msg)
        this.statusEl.querySelector('.trd-status-actions')!.replaceChildren(...actions.map(action => {
            const button = document.createElement('button')
            button.className = 'btn btn-secondary'
            button.textContent = action.label
            button.addEventListener('click', () => action.run())
            return button
        }))
        this.statusEl.style.display = msg || actions.length ? '' : 'none'
        this.overlay.classList.toggle('trd-dim', actions.length > 0)
    }

    private disposers: (() => void)[] = []

    onDispose (f: () => void): void {
        this.disposers.push(f)
    }

    /** Focuses the remote desktop. IronRDP reveals its canvas asynchronously, so retry for about half a second. */
    focusDesktop (attempts = 30): void {
        // While the sign-in form shows, it is what takes focus back (the user name, or the password once filled).
        const signin = this.overlay.querySelector<HTMLFormElement>('.trd-signin form')
        if (signin) {
            if (!signin.contains(document.activeElement)) {
                const user = signin.querySelector<HTMLInputElement>('[name=username]')!
                ;(user.value ? signin.querySelector<HTMLInputElement>('[name=password]')! : user).focus()
            }
            return
        }
        const host = this.host.querySelector('iron-remote-desktop')
        this.canvas()?.focus()
        if (host && document.activeElement !== host && attempts > 1 && this.visible) {
            setTimeout(() => this.visible && this.focusDesktop(attempts - 1), 16)
        }
    }

    dispose (): void {
        this.markDisposed()
        this.setVisible(false)
        clearTimeout(this.labelTimer)
        this.container.removeEventListener('focusin', this.reclaimFocus, true)
        this.disposers.forEach(f => f())
        this.indicator?.dispose()
        try { this.ui?.shutdown() } catch { }
        this.audio?.close()
        this.h264?.close()
        this.mic?.close()
        this.files?.dispose()
        this.drives?.dispose()
        this.proxy?.close()
        this.overlay.remove()
    }
}

/**
 * A remote desktop per terminal pane (an SSH tab, or a local terminal running `ssh`), shown as a layer
 * over that pane's terminal. Toggling hides the layer and returns to the console; the RDP session keeps
 * running until disconnected or the pane closes. One desktop per remote account.
 */
@Injectable({ providedIn: 'root' })
export class RemoteDesktopService {
    /** Emits whenever a pane's desktop is opened, shown, hidden, connected, ended or disconnected. */
    readonly changed$ = new Subject<void>()
    private sessions = new Map<DesktopPane, DesktopSession>()
    private ironrdp: Promise<any> | null = null
    /** Whether the browser decodes H.264 (asked once). */
    private h264Support: Promise<boolean> | null = null
    /** Desktops (session keys) where H.264 decoding failed: they connect without it until Tabby restarts. */
    private h264Failed = new Set<string>()

    constructor (
        private app: AppService,
        private targets: RemoteTargets,
        private notifications: NotificationsService,
        private config: ConfigService,
        private zone: NgZone,
        private profiles: ProfilesService,
        private help: RemoteDesktopHelp,
        private selector: SelectorService,
        private platform: PlatformService,
    ) { }

    /**
     * The remote a desktop opened in the pane now is on: the pane's own, or in an SSH tab where `ssh` was typed at
     * the prompt, the machine it went to (as for a local terminal running ssh), through the tab's host. Asks when it
     * can't tell which. Undefined: cancelled.
     */
    private async remoteFor (pane: DesktopPane): Promise<RemoteTarget | null | undefined> {
        const own = await this.targets.targetOf(pane)
        const nested = own && isSSHTab(pane) ? await this.targets.nestedSSH(pane).catch(() => []) : []
        if (!own || !nested.length) {
            return own
        }
        let chosen = nested[0]
        if (nested.length > 1) {
            const picked = await this.selector.show<typeof chosen | null>('Which remote desktop?', [
                ...nested.map(n => ({ name: n.cmd.destination, description: `ssh running in a terminal on ${own.label}`, icon: 'fas fa-desktop', result: n })),
                { name: own.label, description: 'this tab\'s own SSH connection', icon: 'fas fa-desktop', result: null },
            ]).catch(() => undefined)
            if (picked === undefined) {
                return undefined
            }
            if (!picked) {
                return own
            }
            chosen = picked
        }
        return await this.targets.nestedTarget(pane, chosen).catch(() => null) ?? own
    }

    has (pane: DesktopPane): boolean {
        this.prune()
        return this.sessions.has(pane)
    }

    isVisible (pane: DesktopPane): boolean {
        return !!this.sessions.get(pane)?.visible
    }

    async toggle (pane: DesktopPane): Promise<void> {
        if (!this.isVisible(pane)) {
            await this.showDesktop(pane)
        } else if (this.hasConsole(pane)) {
            this.showConsole(pane)
        }
    }

    /** Whether there is a console to switch to: not in a remote desktop tab, where the desktop is all there is. */
    hasConsole (pane: DesktopPane): boolean {
        return !isRDPTab(pane)
    }

    /**
     * What the setup last found on each SSH host (by target key): GNOME, xrdp (and its port) or Windows. Kept for as
     * long as Tabby runs; a Windows host is found out on the first connect there, which costs a failed setup.
     */
    private ownDesktops = new Map<string, OwnDesktopFound>()

    /** Whether a desktop signs in with an account of its own: all but the host's own GNOME desktop. */
    private signsIn (spec: DesktopSpec): boolean {
        return spec.id !== OWN_DESKTOP || spec.kind !== 'gnome'
    }

    /** Whether the pane's desktop signed in with an account (which "Sign in again…" can replace). */
    canSignInAgain (pane: DesktopPane): boolean {
        const spec = this.sessions.get(pane)?.spec
        return !!spec && this.signsIn(spec)
    }

    /**
     * Forgets the saved account of the pane's desktop and connects again, with the sign-in form. For xrdp above all:
     * with a wrong password it shows its own login window rather than refusing, so the form never comes back.
     */
    private askAgain = new WeakSet<DesktopPane>()

    async signInAgain (pane: DesktopPane): Promise<void> {
        const session = this.sessions.get(pane)
        if (session && this.signsIn(session.spec)) {
            await forgetCredentials(session.key)
            // With a saved account, the form asks for its password anew (the saved one stays until then).
            this.askAgain.add(pane)
            await this.reopen(pane, session.spec)
        }
    }

    /**
     * The desktops this pane's SSH host offers: its own, then those configured behind it, then the RDP profiles that go
     * through its SSH profile. A remote desktop tab has just its own one.
     */
    desktopsOf (target: RemoteTarget): DesktopSpec[] {
        if (target.direct) {
            return [target.direct]
        }
        // With their group's defaults (an account for the whole group), as Tabby resolves a profile when opening it.
        const viaProfile = target.profileId
            ? (this.config.store.profiles ?? []).filter((p: any) => p?.type === RDP_PROFILE_TYPE && p.options?.host && p.options.via === target.profileId)
                .map((p: any) => ({ ...this.profiles.getConfigProxyForProfile(p).options, name: p.name }))
            : []
        const specs = desktopsFor(target, this.config.store.remoteDesktop?.desktops, this.ownDesktops.get(target.key), viaProfile)
        // Found VMs come last, and not where a configured desktop has the same address.
        const found = this.settings().discoverVMs ? this.vms.get(target.key)?.specs ?? [] : []
        return [...specs, ...found.filter(f => !specs.some(s => s.id === f.id))]
    }

    /** VMs found on SSH hosts (see vms.ts), by target key: when, and as desktops. */
    private vms = new Map<string, { at: number, specs: DesktopSpec[], scan?: Promise<void> }>()

    /**
     * Looks for VMs with a desktop on the host (libvirt), unless it did in the last minute or the setting is off.
     * Resolves when the list is up to date; menus wait a little for it, and show what they have.
     */
    discoverVMs (target: RemoteTarget): Promise<void> {
        if (!this.settings().discoverVMs || target.direct || typeof target.exec !== 'function') {
            return Promise.resolve()
        }
        const known = this.vms.get(target.key)
        if (known?.scan) {
            return known.scan
        }
        if (known && Date.now() - known.at < 60000) {
            return Promise.resolve()
        }
        const scan = scanVMs(target).then(found => {
            this.vms.set(target.key, { at: Date.now(), specs: found.map(vmSpec) })
            this.changed$.next()
        }, () => {
            this.vms.set(target.key, { at: Date.now(), specs: known?.specs ?? [] })
        })
        this.vms.set(target.key, { at: known?.at ?? 0, specs: known?.specs ?? [], scan })
        return scan
    }

    /** Keeps a found VM open in the pane among the host's desktops (`remoteDesktop.desktops`), under its name. */
    saveFoundDesktop (pane: DesktopPane): void {
        const session = this.sessions.get(pane)
        const spec = session?.spec
        if (!session?.remote || !spec?.found) {
            return
        }
        const entry = { name: spec.name, via: session.remote.label, host: spec.host, port: spec.port, kind: spec.kind, ...spec.wake ? { wake: spec.wake } : {} }
        this.config.store.remoteDesktop.desktops = [...this.configuredDesktops(), entry]
        this.config.save()
        this.changed$.next()
        this.notifications.notice(`Saved "${spec.name}" to ${session.remote.label}'s desktops (Settings › Remote Desktop)`)
    }

    /** The desktop a plain toggle (hotkey, header, toolbar) opens for this target: the last one used there. */
    defaultDesktop (target: RemoteTarget): DesktopSpec {
        const specs = this.desktopsOf(target)
        return specs.find(s => s.id === this.lastUsed.get(target.key)) ?? specs[0]
    }

    /**
     * The desktops of the pane's SSH host (from the last lookup) and the one a plain toggle acts on: the one
     * the pane has open, else the host's default.
     */
    choicesOf (pane: DesktopPane): { specs: DesktopSpec[], current: DesktopSpec | null } {
        const target = this.targets.cached(pane)
        const specs = target ? this.desktopsOf(target) : []
        return { specs, current: this.desktopOf(pane) ?? (target ? this.defaultDesktop(target) : null) }
    }

    /** "Send files…": picks files to paste there. */
    sendFiles (pane: DesktopPane): void {
        this.sessions.get(pane)?.files?.pickAndSend().catch(() => null)
    }

    /** Whether the pane's desktop is connected (and so can take files). */
    isConnected (pane: DesktopPane): boolean {
        return this.sessions.get(pane)?.state === 'connected'
    }

    /** The desktop this pane shows or has open, if any. */
    desktopOf (pane: DesktopPane): DesktopSpec | null {
        return this.sessions.get(pane)?.spec ?? null
    }

    private lastUsed = new Map<string, string>()

    /** `remoteDesktop.accounts`: the saved accounts desktops can sign in with (see accounts.ts). */
    accounts (): SavedAccount[] {
        return accountsOf(this.config.store.remoteDesktop)
    }

    /**
     * The desktops that sign in with a saved account: configured ones behind SSH hosts, and RDP profiles (their own
     * choice, or their profile group's default when they make none). Each comes with what opens its editor.
     */
    accountUses (id: string): { name: string, profileId?: string, desktopIndex?: number }[] {
        const desktops = this.configuredDesktops().flatMap((d, i) => d.account === id ? [{ name: String(d.name ?? desktopIdOf(d)), desktopIndex: i }] : [])
        const groups: any[] = this.config.store.groups ?? []
        const inherited = (p: any) => p.options?.account === undefined && groups.find(g => g.id === p.group)?.defaults?.[RDP_PROFILE_TYPE]?.options?.account === id
        const profiles = (this.config.store.profiles ?? [])
            .filter((p: any) => p?.type === RDP_PROFILE_TYPE && (p.options?.account === id || inherited(p)))
            .map((p: any) => ({ name: String(p.name ?? p.options?.host ?? ''), profileId: p.id ? String(p.id) : undefined }))
        return [...desktops, ...profiles]
    }

    /**
     * Adds a saved account (no id) or changes one. `password`: the new one for the keychain; undefined keeps what is
     * there. A new user name or domain without a new password drops the old password: it was for the old account.
     * Returns the account's id, and the keychain's complaint if the password couldn't be saved.
     */
    async saveAccount (account: Omit<SavedAccount, 'id'> & { id?: string }, password?: string): Promise<{ id: string, keychainError?: string }> {
        const list = this.accounts()
        const old = list.find(a => a.id === account.id)
        const entry: SavedAccount = {
            id: old?.id ?? newAccountId(list),
            name: account.name.trim() || signInName(account),
            username: account.username.trim(),
            ...account.domain?.trim() ? { domain: account.domain.trim() } : {},
        }
        // The password first: a new user name must not be written while the old password (for the old name) stays, nor
        // a new password reported as saved when the store refused it.
        let keychainError: string | undefined
        if (password !== undefined && password !== '') {
            await saveCredentials(accountKey(entry.id), { username: signInName(entry), password }, `saved account ${entry.name}`).catch(e => { keychainError = String(e?.message ?? e) })
        } else if (old && signInName(old) !== signInName(entry)) {
            await forgetCredentialsOrFail(accountKey(entry.id)).catch(e => { keychainError = `the old password couldn't be removed: ${e?.message ?? e}` })
        }
        if (keychainError && !old) {
            // Not added at all: a retry would otherwise make a second account.
            return { id: entry.id, keychainError: `${keychainError}. The account wasn't added` }
        }
        if (keychainError && old && signInName(old) !== signInName(entry)) {
            // The sign-in name stays as it was; the account's name can still change.
            entry.username = old.username
            if (old.domain) {
                entry.domain = old.domain
            } else {
                delete entry.domain
            }
        }
        this.config.store.remoteDesktop.accounts = old ? list.map(a => a === old ? entry : a) : [...list, entry]
        await this.config.save()
        this.changed$.next()
        return { id: entry.id, keychainError }
    }

    /** A desktop form's "New account…": saves it and hands it back for the form's list. */
    private async addAccountFromForm (input: NewAccountInput): Promise<SavedAccount> {
        const { id, keychainError } = await this.saveAccount({ name: input.name, username: input.username, domain: input.domain }, input.password)
        if (keychainError) {
            throw new Error(keychainError)
        }
        return this.accounts().find(a => a.id === id)!
    }

    /** Whether a password is saved for the account; 'unknown' while the Vault is locked (it isn't unlocked for this). */
    accountHasPassword (id: string): Promise<'yes' | 'no' | 'unknown'> {
        return hasCredentials(accountKey(id))
    }

    /** "Remove…" on a saved account: asks first, naming the desktops that use it. Resolves true when removed. */
    async confirmRemoveAccount (id: string): Promise<boolean> {
        const account = this.accounts().find(a => a.id === id)
        if (!account) {
            return false
        }
        const uses = this.accountUses(id)
        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message: `Remove the account "${account.name}"?`,
            detail: `${signInName(account)}. Its saved password is removed too. ` + (uses.length
                ? `${uses.length === 1 ? 'One desktop uses' : `${uses.length} desktops use`} it and will ask for an account when connecting: ${uses.map(u => u.name).join(', ')}.`
                : 'No desktop uses it.'),
            buttons: ['Remove', 'Keep'],
            defaultId: 1,
            cancelId: 1,
        })
        if (response !== 0) {
            return false
        }
        await this.removeAccount(id)
        return true
    }

    /** Removes a saved account and its password; desktops that used it go back to asking. */
    async removeAccount (id: string): Promise<void> {
        const store = this.config.store.remoteDesktop
        store.accounts = this.accounts().filter(a => a.id !== id)
        if (this.configuredDesktops().some(d => d.account === id)) {
            store.desktops = this.configuredDesktops().map(d => {
                if (d.account !== id) {
                    return d
                }
                const { account: _account, ...rest } = d
                return rest
            })
        }
        for (const profile of this.config.store.profiles ?? []) {
            if (profile?.type === RDP_PROFILE_TYPE && profile.options?.account === id) {
                profile.options.account = ''
            }
        }
        // A profile group's default for remote desktop profiles, too.
        for (const group of this.config.store.groups ?? []) {
            const options = group?.defaults?.[RDP_PROFILE_TYPE]?.options
            if (options?.account === id) {
                options.account = ''
            }
        }
        await this.config.save()
        this.changed$.next()
        await forgetCredentialsOrFail(accountKey(id)).catch(e => this.notifications.error(`The account is removed, but its password could not be: ${e?.message ?? e}`))
    }

    /** `remoteDesktop.desktops`: the desktops configured behind SSH hosts. */
    configuredDesktops (): ExtraDesktopConfig[] {
        const list = this.config.store.remoteDesktop?.desktops
        return Array.isArray(list) ? [...list] : []
    }

    /** "Add a desktop behind <host>…": asks over the pane, saves it to the config, and opens it. */
    async addDesktop (pane: DesktopPane): Promise<void> {
        const target = await this.targets.targetOf(pane)
        if (!target) {
            this.notifications.error('No SSH connection found in this terminal')
            return
        }
        if (this.isVisible(pane)) {
            this.showConsole(pane)
        }
        // The resolved hostname, so a profile tab and a plain `ssh` to that machine both offer it.
        const hostname = target.key.replace(/:\d+$/, '').replace(/^[^@]*@/, '')
        const entry = await askDesktop(pane.element.nativeElement, {
            title: `Add a desktop reached through ${target.label}`,
            action: 'Add and open',
            accounts: this.accounts(),
            addAccount: input => this.addAccountFromForm(input),
            entry: { via: hostname, host: '127.0.0.1', port: 3389 },
            check: e => this.addressTaken(e, -1),
        })
        if (!entry) {
            pane.frontend?.focus()
            return
        }
        this.config.store.remoteDesktop.desktops = [...this.configuredDesktops(), entry]
        this.config.save()
        this.changed$.next()
        await this.showDesktop(pane, desktopIdOf(entry))
    }

    /** Another entry for the same host already has this address (desktops are told apart by it). */
    private addressTaken (entry: ExtraDesktopConfig, index: number): string | null {
        const id = desktopIdOf(entry)
        const via = (entry.via ?? '').trim().toLowerCase()
        const taken = this.configuredDesktops().some((d, i) => i !== index && desktopIdOf(d) === id && (d.via ?? '').trim().toLowerCase() === via)
        return taken ? `There is already a desktop at ${id} behind ${entry.via}.` : null
    }

    /**
     * "Edit a desktop": the same form, over the pane, filled in. A new address takes the desktop's saved accounts and
     * sharpness along; a new user name drops the saved account, which was for the old one. Open sessions keep running.
     */
    async editDesktop (pane: DesktopPane, index: number): Promise<void> {
        if (!this.configuredDesktops()[index]) {
            return
        }
        if (this.isVisible(pane)) {
            this.showConsole(pane)
        }
        await this.editDesktopIn(pane.element.nativeElement, index)
        pane.frontend?.focus()
    }

    /** What a desktop's `via` can name: the SSH profiles' names and hosts (see viaMatches), for the form to suggest. */
    private async sshHosts (): Promise<string[]> {
        const profiles = await this.profiles.getProfiles().catch(() => [])
        const names = profiles.filter((p: any) => p.type === 'ssh' && !p.isTemplate)
            .flatMap((p: any) => [p.name?.replace(/\s*\(\.ssh\/config\)$/, ''), p.options?.host].filter(Boolean))
        return [...new Set<string>(names)].sort((a, b) => a.localeCompare(b))
    }

    /** "Edit a desktop" with the form over any element (a pane, or the settings page). */
    async editDesktopIn (host: HTMLElement, index: number, askVia = false): Promise<void> {
        const old = this.configuredDesktops()[index]
        if (!old) {
            return
        }
        const entry = await askDesktop(host, {
            title: `Edit ${old.name ?? desktopIdOf(old)}${askVia ? '' : ` (behind ${old.via})`}`,
            action: 'Save',
            accounts: this.accounts(),
            addAccount: input => this.addAccountFromForm(input),
            hosts: askVia ? await this.sshHosts() : undefined,
            entry: old,
            check: e => this.addressTaken(e, index),
        })
        // Compared with the entry as it is now: the config can change while the form shows.
        const list = this.configuredDesktops()
        if (!entry || list[index] !== old) {
            return
        }
        list[index] = entry
        this.config.store.remoteDesktop.desktops = list
        this.config.save()
        this.changed$.next()
        const accountChanged = (old.username ?? '') !== (entry.username ?? '') || (old.domain ?? '') !== (entry.domain ?? '') || (old.account ?? '') !== (entry.account ?? '')
        await this.desktopEdited(desktopIdOf(old), desktopIdOf(entry), accountChanged, false)
    }

    /**
     * A desktop was edited (the edit form, or an RDP profile's settings): what is kept per desktop is keyed by its
     * address, so a new address takes the saved account, its sharpness, its remembered certificate and the last-used
     * choice along. (Should another machine answer at the new address, its certificate differs and the connection
     * stops to ask, rather than trusting it silently as a first use.) A new user name or domain drops the saved
     * account instead: it was for the old one. `direct`: a direct desktop (`rdp#<id>` keys), otherwise one behind SSH
     * hosts (`<ssh key>#<id>`).
     */
    async desktopEdited (fromId: string, toId: string, accountChanged: boolean, direct: boolean): Promise<void> {
        if (direct) {
            const [from, to] = [`${DIRECT_KEY}#${fromId}`, `${DIRECT_KEY}#${toId}`]
            const saved = !accountChanged && from !== to ? await loadCredentials(from) : null
            if (saved) {
                await saveCredentials(to, saved).catch(() => null)
            }
            if (accountChanged || from !== to) {
                await forgetCredentials(from)
            }
        } else if (accountChanged) {
            await forgetCredentialsFor(fromId)
        } else if (fromId !== toId) {
            await moveCredentialsFor(fromId, toId)
        }
        if (fromId === toId) {
            return
        }
        const moved = (key: string) => direct ? key === `${DIRECT_KEY}#${fromId}` : key.endsWith(`#${fromId}`) && !key.startsWith(`${DIRECT_KEY}#`)
        const store = this.config.store.remoteDesktop
        for (const list of ['desktopSharpness', 'trustedCertificates']) {
            if (Array.isArray(store[list])) {
                store[list] = store[list].map((e: any) => typeof e?.desktop === 'string' && moved(e.desktop)
                    ? { ...e, desktop: `${e.desktop.slice(0, -fromId.length)}${toId}` }
                    : e)
            }
        }
        this.config.save()
        for (const [key, id] of this.lastUsed) {
            if (id === fromId && (key === DIRECT_KEY) === direct) {
                this.lastUsed.set(key, toId)
            }
        }
    }

    /** "Import an .rdp file…": picks one and adds it as a remote desktop profile (see importRdp). */
    async importRdpFile (): Promise<void> {
        const file = await new Promise<File | null>(resolve => {
            const input = document.createElement('input')
            input.type = 'file'
            input.accept = '.rdp'
            input.style.display = 'none'
            input.addEventListener('change', () => { input.remove(); resolve(input.files?.[0] ?? null) })
            input.addEventListener('cancel', () => { input.remove(); resolve(null) })
            document.body.appendChild(input)
            input.click()
        })
        if (file) {
            await this.importRdp(new Uint8Array(await file.arrayBuffer()), file.name)
        }
    }

    /**
     * The profile group for remote desktop profiles the plugin makes itself (an .rdp import, "New profile…" on the
     * settings page): "Remote desktops", made the first time. Profiles made on Tabby's Profiles page go where the user
     * puts them.
     */
    async remoteDesktopGroup (): Promise<string> {
        const groups = await this.profiles.getProfileGroups({ includeNonUserGroup: false })
        const existing = groups.find(g => g.name === 'Remote desktops')
        if (existing?.id) {
            return existing.id
        }
        const group = { name: 'Remote desktops', profiles: [] } as any
        await this.profiles.newProfileGroup(group, { genId: true })
        return group.id
    }

    /**
     * Adds a "Remote desktop (RDP)" profile from a .rdp file's contents (address, user name, domain; see rdpFile.ts)
     * and opens it; or opens the profile that already has that address and user. Returns the profile, or null.
     */
    async importRdp (data: Uint8Array, fileName: string): Promise<any> {
        const parsed = parseRdpFile(data)
        if (!parsed) {
            this.notifications.error(`${fileName}: no address ("full address") in it`)
            return null
        }
        const existing = (this.config.store.profiles ?? []).find((p: any) => p?.type === RDP_PROFILE_TYPE && !p.options?.via &&
            p.options?.host === parsed.host && (p.options.port || 3389) === parsed.port && (p.options.username ?? '') === (parsed.username ?? ''))
        if (existing) {
            this.notifications.info(`Opening "${existing.name}", which is already a profile for ${fileName}`)
            await this.profiles.openNewTabForProfile(existing)
            return existing
        }
        const profile = {
            type: RDP_PROFILE_TYPE,
            name: fileName.replace(/^.*[\\/]/, '').replace(/\.rdp$/i, '') || parsed.host,
            icon: 'fas fa-desktop',
            group: await this.remoteDesktopGroup(),
            options: { host: parsed.host, port: parsed.port, kind: 'windows', username: parsed.username ?? '', domain: parsed.domain ?? '', via: '' },
        }
        await this.profiles.newProfile(profile)
        this.config.save()
        this.notifications.notice(`Added the remote desktop profile "${profile.name}" (Settings › Profiles & connections)`)
        await this.profiles.openNewTabForProfile(profile)
        return profile
    }

    /** Asks, then removes a configured desktop (see removeDesktop). The menus and the settings page use this. */
    async confirmRemoveDesktop (index: number): Promise<boolean> {
        const d = this.configuredDesktops()[index]
        if (!d) {
            return false
        }
        const address = `${d.host ?? '127.0.0.1'}:${d.port ?? 3389}`
        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message: `Remove the desktop "${d.name ?? address}"?`,
            detail: `${address} behind ${d.via}. Its saved password and remembered certificate are forgotten too. ` +
                'To open it instead, use its host\'s SSH tab: right-click › Open.',
            buttons: ['Remove', 'Keep'],
            defaultId: 1,
            cancelId: 1,
        })
        if (response !== 0) {
            return false
        }
        this.removeDesktop(index)
        return true
    }

    /** Removes a configured desktop, its saved accounts and its remembered certificate. Open sessions to it keep running. */
    removeDesktop (index: number): void {
        const list = this.configuredDesktops()
        const [removed] = list.splice(index, 1)
        if (!removed) {
            return
        }
        const id = `${removed.host ?? '127.0.0.1'}:${removed.port ?? 3389}`
        this.config.store.remoteDesktop.desktops = list
        this.forgetCertificatesFor(id)
        this.config.save()
        this.changed$.next()
        forgetCredentialsFor(id)
    }

    /**
     * Shows a desktop over the pane: `desktopId` (see desktopsOf), or the one it has open, or the default. A pane
     * holds one desktop at a time; choosing another one replaces it.
     */
    async showDesktop (pane: DesktopPane, desktopId?: string, options: { background?: boolean, viewOnly?: boolean, target?: RemoteTarget } = {}): Promise<void> {
        this.prune()
        let session = this.sessions.get(pane)
        if (session?.state === 'ended' || session && desktopId && session.spec.id !== desktopId) {
            this.disconnect(pane)
            session = undefined
        }
        if (!session) {
            const target = options.target ?? await this.remoteFor(pane)
            if (target === undefined) {
                return
            }
            if (!target) {
                this.notifications.error('No SSH connection found in this terminal')
                return
            }
            if (this.sessions.has(pane)) {
                // Opened meanwhile (e.g. a double click); just show it.
                return this.showDesktop(pane, desktopId)
            }
            const spec = desktopId ? this.desktopsOf(target).find(s => s.id === desktopId) : this.defaultDesktop(target)
            if (!spec) {
                this.notifications.error('That desktop is no longer configured for this host')
                return
            }
            this.lastUsed.set(target.key, spec.id)
            const key = sessionKey(target, spec)
            // One desktop per key: another client would only get an extra, empty monitor (GNOME), or take
            // over the session (Windows).
            const existing = this.paneWithDesktopFor(key)
            if (existing) {
                if (existing.parent instanceof SplitTabComponent && existing.parent === pane.parent) {
                    // Next to it, moving the focus there would go unnoticed.
                    this.help.note(pane.element.nativeElement, `${target.label}'s desktop is already open in the other pane.`, 'nested-ssh')
                }
                this.selectPane(existing)
                return this.showDesktop(existing)
            }
            const created = new DesktopSession(pane.element.nativeElement, key, spec)
            created.onHelp = message => this.help.explain(message)
            if (options.viewOnly) {
                created.setViewOnly(true)
            }
            session = created
            this.sessions.set(pane, created)
            // Released with the session: a pane outlives the desktops opened and closed in it.
            const destroyed = pane.destroyed$.subscribe(() => this.disconnect(pane))
            created.onDispose(() => destroyed.unsubscribe())
            // Tabby focuses the terminal when the pane gets focus (tab switch, split focus); take it back.
            const focused = pane.focused$.subscribe(() => {
                if (created.visible) {
                    setTimeout(() => created.visible && created.focusDesktop())
                    this.label(pane, created)
                }
            })
            created.onDispose(() => focused.unsubscribe())
            this.connect(pane, target, spec, created)
        }
        if (options.background) {
            return
        }
        session.setVisible(true)
        session.overlay.classList.toggle('trd-broadcast-on', this.isBroadcast(pane))
        this.syncIndicator(session)
        this.changed$.next()
        this.tip(pane, session)
        this.label(pane, session)
        const shown = session
        setTimeout(() => this.followPane(pane, shown))
    }

    /**
     * `desk`: show this machine's desktop and bring the console along: a terminal on the desktop,
     * attached to the console's tmux session (or opened in its folder when it isn't in tmux).
     */
    async openConsole (pane: DesktopPane, request: DeskRequest): Promise<void> {
        const target = await this.targets.targetOf(pane)
        if (!target) {
            return
        }
        // `desk` may run on another machine than the pane is connected to: `ssh` typed in its console, with the script
        // there through a shared home folder. That machine's desktop isn't this connection's to open.
        if (request.machine) {
            const machineOf = async (t: RemoteTarget) => (await t.exec('sh -s', MACHINE_ID_COMMAND).catch(() => '')).trim()
            const machine = await machineOf(target)
            if (machine && machine !== request.machine) {
                // Typed `ssh` at the prompt: the machine it went to, when that is where desk ran.
                for (const nested of isSSHTab(pane) ? await this.targets.nestedSSH(pane).catch(() => []) : []) {
                    const there = await this.targets.nestedTarget(pane, nested).catch(() => null)
                    if (there && await machineOf(there) === request.machine) {
                        return this.openConsoleOn(pane, there, request)
                    }
                }
                const there = request.hostname || 'another machine'
                this.help.note(pane.element.nativeElement, `desk ran on ${there}, but this tab is connected to ${target.label}. ` +
                    `Open ${there} in its own tab to use desk there.`, 'nested-ssh')
                return
            }
        }
        return this.openConsoleOn(pane, target, request)
    }

    private async openConsoleOn (pane: DesktopPane, target: RemoteTarget, request: DeskRequest): Promise<void> {
        await this.showDesktop(pane, OWN_DESKTOP, { target })
        // Wait for the desktop (possibly another pane's, for the same account) to be connected.
        let session: DesktopSession | undefined
        for (let i = 0; i < 240; i++) {
            const owner = this.paneWithDesktopFor(target.key)  // the host's own desktop
            session = owner ? this.sessions.get(owner) : undefined
            if (!session || session.state !== 'connecting') {
                break
            }
            await new Promise(r => setTimeout(r, 250))
        }
        if (session?.state !== 'connected') {
            return
        }
        if (session.spec.kind !== 'gnome') {
            // The terminal it opens is GNOME's, on the headless GNOME session.
            this.notifications.error(`desk: needs a GNOME desktop; this one is ${session.spec.kind === 'xrdp' ? 'served by xrdp' : 'Windows'}`)
            return
        }
        try {
            const out = await target.exec('sh -s', consoleScript(request))
            const err = /^RD_ERR (.*)$/m.exec(out)
            session.log.push(err ? `desk: ${err[1]}` : `desk: ${/^RD_OK (.*)$/m.exec(out)?.[1] ?? 'no result'}`)
            if (err) {
                this.notifications.error(`desk: ${err[1]}`)
            }
        } catch (e: any) {
            this.notifications.error(`desk: ${e?.message ?? e}`)
        }
    }

    /** True when this pane has no desktop but another pane has this desktop (default: the toggle's) open. */
    isOpenElsewhere (pane: DesktopPane, spec?: DesktopSpec): boolean {
        const target = this.targets.cached(pane)
        if (!target || this.has(pane)) {
            return false
        }
        return !!this.paneWithDesktopFor(sessionKey(target, spec ?? this.defaultDesktop(target)))
    }

    private paneWithDesktopFor (key: string): DesktopPane | null {
        for (const [pane, session] of this.sessions) {
            if (session.key === key && session.state !== 'ended') {
                return pane
            }
        }
        return null
    }

    /** Drops sessions of panes that are gone: "close all" and closing the window skip destroyed$. */
    private prune (): void {
        if (!this.sessions.size) {
            return
        }
        const alive = new Set(this.app.tabs.flatMap(t => t instanceof SplitTabComponent ? t.getAllTabs() : [t]))
        for (const [pane, session] of [...this.sessions]) {
            if (!alive.has(pane)) {
                this.sessions.delete(pane)
                session.dispose()
            }
        }
    }

    /** Brings a pane forward: its top-level tab, and the pane itself within a split. */
    private selectPane (pane: DesktopPane): void {
        const top = this.app.tabs.find(t => t === pane || (t instanceof SplitTabComponent && t.getAllTabs().includes(pane)))
        if (top) {
            this.app.selectTab(top)
        }
        if (pane.parent instanceof SplitTabComponent) {
            pane.parent.focus(pane)
        }
    }

    showConsole (pane: DesktopPane): void {
        const session = this.sessions.get(pane)
        if (session) {
            session.setVisible(false)
            this.syncIndicator(session)
            this.changed$.next()
        }
        pane.frontend?.focus()
    }

    disconnect (pane: DesktopPane): void {
        this.cancelReconnect(pane)
        this.drop(pane)
    }

    private drop (pane: DesktopPane, refocus = true): void {
        const session = this.sessions.get(pane)
        if (!session) {
            return
        }
        this.sessions.delete(pane)
        const wasVisible = session.visible
        session.dispose()
        this.changed$.next()
        if (wasVisible && refocus) {
            pane.frontend?.focus()
        }
    }

    /** Automatic reconnection after a desktop dropped, per pane: attempts so far and the pending timer. */
    private reconnects = new Map<DesktopPane, { attempts: number, timer?: ReturnType<typeof setTimeout>, since: number }>()
    private static readonly RECONNECT_DELAYS = [1, 2, 4, 8, 15, 30]

    private cancelReconnect (pane: DesktopPane): void {
        clearTimeout(this.reconnects.get(pane)?.timer)
        this.reconnects.delete(pane)
    }

    /** Connects this pane's desktop again, keeping it shown or hidden as it was. */
    private async reopen (pane: DesktopPane, spec: DesktopSpec, automatic = false): Promise<void> {
        if (!automatic) {
            this.cancelReconnect(pane)
        }
        const session = this.sessions.get(pane)
        const background = !!session && !session.visible
        this.drop(pane, false)
        // The same remote as before, even if the `ssh` it was found through has ended since.
        await this.zone.run(() => this.showDesktop(pane, spec.id, { background, viewOnly: session?.viewOnly, target: session?.remote ?? undefined }))
    }

    /** After a desktop ended: reconnect by itself if it dropped, otherwise offer to. */
    private afterEnd (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, outcome: { connected: boolean, error?: string, reason?: string }): void {
        session.state = 'ended'
        this.syncIndicator(session)
        this.changed$.next()
        if (this.sessions.get(pane) !== session) {
            return
        }
        const sshDown = !target.isOpen()
        const retrying = this.reconnects.has(pane)
        const again = (label: string): StatusAction => ({ label, run: () => this.reopen(pane, spec) })
        if (outcome.connected ? outcome.error !== undefined || sshDown : retrying || sshDown) {
            this.scheduleReconnect(pane, target, spec, session, outcome.connected
                ? `Connection lost${outcome.error ? `: ${outcome.error}` : ''}.`
                : `Couldn't reconnect: ${outcome.error ?? outcome.reason ?? 'unknown error'}.`)
        } else if (outcome.connected) {
            session.status(`Remote desktop session ended: ${outcome.reason ?? 'unknown reason'}`, [again('Reconnect')])
        } else {
            session.status(`Remote desktop failed: ${outcome.error ?? 'unknown error'}`, [again('Try again')], true)
        }
    }

    private scheduleReconnect (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, message: string): void {
        // since: when the desktop dropped (see openElsewhere).
        const state = this.reconnects.get(pane) ?? { attempts: 0, since: Date.now() }
        this.reconnects.set(pane, state)
        clearTimeout(state.timer)
        const current = () => this.sessions.get(pane) === session
        const stop: StatusAction = {
            label: 'Stop',
            run: () => {
                this.cancelReconnect(pane)
                session.status(message, [{ label: 'Reconnect', run: () => this.reopen(pane, spec) }])
            },
        }
        if (!target.isOpen()) {
            // The desktop layer hides the console, where Tabby offers to reconnect SSH: offer it here too.
            const actions = [...target.reconnectSSH ? [{ label: 'Reconnect SSH', run: () => target.reconnectSSH!().catch(() => null) }] : [], stop]
            session.status(`${message}\nWaiting for the SSH connection to ${target.label}…`, actions)
            state.timer = setTimeout(() => {
                if (current()) {
                    target.isOpen() ? this.reopen(pane, spec, true) : this.scheduleReconnect(pane, target, spec, session, message)
                }
            }, 2000)
            return
        }
        const delays = RemoteDesktopService.RECONNECT_DELAYS
        if (state.attempts >= delays.length) {
            this.reconnects.delete(pane)
            session.status(`${message}\nStopped reconnecting automatically.`, [{ label: 'Reconnect', run: () => this.reopen(pane, spec) }], true)
            return
        }
        const delay = delays[state.attempts++]
        session.status(`${message}\nReconnecting in ${delay} s…`, [{ label: 'Reconnect now', run: () => this.reopen(pane, spec, true) }, stop])
        state.timer = setTimeout(() => current() && this.reopen(pane, spec, true), delay * 1000)
    }

    settings (): DesktopSettings {
        const store = this.config.store.remoteDesktop ?? {}
        return {
            resize: ['live', 'reconnect', 'off'].includes(store.resize) ? store.resize : 'live',
            sharpness: store.sharpness === 'retina' ? 'retina' : 'standard',
            desk: store.desk === true,
            macShortcuts: store.macShortcuts !== false,
            sound: store.sound !== false,
            h264: store.h264 !== false,
            zoom: store.zoom === 'actual' ? 'actual' : 'fit',
            connectionStatus: store.connectionStatus === true,
            microphone: store.microphone === true,
            osd: osdSettings(store.osd),
            discoverVMs: store.discoverVMs !== false,
            checkUpdates: store.checkUpdates !== false,
            shutDownIdle: [5, 15, 60].includes(Number(store.shutDownIdle)) ? Number(store.shutDownIdle) : 0,
        }
    }

    /** The folders shared with remote desktops as drives (`remoteDesktop.sharedFolders`), tidied. */
    sharedFolders (): SharedFolder[] {
        return sharedFolders(this.config.store.remoteDesktop)
    }

    /** Replaces the shared folders; applies to desktops connecting from now on. */
    setSharedFolders (folders: SharedFolder[]): void {
        this.config.store.remoteDesktop.sharedFolders = folders.map(f => ({ path: f.path, name: f.name, readOnly: f.readOnly }))
        this.config.save()
        this.changed$.next()
    }

    /** The sharpness chosen for the pane's desktop in particular (`remoteDesktop.desktopSharpness`), or null. */
    ownSharpness (pane: DesktopPane): DesktopSettings['sharpness'] | null {
        const key = this.sessions.get(pane)?.key
        return key ? this.sharpnessFor(key) : null
    }

    /** Sets (or, with null, clears) the sharpness of the pane's desktop in particular, and applies it. */
    setOwnSharpness (pane: DesktopPane, sharpness: DesktopSettings['sharpness'] | null): void {
        const key = this.sessions.get(pane)?.key
        if (!key) {
            return
        }
        const store = this.config.store.remoteDesktop
        const others = (Array.isArray(store.desktopSharpness) ? store.desktopSharpness : []).filter((e: any) => e?.desktop !== key)
        store.desktopSharpness = sharpness ? [...others, { desktop: key, sharpness }] : others
        this.config.save()
        for (const [p, session] of this.sessions) {
            if (session.key === key) {
                this.followPane(p, session)
            }
        }
    }

    private sharpnessFor (key: string): DesktopSettings['sharpness'] | null {
        const list = this.config.store.remoteDesktop?.desktopSharpness
        const value = (Array.isArray(list) ? list : []).find((e: any) => e?.desktop === key)?.sharpness
        return value === 'retina' || value === 'standard' ? value : null
    }

    /** The settings for a desktop: the defaults, with its own sharpness if it has one. */
    private settingsFor (session: DesktopSession): DesktopSettings {
        const settings = this.settings()
        return { ...settings, sharpness: this.sharpnessFor(session.key) ?? settings.sharpness }
    }

    /** Changes a setting, saves it, and applies it to open desktops. */
    updateSettings (change: Partial<DesktopSettings>): void {
        const store = this.config.store.remoteDesktop
        const { osd, ...rest } = change
        Object.assign(store, rest)
        if (osd) {
            // A nested object in Tabby's config takes its fields one by one (the object itself isn't replaced).
            Object.assign(store.osd, osd)
        }
        if (change.h264) {
            this.h264Failed.clear()  // turned on again: give it another try everywhere
        }
        this.config.save()
        for (const [pane, session] of this.sessions) {
            this.applyZoom(session)
            this.syncIndicator(session)
            this.followPane(pane, session)
        }
    }

    /** IronRDP's ScreenScale for the picture: Real (1:1, scrolling) only with a fixed resolution and zoom 'actual'. */
    private screenScale (): 1 | 3 {
        const settings = this.settings()
        return settings.resize === 'off' && settings.zoom === 'actual' ? 3 /* ScreenScale.Real */ : 1 /* ScreenScale.Fit */
    }

    private applyZoom (session: DesktopSession): void {
        try { session.ui?.setScale(this.screenScale()) } catch { }
    }

    /** Shows the desktop's connection-status indicator while the setting is on and the desktop shows, connected. */
    private syncIndicator (session: DesktopSession): void {
        const on = this.settings().connectionStatus && session.visible && session.state === 'connected'
        if (on && !session.indicator) {
            const remote = session.remote
            session.indicator = new ConnectionStatus(session.overlay, this.zone, {
                path: () => {
                    const spec = session.spec
                    const size = session.remoteSize
                    return [
                        spec.id === OWN_DESKTOP ? spec.name : remote?.direct ? `${spec.name} (direct)` : `${spec.name} via ${remote?.label ?? '?'}`,
                        size ? `${size.width}×${size.height}` : '',
                        session.graphics,
                        this.settingsFor(session).sharpness === 'retina' ? 'Retina' : 'Standard',
                    ].filter(Boolean).join(' · ')
                },
                bytes: () => session.proxy?.stats ?? null,
                ping: remote?.ping ? () => remote.ping!() : undefined,
            })
        }
        const canvas = session.host.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas')
        session.indicator?.setActive(on, on ? canvas : null)
    }

    /** Follows the pane's size (debounced) while the desktop shows, per the resize setting. */
    private watchSize (pane: DesktopPane, session: DesktopSession): void {
        let timer: any
        const observer = new ResizeObserver(() => {
            // Refit the view right away (the component only refits on window resizes by itself) ...
            this.applyZoom(session)
            // ... and change the remote resolution once the size settles.
            clearTimeout(timer)
            timer = setTimeout(() => this.followPane(pane, session), 300)
        })
        observer.observe(session.overlay)
        session.onDispose(() => {
            clearTimeout(timer)
            observer.disconnect()
        })
    }

    private followPane (pane: DesktopPane, session: DesktopSession): void {
        const rect = session.overlay.getBoundingClientRect()
        if (session.state !== 'connected' || !session.visible || !rect.width || !rect.height) {
            return  // hidden panes measure 0; they catch up when shown again
        }
        const settings = this.settingsFor(session)
        const wanted = remoteSizeFor(rect, settings)
        const current = session.remoteSize
        if (settings.resize === 'off' || current && current.width === wanted.width && current.height === wanted.height && current.scale === wanted.scale) {
            return
        }
        if (settings.resize === 'reconnect') {
            session.log.push(`resize: reconnecting at ${wanted.width}x${wanted.height}`)
            const viewOnly = session.viewOnly
            this.zone.run(() => {
                this.disconnect(pane)
                this.showDesktop(pane, undefined, { viewOnly })
            })
            return
        }
        this.applySize(session, wanted)
    }

    private applySize (session: DesktopSession, size: RemoteSize): void {
        session.log.push(`resize: ${size.width}x${size.height} @${size.scale}%`)
        const before = session.remoteSize
        session.remoteSize = size
        if (session.spec.kind !== 'gnome') {
            // Windows takes the scale from the monitor layout only when it also has the monitor's physical size (mm).
            // xrdp gets it too; it can take its session's DPI from it.
            const mm = (px: number) => Math.round(px / (size.scale / 100) / 96 * 25.4)
            session.ui.resize(size.width, size.height, size.scale, mm(size.width), mm(size.height))
        } else {
            session.ui.resize(size.width, size.height, size.scale)
        }
        // grd ignores the scale in the monitor layout: it's set through Mutter (also back to 100%).
        if ((size.scale !== 100 || (before?.scale ?? 100) !== 100) && session.remote && session.spec.id === OWN_DESKTOP && session.spec.kind === 'gnome') {
            session.remote.exec(`python3 - ${size.width} ${size.height} ${size.scale / 100}`, SCALE_SCRIPT).then(out => {
                session.log.push(`scale: ${/^RD_(OK|ERR) (.*)$/m.exec(out)?.[2] ?? out.trim().slice(-120)}`)
            }, e => session.log.push(`scale: ${e?.message ?? e}`))
        }
    }

    /**
     * Whether this connection decodes H.264: the setting, the browser (WebCodecs), and no failure on this desktop
     * since Tabby started.
     */
    private async useH264 (rdp: any, session: DesktopSession, settings: DesktopSettings): Promise<boolean> {
        if (!settings.h264 || this.h264Failed.has(session.key) || typeof rdp.h264Decoder !== 'function') {
            return false
        }
        this.h264Support ??= Promise.resolve(rdp.h264Supported()).catch(() => false)
        return this.h264Support
    }

    isViewOnly (pane: DesktopPane): boolean {
        return !!this.sessions.get(pane)?.viewOnly
    }

    /** View only: the pane's desktop gets no keyboard or mouse input (the picture, clipboard and sound go on). */
    setViewOnly (pane: DesktopPane, viewOnly: boolean): void {
        const session = this.sessions.get(pane)
        if (session) {
            session.setViewOnly(viewOnly)
            this.changed$.next()
        }
    }

    /**
     * For keys sent from a menu: brings the pane's desktop forward and focuses it, since IronRDP only takes keys
     * while it has focus. False when it can't take them (not connected, view only, or focus didn't stick).
     */
    async takeKeyboard (pane: DesktopPane): Promise<boolean> {
        const session = this.sessions.get(pane)
        if (!session || session.state !== 'connected' || session.viewOnly) {
            return false
        }
        if (!session.visible) {
            await this.showDesktop(pane)
        }
        if (desktopPaneOf(this.app.activeTab) !== pane) {
            this.selectPane(pane)
        }
        // After a tab switch, the pane shows on Angular's next change detection.
        for (let i = 0; i < 30; i++) {
            session.focusDesktop(1)
            const focused = document.activeElement
            if (focused?.tagName === 'IRON-REMOTE-DESKTOP' && session.overlay.contains(focused)) {
                return true
            }
            await new Promise(resolve => setTimeout(resolve, 16))
        }
        session.log.push('keys: the desktop did not take the keyboard')
        return false
    }

    /**
     * Saves the remote frame as a PNG in Downloads (never overwriting) and copies it to the clipboard. The canvas is
     * at the remote resolution, so this is the full picture whatever the pane's size. Returns the file.
     */
    async saveScreenshot (pane: DesktopPane): Promise<string | null> {
        const session = this.sessions.get(pane)
        const canvas = session?.state === 'connected' ? session.canvas() : null
        if (!session || !canvas) {
            return null
        }
        try {
            const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
            if (!blob) {
                throw new Error('the picture could not be encoded')
            }
            const png = Buffer.from(await blob.arrayBuffer())
            const dir = path.join(os.homedir(), 'Downloads')
            const now = new Date()
            const two = (n: number) => String(n).padStart(2, '0')
            const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} at ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`
            const name = `Screenshot ${session.spec.name} ${stamp}`.replace(/[\\/:*?"<>|]/g, '-')
            await fs.promises.mkdir(dir, { recursive: true })
            const file = uniquePath(path.join(dir, `${name}.png`))
            await fs.promises.writeFile(file, png, { flag: 'wx' })
            session.log.push(`screenshot: saved ${file}`)
            let copied = true
            try {
                const { clipboard, nativeImage } = require('electron')
                clipboard.writeImage(nativeImage.createFromBuffer(png))
            } catch (e: any) {
                copied = false
                session.log.push(`screenshot: clipboard: ${e?.message ?? e}`)
            }
            session.files?.toast(`Screenshot saved to ${path.basename(dir)}${copied ? ' and copied to the clipboard' : ''}`, [{
                label: process.platform === 'darwin' ? 'Show in Finder' : 'Show in folder',
                run: () => require('electron').shell.showItemInFolder(file),
            }])
            return file
        } catch (e: any) {
            session.log.push(`screenshot: ${e?.message ?? e}`)
            this.notifications.error(`Couldn't save the screenshot: ${e?.message ?? e}`)
            return null
        }
    }

    /**
     * Which desktop a pane shows, for a moment (connected, shown, focused), like a TV naming its input. By default only
     * where nothing else says: in a split, whose pane headers name the SSH connection, and for a desktop other than
     * that connection's own (behind the host, or where ssh was typed on to).
     */
    private label (pane: DesktopPane, session: DesktopSession, always = false): void {
        const target = session.remote
        const osd = this.settings().osd
        if (session.state !== 'connected' || !session.visible || !target || osd.show === 'off' && !always) {
            return
        }
        const inSplit = pane.parent instanceof SplitTabComponent && pane.parent.getAllTabs().length > 1
        const own = session.spec.id === OWN_DESKTOP
        if (osd.show === 'auto' && !always && !inSplit && own && !target.via) {
            return
        }
        // A desktop named after its host already says where it is ("buildhost desktop (xrdp)").
        const through = own ? target.via : target.direct || session.spec.name.startsWith(target.label) ? null : target.label
        const size = session.remoteSize ? `${session.remoteSize.width}×${session.remoteSize.height}` : ''
        session.flashLabel(own ? target.label : session.spec.name, [through ? `via ${through}` : '', size].filter(Boolean).join(' · '), osd)
    }

    /** Shows the on-screen display on every desktop showing now, whatever `show` says (to try the settings). */
    showOsdEverywhere (): number {
        let shown = 0
        for (const [pane, session] of this.sessions) {
            if (session.state === 'connected' && session.visible) {
                this.label(pane, session, true)
                shown++
            }
        }
        return shown
    }

    /** The one-time tip (see RemoteDesktopHelp.tipOnce), once a desktop is connected and showing. */
    private tip (pane: DesktopPane, session: DesktopSession): void {
        if (session.state === 'connected' && session.visible) {
            this.help.tipOnce(session.overlay, this.hasConsole(pane), () => session.visible && session.focusDesktop())
        }
    }

    /** The open desktops, for the settings page (and bug reports): where they are, and their logs. */
    sessionSummaries (): { name: string, where: string | null, state: string, log: string[] }[] {
        this.prune()
        return [...this.sessions.values()].map(session => ({
            name: session.spec.name,
            where: session.remote && !session.remote.direct ? session.remote.label : null,
            state: session.state === 'connected' ? (session.visible ? 'connected, showing' : 'connected, in the background')
                : session.state === 'connecting' ? 'connecting' : 'not connected',
            log: [...session.log],
        }))
    }

    /** The certificates remembered for desktops (`remoteDesktop.trustedCertificates`). */
    trustedCertificates (): { desktop: string, sha256: string }[] {
        const list = this.config.store.remoteDesktop?.trustedCertificates
        return (Array.isArray(list) ? list : [])
            .filter((e: any) => typeof e?.desktop === 'string' && typeof e?.sha256 === 'string')
            .map((e: any) => ({ desktop: e.desktop, sha256: normalizeFingerprint(e.sha256) || e.sha256 }))
    }

    /** Forgets one remembered certificate (by session key); the next connection remembers the one it meets. */
    forgetCertificate (key: string): void {
        const store = this.config.store.remoteDesktop
        store.trustedCertificates = (Array.isArray(store.trustedCertificates) ? store.trustedCertificates : []).filter((e: any) => e?.desktop !== key)
        this.config.save()
        this.changed$.next()
    }

    /** Split tabs where keys typed on one desktop go to all of them (see DesktopKeyboard). */
    private broadcast = new WeakSet<SplitTabComponent>()

    /** The split tab holding the pane, if it has more than one pane. */
    private splitOf (pane: DesktopPane): SplitTabComponent | null {
        const split = this.app.tabs.find(t => t instanceof SplitTabComponent && t.getAllTabs().includes(pane)) as SplitTabComponent | undefined
        return split && split.getAllTabs().length > 1 ? split : null
    }

    /** The other connected desktops in the pane's tab that take input (not view only), with their sessions. */
    private othersInTab (pane: DesktopPane): { pane: DesktopPane, session: DesktopSession }[] {
        const split = this.splitOf(pane)
        return split ? split.getAllTabs().filter(p => p !== pane).map(p => ({ pane: p as DesktopPane, session: this.sessions.get(p as DesktopPane)! }))
            .filter(({ session }) => session?.state === 'connected' && !session.viewOnly && session.ui) : []
    }

    /** How many desktops in the pane's tab would get a paste or typing (itself included), when that's more than one. */
    desktopsInTab (pane: DesktopPane): number {
        const own = this.sessions.get(pane)
        return this.othersInTab(pane).length + (own?.state === 'connected' && !own.viewOnly ? 1 : 0)
    }

    isBroadcast (pane: DesktopPane): boolean {
        const split = this.splitOf(pane)
        return !!split && this.broadcast.has(split)
    }

    /** Keys typed on one desktop of the pane's tab go to all of them, or no longer; each shows it while it does. */
    setBroadcast (pane: DesktopPane, on: boolean): void {
        const split = this.splitOf(pane)
        if (!split) {
            return
        }
        on ? this.broadcast.add(split) : this.broadcast.delete(split)
        for (const p of split.getAllTabs()) {
            const session = this.sessions.get(p as DesktopPane)
            session?.overlay.classList.toggle('trd-broadcast-on', on)
            session?.log.push(`typing into all desktops: ${on ? 'on' : 'off'}`)
        }
        this.changed$.next()
    }

    /** A key event for the other desktops of a tab typing into all (see DesktopKeyboard). */
    broadcastKey (pane: DesktopPane, type: string, init: KeyboardEventInit): void {
        if (!this.isBroadcast(pane)) {
            return
        }
        for (const { session } of this.othersInTab(pane)) {
            try {
                session.ui.sendKeyboardEvent(new KeyboardEvent(type, { ...init, cancelable: true }))
            } catch (e: any) {
                session.log.push(`typing into all desktops: ${e?.message ?? e}`)
            }
        }
    }

    /**
     * Pastes on every connected desktop in the pane's tab: files copied here are offered to each first (see
     * FileTransfer.pasteClipboardFiles); text and pictures are sent to each, since only the desktop with the focus
     * follows this computer's clipboard on its own. Then Ctrl+V on each, in whatever window is active there.
     */
    pasteToAll (pane: DesktopPane): number {
        const targets = [...this.sessions.get(pane) ? [{ pane, session: this.sessions.get(pane)! }] : [], ...this.othersInTab(pane)]
            .filter(({ session }) => session.state === 'connected' && !session.viewOnly && session.ui)
        for (const { session } of targets) {
            // Each pastes once it has taken in the new clipboard, however long that takes it.
            const offered = session.files?.pasteClipboardFiles() ?? false
            ;(offered ? session.files!.offerAnswered() : this.sendClipboard(session)).then(ok => {
                if (!ok) {
                    session.log.push(`paste to all desktops: the remote refused the ${offered ? 'files' : 'clipboard'}`)
                    return
                }
                try {
                    session.ui.ctrlV()
                    session.log.push('keys: Ctrl+V (paste to all desktops)')
                } catch (e: any) {
                    session.log.push(`paste to all desktops: ${e?.message ?? e}`)
                }
            })
        }
        return targets.length
    }

    /**
     * Sends this computer's clipboard (text, a picture) to the session's desktop, whether it has the focus or not.
     * Resolves once the remote has taken it in (true) or refused it (false); true as well when there was nothing to
     * send, or no answer came: a paste then gets what that desktop has.
     */
    private async sendClipboard (session: DesktopSession): Promise<boolean> {
        const answered = session.files?.clipboardAnswered() ?? new Promise<boolean>(resolve => setTimeout(() => resolve(true), 300))
        try {
            await session.ui.sendClipboardData()
        } catch (e: any) {
            // Nothing it can send (an empty clipboard, a kind it doesn't carry).
            session.log.push(`paste to all desktops: clipboard not sent: ${e?.backtrace?.() ?? e?.message ?? e}`)
            return true
        }
        return answered
    }

    /** Resolves when the pane's desktop has taken in the files just offered to it, so a paste then gets them. */
    pasteReady (pane: DesktopPane): Promise<boolean> {
        return this.sessions.get(pane)?.files?.offerAnswered() ?? Promise.resolve(true)
    }

    /** ⌘V on the pane's desktop: offers files copied here for it (see FileTransfer.pasteClipboardFiles). */
    pasteClipboardFiles (pane: DesktopPane): boolean {
        const session = this.sessions.get(pane)
        return !!session?.files && this.isConnected(pane) && !session.viewOnly && session.files.pasteClipboardFiles()
    }

    /** Status log of the pane's desktop session (for tests and troubleshooting). */
    logOf (pane: DesktopPane): string[] {
        return this.sessions.get(pane)?.log ?? []
    }

    private loadIronRDP (): Promise<any> {
        this.ironrdp ??= (async () => {
            // The WebAssembly ships as its own file (not inlined in the bundle). It is read here and handed to init,
            // rather than fetched by the bundle from next to itself: fetch() of file:// URLs is up to the Electron
            // build (a fuse turns it off), and a plain file path needs no URL escaping for spaces or drive letters.
            const [rdp, wasm] = await Promise.all([
                importESM(vendor('iron-remote-desktop.js')).then(() => importESM(vendor('iron-remote-desktop-rdp.js'))),
                fs.promises.readFile(vendorFile('ironrdp_web_bg.wasm')),
            ])
            // Troubleshooting: localStorage.trdLogLevel = 'DEBUG' (or TRACE), then restart Tabby.
            let level = 'INFO'
            try { level = localStorage.getItem('trdLogLevel') || level } catch { }
            await rdp.init(level, wasm)
            return rdp
        })()
        this.ironrdp.catch(() => { this.ironrdp = null })
        return this.ironrdp
    }

    /**
     * Where to connect and as whom. The host's own desktop: the setup script (grd, generated credentials), or, where
     * it finds xrdp or Windows instead of GNOME, as below. Others: the saved account, or the sign-in form (retryError: after a
     * failed sign-in).
     */
    private async endpointFor (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, automatic: boolean, retryError?: string): Promise<Endpoint | null | 'stopped'> {
        // A Windows host is known from an earlier connect: no setup to run there (it would only fail again).
        if (spec.id === OWN_DESKTOP && !retryError && this.ownDesktops.get(target.key)?.kind !== 'windows') {
            session.status(`Preparing the remote desktop on ${target.label}…`)
            const endpoint = await prepareRemoteDesktop(target, this.settings().desk, this.config.store.remoteDesktop?.sessionBackend, this.clientOf(pane))
            this.ownDesktops.set(target.key, { kind: endpoint.kind, xrdpPort: endpoint.xrdpPort, xrdpUser: endpoint.xrdpUser })
            // Only the setup knows which desktop the host has; the session follows it (graphics, sign-in, resizing).
            spec.kind = endpoint.kind
            if (endpoint.kind === 'windows') {
                session.log.push('setup: the SSH host runs Windows; its own desktop is its RDP server')
            }
            if (endpoint.kind === 'gnome') {
                let gnome = endpoint
                const chosen = this.openChoices.get(pane)
                this.openChoices.delete(pane)
                // An automatic reconnect also gives way to a take-over whose connection isn't up yet: one that happened
                // when this desktop dropped (the host says how long ago, so the clocks needn't agree).
                const dropped = this.reconnects.get(pane)?.since
                const displaced = automatic && gnome.takenOver !== undefined && dropped !== undefined &&
                    Math.abs(gnome.takenOver - (Date.now() - dropped) / 1000) < 10
                if (gnome.clients || displaced) {
                    const choice = chosen ?? await this.openElsewhere(pane, target, spec, session, automatic)
                    if (!choice) {
                        return 'stopped'
                    }
                    if (choice === 'take') {
                        session.status(`Taking over the desktop on ${target.label}…`)
                        gnome = await prepareRemoteDesktop(target, this.settings().desk, this.config.store.remoteDesktop?.sessionBackend, this.clientOf(pane), true)
                        session.log.push(`setup: took the desktop over (${endpoint.clients} other connection(s))`)
                    } else {
                        session.log.push(`setup: a screen of its own, besides ${endpoint.clients} other connection(s)`)
                    }
                }
                return { host: '127.0.0.1', port: gnome.port, credentials: { username: gnome.username, password: gnome.password }, remember: false, certificate: gnome.certificate }
            }
            spec.host = '127.0.0.1'
            spec.port = endpoint.port
            spec.username ??= endpoint.username
        }
        // A saved account (Settings): its user name, and its password from the keychain. One that has none yet, or that
        // this desktop just refused, is asked for here and saved for every desktop that uses the account.
        const account = spec.account ? this.accounts().find(a => a.id === spec.account) : undefined
        if (spec.account && !account) {
            session.log.push('sign-in: its saved account no longer exists; asking')
        }
        const again = this.askAgain.delete(pane)
        // A desktop whose account is gone asks, rather than falling back to a login of its own saved earlier.
        let saved = retryError || again || spec.account && !account ? null : await loadCredentials(account ? accountKey(account.id) : session.key)
        if (saved && account && saved.username !== signInName(account)) {
            // Kept for an earlier user name of the account (its change didn't reach the store): not this one's.
            session.log.push(`sign-in: the account's saved password is for ${saved.username}, not ${signInName(account)}; asking`)
            saved = null
        }
        if (saved) {
            if (account) {
                session.log.push(`sign-in: the saved account "${account.name}"`)
            }
            return { host: spec.host, port: spec.port, credentials: account ? { username: signInName(account), password: saved.password } : saved, remember: false, domain: account ? account.domain ?? '' : undefined }
        }
        session.status('')
        const asked = askCredentials(session.overlay, {
            // The host's own desktops (its own, or its xrdp besides GNOME) and direct ones need no "via".
            title: spec.id === OWN_DESKTOP || target.direct || spec.kind === 'xrdp' && spec.host === '127.0.0.1' ? `Sign in to ${spec.name}` : `Sign in to ${spec.name} (via ${target.label})`,
            username: account ? signInName(account) : spec.username,
            error: retryError,
            canRemember: true,
            account: account?.name,
        }, session.disposed)
        if (session.visible) {
            setTimeout(() => session.visible && session.focusDesktop())
        }
        const entered = await asked
        return entered && {
            host: spec.host, port: spec.port, credentials: entered, remember: entered.remember, domain: account ? account.domain ?? '' : undefined,
            saveKey: account && accountKey(account.id), saveLabel: account && `saved account ${account.name}`, saveFor: account && signInName(account),
        }
    }

    private async connect (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession): Promise<void> {
        const alive = () => this.sessions.get(pane) === session
        let retryError: string | undefined
        // Automatic reconnects never start a desktop (`wake`): it may have been shut down on purpose.
        const automatic = this.reconnects.has(pane)
        // A desktop that was just started can answer before it takes connections: a few more tries, same account.
        let woken = false
        let startupRetries = 0
        let endpoint: Endpoint | null = null
        try {
            if (spec.wake) {
                const woke = await this.wakeIfDown(pane, target, spec, session, automatic)
                if (woke === null) {
                    return
                }
                woken = woke
            }
            // Signing in to a Windows account can take a few tries; a GNOME desktop the plugin set up can't fail that way.
            for (let attempt = 0; ; attempt++) {
                const [asked, rdp]: [Endpoint | null | 'stopped', any] = await Promise.all([endpoint ?? this.endpointFor(pane, target, spec, session, automatic, retryError), this.loadIronRDP()])
                if (!alive()) {
                    return
                }
                if (asked === 'stopped') {
                    // Not connecting: the reason and what to do instead are on the layer already.
                    session.state = 'ended'
                    this.changed$.next()
                    this.cancelReconnect(pane)
                    return
                }
                if (!asked) {
                    session.state = 'ended'
                    this.changed$.next()
                    this.cancelReconnect(pane)
                    session.status('Sign-in cancelled.', [{ label: 'Sign in', run: () => this.reopen(pane, spec) }])
                    return
                }
                endpoint = asked
                session.remote = target
                session.pinnedCertificate = asked.certificate ?? null
                session.proxy ??= await startRDCleanPathProxy(
                    () => target.openTcp(asked.host, asked.port),
                    fingerprint => this.checkCertificate(session, fingerprint),
                    m => session.log.push(m),
                    { autologon: spec.kind === 'xrdp' })
                const outcome = await this.run(pane, target, spec, session, rdp, asked)
                if (outcome.certificate && alive()) {
                    // A changed certificate, now trusted: the same account again, without asking for it again.
                    if (await this.refusedCertificate(pane, target, spec, session, asked, outcome.certificate)) {
                        continue
                    }
                    return
                }
                if (outcome.signInFailed && this.signsIn(spec) && attempt < 5 && alive()) {
                    // The desktop's own saved account goes. A shared one stays until a new password is entered: this
                    // desktop refusing it doesn't make it wrong for the others.
                    await forgetCredentials(session.key)
                    retryError = outcome.signInFailed
                    endpoint = null
                    continue
                }
                if (spec.wake && !outcome.connected && !outcome.signInFailed && alive()) {
                    if (woken && startupRetries < 3) {
                        startupRetries++
                        session.log.push(`wake: not taking connections yet: ${outcome.error ?? outcome.reason ?? 'unknown error'}`)
                        session.status(`${spec.name} is still starting…`)
                        await this.zone.runOutsideAngular(() => new Promise(resolve => setTimeout(resolve, 5000)))
                        continue
                    }
                    // It answered before, but not now: it may have been shut down since.
                    if (!woken && !automatic) {
                        const woke = await this.wakeIfDown(pane, target, spec, session, false)
                        if (woke === null) {
                            return
                        }
                        if (woke) {
                            woken = true
                            continue
                        }
                    }
                }
                if (alive()) {
                    this.afterEnd(pane, target, spec, session, outcome)
                }
                return
            }
        } catch (e: any) {
            if (alive()) {
                this.afterEnd(pane, target, spec, session, { connected: false, error: e?.message ?? String(e) })
            }
        }
    }

    /**
     * The proxy's check of the server's certificate, before any credentials go out. The host's own desktop must show
     * the certificate its setup reported. Others (behind a host, a Windows host's own, a remote desktop tab's) are
     * trusted on first use: remembered silently the first time (most connections already run inside SSH, and a prompt
     * on every new desktop would only teach clicking it away), and refused when it changes, until the new one is
     * trusted (see refusedCertificate). Remembered by session key, like saved accounts.
     */
    private checkCertificate (session: DesktopSession, fingerprint: string): void {
        session.certificateProblem = null
        // The host's own GNOME desktop; its own xrdp makes its certificate itself, so that one is trusted on first use.
        if (session.spec.id === OWN_DESKTOP && session.spec.kind === 'gnome') {
            const expected = session.pinnedCertificate ?? ''
            if (fingerprint !== expected) {
                session.certificateProblem = { expected, actual: fingerprint, pinned: true }
                throw new Error(`certificate SHA-256 ${fingerprint} is not the one set up (${expected || 'none'})`)
            }
            session.log.push(`certificate: SHA-256 ${fingerprint}, as set up`)
            return
        }
        const known = this.trustedCertificate(session.key)
        if (!known) {
            this.trustCertificate(session.key, fingerprint)
            session.log.push(`certificate: SHA-256 ${fingerprint}, remembered (first connection)`)
            return
        }
        if (fingerprint !== known) {
            session.certificateProblem = { expected: known, actual: fingerprint, pinned: false }
            throw new Error(`certificate SHA-256 ${fingerprint} is not the one remembered (${known})`)
        }
        session.log.push(`certificate: SHA-256 ${fingerprint}, as remembered`)
    }

    /** How the pane's next connection to a GNOME desktop that's open elsewhere goes, when that was chosen already. */
    private openChoices = new Map<DesktopPane, 'take' | 'second'>()

    /** Each pane's name for itself on hosts, for the note a take-over leaves there (see prepareRemoteDesktop). */
    private clients = new WeakMap<DesktopPane, string>()
    private clientOf (pane: DesktopPane): string {
        let id = this.clients.get(pane)
        if (!id) {
            id = Math.random().toString(36).slice(2, 12)
            this.clients.set(pane, id)
        }
        return id
    }

    /**
     * The host's GNOME desktop has RDP clients already (another Tabby window or computer), and GNOME gives each its own
     * screen. Opened by hand: asks whether to take it over (disconnecting them, as Windows does), or to add a screen.
     * An automatic reconnect doesn't ask, nor take it back: this connection gave way to the other, most likely by being
     * taken over from there, and taking it back by itself would have the two take turns. Resolves with the choice, or
     * null when not connecting (the layer then says so and offers the choices again).
     */
    private async openElsewhere (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, automatic: boolean): Promise<'take' | 'second' | null> {
        const again = (choice: 'take' | 'second') => () => {
            this.openChoices.set(pane, choice)
            this.reopen(pane, spec)
        }
        const stopped = (message: string) => {
            session.status(message, [
                { label: automatic ? 'Take it back' : 'Take it over', run: again('take') },
                { label: 'Open a second screen', run: again('second') },
            ], true)
            return null
        }
        if (automatic) {
            if (!session.visible) {
                this.notifications.notice(`The desktop on ${target.label} was opened somewhere else`)
            }
            return stopped(`The desktop on ${target.label} was opened somewhere else (another Tabby window or computer), and this connection gave way to it.`)
        }
        const choice = await new Promise<'take' | 'second' | null>(resolve => {
            session.status(`The desktop on ${target.label} is open somewhere else too (another Tabby window or computer). GNOME gives each connection a screen of its own, so this one would get a second, empty screen.`, [
                { label: 'Take it over', run: () => resolve('take') },
                { label: 'Open a second screen', run: () => resolve('second') },
                { label: 'Cancel', run: () => resolve(null) },
            ], true)
            session.disposed.then(() => resolve(null))
        })
        return choice ?? stopped(`Not opened: the desktop on ${target.label} is open somewhere else (another Tabby window or computer).`)
    }

    /**
     * After the proxy refused a certificate; nothing was sent to that server. The host's own desktop: an error, since
     * the plugin made that certificate itself. Others: both fingerprints, to trust the new certificate or not. Either
     * way, automatic reconnecting stops here. Resolves true to connect again (the new certificate is then trusted).
     */
    private async refusedCertificate (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, endpoint: Endpoint, problem: CertificateProblem): Promise<boolean> {
        this.cancelReconnect(pane)
        const alive = () => this.sessions.get(pane) === session
        const stop = (message: string) => {
            session.state = 'ended'
            this.changed$.next()
            session.status(message, [{ label: 'Try again', run: () => this.reopen(pane, spec) }], true)
        }
        const fingerprints = `${problem.pinned ? 'Expected' : 'Remembered'} (SHA-256):\n${showFingerprint(problem.expected)}\n\nNow:\n${showFingerprint(problem.actual)}`
        if (problem.pinned) {
            stop(`The remote desktop on ${target.label} answered with a certificate other than the one set up for it. ` +
                `The connection was stopped before signing in.\n\n${fingerprints}\n\n` +
                `Something other than GNOME Remote Desktop may be listening on port ${endpoint.port}.`)
            return false
        }
        if (!session.visible) {
            this.notifications.notice(`The certificate of ${spec.name}${target.direct ? '' : ` (via ${target.label})`} has changed. Open that desktop to decide.`)
        }
        const trusted = await new Promise<boolean>(resolve => {
            session.status(`The certificate of ${spec.name} has changed since it was last used. Nothing has been sent to it.\n\n` +
                `${fingerprints}\n\nReinstalling the machine or renewing its certificate changes it. If neither happened, ` +
                `something else may be answering at ${spec.host}:${spec.port}.`, [
                { label: 'Trust the new certificate', run: () => resolve(true) },
                { label: 'Cancel', run: () => resolve(false) },
            ], true)
            session.disposed.then(() => resolve(false))
        })
        if (!alive()) {
            return false
        }
        if (!trusted) {
            stop('Not connected: the new certificate was not trusted.')
            return false
        }
        this.trustCertificate(session.key, problem.actual)
        session.log.push(`certificate: SHA-256 ${problem.actual}, trusted instead of ${problem.expected}`)
        return true
    }

    /** The certificate remembered for a desktop behind a host (`remoteDesktop.trustedCertificates`), if any. */
    private trustedCertificate (key: string): string | null {
        const list = this.config.store.remoteDesktop?.trustedCertificates
        const value = (Array.isArray(list) ? list : []).find((e: any) => e?.desktop === key)?.sha256
        return typeof value === 'string' ? normalizeFingerprint(value) || null : null
    }

    private trustCertificate (key: string, fingerprint: string): void {
        const store = this.config.store.remoteDesktop
        const others = (Array.isArray(store.trustedCertificates) ? store.trustedCertificates : []).filter((e: any) => e?.desktop !== key)
        store.trustedCertificates = [...others, { desktop: key, sha256: fingerprint }]
        this.config.save()
    }

    /**
     * Forgets the certificates remembered for a desktop behind any SSH host (keys ending in `#<id>`, not a direct
     * one's `rdp#<id>`), or with `direct`, for that direct desktop; doesn't save.
     */
    forgetCertificatesFor (desktopId: string, direct = false): void {
        const store = this.config.store.remoteDesktop
        const list = Array.isArray(store.trustedCertificates) ? store.trustedCertificates : []
        const forget = (key: string) => direct ? key === `${DIRECT_KEY}#${desktopId}` : key.endsWith(`#${desktopId}`) && !key.startsWith(`${DIRECT_KEY}#`)
        store.trustedCertificates = list.filter((e: any) => !forget(String(e?.desktop ?? '')))
    }

    /**
     * For a desktop with `wake`: when its RDP server doesn't answer (probed from the SSH host), starts it and waits
     * until it does. True when it had to be started, false when it was up, null when the wait was cancelled (the layer
     * says so). Throws when it couldn't be started, didn't come up in time, or is down during an automatic reconnect.
     */
    private async wakeIfDown (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, automatic: boolean): Promise<boolean | null> {
        const alive = () => this.sessions.get(pane) === session
        session.status(`Connecting to ${spec.name} via ${target.label}…`)
        if (await rdpAnswers(target, spec.host, spec.port)) {
            return false
        }
        if (!alive()) {
            return null
        }
        if (automatic) {
            throw new Error(`${spec.name} doesn't answer; it may have been shut down`)
        }
        session.status(`Starting ${spec.name}…`)
        session.log.push(`wake: ${await wakeDesktop(target, spec.wake!)}`)
        let cancelled = false
        const cancel: StatusAction = {
            label: 'Cancel',
            run: () => {
                cancelled = true
                session.state = 'ended'
                this.changed$.next()
                this.cancelReconnect(pane)
                session.status(`Stopped waiting for ${spec.name}.`, [{ label: 'Try again', run: () => this.reopen(pane, spec) }])
            },
        }
        const started = Date.now()
        const progress = () => session.status(`Starting ${spec.name}…\nWaiting for it to answer: ${Math.round((Date.now() - started) / 1000)} s`, [cancel])
        progress()
        const up = await this.zone.runOutsideAngular(() => waitForRdp(target, spec.host, spec.port, WAKE_TIMEOUT_MS, () => cancelled || !alive(), progress))
        if (up) {
            session.log.push(`wake: answered after ${Math.round((Date.now() - started) / 1000)} s`)
            // Started here, so it can go back off when it's no longer used, if the settings say so (a VM only: a machine
            // woken over the network would need rights on it).
            const idle = this.settings().shutDownIdle
            if (idle > 0 && 'vm' in spec.wake!) {
                shutDownWhenIdle(target, spec.wake.vm, spec.host, spec.port, idle * 60)
                    .then(done => session.log.push(`wake: ${done}`), e => session.log.push(`wake: no automatic shutdown: ${e?.message ?? e}`))
            }
            return true
        }
        if (cancelled || !alive()) {
            return null
        }
        throw new Error(`${spec.name} didn't answer within ${WAKE_TIMEOUT_MS / 60000} minutes of starting it`)
    }

    /** One RDP connection attempt, until it ends. */
    private async run (
        pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, rdp: any, endpoint: Endpoint,
    ): Promise<{ connected: boolean, signInFailed?: string, error?: string, reason?: string, certificate?: CertificateProblem }> {
        const credentials = endpoint.credentials
        const alive = () => this.sessions.get(pane) === session
        session.certificateProblem = null
        const el = document.createElement('iron-remote-desktop') as any
        try {
            el.setAttribute('scale', this.screenScale() === 3 ? 'real' : 'fit')
            el.setAttribute('flexcenter', 'true')
            el.module = rdp.Backend
            const ready = new Promise<any>(resolve => el.addEventListener('ready', (e: CustomEvent) => resolve(e.detail.irgUserInteraction), { once: true }))
            session.host.replaceChildren(el)
            session.ui = await ready
            // Files through the clipboard: registered before connecting, which sets up its channel messages.
            session.files?.dispose()
            session.files = new FileTransfer(rdp, session.overlay, m => session.log.push(m))
            session.ui.enableFileTransfer(session.files.provider)
            // The component outlines itself while it has the keyboard; the desktop should look like the
            // terminal it replaces, edge to edge. Its styles live in a shadow root, so adopt a sheet there.
            // Not a <style> element: the component only forwards keys while its own container is the shadow
            // root's first child, and an element added before it renders would take that place.
            if (el.shadowRoot) {
                const sheet = new CSSStyleSheet()
                sheet.replaceSync('.capturing-inputs, canvas:focus, canvas:focus-visible { outline: none !important; }')
                el.shadowRoot.adoptedStyleSheets = [...el.shadowRoot.adoptedStyleSheets, sheet]
            }

            // Size the remote display to the pane (see the sharpness setting).
            const settings = this.settingsFor(session)
            const size = remoteSizeFor(session.overlay.getBoundingClientRect(), settings)
            const { width, height } = size

            // DOMAIN\user or user@domain go to the server as typed; only the former needs splitting.
            const [domain, username] = /^([^\\]+)\\(.+)$/.exec(credentials.username)?.slice(1) ?? [endpoint.domain ?? spec.domain ?? '', credentials.username]
            session.status(spec.id === OWN_DESKTOP ? `Connecting to ${target.label}…`
                : target.direct ? `Connecting to ${spec.name}…` : `Connecting to ${spec.name} via ${target.label}…`)
            const config = session.ui.configBuilder()
                .withUsername(username)
                .withPassword(credentials.password)
                .withDestination(`${spec.id === OWN_DESKTOP ? target.hostname ?? target.label : endpoint.host}:${endpoint.port}`)
                .withProxyAddress(session.proxy!.url)
                .withServerDomain(domain)
                .withAuthToken(session.proxy!.token)
                .withDesktopSize({ width, height })
                // Display control lets the remote monitor follow the pane (live resize, remote scaling).
                .withExtension(rdp.displayControl(true))
            // H.264 in the graphics pipeline, decoded by the browser (hardware-accelerated where it can be). A decoder
            // failure ends the connection, which then reconnects without H.264 (see below). Not for xrdp: it encodes
            // H.264 only in some builds, and without it bitmaps do better there than the pipeline.
            session.h264?.close()
            session.h264 = null
            if (spec.kind !== 'xrdp' && typeof rdp.graphicsPipeline === 'function' && await this.useH264(rdp, session, settings)) {
                session.h264 = new rdp.WebCodecsH264Decoder({ onFailure: (reason: string) => session.log.push(`h264: failed: ${reason}`) })
                config.withExtension(rdp.h264Decoder(session.h264))
            }
            // GNOME Remote Desktop requires the graphics pipeline. Windows (and xrdp) do better with bitmaps than with
            // the pipeline without H.264; with H.264, Windows streams what changes a lot (video) as video. A build
            // without the switch decides by itself.
            if (typeof rdp.graphicsPipeline === 'function') {
                const pipeline = spec.kind === 'gnome' || !!session.h264
                config.withExtension(rdp.graphicsPipeline(pipeline))
                session.graphics = pipeline ? `graphics pipeline${session.h264 ? ' with H.264' : ''}` : 'bitmaps'
            } else {
                session.graphics = 'automatic graphics'
            }
            session.log.push(`graphics: ${session.graphics}`)
            if (settings.sound) {
                session.audio?.close()
                session.audio = new AudioPlayer()
                config.withExtension(rdp.audioPlayback(session.audio.callback))
            }
            session.mic?.close()
            session.mic = null
            if (settings.microphone && typeof rdp.audioInput === 'function') {
                const ui = session.ui
                const mic: Microphone = new Microphone(
                    pcm => ui.invokeExtension(rdp.audioInputData(pcm)),
                    () => session.overlay.classList.toggle('trd-mic-on', mic.capturing),
                    m => session.log.push(m),
                    m => this.zone.run(() => this.notifications.error(m)),
                )
                session.mic = mic
                config.withExtension(rdp.audioInput(mic.callback))
            }
            // Shared folders as drives (\\tsclient\<name>). GNOME Remote Desktop doesn't serve drives; Windows and xrdp
            // do. Also skipped with no folder shared: the server then sees no drive device at all.
            session.drives?.dispose()
            session.drives = null
            const folders = this.sharedFolders()
            if (folders.length && spec.kind !== 'gnome' && typeof rdp.driveRedirection === 'function') {
                session.drives = new SharedDrives(folders, m => session.log.push(m))
                config.withExtension(rdp.driveRedirection(session.drives))
                session.log.push(`drives: ${folders.map(f => `${f.name}${f.readOnly ? ' (read-only)' : ''}`).join(', ')}`)
            }
            const built = config.build()
            let info: any
            try {
                info = await session.ui.connect(built)
            } catch (e: any) {
                // The proxy refused the server's certificate, before CredSSP (see checkCertificate).
                if (session.certificateProblem) {
                    return { connected: false, certificate: session.certificateProblem }
                }
                // IronErrorKind: 1 WrongPassword, 2 LogonFailure.
                const kind = typeof e?.kind === 'function' ? e.kind() : undefined
                const detail = typeof e?.backtrace === 'function' ? e.backtrace() : (e?.message ?? String(e))
                if (kind === 1 || kind === 2) {
                    session.log.push(`sign-in failed: ${detail.split('\n')[0]}`)
                    return { connected: false, signInFailed: kind === 1 ? 'Wrong user name or password.' : 'The sign-in was refused.' }
                }
                throw new Error(session.proxy?.failure ?? detail)
            }
            if (!alive()) {
                return { connected: false }
            }
            session.ui.setVisibility(true)
            session.remoteSize = { width, height, scale: 100 }
            if (size.scale !== 100 || spec.kind === 'windows') {
                // Retina: the connection starts unscaled; ask for the matching remote scale right away. Windows also
                // keeps a signed-in session's scale from the last connection: set it either way.
                this.applySize(session, size)
            }
            this.watchSize(pane, session)
            session.state = 'connected'
            session.log.push(`connected: ${width}x${height}`)
            session.status('')
            this.tip(pane, session)
            this.label(pane, session)
            this.syncIndicator(session)
            this.changed$.next()
            this.reconnects.delete(pane)  // connected again: a later drop starts over
            // Under a saved account only while that account is still there with the same sign-in name: the prompt may
            // have been open while it was removed or changed in Settings.
            const accountNow = endpoint.saveKey ? this.accounts().find(a => accountKey(a.id) === endpoint.saveKey) : undefined
            if (endpoint.remember && endpoint.saveKey && (!accountNow || signInName(accountNow) !== endpoint.saveFor)) {
                session.log.push(`sign-in: not saved: the account ${accountNow ? 'changed' : 'was removed'} meanwhile`)
            } else if (endpoint.remember) {
                saveCredentials(endpoint.saveKey ?? session.key, credentials, endpoint.saveLabel).then(
                    () => session.log.push(`sign-in: saved ${endpoint.saveKey ? 'as the account\'s password ' : ''}in ${storeName()}`),
                    e => session.log.push(`sign-in: ${storeName()}: ${e?.message ?? e}`))
            }
            if (session.visible) {
                session.focusDesktop()
            }
            let end: any
            try {
                end = await info.run()
            } catch (e: any) {
                if (session.h264?.failed) {
                    // Reconnects (automatically, like any dropped connection) without H.264, unless the browser only
                    // took an idle decoder back (a hidden window): then with it, as a new stream starts with a key frame.
                    if (session.h264.reclaimed) {
                        return { connected: true, error: 'the video decoder was reclaimed' }
                    }
                    this.h264Failed.add(session.key)
                    return { connected: true, error: `H.264 decoding failed (${session.h264.failed}); continuing without it` }
                }
                return { connected: true, error: typeof e?.backtrace === 'function' ? e.backtrace().split('\n')[0] : (e?.message ?? String(e)) }
            } finally {
                // The server can't close the microphone, or its files, once the connection is gone.
                session.mic?.close()
                session.drives?.dispose()
            }
            return { connected: true, reason: end?.reason?.() }
        } catch (e: any) {
            return { connected: false, error: e?.message ?? String(e) }
        }
    }
}

let styleInstalled = false
export function installStyle (): void {
    if (styleInstalled) {
        return
    }
    styleInstalled = true
    const style = document.createElement('style')
    style.textContent = STYLE + SIGNIN_STYLE + FILES_STYLE + STATS_STYLE + OSD_STYLE + DRAGBAR_STYLE + ACCOUNT_FORM_STYLE
    document.head.appendChild(style)
    keepWindowDraggable()
}

/** A strip the height of the tab bar that stays a window drag region over a dialog (the plugin's, and Tabby's). */
const DRAGBAR_STYLE = `
.trd-form-dragbar { display: none; }
.modal > .trd-form-dragbar { display: block; position: fixed; left: 0; right: 0; top: 0; height: var(--tabs-height, 38px); -webkit-app-region: drag; }
`

/**
 * Tabby's dialogs (ng-bootstrap modals) cover the whole window, tab bar included, with nothing marked as a drag
 * region, so the window can't be moved while one shows. Each gets a strip where the tab bar is; the dialog box itself
 * is below it. The plugin's own dialogs do the same (see settingsPage.ts).
 */
function keepWindowDraggable (): void {
    const strip = (modal: Element) => {
        if (!modal.querySelector(':scope > .trd-form-dragbar')) {
            const bar = document.createElement('div')
            bar.className = 'trd-form-dragbar'
            modal.prepend(bar)
        }
    }
    // ng-bootstrap appends each dialog (ngb-modal-window.modal) to the body itself: only the body's children are watched.
    document.querySelectorAll('body > .modal').forEach(strip)
    new MutationObserver(records => {
        for (const record of records) {
            record.addedNodes.forEach(node => {
                if (node instanceof Element && node.classList.contains('modal')) {
                    strip(node)
                }
            })
        }
    }).observe(document.body, { childList: true })
}
