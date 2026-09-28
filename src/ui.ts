import { Injectable, NgZone } from '@angular/core'
import {
    AppService, BaseTabComponent, ConfigProvider, HotkeyDescription, HotkeyProvider, MenuItemOptions, Platform, SplitTabComponent,
    TabContextMenuItemProvider,
} from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'
import { DesktopSettings, RemoteDesktopService } from './desktop.service'
import { RemoteDesktopHelp, TOGGLE_HOTKEY } from './help'
import { DesktopKeyboard, SEND_KEYS } from './keyboard'
import { UpdateCheck } from './updates'
import { isSSHTab } from './ssh'
import { DesktopPane, desktopPaneOf, RemoteTargets } from './targets'

export { TOGGLE_HOTKEY }

/** Listed in Settings > Hotkeys, where it can be rebound. Works while the desktop has focus too. */
@Injectable()
export class RemoteDesktopHotkeys extends HotkeyProvider {
    async provide (): Promise<HotkeyDescription[]> {
        return [{ id: TOGGLE_HOTKEY, name: 'Remote desktop: switch between desktop and console (SSH tabs and terminals running ssh)' }]
    }
}

@Injectable()
export class RemoteDesktopConfig extends ConfigProvider {
    override defaults = {
        hotkeys: { [TOGGLE_HOTKEY]: [] },
        remoteDesktop: {
            // Shareable session for SSH logins ('desk'): 'native' (trd-pty) or 'tmux' (earlier setup).
            sessionBackend: 'native',
            // When the pane changes size: 'live' | 'reconnect' | 'off'.
            resize: 'live',
            // 'standard' (CSS pixels) | 'retina' (device pixels, remote scaled to match).
            sharpness: 'standard',
            // `desk`: installs a login hook on remotes (applied the next time a desktop opens there).
            desk: false,
            // macOS: ⌘ acts as Ctrl on the remote desktop (false: ⌘ is the Windows/Super key).
            macShortcuts: true,
            // Play the remote desktop's sound (applies on the next connect).
            sound: true,
            // H.264 in the graphics pipeline, decoded by the browser, where it can (applies on the next connect).
            h264: true,
            // With resize 'off': 'fit' (scaled to the pane) | 'actual' (1:1, scrolling).
            zoom: 'fit',
            // A small indicator on the desktop: throughput, frames per second, SSH round trip, connection path.
            connectionStatus: false,
            // Send the microphone to the remote desktop while an application there records (applies on the next connect).
            microphone: false,
            // More desktops behind SSH hosts (e.g. a Windows VM whose RDP port the host forwards); see desktops.ts.
            desktops: [],
            // Sharpness for particular desktops, overriding `sharpness`: [{ desktop: <session key>, sharpness }].
            desktopSharpness: [],
            // Certificates of desktops behind hosts, trusted on first use: [{ desktop: <session key>, sha256 }].
            trustedCertificates: [],
            // The on-screen display naming a desktop for a moment (see osd.ts).
            osd: { show: 'auto', font: 'condensed', size: 'medium', position: 'top-right', color: '', seconds: 2.5 },
            // Look for VMs with a desktop on SSH hosts (libvirt) and offer them in the menus (see vms.ts).
            discoverVMs: true,
            // Ask npm once a day whether a newer tabby-rdp is out, and say so (see updates.ts).
            checkUpdates: true,
            // The newer version a note was shown for (once per version).
            updateNoted: '',
            // The tip shown the first time a desktop connects (see help.ts) has been shown.
            tipShown: false,
        },
    }

    override platformDefaults = {
        [Platform.macOS]: { hotkeys: { [TOGGLE_HOTKEY]: ['⌘-Shift-G'] } },
        [Platform.Windows]: { hotkeys: { [TOGGLE_HOTKEY]: ['Ctrl-Shift-G'] } },
        [Platform.Linux]: { hotkeys: { [TOGGLE_HOTKEY]: ['Ctrl-Shift-G'] } },
    }
}

/**
 * What switching does for this pane right now. Names the desktop when the host has more than one. Null in a remote
 * desktop tab while its desktop shows: there is no console to switch to.
 */
