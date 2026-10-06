import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { AppService, ConfigService, NotificationsService, PlatformService, ProfilesService, SelectorService, SplitTabComponent } from 'tabby-core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isIP } from 'net'
import { Duplex } from 'stream'
import { domainToASCII, pathToFileURL } from 'url'
import { DesktopPane, desktopPaneOf, isRDPTab, NestedSSH, RDP_PROFILE_TYPE, RemoteTarget, RemoteTargets } from './targets'
import { consoleScript, DeskGate, deskKeyDigest, DeskRequest, MACHINE_ID_COMMAND } from './deskScript'
import { AudioPlayer } from './audio'
import { IronRDPLoader } from './ironrdp'
import { CLIPBOARD_LABELS, ClipboardMode, clipboardSetting, ClipboardWays, clipboardWays, narrowest, ownClipboard, setUpClipboard, splitPaste } from './clipboard'
import { ConnectionStatus, STYLE as STATS_STYLE } from './connectionStatus'
import { Microphone } from './microphone'
import { SharedDrives, SharedFolder, sharedFolders } from './drives'
import { askDesktop, formatAddress } from './desktopForm'
import { accountKey, accountsOf, newAccountId, SavedAccount, signInName } from './accounts'
import { ACCOUNT_REMEMBER_UNAVAILABLE, AccountRevisions } from './accountRevisions'
import { NewAccountInput, STYLE as ACCOUNT_FORM_STYLE } from './accountForm'
import { FileTransfer, STYLE as FILES_STYLE, uniquePath } from './fileTransfer'
import { configText, desktopIdOf, DesktopSpec, desktopsFor, DIRECT_KEY, entryText, ExtraDesktopConfig, isDesktopEntry, keyFields, keyParts, keyUser, OWN_DESKTOP, OwnDesktopFound, sessionKey, specOf, xrdpUnasked } from './desktops'
import { RemoteDesktopHelp } from './help'
import { configNumber, OSD_STYLE, OsdSettings, osdSettings, renderOsd } from './osd'
import { MICROPHONE_NOTE, parseRdpFile } from './rdpFile'
import { prepareRemoteDesktop, RemoteDesktopEndpoint } from './remoteSetup'
import { normalizeFingerprint, RDCleanPathProxy, startRDCleanPathProxy, withoutToken } from './rdcleanpath'
import {
    askCredentials, Credentials, forgetCredentials, forgetCredentialsFor, forgetCredentialsIf, forgetCredentialsOrFail, forgetMark, forgetOnce, forgottenSince, gatewayScope, hasCredentials,
    isFor, loadCredentials, moveCredentialsFor, saveCredentials, saveCredentialsIf, Store, storeName, STYLE as SIGNIN_STYLE,
} from './signin'
import { isSSHTab } from './ssh'
import { desktopUp, shutDownWhenIdle, waitForRdp, wakeDesktop } from './wake'
import { hyperVState } from './hyperv'
import { formatGateway, Gateway, GatewaySignInError, openThroughGateway, parseGateway } from './gateway'
import { CertificateDetails, describeCertificate, vouched, whyNotValid } from './authorities'
import { scanVMs, vmSpec } from './vms'
import { SessionLog } from './sessionLog'
import { HostCompatibility, terminalInputs } from './hostCompat'
import { UNSHOWABLE, withoutWordJoiners } from './unshowable'

/**
 * The keychain entry that marks the passwords 0.5.0 saved for desktops reached through a gateway forgotten from this
 * computer's keychain (see RemoteDesktopService.gatewayPasswords): under the plugin's service, a name no saved
 * password's key takes (no target's key is `migration`, see keyParts).
 */
export const GATEWAY_PASSWORDS_MARK = 'migration#gateway-passwords'

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
.trd-overlay.trd-dim .trd-status-text { pointer-events: auto; user-select: text; cursor: text; }
.trd-view-only { display: none; position: absolute; inset: 0; }
.trd-overlay.trd-view-only-on .trd-view-only { display: block; }
.trd-overlay.trd-broadcast-on::before { content: 'Typing into all desktops in this tab'; position: absolute; top: 8px; left: 50%;
    transform: translateX(-50%); z-index: 4; padding: 2px 10px; border-radius: 4px; background: rgba(214, 120, 0, 0.92); color: #fff;
    font-size: 11px; pointer-events: none; white-space: nowrap; }
