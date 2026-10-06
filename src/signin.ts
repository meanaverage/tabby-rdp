/**
 * Sign-in for desktops that use their own accounts (Windows): a form in the desktop layer, and where passwords are
 * kept: Tabby's Vault when it is enabled (encrypted, part of the config, as Tabby's SSH passwords), else the system
 * keychain.
 */
import { DIRECT_KEY, keyParts, rekeyed } from './desktops'
import { parseGateway } from './gateway'

export interface Credentials {
    username: string
    password: string
}

const KEYCHAIN_SERVICE = 'tabby-rdp'
/** The Vault secret type of a desktop's or account's password; its key is `{ key, name }` (see vaultKey). */
export const VAULT_SECRET_TYPE = 'rdp:password'

/** Tabby's Vault (tabby-core's VaultService), handed in at startup; passwords go there while it is enabled. */
let vault: any = null
export function useVault (service: any): void {
    vault = service
}
function vaultOn (): boolean {
    try {
        return !!vault?.isEnabled()
    } catch {
        return false
    }
}
/** Where passwords are kept right now, for messages. */
export function storeName (): string {
    return vaultOn() ? 'Tabby\'s Vault' : 'the keychain'
}
/**
 * Vault changes one after another: each of Tabby's loads the whole encrypted contents, changes them and writes them
 * back, so two at once (two desktops signing in together) would lose one's change.
 */
let vaultQueue: Promise<unknown> = Promise.resolve()
/** Same-origin windows share these locks. Store work holds the lock through its actual completion. */
async function storeLock<T> (name: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const locks = globalThis.navigator?.locks
    return locks ? await locks.request(`tabby-rdp.credentials.${name}`, signal ? { signal } : {}, work) : work()
}
function queued<T> (work: () => Promise<T>): Promise<T> {
    const run = () => storeLock('vault', work)
    const next = vaultQueue.then(run, run)
    vaultQueue = next.catch(() => null)
    return next
}
/** How a Vault entry is found: by the same key as the keychain's; its `description` is only for a listing. */
function vaultKey (key: string): { key: string } {
    return { key }
}
function vaultName (key: string): string {
    const { target, desktopId, gateway } = keyParts(key)
    const where = `${desktopId}${gateway ? gateway.replace('@gateway#', ' through gateway ') : ''}`
    return target === 'account' ? `saved account` : target === DIRECT_KEY ? `${where} (direct)` : desktopId ? `${where} behind ${target}` : target
}

// The system keychain can keep a call waiting indefinitely: on Linux, a locked or missing keyring waits for an unlock
// prompt, which a session without a keyring prompter never shows. Give up after a while. A call that never returns
// also keeps one of Node's few worker threads (four), which the rest of Tabby needs for files and name lookups: after
// one, stop using the keychain. And one call at a time: several started together (a list of saved accounts, each
// asking whether it has a password) would each keep a thread before the first is given up on.
const KEYCHAIN_TIMEOUT_MS = 10000
let keychainStuck = false
let keychainQueue: Promise<unknown> = Promise.resolve()

// Tabby ships keytar (tabby-ssh keeps SSH passwords with it). Without it, nothing is remembered.
function keytar (): any {
    if (keychainStuck) {
        throw new Error('the keychain did not answer earlier')
    }
    try {
        return require('keytar')
    } catch {
        return null
    }
}

/**
 * A keychain call, after the ones before it: its answer, undefined without a keychain, or an error when it doesn't
 * answer in time (or one before it didn't: it is then not made at all).
 */
