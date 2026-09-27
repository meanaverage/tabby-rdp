import { Injectable, NgZone } from '@angular/core'
import {
    BaseTabComponent, ConfigProvider, HotkeyDescription, HotkeyProvider, MenuItemOptions, Platform, SplitTabComponent,
    TabContextMenuItemProvider,
} from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'
import { DesktopSettings, RemoteDesktopService } from './desktop.service'
import { isSSHTab } from './ssh'
import { DesktopPane, desktopPaneOf, RemoteTargets } from './targets'

export const TOGGLE_HOTKEY = 'remote-desktop-toggle'

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
            // More desktops behind SSH hosts (e.g. a Windows VM whose RDP port the host forwards); see desktops.ts.
            desktops: [],
            // Sharpness for particular desktops, overriding `sharpness`: [{ desktop: <session key>, sharpness }].
            desktopSharpness: [],
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
        label: desktop.isOpenElsewhere(pane, spec) ? `Switch to ${spec.name} (open in another tab)` : `Open ${spec.name}`,
        click: () => desktop.showDesktop(pane, spec.id),
    }))
    // Not in a remote desktop tab: it isn't an SSH host.
    if (targetLabel && desktop.hasConsole(pane)) {
        items.push({ label: `Add a desktop behind ${targetLabel}…`, click: () => desktop.addDesktop(pane) })
    }
    return items
}

/** Tab header menu (whole tab: its focused pane) and in-terminal menu (that pane). */
@Injectable()
export class RemoteDesktopContextMenu extends TabContextMenuItemProvider {
    override weight = 6

    constructor (private desktop: RemoteDesktopService, private targets: RemoteTargets) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        // For a header right-click Tabby asks the top-level tab and then its focused pane; answer once.
        if (tabHeader && tab.parent instanceof SplitTabComponent) {
            return []
        }
        const pane = desktopPaneOf(tab)
        // Local terminals qualify only while they run ssh.
        if (!pane || !this.desktop.has(pane) && !await this.targets.targetOf(pane)) {
            return []
        }
        const toggle = toggleLabel(this.desktop, pane)
        const items: MenuItemOptions[] = [
            ...toggle ? [{ label: toggle, click: () => this.desktop.toggle(pane) }] : [],
            ...desktopChoices(this.desktop, pane, this.targets.cached(pane)?.label),
        ]
        if (this.desktop.isConnected(pane)) {
            items.push({ label: 'Send files to the remote desktop…', click: () => this.desktop.sendFiles(pane) })
        }
        if (this.desktop.has(pane)) {
            items.push({ label: 'Disconnect remote desktop', click: () => this.desktop.disconnect(pane) })
        }
        items.push({ label: 'Remote desktop settings', submenu: settingsMenu(this.desktop, pane) })
        return items
    }
}

/** Radio items for the `remoteDesktop` settings; shared by the context menus and the header button. */
export function settingsMenu (desktop: RemoteDesktopService, pane?: DesktopPane | null): MenuItemOptions[] {
    const current = desktop.settings()
    const radio = <K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K], label: string): MenuItemOptions => ({
        type: 'radio',
        label,
        checked: current[key] === value,
        click: () => desktop.updateSettings({ [key]: value } as Partial<DesktopSettings>),
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
        { label: 'When the pane is resized', enabled: false },
        radio('resize', 'live', 'Resize the remote desktop to fit'),
        radio('resize', 'reconnect', 'Reconnect at the new size'),
        radio('resize', 'off', 'Keep the resolution (scale to fit)'),
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
                label: `${d.name ?? `${d.host}:${d.port}`} (behind ${d.via})`,
                click: () => desktop.removeDesktop(i),
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
