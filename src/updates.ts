import { readFileSync } from 'fs'
import { join } from 'path'
import { Injectable, NgZone } from '@angular/core'
import { take } from 'rxjs'
import { AppService, ConfigService, PlatformService } from 'tabby-core'
import { RemoteDesktopHelp } from './help'
import { desktopPaneOf } from './targets'
import { HostCompatibility } from './hostCompat'
import { PackageChangeDialog } from './packageChangeDialog'

import { publishedVersions, registryJSON, ReleaseManager, RELEASES, RELEASE_STATE_KEY, releaseVersion } from './releases'
export { newer } from './releases'

const DAY = 24 * 60 * 60 * 1000
// Capture the running package before an installer replaces its files on disk.
const PACKAGE = require('../package.json')
const RUNNING = PACKAGE.version as string
export function installedVersion (): string { return RUNNING }

/** Kept for callers needing only npm's latest version, with the same response bounds. */
export async function latestVersion (url = 'https://registry.npmjs.org/tabby-rdp/latest', timeoutMs = 15000, maxBytes = 256 * 1024): Promise<string> {
    return String((await registryJSON(url, timeoutMs, maxBytes))?.version ?? '')
}

function localStore (): Storage | undefined {
    try { return window.localStorage } catch { return undefined }
}

function hasPreferences (storage: Storage | undefined): boolean {
    try { return typeof JSON.parse(storage?.getItem(RELEASE_STATE_KEY) ?? 'null')?.paused === 'boolean' }
    catch { return false }
}

/** Daily, opt-out update notes; explicit package changes are handled by ReleaseManager. */
@Injectable({ providedIn: 'root' })
export class UpdateCheck extends ReleaseManager {
    private timer?: ReturnType<typeof setInterval>

    constructor (private config: ConfigService, private app: AppService, private help: RemoteDesktopHelp, private platform: PlatformService, private zone: NgZone, compat: HostCompatibility) {
        const storage = localStore()
        const migratePreferences = !hasPreferences(storage)
        const dialog = new PackageChangeDialog()
        super({ running: RUNNING, policy: PACKAGE.tabbyRdp, tabby: compat.info.version ?? '', node: process.versions.node,
            os: process.platform, cpu: process.arch, storage, fetchCatalog: publishedVersions,
            withLock: async run => {
                if (!navigator.locks) { throw new Error('This Tabby cannot coordinate version changes between windows. Use Tabby Plugins.') }
                await navigator.locks.request('tabby-rdp.package-change', run)
            },
            diskVersion: () => {
                try { return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null }
                    throw error
                }
            },
            install: (name, version) => platform.installPlugin(name, version), uninstall: name => platform.uninstallPlugin(name),
            confirm: (message, detail, action) => dialog.confirm(message, detail, action),
            progress: state => dialog.update(state),
        }, !config.store || config.store.remoteDesktop?.checkUpdates === false)
        // Tabby can construct providers before ConfigService has loaded its store.
        // Keep checks paused until ready, and migrate the old switch only without a saved local preference.
        if (migratePreferences) {
            const migrate = () => { void this.setPaused(config.store?.remoteDesktop?.checkUpdates === false) }
            if (config.store) { migrate() }
            else { config.ready$.pipe(take(1)).subscribe(migrate) }
        }
        window.addEventListener('storage', event => {
            if (event.key === RELEASE_STATE_KEY) { this.zone.run(() => this.syncFromStorage()) }
        })
    }

    start (): void {
        this.zone.runOutsideAngular(() => {
            setTimeout(() => this.check().catch(() => null), 20000)
            this.timer = setInterval(() => this.check().catch(() => null), DAY)
        })
    }

    async check (): Promise<string | null> {
        if (this.state.paused) { return null }
        await this.refreshCatalog()
        this.zone.run(() => {
            if (this.available) { this.noteOnce(this.available) }
        })
        return this.available
    }

    /** Opening Updates loads published versions even when ordinary prompts are paused. */
    refresh (): void { void this.refreshCatalog() }
    upgrade (): void { this.help.open('updates') }
    whatsNew (version = this.available ?? this.running): void {
        if (releaseVersion(version)) { this.platform.openExternal(`${RELEASES}/tag/v${version}`) }
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
