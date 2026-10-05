/**
 * Clipboard sharing with remote desktops: the ways the clipboard goes (the setting `clipboard`, or a desktop's own),
 * and IronRDP's component set up for them before each connection.
 *
 * While a desktop has the keyboard, the component reads this computer's clipboard every 100 ms and announces what
 * changed to the server, and it writes what the server's clipboard gets to this one; files go through the same
 * channel (CLIPRDR, see fileTransfer.ts). What the component lets the plugin enforce:
 * - Off: the component's clipboard turned off, so IronRDP leaves the clipboard channel out of the connection (it
 *   attaches CLIPRDR only with the clipboard callbacks the component hands it). Nothing goes either way, files
 *   included, and this computer's clipboard isn't read.
 * - Only from the remote desktop: the reading stopped through the hook the component composes into the file transfer
 *   provider (`onUploadStarted`, which it has to keep the reading from overwriting a paste of files), with the
 *   matching `onUploadFinished` held back so that nothing starts it again. A server connected this way only ever
 *   gets an empty clipboard from this side (one narrowed to it while connected gets that in full from its next
 *   connection: see RemoteDesktopService.applyClipboard); the plugin's own sending (paste to all, files) checks the
 *   ways as well.
 * The other way only, from this computer to the remote desktop, isn't offered.
 */

/** The ways the clipboard can go between this computer and a remote desktop. */
export type ClipboardMode = 'both' | 'fromRemote' | 'off'

/** The modes, in the order the settings page, the forms and the menus offer them. */
export const CLIPBOARD_LABELS: Record<ClipboardMode, string> = {
    both: 'Both ways',
    fromRemote: 'Only from the remote desktop to this computer',
    off: 'Off',
}

/**
 * A desktop's own mode (its entry's or profile's `clipboard`): none when unset or empty, so the setting applies. A
 * value the plugin doesn't know (one written by hand, say) is off: what limits the clipboard must never end up
 * letting more through than it says.
 */
export function ownClipboard (value: unknown): ClipboardMode | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined
    }
    return value === 'both' || value === 'fromRemote' || value === 'off' ? value : 'off'
}

/** The setting's mode: both ways when unset (the default, and how the clipboard always went), else as ownClipboard. */
export function clipboardSetting (value: unknown): ClipboardMode {
    return ownClipboard(value) ?? 'both'
}

/** Which ways the clipboard goes. */
export interface ClipboardWays {
    /** This computer's clipboard (text, pictures, files) to the remote desktop. */
    toRemote: boolean
    /** The remote desktop's clipboard to this computer's. */
    fromRemote: boolean
}

/** The ways that every one of the modes lets the clipboard go. */
export function clipboardWays (...modes: ClipboardMode[]): ClipboardWays {
    return {
        toRemote: modes.every(mode => mode === 'both'),
        fromRemote: modes.every(mode => mode !== 'off'),
    }
}

/** The mode that lets the clipboard go only the ways every one of the modes does. */
export function narrowest (...modes: ClipboardMode[]): ClipboardMode {
    const ways = clipboardWays(...modes)
    return ways.toRemote && ways.fromRemote ? 'both' : ways.fromRemote ? 'fromRemote' : 'off'
}

/** What setUpClipboard uses of IronRDP's component (its `irgUserInteraction`). */
export interface ClipboardComponent {
    enableFileTransfer (provider: ClipboardProvider): unknown
    setEnableClipboard (enable: boolean): void
}

/** What setUpClipboard uses of the file transfer provider (IronRDP's RdpFileTransferProvider). */
export interface ClipboardProvider {
    onUploadStarted?: () => void
    onUploadFinished?: () => void
}

export interface ClipboardSetUp {
    /** What the connection is set up with: the mode asked for, or off when the component can't do that. */
    mode: ClipboardMode
    /** Stops the component's reading of this computer's clipboard; it stays stopped while `sending` says no. */
    stopSending: () => void
}

/**
 * Sets up the component's clipboard for `mode`, before connect(): registers the provider (files through the
 * clipboard) and turns off what the mode doesn't allow. `sending` says whether this computer's clipboard may still go
 * to the desktop: while it may, a paste of files ends with the component's reading started again, as usual.
 */
export function setUpClipboard (ui: ClipboardComponent, provider: ClipboardProvider, mode: ClipboardMode, sending: () => boolean): ClipboardSetUp {
    if (typeof ui.setEnableClipboard !== 'function') {
        throw new Error('this build of IronRDP can\'t turn its clipboard off')
    }
    // Registering the provider is what composes the hooks, and it turns the component's clipboard on: whatever is turned
    // off comes after it.
    const own = provider.onUploadStarted
    ui.enableFileTransfer(provider)
    const stop = provider.onUploadStarted
    const resume = provider.onUploadFinished
    // Without the hooks composed (a component that doesn't), its reading can't be stopped: nothing goes either way.
    const applied: ClipboardMode = typeof stop === 'function' && typeof resume === 'function' && stop !== own ? mode : 'off'
    provider.onUploadFinished = () => {
        if (sending()) {
            resume?.call(provider)
        }
    }
    const stopSending = () => stop?.call(provider)
    if (applied !== 'both') {
        stopSending()
    }
    if (applied === 'off') {
        ui.setEnableClipboard(false)
    }
    return { mode: applied, stopSending }
}

/** A paste to all desktops in a tab (see RemoteDesktopService.pasteToAll), split by where this computer's clipboard goes. */
export interface PasteSplit<T> {
    /** The desktops it goes to: each gets it, then Ctrl+V. */
    targets: T[]
    /** The others: nothing goes to them, not even Ctrl+V, which would paste what they have instead. */
    left: T[]
    /** What to say about those left out, naming them; null when none is. */
    note: string | null
}

/** Splits a paste to all desktops by the ways the clipboard goes with each one now (`waysOf`). */
export function splitPaste<T> (desktops: T[], waysOf: (desktop: T) => ClipboardWays, nameOf: (desktop: T) => string): PasteSplit<T> {
    const taking = desktops.map(desktop => waysOf(desktop).toRemote)
    const targets = desktops.filter((_, i) => taking[i])
    const left = desktops.filter((_, i) => !taking[i])
    if (!left.length) {
        return { targets, left, note: null }
    }
    const names = left.map(nameOf)
    const which = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
    const note = targets.length
        ? `Pasting on ${targets.length} of ${desktops.length} desktops: not on ${which}, which ${left.length > 1 ? 'don\'t' : 'doesn\'t'} take this computer's clipboard.`
        : `Not pasted: ${desktops.length > 1 ? 'these desktops don\'t' : 'this desktop doesn\'t'} take this computer's clipboard.`
    return { targets, left, note }
}
