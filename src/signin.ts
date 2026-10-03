/**
 * Sign-in for desktops that use their own accounts (Windows): a form in the desktop layer, and where passwords are
 * kept: Tabby's Vault when it is enabled (encrypted, part of the config, as Tabby's SSH passwords), else the system
 * keychain.
 */
import { DIRECT_KEY } from './desktops'

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
function queued<T> (work: () => Promise<T>): Promise<T> {
    const next = vaultQueue.then(work, work)
    vaultQueue = next.catch(() => null)
    return next
}
/** How a Vault entry is found: by the same key as the keychain's; its `description` is only for a listing. */
function vaultKey (key: string): { key: string } {
    return { key }
}
function vaultName (key: string): string {
    const [who, address] = key.split('#', 2)
    return who === 'account' ? `saved account` : who === DIRECT_KEY ? `${address} (direct)` : address ? `${address} behind ${who}` : who
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
        const store = keytar()
        if (!store) {
            resolve(undefined)
            return
        }
        const timer = setTimeout(() => {
            keychainStuck = true
            reject(new Error('the keychain did not answer'))
        }, KEYCHAIN_TIMEOUT_MS)
        Promise.resolve(call(store)).then(
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
 * Saved credentials for a desktop (keyed by its session key) or an account (`account#<id>`), or null. With the Vault
 * on, the keychain is still read for what was saved before it was turned on.
 */
export async function loadCredentials (key: string): Promise<Credentials | null> {
    if (vaultOn()) {
        try {
            const secret = await vault.getSecret(VAULT_SECRET_TYPE, vaultKey(key))
            const found = parseCredentials(secret?.value)
            if (found) {
                return found
            }
        } catch { }
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
    if (vaultOn()) {
        await queued(() => vault.addSecret({ type: VAULT_SECRET_TYPE, key: { ...vaultKey(key), description: label ?? vaultName(key) }, value: JSON.stringify(credentials) }))
        // Not in two places: what the keychain had for it goes.
        try { await keychain(store => store.deletePassword(KEYCHAIN_SERVICE, key)) } catch { }
        return
    }
    await keychain(store => store.setPassword(KEYCHAIN_SERVICE, key, JSON.stringify(credentials)))
}

export async function forgetCredentials (key: string): Promise<void> {
    try {
        await forgetCredentialsOrFail(key)
    } catch { }
}

/** As forgetCredentials, but a store that wouldn't (a Vault prompt cancelled, a keychain not answering) is reported. */
export async function forgetCredentialsOrFail (key: string): Promise<void> {
    if (vaultOn()) {
        await queued(() => vault.removeSecret(VAULT_SECRET_TYPE, vaultKey(key)))
    }
    // No keychain at all is not a failure to forget; one that didn't answer is.
    await keychain(store => store.deletePassword(KEYCHAIN_SERVICE, key))
}

/** Every saved entry's key and value, from the Vault (when on) and the keychain. */
async function allCredentials (): Promise<{ account: string, password: string }[]> {
    const entries: { account: string, password: string }[] = []
    if (vaultOn()) {
        try {
            const contents = await vault.load()
            for (const secret of contents?.secrets ?? []) {
                if (secret.type === VAULT_SECRET_TYPE && typeof secret.key?.key === 'string') {
                    entries.push({ account: secret.key.key, password: secret.value })
                }
            }
        } catch { }
    }
    try {
        entries.push(...await keychain<{ account: string, password: string }[]>(store => store.findCredentials(KEYCHAIN_SERVICE)) ?? [])
    } catch { }
    return entries
}

/** Whether a saved account is for a desktop at this address behind some SSH host (not a direct one: `rdp#<id>`). */
function isBehindHost (account: string, desktopId: string): boolean {
    return account.endsWith(`#${desktopId}`) && !account.startsWith(`${DIRECT_KEY}#`)
}

/** Forgets saved accounts for a desktop on any SSH host (session keys ending in `#<id>`). */
export async function forgetCredentialsFor (desktopId: string): Promise<void> {
    for (const { account } of await allCredentials()) {
        if (isBehindHost(account, desktopId)) {
            await forgetCredentials(account)
        }
    }
}

/** A desktop's address changed: its saved accounts (session keys ending in `#<from>`) move to the new address. */
export async function moveCredentialsFor (fromId: string, toId: string): Promise<void> {
    for (const { account, password } of await allCredentials()) {
        const credentials = parseCredentials(password)
        if (isBehindHost(account, fromId) && credentials) {
            try {
                await saveCredentials(`${account.slice(0, -fromId.length)}${toId}`, credentials)
                await forgetCredentials(account)
            } catch { }
        }
    }
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
