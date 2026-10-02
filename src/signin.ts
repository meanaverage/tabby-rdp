/** Sign-in for desktops that use their own accounts (Windows): a form in the desktop layer, and the keychain. */
import { DIRECT_KEY } from './desktops'

export interface Credentials {
    username: string
    password: string
}

const KEYCHAIN_SERVICE = 'tabby-rdp'

// The system keychain can keep a call waiting indefinitely: on Linux, a locked or missing keyring waits for an unlock
// prompt, which a session without a keyring prompter never shows. Give up after a while. A call that never returns
// also keeps one of Node's few worker threads, which the rest of Tabby needs: after one, stop using the keychain.
const KEYCHAIN_TIMEOUT_MS = 10000
let keychainStuck = false

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

function answered<T> (call: Promise<T> | undefined): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            keychainStuck = true
            reject(new Error('the keychain did not answer'))
        }, KEYCHAIN_TIMEOUT_MS)
        Promise.resolve(call).then(
            value => { clearTimeout(timer); resolve(value) },
            error => { clearTimeout(timer); reject(error) })
    })
}

/** Saved credentials for a desktop (keyed by its session key), or null. */
export async function loadCredentials (key: string): Promise<Credentials | null> {
    try {
        const saved = await answered<string | null>(keytar()?.getPassword(KEYCHAIN_SERVICE, key))
        const parsed = saved ? JSON.parse(saved) : null
        return parsed?.username && typeof parsed.password === 'string' ? { username: parsed.username, password: parsed.password } : null
    } catch {
        return null
    }
}

export async function saveCredentials (key: string, credentials: Credentials): Promise<void> {
    await answered(keytar()?.setPassword(KEYCHAIN_SERVICE, key, JSON.stringify(credentials)))
}

export async function forgetCredentials (key: string): Promise<void> {
    try {
        await answered(keytar()?.deletePassword(KEYCHAIN_SERVICE, key))
    } catch { }
}

/** Whether a saved account is for a desktop at this address behind some SSH host (not a direct one: `rdp#<id>`). */
function isBehindHost (account: string, desktopId: string): boolean {
    return account.endsWith(`#${desktopId}`) && !account.startsWith(`${DIRECT_KEY}#`)
}

/** Forgets saved accounts for a desktop on any SSH host (session keys ending in `#<id>`). */
export async function forgetCredentialsFor (desktopId: string): Promise<void> {
    try {
        const k = keytar()
        for (const { account } of await answered<{ account: string }[]>(k?.findCredentials(KEYCHAIN_SERVICE)) ?? []) {
            if (isBehindHost(account, desktopId)) {
                await answered(k.deletePassword(KEYCHAIN_SERVICE, account))
            }
        }
    } catch { }
}

/** A desktop's address changed: its saved accounts (session keys ending in `#<from>`) move to the new address. */
export async function moveCredentialsFor (fromId: string, toId: string): Promise<void> {
    try {
        const k = keytar()
        for (const { account, password } of await answered<{ account: string, password: string }[]>(k?.findCredentials(KEYCHAIN_SERVICE)) ?? []) {
            if (isBehindHost(account, fromId)) {
                await answered(k.setPassword(KEYCHAIN_SERVICE, `${account.slice(0, -fromId.length)}${toId}`, password))
                await answered(k.deletePassword(KEYCHAIN_SERVICE, account))
            }
        }
    } catch { }
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
            <label class="trd-signin-remember"><input type="checkbox" name="remember" checked> Remember in the keychain</label>
            <div class="trd-signin-buttons">
                <button type="button" class="btn btn-secondary" name="cancel">Cancel</button>
                <button type="submit" class="btn btn-primary">Connect</button>
            </div>
        </form>`
    const form = box.querySelector('form')!
    const field = (name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement
    box.querySelector('.trd-signin-title')!.textContent = options.title
    box.querySelector('.trd-signin-error')!.textContent = options.error ?? ''
    field('username').value = options.username ?? ''
    if (options.account) {
        // The account's user name is changed where the account is (Settings), for every desktop that uses it.
        field('username').readOnly = true
        field('username').title = `The saved account "${options.account}"`
        form.querySelector('.trd-signin-remember')!.lastChild!.textContent = ` Save as the password of "${options.account}"`
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