.trd-view-only::after { content: 'View only'; position: absolute; top: 8px; left: 8px; padding: 2px 8px; border-radius: 4px;
    background: rgba(30, 30, 30, 0.85); color: #ddd; font-size: 11px; pointer-events: none; }
.trd-mic { position: absolute; top: 8px; right: 8px; z-index: 5; width: 22px; height: 22px; border-radius: 50%; display: none;
    align-items: center; justify-content: center; background: rgba(220, 38, 38, 0.85); color: #fff; font-size: 11px;
    pointer-events: none; }
.trd-overlay.trd-mic-on .trd-mic { display: flex; }
.trd-overlay.trd-mic-on > .trd-toast { right: 40px; max-width: min(420px, calc(100% - 52px)); }
.trd-floating-mic-on .trd-overlay.trd-broadcast-on::before { top: 40px; }
`

/** A button in the desktop layer's status (Reconnect, Stop, …). */
interface StatusAction {
    label: string
    run: () => void
    /** What Enter picks: the button with the focus while the question shows (Cancel, where saying yes has a risk). */
    default?: boolean
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
    accountRevision?: string
    /**
     * Where the forgets stood when the prompt was made (see forgetMark): a desktop's own sign-in is saved only if
     * nothing was forgotten for it since, so that an edit or a removal made while the server delayed it isn't undone.
     */
    mark?: number
    /** A saved account's domain (empty: none), in place of the desktop's own `domain`. */
    domain?: string
    /** The host's own desktop: the fingerprint of the certificate its setup made, the only one to accept. */
    certificate?: string
    /** A Hyper-V VM's console: the kind of session the guest takes right now (see hyperv.ts). */
    hyperv?: 'enhanced' | 'basic'
    /** The desktop's RD Gateway takes a saved account of its own: that sign-in (see gatewayAccountFor). */
    gatewayAccount?: GatewaySignIn
}

/** A saved account's sign-in to an RD Gateway, where that isn't the desktop's own. */
interface GatewaySignIn {
    credentials: Credentials
    domain?: string
    /** Entered just now, to be kept as the account's password once the gateway takes it. */
    remember: boolean
    saveKey: string
    saveLabel: string
    saveFor: string
    accountRevision?: string
}

/** A server certificate the proxy refused (see checkCertificate). */
interface CertificateProblem {
    /** The certificate the setup made (the host's own desktop), or the one remembered (others; '' for none: a first use). */
    expected: string
    actual: string
    /** The host's own desktop: its certificate is the plugin's, so a different one is never to be accepted. */
    pinned: boolean
    /**
     * Where an authority's word counts (a direct desktop, a gateway; see checkTrusted): whether the new certificate is
     * valid for the server's name by this computer's certificate authorities, that name, and why it isn't (Node's code).
     * Undefined for a desktop behind an SSH host, trusted on first use.
     */
    valid?: boolean
    name?: string
    reason?: string
    /**
     * Where an authority's word counts, how the certificate it replaces came to be remembered (see
     * RememberedCertificate): by the user's word, or on first use, before the two were told apart.
     */
    replaces?: 'yours' | 'first use'
    /** The desktop's RD Gateway's certificate rather than the desktop's: the gateway's address, and what it is remembered under. */
    gateway?: { address: string, key: string }
    /** What the new certificate says of itself (whom it was issued to and by, its dates), for the question. */
    details?: CertificateDetails
}

/**
 * A certificate remembered for a server (`remoteDesktop.trustedCertificates`, by session key or `gateway#host:port`).
 * `authority`: remembered because it was valid for the server's name by this computer's certificate authorities (true),
 * or because the user trusted it (false). Without it, from before that was told apart, or of a desktop behind an SSH
 * host: trusted on first use.
 */
interface RememberedCertificate {
    sha256: string
    authority?: boolean
}

/**
 * The name a desktop connected to directly goes by, as its certificate is checked against it (see
 * RDCleanPathOptions.serverName): an address as it is, a host name as it resolves (lower case, punycode, without a
 * trailing dot, which SNI doesn't take). A host with a character no host name has stays as it is: the URL parser behind
 * domainToASCII would read part of it as something else (`a?b` as `a`), and the certificate would be checked against
 * another name than the one connected to.
 */
function serverNameOf (host: string): string {
    if (isIP(host) || /[^A-Za-z0-9._-]/.test(host.replace(/[^\x00-\x7f]/g, ''))) {
        return host
    }
    return domainToASCII(host.replace(/\.$/, '')) || host
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
    /**
     * Send the characters the keyboard produces (Unicode) rather than key positions: dead keys and a layout the remote
     * doesn't have come out right. Keys with Ctrl, Alt or ⌘, and non-character keys, still go by position.
     */
    unicodeKeys: boolean
    /** Play the remote desktop's sound here (applies on the next connect). */
    sound: boolean
    /** H.264 in the graphics pipeline, decoded by the browser (WebCodecs), where it can (applies on the next connect). */
    h264: boolean
    /** With resize 'off': 'fit' scales the picture to the pane, 'actual' shows it 1:1, scrolling when it's larger. */
    zoom: 'fit' | 'actual'
    /** A small indicator on the desktop: throughput, frames per second, SSH round trip, connection path. */
    connectionStatus: boolean
    /**
     * Send the microphone to a remote desktop that asks for it, as one does while an app there records (applies on the
     * next connect).
     */
    microphone: boolean
    /**
     * The ways the clipboard (text, pictures, files) goes between this computer and remote desktops, unless a desktop
     * has its own (applies on the next connect; see clipboard.ts).
     */
    clipboard: ClipboardMode
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

/** Exported for the unit tests, which use its keys (credentialKey) without a page to put a layer in. */
export class DesktopSession {
    state: SessionState = 'connecting'
    visible = false
    readonly overlay: HTMLElement
    readonly host: HTMLElement
    readonly statusEl: HTMLElement
    proxy: RDCleanPathProxy | null = null
    ui: any = null
    /** The connection's log (Copy log): its first lines and its latest, however many the remote brings about. */
    readonly log = new SessionLog()
    /** What the remote display was last set to. */
    remoteSize: RemoteSize | null = null
    remote: RemoteTarget | null = null
    /** Plays the remote's sound, when the sound setting was on at connect. */
    audio: AudioPlayer | null = null
    /** Captures the microphone for the remote, when the microphone setting was on at connect. */
    mic: Microphone | null = null
    /** Files through the clipboard (drop on the desktop, or copy on the remote). */
    files: FileTransfer | null = null
    /**
     * The ways the clipboard goes with this connection: as it was set up (see clipboard.ts), narrowed when the settings
     * narrow while it's connected; never widened again before it reconnects.
     */
    clipboard: ClipboardMode = 'off'
    /**
     * The narrowest clipboard asked for this desktop by another way of opening it while it was open here (another
     * profile for the same desktop, say, which brings this one forward instead): this desktop's connections in this
     * pane go no further until it is closed. Its reconnects carry it over to the session made in its place (see
     * reopen), since the server can bring one about whenever it likes by dropping the connection.
     */
    clipboardCap: ClipboardMode = 'both'
    /** Stops the sending of this computer's clipboard on this connection. */
    stopSending: (() => void) | null = null
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
    /** Set when the desktop's RD Gateway refused the sign-in on the current connection attempt: what it said. */
    gatewayRefused: string | null = null
    /** Set when the proxy stopped at a server without Network Level Authentication on the current connection attempt. */
    withoutNla = false
    /**
     * Set when the proxy let the current attempt's server on without Network Level Authentication (see
     * checkWithoutNla): signing in there sends it the password itself, not a proof of it.
     */
    plainSignIn = false
    /**
     * "Send the password anyway" was answered just now (see refusedWithoutNla): the server that answers the next
     * attempt may have the password, and the permission is remembered with its certificate (see holdWithoutNla).
     */
    sendAnyway = false
    /** The connection-status indicator, made the first time it shows. */
    indicator: ConnectionStatus | null = null
    /** How the pictures come (for the indicator): the graphics pipeline, bitmaps, or IronRDP's choice. */
    graphics = ''
    /** "What does this mean?" under a message (see status()): opens help about it. */
    onHelp: ((message: string) => void) | null = null
    /**
     * Whether the desktop's pane is the one the user is in (see RemoteDesktopService.showsInFront): only then does a
     * question take the keyboard as it shows (see status()), and only then does a focus that was waiting for a moment
     * (see focusSoon) go ahead. Its pane's focus hands it over later.
     */
    inFront: () => boolean = () => true
    /** Resolves when the session is disposed (ends a pending sign-in). */
    readonly disposed: Promise<void>
    private markDisposed!: () => void

    /**
     * What a sign-in and a certificate are remembered under: the desktop; for a Hyper-V VM, its host, whose account
     * and certificate they are, the same for all of its VMs.
     */
    get authKey (): string {
        return this.spec.hyperv ? this.key.replace(/#hyperv:[^#]*$/, '#hyperv') : this.key
    }

    /**
     * Where a saved password is kept: under authKey, and whenever the desktop is reached through an RD Gateway, that
     * gateway too (see gatewayScope), whether the gateway takes the desktop's sign-in or an account of its own: a
     * password saved for one gateway (or for a connection without one) is never sent through a different gateway named
     * for the same address without asking. The certificate and the "without NLA" decision stay keyed by authKey: those
     * are the desktop's, not the gateway's.
     */
    get credentialKey (): string {
        return this.authKey + gatewayScope(this.spec.gateway)
    }

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

    /** Keys this desktop was sent and not yet let go of (by `code`): see RemoteDesktopService.broadcastKey. */
    readonly keysDown = new Map<string, KeyboardEventInit>()

    /** Notes a key sent to this desktop as held, or let go. */
    noteKey (type: string, init: KeyboardEventInit): void {
        if (type === 'keydown' && init.code) {
            this.keysDown.set(init.code, init)
        } else if (type === 'keyup' && init.code) {
            this.keysDown.delete(init.code)
        }
    }

    /**
     * Lets go of every key still held on this desktop. For when their keyups won't reach it: view only coming on, or
     * typing into all going off, by a shortcut whose modifiers are down at that moment. They would stay down there.
     */
    releaseKeys (): void {
        for (const [code, init] of [...this.keysDown]) {
            this.keysDown.delete(code)
            try {
                this.ui?.sendKeyboardEvent(new KeyboardEvent('keyup', { key: init.key, code, location: init.location, cancelable: true }))
            } catch (e: any) {
                this.log.push(`keys: ${code} not released: ${e?.message ?? e}`)
            }
        }
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
            this.focusSoon()
        }
    }

    /**
     * Focuses the remote desktop in a moment, if it is still in the pane the user is in then (see inFront). `visible`
     * stays true in a tab in the background, and a focus that was waiting (a retry, or Tabby's re-focus of the terminal
     * taken back) mustn't pull the keyboard, and this computer's clipboard with it, away from where the user went.
     */
    private focusSoon (attempts?: number, delay = 0): void {
        setTimeout(() => this.visible && this.inFront() && this.focusDesktop(attempts), delay)
    }

    /**
     * Shows or hides the desktop layer. While it shows, the terminal's input textarea is disabled so
     * nothing can focus it: keystrokes can't leak into the shell underneath, and Tabby's re-focus of
     * the terminal becomes a no-op.
     */
    setVisible (visible: boolean): void {
        this.visible = visible
        this.overlay.style.display = visible ? '' : 'none'
        terminalInputs(this.container).forEach(input => {
            input.disabled = visible
        })
        if (visible) {
            this.focusSoon()
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
            button.className = action.default ? 'btn btn-primary trd-status-default' : 'btn btn-secondary'
            button.textContent = action.label
            button.addEventListener('click', () => action.run())
            return button
        }))
        this.statusEl.style.display = msg || actions.length ? '' : 'none'
        this.overlay.classList.toggle('trd-dim', actions.length > 0)
        // Not where another pane is in front: the remote decides when a question comes, and the keyboard stays where the
        // user went (a background tab's buttons can take it: Tabby keeps those in the page, off screen). The pane's
        // focus brings it to the default answer once the user goes there.
        if (this.visible && actions.some(a => a.default) && this.inFront()) {
            this.focusDesktop()
        }
    }

    private disposers: (() => void)[] = []
    private connectionDisposers: (() => void)[] = []

    onDispose (f: () => void): void {
        this.disposers.push(f)
    }

    onConnectionEnd (f: () => void): void {
        this.connectionDisposers.push(f)
    }

    /** Release browser resources and references to one backend, including when its WASM has trapped. */
    endConnection (): void {
        const clean = (f: () => void) => {
            try { f() } catch (error: any) { this.log.push(`cleanup: ${error?.message ?? error}`) }
        }
        this.connectionDisposers.splice(0).forEach(clean)
        clean(() => this.ui?.shutdown())
        // Removing the component stops its clipboard loop and removes its global listeners.
        clean(() => this.host.replaceChildren())
        this.ui = null
        this.stopSending = null
        clean(() => this.audio?.close())
        this.audio = null
        clean(() => this.h264?.close())
        this.h264 = null
        clean(() => this.mic?.close())
        this.mic = null
        clean(() => this.files?.dispose())
        this.files = null
        clean(() => this.drives?.dispose())
        this.drives = null
        this.remoteSize = null
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
        // A question with a default answer (see StatusAction.default) keeps the focus on it, so Enter picks that.
        const answer = this.statusEl.querySelector<HTMLButtonElement>('.trd-status-default')
        if (answer) {
            if (document.activeElement !== answer) {
                answer.focus()
            }
            return
        }
        const host = this.host.querySelector('iron-remote-desktop')
        this.canvas()?.focus()
        if (host && document.activeElement !== host && attempts > 1 && this.visible) {
            this.focusSoon(attempts - 1, 16)
        }
    }

    dispose (): void {
        this.markDisposed()
        this.setVisible(false)
        clearTimeout(this.labelTimer)
        this.container.removeEventListener('focusin', this.reclaimFocus, true)
        this.disposers.forEach(f => f())
        this.indicator?.dispose()
        this.endConnection()
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
    private ironrdp = new IronRDPLoader(async () => {
        const [factory, bytes] = await Promise.all([
            importESM(vendor('iron-remote-desktop.js')).then(() => importESM(vendor('ironrdp-factory.js'))),
            fs.promises.readFile(vendorFile('ironrdp_web_bg.wasm')),
        ])
        return { module: await WebAssembly.compile(bytes), createBackend: factory.createBackend }
    })
    /** Whether the browser decodes H.264 (asked once). */
    private h264Support: Promise<boolean> | null = null
    /** Desktops (session keys) where H.264 decoding failed: they connect without it until Tabby restarts. */
    private h264Failed = new Set<string>()
    /** When each desktop's video decoder was last taken back by the browser (see run()). */
    private h264Reclaimed = new Map<string, number>()
    /**
     * Where each host stands as far as the key `desk` has there is concerned (see deskGeneration): a count that goes up
     * each time that key is forgotten.
     */
    private deskForgotten = new Map<string, number>()
    /** How many times `desk` was turned off, for every host (see deskGeneration). */
    private deskTurnedOff = 0
    /** Whether `desk` was on when last looked at (see noteDesk): unknown before the first look. */
    private deskWasOn: boolean | undefined

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
    ) {
        // The settings also change without updateSettings: saved in another Tabby window, in Settings › Config file, or
        // by config sync. Open desktops narrow their clipboard then too, as they do from here (see applyClipboard), and
        // the microphone turned off stops at once there as well.
        config.changed$.subscribe(() => this.sessions.forEach(session => {
            this.applyClipboard(session)
            this.applyMicrophone(session)
        }))
        config.changed$.subscribe(() => this.noteDesk())
        // What older versions saved, brought up to date once the config is there, and whenever it changes: config sync
        // can bring a profile an older version made on another computer (see migrateConfig).
        ;(config as any).ready$?.subscribe?.(() => this.migrateConfig())
        config.changed$.subscribe(() => this.migrateConfig())
    }

    /**
     * Brings what older versions saved up to date; saves only when something changed.
     *
     * - Profiles an .rdp import made before imports set an account of their own (0.3 to 0.5) take their group's, or the
     *   global, default saved account, and with it its saved password, to the address the file named; the same goes for
     *   a gateway account, to the gateway it named, and for the kind (an xrdp one would get the password without NLA,
     *   unasked). They get `account`, `gatewayAccount` and `kind` null, as imports now have (see importRdp), so they ask
     *   and are Windows desktops whatever the defaults say. They are known by the shape the import gave them, which no
     *   save in Tabby's profile editor has changed (it drops options equal to their defaults, an empty `via` among
     *   them): the desktop icon, a domain, `via: ''`, and no option the import didn't set.
     * - Gateway certificates remembered under a spelling other than the gateway's one form (0.5.0 kept capitals and a
     *   trailing dot, see parseGateway) are consulted by nothing any more, and only fill the list: dropped. Not moved
     *   to the gateway's form: such a spelling may be one a file chose, its certificate trusted on first use, unasked.
     * - Passwords 0.5.0 saved for desktops reached through a gateway are forgotten, once in each store (see
     *   gatewayPasswords).
     */
    migrateConfig (): void {
        let changed = false
        const imported = new Set(['host', 'port', 'kind', 'username', 'domain', 'via', 'gateway', 'gatewayAccount'])
        for (const p of this.config.store.profiles ?? []) {
            const o = p?.type === RDP_PROFILE_TYPE && p.icon === 'fas fa-desktop' ? p.options : null
            if (o && typeof o === 'object' && !('account' in o) && o.via === '' && typeof o.domain === 'string' && typeof o.host === 'string' &&
                (o.gatewayAccount ?? '') === '' && (o.kind ?? 'windows') === 'windows' && Object.keys(o).every(k => imported.has(k))) {
                o.account = null
                o.gatewayAccount = null
                o.kind = null
                changed = true
            }
        }
        const store = this.config.store.remoteDesktop
        const list = Array.isArray(store?.trustedCertificates) ? store.trustedCertificates : []
        const kept = list.filter((e: any) => {
            const key = typeof e?.desktop === 'string' ? e.desktop : ''
            if (!key.startsWith('gateway#')) {
                return true
            }
            // `gateway#<host>:<port>`, an IPv6 host without its brackets.
            const address = key.slice('gateway#'.length)
            const colon = address.lastIndexOf(':')
            const host = address.slice(0, colon)
            const gateway = colon > 0 ? parseGateway(`${host.includes(':') ? `[${host}]` : host}:${address.slice(colon + 1)}`) : null
            return !!gateway && `gateway#${gateway.host}:${gateway.port}` === key
        })
        if (kept.length !== list.length) {
            store.trustedCertificates = kept
            changed = true
        }
        if (changed) {
            this.config.save()
        }
        // Whatever the config says: its mark is the Vault's, and this computer's keychain keeps one of its own (see
        // forgetOnce).
        if (store && !this.gatewayPasswordsAsked) {
            this.gatewayPasswordsAsked = true
            forgetOnce(GATEWAY_PASSWORDS_MARK, () => this.gatewayPasswords(), {
                done: () => !!this.config.store.remoteDesktop?.gatewayPasswordsMigrated,
                markDone: () => {
                    this.config.store.remoteDesktop.gatewayPasswordsMigrated = true
                    this.config.save()
                },
            })
        }
    }

    /** Whether the passwords 0.5.0 saved for gateways' desktops were handed to forgetOnce (see gatewayPasswords). */
    private gatewayPasswordsAsked = false

    /**
     * 0.5.0 kept the saved password of a desktop reached through an RD Gateway under the desktop's key alone, which is
     * now the key of that address reached without one (passwords are kept for the way they go now, see gatewayScope):
     * any desktop at that address without a gateway (a quick connect, another profile, an .rdp file naming it) would
     * use it unasked. Forgotten, for each address a remote desktop profile or a desktop behind a host reaches through a
     * gateway; the desktops there, with a gateway or without, ask once. Which keys those are, as the config says now:
     * forgetOnce forgets them when the store of passwords is first used (a locked Vault then asks for its passphrase at
     * a sign-in, as it would anyway), once in this computer's keychain, marked done there (GATEWAY_PASSWORDS_MARK), and
     * once in the Vault, marked done in the config (`gatewayPasswordsMigrated`), which config sync takes to other
     * computers with the Vault but not with their keychains. A part that can't be done (a Vault prompt cancelled, a
     * keychain that doesn't answer) is tried again at the next use, and what it would forget isn't used meanwhile.
     */
    private gatewayPasswords (): (key: string) => boolean {
        const direct = new Set<string>()
        const behindHosts = new Set<string>()
        // A profile in a shape nothing reads is left out, rather than fail this: the work couldn't be done then, and no
        // saved password at all would be used meanwhile (see forgetOnce).
        const profiles = this.config.store.profiles
        for (const p of Array.isArray(profiles) ? profiles : []) {
            if (p?.type !== RDP_PROFILE_TYPE) {
                continue
            }
            // As Tabby opens it, its group's gateway included (as it is saved, should Tabby not resolve it).
            let options = p.options
            try {
                options = this.profiles.getConfigProxyForProfile(p).options
            } catch { }
            try {
                const spec = options?.host ? specOf({ ...options, wake: undefined }) : null
                if (spec?.gateway && parseGateway(spec.gateway)) {
                    (options.via ? behindHosts : direct).add(spec.id)
                }
            } catch { }
        }
        for (const entry of this.configuredDesktops()) {
            const spec = entry ? specOf(entry) : null
            if (spec?.gateway && parseGateway(spec.gateway)) {
                behindHosts.add(spec.id)
            }
        }
        // Behind every host: an entry's `via` doesn't say which host's key it is (see desktopEdited).
        return key => {
            const { desktopId } = keyParts(key)
            return direct.has(desktopId) && isFor(key, desktopId, { direct: true, scope: '' }) ||
                behindHosts.has(desktopId) && isFor(key, desktopId, { scope: '' })
        }
    }

    /**
     * The remote a desktop opened in the pane now is on: the pane's own, or in an SSH tab where `ssh` was typed at
     * the prompt, the machine it went to (as for a local terminal running ssh), through the tab's host. Asks when it
     * can't tell which, and whenever the ssh goes somewhere not chosen "from now on" from this host: the host is what
     * says which ssh runs in its terminal, and could otherwise have a desktop of its choosing open in place of its own,
     * unseen. Undefined: cancelled.
     */
    private async remoteFor (pane: DesktopPane): Promise<RemoteTarget | null | undefined> {
        const own = await this.targets.targetOf(pane)
        const nested = own && isSSHTab(pane) ? await this.targets.nestedSSH(pane).catch(() => []) : []
        if (!own || !nested.length) {
            return own
        }
        let chosen = nested[0]
        let remember = false
        if (nested.length > 1 || !this.nestedChosen(own, chosen.cmd.destination)) {
            // The tab's own connection first, so that Enter opens what the tab is connected to. A machine the host says
            // ssh leads to opens this time only, unless the user says to open it at once from now on: a first choice
            // is no consent to every later claim of the host's under that name.
            const picked = await this.selector.show<{ nested: NestedSSH, remember: boolean } | null>('Which remote desktop?', [
                { name: own.label, description: 'this tab\'s own SSH connection', icon: 'fas fa-desktop', result: null },
                ...nested.map(n => ({ name: n.cmd.destination, description: `ssh running in a terminal on ${own.label}`, icon: 'fas fa-desktop', result: { nested: n, remember: false } })),
                ...nested.map(n => ({
                    name: `${n.cmd.destination}, from now on`,
                    description: `ssh running in a terminal on ${own.label}: opens at once from now on`,
                    icon: 'fas fa-desktop',
                    result: { nested: n, remember: true },
                })),
            ]).catch(() => undefined)
            if (picked === undefined) {
                return undefined
            }
            if (!picked) {
                return own
            }
            chosen = picked.nested
            remember = picked.remember
        }
        const target = await this.targets.nestedTarget(pane, chosen).catch(() => null)
        // Remembered once it led somewhere: one the host couldn't resolve is no choice to repeat at once.
        if (target && remember) {
            this.chooseNested(own, chosen.cmd.destination)
        }
        return target ?? own
    }

    /** Whether ssh to `destination`, typed on `outer`, was chosen there for a desktop before (`remoteDesktop.nestedSSH`). */
    private nestedChosen (outer: RemoteTarget, destination: string): boolean {
        const list = this.config.store.remoteDesktop?.nestedSSH
        return (Array.isArray(list) ? list : []).some((e: any) => e?.via === outer.key && e?.destination === destination)
    }

    /** Remembers the choice: from now on, ssh to `destination` alone in a console on `outer` opens its desktop at once. */
    private chooseNested (outer: RemoteTarget, destination: string): void {
        if (!this.nestedChosen(outer, destination)) {
            const store = this.config.store.remoteDesktop
            store.nestedSSH = [...(Array.isArray(store.nestedSSH) ? store.nestedSSH : []), { via: outer.key, destination }]
            this.config.save()
        }
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
            await forgetCredentials(session.credentialKey)
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
        const specs = desktopsFor(target, this.config.store.remoteDesktop?.desktops, this.ownDesktops.get(target.key), viaProfile, this.settings().clipboard)
        // Found VMs come last, and not where a configured desktop has the same address.
        const found = this.settings().discoverVMs ? this.vms.get(target.key)?.specs ?? [] : []
        return [...specs, ...found.filter(f => !specs.some(s => s.id === f.id))]
    }

    /** VMs found on SSH hosts (see vms.ts), by target key: when, and as desktops; and what the scans learnt of the host. */
    private vms = new Map<string, { at: number, specs: DesktopSpec[], scan?: Promise<void>, host: { windows?: boolean, cut?: boolean } }>()

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
        const host = known?.host ?? { windows: this.ownDesktops.get(target.key)?.kind === 'windows' || undefined }
        const scan = scanVMs(target, host).then(found => {
            this.vms.set(target.key, { at: Date.now(), specs: found.map(vmSpec), host })
            this.changed$.next()
        }, () => {
            // Not asked, rather than nothing found (the connection wasn't up yet, say): the next look asks again. A host
            // that was asked and gave no usable answer (none in time, or far too much) waits its minute like any other.
            this.vms.set(target.key, { at: target.isOpen() ? Date.now() : known?.at ?? 0, specs: known?.specs ?? [], host })
        })
        this.vms.set(target.key, { at: known?.at ?? 0, specs: known?.specs ?? [], scan, host })
        return scan
    }

    /**
     * Whether the pane has a VM the host found open, for saveFoundDesktop to keep. Not one found on a machine reached
     * with ssh typed in a host's console: desktops kept behind that machine's name, which is the host's word, would be
     * offered in tabs connected to any host that goes by it (see viaMatches).
     */
    canSaveFoundDesktop (pane: DesktopPane): boolean {
        const session = this.sessions.get(pane)
        return !!session?.spec.found && !!session.remote && session.remote.via === undefined
    }

    /** Keeps a found VM open in the pane among the host's desktops (`remoteDesktop.desktops`), under its name. */
    saveFoundDesktop (pane: DesktopPane): void {
        const session = this.sessions.get(pane)
        const spec = session?.spec
        if (!session?.remote || !spec?.found || !this.canSaveFoundDesktop(pane)) {
            return
        }
        // Its kind stays the host's word, not a choice of the user's: an xrdp one still asks before signing in without
        // Network Level Authentication (see xrdpUnasked), as it did when found.
        const entry = spec.hyperv ? { name: spec.name, via: session.remote.label, hyperv: spec.hyperv }
            : { name: spec.name, via: session.remote.label, host: spec.host, port: spec.port, kind: spec.kind, ...spec.kind === 'xrdp' ? { kindFromHost: true } : {}, ...spec.wake ? { wake: spec.wake } : {} }
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
     * the pane has open, else the host's default. `chosen`: whether one of the host's desktops is that one, known by
     * its key, since a machine reached through the host has desktops of its own with the same ids (its own desktop's
     * is `own`, as the host's is). Worked out once, for a menu to ask of each desktop it lists: a host can list
     * hundreds of VMs, and the host's default is found among all its desktops.
     */
    choicesOf (pane: DesktopPane): { specs: DesktopSpec[], current: DesktopSpec | null, chosen: (spec: DesktopSpec) => boolean } {
        const target = this.targets.cached(pane)
        const specs = target ? this.desktopsOf(target) : []
        const current = this.desktopOf(pane) ?? (target ? this.defaultDesktop(target) : null)
        const key = this.sessions.get(pane)?.key ?? (target && current ? sessionKey(target, current) : null)
        return { specs, current, chosen: spec => !!target && sessionKey(target, spec) === key }
    }

    /** Whether the VMs found on the pane's host are listed only as far as MAX_VMS (see vms.ts): it may have more. */
    vmsCut (pane: DesktopPane): boolean {
        const target = this.targets.cached(pane)
        return !!target && this.settings().discoverVMs && !!this.vms.get(target.key)?.host.cut
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

    /** How far the clipboard of the pane's desktop was narrowed while it was open (DesktopSession.clipboardCap). */
    clipboardCapOf (pane: DesktopPane): ClipboardMode {
        return this.sessions.get(pane)?.clipboardCap ?? 'both'
    }

    private lastUsed = new Map<string, string>()

    /** `remoteDesktop.accounts`: the saved accounts desktops can sign in with (see accounts.ts). */
    accounts (): SavedAccount[] {
        return accountsOf(this.config.store.remoteDesktop)
    }

    private accountRevisions = new AccountRevisions()

    private accountCurrent (key: string, name: string | undefined, revision: string | undefined): boolean {
        const account = this.accounts().find(a => accountKey(a.id) === key)
        return !!account && signInName(account) === name && (account.credentialRevision ?? '') === revision && this.accountRevisions.current(account.id, revision)
    }

    /**
     * The desktops that sign in with a saved account, or sign in to their RD Gateway with it: configured ones behind
     * SSH hosts, and RDP profiles (their own choice, or their profile group's default when they make none). Each comes
     * with what opens its editor.
     */
    accountUses (id: string): { name: string, profileId?: string, desktopIndex?: number }[] {
        // Names as text whatever the config holds (see entryText): the accounts list and the question before removing
        // one show them all.
        const desktops = this.configuredDesktops().flatMap((d, i) => isDesktopEntry(d) && (d.account === id || d.gatewayAccount === id) ? [{ name: entryText(d).name, desktopIndex: i }] : [])
        const groups: any[] = this.config.store.groups ?? []
        const inherited = (p: any) => p.options?.account === undefined && groups.find(g => g.id === p.group)?.defaults?.[RDP_PROFILE_TYPE]?.options?.account === id
        const profiles = (this.config.store.profiles ?? [])
            .filter((p: any) => p?.type === RDP_PROFILE_TYPE && (p.options?.account === id || p.options?.gatewayAccount === id || inherited(p)))
            .map((p: any) => ({ name: configText(p.name) || configText(p.options?.host), profileId: configText(p.id) || undefined }))
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
        let revision: string
        try { revision = this.accountRevisions.change(entry.id) } catch (error: any) {
            return { id: entry.id, keychainError: error?.message ?? String(error) }
        }
        entry.credentialRevision = revision
        // Invalidate before any store await. Keep the old sign-in name until changing its password succeeds.
        if (old) {
            this.config.store.remoteDesktop.accounts = list.map(a => a.id === old.id ? { ...a, credentialRevision: revision } : a)
            await this.config.save()
        }
        const current = () => this.accountRevisions.current(entry.id, revision) && (!old || this.accounts().some(a => a.id === entry.id && a.credentialRevision === revision))
        // The password first: a new user name must not be written while the old password (for the old name) stays, nor
        // a new password reported as saved when the store refused it.
        let keychainError: string | undefined
        if (password !== undefined && password !== '') {
            await saveCredentialsIf(accountKey(entry.id), { username: signInName(entry), password }, current, `saved account ${entry.name}`).catch(e => { keychainError = String(e?.message ?? e) })
        } else if (old && signInName(old) !== signInName(entry)) {
            await forgetCredentialsIf(accountKey(entry.id), current).catch(e => { keychainError = `the old password couldn't be removed: ${e?.message ?? e}` })
        }
        if (!current()) { return { id: entry.id, keychainError: 'The account changed again while this edit was being saved. The newer change was kept.' } }
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
        const now = this.accounts()
        this.config.store.remoteDesktop.accounts = old ? now.map(a => a.id === old.id ? entry : a) : [...now, entry]
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
        try {
            await this.removeAccount(id)
            return true
        } catch (error: any) {
            this.notifications.error(`The account could not be fully removed: ${error?.message ?? error}`)
            return false
        }
    }

    /** Removes a saved account and its password; desktops that used it go back to asking. */
    async removeAccount (id: string): Promise<void> {
        const revision = this.accountRevisions.change(id)
        const store = this.config.store.remoteDesktop
        store.accounts = this.accounts().filter(a => a.id !== id)
        if (this.configuredDesktops().some(d => isDesktopEntry(d) && (d.account === id || d.gatewayAccount === id))) {
            store.desktops = this.configuredDesktops().map(d => {
                if (!isDesktopEntry(d)) {
                    return d
                }
                const rest = { ...d }
                if (rest.account === id) {
                    delete rest.account
                }
                // A gateway that signed in with it takes the desktop's sign-in from now on.
                if (rest.gatewayAccount === id) {
                    delete rest.gatewayAccount
                }
                return rest
            })
        }
        // Null rather than '': '' takes the group's default account, should there be one, where the profile is to ask.
        for (const profile of this.config.store.profiles ?? []) {
            if (profile?.type === RDP_PROFILE_TYPE && profile.options?.account === id) {
                profile.options.account = null
            }
            if (profile?.type === RDP_PROFILE_TYPE && profile.options?.gatewayAccount === id) {
                profile.options.gatewayAccount = null
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
        await forgetCredentialsIf(accountKey(id), () => this.accountRevisions.current(id, revision)).catch(e => this.notifications.error(`The account is removed, but its password could not be: ${e?.message ?? e}`))
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
        const hostname = keyFields(target.key).host
        const entry = await askDesktop(pane.element.nativeElement, {
            title: `Add a desktop reached through ${target.label}`,
            action: 'Add and open',
            accounts: this.accounts(),
            addAccount: input => this.addAccountFromForm(input),
            entry: { via: hostname, host: '127.0.0.1', port: 3389 },
            check: e => this.addressTaken(e, -1),
            clipboard: this.settings().clipboard,
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
        // As text: an edited entry keeps a `via` the form doesn't ask for, and other entries hold whatever the config does.
        const via = configText(entry.via).trim().toLowerCase()
        const taken = this.configuredDesktops().some((d, i) => i !== index && isDesktopEntry(d) && desktopIdOf(d) === id && configText(d.via).trim().toLowerCase() === via)
        return taken ? `There is already a desktop at ${id} behind ${configText(entry.via)}.` : null
    }

    /**
     * "Edit a desktop": the same form, over the pane, filled in. A new address takes what is kept for the desktop along
     * (see desktopEdited); a new user name drops the saved password, which was for the old one. Open sessions keep running.
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
        if (!isDesktopEntry(old)) {
            return
        }
        const { name, via } = entryText(old)
        const entry = await askDesktop(host, {
            title: `Edit ${name}${askVia || !via ? '' : ` (behind ${via})`}`,
            action: 'Save',
            accounts: this.accounts(),
            addAccount: input => this.addAccountFromForm(input),
            hosts: askVia ? await this.sshHosts() : undefined,
            entry: old,
            check: e => this.addressTaken(e, index),
            clipboard: this.settings().clipboard,
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
        await this.desktopEdited(desktopIdOf(old), desktopIdOf(entry), accountChanged, false, { from: old.gateway, to: entry.gateway })
    }

    /**
     * A desktop was edited (the edit form, or an RDP profile's settings): what is kept per desktop is keyed by its
     * address, so a new address takes the saved password, its sharpness, its remembered certificate and the last-used
     * choice along. (Should another machine answer at the new address, its certificate differs and the connection
     * stops to ask, rather than trusting it silently as a first use.) Not the permission to sign in without Network
     * Level Authentication: that was given to the server at the old address, and is asked for again. The saved password
     * is the one of the desktop's way there, `gateways.from` (see gatewayScope): a new user name, domain or account, or
     * another gateway (or none where there was one), drops it instead, since it was for the old one; a new address
     * takes it along, through the same gateway. Another desktop at the old address reached another way (a direct
     * profile next to one through a gateway) keeps its own, and what a desktop at the new address has stays its own.
     * Where a desktop at the new address is known already (a certificate is remembered for it), the password doesn't
     * move either, and the edited desktop asks: its certificate stays the one of the machine there, which then checks
     * out, and the moved password would go to that machine unasked, a desktop of another host's or profile's perhaps.
     * Behind a host, a password moves only along with the certificate remembered for its desktop, and is dropped
     * without one (see moveCredentialsFor). `direct`: a direct desktop (`rdp#<id>` keys), otherwise one behind SSH
     * hosts (`<ssh key>#<id>`): those of every host, since a desktop's `via` can name its host by an alias or a
     * profile's name that its keys don't show. Each store of passwords has its part done on its own: one that can't be
     * read now (Tabby's Vault locked and its prompt cancelled, the keychain not answering) keeps what it holds for the
     * desktop as it was unused, until it can be read while this window is open (see forgetLater). That is said, of that
     * store. After a new address the certificate stays at the old one as well as going along (below), whichever
     * passwords stayed there.
     */
    async desktopEdited (fromId: string, toId: string, accountChanged: boolean, direct: boolean, gateways: { from?: string, to?: string }): Promise<void> {
        const scope = gatewayScope(gateways.from)
        let waiting: Store[] = []
        if (accountChanged || scope !== gatewayScope(gateways.to)) {
            waiting = await forgetCredentialsFor(fromId, { direct, scope })
        } else if (fromId !== toId) {
            // As they are when each password is looked at, not as they were before the stores were listed (a Vault's
            // passphrase prompt takes as long as the user does, and a connection meanwhile may remember the certificate
            // of the new address), and before the certificates move (below).
            waiting = await moveCredentialsFor(fromId, toId, { direct, scope }, key => this.trustedCertificates().some(e => e.desktop === key))
        }
        if (waiting.length) {
            // Not said to be there: a store that can't be read doesn't tell what it holds.
            this.notifications.info(`If a password was saved for this desktop before the change, ${this.passwordWaits(waiting)}`)
        }
        if (fromId === toId) {
            return
        }
        // Anchored on the key's parts, not an `endsWith('#'+fromId)`: a gateway pin (`gateway#…`) or a desktop whose
        // id is a suffix of this one's isn't moved by mistake.
        const moved = (key: string) => {
            const { target, desktopId: id } = keyParts(key)
            return id === fromId && (direct ? target === DIRECT_KEY : target !== DIRECT_KEY && target !== 'gateway')
        }
        const store = this.config.store.remoteDesktop
        // The certificates go along and stay at the old address too. What is kept there still goes only to the machine
        // it was saved for, and another machine answering there meets the certificate question rather than being
        // trusted as a first use: the password of another desktop at that address, reached another way (a certificate
        // belongs to the address, a password to the way there: see credentialKey), or one that a store which couldn't
        // be read still has, found there again should this window close before it goes.
        for (const list of ['desktopSharpness', 'trustedCertificates']) {
            if (Array.isArray(store[list])) {
                // What a desktop already has at the new address (one behind the same host, say) stays its own: the moved
                // entry is dropped rather than put next to it, where either could be the one found.
                const isMoved = (e: any) => typeof e?.desktop === 'string' && moved(e.desktop)
                const taken = new Set(store[list].filter((e: any) => !isMoved(e)).map((e: any) => e?.desktop))
                const kept = list === 'trustedCertificates'
                store[list] = store[list].flatMap((e: any) => {
                    if (!isMoved(e)) {
                        return [e]
                    }
                    const desktop = `${keyParts(e.desktop).target}#${toId}`
                    return [...kept ? [e] : [], ...taken.has(desktop) ? [] : [{ ...e, desktop }]]
                })
            }
        }
        if (Array.isArray(store.withoutNla)) {
            store.withoutNla = store.withoutNla.filter((e: any) => !(typeof e?.desktop === 'string' && moved(e.desktop)))
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
            // A reading or parsing failure is shown, not dropped as an unhandled rejection: this is the user's action.
            try {
                await this.importRdp(new Uint8Array(await file.arrayBuffer()), file.name)
            } catch (e: any) {
                this.notifications.error(`${file.name}: couldn't be imported (${e?.message ?? e})`)
            }
        }
    }

    /**
     * The profile group for remote desktop profiles the plugin makes itself (an .rdp import, "New profile…" on the
     * settings page): "Remote desktops", made the first time. Profiles made on Tabby's Profiles page go where the user
     * puts them.
     */
    async remoteDesktopGroup (): Promise<string> {
        const existing = await this.existingRemoteDesktopGroup()
        if (existing) {
            return existing
        }
        const group = { name: 'Remote desktops', profiles: [] } as any
        await this.profiles.newProfileGroup(group, { genId: true })
        return group.id
    }

    /** The "Remote desktops" profile group's id, when there is one yet (see remoteDesktopGroup). */
    private async existingRemoteDesktopGroup (): Promise<string | undefined> {
        const groups = await this.profiles.getProfileGroups({ includeNonUserGroup: false })
        return groups.find(g => g.name === 'Remote desktops')?.id || undefined
    }

    /**
     * Adds a "Remote desktop (RDP)" profile from a .rdp file's contents (address, user name, domain; see rdpFile.ts)
     * and opens it; or opens the profile that already has that address, user and domain. Returns the profile, or null.
     */
    async importRdp (data: Uint8Array, rawFileName: string): Promise<any> {
        // The file's name comes with the file, and is shown: what could reorder or hide part of it shows as �.
        const fileName = rawFileName.replace(new RegExp(UNSHOWABLE.source, 'gu'), '�')
        const parsed = parseRdpFile(data)
        if (!parsed) {
            this.notifications.error(`${fileName}: no address ("full address") in it`)
            return null
        }
        // The confirmation below is the only gate on an imported file, so the file can't be allowed to spoof it: an
        // address, gateway, user name or domain with a character that could reorder or hide part of it (see
        // UNSHOWABLE) is refused, and an international name is shown and stored as the punycode it actually resolves
        // to, so a look-alike can't pose as a trusted name. But for the zero-width joiners between letters that Persian
        // and Indic scripts write words with, in a user name or a domain (see withoutWordJoiners; elsewhere they don't
        // show): an account's name decides nothing of where the sign-in goes, and such names are a person's own.
        for (const [what, value] of [['address', parsed.host], ['RD Gateway', parsed.gateway], ['user name', parsed.username && withoutWordJoiners(parsed.username)],
            ['domain', parsed.domain && withoutWordJoiners(parsed.domain)]] as const) {
            if (value && UNSHOWABLE.test(value)) {
                this.notifications.error(`${fileName}: its ${what} has characters that can't be shown safely, so it wasn't imported.`)
                return null
            }
        }
        const international = (text: string | undefined) => /[^\x00-\x7f]/.test(text ?? '')
        const spoofable = international(parsed.host) || international(parsed.gateway)
        const host = /^[\x20-\x7e]*$/.test(parsed.host) || isIP(parsed.host) ? parsed.host : domainToASCII(parsed.host) || null
        if (!host) {
            this.notifications.error(`${fileName}: its address isn't one that can be reached.`)
            return null
        }
        parsed.host = host
        if (parsed.gateway) {
            // As the gateway setting has it (see parseGateway): its host as it resolves, its port apart from that.
            const gateway = parseGateway(parsed.gateway)
            if (!gateway) {
                this.notifications.error(`${fileName}: its RD Gateway isn't an address that can be reached.`)
                return null
            }
            parsed.gateway = formatGateway(gateway)
        }
        // A profile that already leads where the file does, as it resolves (its group's defaults included): opened
        // rather than added again. It is the user's own: where it leads, and as whom, are as they set it. As whom
        // includes the domain the question names, which Windows takes for the same in any case.
        const sameGateway = (a: unknown, b: string | undefined) => {
            const [x, y] = [parseGateway(a), parseGateway(b)]
            return x && y ? x.host === y.host && x.port === y.port : !x && !y
        }
        const sameDomain = (a: unknown, b: string | undefined) => configText(a).toLowerCase() === (b ?? '').toLowerCase()
        const existing = (this.config.store.profiles ?? []).find((p: any) => {
            const o = p?.type === RDP_PROFILE_TYPE ? this.profiles.getConfigProxyForProfile(p).options : null
            return o && !o.via && o.host === parsed.host && (o.port || 3389) === parsed.port && (o.username ?? '') === (parsed.username ?? '') &&
                sameDomain(o.domain, parsed.domain) && sameGateway(o.gateway, parsed.gateway)
        })
        if (existing) {
            if (parsed.clipboard && !await this.clipboardOffForFile(existing, fileName)) {
                return null
            }
            this.notifications.info(`Opening "${existing.name}", which is already a profile for ${fileName}`)
            await this.profiles.openNewTabForProfile(existing)
            return existing
        }
        // A file is someone else's word for where to connect: where it leads is said before anything goes there. The
        // account typed into the sign-in form goes to that address, and to the gateway before it, as a proof of the
        // password the gateway can keep, so the gateway's part is spelled out, as is the domain the account would be
        // taken from. A file can turn the clipboard off for its desktop (see rdpFile.ts), never on. Otherwise the
        // profile gets no clipboard option, so that it follows the defaults of its type and of its group (Tabby's
        // profile settings), else the setting: the question names what that comes to.
        const base = fileName.replace(/^.*[\\/]/, '')
        const fileClipboard = parsed.clipboard ? { clipboard: parsed.clipboard } : {}
        const group = await this.existingRemoteDesktopGroup()
        const clipboard = ownClipboard(this.profiles.getConfigProxyForProfile({ type: RDP_PROFILE_TYPE, name: base, group, options: { ...fileClipboard } }).options.clipboard) ??
            this.settings().clipboard
        // The microphone is the setting's alone: on, every desktop gets it whenever it asks for it (an honest server
        // asks while an app there records), whatever the file.
        const what = [...clipboard === 'both' ? ['your clipboard'] : [], 'the folders you share',
            ...this.settings().microphone ? ['your microphone when it asks for it'] : []]
        const listed = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0]
        const gets = clipboard === 'fromRemote' ? `${listed}${what.length > 1 ? ',' : ''} and can put things on your clipboard`
            : clipboard === 'off' && parsed.clipboard ? `${listed} (the file turns the clipboard off for it)` : listed
        const as = parsed.username ? `, as ${signInName({ username: parsed.username, domain: parsed.domain })}`
            : parsed.domain ? `, with an account of the domain ${parsed.domain}` : ''
        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message: `Add a remote desktop from ${base}?`,
            detail: `It connects to ${formatAddress(parsed.host, parsed.port)}${parsed.gateway ? `, through the gateway ${parsed.gateway}` : ''}` +
                `${as}. What you sign in with there goes to that address${parsed.gateway ? ' and that gateway' : ''}, and once signed in, ` +
                `the desktop gets ${gets}.` +
                (parsed.gateway ? ' The gateway is signed in to first, before the desktop is reached, and is given a proof of your password ' +
                    'that whoever runs it could try to crack offline.' : '') +
                (spoofable ? ' A name in the file uses international characters, shown here as the punycode it resolves to.' : '') +
                ' Add it only if you know where it leads, or trust who gave you the file.',
            buttons: ['Add and connect', 'Add only', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
        })
        if (response !== 0 && response !== 1) {
            return null
        }
        const profile = {
            type: RDP_PROFILE_TYPE,
            name: base.replace(/\.rdp$/i, '') || parsed.host,
            icon: 'fas fa-desktop',
            group: await this.remoteDesktopGroup(),
            // `account: null` on purpose: the plugin puts imported profiles in the "Remote desktops" group, and without an
            // account of its own a profile takes that group's (or the global) default saved account, so a file could send
            // a saved, possibly privileged, password to the address it names with no sign-in prompt. Null rather than '':
            // Tabby's profile editor drops a value equal to the default when it saves ('' while there is no default
            // account), and one set later would then be taken; null is never a default, and is no account (see
            // migrateConfig). The editor still offers "Ask for the account" or a saved one. The same for the gateway's
            // account (a default one would send its proof to the gateway the file named) and the kind (a default of xrdp
            // would have the password go without NLA, unasked): null is the desktop's own sign-in, and Windows. The
            // clipboard is the one default left to inherit (see above): the user's own word for the group, and named in
            // the question.
            options: {
                host: parsed.host, port: parsed.port, kind: null, username: parsed.username ?? '', domain: parsed.domain ?? '', account: null, via: '',
                gateway: parsed.gateway ?? '', gatewayAccount: null, ...fileClipboard,
            },
        }
        await this.profiles.newProfile(profile)
        // The file's display scale, as this desktop's own sharpness (the key a direct desktop's settings are kept by).
        if (parsed.sharpness) {
            const store = this.config.store.remoteDesktop
            const key = `${DIRECT_KEY}#${desktopIdOf(profile.options)}`
            store.desktopSharpness = [...(Array.isArray(store.desktopSharpness) ? store.desktopSharpness : []).filter((e: any) => e?.desktop !== key), { desktop: key, sharpness: parsed.sharpness }]
        }
        this.config.save()
        this.notifications.notice(`Added the remote desktop profile "${profile.name}" (Settings › Profiles & connections)`)
        // What the file asked for beyond that, so nobody wonders why the desktop doesn't behave as in mstsc. The microphone
        // isn't among it while the setting is on: the desktop gets it then (the question said so). A note can quote the
        // file (a gateway it names but doesn't use), shown as the file name is.
        const ignored = parsed.ignored.filter(note => note !== MICROPHONE_NOTE || !this.settings().microphone)
        if (ignored.length) {
            const notes = ignored.join('; ').replace(new RegExp(UNSHOWABLE.source, 'gu'), '�')
            this.notifications.info(`${base} also asks for ${notes}. Not applied.`)
        }
        if (response === 0) {
            await this.profiles.openNewTabForProfile(profile)
        }
        return profile
    }

    /**
     * An .rdp file that turns the clipboard off leads to a profile there already is: opened as it is, that profile
     * would share the clipboard all the same. Unless it is off there too, the user is asked whether to turn it off in
     * that profile, or to open it as it is; nothing goes in silence. False when cancelled.
     */
    private async clipboardOffForFile (profile: any, fileName: string): Promise<boolean> {
        const now = ownClipboard(this.profiles.getConfigProxyForProfile(profile).options?.clipboard) ?? this.settings().clipboard
        if (now === 'off') {
            return true
        }
        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message: `Turn the clipboard off for "${profile.name}"?`,
            detail: `${fileName.replace(/^.*[\\/]/, '')} turns the clipboard off for its desktop, and "${profile.name}", already a ` +
                `profile for that desktop, ${now === 'both' ? 'shares it both ways' : 'lets that desktop put things on your clipboard'}. ` +
                'Turned off there, it is off from now on; if the desktop is open, what you copy after that stops going ' +
                'to it (what it was reading already may still arrive), and the clipboard is off in full once the desktop reconnects.',
            buttons: ['Turn it off and open', 'Open as it is', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
        })
        if (response === 0) {
            // As Tabby's profile editor saves a profile: new options in place of the old. Opening it then narrows its
            // desktop if it is open already (see showDesktop).
            profile.options = { ...profile.options, clipboard: 'off' }
            this.config.save()
        }
        return response === 0 || response === 1
    }

    /** Asks, then removes a configured desktop (see removeDesktop). The menus and the settings page use this. */
    async confirmRemoveDesktop (index: number): Promise<boolean> {
        const d = this.configuredDesktops()[index]
        if (!isDesktopEntry(d)) {
            return false
        }
        // A Hyper-V VM's sign-in and certificate are its host's (see DesktopSession.authKey), which its other VMs use too.
        const { name, address, via, hyperv } = entryText(d)
        const { response } = await this.platform.showMessageBox({
            type: 'warning',
            message: `Remove the desktop "${name}"?`,
            detail: (hyperv ? `A Hyper-V VM${via ? ` on ${via}` : ''}. The sign-in and certificate kept for its host stay, for its other VMs. `
                : `${address}${via ? ` behind ${via}` : ''}. Its saved password and remembered certificate are forgotten too. `) +
                'To open it instead, use its host\'s SSH tab: right-click › Open.',
            buttons: ['Remove', 'Keep'],
            defaultId: 1,
            cancelId: 1,
        })
        if (response !== 0) {
            return false
        }
        // Not waited for: the stores are asked meanwhile, which a Vault's passphrase prompt can hold up.
        this.removeDesktop(index).catch(() => null)
        return true
    }

    /**
     * Removes a configured desktop, its saved passwords and its remembered certificate. Open sessions to it keep
     * running. The desktop is gone from the list at once; what is kept for it goes as forgetDesktop says, which can
     * take as long as a Vault's passphrase prompt does: a caller needn't wait for the result.
     */
    async removeDesktop (index: number): Promise<void> {
        const list = this.configuredDesktops()
        const [removed] = list.splice(index, 1)
        if (!isDesktopEntry(removed)) {
            return
        }
        // Its desktop's id, which what is kept for it is under: a Hyper-V VM's included.
        const id = desktopIdOf(removed)
        this.config.store.remoteDesktop.desktops = list
        this.config.save()
        this.changed$.next()
        await this.forgetDesktop(id, false, `"${entryText(removed).name}"`)
    }

    /**
     * Forgets what is kept for a desktop that is gone (removed from the list, or a direct profile deleted or sent
     * through an SSH host): its saved passwords from each store that can be read, and then its remembered certificate,
     * that of every desktop at that address behind any SSH host or, with `direct`, the direct one's. Where a store
     * can't be read just now (Tabby's Vault locked and its prompt cancelled, the keychain not answering) its password
     * stays, unused in this window (see forgetCredentialsFor), and so do the certificates: they are what keeps that
     * password from going to a machine that isn't the one it was saved for, where a desktop behind a host trusts the
     * first certificate it meets unasked. The user is told, and can forget them in Settings › Remote Desktop ›
     * Certificates. `what` names the desktop for that.
     */
    async forgetDesktop (id: string, direct: boolean, what: string): Promise<void> {
        const waiting = await forgetCredentialsFor(id, direct ? { direct: true } : {})
        if (waiting.length) {
            this.notifications.info(`If a password was saved for ${what}, ${this.passwordWaits(waiting)} Its remembered certificate stays, ` +
                'so that the password can only go to that machine: Settings › Remote Desktop › Certificates can forget it.')
            return
        }
        this.forgetCertificatesFor(id, direct)
        this.config.save()
        this.changed$.next()
    }

    /**
     * What becomes of a desktop's saved password that couldn't be removed from `waiting`, the stores that can't be read
     * just now (see forgetCredentialsFor), as the end of a sentence.
     */
    private passwordWaits (waiting: Store[]): string {
        const where = waiting.map(store => store === 'vault' ? 'Tabby\'s Vault' : 'the system keychain').join(' or ')
        const when = waiting.length > 1 ? 'each can be read' : waiting[0] === 'vault' ? 'the Vault is unlocked' : 'the keychain answers'
        return `it couldn't be removed from ${where} just now. It won't be used in this window, and is removed once ${when}, while the window stays open.`
    }

    /**
     * Shows a desktop over the pane: `desktopId` (see desktopsOf), or the one it has open, or the default. A pane
     * holds one desktop at a time; choosing another one replaces it.
     */
    async showDesktop (pane: DesktopPane, desktopId?: string, options: { background?: boolean, viewOnly?: boolean, target?: RemoteTarget, clipboardCap?: ClipboardMode } = {}): Promise<void> {
        this.prune()
        // A desktop asked for by id is one of the pane's own host's (the menus list those), not one of wherever ssh
        // typed in its console leads: an id from that list isn't to be looked up among the desktops of a machine the
        // host names. Nor is a desktop open in the pane taken for it by its id alone: a machine's own desktop there has
        // the id of the host's own.
        const requested = desktopId ? options.target ?? await this.targets.targetOf(pane) : undefined
        let session = this.sessions.get(pane)
        // One that ended (the server can end it whenever it likes) is shown again as a new connection, which keeps to the
        // clipboard it was narrowed to (see clipboardCap), as a reconnect does: below, when it is the same desktop.
        const ended = session?.state === 'ended' ? session : undefined
        if (session?.state === 'ended' || session && desktopId && (session.spec.id !== desktopId || requested && session.key !== sessionKey(requested, { id: desktopId }))) {
            this.disconnect(pane)
            session = undefined
        }
        if (!session) {
            const target = desktopId ? requested : options.target ?? await this.remoteFor(pane)
            if (target === undefined) {
                return
            }
            if (!target) {
                // A remote desktop tab whose profile was changed to go through an SSH profile: that one opens over its tab.
                this.notifications.error(isRDPTab(pane) ? `${pane.profile?.name ?? 'This profile'} no longer connects directly: open it from the profile list`
                    : 'No SSH connection found in this terminal')
                return
            }
            if (this.sessions.has(pane)) {
                // Opened meanwhile (e.g. a double click); just show it, if it is the one asked for on the same remote.
                return this.showDesktop(pane, desktopId, { ...options, target: requested ?? options.target })
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
                // Asked for with a narrower clipboard than the open one was connected with (another profile for the same
                // desktop, say, or an .rdp file's): that one narrows to it, rather than the request getting more.
                const open = this.sessions.get(existing)
                if (open && this.applyClipboard(open, narrowest(spec.clipboard ?? this.settings().clipboard, options.clipboardCap ?? 'both'))) {
                    open.files?.toast(`Clipboard sharing with this desktop is now ${CLIPBOARD_LABELS[open.clipboard].toLowerCase()}, as ` +
                        `${spec.name} has it, until it is closed. The change applies in full once the desktop reconnects.`)
                }
                this.selectPane(existing)
                return this.showDesktop(existing)
            }
            const created = new DesktopSession(pane.element.nativeElement, key, spec)
            created.onHelp = message => this.help.explain(message)
            // The remote it is opened on, from the start: reopening one whose connection ended before it got as far as
            // a sign-in (cancelled, or a setup that failed) goes there again, not to the tab's own host.
            created.remote = target
            created.inFront = () => this.showsInFront(created)
            // View only stays on for the same desktop shown again after its server ended it, as on a reconnect: the
            // keys typed there would go to it otherwise.
            if (options.viewOnly || ended?.key === key && ended.viewOnly) {
                created.setViewOnly(true)
            }
            const cap = narrowest(options.clipboardCap ?? 'both', ended?.key === key ? ended.clipboardCap : 'both')
            if (cap !== 'both') {
                created.clipboardCap = cap
            }
            session = created
            this.sessions.set(pane, created)
            // Released with the session: a pane outlives the desktops opened and closed in it.
            const destroyed = pane.destroyed$.subscribe(() => this.disconnect(pane))
            created.onDispose(() => destroyed.unsubscribe())
            // Tabby focuses the terminal when the pane gets focus (tab switch, split focus); take it back.
            const focused = pane.focused$.subscribe(() => {
                if (created.visible) {
                    setTimeout(() => created.visible && this.showsInFront(created) && created.focusDesktop())
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

    /** Each pane's `desk` requests, one at a time (see DeskGate). */
    private deskGates = new WeakMap<DesktopPane, DeskGate>()

    /** Whether `key` is desk's key of a host whose setup gave it to this plugin (see openConsole). */
    knowsDeskKey (key: string): boolean {
        const digest = deskKeyDigest(key)
        return !!digest && this.deskKeys().some(e => e.sha256 === digest)
    }

    /**
     * `desk`: show this machine's desktop and bring the console along: a terminal on the desktop,
     * attached to the console's shared session (or opened in its folder when it isn't in one).
     */
    async openConsole (pane: DesktopPane, request: DeskRequest): Promise<void> {
        // Anything shown in a terminal can carry what `desk` prints: a file, a log, another machine's output. A request
        // counts only with the key of a host whose setup gave it to this plugin, which only that user can read there;
        // others are ignored before anything runs, here or on a host, and without a word in Tabby's window.
        if (!this.knowsDeskKey(request.key)) {
            console.warn(`desk: ignored a request ${request.key ? 'with a key no host gave this plugin' : 'without desk\'s key'}`)
            return
        }
        let gate = this.deskGates.get(pane)
        if (!gate) {
            gate = new DeskGate()
            this.deskGates.set(pane, gate)
        }
        await gate.run(async () => {
            if (!this.settings().desk) {
                // A hook left from when it was on; it goes away the next time a desktop opens there. Said when `desk` is
                // typed, in the pane in front, not whenever a host likes (see below).
                if (this.inFront(pane)) {
                    this.notifications.info('`desk` is off: turn it on in the menu under Remote Desktop › Settings')
                } else {
                    console.warn('desk: ignored a request while desk is off, from a pane that isn\'t in front')
                }
                return
            }
            // A host can always send its own key, and a recording of `desk`'s output holds it: such a request mustn't show
            // a desktop in a pane the user isn't in, where it would take the keyboard (and this computer's clipboard)
            // from the pane they are typing in. `desk` is typed in the pane in front.
            if (!this.inFront(pane)) {
                this.help.note(pane.element.nativeElement, 'desk asked for this machine\'s desktop while this pane wasn\'t the one in front, so it wasn\'t shown. Run desk again here to show it.')
                return
            }
            await this.openConsoleFor(pane, request, deskKeyDigest(request.key))
        })
    }

    /**
     * Whether the pane is the one the user is in: the focused pane of the active tab. A desktop that takes the focus
     * anywhere else takes the keyboard from that pane, even in a tab that isn't showing: Tabby keeps those in the page,
     * off screen. (Whether Tabby's window is in front doesn't matter here: what is decided is which pane has the
     * keyboard once the user is back.)
     */
    private inFront (pane: DesktopPane): boolean {
        return desktopPaneOf(this.app.activeTab) === pane
    }

    /** Whether `session` is the desktop of the pane the user is in (see inFront). */
    private showsInFront (session: DesktopSession): boolean {
        const pane = desktopPaneOf(this.app.activeTab)
        return !!pane && this.sessions.get(pane) === session
    }

    /**
     * Gives a desktop that just connected the keyboard, if it shows in the pane the user is in. Not when another pane is
     * in front by now: the connection can take as long as the remote likes, and the keyboard (and this computer's
     * clipboard, which follows it) stays where the user went. The pane takes it back when it gets the focus again.
     */
    private focusIfInFront (pane: DesktopPane, session: DesktopSession): void {
        if (session.visible && this.inFront(pane)) {
            session.focusDesktop()
        }
    }

    /**
     * Whether another pane of the pane's split is maximized over it (Tabby's pane-maximize): it is all but hidden then,
     * nearly transparent behind that pane, so it counts as not showing (see takesAll and inView).
     */
    private behindMaximized (pane: DesktopPane): boolean {
        const maximized = (this.splitOf(pane) as any)?.getMaximizedTab?.()
        return !!maximized && maximized !== pane
    }

    private async openConsoleFor (pane: DesktopPane, request: DeskRequest, digest: string): Promise<void> {
        const target = await this.targets.targetOf(pane)
        if (!target) {
            return
        }
        // `desk` may run on another machine than the pane is connected to: `ssh` typed in its console, with the script
        // there through a shared home folder. That machine's desktop isn't this connection's to open.
        let there: RemoteTarget | null = target
        if (request.machine) {
            const machineOf = async (t: RemoteTarget) => (await t.exec('sh -s', MACHINE_ID_COMMAND).catch(() => '')).trim()
            const machine = await machineOf(target)
            if (!machine) {
                // Without an answer it could be either machine.
                this.notifications.error(`desk: couldn't ask ${target.label} which machine it is`)
                return
            }
            if (machine !== request.machine) {
                // Typed `ssh` at the prompt: the machine it went to, when that is where desk ran.
                there = null
                for (const nested of isSSHTab(pane) ? await this.targets.nestedSSH(pane).catch(() => []) : []) {
                    const candidate = await this.targets.nestedTarget(pane, nested).catch(() => null)
                    if (candidate && await machineOf(candidate) === request.machine) {
                        there = candidate
                        break
                    }
                }
                if (!there) {
                    const elsewhere = request.hostname || 'another machine'
                    this.help.note(pane.element.nativeElement, `desk ran on ${elsewhere}, but this tab is connected to ${target.label}. ` +
                        `Open ${elsewhere} in its own tab to use desk there.`, 'nested-ssh')
                    return
                }
            }
        }
        // The key must be that machine's own: the one known may be another host's (a shared home folder gives several
        // the same one), and one set up from another computer is learned by opening the desktop from this one.
        const known = this.deskKeyOf(there.key)
        if (known !== digest) {
            this.help.note(pane.element.nativeElement, known
                ? `desk on ${there.label} sent a key that isn't the one this Tabby has for it (it was set up again since, or the key is another machine's): open its desktop once, then run desk again.`
                : `This Tabby doesn't know desk on ${there.label} yet: open its desktop once, then run desk again.`)
            return
        }
        return this.openConsoleOn(pane, there, request)
    }

    /** What the setups of GNOME hosts said about `desk` (`remoteDesktop.deskKeys`): its key's digest, by account. */
    private deskKeys (): { desktop: string, sha256: string }[] {
        const list = this.config.store.remoteDesktop?.deskKeys
        return (Array.isArray(list) ? list : []).filter((e: any) => typeof e?.desktop === 'string' && typeof e?.sha256 === 'string')
    }

    private deskKeyOf (key: string): string {
        return this.deskKeys().find(e => e.desktop === key)?.sha256 ?? ''
    }

    /**
     * Notes `desk` going from on to off, wherever the setting was changed (here, another window, the config file,
     * config sync): see deskGeneration. `before`: what it was just before a change made here, where that is known.
     */
    private noteDesk (before = this.deskWasOn): void {
        const on = this.settings().desk
        if (before === true && !on) {
            this.deskTurnedOff++
        }
        this.deskWasOn = on
    }

    /**
     * A number that changes whenever what a setup of the host's that began earlier learned about `desk` there is no
     * longer to be kept: desk was turned off since (for every host), or the host's key was forgotten (by a setup run
     * with desk off, say). A setup asked to set desk up takes it as it starts, and gives a key only if it is still the
     * same as it ends: one that began with desk on, which was turned off meanwhile and on again, or that another setup
     * dropped the host's key under, would otherwise put its key back after the host was dropped from desk.
     */
    private deskGeneration (key: string): number {
        return this.deskTurnedOff + (this.deskForgotten.get(key) ?? 0)
    }

    /**
     * Keeps what a host's setup said about `desk`: its key's digest while desk is set up there (so that desk works after
     * Tabby restarts too), nothing otherwise. Only a setup asked to set desk up (`requested`), with desk still on as it
     * ends, and not turned off, or the host's key forgotten, since it began (`generation`, see deskGeneration), gives a
     * key: a host whose setup ran with desk off has none (that setup removed it), so one it reports anyway is only a
     * way in. Any other setup forgets the host's key: desk off, or the host's own desktop no longer GNOME's. One that
     * began before desk was turned off and on again, or before the host's key was forgotten, changes nothing.
     */
    private rememberDeskKey (key: string, endpoint: RemoteDesktopEndpoint, requested: boolean, generation: number): void {
        if (!this.settings().desk) {
            this.forgetDeskKey(key)
            return
        }
        // Begun before desk was turned off (and on again), or before the host's key was forgotten (by a setup of its
        // own with desk off, say): what it learned isn't kept, and what came since stays as it is, a newer setup's key
        // or none, rather than being undone by this one.
        if (generation !== this.deskGeneration(key)) {
            return
        }
        const sha256 = requested && endpoint.kind === 'gnome' ? deskKeyDigest(endpoint.deskKey) : ''
        if (!sha256) {
            this.forgetDeskKey(key)
            return
        }
        if (this.deskKeyOf(key) === sha256) {
            return
        }
        const store = this.config.store.remoteDesktop
        const others = (Array.isArray(store.deskKeys) ? store.deskKeys : []).filter((e: any) => e?.desktop !== key)
        store.deskKeys = [...others, { desktop: key, sha256 }]
        this.config.save()
    }

    /** Forgets a host's desk key (see rememberDeskKey); saves only when there was one. */
    private forgetDeskKey (key: string): void {
        this.deskForgotten.set(key, (this.deskForgotten.get(key) ?? 0) + 1)
        const store = this.config.store.remoteDesktop
        const list = Array.isArray(store.deskKeys) ? store.deskKeys : []
        const others = list.filter((e: any) => e?.desktop !== key)
        if (others.length !== list.length) {
            store.deskKeys = others
            this.config.save()
        }
    }

    /**
     * The host's setup (see prepareRemoteDesktop), with `desk` as it is set as it starts, and what it says about desk
     * kept. A setup with desk off removes desk there, which is how a host is dropped (opening its desktop with desk
     * off), so its key is forgotten before the host is asked anything: a host that answers with an error, with nothing
     * the setup can use, or not at all keeps none. So is the key of one whose setup fails while desk is off. One that
     * began before desk was turned off and on again keeps nothing it learned, and leaves what came since as it is (see
     * deskGeneration).
     */
    private async setUp (pane: DesktopPane, target: RemoteTarget, takeOver = false): Promise<RemoteDesktopEndpoint> {
        this.noteDesk()
        const desk = this.settings().desk
        if (!desk) {
            this.forgetDeskKey(target.key)
        }
        // After that, which is this setup's own: what changes the host's key's standing from here on is another's.
        const generation = this.deskGeneration(target.key)
        let endpoint: RemoteDesktopEndpoint
        try {
            endpoint = await prepareRemoteDesktop(target, desk, this.config.store.remoteDesktop?.sessionBackend, this.clientOf(pane), takeOver)
        } catch (e) {
            if (!this.settings().desk) {
                this.forgetDeskKey(target.key)
            }
            throw e
        }
        this.rememberDeskKey(target.key, endpoint, desk, generation)
        return endpoint
    }

    private async openConsoleOn (pane: DesktopPane, target: RemoteTarget, request: DeskRequest): Promise<void> {
        // Asked again: the host decides how long its answers above take, and could wait until the user is elsewhere.
        if (!this.inFront(pane)) {
            this.help.note(pane.element.nativeElement, 'desk\'s desktop wasn\'t shown: another pane was in front by then. Run desk again here to show it.')
            return
        }
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
            // The host's words, as much of them as a notice shows: the host decides how long its lines are.
            const err = /^RD_ERR (.{0,1000})/m.exec(out)
            session.log.push(err ? `desk: ${err[1]}` : `desk: ${/^RD_OK (.{0,1000})/m.exec(out)?.[1] ?? 'no result'}`)
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

    /** The top-level tab holding a pane: the pane itself, or the split it is in. */
    private topTabOf (pane: DesktopPane): AppService['tabs'][number] | undefined {
        return this.app.tabs.find(t => t === pane || (t instanceof SplitTabComponent && t.getAllTabs().includes(pane)))
    }

    /** Brings a pane forward: its top-level tab, and the pane itself within a split. */
    private selectPane (pane: DesktopPane): void {
        const top = this.topTabOf(pane)
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

    /**
     * Automatic reconnection after a desktop dropped, per pane: attempts so far and the pending timer. Kept while a
     * reconnected desktop is up, until it has stayed up for STABLE_MS (see reconnectedUntilNow): one that drops again
     * sooner goes on where the delays were, and they run out.
     */
    private reconnects = new Map<DesktopPane, { attempts: number, timer?: ReturnType<typeof setTimeout>, since: number }>()
    private static readonly RECONNECT_DELAYS = [1, 2, 4, 8, 15, 30]
    /** How long a connection has to stay up to count as back: a drop after that starts the delays over. */
    private static readonly STABLE_MS = 30000
    /** A video decoder the browser takes back twice within this turns H.264 off for the desktop (see run()). */
    private static readonly RECLAIMED_AGAIN_MS = 10 * 60000

    private cancelReconnect (pane: DesktopPane): void {
        clearTimeout(this.reconnects.get(pane)?.timer)
        this.reconnects.delete(pane)
    }

    /**
     * The pane's desktop, reconnected, was up from `connectedAt` until now. Back for good once it stayed up STABLE_MS:
     * a later drop starts the delays over. One that ended sooner (a server that ends every connection at once, say)
     * goes on backing off, from when it dropped.
     */
    private reconnectedUntilNow (pane: DesktopPane, connectedAt: number): void {
        const reconnecting = this.reconnects.get(pane)
        if (reconnecting && Date.now() - connectedAt >= RemoteDesktopService.STABLE_MS) {
            this.reconnects.delete(pane)
        } else if (reconnecting) {
            reconnecting.since = Date.now()
        }
    }

    /** The browser took the desktop's video decoder back (`key`: its session's): whether it did so before, not long ago. */
    private decoderReclaimedAgain (key: string): boolean {
        const before = this.h264Reclaimed.get(key)
        this.h264Reclaimed.set(key, Date.now())
        return before !== undefined && Date.now() - before <= RemoteDesktopService.RECLAIMED_AGAIN_MS
    }

    /**
     * Connects this pane's desktop again, keeping it shown or hidden as it was, view only or not, and its clipboard no
     * wider than a narrower way of opening it asked for (DesktopSession.clipboardCap).
     */
    private async reopen (pane: DesktopPane, spec: DesktopSpec, automatic = false): Promise<void> {
        if (!automatic) {
            this.cancelReconnect(pane)
        }
        const session = this.sessions.get(pane)
        const background = !!session && !session.visible
        this.drop(pane, false)
        // The same remote as before, even if the `ssh` it was found through has ended since. A remote desktop tab's one
        // desktop is made afresh instead, from its profile as saved now (see RemoteTargets.targetOf), whose address may
        // have changed meanwhile.
        const tab = isRDPTab(pane)
        await this.zone.run(() => this.showDesktop(pane, tab ? undefined : spec.id, {
            background, viewOnly: session?.viewOnly, target: tab ? undefined : session?.remote ?? undefined, clipboardCap: session?.clipboardCap,
        }))
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
            this.cancelReconnect(pane)
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
            unicodeKeys: store.unicodeKeys === true,
            sound: store.sound !== false,
            h264: store.h264 !== false,
            zoom: store.zoom === 'actual' ? 'actual' : 'fit',
            connectionStatus: store.connectionStatus === true,
            microphone: store.microphone === true,
            clipboard: clipboardSetting(store.clipboard),
            osd: osdSettings(store.osd),
            discoverVMs: store.discoverVMs !== false,
            checkUpdates: store.checkUpdates !== false,
            shutDownIdle: [5, 15, 60].includes(configNumber(store.shutDownIdle)) ? configNumber(store.shutDownIdle) : 0,
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

    /**
     * The settings for a desktop: the defaults, with its own sharpness and clipboard sharing where it has them, the
     * clipboard no wider than a narrower way of opening it asked for while it was open (DesktopSession.clipboardCap).
     */
    private settingsFor (session: DesktopSession): DesktopSettings {
        const settings = this.settings()
        return {
            ...settings,
            sharpness: this.sharpnessFor(session.key) ?? settings.sharpness,
            clipboard: narrowest(session.spec.clipboard ?? settings.clipboard, session.clipboardCap),
        }
    }

    /**
     * The ways the clipboard goes with the session's desktop now: what its connection lets through, and no more than
     * the settings say now (also when they were changed in the config file rather than here).
     */
    private clipboardWaysOf (session: DesktopSession): ClipboardWays {
        return clipboardWays(session.clipboard, this.settingsFor(session).clipboard)
    }

    /**
     * Narrows what the session's connection lets through when the settings narrow it while connected, or `also` does (a
     * narrower desktop opened onto this one: see showDesktop): this computer's clipboard stops going there at once (the
     * component's reading stopped), the files offered there are taken back, and what the plugin sends and offers
     * itself stops too. The rest of the narrowing, like widening, waits for the next connection, which sets the
     * clipboard up anew. True when it narrowed.
     */
    private applyClipboard (session: DesktopSession, also?: ClipboardMode): boolean {
        if (also) {
            // Kept for this desktop's connections here, a retry while connecting and its reconnects included: see
            // settingsFor and reopen.
            session.clipboardCap = narrowest(session.clipboardCap, also)
        }
        const narrowed = narrowest(session.clipboard, this.settingsFor(session).clipboard)
        if (narrowed === session.clipboard) {
            return false
        }
        // Narrowed first: taking the offered files back ends a paste of them, whose hook would start the reading
        // again if the connection still let this computer's clipboard go (see setUpClipboard).
        session.clipboard = narrowed
        if (!clipboardWays(narrowed).toRemote) {
            session.stopSending?.()
            session.files?.revoke()
        }
        session.log.push(`clipboard: ${narrowed === 'off' ? 'off' : 'only from the remote desktop'} from now on ` +
            '(in full once it reconnects)')
        return true
    }

    /** Changes a setting, saves it, and applies it to open desktops. */
    updateSettings (change: Partial<DesktopSettings>): void {
        const store = this.config.store.remoteDesktop
        const { osd, ...rest } = change
        const desk = this.settings().desk
        Object.assign(store, rest)
        this.noteDesk(desk)
        if (osd) {
            // A nested object in Tabby's config takes its fields one by one (the object itself isn't replaced).
            Object.assign(store.osd, osd)
        }
        if (change.h264) {
            this.h264Failed.clear()  // turned on again: give it another try everywhere
            this.h264Reclaimed.clear()
        }
        this.config.save()
        for (const [pane, session] of this.sessions) {
            this.applyMicrophone(session)
            this.applyZoom(session)
            this.applyKeyboardMode(session)
            this.applyClipboard(session)
            this.syncIndicator(session)
            this.followPane(pane, session)
        }
    }

    /**
     * The microphone setting turned off stops the session's microphone at once, also on a connection still being set
     * up (run() reads the setting again where it makes the microphone). Turned on, it takes the next connection.
     */
    private applyMicrophone (session: DesktopSession): void {
        if (!this.settings().microphone) {
            session.mic?.turnOff()
        }
    }

    /** IronRDP's keyboard mode for the session: characters (Unicode) or key positions (scancodes), per the setting. */
    private applyKeyboardMode (session: DesktopSession): void {
        try { session.ui?.setKeyboardUnicodeMode(this.settings().unicodeKeys) } catch { }
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
        session.onConnectionEnd(() => {
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
            const { viewOnly, clipboardCap } = session
            // The same remote and desktop as before, rather than looking (and maybe asking) again which one the pane
            // is on, or taking the host's last used, which may be another pane's. A remote desktop tab's one desktop is
            // made afresh, from its profile as saved now, as reopen does.
            const tab = isRDPTab(pane)
            const target = tab ? undefined : session.remote ?? undefined
            this.zone.run(() => {
                this.disconnect(pane)
                this.showDesktop(pane, tab ? undefined : session.spec.id, { viewOnly, target, clipboardCap })
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
            if (viewOnly) {
                // From here on this desktop's keys stop at the plugin, their keyups too: let go of what is down, also
                // on the desktops typing into all had copy them.
                session.releaseKeys()
                if (this.isBroadcast(pane)) {
                    this.othersInTab(pane).forEach(other => other.session.releaseKeys())
                }
            }
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
        // After a tab switch, the pane shows on Angular's next change detection. Not once the user went elsewhere
        // meanwhile: the keyboard stays where they went.
        for (let i = 0; i < 30 && this.showsInFront(session); i++) {
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
        // The overlay is cosmetic: whatever goes wrong with it, reading its settings included, mustn't fail the connection
        // it names (see run()).
        try {
            const target = session.remote
            const osd = osdSettings(this.config.store.remoteDesktop?.osd)
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
        } catch (e: any) {
            session.log.push(`overlay: ${e?.message ?? e}`)
        }
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

    /**
     * The one-time tip (see RemoteDesktopHelp.tipOnce), once a desktop is connected and showing. Closing it (Got it, or
     * by itself after a while) gives the desktop the keyboard back only if its pane is the one in front by then: the
     * user may have gone to another pane, in another tab too, which would lose the keyboard (and this computer's
     * clipboard) to it. The pane takes it back when it gets the focus again.
     */
    private tip (pane: DesktopPane, session: DesktopSession): void {
        if (session.state === 'connected' && session.visible) {
            this.help.tipOnce(session.overlay, this.hasConsole(pane), () => session.visible && this.showsInFront(session) && session.focusDesktop())
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

    /**
     * The desktops sent the microphone right now (the remote has it open), for the indicator in Tabby's header
     * (header.ts), and whether each is in view, where the dot on it says so too.
     */
    microphoneUsers (): { pane: DesktopPane, name: string, inView: boolean }[] {
        this.prune()
        return [...this.sessions].filter(([, session]) => session.mic?.capturing)
            .map(([pane, session]) => ({ pane, name: session.spec.name, inView: this.inView(pane, session) }))
    }

    /**
     * The desktops (session keys) the microphone was stopped for, by Stop in the header's microphone menu or the
     * desktop's own menu. A server can end its connection whenever it likes, and the one made in its place would go by
     * the setting again, so the stop holds for the desktop, reconnects included, however they come about, until it is
     * turned back on in the desktop's menu. Kept in this window until it is closed: each Tabby window has its own.
     */
    private microphoneStopped = new Set<string>()

    /** Stops sending the microphone to the pane's desktop at once, and on its later connections (see microphoneStopped). */
    stopMicrophone (pane: DesktopPane): void {
        const session = this.sessions.get(pane)
        if (!session) {
            return
        }
        this.microphoneStopped.add(session.key)
        session.log.push('microphone: stopped for this desktop, its reconnects included')
        session.mic?.turnOff()
        this.changed$.next()
    }

    /** Whether the microphone was stopped for the pane's desktop (see stopMicrophone). */
    microphoneStoppedFor (pane: DesktopPane): boolean {
        const session = this.sessions.get(pane)
        return !!session && this.microphoneStopped.has(session.key)
    }

    /**
     * Sends the microphone to the pane's desktop again, after a stop: when it asks for it, at once if it has it open,
     * as long as the setting is on.
     */
    resumeMicrophone (pane: DesktopPane): void {
        const session = this.sessions.get(pane)
        if (!session || !this.microphoneStopped.delete(session.key)) {
            return
        }
        session.log.push('microphone: sent to this desktop again')
        if (this.settings().microphone) {
            session.mic?.turnOn()
        }
        this.changed$.next()
    }

    /** Brings the pane's desktop on screen: its tab, the pane within a split, and the desktop over the console. */
    async bringForward (pane: DesktopPane): Promise<void> {
        if (this.sessions.has(pane)) {
            this.selectPane(pane)
            await this.showDesktop(pane)
        }
    }

    /** When each desktop's last note about its microphone was (see microphoneChanged). */
    private microphoneNoted = new WeakMap<DesktopSession, number>()

    /**
     * The microphone of the pane's desktop started or stopped. The dot on the desktop shows only while the desktop
     * does; the microphone in Tabby's header (header.ts) shows whatever is in front, and over the window when there is
     * no header (full screen). The remote decides when it takes the microphone, so a capture that starts while its
     * desktop isn't in view (the console in front, its tab in the background, the window hidden) is also said in a note,
     * at most once a minute each time the desktop is opened.
     */
    private microphoneChanged (pane: DesktopPane, session: DesktopSession, mic: Microphone): void {
        session.overlay.classList.toggle('trd-mic-on', mic.capturing)
        this.changed$.next()
        if (mic.capturing && !this.inView(pane, session) && Date.now() - (this.microphoneNoted.get(session) ?? 0) > 60000) {
            this.microphoneNoted.set(session, Date.now())
            session.log.push('microphone: capturing while the desktop isn\'t in view')
            // What the plugin knows is that the desktop asked for the microphone and gets it, not what it does with it.
            this.zone.run(() => this.notifications.info(`${session.spec.name} is receiving your microphone, and that desktop isn't showing. ` +
                'A red microphone in Tabby\'s header (in full screen, at the top of the window) shows while it does: click it to show the ' +
                'desktop, or to stop sending the microphone there.'))
        }
    }

    /**
     * Whether the pane's desktop is in view: shown over its console, not behind a pane maximized over it (see
     * behindMaximized), in the active tab, in a window that isn't hidden.
     */
    private inView (pane: DesktopPane, session: DesktopSession): boolean {
        return session.visible && !this.behindMaximized(pane) && this.topTabOf(pane) === this.app.activeTab && document.visibilityState !== 'hidden'
    }

    /**
     * The certificates remembered for desktops and gateways (`remoteDesktop.trustedCertificates`), with how each was
     * trusted where that is known (see RememberedCertificate).
     */
    trustedCertificates (): { desktop: string, sha256: string, authority?: boolean }[] {
        const list = this.config.store.remoteDesktop?.trustedCertificates
        return (Array.isArray(list) ? list : [])
            .filter((e: any) => typeof e?.desktop === 'string' && typeof e?.sha256 === 'string')
            .map((e: any) => ({ desktop: e.desktop, sha256: normalizeFingerprint(e.sha256) || e.sha256, ...typeof e.authority === 'boolean' ? { authority: e.authority } : {} }))
    }

    /**
     * Forgets one remembered certificate (by session key). The next connection asks about the one it meets (a desktop
     * connected to directly, a gateway), unless an authority vouches for it; one behind an SSH host remembers it.
     */
    forgetCertificate (key: string): void {
        const store = this.config.store.remoteDesktop
        store.trustedCertificates = (Array.isArray(store.trustedCertificates) ? store.trustedCertificates : []).filter((e: any) => e?.desktop !== key)
        // What else was decided about that server goes with it: it is asked again.
        store.withoutNla = (Array.isArray(store.withoutNla) ? store.withoutNla : []).filter((e: any) => e?.desktop !== key)
        this.config.save()
        this.changed$.next()
    }

    /**
     * Whether the desktop was allowed to sign in without Network Level Authentication (see refusedWithoutNla) with the
     * certificate remembered for it now.
     */
    signsInWithoutNla (key: string): boolean {
        const allowed = this.withoutNlaCertificate(key)
        return !!allowed && allowed === this.trustedCertificates().find(e => e.desktop === key)?.sha256
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

    /**
     * Whether the pane's desktop gets what is pasted or typed into all desktops of its tab: connected, taking input, and
     * showing. One whose console is in front doesn't: nothing on screen would say that it gets them (its label is on its
     * hidden layer), and the pane shows a terminal. Nor does one behind a pane maximized over it (see behindMaximized).
     */
    private takesAll (pane: DesktopPane, session: DesktopSession | undefined): boolean {
        return !!session && session.state === 'connected' && !session.viewOnly && !!session.ui && session.visible && !this.behindMaximized(pane)
    }

    /** How many desktops in the pane's tab would get a paste or typing (itself included), when that's more than one. */
    desktopsInTab (pane: DesktopPane): number {
        return this.othersInTab(pane).filter(other => this.takesAll(other.pane, other.session)).length + (this.takesAll(pane, this.sessions.get(pane)) ? 1 : 0)
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
        if (!on && this.broadcast.has(split)) {
            // The keyups of keys held right now (the shortcut's own modifiers) won't be copied any more.
            this.othersInTab(pane).forEach(other => other.session.releaseKeys())
        }
        on ? this.broadcast.add(split) : this.broadcast.delete(split)
        for (const p of split.getAllTabs()) {
            const session = this.sessions.get(p as DesktopPane)
            session?.overlay.classList.toggle('trd-broadcast-on', on)
            session?.log.push(`typing into all desktops: ${on ? 'on' : 'off'}`)
        }
        this.changed$.next()
    }

    /**
     * A key the pane's desktop was sent (see DesktopKeyboard): noted as held there or let go, and copied to the other
     * desktops of a tab typing into all.
     */
    broadcastKey (pane: DesktopPane, type: string, init: KeyboardEventInit): void {
        this.sessions.get(pane)?.noteKey(type, init)
        if (!this.isBroadcast(pane)) {
            return
        }
        for (const { pane: other, session } of this.othersInTab(pane)) {
            // Only to the desktops showing (see takesAll). A key let go goes wherever it went down, so that none stays
            // held on a desktop hidden since.
            if (!this.takesAll(other, session) && !(type === 'keyup' && init.code && session.keysDown.has(init.code))) {
                continue
            }
            try {
                session.ui.sendKeyboardEvent(new KeyboardEvent(type, { ...init, cancelable: true }))
                session.noteKey(type, init)
            } catch (e: any) {
                session.log.push(`typing into all desktops: ${e?.message ?? e}`)
            }
        }
    }

    /**
     * Pastes on every connected desktop in the pane's tab: files copied here are offered to each first (see
     * FileTransfer.pasteClipboardFiles); text and pictures are sent to each, since only the desktop with the focus
     * follows this computer's clipboard on its own. Then Ctrl+V on each, in whatever window is active there. Only the
     * desktops showing get it (see takesAll). Those that don't take this computer's clipboard are left out, Ctrl+V
     * included (it would paste something else there), and the pane says which.
     */
    pasteToAll (pane: DesktopPane): number {
        const all = [...this.sessions.get(pane) ? [{ pane, session: this.sessions.get(pane)! }] : [], ...this.othersInTab(pane)]
            .filter(({ pane: into, session }) => this.takesAll(into, session))
        const { targets, left, note } = splitPaste(all, ({ session }) => this.clipboardWaysOf(session), ({ session }) => session.spec.name)
        if (note) {
            left.forEach(({ session }) => session.log.push('paste to all desktops: left out: this computer\'s clipboard doesn\'t go to this desktop'))
            const own = this.sessions.get(pane)
            if (own?.visible && own.files) {
                own.files.toast(note)
            } else {
                this.notifications.info(note)
            }
        }
        for (const { pane: into, session } of targets) {
            // Each pastes once it has taken in the new clipboard, however long that takes it.
            const offered = session.files?.pasteClipboardFiles() ?? false
            // Taken with nothing it could send (see FileTransfer.pasteClipboardFiles, which logs why): the remote
            // wasn't asked, and didn't refuse anything.
            const nothing = offered && session.files!.nothingOffered
            ;(offered ? session.files!.offerAnswered() : this.sendClipboard(session)).then(ok => {
                if (!ok) {
                    session.log.push(nothing ? 'paste to all desktops: no Ctrl+V: none of the files copied here could be sent'
                        : `paste to all desktops: the remote refused the ${offered ? 'files' : 'clipboard'}`)
                    return
                }
                // That can take seconds. Ctrl+V goes only if the desktop still takes a paste from here: not once the
                // clipboard narrowed for it, or it went view only, out of sight or away meanwhile (`visible` stays true
                // in a tab in the background, which isn't in view).
                if (this.sessions.get(into) !== session || !this.takesAll(into, session) || !this.inView(into, session) || !this.clipboardWaysOf(session).toRemote) {
                    session.log.push('paste to all desktops: no Ctrl+V: the desktop stopped taking a paste from here meanwhile')
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
        // Not where it doesn't go (pasteToAll leaves those desktops out before this).
        if (!this.clipboardWaysOf(session).toRemote) {
            return false
        }
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
        let level = 'INFO'
        try { level = localStorage.getItem('trdLogLevel') || level } catch { }
        return this.ironrdp.create(level)
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
            const endpoint = await this.setUp(pane, target)
            this.ownDesktops.set(target.key, { kind: endpoint.kind, xrdpPort: endpoint.xrdpPort, xrdpUser: endpoint.xrdpUser })
            endpoint.notes?.forEach(note => session.log.push(`setup: ${note}`))
            // Only the setup knows which desktop the host has; the session follows it (graphics, sign-in, resizing). It is
            // the host's word about itself, which spares no question (see DesktopSpec.kindTrusted).
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
                        gnome = await this.setUp(pane, target, true)
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
        // A Hyper-V VM's console: which session the guest takes right now (enhanced once its Remote Desktop Services
        // are up, the basic console before that and for guests that have none). The sign-in is the host's.
        let hyperv: Endpoint['hyperv']
        if (spec.hyperv) {
            session.status(`Connecting to ${spec.name} via ${target.label}…`)
            const state = await hyperVState(target, spec.hyperv)
            if (!state.running) {
                throw new Error(`${spec.name} isn't running`)
            }
            hyperv = state.enhanced ? 'enhanced' : 'basic'
            session.log.push(`hyper-v: ${hyperv === 'enhanced' ? 'an enhanced session' : 'the basic console (the guest takes no enhanced session now)'}`)
            // The SSH user is who to try first: it got to list the VMs.
            spec.username ??= keyUser(target.key) || undefined
        }
        // A saved account (Settings): its user name, and its password from the keychain. One that has none yet, or that
        // this desktop just refused, is asked for here and saved for every desktop that uses the account.
        const account = spec.account ? this.accounts().find(a => a.id === spec.account) : undefined
        if (spec.account && !account) {
            session.log.push('sign-in: its saved account no longer exists; asking')
        }
        const again = this.askAgain.delete(pane)
        // A desktop whose account is gone asks, rather than falling back to a login of its own saved earlier.
        let saved = retryError || again || spec.account && !account ? null : await loadCredentials(account ? accountKey(account.id) : session.credentialKey)
        if (saved && account && saved.username !== signInName(account)) {
            // Kept for an earlier user name of the account (its change didn't reach the store): not this one's.
            session.log.push(`sign-in: the account's saved password is for ${saved.username}, not ${signInName(account)}; asking`)
            saved = null
        }
        if (saved) {
            if (account) {
                session.log.push(`sign-in: the saved account "${account.name}"`)
            }
            return { host: spec.host, port: spec.port, credentials: account ? { username: signInName(account), password: saved.password } : saved, remember: false, domain: account ? account.domain ?? '' : undefined, hyperv }
        }
        session.status('')
        const mark = forgetMark()
        const accountRevision = account && this.accountRevisions.capture(account)
        // The host's own desktops (its own, or its xrdp besides GNOME) and direct ones need no "via". A machine reached
        // with ssh typed in a host's console says which host: that host is what leads there.
        const hostOwn = spec.id === OWN_DESKTOP || spec.kind === 'xrdp' && spec.host === '127.0.0.1'
        const via = !target.via ? target.label : hostOwn ? target.via : `${target.label}, through ${target.via}`
        const asked = askCredentials(session.overlay, {
            title: spec.hyperv ? `Sign in to ${target.label}${target.via ? ` (via ${target.via})` : ''}, to open ${spec.name}`
                : hostOwn && !target.via || target.direct ? `Sign in to ${spec.name}` : `Sign in to ${spec.name} (via ${via})`,
            username: account ? signInName(account) : spec.username,
            error: [retryError, account && accountRevision === undefined ? ACCOUNT_REMEMBER_UNAVAILABLE : ''].filter(Boolean).join(' '),
            canRemember: !account || accountRevision !== undefined,
            account: account?.name,
        }, session.disposed)
        // Only in the pane in front, as when connected (see run()): the form gets the keyboard when its pane does.
        if (session.visible && this.inFront(pane)) {
            setTimeout(() => session.visible && this.showsInFront(session) && session.focusDesktop())
        }
        const entered = await asked
        return entered && {
            host: spec.host, port: spec.port, credentials: entered, remember: entered.remember, domain: account ? account.domain ?? '' : undefined,
            saveKey: account && accountKey(account.id), saveLabel: account && `saved account ${account.name}`, saveFor: account && signInName(account),
            hyperv, mark, accountRevision,
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
        let gatewayError: string | undefined
        try {
            const gateway = spec.gateway ? parseGateway(spec.gateway) : null
            if (spec.gateway && !gateway) {
                throw new Error(`"${spec.gateway}" isn't a gateway's address (a name or address, or name:port)`)
            }
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
                // A gateway with a saved account of its own: its password, asked for when there is none or it was refused.
                if (gateway && spec.gatewayAccount && !asked.gatewayAccount) {
                    const signIn = await this.gatewayAccountFor(spec, session, gateway, gatewayError)
                    if (!alive()) {
                        return
                    }
                    if (signIn === null) {
                        session.state = 'ended'
                        this.changed$.next()
                        this.cancelReconnect(pane)
                        session.status('Sign-in cancelled.', [{ label: 'Sign in', run: () => this.reopen(pane, spec) }])
                        return
                    }
                    asked.gatewayAccount = signIn
                }
                // The proxy outlives an attempt: it reads the sign-in of the attempt it serves.
                if (!session.proxy) {
                    const proxy = await startRDCleanPathProxy(
                        (_destination, signal) => gateway ? this.throughGateway(target, spec, session, gateway, endpoint!, signal) : target.openTcp(asked.host, asked.port),
                        (fingerprint, valid, reason, details) => this.checkCertificate(session, fingerprint, valid, reason, details),
                        m => session.log.push(m),
                        {
                            autologon: spec.kind === 'xrdp',
                            withoutNla: () => this.checkWithoutNla(session),
                            // Let through before TLS: the permission is held to the certificate the server then shows.
                            withoutNlaCertificate: fingerprint => this.holdWithoutNla(session, fingerprint),
                            // A desktop connected to directly is checked against its name and this computer's
                            // certificate authorities (see checkTrusted). One behind an SSH host goes by that host's
                            // names, which its certificate can't be checked against: trusted on first use.
                            serverName: target.direct ? serverNameOf(asked.host) : undefined,
                        })
                    // The desktop was closed while the proxy started: closing it found no proxy, and nothing else would.
                    if (!alive()) {
                        proxy.close()
                        return
                    }
                    session.proxy = proxy
                }
                const outcome = await this.run(pane, target, spec, session, rdp, asked)
                if (outcome.certificate && alive()) {
                    // A changed certificate, now trusted: the same account again, without asking for it again.
                    if (await this.refusedCertificate(pane, target, spec, session, asked, outcome.certificate)) {
                        continue
                    }
                    return
                }
                if (outcome.withoutNla && alive()) {
                    // Allowed now: the same account again, without asking for it again.
                    if (await this.refusedWithoutNla(pane, target, spec, session)) {
                        continue
                    }
                    return
                }
                if (outcome.gatewayRefused && asked.gatewayAccount && attempt < 5 && alive()) {
                    // The gateway's own account was refused: asked for again, the desktop's sign-in kept.
                    gatewayError = outcome.signInFailed
                    asked.gatewayAccount = undefined
                    continue
                }
                if (outcome.signInFailed && this.signsIn(spec) && attempt < 5 && alive()) {
                    // The desktop's own saved account goes. A shared one stays until a new password is entered: this
                    // desktop refusing it doesn't make it wrong for the others.
                    await forgetCredentials(session.credentialKey)
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
     * The sign-in to a desktop's RD Gateway with the saved account it names: the account's password from the keychain,
     * or asked for (when none is saved, or `retryError`: the gateway just refused it). Undefined when that account no
     * longer exists (the desktop's own sign-in is then tried); null when the form was cancelled.
     */
    private async gatewayAccountFor (spec: DesktopSpec, session: DesktopSession, gateway: Gateway, retryError?: string): Promise<GatewaySignIn | undefined | null> {
        const account = this.accounts().find(a => a.id === spec.gatewayAccount)
        if (!account) {
            session.log.push('gateway: its saved account no longer exists; signing in with the desktop\'s')
            return undefined
        }
        const signIn = { domain: account.domain, saveKey: accountKey(account.id), saveLabel: `saved account ${account.name}`, saveFor: signInName(account), accountRevision: this.accountRevisions.capture(account) }
        const saved = retryError ? null : await loadCredentials(signIn.saveKey)
        if (saved && saved.username === signInName(account)) {
            session.log.push(`gateway: the saved account "${account.name}"`)
            return { ...signIn, credentials: { username: signInName(account), password: saved.password }, remember: false }
        }
        session.status('')
        const asked = askCredentials(session.overlay, {
            title: `Sign in to the gateway ${gateway.host}, to reach ${spec.name}`,
            username: signInName(account),
            error: [retryError, signIn.accountRevision === undefined ? ACCOUNT_REMEMBER_UNAVAILABLE : ''].filter(Boolean).join(' '),
            canRemember: signIn.accountRevision !== undefined,
            account: account.name,
        }, session.disposed)
        // Only in the pane in front (see endpointFor).
        if (session.visible && this.showsInFront(session)) {
            setTimeout(() => session.visible && this.showsInFront(session) && session.focusDesktop())
        }
        const entered = await asked
        return entered && { ...signIn, credentials: entered, remember: entered.remember }
    }

    /**
     * The proxy's stream to a desktop behind an RD Gateway (see gateway.ts): to the gateway as the SSH host (or this
     * computer) reaches it, signed in with the gateway's own account or else the desktop's, then on to the desktop.
     */
    private async throughGateway (target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, gateway: Gateway, endpoint: Endpoint, signal?: AbortSignal): Promise<Duplex> {
        session.gatewayRefused = null
        const own = endpoint.gatewayAccount
        const credentials = own?.credentials ?? endpoint.credentials
        session.log.push(`gateway: ${gateway.host}:${gateway.port}, signing in with ${own ? 'its saved account' : 'the desktop\'s sign-in'}`)
        try {
            const stream = await openThroughGateway(
                () => target.openTcp(gateway.host, gateway.port), gateway,
                { username: credentials.username, password: credentials.password, domain: (own ? own.domain : endpoint.domain ?? spec.domain) || undefined },
                { host: endpoint.host, port: endpoint.port },
                (fingerprint, valid, reason, details) => this.checkGatewayCertificate(session, gateway, fingerprint, valid, reason, details),
                { log: m => session.log.push(m), clientName: os.hostname(), signal })
            // Entered a moment ago and taken by the gateway: kept, while the account is still what it was signed in as.
            if (own?.remember) {
                own.remember = false
                saveCredentialsIf(own.saveKey, own.credentials,
                    () => this.accountCurrent(own.saveKey, own.saveFor, own.accountRevision), own.saveLabel).then(
                    saved => session.log.push(saved ? `gateway: saved as the account's password in ${storeName()}` : 'gateway: not saved: the account changed meanwhile'),
                    e => session.log.push(`gateway: ${storeName()}: ${e?.message ?? e}`))
            }
            return stream
        } catch (e: any) {
            if (e instanceof GatewaySignInError) {
                session.gatewayRefused = e.message
            }
            throw e
        }
    }

    /**
     * A gateway's certificate, before the sign-in goes to it. The sign-in reaches the gateway as a proof of the
     * password, one that can be cracked offline, so a gateway is not trusted silently the way a desktop behind a host
     * is: it is checked as a desktop connected to directly is (see checkTrusted), by the gateway's address, whether the
     * gateway is reached from here or from an SSH host.
     */
    private checkGatewayCertificate (session: DesktopSession, gateway: Gateway, raw: string, valid: boolean, reason = '', details?: CertificateDetails): void {
        const key = `gateway#${gateway.host}:${gateway.port}`
        this.checkTrusted(session, key, normalizeFingerprint(raw), valid, reason, gateway.host, { address: formatAddress(gateway.host, gateway.port), key }, details)
    }

    /**
     * The certificate of a server whose name an authority can vouch for: a desktop connected to directly, an RD
     * Gateway. One valid for that name by this computer's certificate authorities connects without asking, and is
     * remembered as such. Any other is asked about the first time, with why it isn't valid and its fingerprint, before
     * anything goes to the server, and is remembered once trusted (refusedCertificate). Once remembered, the same
     * certificate connects, unless an authority's word is all that remembered it and no longer holds (it has expired,
     * or the authority is gone from this computer's store): nobody confirmed it, so it is asked about as a first use. A
     * different one: where an authority vouched for the one before, another it vouches for replaces it (a renewal,
     * logged); one the user trusted stops the connection whatever replaces it, as does any replacement that isn't
     * valid. Throws, with the problem on the session, to stop and ask. What a certificate says of itself (`details`)
     * goes to the log whenever it isn't the one remembered, and with the problem to the question.
     */
    private checkTrusted (
        session: DesktopSession, key: string, fingerprint: string, valid: boolean, reason: string, name: string, gateway?: { address: string, key: string },
        details?: CertificateDetails,
    ): void {
        const what = gateway ? 'gateway certificate' : 'certificate'
        const known = this.trustedCertificate(key)
        // Remembered before the two were told apart: a gateway's on an authority's word whatever came before, a
        // desktop's held to the one remembered. Each keeps the rule it was checked by.
        const byAuthority = known?.authority ?? key.startsWith('gateway#')
        // Remembered on an authority's word, which no longer holds: the same certificate, but the user never confirmed
        // it. One the user trusted (`authority` false) and one from before the two were told apart connect on their
        // fingerprint, as they were remembered.
        const lapsed = known?.sha256 === fingerprint && known.authority === true && !valid
        if (known && fingerprint === known.sha256 && !lapsed) {
            if (valid && known.authority === undefined) {
                // One remembered before, unasked, that an authority vouches for: from here on, a renewal by one goes
                // through too, as it would for this certificate met for the first time now. One the user trusted stays
                // the user's: a different one is asked about, whatever vouches for it.
                this.trustCertificate(key, fingerprint, true)
            }
            session.log.push(`${what}: SHA-256 ${fingerprint}, as remembered${valid ? `, valid for ${name}` : ''}`)
            return
        }
        if (lapsed) {
            session.log.push(`${what}: SHA-256 ${fingerprint}, as remembered, but no longer valid for ${name}: ${reason || 'unchecked'}`)
        }
        if (details) {
            session.log.push(`${what}: ${describeCertificate(details, !vouched(valid, details))}`)
        }
        if (valid && (!known || byAuthority)) {
            this.trustCertificate(key, fingerprint, true)
            session.log.push(`${what}: SHA-256 ${fingerprint}, valid for ${name}${known ? `, in place of ${known.sha256} (renewed)` : ', remembered'}`)
            return
        }
        // `expected` empty marks a first use rather than a change (see refusedCertificate), also for a remembered
        // certificate that no longer holds.
        const replaced = lapsed ? null : known
        const replaces = !replaced || byAuthority ? {} : { replaces: replaced.authority === false ? 'yours' as const : 'first use' as const }
        session.certificateProblem = {
            expected: replaced?.sha256 ?? '', actual: fingerprint, pinned: false, valid, name, reason, ...replaces, ...gateway ? { gateway } : {}, ...details ? { details } : {},
        }
        const whose = gateway ? 'the gateway\'s certificate' : 'certificate'
        throw new Error(replaced
            ? `${whose} SHA-256 ${fingerprint} is not the one remembered (${replaced.sha256})`
            : `${whose} SHA-256 ${fingerprint} can't be verified (${reason || 'unchecked'}), and ${lapsed ? 'was remembered on an authority\'s word, which no longer holds' : 'hasn\'t been seen before'}`)
    }

    /**
     * The certificate a desktop was allowed to sign in without Network Level Authentication with, or null
     * (`remoteDesktop.withoutNla`, by session key: see holdWithoutNla). An entry without one isn't a permission: such a
     * desktop asks again. Only development builds wrote those; 0.5.0 never saved the permission (`withoutNla` was
     * missing from its defaults, so Tabby didn't write it).
     */
    private withoutNlaCertificate (key: string): string | null {
        const list = this.config.store.remoteDesktop?.withoutNla
        const value = (Array.isArray(list) ? list : []).find((e: any) => e?.desktop === key)?.sha256
        return typeof value === 'string' ? normalizeFingerprint(value) || null : null
    }

    /** Whether a desktop was allowed to sign in without Network Level Authentication (see withoutNlaCertificate). */
    private allowedWithoutNla (key: string): boolean {
        return !!this.withoutNlaCertificate(key)
    }

    /**
     * The proxy found a server that doesn't use Network Level Authentication: the password would go to it as it is,
     * before the server has shown anything but a certificate. That is how xrdp signs in, so a desktop the user made an
     * xrdp one goes on (see xrdpUnasked). A Windows machine or GNOME Remote Desktop always uses it unless it was turned
     * off, and something posing as one (the address in a file someone sent), or as an xrdp desktop a host offers or
     * says it has itself, doesn't: those stop here, until the desktop is allowed (refusedWithoutNla). One that was goes
     * on to TLS, where the permission is held to the certificate it was given with (holdWithoutNla).
     */
    private checkWithoutNla (session: DesktopSession): void {
        if (xrdpUnasked(session.spec)) {
            session.plainSignIn = true
            return
        }
        if (session.sendAnyway || this.allowedWithoutNla(session.authKey)) {
            session.log.push('sign-in: without Network Level Authentication, as allowed for this desktop')
            session.plainSignIn = true
            return
        }
        session.withoutNla = true
        throw new Error('the server doesn\'t use Network Level Authentication')
    }

    /**
     * After the certificate check, for a server that doesn't use Network Level Authentication (checkWithoutNla let it on
     * to TLS; the proxy's withoutNlaCertificate): the permission to send it the password is for the server with one
     * certificate. Given just now, it is remembered with this one; one remembered holds only for the certificate it was
     * given with. Anything else (a permission taken back meanwhile, by another connection of the desktop that trusted a
     * new certificate) stops here, before the client hears back and so before the password goes, and asks again.
     */
    private holdWithoutNla (session: DesktopSession, fingerprint: string): void {
        if (xrdpUnasked(session.spec)) {
            return
        }
        if (session.sendAnyway) {
            session.sendAnyway = false
            const store = this.config.store.remoteDesktop
            store.withoutNla = [...(Array.isArray(store.withoutNla) ? store.withoutNla : []).filter((e: any) => e?.desktop !== session.authKey), { desktop: session.authKey, sha256: fingerprint }]
            this.config.save()
            session.log.push(`sign-in: allowed without Network Level Authentication for certificate SHA-256 ${fingerprint}`)
            return
        }
        if (this.withoutNlaCertificate(session.authKey) === fingerprint) {
            return
        }
        session.withoutNla = true
        throw new Error('the server doesn\'t use Network Level Authentication, and wasn\'t allowed to sign in without it with this certificate')
    }

    /**
     * After the proxy stopped at a server without Network Level Authentication; nothing but the connection request
     * (without the user name: see withoutUserCookie) was sent to it, or, where it stopped after the certificate check
     * (see holdWithoutNla), the TLS handshake. Says what going on would mean and asks; automatic reconnecting stops
     * here. Resolves true to connect again: the server that answers then may have the password, and the permission is
     * remembered with its certificate (see holdWithoutNla).
     */
    private async refusedWithoutNla (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession): Promise<boolean> {
        this.cancelReconnect(pane)
        const alive = () => this.sessions.get(pane) === session
        session.log.push('sign-in: the server doesn\'t use Network Level Authentication; asking before the password goes to it')
        // A note that stays a while (notice() is gone in a second): the question waits unseen until the user goes
        // there.
        if (!this.inView(pane, session)) {
            this.notifications.info(`${spec.name}${target.direct ? '' : ` (via ${target.label})`} would get your password as it is. Open that desktop to decide.`)
        }
        // An xrdp desktop asks only where that it is xrdp is a host's word (see xrdpUnasked): a VM the host found, the
        // host's own desktop, a machine reached through it. Only a desktop the user configured has a kind to set: a VM
        // saved from the host's list (kindTrusted false, see xrdpFromHost) is told how.
        const why = spec.kind === 'xrdp'
            ? `xrdp signs in this way by design. That ${spec.name} is xrdp is what ${target.via ?? target.label} reported, not a ` +
                `setting of yours: send the password if you know it is${spec.kindTrusted === false ? ', or pick its kind in its edit form, which makes it one' : ''}.`
            : 'A Windows machine asks for Network Level Authentication unless that was turned off on it. A server posing as one doesn\'t' +
                (spec.kindTrusted && spec.id !== OWN_DESKTOP ? `, and neither does xrdp: if ${spec.name} is an xrdp server, set its kind to xrdp instead.` : '.')
        const allowed = await new Promise<boolean>(resolve => {
            session.status(`${spec.name} doesn't use Network Level Authentication, so your password would be sent to it as it is: ` +
                `encrypted on the way, but readable to whatever answered there, before it has proved anything. Your password hasn't been sent.\n\n${why}`, [
                { label: 'Send the password anyway', run: () => resolve(true) },
                // What Enter picks, as for the certificate questions: sending the password is the risk.
                { label: 'Cancel', run: () => resolve(false), default: true },
            ], true)
            session.disposed.then(() => resolve(false))
        })
        if (!alive()) {
            return false
        }
        if (!allowed) {
            session.state = 'ended'
            this.changed$.next()
            session.status('Not connected: the password was not sent.', [{ label: 'Try again', run: () => this.reopen(pane, spec) }], true)
            return false
        }
        // Not remembered yet: the permission goes with a certificate, which the next attempt's server shows.
        session.sendAnyway = true
        return true
    }

    /**
     * The proxy's check of the server's certificate, before any credentials go out. The host's own desktop must show
     * the certificate its setup reported. A desktop connected to directly (a remote desktop tab's: a profile, quick
     * connect, an imported file, a restored tab) is checked against its name and this computer's certificate
     * authorities, and asked about the first time when they don't vouch for it (see checkTrusted): nothing else stands
     * between it and the network on the way. The others (behind a host, a Windows host's own) are trusted on first
     * use: remembered silently the first time (the way there runs inside SSH, which vouches for the host, and a prompt
     * on every new desktop would only teach clicking it away), and refused when it changes, until the new one is
     * trusted (see refusedCertificate). Remembered by session key, like saved accounts.
     */
    private checkCertificate (session: DesktopSession, fingerprint: string, valid = false, reason = '', details?: CertificateDetails): void {
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
        if (keyParts(session.authKey).target === DIRECT_KEY) {
            this.checkTrusted(session, session.authKey, fingerprint, valid, reason, serverNameOf(session.spec.host), undefined, details)
            return
        }
        const known = this.trustedCertificate(session.authKey)?.sha256
        if (details && fingerprint !== known) {
            session.log.push(`certificate: ${describeCertificate(details, !vouched(valid, details))}`)
        }
        if (!known) {
            this.trustCertificate(session.authKey, fingerprint)
            session.log.push(`certificate: SHA-256 ${fingerprint}, remembered (first connection)`)
            return
        }
        if (fingerprint !== known) {
            session.certificateProblem = { expected: known, actual: fingerprint, pinned: false, ...details ? { details } : {} }
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
     * After the proxy refused a certificate; nothing of the sign-in was sent to that server (only the connection request
     * and the TLS handshake). The host's own desktop: an error, since the plugin made that certificate itself. Others: a
     * first one (see checkTrusted) with why it can't be verified (see whyNotValid), its fingerprint and what it says of
     * itself (marked as its own word unless an authority vouched for it, see vouched), a changed one with both
     * fingerprints, to trust it or not; Cancel is what Enter picks. Either way, automatic reconnecting stops here.
     * Resolves true to connect again (the certificate is then trusted).
     */
    private async refusedCertificate (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, endpoint: Endpoint, problem: CertificateProblem): Promise<boolean> {
        this.cancelReconnect(pane)
        const alive = () => this.sessions.get(pane) === session
        const stop = (message: string) => {
            session.state = 'ended'
            this.changed$.next()
            session.status(message, [{ label: 'Try again', run: () => this.reopen(pane, spec) }], true)
        }
        if (problem.pinned) {
            const fingerprints = `Expected (SHA-256):\n${showFingerprint(problem.expected)}\n\nNow:\n${showFingerprint(problem.actual)}`
            stop(`The remote desktop on ${target.label} answered with a certificate other than the one set up for it. ` +
                `The connection was stopped before signing in.\n\n${fingerprints}\n\n` +
                `Something other than GNOME Remote Desktop may be listening on port ${endpoint.port}.`)
            return false
        }
        // The desktop's, or its gateway's. With nothing remembered (no expected fingerprint), a first use: a certificate
        // no authority vouches for, where the sign-in would go, confirmed rather than trusted silently (see checkTrusted).
        const whose = problem.gateway ? `${spec.name}'s gateway ${problem.gateway.address}` : spec.name
        const it = problem.gateway ? 'the gateway' : spec.name
        const via = target.direct ? '' : ` (via ${target.label})`
        // Named as the certificate was checked for them, as the .rdp import shows names: the desktop's as it resolves
        // (an international name as its punycode, see serverNameOf), its gateway in its one form (see parseGateway).
        const address = problem.gateway?.address ?? formatAddress(problem.name ?? spec.host, spec.port)
        const throughGateway = !problem.gateway && spec.gateway ? parseGateway(spec.gateway) : null
        const firstUse = !problem.expected
        // What the certificate says of itself, under its fingerprint (shown as the import shows a file's): an issuer
        // one wouldn't expect there (an authority that inspects the network's TLS) tells against it. Unless an
        // authority vouched for it (`valid`), or its chain leads to one this computer trusts (another machine's
        // certificate, which the names in it give away), all of it is the certificate's own word, which a certificate
        // anyone made can match, an organisation's own issuer included: the line says so, where the user decides.
        const about = problem.details ? `\n${describeCertificate(problem.details, !vouched(problem.valid, problem.details))}` : ''
        const fingerprints = firstUse
            ? `SHA-256:\n${showFingerprint(problem.actual)}${about}`
            : `Remembered (SHA-256):\n${showFingerprint(problem.expected)}\n\nNow:\n${showFingerprint(problem.actual)}${about}`
        // Also for a desktop showing in a tab that isn't in front: the question doesn't take the keyboard there (see
        // DesktopSession.status), and would wait unseen. A note that stays a while (notice() is gone in a second).
        if (!this.inView(pane, session)) {
            this.notifications.info(firstUse
                ? `${whose}${via} has a certificate this computer can't verify. Open that desktop to decide.`
                : `The certificate of ${whose}${via} has changed. Open that desktop to decide.`)
        }
        // Signing in without Network Level Authentication was allowed for the server with the old certificate, and goes
        // with it, as when that is forgotten (see forgetCertificate); so does an answer given just now, before this
        // certificate showed. A gateway's certificate has nothing to do with it.
        const plain = !problem.gateway && (session.sendAnyway || this.allowedWithoutNla(session.authKey))
        // Where an authority's word counts: why the certificate isn't valid, or, for one that wasn't remembered on an
        // authority's word replaced by one an authority vouches for, why that is asked about all the same.
        const why = problem.valid === false ? whyNotValid(problem.reason ?? '', problem.name ?? address, problem.details) : ''
        const verdict = problem.valid === undefined ? ''
            : problem.valid ? `The new one is valid for ${problem.name} by this computer's certificate authorities, but the one it replaces ` +
                `${problem.replaces === 'yours' ? 'is one you trusted yourself' : 'was remembered the first time it was seen, without that check'}. `
                : `The new one can't be verified: ${why}. `
        // What signing in gives the server: a proof of the password, with Network Level Authentication; without it (the
        // proxy let this attempt's server on without, see checkWithoutNla), the password itself. A gateway gets a proof.
        const gives = !problem.gateway && session.plainSignIn
            ? `This server doesn't use Network Level Authentication: signing in sends it your password itself, readable to a server posing as ${it}.`
            : `Signing in gives ${it} a proof of your password, which a server posing as ${it} could try to crack offline.`
        const trusted = await new Promise<boolean>(resolve => {
            // Nothing of the sign-in: the connection request and the TLS handshake have gone to the server by now.
            session.status(firstUse
                ? `${whose}${problem.gateway ? '' : ` (${address}${throughGateway ? `, through the gateway ${formatGateway(throughGateway)}` : ''})`} ` +
                    `has a certificate this computer can't verify: ${why}. Nothing of your sign-in has been sent to it yet` +
                    // The gateway on the way has had the sign-in already, as its own certificate allowed.
                    `${throughGateway ? '; only the gateway has had your sign-in' : ''}. ${gives}\n\n${fingerprints}\n\n` +
                    `Check this fingerprint with whoever runs ${it}, some other way than this connection, before you trust it. ` +
                    'Once trusted, it is remembered, and a different certificate there stops the connection again.'
                : `The certificate of ${whose} has changed since it was last used. Nothing of your sign-in has been sent to it.\n\n` +
                    `${fingerprints}\n\n${verdict}Reinstalling the machine or renewing its certificate changes it. If neither happened, ` +
                    `something else may be answering at ${address}.` +
                    (plain ? '\n\nIt was allowed to sign in without Network Level Authentication, which goes with the old certificate: ' +
                        'if the server still doesn\'t use it, you\'ll be asked again.'
                        // An xrdp desktop of the user's, which signs in that way unasked (see xrdpUnasked).
                        : !problem.gateway && session.plainSignIn ? `\n\n${gives}` : ''), [
                { label: firstUse ? 'Trust the certificate' : 'Trust the new certificate', run: () => resolve(true) },
                { label: 'Cancel', run: () => resolve(false), default: true },
            ], true)
            session.disposed.then(() => resolve(false))
        })
        if (!alive()) {
            return false
        }
        if (!trusted) {
            stop(firstUse ? 'Not connected: the certificate was not trusted.' : 'Not connected: the new certificate was not trusted.')
            return false
        }
        // Trusting a certificate never allows signing in without NLA. One allowed for a desktop whose first certificate
        // is trusted now was allowed before any certificate of it was seen (that stop comes first, before TLS), and stays.
        if (!problem.gateway && !firstUse) {
            const store = this.config.store.remoteDesktop
            store.withoutNla = (Array.isArray(store.withoutNla) ? store.withoutNla : []).filter((e: any) => e?.desktop !== session.authKey)
            session.sendAnyway = false
            if (plain) {
                session.log.push('sign-in: no longer allowed without Network Level Authentication: that was for the old certificate')
            }
        }
        // Where an authority's word counts, remembered as one the user trusted, or (a replacement it vouches for) as its.
        this.trustCertificate(problem.gateway?.key ?? session.authKey, problem.actual, problem.valid)
        session.log.push(`${problem.gateway ? 'gateway ' : ''}certificate: SHA-256 ${problem.actual}, ${firstUse ? 'trusted (first connection)' : `trusted instead of ${problem.expected}`}`)
        return true
    }

    /** The certificate remembered for a desktop or a gateway (`remoteDesktop.trustedCertificates`), if any. */
    private trustedCertificate (key: string): RememberedCertificate | null {
        const list = this.config.store.remoteDesktop?.trustedCertificates
        const entry = (Array.isArray(list) ? list : []).find((e: any) => e?.desktop === key)
        const sha256 = typeof entry?.sha256 === 'string' ? normalizeFingerprint(entry.sha256) : ''
        return sha256 ? { sha256, ...typeof entry.authority === 'boolean' ? { authority: entry.authority } : {} } : null
    }

    /** Remembers a server's certificate; `authority` as RememberedCertificate has it (none: trusted on first use). */
    private trustCertificate (key: string, fingerprint: string, authority?: boolean): void {
        const store = this.config.store.remoteDesktop
        const others = (Array.isArray(store.trustedCertificates) ? store.trustedCertificates : []).filter((e: any) => e?.desktop !== key)
        store.trustedCertificates = [...others, { desktop: key, sha256: fingerprint, ...authority === undefined ? {} : { authority } }]
        this.config.save()
    }

    /**
     * Forgets the certificates remembered for a desktop behind any SSH host (keys ending in `#<id>`, not a direct
     * one's `rdp#<id>`), or with `direct`, for that direct desktop; doesn't save.
     */
    forgetCertificatesFor (desktopId: string, direct = false): void {
        const store = this.config.store.remoteDesktop
        const list = Array.isArray(store.trustedCertificates) ? store.trustedCertificates : []
        // Anchored on the key's parts (see keyParts): a gateway pin or a desktop whose id is a suffix of this one's
        // keeps its certificate.
        const forget = (key: string) => {
            const { target, desktopId: id } = keyParts(key)
            return id === desktopId && (direct ? target === DIRECT_KEY : target !== DIRECT_KEY && target !== 'gateway')
        }
        // Keys as text only (String() of an object from the config can throw), as desktopEdited reads them.
        store.trustedCertificates = list.filter((e: any) => !(typeof e?.desktop === 'string' && forget(e.desktop)))
        store.withoutNla = (Array.isArray(store.withoutNla) ? store.withoutNla : []).filter((e: any) => !(typeof e?.desktop === 'string' && forget(e.desktop)))
    }

    /**
     * For a desktop with `wake`: when its RDP server doesn't answer (probed from the SSH host), starts it and waits
     * until it does. True when it had to be started, false when it was up, null when the wait was cancelled (the layer
     * says so). Throws when it couldn't be started, didn't come up in time, or is down during an automatic reconnect.
     */
    private async wakeIfDown (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, automatic: boolean): Promise<boolean | null> {
        const alive = () => this.sessions.get(pane) === session
        session.status(`Connecting to ${spec.name} via ${target.label}…`)
        if (await desktopUp(target, spec.host, spec.port, spec.wake)) {
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
        const up = await this.zone.runOutsideAngular(() => waitForRdp(target, spec.host, spec.port, WAKE_TIMEOUT_MS, () => cancelled || !alive(), progress, spec.wake))
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
    ): Promise<{ connected: boolean, signInFailed?: string, gatewayRefused?: boolean, withoutNla?: boolean, error?: string, reason?: string, certificate?: CertificateProblem }> {
        const attempt = new AbortController()
        let unwatch: (() => void) | undefined
        const trapped = new Promise<{ connected: boolean, error: string }>(resolve => {
            unwatch = rdp.runtime?.onTrap((error: Error) => {
                session.log.push(`wasm: this desktop's instance trapped: ${error.message}`)
                // Drop the socket even if Rust's run() promise can no longer settle after a trap.
                session.proxy?.close()
                session.proxy = null
                resolve({ connected: session.state === 'connected', error: `WebAssembly instance failed: ${error.message}` })
            })
        })
        try {
            return await Promise.race([
                this.runConnection(pane, target, spec, session, rdp, endpoint, attempt.signal),
                trapped,
                session.disposed.then(() => ({ connected: false })),
            ])
        } finally {
            attempt.abort()
            unwatch?.()
            session.endConnection?.()
        }
    }

    private async runConnection (
        pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, rdp: any, endpoint: Endpoint, signal: AbortSignal,
    ): Promise<{ connected: boolean, signInFailed?: string, gatewayRefused?: boolean, withoutNla?: boolean, error?: string, reason?: string, certificate?: CertificateProblem }> {
        const credentials = endpoint.credentials
        const alive = () => !signal.aborted && this.sessions.get(pane) === session
        session.certificateProblem = null
        session.gatewayRefused = null
        session.withoutNla = false
        session.plainSignIn = false
        const el = document.createElement('iron-remote-desktop') as any
        try {
            el.setAttribute('scale', this.screenScale() === 3 ? 'real' : 'fit')
            el.setAttribute('flexcenter', 'true')
            el.module = rdp.Backend
            const ready = new Promise<any>(resolve => el.addEventListener('ready', (e: CustomEvent) => resolve(e.detail.irgUserInteraction), { once: true }))
            session.host.replaceChildren(el)
            // The element only gets ready in the page: one whose desktop was closed meanwhile (the layer gone) never does.
            // Closed as it got ready, it isn't given the clipboard, files and the rest that closing it has ended already.
            session.ui = await Promise.race([ready, session.disposed.then(() => null), new Promise<null>(resolve => {
                signal.addEventListener('abort', () => resolve(null), { once: true })
            })])
            if (!session.ui || !alive()) {
                return { connected: false }
            }
            // Files through the clipboard: registered before connecting, which sets up its channel messages. The
            // clipboard goes only the ways the settings let it, as they are now, for this connection (see clipboard.ts).
            session.files?.dispose()
            // What it reads for the remote waits for room in the connection (see ServerFlow).
            session.files = new FileTransfer(rdp, session.overlay, m => session.log.push(m), () => this.clipboardWaysOf(session), session.proxy ?? undefined)
            const clipboard = setUpClipboard(session.ui, session.files.provider, this.settingsFor(session).clipboard, () => this.clipboardWaysOf(session).toRemote)
            session.clipboard = clipboard.mode
            session.stopSending = clipboard.stopSending
            session.log.push(`clipboard: ${clipboard.mode === 'both' ? 'both ways'
                : clipboard.mode === 'fromRemote' ? 'only from the remote desktop (this computer\'s is neither read nor sent)' : 'off (no clipboard channel)'}`)
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
                // The name the server is signed in to as: the SSH host's for its own desktop, and for its VMs' consoles.
                .withDestination(`${spec.id === OWN_DESKTOP || spec.hyperv ? target.hostname ?? target.label : endpoint.host}:${endpoint.port}`)
                .withProxyAddress(session.proxy!.url)
                .withServerDomain(domain)
                .withAuthToken(session.proxy!.token)
                .withDesktopSize({ width, height })
                // Display control lets the remote monitor follow the pane (live resize, remote scaling).
                .withExtension(rdp.displayControl(true))
            // H.264 in the graphics pipeline, decoded by the browser (hardware-accelerated where it can be). A decoder
            // failure ends the connection, which then reconnects without H.264 (see below). Not for xrdp: it encodes
            // H.264 only in some builds, and without it bitmaps do better there than the pipeline.
            // A Hyper-V VM's console: the VM's id goes ahead of everything, and the sign-in (the host's) before the RDP
            // handshake. Its basic console is a picture, keyboard and mouse: no channels for sound, files or resizing.
            const basic = endpoint.hyperv === 'basic'
            if (spec.hyperv) {
                if (typeof rdp.vmConnect !== 'function') {
                    throw new Error('this build of IronRDP has no Hyper-V console support')
                }
                config.withExtension(rdp.vmConnect(spec.hyperv, endpoint.hyperv ?? 'basic'))
            }
            session.h264?.close()
            session.h264 = null
            const h264 = spec.kind !== 'xrdp' && !basic && typeof rdp.graphicsPipeline === 'function' && await this.useH264(rdp, session, settings)
            // Asking the browser about H.264 can take a moment, the first time: a desktop closed meanwhile gets no decoder,
            // sound, microphone or drives, which nothing would close.
            if (!alive()) {
                return { connected: false }
            }
            if (h264) {
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
            if (settings.sound && !basic) {
                session.audio?.close()
                session.audio = new AudioPlayer()
                config.withExtension(rdp.audioPlayback(session.audio.callback))
            }
            session.mic?.close()
            session.mic = null
            // The setting as it is now: `settings` was read before the wait for H.264 above, and turned off meanwhile it
            // found no microphone here to stop (see applyMicrophone).
            if (this.settings().microphone && !basic && typeof rdp.audioInput === 'function') {
                const ui = session.ui
                const mic: Microphone = new Microphone(
                    pcm => ui.invokeExtension(rdp.audioInputData(pcm)),
                    () => this.microphoneChanged(pane, session, mic),
                    m => session.log.push(m),
                    m => this.zone.run(() => this.notifications.error(m)),
                )
                // Stopped for this desktop, also on this connection, which its server may have brought about by ending
                // the last one. The remote can still open the microphone, and gets nothing until it is turned back on.
                if (this.microphoneStopped.has(session.key)) {
                    mic.turnOff()
                }
                session.mic = mic
                config.withExtension(rdp.audioInput(mic.callback))
            }
            // Shared folders as drives (\\tsclient\<name>). GNOME Remote Desktop doesn't serve drives; Windows and xrdp
            // do. Also skipped with no folder shared: the server then sees no drive device at all.
            session.drives?.dispose()
            session.drives = null
            const folders = this.sharedFolders()
            if (folders.length && spec.kind !== 'gnome' && !basic && typeof rdp.driveRedirection === 'function') {
                session.drives = new SharedDrives(folders, m => session.log.push(m), session.proxy ?? undefined)
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
                // The proxy stopped at a server that would get the password as it is (see checkWithoutNla).
                if (session.withoutNla) {
                    return { connected: false, withoutNla: true }
                }
                // Its gateway refused the sign-in, before anything went to the desktop.
                if (session.gatewayRefused) {
                    session.log.push(`gateway: ${session.gatewayRefused}`)
                    return { connected: false, signInFailed: session.gatewayRefused, gatewayRefused: true }
                }
                // IronErrorKind: 1 WrongPassword, 2 LogonFailure.
                const kind = typeof e?.kind === 'function' ? e.kind() : undefined
                // Not the proxy's token, which is in the address IronRDP names when it can't connect there.
                const detail = withoutToken(typeof e?.backtrace === 'function' ? e.backtrace() : (e?.message ?? String(e)), session.proxy)
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
            this.applyKeyboardMode(session)
            session.remoteSize = { width, height, scale: 100 }
            if (!basic && (size.scale !== 100 || spec.kind === 'windows')) {
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
            // Under a saved account only while that account is still there with the same sign-in name: the prompt may
            // have been open while it was removed or changed in Settings.
            if (endpoint.remember && endpoint.saveKey) {
                const key = endpoint.saveKey
                saveCredentialsIf(key, credentials, () => this.accountCurrent(key, endpoint.saveFor, endpoint.accountRevision), endpoint.saveLabel).then(
                    saved => session.log.push(saved ? `sign-in: saved as the account's password in ${storeName()}` : 'sign-in: not saved: the account changed meanwhile'),
                    e => session.log.push(`sign-in: ${storeName()}: ${e?.message ?? e}`))
            } else if (endpoint.remember && endpoint.mark !== undefined && forgottenSince(session.credentialKey, endpoint.mark)) {
                // Edited (its user name, gateway or address) or removed while the server delayed the sign-in: what was
                // forgotten then stays forgotten, and the desktop asks the next time.
                session.log.push('sign-in: not saved: the desktop was changed or removed meanwhile')
            } else if (endpoint.remember) {
                const key = endpoint.saveKey ?? session.credentialKey
                const writing = forgetMark()
                saveCredentials(key, credentials, endpoint.saveLabel).then(
                    () => {
                        // A forget that came while it was being written (an edit, a removal) found nothing to forget
                        // yet: it wins, and the password goes again now that it is there.
                        if (!endpoint.saveKey && forgottenSince(key, writing)) {
                            session.log.push('sign-in: saved, then forgotten again: the desktop was changed or removed meanwhile')
                            return forgetCredentials(key)
                        }
                        session.log.push(`sign-in: saved ${endpoint.saveKey ? 'as the account\'s password ' : ''}in ${storeName()}`)
                    },
                    e => session.log.push(`sign-in: ${storeName()}: ${e?.message ?? e}`))
            }
            this.focusIfInFront(pane, session)
            const connectedAt = Date.now()
            let end: any
            try {
                end = await info.run()
            } catch (e: any) {
                if (session.h264?.failed) {
                    // Reconnects (automatically, like any dropped connection) without H.264, unless the browser only
                    // took an idle decoder back (a hidden window): then with it, as a new stream starts with a key frame.
                    // Taken back again soon after, it goes like any other failure: the connection would otherwise start
                    // over and over for as long as the window stays hidden, or the browser keeps taking decoders back.
                    if (session.h264.reclaimed && !this.decoderReclaimedAgain(session.key)) {
                        return { connected: true, error: 'the video decoder was reclaimed' }
                    }
                    this.h264Failed.add(session.key)
                    return { connected: true, error: `H.264 decoding failed (${session.h264.failed}); continuing without it` }
                }
                const error: string = withoutToken(typeof e?.backtrace === 'function' ? e.backtrace().split('\n')[0] : (e?.message ?? String(e)), session.proxy)
                // A Hyper-V host signs anyone in that it knows, and ends the connection at once when that account may not
                // open the VM's console: a refused sign-in in effect, so the form comes back, saying so.
                if (spec.hyperv && Date.now() - connectedAt < 5000 && /disconnect provider ultimatum/i.test(error)) {
                    session.log.push(`hyper-v: disconnected at once (${error}): the account may not open this VM's console`)
                    return { connected: false, signInFailed: `${target.label} ended the connection at once: this account may not open ${spec.name}'s console. Use an administrator of the host, a member of its Hyper-V Administrators, or an account given access with Grant-VMConnectAccess.` }
                }
                return { connected: true, error }
            } finally {
                // The server can't close the microphone, or its files, once the connection is gone.
                session.mic?.close()
                session.drives?.dispose()
                if (alive()) {
                    this.reconnectedUntilNow(pane, connectedAt)
                }
            }
            return { connected: true, reason: end?.reason?.() }
        } catch (e: any) {
            return { connected: false, error: e?.message ?? String(e) }
        }
    }
}

let styleInstalled = false
export function installStyle (compat: HostCompatibility): void {
    if (styleInstalled) {
        return
    }
    styleInstalled = true
    const style = document.createElement('style')
    style.textContent = STYLE + SIGNIN_STYLE + FILES_STYLE + STATS_STYLE + OSD_STYLE + DRAGBAR_STYLE + ACCOUNT_FORM_STYLE
    document.head.appendChild(style)
    keepWindowDraggable(compat)
}

/** A strip the height of the tab bar that stays a window drag region over a dialog (the plugin's, and Tabby's). */
const DRAGBAR_STYLE = `
.trd-form-dragbar { display: none; }
.modal > .trd-form-dragbar { display: block; position: fixed; left: 0; right: 0; top: 0; height: var(--tabs-height, 38px); -webkit-app-region: drag; }
`

/**
 * Older Tabby dialogs cover the tab bar without a drag region. Supply their fallback strip, deferring to the host's
 * modal pseudo-element when it provides one. The plugin's own dialogs still need their strips (see settingsPage.ts).
 */
function keepWindowDraggable (compat: HostCompatibility): void {
    const strip = (modal: Element) => {
        if (compat.hasNativeModalDragRegion(modal)) {
            return
        }
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
