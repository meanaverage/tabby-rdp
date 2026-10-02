import { Injectable, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { AppService, ConfigService, PlatformService } from 'tabby-core'
import { RemoteDesktopHelp } from './help'
import { desktopPaneOf } from './targets'

const REGISTRY = 'https://registry.npmjs.org/tabby-rdp/latest'
const RELEASES = 'https://github.com/meanaverage/tabby-rdp/releases'
const DAY = 24 * 60 * 60 * 1000

/** This package's version. */
export function installedVersion (): string {
    try {
        return require('../package.json').version
    } catch {
        return '0.0.0'
    }
}

/** Whether `a` is a later release than `b` (x.y.z; a version with a pre-release part is never offered). */
export function newer (a: string, b: string): boolean {
    const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number)
    const x = parse(a), y = parse(b)
    if (!x || !y) {
        return false
    }
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i]) {
            return x[i] > y[i]
        }
    }
    return false
}

/**
 * Tells about a newer tabby-rdp: Tabby only shows plugin upgrades while its Plugins page is open, and never on its own.
 * Once a day (and a little after Tabby starts) it asks npm for the latest version, and nothing else: no identifier,
 * no usage. A newer one gets a note, once per version, over the active pane; an "Update available" item in the
 * menus and a line on the settings page until it's installed. `remoteDesktop.checkUpdates` turns it off.
 */
@Injectable({ providedIn: 'root' })
export class UpdateCheck {
    /** The newer version, once one is known. */
    available: string | null = null
    readonly changed$ = new Subject<void>()
    private timer?: ReturnType<typeof setInterval>

    constructor (private config: ConfigService, private app: AppService, private help: RemoteDesktopHelp, private platform: PlatformService, private zone: NgZone) { }

    start (): void {
        this.zone.runOutsideAngular(() => {
            setTimeout(() => this.check().catch(() => null), 20000)
            this.timer = setInterval(() => this.check().catch(() => null), DAY)
        })
    }

    private get enabled (): boolean {
        return this.config.store.remoteDesktop?.checkUpdates !== false
    }

    /** Asks npm for the latest version (or takes `latest`, for tests), and tells about it if it's newer. */
    async check (latest?: string): Promise<string | null> {
        if (!this.enabled && latest === undefined) {
            return null
        }
        const version = latest ?? String((await (await fetch(REGISTRY, { cache: 'no-store' })).json())?.version ?? '')
        this.zone.run(() => {
            this.available = newer(version, installedVersion()) ? version : null
            this.changed$.next()
            if (this.available) {
                this.noteOnce(this.available)
            }
        })
        return this.available
    }

    /**
     * Asks again now, when a version is known already: the settings page is where it's shown, and a Tabby left open for
     * days would otherwise offer the version it found first, not the latest (meanaverage/tabby-rdp#17).
     */
    refresh (): void {
        if (this.available && this.enabled) {
            this.check().catch(() => null)
        }
    }

    /** Settings › Plugins, where Tabby's Upgrade button is. */
    upgrade (): void {
        this.help.openSettings('plugins')
    }

    /** The release notes of the newer version. */
    whatsNew (): void {
        this.platform.openExternal(`${RELEASES}/tag/v${this.available ?? ''}`)
    }

    /** A note over the active pane, once per version (then the menus and the settings page keep saying it). */
    private noteOnce (version: string): void {
        const store = this.config.store.remoteDesktop
        if (!store || store.updateNoted === version) {
            return
        }
        const pane = desktopPaneOf(this.app.activeTab)
        if (!pane) {
            return  // shown the next time a pane is active and this runs
        }
        store.updateNoted = version
        this.config.save()
        const note = this.help.note(pane.element.nativeElement, `tabby-rdp ${version} is available (you have ${installedVersion()}).`)
        const button = document.createElement('button')
        button.className = 'btn btn-secondary'
        button.textContent = 'Upgrade'
        button.addEventListener('click', () => {
            note.remove()
            this.upgrade()
        })
        note.insertBefore(button, note.querySelector('[data-ok]'))
    }
}
