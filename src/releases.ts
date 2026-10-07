import * as semver from 'semver'
import { Subject } from 'rxjs'

export const REGISTRY = 'https://registry.npmjs.org/tabby-rdp'
export const RELEASES = 'https://github.com/meanaverage/tabby-rdp/releases'
export const RELEASE_STATE_KEY = 'tabby-rdp.releases.v1'
const BASELINE = '0.5.1'
const CACHE_MS = 15 * 60 * 1000

export type Channel = 'stable' | 'preview'
export interface ReleasePolicy { minimumTabbyVersion: string, rollbackFloor: string }
export interface PublishedRelease {
    version: string
    policy?: ReleasePolicy
    node?: string
    os?: string[]
    cpu?: string[]
    deprecated: boolean
}
export interface Catalog { versions: PublishedRelease[], stable: string | null, preview: string | null }
export interface LocalReleaseState {
    channel: Channel
    paused: boolean
    previous?: string
    /** Last successful installed target; retained after restart so older open windows still see it. */
    pending?: string
    removed?: boolean
    rollbackFloor: string
}
export interface ReleaseEnvironment {
    running: string
    policy: ReleasePolicy
    tabby: string
    node: string
    os: string
    cpu: string
    storage?: Pick<Storage, 'getItem' | 'setItem'>
    fetchCatalog: () => Promise<Catalog>
    install: (name: string, version: string) => Promise<void>
    uninstall: (name: string) => Promise<void>
    confirm: (message: string, detail: string, action: string) => Promise<boolean>
    now?: () => number
    /** Serializes all state writes and package mutations across this profile's windows. */
    withLock?: (run: () => Promise<void>) => Promise<void>
    /** Reads the package on disk, bypassing Node's module cache; null only if the file is absent. */
    diskVersion?: () => string | null
}

/** Exact, canonical versions only: never an npm selector, alias, URL or tag. */
export function releaseVersion (value: unknown): value is string {
    return typeof value === 'string' && semver.valid(value) === value && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:beta|rc)\.(0|[1-9]\d*))?$/.test(value)
}
export function newer (a: string, b: string): boolean {
    return releaseVersion(a) && releaseVersion(b) && semver.gt(a, b)
}
const greatest = (a: string, b: string): string => semver.gt(a, b) ? a : b
function policy (value: any): ReleasePolicy | undefined {
    return value && typeof value.minimumTabbyVersion === 'string' && semver.valid(value.minimumTabbyVersion) &&
        releaseVersion(value.rollbackFloor) ? { minimumTabbyVersion: value.minimumTabbyVersion, rollbackFloor: value.rollbackFloor } : undefined
}

/** Bound both the response body and elapsed time, including slow streaming responses. */
export async function registryJSON (url: string, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024): Promise<any> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
        const response = await fetch(url, { cache: 'no-store', signal: abort.signal })
        if (!response.ok || !response.body) {
            throw new Error(`The registry answered ${response.status}.`)
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        for (;;) {
            const { done, value } = await reader.read()
            if (done) { break }
            size += value.byteLength
            if (size > maxBytes) { throw new Error('The registry\'s answer is too large.') }
            chunks.push(value)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
        clearTimeout(timer)
        abort.abort()
    }
}

export function parseCatalog (data: any): Catalog {
    if (data?.name !== 'tabby-rdp' || !data.versions || typeof data.versions !== 'object' || Array.isArray(data.versions)) {
        throw new Error('The registry returned an invalid version list.')
    }
    const entries = Object.entries(data.versions)
    if (entries.length > 5000) { throw new Error('The registry\'s version list is too large.') }
    const versions: PublishedRelease[] = []
    for (const [version, raw] of entries) {
        const p = raw as any
        if (!releaseVersion(version) || p?.name !== 'tabby-rdp' || p.version !== version) { continue }
        // 0.5.1 predates this field. Its requirements and irreversible credential migration were reviewed explicitly.
        let compatibility = policy(p.tabbyRdp) ?? (version === BASELINE ? { minimumTabbyVersion: '1.0.236', rollbackFloor: BASELINE } : undefined)
        if (compatibility && semver.gt(compatibility.rollbackFloor, version)) { compatibility = undefined }
        versions.push({ version, policy: compatibility, node: typeof p.engines?.node === 'string' ? p.engines.node : undefined,
            os: Array.isArray(p.os) ? p.os.filter((x: unknown) => typeof x === 'string') : undefined,
            cpu: Array.isArray(p.cpu) ? p.cpu.filter((x: unknown) => typeof x === 'string') : undefined,
            deprecated: !!p.deprecated })
    }
    versions.sort((a, b) => semver.rcompare(a.version, b.version))
    const tag = (name: string, preview: boolean): string | null => {
        const v = data['dist-tags']?.[name]
        return releaseVersion(v) && !!semver.prerelease(v) === preview && versions.some(p => p.version === v) ? v : null
    }
    return { versions, stable: tag('latest', false), preview: tag('beta', true) }
}
export async function publishedVersions (): Promise<Catalog> {
    return parseCatalog(await registryJSON(REGISTRY))
}

