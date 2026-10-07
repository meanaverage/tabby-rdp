import type { PackageChangeProgress } from './releases'

const STYLE = `
.trd-package-dialog { width: min(460px, calc(100vw - 40px)); padding: 24px; border-radius: 8px; outline: none;
    border: 1px solid rgba(128,128,128,.35); background: var(--bs-body-bg, #1b1b1b); color: var(--bs-body-color, #ddd);
    box-shadow: 0 16px 60px rgba(0,0,0,.45); }
.trd-package-dialog::backdrop { background: rgba(0,0,0,.55); }
.trd-package-dialog h4 { font-size: 18px; margin: 0 0 16px; }
.trd-package-dialog p { white-space: pre-line; overflow-wrap: anywhere; }
.trd-package-dialog [data-detail] { font-size: 13px; opacity: .8; }
.trd-package-dialog p:empty { display: none; }
.trd-package-dialog progress { display: block; width: 100%; height: 8px; margin: 18px 0 8px; accent-color: #589cf0; }
.trd-package-dialog [hidden] { display: none !important; }
.trd-package-dialog [data-elapsed] { font-size: 12px; opacity: .7; }
.trd-package-dialog [data-phase=error] { color: var(--bs-danger, #f08080); }
.trd-package-dialog [data-phase=success] { color: var(--bs-success, #79c99b); }
.trd-package-dialog .trd-package-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
`

/** One modal remains open from confirmation through the installer's verified result. */
export class PackageChangeDialog {
    private dialog: HTMLDialogElement | null = null
    private confirmation?: (accepted: boolean) => void
    private previousFocus: HTMLElement | null = null
    private timer?: ReturnType<typeof setInterval>
    private started = 0

    update (state: PackageChangeProgress): void {
        if (state.phase === 'cancelled') { this.close(); return }
        this.open()
        this.field<HTMLElement>('[data-title]').textContent = state.action === 'install'
            ? `Install tabby-rdp ${state.version}` : 'Uninstall tabby-rdp'
        const result = this.field<HTMLElement>('[data-result]')
        result.dataset.phase = state.phase
        result.setAttribute('role', state.phase === 'error' ? 'alert' : 'status')
        const complete = state.phase === 'success' || state.phase === 'error'
        this.field<HTMLProgressElement>('progress').hidden = complete
        this.field<HTMLElement>('[data-elapsed]').hidden = complete
        this.field<HTMLButtonElement>('[data-cancel]').hidden = true
        this.field<HTMLButtonElement>('[data-confirm]').hidden = true
        this.field<HTMLButtonElement>('[data-close]').hidden = !complete
        this.field<HTMLElement>('[data-detail]').textContent = ''
        let message = state.message ?? ''
        if (state.phase === 'preparing') { message = state.action === 'install' ? 'Checking compatibility…' : 'Checking installation…' }
        if (state.phase === 'installing') { message = `Installing tabby-rdp ${state.version}…` }
        if (state.phase === 'uninstalling') { message = 'Uninstalling tabby-rdp…' }
        if (state.phase === 'verifying') { message = state.action === 'install' ? 'Verifying installation…' : 'Verifying removal…' }
        if (state.phase === 'success') {
            this.field<HTMLElement>('[data-title]').textContent = state.action === 'install' ? 'Installation complete' : 'Uninstall complete'
            if (!state.message) {
                message = state.action === 'install' ? `tabby-rdp ${state.version} is installed.` : 'tabby-rdp is uninstalled.'
                this.field<HTMLElement>('[data-detail]').textContent = 'Close remote desktops, then restart Tabby.'
            }
        }
        if (state.phase === 'error') {
            this.field<HTMLElement>('[data-title]').textContent = state.action === 'install' ? 'Installation failed' : 'Uninstall failed'
        }
        this.field<HTMLElement>('[data-message]').textContent = message
        if (complete) {
            this.stopTimer()
            this.field<HTMLButtonElement>('[data-close]').focus()
        } else {
            this.dialog!.focus()
        }
    }

