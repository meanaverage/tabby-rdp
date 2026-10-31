import { FreeRDPProcess, NativeFrame, numbers } from './freerdp'

/** RDP set-1 scan codes (FreeRDP scancode.h / Chromium dom_code_data.inc). Ninth bit: KBDEXT. */
const SCANS: Record<string, number> = {
    Escape: 0x01, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
    BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
    Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
    Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37,
    AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, NumLock: 0x45, ScrollLock: 0x46,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
    Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
    Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
    IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEnter: 0x11c,
    ControlRight: 0x11d, NumpadDivide: 0x135, PrintScreen: 0x137, AltRight: 0x138,
    Home: 0x147, ArrowUp: 0x148, PageUp: 0x149, ArrowLeft: 0x14b, ArrowRight: 0x14d,
    End: 0x14f, ArrowDown: 0x150, PageDown: 0x151, Insert: 0x152, Delete: 0x153,
    MetaLeft: 0x15b, MetaRight: 0x15c, ContextMenu: 0x15d,
    IntlRo: 0x73, IntlYen: 0x7d, KanaMode: 0x70, Convert: 0x79, NonConvert: 0x7b,
    Lang1: 0x72, Lang2: 0x71, Lang3: 0x78, Lang4: 0x77,
    NumpadEqual: 0x59, NumpadComma: 0x7e, Pause: 0x146,
}
for (const [keys, start] of [['1234567890', 0x02], ['QWERTYUIOP', 0x10], ['ASDFGHJKL', 0x1e], ['ZXCVBNM', 0x2c]] as const) {
    Array.from(keys).forEach((key, i) => { SCANS[/\d/.test(key) ? `Digit${key}` : `Key${key}`] = start + i })
}
for (let i = 1; i <= 10; i++) { SCANS[`F${i}`] = 0x3a + i }
for (let i = 13; i <= 24; i++) { SCANS[`F${i}`] = 0x64 + i - 13 }

