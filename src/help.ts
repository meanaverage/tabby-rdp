import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { AppService, ConfigService } from 'tabby-core'
import { SettingsTabComponent } from 'tabby-settings'

export const TOGGLE_HOTKEY = 'remote-desktop-toggle'

/** The plugin's page in Tabby's settings (see settingsPage.ts). */
export const SETTINGS_TAB_ID = 'remote-desktop'

/** Sections of the settings page that help can open at. */
export type HelpTopic = 'start' | 'settings' | 'osd' | 'keyboard' | 'desktops' | 'certificates' | 'troubleshooting'

/** A troubleshooting entry: `match` picks it for a message shown over a desktop ("What does this mean?"). */
export interface HelpEntry {
    id: string
    title: string
    match?: RegExp
    /** HTML; written here, never from a remote. */
    body: string
}

export const TROUBLESHOOTING: HelpEntry[] = [
    {
        id: 'certificate',
        title: 'The certificate has changed',
        match: /certificate/i,
        body: `The first connection to a Windows or xrdp desktop remembers its certificate. When a later one differs, the
            plugin stops before signing in, so nothing (no password) has been sent. Reinstalling the machine or renewing its
            certificate changes it: then choose <b>Trust the new certificate</b>. If neither happened, something else is
            answering at that address. A GNOME desktop only ever accepts the certificate the plugin made for it; a
            different one there means another program listens on its port. Remembered certificates are listed above.`,
    },
    {
        id: 'sign-in',
        title: 'Wrong user name or password',
        match: /sign-in|sign in|password|user name/i,
        body: `Windows and xrdp desktops sign in with an account on that machine (<code>DOMAIN\\user</code> works). A saved
            password that no longer works is asked for again; <b>Sign in again…</b> in the tab's menu replaces it on
            purpose. xrdp doesn't refuse a wrong password: it shows its own login window instead. GNOME desktops never
            ask: the plugin manages their sign-in.`,
    },
    {
        id: 'no-desktop',
        title: 'No desktop found on a Linux host',
        match: /GNOME|xrdp|grdctl|headless/i,
        body: `The plugin uses GNOME Remote Desktop 46 or newer (Ubuntu 24.04, for example), with no root and no login
            screen. For KDE, XFCE, MATE and others, install xrdp and a desktop for its sessions: on Debian and Ubuntu,
            <code>sudo apt install xrdp xfce4</code>. A GNOME session already shared from the machine's own screen (GNOME's
            Desktop Sharing) has to be turned off first.`,
    },
    {
        id: 'unreachable',
        title: 'Can\'t reach a Windows desktop',
        match: /refused|timed out|timeout|unreachable|ECONN|EHOST|no route|could not connect|couldn't connect/i,
        body: `Windows needs Remote Desktop turned on (Settings › System › Remote Desktop; Pro, Enterprise or Server).
            Behind an SSH host, the address is as that host sees it: from there, <code>nc -z &lt;address&gt; 3389</code>
            should succeed. For a VM or machine that may be off, give the desktop a VM name or MAC address in its edit form
            and it is started when opened.`,
    },
    {
        id: 'reconnecting',
        title: 'It keeps reconnecting',
        match: /reconnect|connection lost/i,
        body: `After sleep or a network change the desktop reconnects by itself, with growing pauses, and waits while the
            SSH connection is down (<b>Reconnect SSH</b> hurries that along). It stops after a few tries or on
            <b>Stop</b>. If it drops again right after connecting, check the host's free memory and that the desktop's
            session is still running there.`,
    },
    {
        id: 'picture',
        title: 'The picture is blurry or slow',
        match: /H\.264|decod|video/i,
        body: `<b>Sharpness › Retina</b> renders at your screen's device pixels, with the remote's scale set to match. Video
            (H.264) is used when the remote sends it: Windows does, GNOME only with a hardware encoder (VA-API or NVENC).
            <b>Show connection status</b> shows the frame rate, the round trip and how the picture comes.`,
    },
    {
        id: 'sound',
        title: 'No sound, or the microphone isn\'t heard',
        body: `Sound and microphone changes apply on the next connection. xrdp needs <code>pipewire-module-xrdp</code> or
            <code>pulseaudio-module-xrdp</code>. The microphone needs the system's permission here (macOS: System Settings ›
            Privacy &amp; Security › Microphone, then restart Tabby). On GNOME, apps record from "Remoteaudio Source"; on
            Windows, the machine must allow audio recording redirection.`,
    },
    {
        id: 'nested-ssh',
        title: 'I typed ssh to another machine in a terminal',
        body: `In an SSH tab (or a split pane) where you typed <code>ssh</code> on to another machine, <b>Desktop</b> opens that
            machine's desktop, going through the first one, and <code>desk</code> works there too. The first machine has to
            log in to the other by itself for this: with a key there, or agent forwarding, as <code>ssh -o BatchMode=yes</code>
            would. Tabby's <b>Reconnect</b> belongs to the tab: it reconnects the first machine and ends the ssh typed in it.
            To have both desktops side by side, open the first machine's desktop in one pane, and ssh on in the other.`,
    },
    {
        id: 'extra-monitor',
        title: 'GNOME shows an empty extra monitor',
        body: `GNOME Remote Desktop's headless mode gives each client its own monitor: a second client for the same account
            (another computer, or another Tabby window) gets an empty one. Use one client per account at a time.`,
    },
]