export function toggleLabel (desktop: RemoteDesktopService, pane: DesktopPane): string | null {
    if (desktop.isVisible(pane)) {
        return desktop.hasConsole(pane) ? 'Back to console' : null
    }
    const { specs, current } = desktop.choicesOf(pane)
    const what = specs.length > 1 && current ? current.name : 'remote desktop'
    if (desktop.has(pane)) {
        return `Show ${what}`
    }
    return desktop.isOpenElsewhere(pane) ? `Switch to ${what} (open in another tab)` : `Open ${what}`
}

/**
 * The host's other desktops (besides the one the toggle acts on): open one here, replacing the current one.
 * Then "Add a desktop behind <host>…".
 */
export function desktopChoices (desktop: RemoteDesktopService, pane: DesktopPane, targetLabel?: string): MenuItemOptions[] {
    const { specs, current } = desktop.choicesOf(pane)
    const items: MenuItemOptions[] = specs.filter(spec => spec.id !== current?.id).map(spec => ({
        label: desktop.isOpenElsewhere(pane, spec) ? `Switch to ${spec.name} (open in another tab)`
            // Found on the host (see vms.ts): say so, and that opening one that's off starts it.
            : spec.found === 'off' ? `Start and open ${spec.name} (VM, shut off)` : spec.found ? `Open ${spec.name} (VM)` : `Open ${spec.name}`,
        click: () => desktop.showDesktop(pane, spec.id),
    }))
    // Not in a remote desktop tab: it isn't an SSH host.
    if (targetLabel && desktop.hasConsole(pane)) {
        items.push({ label: `Add a desktop behind ${targetLabel}…`, click: () => desktop.addDesktop(pane) })
    }
    return items
}

/** What can be done with the pane's connected desktop: send keys, view only, a screenshot. Shared by the menus. */
export function desktopActions (desktop: RemoteDesktopService, keyboard: DesktopKeyboard, pane: DesktopPane): MenuItemOptions[] {
    const spec = desktop.desktopOf(pane)
    if (!spec || !desktop.isConnected(pane)) {
        return []
    }
    const viewOnly = desktop.isViewOnly(pane)
    return [
        {
            label: 'Send keys',
            enabled: !viewOnly,
            submenu: SEND_KEYS[spec.kind].map(combo => ({ label: combo.label, click: () => keyboard.send(pane, combo) })),
        },
        {
            type: 'checkbox',
            label: 'View only (no keyboard or mouse input)',
            checked: viewOnly,
            click: () => desktop.setViewOnly(pane, !viewOnly),
        },
        { label: 'Save a screenshot (to Downloads and the clipboard)', click: () => desktop.saveScreenshot(pane) },
    ]
}

/** Tab header menu (whole tab: its focused pane) and in-terminal menu (that pane). */
@Injectable()
export class RemoteDesktopContextMenu extends TabContextMenuItemProvider {
    override weight = 6

