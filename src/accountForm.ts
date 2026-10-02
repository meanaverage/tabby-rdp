/** A small "new account" form that sits inside the forms that pick an account, so one can be added without leaving. */
import { SavedAccount } from './accounts'

export const NEW_ACCOUNT = '__new__'

export const STYLE = `
.trd-new-account { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; padding: 10px; border-radius: 6px;
    border: 1px solid rgba(128, 128, 128, 0.35); }
.trd-new-account .trd-new-account-error { grid-column: 1 / -1; color: #f08080; font-size: 12px; }
.trd-new-account .trd-new-account-error:empty { display: none; }
.trd-new-account .trd-new-account-buttons { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; }
`

export interface NewAccountInput {
    name: string
    username: string
    domain: string
    password: string
}

/**
 * Wires an account `<select>` that ends with "New account…": choosing it opens the form under the select; "Add" hands
 * the fields to `save`, which returns the saved account, and the select then offers and shows it. `onChange` is told
 * the chosen id ('' for none) whenever it changes, the new account included.
 */
export function newAccountOption (
    select: HTMLSelectElement,
    label: (a: SavedAccount) => string,
    save: (input: NewAccountInput) => Promise<SavedAccount>,
    onChange: (id: string) => void,
): void {
    select.append(new Option('New account…', NEW_ACCOUNT))
    let last = select.value
    let form: HTMLFormElement | null = null
    const close = () => {
        form?.remove()
        form = null
    }
    select.addEventListener('change', () => {
        if (select.value !== NEW_ACCOUNT) {
            close()
            last = select.value
            onChange(select.value)
            return
        }
        if (form) {
            return
        }
        form = document.createElement('form')
        form.className = 'trd-new-account'
        form.autocomplete = 'off'
        form.innerHTML = `
            <input class="form-control form-control-sm" name="name" placeholder="Name, e.g. Domain A admin" spellcheck="false">
            <input class="form-control form-control-sm" name="username" placeholder="User name, or DOMAIN\\user" spellcheck="false">
            <input class="form-control form-control-sm" name="domain" placeholder="Domain (optional)" spellcheck="false">
            <input class="form-control form-control-sm" name="password" type="password" autocomplete="new-password" placeholder="Password (optional; asked on the first connection)">
            <div class="trd-new-account-error"></div>
            <div class="trd-new-account-buttons">
                <button type="button" class="btn btn-secondary btn-sm" name="cancel">Cancel</button>
                <button type="submit" class="btn btn-primary btn-sm">Add account</button>
            </div>`
        const field = (name: string) => form!.querySelector(`[name="${name}"]`) as HTMLInputElement
        const error = form.querySelector('.trd-new-account-error')!
        // Keys typed in it are its own (the forms around it act on Enter and Escape).
        form.addEventListener('keydown', event => {
            event.stopPropagation()
            if (event.key === 'Escape') {
                event.preventDefault()
                field('cancel').click()
            }
        })
        field('cancel').addEventListener('click', () => {
            close()
            select.value = last
        })
        form.addEventListener('submit', async event => {
            event.preventDefault()
            event.stopPropagation()
            const username = field('username').value.trim()
            if (!username) {
                error.textContent = 'Give it a user name.'
                field('username').focus()
                return
            }
            try {
                const account = await save({ name: field('name').value.trim(), username, domain: field('domain').value.trim(), password: field('password').value })
                const option = new Option(label(account), account.id)
                select.insertBefore(option, select.querySelector(`option[value="${NEW_ACCOUNT}"]`))
                select.value = account.id
                last = account.id
                close()
                onChange(account.id)
            } catch (e: any) {
                error.textContent = `Couldn't save it: ${e?.message ?? e}`
            }
        })
        select.insertAdjacentElement('afterend', form)
        field('name').focus()
    })
}