function keychain<T> (call: (keytar: any) => Promise<T>): Promise<T | undefined> {
    const run = () => new Promise<T | undefined>((resolve, reject) => {
        if (keychainStuck) { reject(new Error('the keychain did not answer earlier')); return }
        const abort = new AbortController()
        const timer = setTimeout(() => {
            keychainStuck = true
            abort.abort() // cancels a lock still waiting, never a native call already running
            reject(new Error('the keychain did not answer'))
        }, KEYCHAIN_TIMEOUT_MS)
        // Timeout is outside the lock: a late native write keeps other windows' writes behind it until it ends.
        storeLock('keychain', async () => {
            const store = keytar()
            return store ? call(store) : undefined
        }, abort.signal).then(
            value => { clearTimeout(timer); resolve(value) },
            error => { clearTimeout(timer); reject(error) })
    })
    const next = keychainQueue.then(run, run)
    keychainQueue = next.catch(() => null)
    return next
}

function parseCredentials (saved: string | null | undefined): Credentials | null {
    try {
        const parsed = saved ? JSON.parse(saved) : null
        return parsed?.username && typeof parsed.password === 'string' ? { username: parsed.username, password: parsed.password } : null
    } catch {
        return null
    }
}

/**
 * Saved passwords to be forgotten once in each store (see forgetOnce): this computer's keychain, whose part is marked
 * done there, under `mark`; and the Vault, whose part `vault` marks done in the config, which config sync takes to
 * other computers along with the Vault, while each keeps a keychain of its own.
 */
interface ForgetOnce {
    mark: string
    /** Which keys go, as the config says now. */
    forgets: () => (key: string) => boolean
    vault: { done (): boolean, markDone (): void }
    /** Whether this computer's keychain has had its part done, as far as this Tabby knows (see keychainOnce). */
    keychainDone: boolean
}

let once: ForgetOnce | null = null
let onceRunning: Promise<void> | null = null

/**
 * Forgets the saved passwords whose key `forgets` matches, once in this computer's keychain and once in the Vault,
 * before the store is next used: when it is asked anyway, so that a locked Vault asks for its passphrase at a sign-in
 * rather than when Tabby starts. Each part's mark is read as that part is about to be done (another Tabby window may
 * have done it since this one asked). A part that can't be done then (the keychain doesn't answer, or can't list what
 * it holds; the Vault's prompt is cancelled) is tried again at the next use, and until it is done, what it would
 * forget isn't looked up in that store (see withheld): the desktop asks.
 */
export function forgetOnce (mark: string, forgets: () => (key: string) => boolean, vault: { done (): boolean, markDone (): void }): void {
    once = { mark, forgets, vault, keychainDone: false }
}

/** Does what forgetOnce and forgetLater left to do, if anything, and waits for it to end. */
async function used (): Promise<void> {
    if (once && !onceRunning) {
        const job = once
        onceRunning = doOnce(job).catch(() => undefined).finally(() => { onceRunning = null })
    }
    await onceRunning
    // A previous background pass may have failed before the store became available. This use gets one fresh attempt.
    await laterRunning
    if (later.length && !laterRunning) {
        laterRunning = doLater().catch(() => undefined).finally(() => { laterRunning = null })
    }
    await laterRunning
}

/** forgetOnce's work: the keychain's part first, and on its own, so a Vault that can't be read doesn't hold it up. */
async function doOnce (job: ForgetOnce): Promise<void> {
    let forgets: (key: string) => boolean
    try {
        forgets = job.forgets()
    } catch {
        return
    }
    if (!job.keychainDone) {
        try {
            job.keychainDone = await keychainOnce(job.mark, forgets)
        } catch { }
    }
    if (!job.vault.done()) {
        try {
            if (vaultOn()) {
                // Read in full or not at all: a passphrase prompt cancelled throws, and the part is tried again.
                const contents = await vault.load()
                for (const secret of contents?.secrets ?? []) {
                    if (secret.type === VAULT_SECRET_TYPE && typeof secret.key?.key === 'string' && forgets(secret.key.key)) {
                        await queued(() => vault.removeSecret(VAULT_SECRET_TYPE, vaultKey(secret.key.key)))
                    }
                }
            }
            // With the Vault off there is nothing in it: Tabby drops its contents when it is turned off.
            job.vault.markDone()
        } catch { }
    }
    if (job.keychainDone && job.vault.done() && once === job) {
        once = null
    }
}