    constructor (
        private desktop: RemoteDesktopService,
        private targets: RemoteTargets,
        private keyboard: DesktopKeyboard,
        private help: RemoteDesktopHelp,
        private app: AppService,
        private updates: UpdateCheck,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        // For a header right-click Tabby asks the top-level tab and then its focused pane; answer once.
        if (tabHeader && tab.parent instanceof SplitTabComponent) {
            return []
        }
        const pane = desktopPaneOf(tab)
        // Local terminals qualify only while they run ssh.
        const target = pane && (this.targets.cached(pane) ?? await this.targets.targetOf(pane))
        if (!pane || !this.desktop.has(pane) && !target) {
            return []
        }
        // VMs on the host: wait a moment for a fresh look, else show what's known.
        if (target) {
            await Promise.race([this.desktop.discoverVMs(target), new Promise(resolve => setTimeout(resolve, 1200))])
        }
        // A heading, so the items below read as this plugin's rather than Tabby's.
        const connectedTo = this.desktop.isConnected(pane) ? this.desktop.desktopOf(pane)?.name : undefined
        const toggle = toggleLabel(this.desktop, pane)
        const items: MenuItemOptions[] = [
            { label: connectedTo ? `Remote Desktop — connected to ${connectedTo}` : 'Remote Desktop', enabled: false },
            // A newer tabby-rdp: where to get it (Tabby shows plugin upgrades only on its Plugins page).
            ...this.updates.available ? [{ label: `Update available: ${this.updates.available}…`, click: () => this.updates.upgrade() }] : [],
            ...toggle ? [{ label: toggle, click: () => this.desktop.toggle(pane) }] : [],
        ]
        // The host's other desktops (and VMs found there) and "Add a desktop behind…", one level down to keep the menu short.
        const choices = desktopChoices(this.desktop, pane, this.targets.cached(pane)?.label)
        if (choices.length) {
            items.push({ label: 'Desktops', submenu: choices })
        }
        if (this.desktop.isConnected(pane)) {
            items.push({ label: 'Send files…', click: () => this.desktop.sendFiles(pane) })
            items.push(...desktopActions(this.desktop, this.keyboard, pane))
            // Several desktops in this tab: paste on all of them, or type into all of them.
            const all = this.desktop.desktopsInTab(pane)
            if (all > 1) {
                items.push({ label: `Paste to all ${all} desktops in this tab`, click: () => this.desktop.pasteToAll(pane) })
                items.push({
                    type: 'checkbox',
                    label: `Type into all ${all} desktops in this tab`,
                    checked: this.desktop.isBroadcast(pane),
                    click: () => this.desktop.setBroadcast(pane, !this.desktop.isBroadcast(pane)),
                })
            }
        }
        if (this.desktop.desktopOf(pane)?.found) {
            items.push({ label: `Save ${this.desktop.desktopOf(pane)!.name} to this host's desktops`, click: () => this.desktop.saveFoundDesktop(pane) })
        }
        if (this.desktop.canSignInAgain(pane)) {
            items.push({ label: 'Sign in again…', click: () => this.desktop.signInAgain(pane) })
        }
        if (this.desktop.has(pane)) {
            items.push({ label: 'Disconnect', click: () => this.desktop.disconnect(pane) })
        }
        items.push({ label: 'Settings', submenu: settingsMenu(this.desktop, pane, this.help) })
        // Tabby can even out a split's panes but offers it nowhere; a grid of desktops wants it.
        const split = this.app.tabs.find(t => t instanceof SplitTabComponent && t.getAllTabs().includes(pane)) as SplitTabComponent | undefined
        if (split && split.getAllTabs().length > 1) {
            items.push({ label: 'Make panes even', click: () => { split.equalize(); split.layout() } })
        }
        return items
    }
}

