import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { AppService, ConfigService, NotificationsService, SplitTabComponent } from 'tabby-core'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { DesktopPane, RemoteTarget, RemoteTargets } from './targets'
import { consoleScript, DeskRequest } from './deskScript'
import { AudioPlayer } from './audio'
import { askDesktop } from './desktopForm'
import { FileTransfer, STYLE as FILES_STYLE } from './fileTransfer'
import { desktopIdOf, DesktopSpec, desktopsFor, ExtraDesktopConfig, OWN_DESKTOP, sessionKey } from './desktops'
import { prepareRemoteDesktop, WindowsHostError } from './remoteSetup'
import { RDCleanPathProxy, startRDCleanPathProxy } from './rdcleanpath'
import {
    askCredentials, Credentials, forgetCredentials, forgetCredentialsFor, loadCredentials, moveCredentialsFor, saveCredentials,
    STYLE as SIGNIN_STYLE,
} from './signin'

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
const vendor = (f: string) => pathToFileURL(path.join(__dirname, '..', 'vendor', f)).href

const STYLE = `
.trd-overlay { position: absolute; inset: 0; z-index: 30; display: flex; background: #111; }
.trd-host { flex: auto; min-width: 0; min-height: 0; display: flex; }
.trd-host iron-remote-desktop { flex: auto; }
.trd-status { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 14px; align-items: center;
    justify-content: center; padding: 2em; text-align: center; color: #bbb; font-size: 13px; white-space: pre-line;
    pointer-events: none; }
.trd-status-actions { display: flex; gap: 8px; pointer-events: auto; }
.trd-status-actions:empty { display: none; }
.trd-overlay.trd-dim .trd-host { opacity: 0.2; }
`

/** A button in the desktop layer's status (Reconnect, Stop, …). */
interface StatusAction {
    label: string
    run: () => void
}

type SessionState = 'connecting' | 'connected' | 'ended'

/** `remoteDesktop` settings (Tabby config), editable from the "Remote desktop settings" menus. */
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