/** The troubleshooting entry that explains a message, if one does. */
export function entryFor (message: string): HelpEntry | null {
    return TROUBLESHOOTING.find(e => e.match?.test(message)) ?? null
}

/** A hotkey as Tabby stores it ('⌘-Shift-G', or a sequence) as it reads on this platform: ⌘⇧G, Ctrl+Shift+G. */
export function hotkeyLabel (binding: unknown): string | null {
    const first = Array.isArray(binding) ? binding[0] : null
    const strokes: string[] = Array.isArray(first) ? first : typeof first === 'string' ? [first] : []
    if (!strokes.length) {
        return null
    }
    const mac = process.platform === 'darwin'
    const MAC: Record<string, string> = { Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Meta: '⌘', Cmd: '⌘' }
    return strokes.map(s => s.split('-').map(k => mac ? MAC[k] ?? k : k).join(mac ? '' : '+')).join(', ')
}

const TIP_STYLE = `
.trd-tip { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2; max-width: min(560px, 90%);
    display: flex; gap: 12px; align-items: center; padding: 10px 12px 10px 14px; border-radius: 8px; font-size: 12px;
    line-height: 1.5; color: #e6e6e6; background: rgba(28, 28, 30, 0.94); box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
    animation: trd-tip-in 0.2s ease-out; }
.trd-tip kbd { padding: 0 4px; border-radius: 3px; background: rgba(255, 255, 255, 0.12); color: inherit; font-size: 11px; }
.trd-tip-actions { display: flex; gap: 6px; flex: none; }
.trd-tip-actions button { font-size: 12px; padding: 2px 10px; }
.trd-note { z-index: 40; }
@keyframes trd-tip-in { from { opacity: 0; transform: translate(-50%, 6px); } }
`

/**
 * Help that comes to the user: the plugin's settings page, opened at a section, and one tip the first time a desktop
 * connects. Nothing else pops up.
 */
@Injectable({ providedIn: 'root' })
export class RemoteDesktopHelp {
    /** A section to show; the open settings page follows it (see settingsPage.ts). */
    readonly show$ = new Subject<{ topic: HelpTopic, entry?: string }>()
    /** For a settings page not yet made: where to scroll once it is. */
    pending: { topic: HelpTopic, entry?: string } | null = null

    constructor (private app: AppService, private config: ConfigService, private zone: NgZone) {
        const style = document.createElement('style')
        style.textContent = TIP_STYLE
        document.head.appendChild(style)
    }

    /** Opens Tabby's settings at the plugin's page, at `topic` (and a troubleshooting entry). */
    open (topic: HelpTopic = 'start', entry?: string): void {
        this.zone.run(() => {
            this.pending = { topic, entry }
            this.openSettings(SETTINGS_TAB_ID)
            this.show$.next({ topic, entry })
        })
    }