/**
 * This computer's keychain's part of forgetOnce: done before (its mark is there), or now, and marked. True without a
 * keychain, where there is nothing to do. Throws when the keychain doesn't answer, or can't list what it holds: a
 * part done on a listing that came back empty because of that would leave what it should have forgotten in place.
 */
async function keychainOnce (mark: string, forgets: (key: string) => boolean): Promise<boolean> {
    const marked = await keychain<string | null>(store => store.getPassword(KEYCHAIN_SERVICE, mark))
    if (marked === undefined || marked) {
        return true
    }
    const entries = await keychain<{ account: string }[]>(store => store.findCredentials(KEYCHAIN_SERVICE))
    for (const { account } of entries ?? []) {
        if (typeof account === 'string' && account !== mark && forgets(account)) {
            await keychain(store => store.deletePassword(KEYCHAIN_SERVICE, account))
        }
    }
    await keychain(store => store.setPassword(KEYCHAIN_SERVICE, mark, 'done'))
    return true
}

/**
 * Forgets that couldn't be done when they were asked for (see forgetLater), each of one store's part: the Vault's
 * (`inVault`), or the keychain's. Each is done the next time its store is used and can be read (see used, doLater),
 * and what it would forget isn't looked up in that store meanwhile (see withheld). `saved`: keys a password was saved
 * under in that store since, which is a new one, and stays. Kept in this window's memory, for as long as it is open.
 */
const later: { forgets: (key: string) => boolean, inVault: boolean, saved: Set<string> }[] = []
let laterRunning: Promise<void> | null = null

/**
 * The saved passwords whose key `forgets` matches are to go from one store (the Vault, or with `inVault` false the
 * keychain), and couldn't now (it couldn't be listed or wouldn't forget: a Vault whose passphrase prompt was
 * cancelled, a keychain that didn't answer): forgotten once that store can be read (see doLater), and not used from it
 * meanwhile, so that the desktop asks. The other store's part doesn't wait for it.
 */
function forgetLater (forgets: (key: string) => boolean, inVault: boolean): void {
    later.push({ forgets, inVault, saved: new Set() })
}

/**
 * forgetLater's work, each store's part on its own, so that one that can't be read doesn't hold up the other: the
 * keychain's whenever it can be listed; the Vault's at once while the Vault is off (there is nothing in it then: Tabby
 * drops its contents when it is turned off), and otherwise once it is open. Not at the cost of a passphrase prompt of
 * its own: with the Vault locked, its part waits for the Vault's next unlock (by whatever unlocks it, a password looked
 * up or saved), and what it covers isn't used meanwhile.
 */
async function doLater (): Promise<void> {
    for (const inVault of [true, false]) {
        const jobs = later.filter(job => job.inVault === inVault)
        if (!jobs.length || inVault && vaultOn() && !vaultOpen()) {
            continue
        }
        const entries = await entriesOf(inVault)
        if (!entries) {
            continue
        }
        for (const job of jobs) {
            if (await forgetListed(inVault, entries, job.forgets, job.saved)) {
                later.splice(later.indexOf(job), 1)
            }
        }
    }
}

function vaultOpen (): boolean {
    try {
        return !!vault?.isOpen()
    } catch {
        return false
    }
}

/**
 * Whether `key` is one forgetOnce's work would forget from that store (the Vault, or with `inVault` false the
 * keychain), and that part isn't done yet (see used), or one a forget left for later would forget from that store (see
 * forgetLater): what is saved under it there isn't used meanwhile.
 */
function withheld (key: string, inVault: boolean): boolean {
    if (later.some(job => job.inVault === inVault && !job.saved.has(key) && job.forgets(key))) {
        return true
    }
    const job = once
    if (!job || (inVault ? job.vault.done() : job.keychainDone)) {
        return false
    }
    try {
        return job.forgets()(key)
    } catch {
        return true
    }
}

