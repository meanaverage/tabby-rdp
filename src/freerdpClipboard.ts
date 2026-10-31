import { ClipboardMode, ClipboardWays } from './clipboard'

/** The log line for the clipboard a FreeRDP connection was set up with (IronRDP's says the same of pictures and files). */
export function freeRDPClipboardLog (mode: ClipboardMode): string {
    return `clipboard: ${mode === 'both' ? 'both ways' : mode === 'fromRemote' ? 'only from the remote desktop (this computer\'s is neither read nor sent)'
        : 'off (no clipboard channel)'}${mode === 'off' ? '' : '; FreeRDP shares text only'}`
}

/**
 * Text through FreeRDP's clipboard channel: the helper's 'P' message offers this computer's text to the server, and 'T'
 * brings what the server's clipboard gets. As IronRDP's component does (see clipboard.ts), this computer's clipboard
 * is read only while the desktop has the keyboard, every 100 ms, and only a change is sent; what comes from the server
 * is written here and remembered, so that it isn't sent straight back. The ways are asked on every turn, so a
 * narrowing while connected (see RemoteDesktopService.applyClipboard) stops the sending at once. Pictures and files
 * don't go through FreeRDP.
 */
export class FreeRDPClipboard {
    private last: string | undefined
    private readonly timer: ReturnType<typeof setInterval>

    constructor (
        private readonly io: { read: () => string, write: (text: string) => void, send: (text: string) => void },
        private readonly ways: () => ClipboardWays,
        private readonly hasKeyboard: () => boolean,
        interval = 100,
    ) {
        this.timer = setInterval(() => this.poll(), interval)
    }

    /** Sends this computer's clipboard text when it changed, if it may go and the desktop has the keyboard. */
    poll (): void {
        if (!this.ways().toRemote || !this.hasKeyboard()) {
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

    /** Text the server's clipboard got: written here, if it may come. */
    remote (text: string): void {
        if (!this.ways().fromRemote) {
            return
        }
        this.last = text
        this.io.write(text)
    }

    stop (): void {
        clearInterval(this.timer)
    }
}
