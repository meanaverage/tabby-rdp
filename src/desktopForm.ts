import { ASK_GATEWAY_ACCOUNT, SavedAccount, signInName } from './accounts'
import { newAccountOption, NewAccountInput } from './accountForm'
import { CLIPBOARD_LABELS, ClipboardMode, ownClipboard } from './clipboard'
import { configText, ExtraDesktopConfig, xrdpFromHost } from './desktops'
import { parseGateway } from './gateway'
import { configNumber } from './osd'
import { wakeFromText } from './wake'
import { terminalInputs } from './hostCompat'

/** host:port, [v6]:port, or a bare host (RDP's 3389); null if it doesn't look like an address. */
export function parseAddress (text: string): { host: string, port: number } | null {
    // No '#' in a host: session and trust keys are split on it (see keyParts).
    const m = /^\[([^\]#]+)\](?::(\d+))?$|^([^:\s#]+)(?::(\d+))?$/.exec(text.trim())
    const host = m?.[1] ?? m?.[3]
    const port = Number(m?.[2] ?? m?.[4] ?? 3389)
    return host && Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null
}

/** The address as the form shows it. */
export function formatAddress (host: string, port: number): string {
    return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

/** An entry's `wake` as the form's field shows it: the VM's name, or the MAC address. */
function wakeTextOf (entry: ExtraDesktopConfig): string {
    return configText(entry.wake?.vm) || configText(entry.wake?.mac)
}

export interface DesktopFormOptions {
    title: string
    /** The submit button's label. */
    action: string
    /** The entry being edited (fields filled in from it, `via` kept), or the new entry's `via`. */
    entry: ExtraDesktopConfig
    /** The saved accounts to offer (Settings › Remote Desktop › Accounts). */
    accounts?: SavedAccount[]
    /** Saves a new account typed into the form's "New account…" (RemoteDesktopService.saveAccount); without it, no such choice. */
    addAccount?: (input: NewAccountInput) => Promise<SavedAccount>
    /**
     * Asks which SSH host the desktop is behind (from the settings page, where no SSH tab says): the SSH profiles'
     * names and hosts to suggest. Without it, the entry's `via` is kept as it is.
     */
    hosts?: string[]
    /** Refuses an entry with a message (e.g. the address is taken), or null to accept it. */
    check?: (entry: ExtraDesktopConfig) => string | null
    /** The clipboard setting, which a desktop without its own follows: named in that choice. */
    clipboard: ClipboardMode
}

/**
 * "Add a desktop behind <host>" and "Edit": a form over the pane (plain DOM, like the sign-in form; uses its styles).
 * While it shows, the terminal can't take focus, and focus that leaves the form comes back to it.
 * Resolves with the `remoteDesktop.desktops` entry, or null when cancelled.
 */
export function askDesktop (pane: HTMLElement, options: DesktopFormOptions): Promise<ExtraDesktopConfig | null> {
    const overlay = document.createElement('div')
    overlay.className = 'trd-overlay trd-form-overlay'
    overlay.innerHTML = `
        <div class="trd-form-dragbar"></div>
        <div class="trd-signin">
            <form autocomplete="off">
                <div class="trd-signin-title"></div>
                <div class="trd-signin-error"></div>
                <input class="form-control" name="name" placeholder="A name of your choice, e.g. Windows VM" spellcheck="false">
                <input class="form-control" name="via" list="trd-via-hosts" placeholder="The SSH host it is behind: a profile's name, or its hostname" spellcheck="false">
                <datalist id="trd-via-hosts"></datalist>
                <input class="form-control" name="address" placeholder="Address as seen from the host, e.g. 127.0.0.1:3389" spellcheck="false">
                <select class="form-control" name="kind">
                    <option value="windows">Windows (or another RDP server)</option>
                    <option value="xrdp">xrdp (Linux: KDE, XFCE, MATE, …)</option>
                    <option value="gnome">GNOME Remote Desktop (needs the graphics pipeline)</option>
                </select>
                <select class="form-control" name="account" title="Saved accounts are added in Settings › Remote Desktop › Accounts"></select>
                <input class="form-control" name="username" placeholder="User name (optional; asked when connecting)" spellcheck="false">
                <input class="form-control" name="domain" placeholder="Domain (optional)" spellcheck="false">
                <input class="form-control" name="gateway" placeholder="RD Gateway (optional), as seen from the host, e.g. rdgw.example.com" title="A Remote Desktop Gateway to reach the desktop through (HTTPS, port 443 unless given); the address above is then as the gateway sees it" spellcheck="false">
                <select class="form-control" name="gatewayAccount" title="A gateway that takes another account than the desktop: a saved account for it"></select>
                <input class="form-control" name="wake" placeholder="Start it when off (optional): libvirt VM name, or MAC address" title="A libvirt VM on the host, started with virsh; or a MAC address to wake over the network from the host" spellcheck="false">
                <select class="form-control" name="clipboard" title="Which ways text, pictures and files copied on either side go between this computer and the desktop. Applies on the next connection"></select>
                <div class="trd-signin-buttons">
                    <button type="button" class="btn btn-secondary" name="cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary"></button>
                </div>
            </form>
        </div>`
    const form = overlay.querySelector('form')!
    const field = <T extends HTMLElement = HTMLInputElement>(name: string) => form.querySelector(`[name="${name}"]`) as T
    form.querySelector('.trd-signin-title')!.textContent = options.title
    form.querySelector<HTMLElement>('button[type=submit]')!.textContent = options.action
    const error = form.querySelector('.trd-signin-error')!
    const initial = options.entry
    // Each field as text whatever the entry holds (see configText): a field makes text of what it is given, and a value
    // that can't be made text (a hand edit's, config sync's) would keep the form from opening, and the entry from being
    // put right here.
    field('name').value = configText(initial.name)
    const via = field('via')
    via.value = configText(initial.via)
    via.hidden = !options.hosts
    form.querySelector('datalist')!.append(...(options.hosts ?? []).map(h => new Option(h)))
    field('address').value = formatAddress(configText(initial.host ?? '127.0.0.1'), configNumber(initial.port ?? 3389))
    field<HTMLSelectElement>('kind').value = initial.kind === 'gnome' || initial.kind === 'xrdp' ? initial.kind : 'windows'
    // A VM saved from the host's list is xrdp on the host's word (see xrdpFromHost), which is a choice of its own here:
    // kept as long as it is chosen, so that the desktop still asks before signing in without NLA. Any kind picked is
    // the user's, xrdp included.
    if (xrdpFromHost(initial)) {
        const kind = field<HTMLSelectElement>('kind')
        kind.prepend(new Option(`xrdp, as ${configText(initial.via) || 'the host'} reported (asks before signing in without NLA)`, ''))
        kind.value = ''
    }
    field('username').value = configText(initial.username)
    field('domain').value = configText(initial.domain)
    field('wake').value = wakeTextOf(initial)
    // A saved account in place of a user name and domain of its own. Without any saved, the choice isn't shown.
    const account = field<HTMLSelectElement>('account')
    const accounts = options.accounts ?? []
    account.append(new Option('Ask for the account when connecting', ''), ...accounts.map(a => new Option(`Sign in with ${a.name} (${signInName(a)})`, a.id)))
    const initialAccount = configText(initial.account)
    if (initialAccount && !accounts.some(a => a.id === initialAccount)) {
        account.append(new Option('(a saved account that no longer exists)', initialAccount))
    }
    account.value = initialAccount
    const ownAccount = () => {
        field('username').hidden = field('domain').hidden = !!account.value && account.value !== '__new__'
    }
    account.addEventListener('change', ownAccount)
    if (options.addAccount) {
        newAccountOption(account, a => `Sign in with ${a.name} (${signInName(a)})`, options.addAccount, () => null)
    } else {
        account.hidden = account.options.length < 2
    }
    ownAccount()
    // The gateway's own account, including a separate prompt when no saved account is chosen.
    const gateway = field('gateway')
    const gatewayAccount = field<HTMLSelectElement>('gatewayAccount')
    gateway.value = configText(initial.gateway)
    gatewayAccount.append(new Option('Gateway account: the same as the desktop\'s', ''),
        new Option('Gateway account: ask when connecting', ASK_GATEWAY_ACCOUNT), ...accounts.map(a => new Option(`Gateway account: ${a.name} (${signInName(a)})`, a.id)))
    const initialGatewayAccount = configText(initial.gatewayAccount)
    if (initialGatewayAccount && initialGatewayAccount !== ASK_GATEWAY_ACCOUNT && !accounts.some(a => a.id === initialGatewayAccount)) {
        gatewayAccount.append(new Option('(a saved account that no longer exists)', initialGatewayAccount))
    }
    gatewayAccount.value = initialGatewayAccount
    const gatewayChanged = () => {
        gatewayAccount.hidden = !gateway.value.trim() || gatewayAccount.options.length < 2
    }
    gateway.addEventListener('input', gatewayChanged)
    gatewayChanged()
    // Its own clipboard sharing, or the setting's (named, as it is now).
    const clipboard = field<HTMLSelectElement>('clipboard')
    const lower = (mode: ClipboardMode) => CLIPBOARD_LABELS[mode].toLowerCase()
    clipboard.append(new Option(`Clipboard: as in Settings (${lower(options.clipboard)})`, ''),
        ...(Object.keys(CLIPBOARD_LABELS) as ClipboardMode[]).map(mode => new Option(`Clipboard: ${lower(mode)}`, mode)))
    clipboard.value = ownClipboard(initial.clipboard) ?? ''

    if (getComputedStyle(pane).position === 'static') {
        pane.style.position = 'relative'
    }
    pane.appendChild(overlay)
    // Same as a desktop layer: the terminal underneath can't take the keyboard while the form shows.
    const inputs = terminalInputs(pane).filter(t => !t.disabled)
    inputs.forEach(t => { t.disabled = true })
    const focusForm = () => {
        if (!form.contains(document.activeElement)) {
            field('name').focus()
        }
    }
    const reclaim = (event: FocusEvent) => {
        if (!overlay.contains(event.target as Node)) {
            setTimeout(focusForm)
        }
    }
    pane.addEventListener('focusin', reclaim, true)
    setTimeout(focusForm)

    return new Promise(resolve => {
        const done = (result: ExtraDesktopConfig | null) => {
            pane.removeEventListener('focusin', reclaim, true)
            inputs.forEach(t => { t.disabled = false })
            overlay.remove()
            resolve(result)
        }
        form.addEventListener('submit', event => {
            event.preventDefault()
            const name = field('name').value.trim()
            const address = parseAddress(field('address').value)
            if (!name) {
                error.textContent = 'Give it a name.'
                field('name').focus()
                return
            }
            if (!address) {
                error.textContent = 'The address should look like 127.0.0.1:3389 or vm.local:3389.'
                field('address').focus()
                return
            }
            const gatewayText = gateway.value.trim()
            if (gatewayText && !parseGateway(gatewayText)) {
                error.textContent = 'The gateway should be a name or address, with :port if it isn\'t 443.'
                gateway.focus()
                return
            }
            if (options.hosts && !via.value.trim()) {
                error.textContent = 'Which SSH host is it behind?'
                via.focus()
                return
            }
            const username = field('username').value.trim()
            const domain = field('domain').value.trim()
            const kind = field<HTMLSelectElement>('kind').value
            // '': the kind the host reported, still its word (see above).
            const picked = kind !== ''
            const wakeText = field('wake').value.trim()
            // An unchanged wake keeps what the field doesn't show (a Wake-on-LAN broadcast address and port).
            const wake = wakeText && wakeText === wakeTextOf(initial) ? initial.wake : wakeFromText(wakeText)
            // Other keys of an edited entry (hand-written ones) are kept.
            const entry: ExtraDesktopConfig = {
                ...initial,
                ...options.hosts ? { via: via.value.trim() } : {},
                name,
                host: address.host,
                port: address.port,
                kind: !picked ? initial.kind : kind === 'gnome' || kind === 'xrdp' ? kind : 'windows',
                username: username || undefined,
                domain: domain || undefined,
                account: account.value && account.value !== '__new__' ? account.value : undefined,
                wake,
                gateway: gatewayText || undefined,
                gatewayAccount: gatewayText && gatewayAccount.value || undefined,
                clipboard: clipboard.value || undefined,
            }
            for (const key of ['username', 'domain', 'account', 'wake', 'gateway', 'gatewayAccount', 'clipboard'] as const) {
                if (entry[key] === undefined) {
                    delete entry[key]
                }
            }
            // A kind left as the host reported it stays marked so; one picked is the user's, and is marked so only where
            // the entry would otherwise be taken for a VM saved before the mark existed (see xrdpFromHost).
            delete entry.kindFromHost
            if (!picked) {
                entry.kindFromHost = true
            } else if (xrdpFromHost(entry)) {
                entry.kindFromHost = false
            }
            const refused = options.check?.(entry)
            if (refused) {
                error.textContent = refused
                field('address').focus()
                return
            }
            done(entry)
        })
        field('cancel').addEventListener('click', () => done(null))
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                done(null)
            }
        })
    })
}