/** The SSH host's own GNOME desktop: set up by the plugin, with an account it made, so no sign-in. */
function isManaged (spec: DesktopSpec): boolean {
    return spec.id === OWN_DESKTOP && spec.kind === 'gnome'
}

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
    /** Files through the clipboard (drop on the desktop, or copy on the remote). */
    files: FileTransfer | null = null
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
            <div class="trd-status"><div class="trd-status-text"></div><div class="trd-status-actions"></div></div>`
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

    /** Shows a message over the desktop (empty: none), with buttons; with buttons the last picture is dimmed. */
    status (msg: string, actions: StatusAction[] = []): void {
        this.log.push(`${new Date().toISOString()} ${msg}`)
        this.statusEl.querySelector('.trd-status-text')!.textContent = msg
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
        const canvas = host?.shadowRoot?.querySelector('canvas') as HTMLElement | null
        canvas?.focus()
        if (host && document.activeElement !== host && attempts > 1 && this.visible) {
            setTimeout(() => this.visible && this.focusDesktop(attempts - 1), 16)
        }
    }

    dispose (): void {
        this.markDisposed()
        this.setVisible(false)
        this.container.removeEventListener('focusin', this.reclaimFocus, true)
        this.disposers.forEach(f => f())
        try { this.ui?.shutdown() } catch { }
        this.audio?.close()
        this.files?.dispose()
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

    constructor (
        private app: AppService,
        private targets: RemoteTargets,
        private notifications: NotificationsService,
        private config: ConfigService,
        private zone: NgZone,
    ) { }

    has (pane: DesktopPane): boolean {
        this.prune()
        return this.sessions.has(pane)
    }

    isVisible (pane: DesktopPane): boolean {
        return !!this.sessions.get(pane)?.visible
    }

    async toggle (pane: DesktopPane): Promise<void> {
        if (this.isVisible(pane)) {
            this.showConsole(pane)
        } else {
            await this.showDesktop(pane)
        }
    }

    /** The desktops this pane's SSH host offers: its own, then those configured behind it. */
    desktopsOf (target: RemoteTarget): DesktopSpec[] {
        return desktopsFor(target, this.config.store.remoteDesktop?.desktops, this.windowsHosts.has(target.key) ? 'windows' : 'gnome')
    }

    /**
     * SSH targets (keys) found to run Windows: their own desktop is Windows' RDP server. Found out on the first connect
     * there (see prepareRemoteDesktop), which costs a failed setup, so it is remembered for as long as Tabby runs.
     */
    private windowsHosts = new Set<string>()

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

    /** "Send files to the remote desktop…": picks files to paste there. */
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
        const old = this.configuredDesktops()[index]
        if (!old) {
            return
        }
        if (this.isVisible(pane)) {
            this.showConsole(pane)
        }
        const entry = await askDesktop(pane.element.nativeElement, {
            title: `Edit ${old.name ?? desktopIdOf(old)} (behind ${old.via})`,
            action: 'Save',
            entry: old,
            check: e => this.addressTaken(e, index),
        })
        pane.frontend?.focus()
        // Compared with the entry as it is now: the config can change while the form shows.
        const list = this.configuredDesktops()
        if (!entry || list[index] !== old) {
            return
        }
        list[index] = entry
        this.config.store.remoteDesktop.desktops = list
        this.config.save()
        this.changed$.next()
        const [from, to] = [desktopIdOf(old), desktopIdOf(entry)]
        if ((old.username ?? '') !== (entry.username ?? '') || (old.domain ?? '') !== (entry.domain ?? '')) {
            await forgetCredentialsFor(from)
        } else if (from !== to) {
            await moveCredentialsFor(from, to)
        }
        if (from !== to) {
            this.moveDesktopKeys(from, to)
        }
    }

    /** Keeps what is kept per desktop (its sharpness, the last-used choice) with a desktop whose address changed. */
    private moveDesktopKeys (fromId: string, toId: string): void {
        const store = this.config.store.remoteDesktop
        if (Array.isArray(store.desktopSharpness)) {
            store.desktopSharpness = store.desktopSharpness.map((e: any) => typeof e?.desktop === 'string' && e.desktop.endsWith(`#${fromId}`)
                ? { ...e, desktop: `${e.desktop.slice(0, -fromId.length)}${toId}` }
                : e)
            this.config.save()
        }
        for (const [key, id] of this.lastUsed) {
            if (id === fromId) {
                this.lastUsed.set(key, toId)
            }
        }
    }

    /** Removes a configured desktop and its saved accounts. Open sessions to it keep running. */
    removeDesktop (index: number): void {
        const list = this.configuredDesktops()
        const [removed] = list.splice(index, 1)
        if (!removed) {
            return
        }
        this.config.store.remoteDesktop.desktops = list
        this.config.save()
        this.changed$.next()
        forgetCredentialsFor(`${removed.host ?? '127.0.0.1'}:${removed.port ?? 3389}`)
    }

    /**
     * Shows a desktop over the pane: `desktopId` (see desktopsOf), or the one it has open, or the default. A pane
     * holds one desktop at a time; choosing another one replaces it.
     */
    async showDesktop (pane: DesktopPane, desktopId?: string, options: { background?: boolean } = {}): Promise<void> {
        this.prune()
        let session = this.sessions.get(pane)
        if (session?.state === 'ended' || session && desktopId && session.spec.id !== desktopId) {
            this.disconnect(pane)
            session = undefined
        }
        if (!session) {
            const target = await this.targets.targetOf(pane)
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
                this.selectPane(existing)
                return this.showDesktop(existing)
            }
            const created = new DesktopSession(pane.element.nativeElement, key, spec)
            session = created
            this.sessions.set(pane, created)
            pane.destroyed$.subscribe(() => this.disconnect(pane))
            // Tabby focuses the terminal when the pane gets focus (tab switch, split focus); take it back.
            const focused = pane.focused$.subscribe(() => {
                if (created.visible) {
                    setTimeout(() => created.visible && created.focusDesktop())
                }
            })
            created.onDispose(() => focused.unsubscribe())
            this.connect(pane, target, spec, created)
        }
        if (options.background) {
            return
        }
        session.setVisible(true)
        this.changed$.next()
        const shown = session
        setTimeout(() => this.followPane(pane, shown))
    }

    /**
     * `desk`: show this machine's desktop and bring the console along: a terminal on the desktop,
     * attached to the console's tmux session (or opened in its folder when it isn't in tmux).
     */
    async openConsole (pane: DesktopPane, request: DeskRequest): Promise<void> {
        await this.showDesktop(pane, OWN_DESKTOP)
        const target = await this.targets.targetOf(pane)
        if (!target) {
            return
        }
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
    private reconnects = new Map<DesktopPane, { attempts: number, timer?: ReturnType<typeof setTimeout> }>()
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
        await this.zone.run(() => this.showDesktop(pane, spec.id, { background }))
    }

    /** After a desktop ended: reconnect by itself if it dropped, otherwise offer to. */
    private afterEnd (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, outcome: { connected: boolean, error?: string, reason?: string }): void {
        session.state = 'ended'
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
            session.status(`Remote desktop failed: ${outcome.error ?? 'unknown error'}`, [again('Try again')])
        }
    }

    private scheduleReconnect (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, message: string): void {
        const state = this.reconnects.get(pane) ?? { attempts: 0 }
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
            session.status(`${message}\nStopped reconnecting automatically.`, [{ label: 'Reconnect', run: () => this.reopen(pane, spec) }])
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
        }
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
        Object.assign(store, change)
        this.config.save()
        for (const [pane, session] of this.sessions) {
            this.followPane(pane, session)
        }
    }

    /** Follows the pane's size (debounced) while the desktop shows, per the resize setting. */
    private watchSize (pane: DesktopPane, session: DesktopSession): void {
        let timer: any
        const observer = new ResizeObserver(() => {
            // Refit the view right away (the component only refits on window resizes by itself) ...
            try { session.ui?.setScale(1 /* ScreenScale.Fit */) } catch { }
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
            this.zone.run(() => {
                this.disconnect(pane)
                this.showDesktop(pane)
            })
            return
        }
        this.applySize(session, wanted)
    }

    private applySize (session: DesktopSession, size: RemoteSize): void {
        session.log.push(`resize: ${size.width}x${size.height} @${size.scale}%`)
        const before = session.remoteSize
        session.remoteSize = size
        if (session.spec.kind === 'windows') {
            // Windows takes the scale from the monitor layout only when it also has the monitor's physical size (mm).
            const mm = (px: number) => Math.round(px / (size.scale / 100) / 96 * 25.4)
            session.ui.resize(size.width, size.height, size.scale, mm(size.width), mm(size.height))
        } else {
            session.ui.resize(size.width, size.height, size.scale)
        }
        // grd ignores the scale in the monitor layout: it's set through Mutter (also back to 100%).
        if ((size.scale !== 100 || (before?.scale ?? 100) !== 100) && session.remote && isManaged(session.spec)) {
            session.remote.exec(`python3 - ${size.width} ${size.height} ${size.scale / 100}`, SCALE_SCRIPT).then(out => {
                session.log.push(`scale: ${/^RD_(OK|ERR) (.*)$/m.exec(out)?.[2] ?? out.trim().slice(-120)}`)
            }, e => session.log.push(`scale: ${e?.message ?? e}`))
        }
    }

    /** Status log of the pane's desktop session (for tests and troubleshooting). */
    logOf (pane: DesktopPane): string[] {
        return this.sessions.get(pane)?.log ?? []
    }

    private loadIronRDP (): Promise<any> {
        this.ironrdp ??= (async () => {
            await importESM(vendor('iron-remote-desktop.js'))
            const rdp = await importESM(vendor('iron-remote-desktop-rdp.js'))
            // Troubleshooting: localStorage.trdLogLevel = 'DEBUG' (or TRACE), then restart Tabby.
            let level = 'INFO'
            try { level = localStorage.getItem('trdLogLevel') || level } catch { }
            await rdp.init(level)
            return rdp
        })()
        this.ironrdp.catch(() => { this.ironrdp = null })
        return this.ironrdp
    }

    /**
     * Where to connect and as whom. The host's own desktop: the setup script (grd, generated credentials).
     * Others: the saved account, or the sign-in form (retry=true after a failed sign-in).
     */
    private async endpointFor (target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, retryError?: string): Promise<{ host: string, port: number, credentials: Credentials, remember: boolean } | null> {
        if (isManaged(spec)) {
            session.status(`Preparing the remote desktop on ${target.label}…`)
            const endpoint = await prepareRemoteDesktop(target, this.settings().desk, this.config.store.remoteDesktop?.sessionBackend)
            return { host: '127.0.0.1', port: endpoint.port, credentials: { username: endpoint.username, password: endpoint.password }, remember: false }
        }
        const saved = retryError ? null : await loadCredentials(session.key)
        if (saved) {
            return { host: spec.host, port: spec.port, credentials: saved, remember: false }
        }
        session.status('')
        const asked = askCredentials(session.overlay, {
            title: spec.id === OWN_DESKTOP ? `Sign in to ${spec.name}` : `Sign in to ${spec.name} (via ${target.label})`,
            username: spec.username,
            error: retryError,
            canRemember: true,
        }, session.disposed)
        if (session.visible) {
            setTimeout(() => session.visible && session.focusDesktop())
        }
        const entered = await asked
        return entered && { host: spec.host, port: spec.port, credentials: entered, remember: entered.remember }
    }

    private async connect (pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession): Promise<void> {
        const alive = () => this.sessions.get(pane) === session
        let retryError: string | undefined
        try {
            // Signing in to a Windows account can take a few tries; a GNOME desktop the plugin set up can't fail that way.
            for (let attempt = 0; ; attempt++) {
                const [endpoint, rdp] = await Promise.all([this.endpointFor(target, spec, session, retryError), this.loadIronRDP()])
                if (!alive()) {
                    return
                }
                if (!endpoint) {
                    session.state = 'ended'
                    this.changed$.next()
                    this.cancelReconnect(pane)
                    session.status('Sign-in cancelled.', [{ label: 'Sign in', run: () => this.reopen(pane, spec) }])
                    return
                }
                session.remote = target
                session.proxy ??= await startRDCleanPathProxy(() => target.openTcp(endpoint.host, endpoint.port), m => session.log.push(m))
                const outcome = await this.run(pane, target, spec, session, rdp, endpoint)
                if (outcome.signInFailed && !isManaged(spec) && attempt < 5 && alive()) {
                    await forgetCredentials(session.key)
                    retryError = outcome.signInFailed
                    continue
                }
                if (alive()) {
                    this.afterEnd(pane, target, spec, session, outcome)
                }
                return
            }
        } catch (e: any) {
            if (e instanceof WindowsHostError && alive()) {
                // Start over with the host's own desktop as a Windows one: sign-in instead of the GNOME setup.
                session.log.push('setup: the SSH host runs Windows; its own desktop is its RDP server')
                this.windowsHosts.add(target.key)
                this.changed$.next()
                await this.reopen(pane, spec, true)
                return
            }
            if (alive()) {
                this.afterEnd(pane, target, spec, session, { connected: false, error: e?.message ?? String(e) })
            }
        }
    }

    /** One RDP connection attempt, until it ends. */
    private async run (
        pane: DesktopPane, target: RemoteTarget, spec: DesktopSpec, session: DesktopSession, rdp: any,
        endpoint: { host: string, port: number, credentials: Credentials, remember: boolean },
    ): Promise<{ connected: boolean, signInFailed?: string, error?: string, reason?: string }> {
        const credentials = endpoint.credentials
        const alive = () => this.sessions.get(pane) === session
        const el = document.createElement('iron-remote-desktop') as any
        try {
            el.setAttribute('scale', 'fit')
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
            const [domain, username] = /^([^\\]+)\\(.+)$/.exec(credentials.username)?.slice(1) ?? [spec.domain ?? '', credentials.username]
            session.status(spec.id === OWN_DESKTOP ? `Connecting to ${target.label}…` : `Connecting to ${spec.name} via ${target.label}…`)
            const config = session.ui.configBuilder()
                .withUsername(username)
                .withPassword(credentials.password)
                .withDestination(`${spec.id === OWN_DESKTOP ? target.label : endpoint.host}:${endpoint.port}`)
                .withProxyAddress(session.proxy!.url)
                .withServerDomain(domain)
                .withAuthToken(session.proxy!.token)
                .withDesktopSize({ width, height })
                // Display control lets the remote monitor follow the pane (live resize, remote scaling).
                .withExtension(rdp.displayControl(true))
            // GNOME Remote Desktop requires the graphics pipeline; Windows does better with bitmaps (IronRDP decodes
            // EGFX without H.264, which Windows would want). A build without the switch decides by itself.
            if (typeof rdp.graphicsPipeline === 'function') {
                config.withExtension(rdp.graphicsPipeline(spec.kind === 'gnome'))
            }
            if (settings.sound) {
                session.audio?.close()
                session.audio = new AudioPlayer()
                config.withExtension(rdp.audioPlayback(session.audio.callback))
            }
            const built = config.build()
            let info: any
            try {
                info = await session.ui.connect(built)
            } catch (e: any) {
                // IronErrorKind: 1 WrongPassword, 2 LogonFailure.
                const kind = typeof e?.kind === 'function' ? e.kind() : undefined
                const detail = typeof e?.backtrace === 'function' ? e.backtrace() : (e?.message ?? String(e))
                if (kind === 1 || kind === 2) {
                    session.log.push(`sign-in failed: ${detail.split('\n')[0]}`)
                    return { connected: false, signInFailed: kind === 1 ? 'Wrong user name or password.' : 'The sign-in was refused.' }
                }
                throw new Error(detail)
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
            session.status('')
            this.changed$.next()
            this.reconnects.delete(pane)  // connected again: a later drop starts over
            if (endpoint.remember) {
                saveCredentials(session.key, credentials).then(
                    () => session.log.push('sign-in: saved in the keychain'),
                    e => session.log.push(`sign-in: keychain: ${e?.message ?? e}`))
            }
            if (session.visible) {
                session.focusDesktop()
            }
            let end: any
            try {
                end = await info.run()
            } catch (e: any) {
                return { connected: true, error: typeof e?.backtrace === 'function' ? e.backtrace().split('\n')[0] : (e?.message ?? String(e)) }
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
    style.textContent = STYLE + SIGNIN_STYLE + FILES_STYLE
    document.head.appendChild(style)
}