/**
 * Targets whose key changed (see RemoteTargets.keyChanged): the key each had up to 0.5.0, by the key it has now. A
 * password saved under the former one moves to the new one the first time it is looked for there (see loadCredentials):
 * when its store is asked anyway, so a locked Vault asks for its passphrase at a sign-in rather than when a tab opens.
 */
const formerKeys = new Map<string, string>()

/** A target's key changed from `from` to `to` (see formerKeys). */
export function renameCredentials (from: string, to: string): void {
    if (from !== to) {
        formerKeys.set(to, from)
    }
}

/**
 * Saved credentials for a desktop (keyed by its session key) or an account (`account#<id>`), or null. With the Vault
 * on, the keychain is still read for what was saved before it was turned on. Credentials saved under the target's
 * former key (see formerKeys) are moved under this one, and returned.
 */
export async function loadCredentials (key: string): Promise<Credentials | null> {
    await used()
    const found = await loadSaved(key)
    if (found) {
        return found
    }
    for (const [to, from] of formerKeys) {
        const former = rekeyed(key, to, from)
        if (former) {
            const moved = await loadSaved(former)
            if (moved) {
                // Forgotten there only once saved here: should the store refuse, it is found there again next time.
                try {
                    await saveCredentials(key, moved)
                    await forgetCredentialsOrFail(former)
                } catch { }
            }
            return moved
        }
    }
    return null
}

async function loadSaved (key: string): Promise<Credentials | null> {
    if (vaultOn() && !withheld(key, true)) {
        try {
            const secret = await vault.getSecret(VAULT_SECRET_TYPE, vaultKey(key))
            const found = parseCredentials(secret?.value)
            if (found) {
                return found
            }
        } catch { }
    }
    if (withheld(key, false)) {
        return null
    }
    try {
        return parseCredentials(await keychain<string | null>(store => store.getPassword(KEYCHAIN_SERVICE, key)))
    } catch {
        return null
    }
}

/** `label`: how the Vault page lists it (a saved account's name); otherwise made from the key. */
/**
 * Whether credentials are saved under the key, without asking the user anything: a locked Vault stays locked (its
 * entries can't be seen then: 'unknown'), where loadCredentials would prompt for the passphrase.
 */
export async function hasCredentials (key: string): Promise<'yes' | 'no' | 'unknown'> {
    if (keychainStuck && !vaultOn()) {
        return 'unknown'
    }
    if (vaultOn()) {
        try {
            if (!vault.isOpen()) {
                return 'unknown'
            }
            const contents = await vault.load()
            if (contents?.secrets?.some((s: any) => s.type === VAULT_SECRET_TYPE && s.key?.key === key && parseCredentials(s.value))) {
                return 'yes'
            }
        } catch {
            return 'unknown'
        }
    }
    try {
        return parseCredentials(await keychain<string | null>(store => store.getPassword(KEYCHAIN_SERVICE, key))) ? 'yes' : 'no'
    } catch {
        return 'unknown'
    }
}

export async function saveCredentials (key: string, credentials: Credentials, label?: string): Promise<void> {
    await saveCredentialsIf(key, credentials, () => true, label)
}

/**
 * Checks a revision within the store queue/lock, including after an asynchronous write. If invalidated while writing,
 * removes that write before a newer queued replacement can run. Never schedules a deletion behind a newer write.
 */
export async function saveCredentialsIf (key: string, credentials: Credentials, current: () => boolean, label?: string): Promise<boolean> {
    await used()
    if (vaultOn()) {
        const saved = await queued(async () => {
            if (!current()) { return false }
            await vault.addSecret({ type: VAULT_SECRET_TYPE, key: { ...vaultKey(key), description: label ?? vaultName(key) }, value: JSON.stringify(credentials) })
            if (!current()) { await vault.removeSecret(VAULT_SECRET_TYPE, vaultKey(key)); return false }
            return true
        })
        if (!saved) { return false }
        newlySaved(key, true)
        // Not in two places: what the keychain had for it goes.
        try { await keychain(async store => { if (current()) { await store.deletePassword(KEYCHAIN_SERVICE, key) } }) } catch { }
        return true
    }
    const saved = await keychain(async store => {
        if (!current()) { return false }
        await store.setPassword(KEYCHAIN_SERVICE, key, JSON.stringify(credentials))
        if (!current()) { await store.deletePassword(KEYCHAIN_SERVICE, key); return false }
        return true
    })
    if (saved) { newlySaved(key, false) }
    return !!saved
}

