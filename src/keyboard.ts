import { Injectable, NgZone } from '@angular/core'
import { AppService, HotkeysService } from 'tabby-core'
import { RemoteDesktopService } from './desktop.service'
import { DesktopKind } from './desktops'
import { desktopPaneOf, DesktopPane } from './targets'

/**
 * Tabby shortcuts that keep working while a desktop covers the pane: getting back to the console, and moving
 * between tabs. Everything else (⌘W, ⌘T, ⌘V paste, …) belongs to the remote desktop then; Tabby would otherwise
 * act on the terminal underneath (⌘V pasted the Mac clipboard into the hidden SSH console).
 */
/** Modifier and lock keys: macOS does send their keyups, and they must stay down until then. */
const MODIFIERS = /^(Shift|Control|Alt|Meta|OS)(Left|Right)$|^(CapsLock|Fn|FnLock|NumLock|ScrollLock)$/

const TABBY_SHORTCUTS = new Set(['next-tab', 'previous-tab', 'next-mru-tab', 'previous-mru-tab', 'toggle-last-tab', 'toggle-fullscreen'])

/** A key combination for "Send keys": KeyboardEvent codes, pressed in this order and released in reverse. */
export interface KeyCombo {
    label: string
    codes: string[]
}

/**
 * "Send keys", per kind of desktop: combinations the local system keeps for itself (Ctrl+Alt+Del, Win+L) or that
 * are awkward to press from here. GNOME gets its own: Ctrl+Alt+Del only offers to log out there, and Super+L would
 * lock a headless session, whose password the user may not even have (SSH keys).
 */
export const SEND_KEYS: Record<DesktopKind, KeyCombo[]> = {
    windows: [
        { label: 'Ctrl+Alt+Del', codes: ['ControlLeft', 'AltLeft', 'Delete'] },
        { label: 'Windows key (Start)', codes: ['MetaLeft'] },
        { label: 'Win+R (Run)', codes: ['MetaLeft', 'KeyR'] },
        { label: 'Win+E (File Explorer)', codes: ['MetaLeft', 'KeyE'] },
        { label: 'Win+D (show the desktop)', codes: ['MetaLeft', 'KeyD'] },
        { label: 'Win+L (lock)', codes: ['MetaLeft', 'KeyL'] },
        { label: 'Alt+Tab', codes: ['AltLeft', 'Tab'] },
        { label: 'Alt+F4 (close the window)', codes: ['AltLeft', 'F4'] },
        { label: 'Ctrl+Shift+Esc (Task Manager)', codes: ['ControlLeft', 'ShiftLeft', 'Escape'] },
        { label: 'Print Screen', codes: ['PrintScreen'] },
    ],
    gnome: [
        { label: 'Super (Activities)', codes: ['MetaLeft'] },
        { label: 'Super+A (apps)', codes: ['MetaLeft', 'KeyA'] },
        { label: 'Super+V (notifications)', codes: ['MetaLeft', 'KeyV'] },
        { label: 'Alt+F2 (run a command)', codes: ['AltLeft', 'F2'] },
        { label: 'Alt+Tab', codes: ['AltLeft', 'Tab'] },
        { label: 'Alt+F4 (close the window)', codes: ['AltLeft', 'F4'] },
        { label: 'Print Screen (screenshot)', codes: ['PrintScreen'] },
    ],
}

/**
 * Routes the keyboard while a remote desktop has it:
 * - Tabby's hotkeys: only the desktop/console switch and TABBY_SHORTCUTS fire, and those don't reach the remote.
 * - Mac shortcuts (setting, on by default): ⌘ is sent as Ctrl, so ⌘C/⌘V/⌘Z/… do what they do on a Mac, and
 *   tapping ⌘ on its own is the Windows/Super key (Start, Activities). ⌃⌘+key is the Windows key with that key
 *   (Win+R, Win+E, …). Off: ⌘ is the Windows/Super key.
 * - View only (per desktop): no keys reach the remote.
 * - macOS sends no keyup for a key pressed while ⌘ is down; the remote gets one right after the keydown, so
 *   the key doesn't stay pressed there.
 */
@Injectable({ providedIn: 'root' })
export class DesktopKeyboard {
    /** The copies handed to IronRDP (they pass this module's window listener too). */
    private readonly copies = new WeakSet<Event>()
    /** The pane a key event started on: a Tabby shortcut (⌘1) can switch tabs before this module sees it. */
    private readonly startedOn = new WeakMap<Event, DesktopPane | null>()
    /** ⌘ is down and nothing else was pressed with it (a tap sends the Windows key). */
    private metaAlone = false

    constructor (
        private app: AppService,
        private hotkeys: HotkeysService,
        private desktop: RemoteDesktopService,
        private zone: NgZone,
    ) { }

    install (toggleHotkey: string): void {
        // Tabby matches hotkeys in a document listener; filter what it may match while a desktop covers the pane.
        const hotkeys = this.hotkeys as any
        const match = hotkeys.matchActiveHotkey?.bind(hotkeys)
        if (typeof match === 'function') {
            hotkeys.matchActiveHotkey = (partial?: boolean) => {
                const id: string | null = match(partial)
                if (id && this.coveredPane() && id !== toggleHotkey && !TABBY_SHORTCUTS.has(id) && !/^tab-\d+$/.test(id)) {
                    return null
                }
                return id
            }
        }
        // On window: after Tabby's hotkey listener (on document, registered once Tabby's config has loaded,
        // which can be after this) and, registered at startup, before IronRDP's (window, per desktop).
        this.zone.runOutsideAngular(() => {
            for (const type of ['keydown', 'keyup'] as const) {
                window.addEventListener(type, event => this.startedOn.set(event, this.coveredPane()), true)
                window.addEventListener(type, event => this.copies.has(event) || this.route(event))
            }
        })
    }

