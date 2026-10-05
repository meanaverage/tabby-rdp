import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { AppService, ConfigService } from 'tabby-core'
import { SettingsTabComponent } from 'tabby-settings'

export const TOGGLE_HOTKEY = 'remote-desktop-toggle'

/**
 * The plugin's hotkeys (Settings › Hotkeys, and the Remote Desktop page), all `remote-desktop-*`: they fire while a
 * desktop has the keyboard too (see DesktopKeyboard). Only the switch has a default binding.
 */
export const HOTKEYS: { id: string, name: string }[] = [
    { id: TOGGLE_HOTKEY, name: 'Switch between the desktop and the console' },
    { id: 'remote-desktop-view-only', name: 'View only (on or off)' },
    { id: 'remote-desktop-screenshot', name: 'Save a screenshot' },
    { id: 'remote-desktop-ctrl-alt-del', name: 'Send Ctrl+Alt+Del' },
    { id: 'remote-desktop-type-into-all', name: 'Type into all desktops in the tab (on or off)' },
    { id: 'remote-desktop-paste-to-all', name: 'Paste to all desktops in the tab' },
    { id: 'remote-desktop-connection-status', name: 'Show connection status (on or off)' },
    { id: 'remote-desktop-disconnect', name: 'Disconnect the desktop' },
]

/** The plugin's page in Tabby's settings (see settingsPage.ts). */
export const SETTINGS_TAB_ID = 'remote-desktop'

/** Sections of the settings page that help can open at. */
export type HelpTopic = 'start' | 'settings' | 'osd' | 'keyboard' | 'desktops' | 'accounts' | 'certificates' | 'troubleshooting'

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
        title: 'A certificate this computer can\'t verify, or one that has changed',
        match: /certificate/i,
        body: `A desktop you connect to directly (a remote desktop profile, an imported file) and an RD Gateway connect
            without asking when their certificate is valid for their name by this computer's certificate authorities, as
            an organisation's own desktops and gateways often are. Any other is shown the first time, with why it can't
            be verified (most often: it is the server's own, self-signed) and its fingerprint, before anything of your
            sign-in is sent: check the fingerprint with whoever runs it, some other way than this connection (it is in the
            desktop's log too, which <b>Copy log</b> under Open desktops below copies), then choose <b>Trust the
            certificate</b>. The question also says whom the certificate says it was issued to and by, and when it is
            valid: its own word, which nothing has checked, unless its chain leads to an authority this computer trusts
            (another machine's certificate then shows that machine's name) and the TLS library didn't refuse it for a
            reason of its own (a limit set on the authority, say). An issuer you wouldn't expect there (one
            that inspects your network's connections, say) is worth asking about before you trust it, but the one you
            would expect proves nothing: anyone can make a certificate that names it. Only the fingerprint, checked some
            other way, does. A desktop behind an SSH host remembers its certificate on first use without asking, since
            the way there runs inside SSH. When a remembered certificate differs later, the plugin stops before signing
            in, so nothing of your sign-in has gone to that server; only a certificate an authority vouched for is
            replaced without a question, by another it vouches for too. Reinstalling the machine or renewing its
            certificate changes it: then choose <b>Trust the new certificate</b>. If neither happened, something else
            is answering at that address. A GNOME desktop only ever accepts the certificate the plugin made for it; a
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
            Windows, the machine must allow audio recording redirection. A desktop whose microphone was stopped (<b>Stop</b>
            in the microphone's menu in Tabby's header, or <b>Send the microphone</b> unchecked in the desktop's menu) gets
            none, its reconnects included, until <b>Send the microphone</b> is checked again in its menu or that Tabby window is closed.`,
    },
    {
        id: 'nested-ssh',
        title: 'I typed ssh to another machine in a terminal',
        body: `In an SSH tab (or a split pane) where you typed <code>ssh</code> on to another machine, <b>Desktop</b> opens that
            machine's desktop, going through the first one, and <code>desk</code> works there too. Desktop asks which desktop
            you mean, since which <code>ssh</code> runs there is the first machine's to say; pick the other machine's
            "from now on" to have it open at once the next times. Desktops you set up behind a host open in a tab connected
            to that host, not through another one.
            The first machine has to log in to the other by itself for this: with a key there, or agent forwarding, as
            <code>ssh -o BatchMode=yes</code> would. Tabby's <b>Reconnect</b> belongs to the tab: it reconnects the first
            machine and ends the ssh typed in it.
            To have both desktops side by side, open the first machine's desktop in one pane, and ssh on in the other.`,
    },
    {
        id: 'extra-monitor',
        title: 'The desktop is open somewhere else',
        match: /open somewhere else|opened somewhere else/,
        body: `GNOME Remote Desktop's headless mode gives each connection a screen of its own: a second computer, or another
            Tabby window, connected to the same account gets an empty extra screen rather than the same one. So when the
            desktop is open somewhere else already, you choose. <b>Take it over</b> disconnects the other connection, as
            Windows does; the session and its apps carry on, on this screen. <b>Open a second screen</b> keeps both, each
            with a screen of its own. A desktop taken over from here doesn't take itself back: it says so, and offers
            the same two choices.`,
    },
]

/** The troubleshooting entry that explains a message, if one does. */
export function entryFor (message: string): HelpEntry | null {
    return TROUBLESHOOTING.find(e => e.match?.test(message)) ?? null
}

/** A hotkey as Tabby stores it ('⌘-Shift-G', or a sequence) as it reads on this platform: ⌘⇧G, Ctrl+Shift+G. */
/** Text for HTML: config values (a hotkey, a desktop's name) are text, never markup. */
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export function hotkeyLabel (binding: unknown): string | null {
    const first = Array.isArray(binding) ? binding[0] : null
    // Text only: the config may hold anything, and this runs for the settings page and the first-connect tip.
    const strokes = (Array.isArray(first) ? first : [first]).filter((s): s is string => typeof s === 'string')
    if (!strokes.length) {
        return null
    }
    const mac = process.platform === 'darwin'
    // A Map, not an object literal: a part named 'constructor' or 'toString' would find what objects inherit.
    const MAC = new Map([['Shift', '⇧'], ['Alt', '⌥'], ['Ctrl', '⌃'], ['Meta', '⌘'], ['Cmd', '⌘']])
    return strokes.map(s => s.split('-').map(k => mac ? MAC.get(k) ?? k : k).join(mac ? '' : '+')).join(', ')
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
        const k = (s: string) => `<kbd>${esc(s)}</kbd>`
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
