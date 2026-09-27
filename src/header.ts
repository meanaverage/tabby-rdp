import { Injectable, NgZone } from '@angular/core'
import { AppService, MenuItemOptions, PlatformService } from 'tabby-core'
import { RemoteDesktopService } from './desktop.service'
import { DesktopKeyboard } from './keyboard'
import { isSSHTab } from './ssh'
import { desktopPaneOf, RemoteTargets } from './targets'
import { desktopActions, desktopChoices, settingsMenu, toggleLabel } from './ui'

// Font Awesome Free 6.7.2 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free
// (Icons: CC BY 4.0) Copyright 2024 Fonticons, Inc.
const ICON_DESKTOP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path fill="currentColor" d="M64 0C28.7 0 0 28.7 0 64L0 352c0 35.3 28.7 64 64 64l176 0-10.7 32L160 448c-17.7 0-32 14.3-32 32s14.3 32 32 32l256 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-69.3 0L336 416l176 0c35.3 0 64-28.7 64-64l0-288c0-35.3-28.7-64-64-64L64 0zM512 64l0 224L64 288 64 64l448 0z"/></svg>'
const ICON_TERMINAL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><path fill="currentColor" d="M9.4 86.6C-3.1 74.1-3.1 53.9 9.4 41.4s32.8-12.5 45.3 0l192 192c12.5 12.5 12.5 32.8 0 45.3l-192 192c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L178.7 256 9.4 86.6zM256 416l288 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-288 0c-17.7 0-32-14.3-32-32s14.3-32 32-32z"/></svg>'
const ICON_DISCONNECT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M64 80c-8.8 0-16 7.2-16 16l0 320c0 8.8 7.2 16 16 16l384 0c8.8 0 16-7.2 16-16l0-320c0-8.8-7.2-16-16-16L64 80zM0 96C0 60.7 28.7 32 64 32l384 0c35.3 0 64 28.7 64 64l0 320c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96zm175 79c9.4-9.4 24.6-9.4 33.9 0l47 47 47-47c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-47 47 47 47c9.4 9.4 9.4 24.6 0 33.9s-24.6 9.4-33.9 0l-47-47-47 47c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l47-47-47-47c-9.4-9.4-9.4-24.6 0-33.9z"/></svg>'

/**
 * Desktop/console switch and Disconnect in Tabby's header, left of the settings gear, for the active
 * tab's SSH pane. Tabby builds its own header buttons once at startup, so these are plain DOM kept in
 * sync with the active tab and the desktop state.
 */
@Injectable({ providedIn: 'root' })
export class HeaderControls {
    private group: HTMLElement | null = null
    private toggleButton!: HTMLButtonElement
    private disconnectButton!: HTMLButtonElement
    private scheduled = false

    constructor (
        private app: AppService,
        private desktop: RemoteDesktopService,
        private targets: RemoteTargets,
        private platform: PlatformService,
        private keyboard: DesktopKeyboard,
        private zone: NgZone,
    ) { }

    // All watching and DOM syncing runs outside Angular's zone: inside it, every observer callback and
    // animation frame triggers app-wide change detection, whose DOM updates re-trigger the observer
    // (an endless loop while no header group can be found, e.g. on the start page with no tabs open).
    // Only user actions re-enter the zone, so Tabby's UI updates for tab switches.
    install (): void {
        this.zone.runOutsideAngular(() => {
            this.app.activeTabChange$.subscribe(() => this.schedule())
            this.desktop.changed$.subscribe(() => this.schedule())
            // Focus moves between panes of a split without an activeTabChange$.
            document.addEventListener('focusin', () => this.schedule(), true)
            // The header renders after plugins load, and is re-rendered when the layout changes.
            new MutationObserver(() => {
                if (!this.group?.isConnected) {
                    this.schedule()
                }
            }).observe(document.body, { childList: true, subtree: true })
            // A local terminal qualifies once `ssh` runs in it (and stops when it exits): keep checking the active one.
            this.app.activeTabChange$.subscribe(() => this.detect())
            setInterval(() => this.detect(), 2000)
            this.schedule()
        })
    }

