import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** A file the remote offers (IronRDP's FileInfo). */
interface RemoteFile {
    name: string
    path?: string
    size: number
    isDirectory?: boolean
}

export const STYLE = `
.trd-toast { position: absolute; top: 12px; right: 12px; z-index: 2; max-width: min(420px, calc(100% - 24px));
    display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 6px;
    background: rgba(30, 30, 30, 0.92); color: #ddd; font-size: 12px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4); }
.trd-toast-text { flex: auto; white-space: pre-line; }
.trd-toast .btn { flex: none; padding: 2px 8px; font-size: 12px; }
.trd-overlay.trd-drop-target::after { content: 'Drop to copy to the remote desktop, then paste there'; position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center; background: rgba(40, 90, 160, 0.35); color: #fff; font-size: 15px;
    pointer-events: none; }
`

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Files through the clipboard, with IronRDP's RdpFileTransferProvider: files dropped on the desktop (or
 * picked) are offered on the remote clipboard, to paste there; files copied on the remote can be saved to
 * the Mac's Downloads folder. Messages show as a small bar over the desktop.
 */
export class FileTransfer {
    readonly provider: any
    private toastEl: HTMLElement | null = null
    private toastTimer: ReturnType<typeof setTimeout> | undefined
    /** Files the remote offered last (for tests: saveAll). */
    offered: RemoteFile[] = []
    /** Where the last save went (for tests and "Show in Finder"). */
    lastSaved: string[] = []

    constructor (rdp: any, private overlay: HTMLElement, private log: (msg: string) => void) {
        this.provider = new rdp.RdpFileTransferProvider({ storageBackend: 'blob' })
        this.provider.on('files-available', (files: RemoteFile[]) => this.offer(files))
        this.provider.on('error', (e: any) => {
            this.log(`files: ${e?.message ?? JSON.stringify(e)}`)
            this.toast(`File transfer failed: ${e?.message ?? 'unknown error'}`)
        })

        // Drop files on the desktop to send them. Handled here so Tabby doesn't paste their paths into
        // the console under the desktop.
        overlay.addEventListener('dragover', event => {
            if (event.dataTransfer?.types.includes('Files')) {
                event.preventDefault()
                event.stopPropagation()
                overlay.classList.add('trd-drop-target')
            }
        })
        overlay.addEventListener('dragleave', event => {
            if (!overlay.contains(event.relatedTarget as Node)) {
                overlay.classList.remove('trd-drop-target')
            }
        })
        overlay.addEventListener('drop', event => {
            overlay.classList.remove('trd-drop-target')
            if (!event.dataTransfer?.types.includes('Files')) {
                return
            }
            event.preventDefault()
            event.stopPropagation()
            this.provider.handleDrop(event).then((dropped: any[]) => this.send(dropped), (e: any) => this.toast(`Couldn't read the dropped files: ${e?.message ?? e}`))
        }, true)
    }

    /** Mac → remote: offers the files on the remote clipboard; the remote copies them when they're pasted. */
    send (files: any[]): void {
        const count = files.filter(f => !f.isDirectory).length
        if (!count) {
            return
        }
        try {
            const upload = this.provider.uploadFiles(files)
            this.log(`files: offered ${count} to the remote`)
            this.toast(`${plural(count, 'file')} ready: paste on the remote desktop (⌘V) to copy ${count === 1 ? 'it' : 'them'} there`, [], 0)
            upload.completion.then(
                () => { this.log('files: pasted on the remote'); this.toast(`Copied ${plural(count, 'file')} to the remote desktop`) },
                (e: any) => { this.log(`files: upload: ${e?.message ?? e}`); this.toast(`Copying to the remote desktop failed: ${e?.message ?? e}`) },
            )
        } catch (e: any) {
            this.toast(`Couldn't offer the files: ${e?.message ?? e}`)
        }
    }

    /** Picks files on the Mac to send. */
    async pickAndSend (): Promise<void> {
        const files = await this.provider.showFilePicker({ multiple: true })
        this.send(files)
    }

    /** Remote → Mac: the remote copied files; offer saving them. */
    private offer (files: RemoteFile[]): void {
        this.offered = files
        const count = files.filter(f => !f.isDirectory).length
        this.log(`files: the remote copied ${count}`)
        if (count) {
            this.toast(`${plural(count, 'file')} copied on the remote desktop`, [{ label: 'Save to Downloads', run: () => this.saveAll() }], 15000)
        }
    }

    /** Downloads what the remote offered into a folder (default ~/Downloads), keeping their folder structure. */
    async saveAll (dir = path.join(os.homedir(), 'Downloads')): Promise<string[]> {
        const files = this.offered
        const saved: string[] = []
        this.toast(`Saving ${plural(files.filter(f => !f.isDirectory).length, 'file')}…`, [], 0)
        try {
            for (const [index, file] of files.entries()) {
                // Relative paths use `\` (the wire convention); never let one leave the target folder.
                const parts = [...(file.path ?? '').split('\\'), file.name].filter(p => p && p !== '.' && p !== '..')
                if (file.isDirectory) {
                    continue
                }
                const blob: Blob = await this.provider.downloadFile(file, index).completion
                const target = uniquePath(path.join(dir, ...parts))
                await fs.promises.mkdir(path.dirname(target), { recursive: true })
                await fs.promises.writeFile(target, Buffer.from(await blob.arrayBuffer()))
                saved.push(target)
            }
            this.lastSaved = saved
            this.log(`files: saved ${saved.length}`)
            this.toast(`Saved ${plural(saved.length, 'file')} to ${path.basename(dir)}`, saved.length ? [{
                label: 'Show in Finder',
                run: () => require('electron').shell.showItemInFolder(saved[0]),
            }] : [])
        } catch (e: any) {
            this.log(`files: save: ${e?.message ?? e}`)
            this.toast(`Saving failed: ${e?.message ?? e}`)
        }
        return saved
    }

    /** A message over the desktop; hides after `hideAfter` ms (0: stays until replaced). */
    private toast (text: string, actions: { label: string, run: () => void }[] = [], hideAfter = 6000): void {
        clearTimeout(this.toastTimer)
        this.toastEl?.remove()
        const el = document.createElement('div')
        el.className = 'trd-toast'
        const label = document.createElement('div')
        label.className = 'trd-toast-text'
        label.textContent = text
        el.append(label, ...actions.map(action => {
            const button = document.createElement('button')
            button.className = 'btn btn-primary'
            button.textContent = action.label
            button.addEventListener('click', () => action.run())
            return button
        }))
        const close = document.createElement('button')
        close.className = 'btn btn-link'
        close.textContent = '×'
        close.title = 'Dismiss'
        close.addEventListener('click', () => el.remove())
        el.append(close)
        this.overlay.appendChild(el)
        this.toastEl = el
        if (hideAfter) {
            this.toastTimer = setTimeout(() => el.remove(), hideAfter)
        }
    }

    dispose (): void {
        clearTimeout(this.toastTimer)
        this.toastEl?.remove()
        try { this.provider.dispose() } catch { }
    }
}

/** `file.txt`, or `file 2.txt`, `file 3.txt`… if taken. */
function uniquePath (target: string): string {
    if (!fs.existsSync(target)) {
        return target
    }
    const { dir, name, ext } = path.parse(target)
    for (let n = 2; ; n++) {
        const candidate = path.join(dir, `${name} ${n}${ext}`)
        if (!fs.existsSync(candidate)) {
            return candidate
        }
    }
}