/**
 * A password was saved under `key` just now, in the Vault or with `inVault` false the keychain, in place of what a
 * forget left for later would forget from that store (see forgetLater): it stays. (What the other store has under that
 * key is still the old one.) The rest of such a forget is done now, while the store that took the password can be read.
 */
function newlySaved (key: string, inVault: boolean): void {
    for (const job of later) {
        if (job.inVault === inVault) {
            job.saved.add(key)
        }
    }
    if (later.length) {
        used().catch(() => undefined)
    }
}

/**
 * The latest forgets (a password forgotten for a key, an edit or a removal of a desktop, the passwords under a former
 * key), each with a number and what it covers. A sign-in that began before one and ends after it, the server having
 * taken its time, mustn't save its password again, which would undo the forget (see forgottenSince). Only the last
 * FORGETS_KEPT are kept.
 */
const FORGETS_KEPT = 256
const forgotten: { n: number, covers: (key: string) => boolean }[] = []
let forgetCount = 0

/** Records a forget, as it is asked for: what began before it doesn't save under the keys it covers. */
function noteForget (covers: (key: string) => boolean): void {
    forgotten.push({ n: ++forgetCount, covers })
    if (forgotten.length > FORGETS_KEPT) {
        forgotten.shift()
    }
}

/** Where the forgets stand now: what a sign-in takes when its credentials are, to ask forgottenSince when it ends. */
export function forgetMark (): number {
    return forgetCount
}

/**
 * Whether a forget covering `key` was asked for since `mark` (see forgetMark): the desktop was edited or removed, or
 * what was saved for it forgotten, while a sign-in ended later was under way. A mark older than the forgets kept counts
 * as forgotten since: a sign-in that slow asks again, at worst.
 */
export function forgottenSince (key: string, mark: number): boolean {
    return forgetCount - mark > forgotten.length || forgotten.some(f => f.n > mark && f.covers(key))
}

export async function forgetCredentials (key: string): Promise<void> {
    try {
        await forgetCredentialsOrFail(key)
    } catch { }
}

/** As forgetCredentials, but a store that wouldn't (a Vault prompt cancelled, a keychain not answering) is reported. */
export async function forgetCredentialsOrFail (key: string): Promise<void> {
    noteForget(k => k === key)
    await used()
    return forgetNow(key)
}

/** An account edit/removal must not delete a replacement committed by a later edit. */
export async function forgetCredentialsIf (key: string, current: () => boolean): Promise<void> {
    noteForget(k => k === key)
    await used()
    if (vaultOn()) {
        await queued(async () => { if (current()) { await vault.removeSecret(VAULT_SECRET_TYPE, vaultKey(key)) } })
    }
    await keychain(async store => { if (current()) { await store.deletePassword(KEYCHAIN_SERVICE, key) } })
}

/** Forgets what is saved under `key`, in both stores. */
async function forgetNow (key: string): Promise<void> {
    await forgetIn(true, key)
    await forgetIn(false, key)
}

/** Forgets what is saved under `key` in one store: the Vault (while it is on), or with `inVault` false the keychain. */
async function forgetIn (inVault: boolean, key: string): Promise<void> {
    if (inVault) {
        if (vaultOn()) {
            await queued(() => vault.removeSecret(VAULT_SECRET_TYPE, vaultKey(key)))
        }
        return
    }
    // No keychain at all is not a failure to forget; one that didn't answer is.
    await keychain(store => store.deletePassword(KEYCHAIN_SERVICE, key))
}