    confirm (message: string, detail: string, action: string): Promise<boolean> {
        this.open()
        this.stopTimer()
        this.field<HTMLElement>('[data-title]').textContent = message
        this.field<HTMLElement>('[data-message]').textContent = detail
        this.field<HTMLElement>('[data-detail]').textContent = ''
        this.field<HTMLProgressElement>('progress').hidden = true
        this.field<HTMLElement>('[data-elapsed]').hidden = true
        this.field<HTMLButtonElement>('[data-close]').hidden = true
        const cancel = this.field<HTMLButtonElement>('[data-cancel]')
        const accept = this.field<HTMLButtonElement>('[data-confirm]')
        cancel.hidden = false
        accept.hidden = false
        accept.textContent = action
        this.field<HTMLElement>('[data-result]').dataset.phase = 'confirming'
        cancel.focus()
        return new Promise(resolve => { this.confirmation = resolve })
    }

    private field<T extends HTMLElement> (selector: string): T { return this.dialog!.querySelector<T>(selector)! }

    private open (): void {
        if (this.dialog) {
            if (!this.dialog.open) { this.dialog.showModal() }
            if (!this.timer) { this.startTimer() }
            return
        }
        if (!document.getElementById('trd-package-dialog-style')) {
            const style = document.createElement('style')
            style.id = 'trd-package-dialog-style'
            style.textContent = STYLE
            document.head.appendChild(style)
        }
        this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const dialog = document.createElement('dialog')
        this.dialog = dialog
        dialog.className = 'trd-package-dialog'
        dialog.setAttribute('aria-labelledby', 'trd-package-dialog-title')
        dialog.setAttribute('tabindex', '-1')
        dialog.setAttribute('closedby', 'none')
        dialog.innerHTML = `<h4 id="trd-package-dialog-title" data-title></h4>
            <div data-result role="status" aria-live="polite"><p data-message></p><p data-detail></p></div>
            <progress aria-label="Package change progress"></progress><div data-elapsed></div>
            <div class="trd-package-actions"><button class="btn btn-secondary" data-cancel hidden>Cancel</button>
                <button class="btn btn-primary" data-confirm hidden></button><button class="btn btn-primary" data-close hidden>Close</button></div>`
        this.field<HTMLButtonElement>('[data-confirm]').addEventListener('click', () => this.decide(true))
        this.field<HTMLButtonElement>('[data-cancel]').addEventListener('click', () => this.decide(false))
        this.field<HTMLButtonElement>('[data-close]').addEventListener('click', () => this.close())
        dialog.addEventListener('cancel', event => {
            event.preventDefault()
            this.dismiss()
        })
        // Keep package-dialog keystrokes out of Tabby's terminal and shortcut handlers.
        dialog.addEventListener('keydown', event => {
            event.stopPropagation()
            if (event.key === 'Escape') {
                event.preventDefault()
                this.dismiss()
            }
        })
        dialog.addEventListener('keyup', event => event.stopPropagation())
        document.body.appendChild(dialog)
        dialog.showModal()
        this.startTimer()
    }

    private decide (accepted: boolean): void {
        const resolve = this.confirmation
        if (!resolve) { return }
        this.confirmation = undefined
        this.field<HTMLButtonElement>('[data-confirm]').hidden = true
        this.field<HTMLButtonElement>('[data-cancel]').hidden = true
        resolve(accepted)
        if (!accepted) { this.close() }
    }

    private dismiss (): void {
        if (this.confirmation) { this.decide(false) }
        else if (!this.field<HTMLButtonElement>('[data-close]').hidden) { this.close() }
    }

    private startTimer (): void {
        this.started = Date.now()
        const tick = () => {
            const seconds = Math.floor((Date.now() - this.started) / 1000)
            this.field<HTMLElement>('[data-elapsed]').textContent = `Elapsed ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        }
        tick()
        this.timer = setInterval(tick, 1000)
    }
    private stopTimer (): void { clearInterval(this.timer); this.timer = undefined }
    private close (): void {
        this.stopTimer()
        this.dialog?.close()
        this.dialog?.remove()
        this.dialog = null
        if (this.previousFocus?.isConnected) { this.previousFocus.focus() }
        this.previousFocus = null
    }
}
