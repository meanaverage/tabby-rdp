import { NgZone } from '@angular/core'

export const STYLE = `
.trd-stats { position: absolute; left: 8px; bottom: 8px; z-index: 2; padding: 3px 7px; border-radius: 4px;
    background: rgba(20, 20, 20, 0.7); color: #ddd; font: 11px/1.45 ui-monospace, Menlo, Consolas, monospace;
    white-space: pre; pointer-events: none; transition: opacity 0.15s; }
.trd-stats-path { color: #999; }
.trd-stats.trd-stats-away { opacity: 0.1; }
`

/** What the indicator says about the connection besides the numbers; asked on every update. */
export interface ConnectionInfo {
    /** e.g. "Windows VM via buildhost · bitmaps · Standard" */
    path (): string
    /** RDP bytes relayed so far (the proxy's counters), if a proxy runs. */
    bytes (): { bytesIn: number, bytesOut: number } | null
    /** Round trip to the SSH server in ms, where it can be measured cheaply. */
    ping?: () => Promise<number>
}

// Rates are per second; the round trip is measured less often, since it opens a channel on the SSH server.
const TICK_MS = 1000
const PING_EVERY_TICKS = 5

function rate (bytesPerSecond: number): string {
    if (bytesPerSecond < 1000) {
        return `${Math.round(bytesPerSecond)} B/s`
    }
    if (bytesPerSecond < 1e6) {
        return `${(bytesPerSecond / 1e3).toFixed(bytesPerSecond < 1e4 ? 1 : 0)} kB/s`
    }
    return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`
}

/**
 * The connection-status indicator in a desktop layer: throughput, frames per second, SSH round trip, and the
 * connection path. Runs only while active (the setting is on and the desktop shows and is connected); its timers
 * and listeners stay outside Angular's zone, like everything that runs on its own (see docs/architecture.md).
 */
export class ConnectionStatus {
    private readonly el: HTMLElement
    private readonly numbersEl: HTMLElement
    private readonly pathEl: HTMLElement
    private timer: ReturnType<typeof setInterval> | null = null
    private ticks = 0
    private last: { at: number, bytesIn: number, bytesOut: number, frames: number } | null = null
    private frames = 0
    private frameHook: {
        context: CanvasRenderingContext2D
        original: CanvasRenderingContext2D['putImageData']
        wrapped: CanvasRenderingContext2D['putImageData']
    } | null = null
    private latency: number | null = null
    private pinging = false
    private active = false

    constructor (private overlay: HTMLElement, private zone: NgZone, private info: ConnectionInfo) {
        this.el = document.createElement('div')
        this.el.className = 'trd-stats'
        this.el.innerHTML = '<div class="trd-stats-numbers"></div><div class="trd-stats-path"></div>'
        this.numbersEl = this.el.querySelector('.trd-stats-numbers')!
        this.pathEl = this.el.querySelector('.trd-stats-path')!
    }

    /** Starts or stops the indicator. `canvas`: the remote display, whose updates are counted as frames. */
    setActive (active: boolean, canvas?: HTMLCanvasElement | null): void {
        if (active && canvas) {
            this.countFrames(canvas)
        } else if (!active) {
            this.releaseCanvas()
        }
        if (active === this.active) {
            return
        }
        this.active = active
        if (!active) {
            clearInterval(this.timer ?? undefined)
            this.timer = null
            this.overlay.removeEventListener('mousemove', this.onMouseMove, true)
            this.el.remove()
            return
        }
        this.last = null
        this.ticks = 0
        this.latency = null
        this.numbersEl.textContent = '…'
        this.pathEl.textContent = this.info.path()
        this.el.classList.remove('trd-stats-away')
        this.overlay.appendChild(this.el)
        this.zone.runOutsideAngular(() => {
            this.timer = setInterval(() => this.tick(), TICK_MS)
            this.overlay.addEventListener('mousemove', this.onMouseMove, { capture: true, passive: true })
            this.tick()
        })
    }

    dispose (): void {
        this.setActive(false)
    }

    /**
     * IronRDP's web client blits each changed region with putImageData and tells nobody, so the canvas context's
     * putImageData is wrapped (on that one context object). A frame is one synchronous batch of blits.
     */
    private countFrames (canvas: HTMLCanvasElement): void {
        const ctx = canvas.getContext('2d')
        if (ctx === this.frameHook?.context) {
            return
        }
        this.releaseCanvas()
        if (!ctx) {
            return
        }
        const original = ctx.putImageData
        let batch = false
        const wrapped = ((...args: any[]) => {
            if (!batch) {
                batch = true
                this.frames++
                queueMicrotask(() => { batch = false })
            }
            return (original as any).apply(ctx, args)
        }) as any
        ctx.putImageData = wrapped
        this.frameHook = { context: ctx, original, wrapped }
    }

    /** A detached canvas's handlers retain its backend, even after its component has been removed. */
    private releaseCanvas (): void {
        const hook = this.frameHook
        this.frameHook = null
        // Leave a later owner's replacement alone.
        if (hook && hook.context.putImageData === hook.wrapped) {
            hook.context.putImageData = hook.original
        }
    }

    private tick (): void {
        const now = performance.now()
        const bytes = this.info.bytes() ?? { bytesIn: 0, bytesOut: 0 }
        const current = { at: now, bytesIn: bytes.bytesIn, bytesOut: bytes.bytesOut, frames: this.frames }
        const parts: string[] = []
        if (this.last && now > this.last.at) {
            const seconds = (now - this.last.at) / 1000
            parts.push(
                `↓ ${rate((current.bytesIn - this.last.bytesIn) / seconds)}`,
                `↑ ${rate((current.bytesOut - this.last.bytesOut) / seconds)}`,
                `${Math.round((current.frames - this.last.frames) / seconds)} fps`)
        } else {
            parts.push('↓ …', '↑ …', '… fps')
        }
        if (this.info.ping) {
            parts.push(this.latency === null ? 'ping …' : `ping ${this.latency < 10 ? this.latency.toFixed(1) : Math.round(this.latency)} ms`)
            if (this.ticks++ % PING_EVERY_TICKS === 0) {
                this.measureLatency()
            }
        }
        this.last = current
        this.numbersEl.textContent = parts.join('  ')
        this.pathEl.textContent = this.info.path()
    }

    private measureLatency (): void {
        // Nothing to show while the window is hidden; and never two at once on a slow link.
        if (this.pinging || document.hidden) {
            return
        }
        this.pinging = true
        this.info.ping!().then(ms => { this.latency = ms }, () => { this.latency = null }).finally(() => { this.pinging = false })
    }

    /** The indicator fades while the pointer is near it, so it never hides what is under it for long. */
    private readonly onMouseMove = (event: MouseEvent): void => {
        const r = this.el.getBoundingClientRect()
        const near = event.clientX > r.left - 24 && event.clientX < r.right + 24 && event.clientY > r.top - 24 && event.clientY < r.bottom + 24
        if (near !== this.el.classList.contains('trd-stats-away')) {
            this.el.classList.toggle('trd-stats-away', near)
        }
    }
}