/** Where passwords are kept: Tabby's Vault, or this computer's keychain. */
export type Store = 'vault' | 'keychain'

/**
 * Every entry saved in one store, by its key: the Vault's (none while it is off: Tabby drops its contents when it is
 * turned off), or with `inVault` false the keychain's (none without one). Null where that store can't be listed in full
 * now (a Vault whose passphrase prompt was cancelled, a keychain that doesn't answer): what goes by such a list,
 * forgetting or moving a desktop's passwords, would leave the rest in place, and in use. Each store is listed on its
 * own, so that one that can't be doesn't keep what the other holds from being done.
 */
async function entriesOf (inVault: boolean): Promise<{ account: string, password: string }[] | null> {
    try {
        if (!inVault) {
            const entries = await keychain<{ account: string, password: string }[]>(store => store.findCredentials(KEYCHAIN_SERVICE))
            return (entries ?? []).filter(entry => typeof entry?.account === 'string')
        }
        if (!vaultOn()) {
            return []
        }
        const contents = await vault.load()
        return (contents?.secrets ?? []).filter((secret: any) => secret?.type === VAULT_SECRET_TYPE && typeof secret.key?.key === 'string')
            .map((secret: any) => ({ account: secret.key.key, password: secret.value }))
    } catch {
        return null
    }
}

/**
 * Forgets from one store (the Vault, or with `inVault` false the keychain) what `entries`, all it holds (see
 * entriesOf), has under a key `forgets` matches, but for those `kept`. False where it wouldn't forget one of them.
 */
async function forgetListed (inVault: boolean, entries: { account: string }[], forgets: (key: string) => boolean, kept?: Set<string>): Promise<boolean> {
    let done = true
    for (const key of new Set(entries.map(({ account }) => account))) {
        if (!kept?.has(key) && forgets(key)) {
            try {
                await forgetIn(inVault, key)
            } catch {
                done = false
            }
        }
    }
    return done
}

/**
 * What a saved desktop password's key adds for the RD Gateway it goes through (`@gateway#host:port`, the gateway as
 * parseGateway has it, so another spelling of it is the same one), or '' for none. Whenever a desktop has a gateway,
 * its password is kept for that gateway too, a gateway account of its own or not: a password saved for one gateway
 * (or for a connection without one) is never sent through a different gateway named for the same address, which could
 * lead somewhere else, without asking.
 */
export function gatewayScope (gateway: string | undefined): string {
    const parsed = gateway ? parseGateway(gateway) : null
    return parsed ? `@gateway#${parsed.host}:${parsed.port}` : ''
}

/**
 * Which saved passwords of a desktop an edit or a removal applies to: a direct one's (`rdp#<id>`) with `direct`, else
 * those of the desktops at that address behind any SSH host (`<ssh key>#<id>`); with `scope` (see gatewayScope), only
 * those for that gateway ('' for none), else for any.
 */
export interface SavedFor {
    direct?: boolean
    scope?: string
}

/**
 * Whether a credential key is one of a desktop's saved passwords (see SavedFor). Anchored on the key's parts, so an
 * unrelated key that merely ends in `#<id>` (a gateway pin, or a desktop whose own id is a suffix of another's) isn't
 * matched; a gateway suffix on the key doesn't change the id.
 */
export function isFor (account: string, desktopId: string, which: SavedFor): boolean {
    const { target, desktopId: id, gateway } = keyParts(account)
    return id === desktopId && (which.direct ? target === DIRECT_KEY : target !== DIRECT_KEY && target !== 'gateway' && target !== 'account') &&
        (which.scope === undefined || gateway === which.scope)
}

