/**
 * Saved accounts: a user name (and domain) under a name of its own, which several desktops can sign in with. The list
 * is `remoteDesktop.accounts` in Tabby's config; the password is in the system keychain, once per account, so a new
 * password is entered once for every desktop that uses the account.
 *
 *     remoteDesktop:
 *       accounts:
 *         - id: k3f9x2ab            # what desktops refer to (`account: k3f9x2ab`); stays when the name changes
 *           name: Domain A admin
 *           username: adm.user
 *           domain: DOMAIN_A        # optional
 */
export interface SavedAccount {
    id: string
    name: string
    username: string
    domain?: string
    /** Opaque credential-edit revision, synced with the account; never a password or password hash. */
    credentialRevision?: string
}

/** A separate gateway sign-in prompt. The '@' cannot occur in a saved account's id. */
export const ASK_GATEWAY_ACCOUNT = '@ask'

/** The usable entries of `remoteDesktop.accounts` (hand-written ones may lack fields). */
export function accountsOf (store: any): SavedAccount[] {
    const list = Array.isArray(store?.accounts) ? store.accounts : []
    const seen = new Set<string>()
    return list.flatMap((a: any): SavedAccount[] => {
        const id = typeof a?.id === 'string' ? a.id.trim() : ''
        const username = typeof a?.username === 'string' ? a.username.trim() : ''
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !username || seen.has(id)) {
            return []
        }
        seen.add(id)
        const domain = typeof a.domain === 'string' && a.domain.trim() ? a.domain.trim() : undefined
        return [{ id, name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : signInName({ username, domain }), username,
            ...domain ? { domain } : {}, ...typeof a.credentialRevision === 'string' ? { credentialRevision: a.credentialRevision } : {} }]
    })
}

/** A new account's id: nothing in it but that it is unused. */
export function newAccountId (taken: SavedAccount[]): string {
    for (;;) {
        const id = Math.random().toString(36).slice(2, 10).padEnd(8, '0')
        if (!taken.some(a => a.id === id)) {
            return id
        }
    }
}

/** What the account signs in as: DOMAIN\user, or the user name as typed when it names its domain itself. */
export function signInName (account: Pick<SavedAccount, 'username' | 'domain'>): string {
    return account.domain && !/[\\@]/.test(account.username) ? `${account.domain}\\${account.username}` : account.username
}

/** Where the keychain keeps an account's password (next to the desktops' own entries, which are session keys). */
export function accountKey (id: string): string {
    return `account#${id}`
}