export function nativeKey (event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'metaKey'> & Partial<Pick<KeyboardEvent, 'getModifierState'>>, unicode: boolean, held: Iterable<string> = []): { scan: number, text: string } | null {
    const pressed = new Set(held)
    const altGraph = event.getModifierState?.('AltGraph') === true
    const meta = event.metaKey || pressed.has('MetaLeft') || pressed.has('MetaRight')
    const shortcut = meta || !altGraph && (event.ctrlKey || event.altKey || ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight'].some(code => pressed.has(code)))
    if (unicode && Array.from(event.key).length === 1 && !shortcut) {
        return { scan: 0, text: event.key }
    }
    const scan = SCANS[event.code]
    return scan ? { scan, text: '' } : null
}

/** Canvas/input adapter for the same session UI operations used by the embedded IronRDP component. */
export class FreeRDPView {
    readonly element: HTMLElement
    readonly canvas: HTMLCanvasElement
    private readonly abort = new AbortController()
    private visible = true
    private readOnly = false
    private buttons = 0
    private pointerId: number | null = null
    private pointerPosition = { x: 0, y: 0 }
    private unicode = false
    private scale = 1
    private readonly pressed = new Map<string, { scan: number, text: string }>()

    constructor (readonly native: FreeRDPProcess, host: HTMLElement) {
        this.element = document.createElement('div')
        this.element.className = 'trd-freerdp'
        this.element.style.cssText = 'display:flex;flex:1;min-width:0;min-height:0'
        const root = this.element.attachShadow({ mode: 'open' })
        root.innerHTML = `<style>:host { display:flex;flex:1;min-width:0;min-height:0 }
            .screen-wrapper { flex:1;min-width:0;min-height:0;overflow:auto;display:flex;align-items:safe center;justify-content:safe center }
            canvas { display:block;flex:none;outline:none;object-fit:contain }</style><div class="screen-wrapper"><canvas tabindex="0"></canvas></div>`
        this.canvas = root.querySelector('canvas')!
        host.replaceChildren(this.element)
        const listen = (target: EventTarget, name: string, listener: (event: any) => void, options = {}) =>
            target.addEventListener(name, listener, { ...options, signal: this.abort.signal })
        for (const name of ['keydown', 'keyup']) {
            // DesktopKeyboard's window listener runs first and maps Mac shortcuts / handles Tabby's shortcuts.
            listen(window, name, (event: KeyboardEvent) => {
                if (!event.defaultPrevented && this.visible && document.activeElement === this.element) { this.sendKeyboardEvent(event) }
            })
        }
        listen(this.canvas, 'blur', () => this.releaseInput())
        listen(window, 'blur', () => this.releaseInput())
        listen(this.canvas, 'pointerdown', (event: PointerEvent) => {
            if (!this.visible || this.readOnly || this.pointerId !== null && this.pointerId !== event.pointerId) { return }
            this.canvas.focus()
            this.pointerId = event.pointerId
            this.canvas.setPointerCapture(event.pointerId)
            this.mouse(event)
        })
        listen(this.canvas, 'pointerup', (event: PointerEvent) => this.mouse(event))
        for (const name of ['pointercancel', 'lostpointercapture']) {
            listen(this.canvas, name, (event: PointerEvent) => { if (this.pointerId === event.pointerId) { this.releaseButtons() } })
        }
        listen(this.canvas, 'pointermove', (event: PointerEvent) => this.mouse(event))
        listen(this.canvas, 'wheel', (event: WheelEvent) => {
            if (!this.visible || this.readOnly) { return }
            event.preventDefault()
            const { x, y } = this.coordinates(event)
            const delta = Math.max(-255, Math.min(255, Math.round(-event.deltaY)))
            if (delta) { this.native.send('M', numbers(0x0200 | (delta & 0x01ff), x, y)) }
        }, { passive: false })
    }

    get stats (): { bytesIn: number, bytesOut: number } | null { return this.native.stats }
    get frameCount (): number { return this.native.frameCount }

    paint (frame: NativeFrame): void {
        if (this.abort.signal.aborted) { return }
        if (this.canvas.width !== frame.screenWidth || this.canvas.height !== frame.screenHeight) {
            this.canvas.width = frame.screenWidth
            this.canvas.height = frame.screenHeight
            this.fit()
        }
        this.canvas.getContext('2d')!.putImageData(new ImageData(frame.rgba, frame.width, frame.height), frame.x, frame.y)
    }

    setVisibility (visible: boolean): void { this.visible = visible; if (!visible) { this.releaseInput() } }
    setReadOnly (readOnly: boolean): void { this.readOnly = readOnly; if (readOnly) { this.releaseInput() } }
    /** Whether the desktop has the focus: shown, focused, and Tabby the app in front. */
    isFocused (): boolean { return this.visible && document.activeElement === this.element && document.hasFocus() }
    isViewOnly (): boolean { return this.readOnly }
    /** Sends this computer's clipboard text to the desktop now (set by the service; see FreeRDPClipboard.sendNow). */
    clipboardSender?: () => void
    /** Paste to all: this computer's clipboard to the desktop, focus or not, as IronRDP's component does. */
    async sendClipboardData (): Promise<void> {
        if (!this.clipboardSender) { throw new Error('no clipboard channel') }
        this.clipboardSender()
    }
    /** Paste to all: Ctrl+V in whatever window is active on the desktop. */
    ctrlV (): void {
        if (this.readOnly) { return }
        const ctrl = { scan: SCANS.ControlLeft, text: '' }, v = { scan: SCANS.KeyV, text: '' }
        this.key(ctrl, false); this.key(v, false); this.key(v, true); this.key(ctrl, true)
    }
    setKeyboardUnicodeMode (unicode: boolean): void { this.unicode = unicode }
    setScale (scale: number): void { this.scale = scale; this.fit() }
    resize (width: number, height: number, scale = 100): void { this.native.send('R', numbers(width, height, scale)) }

    private fit (): void {
        const rect = this.element.getBoundingClientRect()
        const ratio = this.scale === 3 ? 1 : Math.min(rect.width / this.canvas.width, rect.height / this.canvas.height)
        this.canvas.style.width = `${Math.max(1, this.canvas.width * ratio)}px`
        this.canvas.style.height = `${Math.max(1, this.canvas.height * ratio)}px`
    }

    private coordinates (event: MouseEvent): { x: number, y: number } {
        const rect = this.canvas.getBoundingClientRect()
        return {
            x: Math.max(0, Math.min(this.canvas.width - 1, Math.floor((event.clientX - rect.left) * this.canvas.width / Math.max(1, rect.width)))),
            y: Math.max(0, Math.min(this.canvas.height - 1, Math.floor((event.clientY - rect.top) * this.canvas.height / Math.max(1, rect.height)))),
        }
    }

    private mouse (event: PointerEvent): void {
        if (!this.visible || this.readOnly) { return }
        if (this.pointerId !== null && this.pointerId !== event.pointerId) { return }
        const { x, y } = this.coordinates(event)
        this.pointerPosition = { x, y }
        // Pointer Events report intermediate button presses/releases as moves. Reconcile the complete mask,
        // including those moves, so chords cannot leave a remote button held after both local buttons are up.
        // A drag started in a local terminal/toolbar must never become a remote button press on canvas entry.
        const next = this.pointerId === event.pointerId ? event.buttons & 7 : 0
        for (const [mask, flag] of [[1, 0x1000], [2, 0x2000], [4, 0x4000]]) {
            if ((this.buttons & mask) !== (next & mask)) this.native.send('M', numbers(flag | (next & mask ? 0x8000 : 0), x, y))
        }
        this.buttons = next
        if (event.type === 'pointermove') this.native.send('M', numbers(0x0800, x, y))
        if (!next && this.pointerId === event.pointerId) this.releaseButtons()
    }

    private releaseButtons (): void {
        for (const [mask, flag] of [[1, 0x1000], [2, 0x2000], [4, 0x4000]]) {
            if (this.buttons & mask) this.native.send('M', numbers(flag, this.pointerPosition.x, this.pointerPosition.y))
        }
        this.buttons = 0
        const id = this.pointerId
        this.pointerId = null
        if (id !== null && this.canvas.hasPointerCapture?.(id)) this.canvas.releasePointerCapture(id)
    }

    sendKeyboardEvent (event: KeyboardEvent): void {
        if (this.readOnly) { return }
        const release = event.type === 'keyup'
        const key = release ? this.pressed.get(event.code) ?? nativeKey(event, this.unicode, this.pressed.keys()) : nativeKey(event, this.unicode, this.pressed.keys())
        if (!key) { return }
        event.preventDefault()
        if (release) { this.pressed.delete(event.code) } else { this.pressed.set(event.code, key) }
        this.key(key, release)
    }

    private key (key: { scan: number, text: string }, release: boolean): void {
        if (key.text) {
            for (let i = 0; i < key.text.length; i++) { this.native.send('K', numbers(release ? 0x8000 : 0, 0, key.text.charCodeAt(i))) }
        } else { this.native.send('K', numbers(release ? 0x8000 : 0, key.scan, 0)) }
    }

    private releaseKeys (): void {
        for (const key of this.pressed.values()) { this.key(key, true) }
        this.pressed.clear()
    }

    private releaseInput (): void { this.releaseKeys(); this.releaseButtons() }

    shutdown (): void {
        this.releaseInput()
        this.abort.abort()
        this.native.shutdown()
    }
}