/** No config or credential backups: only local preferences and successful package-change history. */
export class ReleaseManager {
    readonly changed$ = new Subject<void>()
    readonly running: string
    readonly state: LocalReleaseState
    catalog: Catalog | null = null
    checking = false
    busy = false
    readonly ready: Promise<void>
    error = ''
    private catalogError = ''
    notice = ''
    storageWarning = ''
    checkedAt: number | null = null
    private inFlight?: Promise<void>
    private lastAttempt = -Infinity
    private readonly now: () => number

    constructor (private env: ReleaseEnvironment, initiallyPaused = false) {
        this.running = env.running
        this.now = env.now ?? Date.now
        this.state = { channel: 'stable', paused: initiallyPaused, rollbackFloor: greatest(BASELINE, env.policy.rollbackFloor) }
        this.syncFromStorage()
        this.ready = this.lock(async () => {
            this.syncFromStorage()
            this.reconcileDisk()
            this.persist()
        }).catch(e => { this.error = this.message(e) }).finally(() => this.changed$.next())
    }

    private message (error: unknown): string { return error instanceof Error ? error.message : 'Use Tabby Plugins to manage this installation.' }
    private async lock (run: () => Promise<void>): Promise<void> {
        if (this.env.withLock) { await this.env.withLock(run) } else { await run() }
    }
    /** Storage events call this too. Reading never clears another window's successful package change. */
    syncFromStorage (): void {
        if (!this.env.storage) { return }
        try {
            const saved = JSON.parse(this.env.storage.getItem(RELEASE_STATE_KEY) ?? 'null')
            if (!saved) { return }
            this.state.channel = saved.channel === 'preview' ? 'preview' : 'stable'
            if (typeof saved.paused === 'boolean') { this.state.paused = saved.paused }
            this.state.previous = releaseVersion(saved.previous) ? saved.previous : undefined
            this.state.pending = releaseVersion(saved.pending) ? saved.pending : undefined
            this.state.removed = saved.removed === true
            if (releaseVersion(saved.rollbackFloor)) {
                this.state.rollbackFloor = greatest(this.state.rollbackFloor, saved.rollbackFloor)
            }
        } catch { /* Keep the known state if local storage is temporarily unavailable. */ }
        this.changed$.next()
    }
    /** Under the shared lock, so a second window never observes our installer's intermediate files. */
    private reconcileDisk (): void {
        if (!this.env.diskVersion) { return }
        const disk = this.env.diskVersion()
        if (disk !== null && !releaseVersion(disk)) { throw new Error('The installed package version cannot be verified. Use Tabby Plugins.') }
        if (disk === null) {
            this.state.removed = true
        } else {
            if ((this.state.pending && this.state.pending !== disk) || this.state.removed) {
                this.notice = `The package changed outside this page. Tabby is running ${this.running}; the package on disk is ${disk}.`
                this.state.previous = undefined
            }
            this.state.pending = disk
            this.state.removed = false
        }
    }
    get pending (): string | null { return !this.removed && this.state.pending && this.state.pending !== this.running ? this.state.pending : null }
    get removed (): boolean { return this.state.removed === true }
    private persist (): void {
        try {
            if (!this.env.storage) { throw new Error('Local storage unavailable') }
            this.env.storage.setItem(RELEASE_STATE_KEY, JSON.stringify(this.state))
            this.storageWarning = ''
        } catch {
            this.storageWarning = 'Version preferences could not be saved on this computer. They apply to this window only. Manage installations in Tabby Plugins.'
        }
    }
    private async preference (change: Partial<LocalReleaseState>): Promise<void> {
        if (this.busy) { return }
        await this.ready
        try {
            await this.lock(async () => {
                this.syncFromStorage()
                Object.assign(this.state, change)
                this.persist()
            })
        } catch (e) { this.error = this.message(e) }
        this.changed$.next()
    }
    async setChannel (value: string): Promise<void> {
        if (value === 'stable' || value === 'preview') { await this.preference({ channel: value }) }
    }
    async setPaused (paused: boolean): Promise<void> { await this.preference({ paused }) }
    get recommended (): string | null {
        const stable = this.catalog?.stable ?? null
        const preview = this.state.channel === 'preview' ? this.catalog?.preview : null
        return preview && (!stable || newer(preview, stable)) ? preview : stable
    }
    get available (): string | null {
        const version = this.recommended
        return !this.state.paused && !this.catalogError && !this.pending && !this.removed && version && newer(version, this.running) && !this.reason(version) ? version : null
    }
    get versions (): PublishedRelease[] {
        return (this.catalog?.versions ?? []).filter(p => this.state.channel === 'preview' || !semver.prerelease(p.version))
    }
    /** A reason to refuse a version, independent of whether it is newer. Return-to-stable may downgrade. */
    reason (version: string): string | null {
        if (!releaseVersion(version)) { return 'Invalid version.' }
        const p = this.catalog?.versions.find(x => x.version === version)
        if (!p) { return 'This version is not in the published version list.' }
        if (p.deprecated) { return 'This version has been withdrawn from recommendations.' }
        if (semver.lt(version, this.state.rollbackFloor)) { return `Saved data requires version ${this.state.rollbackFloor} or newer.` }
        if (!p.policy) { return 'Compatibility has not been confirmed for this version.' }
        if (!semver.valid(this.env.tabby) || semver.lt(this.env.tabby, p.policy.minimumTabbyVersion)) {
            return `Requires Tabby ${p.policy.minimumTabbyVersion} or newer.`
        }
        if (p.node && (!semver.validRange(p.node) || !semver.satisfies(this.env.node, p.node, { includePrerelease: true }))) {
            return 'Requires a different Node.js version. Update Tabby first.'
        }
        const supports = (list: string[] | undefined, value: string): boolean => !list?.length ||
            (!list.includes(`!${value}`) && (list.includes('any') || !list.some(x => !x.startsWith('!')) || list.includes(value)))
        if (!supports(p.os, this.env.os) || !supports(p.cpu, this.env.cpu)) { return 'Not available for this computer.' }
        return null
    }

