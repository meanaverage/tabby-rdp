import { ClipboardMode, ClipboardWays } from './clipboard'

/** The log line for the clipboard a FreeRDP connection was set up with (IronRDP's says the same of pictures and files). */
export function freeRDPClipboardLog (mode: ClipboardMode): string {
    return `clipboard: ${mode === 'both' ? 'both ways' : mode === 'fromRemote' ? 'only from the remote desktop (this computer\'s is neither read nor sent)'
        : 'off (no clipboard channel)'}${mode === 'off' ? '' : '; FreeRDP shares text only'}`
}

/**
 * Text through FreeRDP's clipboard channel: the helper's 'P' message offers this computer's text to the server, and 'T'
 * brings what the server's clipboard gets. As IronRDP's component does (see clipboard.ts), the clipboard goes only
 * while the desktop has the focus (and Tabby is the app in front): this computer's is read then, every 100 ms, and only
 * a change is sent; what the server's gets is written here then, or, from a desktop without the focus, the latest of
 * it once it has the focus again; and it is remembered, so that it isn't sent straight back. A desktop in the
 * background can't change this computer's clipboard. In view only no clipboard goes either way, and what the desktop's
 * clipboard gets meanwhile is dropped.
 *
 * The ways are asked on every turn: a narrowing while connected (see RemoteDesktopService.applyClipboard) stops the
 * sending at once, and is passed on to the helper (`narrow`), which drops what it was holding for the server.
 * Nothing is read before `start`, once the connection is up. Pictures and files don't go through FreeRDP.
 */
export class FreeRDPClipboard {
    private last: string | undefined
    private pending: string | undefined
    private timer: ReturnType<typeof setInterval> | undefined
    private told: ClipboardWays

    constructor (
        private readonly io: { read: () => string, write: (text: string) => void, send: (text: string) => void, narrow: (ways: ClipboardWays) => void },
        private readonly ways: () => ClipboardWays,
        /** `focused`: the desktop has the focus; `viewOnly`: it is in view only. */
        private readonly focus: { focused: () => boolean, viewOnly: () => boolean },
        private readonly interval = 100,
    ) {
        // The ways the connection was set up with, which the helper has.
        this.told = ways()
    }

    /** Starts the turns, once the connection is up. */
    start (): void {
        this.timer ??= setInterval(() => this.poll(), this.interval)
    }

    /** One turn: passes a narrowing on, then, with the focus, writes what came and sends what changed here. */
    poll (): void {
        const ways = this.ways()
        if (ways.toRemote !== this.told.toRemote || ways.fromRemote !== this.told.fromRemote) {
            this.told = ways
            this.io.narrow(ways)
        }
        if (this.focus.viewOnly()) {
            this.pending = undefined
            return
        }
        if (!this.focus.focused()) {
            return
        }
        if (this.pending !== undefined) {
            const text = this.pending
            this.pending = undefined
            if (ways.fromRemote) {
                this.last = text
                this.io.write(text)
            }
        }
        if (!ways.toRemote) {
            return
        }
        let text: string
        try {
            text = this.io.read()
        } catch {
            return
        }
        if (text !== this.last) {
            this.last = text
            this.io.send(text)
        }
    }

    /** Text the server's clipboard got, if it may come: written here now with the focus, else once it has it. */
    remote (text: string): void {
        if (!this.ways().fromRemote || this.focus.viewOnly()) {
            return
        }
        if (this.focus.focused()) {
            this.pending = undefined
            this.last = text
            this.io.write(text)
        } else {
            this.pending = text
        }
    }

    stop (): void {
        clearInterval(this.timer)
        this.timer = undefined
    }
}