    /** Opens Tabby's settings at one of its pages: this plugin's, or Tabby's own ('plugins', 'hotkeys', …). */
    openSettings (page: string): void {
        this.zone.run(() => {
            const tab = this.app.tabs.find(t => t instanceof SettingsTabComponent) as SettingsTabComponent | undefined
            if (tab) {
                tab.activeTab = page
                this.app.selectTab(tab)
            } else {
                this.app.openNewTabRaw({ type: SettingsTabComponent, inputs: { activeTab: page } })
            }
        })
    }

    /** "What does this mean?" under a message: the entry explaining it, else troubleshooting as a whole. */
    explain (message: string): void {
        this.open('troubleshooting', entryFor(message)?.id)
    }

    /**
     * A note over a terminal pane, for something to read (a toast goes too fast): looks like the plugin's other notes
     * (see fileTransfer.ts), stays until closed, replaced by the next one. `entry`: a troubleshooting entry for Help.
     */
    note (container: HTMLElement, text: string, entry?: string): HTMLElement {
        container.querySelector(':scope > .trd-note')?.remove()
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative'
        }
        const note = document.createElement('div')
        note.className = 'trd-toast trd-note'
        note.innerHTML = `<div class="trd-toast-text"></div>${entry ? '<button class="btn btn-secondary" data-more>Help</button>' : ''}<button class="btn btn-link" data-ok title="Dismiss">×</button>`
        note.querySelector('.trd-toast-text')!.textContent = text
        // Below an SSH tab's toolbar (Reconnect, SFTP…), not over it.
        const toolbar = container.querySelector<HTMLElement>('terminal-toolbar')
        if (toolbar?.offsetHeight) {
            note.style.top = `${toolbar.offsetTop + toolbar.offsetHeight + 8}px`
        }
        note.querySelector('[data-ok]')!.addEventListener('click', () => note.remove())
        note.querySelector('[data-more]')?.addEventListener('click', () => {
            note.remove()
            this.open('troubleshooting', entry)
        })
        container.appendChild(note)
        return note
    }

    /** The desktop/console hotkey as it reads here, or null when it has none. */
    toggleHotkey (): string | null {
        return hotkeyLabel(this.config.store.hotkeys?.[TOGGLE_HOTKEY])
    }

    /**
     * The first time any desktop connects (and shows): what to know that isn't on screen. Once only, whether read or
     * not; gone after a while, on Got it, or with the desktop. `hasConsole`: false in a remote desktop tab.
     */
    tipOnce (overlay: HTMLElement, hasConsole: boolean, onDone: () => void): void {
        const store = this.config.store.remoteDesktop
        if (!store || store.tipShown) {
            return
        }
        store.tipShown = true
        this.config.save()
        const k = (s: string) => `<kbd>${s}</kbd>`
        const mac = process.platform === 'darwin'
        const hotkey = this.toggleHotkey()
        const parts = [
            hasConsole && hotkey ? `${k(hotkey)} switches back to the console.` : '',
            mac ? `${k('⌃⌘')} with a key is the Windows key with it (${k('⌃⌘R')} for Win+R).` : '',
            'Right-click the tab for Send keys, View only and screenshots.',
        ]
        const tip = document.createElement('div')
        tip.className = 'trd-tip'
        tip.innerHTML = `<div>${parts.filter(Boolean).join(' ')}</div>
            <div class="trd-tip-actions"><button class="btn btn-link" data-more>More tips</button><button class="btn btn-secondary" data-ok>Got it</button></div>`
        const close = () => {
            clearTimeout(timer)
            tip.remove()
            onDone()
        }
        tip.querySelector('[data-ok]')!.addEventListener('click', close)
        tip.querySelector('[data-more]')!.addEventListener('click', () => {
            close()
            this.open('keyboard')
        })
        const timer = setTimeout(() => tip.isConnected && close(), 25000)
        overlay.appendChild(tip)
    }
}