    /** One shared request; ordinary reads cache for 15 minutes, explicit checks retry at most every 10 seconds. */
    async refreshCatalog (force = false): Promise<void> {
        if (this.inFlight) { return this.inFlight }
        const elapsed = this.now() - this.lastAttempt
        if (elapsed < (force ? 10000 : CACHE_MS)) { return }
        this.lastAttempt = this.now()
        this.checking = true
        this.error = ''
        this.changed$.next()
        this.inFlight = (async () => {
            try {
                this.catalog = await Promise.resolve().then(() => this.env.fetchCatalog())
                this.catalogError = ''
                this.checkedAt = this.now()
            } catch (e) {
                this.error = this.catalogError = `Could not check published versions. ${e instanceof Error ? e.message : 'Try again later.'}`
            } finally {
                this.checking = false
                this.inFlight = undefined
                this.changed$.next()
            }
        })()
        return this.inFlight
    }

    async install (version: string, returnToStable = false): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.error = ''
        this.changed$.next()
        try {
            await this.ready
            await this.lock(async () => {
                this.syncFromStorage()
                this.reconcileDisk()
                this.persist()
                if (this.storageWarning) { throw new Error('Version history cannot be saved. Use Tabby Plugins to install.') }
                if (this.pending || this.removed) { return }
                await this.refreshCatalog()
                if (this.catalogError) { throw new Error('Check published versions successfully before installing.') }
                const reason = this.reason(version)
                if (reason) { throw new Error(reason) }
                if (version === this.running) { return }
                if (semver.prerelease(version) && this.state.channel !== 'preview') { throw new Error('Choose Preview before installing a preview version.') }
                if (returnToStable && version !== this.catalog?.stable) { throw new Error('Check the current stable version again.') }
                const downgrade = semver.lt(version, this.running)
                if (!await this.env.confirm(`Install tabby-rdp ${version}?`,
                    `Currently running ${this.running}. ${downgrade ? 'This is a downgrade. ' : ''}Close remote desktops and restart Tabby after installation.`, 'Install')) { return }
                await this.env.install('tabby-rdp', version)
                // History is committed only after the supported installer succeeds.
                this.state.previous = this.running
                this.state.pending = version
                this.state.removed = false
                if (returnToStable) { this.state.channel = 'stable' }
                this.persist()
            })
        } catch (e) {
            this.error = `Installation did not complete. ${this.message(e)}`
        } finally {
            this.busy = false
            this.changed$.next()
        }
    }

    async uninstall (): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.error = ''
        this.changed$.next()
        try {
            await this.ready
            await this.lock(async () => {
                this.syncFromStorage()
                this.reconcileDisk()
                this.persist()
                if (this.storageWarning) { throw new Error('Version history cannot be saved. Use Tabby Plugins to uninstall.') }
                if (this.pending || this.removed) { return }
                if (!await this.env.confirm('Uninstall tabby-rdp?',
                    'Close remote desktops before uninstalling, then restart Tabby. Saved connections, settings, passwords and remote setup are kept.', 'Uninstall')) { return }
                await this.env.uninstall('tabby-rdp')
                this.state.removed = true
                this.persist()
            })
        } catch (e) {
            this.error = `Uninstall did not complete. ${this.message(e)}`
        } finally {
            this.busy = false
            this.changed$.next()
        }
    }
}
