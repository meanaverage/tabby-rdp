import { Injector, NgModule } from '@angular/core'
import {
    AppService, CommandProvider, ConfigProvider, HotkeyProvider, HotkeysService, ProfileProvider, TabContextMenuItemProvider,
    TabRecoveryProvider, VaultService,
} from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'
import { installStyle, RemoteDesktopService } from './desktop.service'
import { DeskTriggerDecorator } from './desk'
import { HeaderControls } from './header'
import { DesktopKeyboard } from './keyboard'
import { RemoteDesktopHelp } from './help'
import { useVault } from './signin'
import { parseRdpFile } from './rdpFile'
import {
    RDPCommands, RDPProfileOpener, RDPProfileSettingsComponent, RDPProfilesService, RDPTabComponent, RDPTabRecovery,
} from './rdpProfile'
import { RemoteDesktopSettingsComponent, RemoteDesktopSettingsTab } from './settingsPage'
import { UpdateCheck } from './updates'
import { execRemote } from './ssh'
import { DesktopPane, desktopPaneOf, RemoteTargets } from './targets'
import {
    RemoteDesktopConfig, RemoteDesktopContextMenu, RemoteDesktopHotkeys, RemoteDesktopToolbarButton, TOGGLE_HOTKEY,
} from './ui'

@NgModule({
    providers: [
        { provide: HotkeyProvider, useClass: RemoteDesktopHotkeys, multi: true },
        { provide: ConfigProvider, useClass: RemoteDesktopConfig, multi: true },
        { provide: TabContextMenuItemProvider, useClass: RemoteDesktopContextMenu, multi: true },
        { provide: TerminalDecorator, useClass: RemoteDesktopToolbarButton, multi: true },
        { provide: TerminalDecorator, useClass: DeskTriggerDecorator, multi: true },
        // "Remote desktop (RDP)" profiles and their tabs.
        { provide: ProfileProvider, useExisting: RDPProfilesService, multi: true },
        { provide: TabRecoveryProvider, useClass: RDPTabRecovery, multi: true },
        { provide: TerminalDecorator, useClass: RDPProfileOpener, multi: true },
        { provide: CommandProvider, useClass: RDPCommands, multi: true },
        // Settings › Remote Desktop: settings, getting started, keys, troubleshooting.
        { provide: SettingsTabProvider, useClass: RemoteDesktopSettingsTab, multi: true },
    ],
    declarations: [RDPTabComponent, RDPProfileSettingsComponent, RemoteDesktopSettingsComponent],
})
export default class RemoteDesktopModule {
    constructor (app: AppService, hotkeys: HotkeysService, desktop: RemoteDesktopService, header: HeaderControls, targets: RemoteTargets, keyboard: DesktopKeyboard, injector: Injector) {
        installStyle()
        header.install()
        // Passwords go to Tabby's Vault while it is enabled (as Tabby's SSH passwords do), else to the system keychain.
        try { useVault(injector.get(VaultService)) } catch { }
        injector.get(UpdateCheck).start()
        keyboard.install()
        // The plugin's hotkeys (see HOTKEYS in help.ts) act on the active tab's desktop.
        const actions: Record<string, (pane: DesktopPane) => void> = {
            [TOGGLE_HOTKEY]: pane => desktop.toggle(pane),
            'remote-desktop-view-only': pane => desktop.setViewOnly(pane, !desktop.isViewOnly(pane)),
            'remote-desktop-screenshot': pane => desktop.saveScreenshot(pane),
            'remote-desktop-ctrl-alt-del': pane => keyboard.send(pane, { label: 'Ctrl+Alt+Del', codes: ['ControlLeft', 'AltLeft', 'Delete'] }),
            'remote-desktop-type-into-all': pane => desktop.setBroadcast(pane, !desktop.isBroadcast(pane)),
            'remote-desktop-paste-to-all': pane => desktop.pasteToAll(pane),
            'remote-desktop-connection-status': () => desktop.updateSettings({ connectionStatus: !desktop.settings().connectionStatus }),
            'remote-desktop-disconnect': pane => desktop.disconnect(pane),
        }
        hotkeys.hotkey$.subscribe((id: string) => {
            // Tabby fires any key bound under `hotkeys` in the config ('constructor' too): the table's own entries only.
            const action = Object.prototype.hasOwnProperty.call(actions, id) ? actions[id] : undefined
            const pane = action && desktopPaneOf(app.activeTab)
            if (!action || !pane) {
                return
            }
            // The switch works without a desktop open (it opens one); the rest act on an open desktop.
            if (id === TOGGLE_HOTKEY || desktop.has(pane)) {
                action(pane)
            }
        })
        // Handle for tests and troubleshooting from DevTools.
        const w = window as any
        w.__remoteDesktop = { app, desktop, targets, desktopPaneOf, injector, execRemote, parseRdpFile, help: injector.get(RemoteDesktopHelp), updates: injector.get(UpdateCheck) }
    }
}