    /** The active pane, while a desktop (or its sign-in or add form) covers it. */
    private coveredPane (): DesktopPane | null {
        const pane = desktopPaneOf(this.app.activeTab)
        if (!pane) {
            return null
        }
        return this.desktop.isVisible(pane) || pane.element.nativeElement.querySelector('.trd-form-overlay') ? pane : null
    }

    private route (event: KeyboardEvent): void {
        const pane = this.startedOn.has(event) ? this.startedOn.get(event) : this.coveredPane()
        const focused = document.activeElement
        if (!pane || focused?.tagName !== 'IRON-REMOTE-DESKTOP' || !pane.element.nativeElement.contains(focused)) {
            return
        }
        // A Tabby shortcut Tabby just acted on: not for the remote.
        if (event.type === 'keydown' && (this.hotkeys as any).pressedHotkey) {
            this.metaAlone = false
            event.stopImmediatePropagation()
            event.preventDefault()
            return
        }
        if (this.desktop.isViewOnly(pane)) {
            this.metaAlone = false
            event.stopImmediatePropagation()
            event.preventDefault()
            return
        }
        const isMeta = event.code === 'MetaLeft' || event.code === 'MetaRight'
        const macShortcuts = process.platform === 'darwin' && this.desktop.settings().macShortcuts
        if (macShortcuts && event.metaKey && event.ctrlKey && !MODIFIERS.test(event.code)) {
            // ⌃⌘+key: the Windows key with that key. With ⌘ sent as Ctrl, ⌃⌘ would only mean Ctrl again, so
            // nothing is lost, and macOS keeps few ⌃⌘ shortcuts for itself.
            event.stopImmediatePropagation()
            event.preventDefault()
            if (event.type === 'keydown') {
                this.metaAlone = false
                // Ctrl is down on the remote (⌃, and ⌘ sent as Ctrl): let go of it, or this would be Ctrl+Win+key.
                // Releasing a key that isn't down sends nothing.
                for (const code of ['ControlLeft', 'ControlRight']) {
                    this.forward(event, { key: 'Control', code, plain: true }, 'keyup')
                }
                const win = { key: 'Meta', code: 'MetaLeft', plain: true }
                this.forward(event, win, 'keydown')
                this.forward(event, { plain: true }, 'keydown')
                // The keyup macOS won't send while ⌘ is down; if one does come, it is dropped here.
                this.forward(event, { plain: true }, 'keyup')
                this.forward(event, win, 'keyup')
            }
            return
        }
        if (macShortcuts && (isMeta || event.metaKey)) {
            // Replace the event for IronRDP: ⌘ becomes Ctrl.
            event.stopImmediatePropagation()
            event.preventDefault()
            if (event.type === 'keydown') {
                this.metaAlone = isMeta && !event.repeat ? true : isMeta && this.metaAlone
            }
            this.forward(event, isMeta ? { key: 'Control', code: event.code === 'MetaRight' ? 'ControlRight' : 'ControlLeft' } : {})
            if (isMeta && event.type === 'keyup' && this.metaAlone) {
                // ⌘ tapped on its own: the Windows key.
                this.metaAlone = false
                const win = { key: 'Meta', code: event.code === 'MetaRight' ? 'MetaRight' : 'MetaLeft', plain: true }
                this.forward(event, win, 'keydown')
                this.forward(event, win, 'keyup')
            }
            if (event.type === 'keydown' && !MODIFIERS.test(event.code)) {
                this.forward(event, {}, 'keyup')
            }
            return
        }
        if (process.platform === 'darwin' && event.type === 'keydown' && event.metaKey && !MODIFIERS.test(event.code)) {
            // ⌘ stays the Windows key: IronRDP gets this keydown as is, plus the keyup macOS won't send.
            setTimeout(() => this.forward(event, {}, 'keyup'))
        }
    }

    /** Hands IronRDP (its listeners are on window) a copy of the event, with ⌘ mapped to Ctrl when asked. */
    private forward (event: KeyboardEvent, change: { key?: string, code?: string, plain?: boolean }, type: string = event.type): void {
        // `plain`: send the key as is (the Windows key for a ⌘ tap), not mapped.
        const macShortcuts = process.platform === 'darwin' && this.desktop.settings().macShortcuts && !change.plain
        const copy = new KeyboardEvent(type, {
            key: change.key ?? event.key,
            code: change.code ?? event.code,
            location: event.location,
            repeat: event.repeat,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            ctrlKey: macShortcuts ? event.ctrlKey || event.metaKey : event.ctrlKey,
            metaKey: macShortcuts ? false : event.metaKey,
            cancelable: true,
        })
        this.copies.add(copy)
        window.dispatchEvent(copy)
    }

    /** "Send keys": presses a combination on the pane's desktop (showing it, if hidden). */
    async send (pane: DesktopPane, combo: KeyCombo): Promise<void> {
        // IronRDP only takes keys while it has focus, and they go through its window listeners like typed ones.
        if (!await this.desktop.takeKeyboard(pane)) {
            return
        }
        const press = (type: string, code: string) => {
            // IronRDP sends the scancode for `code`; `key` only matters in its Unicode mode, which is off.
            const copy = new KeyboardEvent(type, { key: code.replace(/^Key|(Left|Right)$/g, ''), code, cancelable: true })
            this.copies.add(copy)
            window.dispatchEvent(copy)
        }
        combo.codes.forEach(code => press('keydown', code))
        ;[...combo.codes].reverse().forEach(code => press('keyup', code))
        this.desktop.logOf(pane).push(`keys: sent ${combo.label}`)
    }
}