/**
 * Forgets a desktop's saved passwords (see SavedFor; by default those behind any SSH host, for any gateway), from each
 * store on its own. Where one can't be listed or won't forget now, its part goes later, and what it has of them isn't
 * used meanwhile (see forgetLater): a user name changed while the Vault's prompt is cancelled doesn't leave the old
 * one's password to sign in with, and a keychain that doesn't answer doesn't keep the Vault's from going at once.
 * Returns the stores whose part waits (none, as a rule).
 */
export async function forgetCredentialsFor (desktopId: string, which: SavedFor = {}): Promise<Store[]> {
    const forgets = (key: string) => isFor(key, desktopId, which)
    noteForget(forgets)
    await used()
    const waiting: Store[] = []
    for (const inVault of [true, false]) {
        const entries = await entriesOf(inVault)
        if (!entries || !await forgetListed(inVault, entries, forgets)) {
            forgetLater(forgets, inVault)
            waiting.push(inVault ? 'vault' : 'keychain')
        }
    }
    return waiting
}

/**
 * A desktop's address changed: its saved passwords (see SavedFor) move to the new address, for the same gateway. One
 * that another desktop already has there (one at that address behind the same host, say) stays that desktop's: the
 * moved one is dropped rather than put in its place, and the edited desktop asks. So is one for an address where a
 * desktop is known already (`known`, by the session key there: a certificate is remembered for it, as it is when each
 * password is looked at): the machine there may be another desktop's, which would otherwise get the edited desktop's
 * password unasked, its certificate checking out as its own.
 *
 * Behind an SSH host, a password moves only with the certificate remembered for its desktop (`known` at the old
 * address), which goes along and stays at the old address too (see RemoteDesktopService.desktopEdited): a desktop
 * behind a host trusts its first certificate unasked, so a password that came to the new address alone would go to
 * whatever answers there first, and so would one that stayed at the old address without it (another desktop's,
 * reached another way). The keys don't show which host a desktop entry is behind, so an edit moves the passwords at
 * that address behind every host: this way none of them reaches a machine at the new address that isn't the one it was
 * saved for (another host's, or the one a mistyped address leads to) without a question. Without a certificate, a
 * password is dropped, and that desktop asks. What isn't to be used (see withheld) doesn't move either. Each store's
 * part is done on its own: one that can't be listed (a Vault whose prompt was cancelled, a keychain that doesn't
 * answer) moves nothing, what it has at the old address goes later (see forgetLater), and what it has at the new one
 * can't be seen, so only the other store's tells what is there already. Returns the stores whose part waits (none, as
 * a rule): what they have at the old address is found there again should this window close first, where the
 * certificate stays (see RemoteDesktopService.desktopEdited).
 */
export async function moveCredentialsFor (fromId: string, toId: string, which: SavedFor = {}, known: (sessionKey: string) => boolean = () => false): Promise<Store[]> {
    const forgets = (key: string) => isFor(key, fromId, which)
    noteForget(forgets)
    await used()
    const stores: { inVault: boolean, entries: { account: string, password: string }[] | null }[] = []
    for (const inVault of [true, false]) {
        stores.push({ inVault, entries: await entriesOf(inVault) })
    }
    const taken = new Set(stores.flatMap(({ entries }) => entries ?? []).map(({ account }) => account))
    const waiting: Store[] = []
    for (const { inVault, entries } of stores) {
        let done = !!entries
        for (const { account, password } of entries ?? []) {
            const credentials = parseCredentials(password)
            const { target, gateway } = keyParts(account)
            if (forgets(account) && credentials) {
                const to = `${target}#${toId}${gateway}`
                const pinned = target === DIRECT_KEY || known(`${target}#${fromId}`)
                try {
                    if (!taken.has(to) && !known(`${target}#${toId}`) && pinned && !withheld(account, inVault)) {
                        await saveCredentials(to, credentials)
                        taken.add(to)
                    }
                } catch { }
                try {
                    await forgetIn(inVault, account)
                } catch {
                    done = false
                }
            }
        }
        if (!done) {
            forgetLater(forgets, inVault)
            waiting.push(inVault ? 'vault' : 'keychain')
        }
    }
    return waiting
}

