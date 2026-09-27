import { Injector, NgModule } from '@angular/core'
import {
    AppService, ConfigProvider, HotkeyProvider, HotkeysService, ProfileProvider, TabContextMenuItemProvider, TabRecoveryProvider,
} from 'tabby-core'
import { TerminalDecorator } from 'tabby-terminal'
import { installStyle, RemoteDesktopService } from './desktop.service'
import { DeskTriggerDecorator } from './desk'
import { HeaderControls } from './header'
import { DesktopKeyboard } from './keyboard'
import { RDPProfileOpener, RDPProfileSettingsComponent, RDPProfilesService, RDPTabComponent, RDPTabRecovery } from './rdpProfile'
import { execRemote } from './ssh'
import { desktopPaneOf, RemoteTargets } from './targets'
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
    ],
    declarations: [RDPTabComponent, RDPProfileSettingsComponent],
})
export default class RemoteDesktopModule {
    constructor (app: AppService, hotkeys: HotkeysService, desktop: RemoteDesktopService, header: HeaderControls, targets: RemoteTargets, keyboard: DesktopKeyboard, injector: Injector) {
        installStyle()
        header.install()
        keyboard.install(TOGGLE_HOTKEY)
        hotkeys.hotkey$.subscribe((id: string) => {
            if (id !== TOGGLE_HOTKEY) {
                return
            }
            const pane = desktopPaneOf(app.activeTab)
            if (pane) {
                desktop.toggle(pane)
            }
        })
        // Handle for tests and troubleshooting from DevTools.
        const w = window as any
        w.__remoteDesktop = { app, desktop, targets, desktopPaneOf, injector, execRemote }
    }
}
