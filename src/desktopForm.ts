import { ExtraDesktopConfig } from './desktops'
import { wakeFromText } from './wake'

/** host:port, [v6]:port, or a bare host (RDP's 3389); null if it doesn't look like an address. */
export function parseAddress (text: string): { host: string, port: number } | null {
    const m = /^\[([^\]]+)\](?::(\d+))?$|^([^:\s]+)(?::(\d+))?$/.exec(text.trim())
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
    return entry.wake?.vm ?? entry.wake?.mac ?? ''
}

export interface DesktopFormOptions {
    title: string
    /** The submit button's label. */
    action: string
    /** The entry being edited (fields filled in from it, `via` kept), or the new entry's `via`. */
    entry: ExtraDesktopConfig
    /** Refuses an entry with a message (e.g. the address is taken), or null to accept it. */
    check?: (entry: ExtraDesktopConfig) => string | null
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
        <div class="trd-signin">
            <form autocomplete="off">
                <div class="trd-signin-title"></div>
                <div class="trd-signin-error"></div>
                <input class="form-control" name="name" placeholder="Name, e.g. Windows VM" spellcheck="false">
                <input class="form-control" name="address" placeholder="Address as seen from the host, e.g. 127.0.0.1:3389" spellcheck="false">
                <select class="form-control" name="kind">
                    <option value="windows">Windows (or another RDP server)</option>
                    <option value="xrdp">xrdp (Linux: KDE, XFCE, MATE, …)</option>
                    <option value="gnome">GNOME Remote Desktop (needs the graphics pipeline)</option>
                </select>
                <input class="form-control" name="username" placeholder="User name (optional; asked when connecting)" spellcheck="false">
                <input class="form-control" name="domain" placeholder="Domain (optional)" spellcheck="false">
                <input class="form-control" name="wake" placeholder="Start it when off (optional): libvirt VM name, or MAC address" title="A libvirt VM on the host, started with virsh; or a MAC address to wake over the network from the host" spellcheck="false">
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
    field('name').value = initial.name ?? ''
    field('address').value = formatAddress(initial.host ?? '127.0.0.1', Number(initial.port ?? 3389))
    field<HTMLSelectElement>('kind').value = initial.kind === 'gnome' || initial.kind === 'xrdp' ? initial.kind : 'windows'
    field('username').value = initial.username ?? ''
    field('domain').value = initial.domain ?? ''
    field('wake').value = wakeTextOf(initial)

    if (getComputedStyle(pane).position === 'static') {
        pane.style.position = 'relative'
    }
    pane.appendChild(overlay)
    // Same as a desktop layer: the terminal underneath can't take the keyboard while the form shows.
    const inputs = Array.from(pane.querySelectorAll<HTMLTextAreaElement>('textarea.xterm-helper-textarea')).filter(t => !t.disabled)
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
            const username = field('username').value.trim()
            const domain = field('domain').value.trim()
            const kind = field<HTMLSelectElement>('kind').value
            const wakeText = field('wake').value.trim()
            // An unchanged wake keeps what the field doesn't show (a Wake-on-LAN broadcast address and port).
            const wake = wakeText && wakeText === wakeTextOf(initial) ? initial.wake : wakeFromText(wakeText)
            // Other keys of an edited entry (hand-written ones) are kept.
            const entry: ExtraDesktopConfig = {
                ...initial,
                name,
                host: address.host,
                port: address.port,
                kind: kind === 'gnome' || kind === 'xrdp' ? kind : 'windows',
                username: username || undefined,
                domain: domain || undefined,
                wake,
            }
            for (const key of ['username', 'domain', 'wake'] as const) {
                if (entry[key] === undefined) {
                    delete entry[key]
                }
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