/**
 * A target's key changed from `from`, a key no target has any more, whose saved passwords nothing moves (see
 * RemoteTargets.keyChanged): those under it (its own desktop's and those of the desktops behind it, see rekeyed) are
 * forgotten from each store once it can be read, and not used from it meanwhile (see forgetLater).
 */
export function forgetFormerKey (from: string): void {
    const forgets = (key: string) => rekeyed(key, from, from) !== null
    noteForget(forgets)
    forgetLater(forgets, true)
    forgetLater(forgets, false)
}

export const STYLE = `
.trd-signin { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 1; }
.trd-signin form { display: flex; flex-direction: column; gap: 10px; width: 300px; max-width: calc(100% - 32px); color: #ccc; font-size: 13px; }
.trd-signin .trd-signin-title { font-size: 15px; color: #eee; }
.trd-signin .trd-signin-error { color: #f08080; white-space: pre-line; }
.trd-signin .trd-signin-error:empty { display: none; }
.trd-signin label.trd-signin-remember { display: flex; gap: 6px; align-items: center; }
.trd-signin .trd-signin-buttons { display: flex; gap: 8px; justify-content: flex-end; }
`

/**
 * Asks for the account in the desktop layer. Resolves with what was entered (and whether to remember it),
 * or null when cancelled or when `abort` fires (the desktop was disconnected meanwhile).
 */
export function askCredentials (
    layer: HTMLElement,
    options: {
        title: string, username?: string, error?: string, canRemember: boolean,
        /** Signing in with a saved account: its name. The user name is the account's, and remembering updates it. */
        account?: string,
    },
    abort: Promise<void>,
): Promise<(Credentials & { remember: boolean }) | null> {
    const box = document.createElement('div')
    box.className = 'trd-signin'
    box.innerHTML = `
        <form autocomplete="off">
            <div class="trd-signin-title"></div>
            <div class="trd-signin-error"></div>
            <input class="form-control" name="username" placeholder="User name (or DOMAIN\\user)" spellcheck="false">
            <input class="form-control" name="password" type="password" placeholder="Password">
            <label class="trd-signin-remember"><input type="checkbox" name="remember" checked> Remember</label>
            <div class="trd-signin-buttons">
                <button type="button" class="btn btn-secondary" name="cancel">Cancel</button>
                <button type="submit" class="btn btn-primary">Connect</button>
            </div>
        </form>`
    const form = box.querySelector('form')!
    const field = (name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement
    box.querySelector('.trd-signin-title')!.textContent = options.title
    form.querySelector('.trd-signin-remember')!.lastChild!.textContent = ` Remember in ${storeName()}`
    box.querySelector('.trd-signin-error')!.textContent = options.error ?? ''
    field('username').value = options.username ?? ''
    if (options.account) {
        // The account's user name is changed where the account is (Settings), for every desktop that uses it.
        field('username').readOnly = true
        field('username').title = `The saved account "${options.account}"`
        form.querySelector('.trd-signin-remember')!.lastChild!.textContent = ` Save as the password of "${options.account}" (in ${storeName()})`
    }
    if (!options.canRemember) {
        field('remember').checked = false
        form.querySelector<HTMLElement>('.trd-signin-remember')!.style.display = 'none'
    }
    layer.appendChild(box)
    // Focus goes to the form from DesktopSession.focusDesktop(), which also takes it back from Tabby.

    return new Promise(resolve => {
        const done = (result: (Credentials & { remember: boolean }) | null) => {
            box.remove()
            resolve(result)
        }
        form.addEventListener('submit', event => {
            event.preventDefault()
            const username = field('username').value.trim()
            if (!username) {
                field('username').focus()
                return
            }
            done({ username, password: field('password').value, remember: field('remember').checked })
        })
        field('cancel').addEventListener('click', () => done(null))
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                done(null)
            }
        })
        abort.then(() => done(null))
    })
}
