import { ExtraDesktopConfig } from './desktops'
import { wakeFromText } from './wake'

/**
 * "Add a desktop behind <host>": a form over the pane (plain DOM, like the sign-in form; uses its styles).
 * While it shows, the terminal can't take focus, and focus that leaves the form comes back to it.
 * Resolves with the new `remoteDesktop.desktops` entry, or null when cancelled.
 */
export function askNewDesktop (pane: HTMLElement, via: string, viaLabel: string): Promise<ExtraDesktopConfig | null> {
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
                    <option value="gnome">GNOME Remote Desktop (needs the graphics pipeline)</option>
                </select>
                <input class="form-control" name="username" placeholder="User name (optional; asked when connecting)" spellcheck="false">
                <input class="form-control" name="wake" placeholder="Start it when off (optional): libvirt VM name, or MAC address" title="A libvirt VM on the host, started with virsh; or a MAC address to wake over the network from the host" spellcheck="false">
                <div class="trd-signin-buttons">
                    <button type="button" class="btn btn-secondary" name="cancel">Cancel</button>
                    <button type="submit" class="btn btn-primary">Add and open</button>
                </div>
            </form>
        </div>`
    const form = overlay.querySelector('form')!
    const field = <T extends HTMLElement = HTMLInputElement>(name: string) => form.querySelector(`[name="${name}"]`) as T
    form.querySelector('.trd-signin-title')!.textContent = `Add a desktop reached through ${viaLabel}`
    const error = form.querySelector('.trd-signin-error')!
    field('address').value = '127.0.0.1:3389'

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
            // host:port, [v6]:port, or a bare host (RDP's 3389).
            const m = /^\[([^\]]+)\](?::(\d+))?$|^([^:\s]+)(?::(\d+))?$/.exec(field('address').value.trim())
            const host = m?.[1] ?? m?.[3]
            const port = Number(m?.[2] ?? m?.[4] ?? 3389)
            if (!name) {
                error.textContent = 'Give it a name.'
                field('name').focus()
                return
            }
            if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
                error.textContent = 'The address should look like 127.0.0.1:3389 or vm.local:3389.'
                field('address').focus()
                return
            }
            const username = field('username').value.trim()
            const wake = wakeFromText(field('wake').value)
            done({
                name,
                via,
                host,
                port,
                kind: field<HTMLSelectElement>('kind').value === 'gnome' ? 'gnome' : 'windows',
                ...username ? { username } : {},
                ...wake ? { wake } : {},
            })
        })
        field('cancel').addEventListener('click', () => done(null))
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                done(null)
            }
        })
    })
}