    private async detect (): Promise<void> {
        const pane = desktopPaneOf(this.app.activeTab)
        if (!pane) {
            return
        }
        await this.targets.targetOf(pane)
        this.schedule()
    }

    private schedule (): void {
        if (this.scheduled) {
            return
        }
        this.scheduled = true
        // A timer, not requestAnimationFrame: Chromium stops animation frames while the window is hidden.
        this.zone.runOutsideAngular(() => setTimeout(() => {
            this.scheduled = false
            this.refresh()
        }, 16))
    }

    private ensureGroup (): boolean {
        if (this.group?.isConnected) {
            return true
        }
        // The right-hand header group: settings gear (and update button).
        const right = document.querySelector('app-root .btn-space ~ .btn-group')
        if (!right) {
            return false
        }
        // Tabby's header button styles are scoped to its root component; borrow its scope attribute.
        const reference = right.querySelector('button.btn-tab-bar')
        const scope = reference ? Array.from(reference.attributes).filter(a => a.name.startsWith('_ngcontent')) : []
        const scoped = <T extends HTMLElement>(el: T) => {
            scope.forEach(a => el.setAttribute(a.name, a.value))
            return el
        }
        const button = (cls: string, onClick: () => void) => {
            const b = scoped(document.createElement('button'))
            b.className = `btn btn-secondary btn-tab-bar ${cls}`
            b.addEventListener('click', () => this.zone.run(onClick))
            return b
        }
        this.group = scoped(document.createElement('div'))
        // Inline flex, not Bootstrap's d-flex: that is `display: flex !important` and can't be hidden.
        this.group.className = 'trd-header'
        this.group.style.display = 'flex'
        this.toggleButton = button('trd-header-toggle', () => {
            const pane = desktopPaneOf(this.app.activeTab)
            if (pane) {
                this.desktop.toggle(pane)
            }
        })
        this.disconnectButton = button('trd-header-disconnect', () => {
            const pane = desktopPaneOf(this.app.activeTab)
            if (pane) {
                this.desktop.disconnect(pane)
            }
        })
        this.toggleButton.addEventListener('contextmenu', event => {
            event.preventDefault()
            this.zone.run(() => {
                const pane = desktopPaneOf(this.app.activeTab)
                const choices = pane ? [
                    ...desktopChoices(this.desktop, pane, this.targets.cached(pane)?.label),
                    ...desktopActions(this.desktop, this.keyboard, pane),
                ] : []
                const settings: MenuItemOptions = { label: 'Remote desktop settings', submenu: settingsMenu(this.desktop, pane) }
                this.platform.popupContextMenu(choices.length ? [...choices, { type: 'separator' }, settings] : settingsMenu(this.desktop, pane), event)
            })
        })
        this.disconnectButton.title = 'Disconnect remote desktop'
        this.disconnectButton.innerHTML = ICON_DISCONNECT
        this.group.append(this.toggleButton, this.disconnectButton)
        right.insertBefore(this.group, right.firstChild)
        return true
    }

    private refresh (): void {
        if (!this.ensureGroup()) {
            return
        }
        let pane = desktopPaneOf(this.app.activeTab)
        // SSH tabs always qualify; local terminals only while they run ssh (see detect()).
        if (pane && !isSSHTab(pane) && !this.desktop.has(pane) && !this.targets.cached(pane)) {
            pane = null
        }
        this.group!.style.display = pane ? 'flex' : 'none'
        if (!pane) {
            return
        }
        const visible = this.desktop.isVisible(pane)
        // None while a remote desktop tab shows its desktop: there is no console to switch to.
        const title = toggleLabel(this.desktop, pane)
        this.toggleButton.style.display = title ? '' : 'none'
        if (title && this.toggleButton.title !== title) {
            this.toggleButton.title = title
            this.toggleButton.innerHTML = visible ? ICON_TERMINAL : ICON_DESKTOP
        }
        this.disconnectButton.style.display = this.desktop.has(pane) ? '' : 'none'
    }
}
