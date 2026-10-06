import { randomUUID } from 'crypto'
import { SavedAccount } from './accounts'

/** No secrets: invalidates old sign-in forms in other windows before an account edit touches the store. */
const PREFIX = 'tabby-rdp.account-revision.'
type RevisionStorage = Pick<Storage, 'getItem' | 'setItem'>
export const ACCOUNT_REMEMBER_UNAVAILABLE = 'To remember this password, save the account again in Settings and reopen this sign-in form.'

export class AccountRevisions {
    constructor (
        private storage: () => RevisionStorage = () => window.localStorage,
        private coordinated: () => boolean = () => !!globalThis.navigator?.locks,
    ) { }

    /** A prompt may remember only when this window's account agrees with the shared revision. */
    capture (account: SavedAccount): string | undefined {
        const revision = account.credentialRevision ?? ''
        return this.current(account.id, revision) ? revision : undefined
    }

    current (id: string, revision: string | undefined): boolean {
        if (revision === undefined || !this.coordinated()) { return false }
        try {
            const shared = this.storage().getItem(PREFIX + id)
            return shared === null || shared === revision
        } catch { return false }
    }

    /** Synchronous publication: older writers fail their next check, including one already waiting on a store. */
    change (id: string): string {
        if (!this.coordinated()) { throw new Error('Saved account changes are unavailable. Restart or update Tabby and try again.') }
        const revision = randomUUID()
        // A failed write must stop the edit: a revision held only in this window cannot invalidate another's form.
        try { this.storage().setItem(PREFIX + id, revision) } catch {
            throw new Error('Saved account changes are unavailable. Restart Tabby and try again.')
        }
        return revision
    }
}