/** Radio items for the `remoteDesktop` settings; shared by the context menus and the header button. */
export function settingsMenu (desktop: RemoteDesktopService, pane?: DesktopPane | null, help?: RemoteDesktopHelp): MenuItemOptions[] {
    const current = desktop.settings()
    const radio = <K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K], label: string): MenuItemOptions => ({
        type: 'radio',
        label,
        checked: current[key] === value,
        click: () => desktop.updateSettings({ [key]: value } as Partial<DesktopSettings>),
    })
    // A fixed resolution, scaled to fit the pane or shown at actual size.
    const fixed = (zoom: DesktopSettings['zoom'], label: string): MenuItemOptions => ({
        type: 'radio',
        label,
        checked: current.resize === 'off' && current.zoom === zoom,
        click: () => desktop.updateSettings({ resize: 'off', zoom }),
    })
    // The desktop open in this pane can have its own sharpness (for example, Retina for Windows only).
    const spec = pane ? desktop.desktopOf(pane) : null
    const own = pane ? desktop.ownSharpness(pane) : null
    const ownRadio = (value: DesktopSettings['sharpness'] | null, label: string): MenuItemOptions => ({
        type: 'radio',
        label,
        checked: own === value,
        click: () => desktop.setOwnSharpness(pane!, value),
    })
    const ownSharpness: MenuItemOptions[] = spec ? [
        { label: `For ${spec.name} only`, enabled: false },
        ownRadio(null, 'As above'),
        ownRadio('standard', 'Standard'),
        ownRadio('retina', 'Retina'),
    ] : []
    return [
        ...help ? [
            { label: 'All settings, keys and help…', click: () => help.open() },
            { type: 'separator' as const },
        ] : [],
        { label: 'When the pane is resized', enabled: false },
        radio('resize', 'live', 'Resize the remote desktop to fit'),
        radio('resize', 'reconnect', 'Reconnect at the new size'),
        fixed('fit', 'Keep the resolution (scale to fit)'),
        fixed('actual', 'Keep the resolution (actual size, scroll)'),
        { type: 'separator' },
        { label: 'Sharpness', enabled: false },
        radio('sharpness', 'standard', 'Standard'),
        radio('sharpness', 'retina', 'Retina (device pixels, remote scaled to match)'),
        ...ownSharpness,
        { type: 'separator' },
        {
            type: 'checkbox',
            label: 'Bring the console along with `desk` (installs a login hook; applies on the next desktop connect)',
            checked: current.desk,
            click: () => desktop.updateSettings({ desk: !current.desk }),
        },
        {
            type: 'checkbox',
            label: 'Play the remote desktop\'s sound (applies on the next connect)',
            checked: current.sound,
            click: () => desktop.updateSettings({ sound: !current.sound }),
        },
        {
            type: 'checkbox',
            label: 'Video decoding (H.264, hardware-accelerated where available; applies on the next connect)',
            checked: current.h264,
            click: () => desktop.updateSettings({ h264: !current.h264 }),
        },
        {
            type: 'checkbox',
            label: 'Send the microphone while an app on the remote desktop records (applies on the next connect)',
            checked: current.microphone,
            click: () => desktop.updateSettings({ microphone: !current.microphone }),
        },
        {
            type: 'checkbox',
            label: 'Show connection status on the desktop (throughput, frames per second, round trip)',
            checked: current.connectionStatus,
            click: () => desktop.updateSettings({ connectionStatus: !current.connectionStatus }),
        },
        ...process.platform === 'darwin' ? [{
            type: 'checkbox' as const,
            label: 'Mac shortcuts on the remote desktop (⌘C, ⌘V, ⌘Z… act as Ctrl+C, Ctrl+V…; off: ⌘ is the Windows key)',
            checked: current.macShortcuts,
            click: () => desktop.updateSettings({ macShortcuts: !current.macShortcuts }),
        }] : [],
        { type: 'separator' },
        { label: 'Import an .rdp file…', click: () => desktop.importRdpFile() },
        {
            // The form shows over a console (a remote desktop tab edits its desktop in Tabby's profile settings).
            label: 'Edit a desktop',
            enabled: !!pane && desktop.hasConsole(pane) && desktop.configuredDesktops().length > 0,
            submenu: desktop.configuredDesktops().map((d, i) => ({
                label: `${d.name ?? `${d.host}:${d.port}`} (behind ${d.via})…`,
                click: () => pane && desktop.editDesktop(pane, i),
            })),
        },
        {
            label: 'Remove a desktop',
            enabled: desktop.configuredDesktops().length > 0,
            submenu: desktop.configuredDesktops().map((d, i) => ({
                label: `${d.name ?? `${d.host}:${d.port}`} (behind ${d.via})…`,
                click: () => desktop.confirmRemoveDesktop(i),
            })),
        },
    ]
}

/** Adds a "Desktop" button to the SSH tab's floating toolbar, next to Reconnect / SFTP / Ports. */
@Injectable()
export class RemoteDesktopToolbarButton extends TerminalDecorator {
    constructor (private desktop: RemoteDesktopService, private zone: NgZone) {
        super()
    }

    override attach (terminal: BaseTerminalTabComponent<any>): void {
        if (!isSSHTab(terminal)) {
            return
        }
        const tab = terminal
        const root: HTMLElement = tab.element.nativeElement
        const insert = () => {
            const toolbar = root.querySelector('terminal-toolbar')
            if (!toolbar || toolbar.querySelector('.trd-toolbar-button')) {
                return !!toolbar
            }
            const button = document.createElement('button')
            button.className = 'btn btn-sm btn-link me-2 trd-toolbar-button'
            button.title = 'Switch between the remote desktop and the console'
            button.innerHTML = '<i class="fas fa-desktop"></i><span>Desktop</span>'
            button.addEventListener('click', () => this.zone.run(() => this.desktop.toggle(tab)))
            // Next to Reconnect / SFTP / Ports, which sit in a projected container inside the toolbar.
            const anchor = toolbar.querySelector('button .fa-redo')?.closest('button') ?? toolbar.querySelector('button')
            if (!anchor?.parentElement) {
                return false
            }
            anchor.parentElement.insertBefore(button, anchor)
            return true
        }
        if (insert()) {
            return
        }
        // The toolbar renders after the terminal attaches. Watch outside Angular's zone (see header.ts),
        // and give up after a while: the toolbar can be disabled in settings.
        this.zone.runOutsideAngular(() => {
            const observer = new MutationObserver(() => {
                if (insert()) {
                    observer.disconnect()
                }
            })
            observer.observe(root, { childList: true, subtree: true })
            setTimeout(() => observer.disconnect(), 30000)
            tab.destroyed$.subscribe(() => observer.disconnect())
        })
    }
}
