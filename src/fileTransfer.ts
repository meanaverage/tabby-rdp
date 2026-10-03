import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** Limits for a copied folder, as for a dropped one in IronRDP. */
const MAX_ENTRIES = 10000
const MAX_DEPTH = 20

/**
 * Files copied in Finder (Explorer, Files): their paths, from the local clipboard. Empty when it holds no files.
 */
export function clipboardPaths (): string[] {
    const { clipboard } = require('electron')
    const read = (format: string): string => {
        try {
            return clipboard.read(format) ?? ''
        } catch {
            return ''
        }
    }
    if (process.platform === 'darwin') {
        const plist = read('NSFilenamesPboardType')
        const paths = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'))
        if (paths.length) {
            return paths
        }
        const url = read('public.file-url')
        return url.startsWith('file://') ? [decodeURIComponent(new URL(url).pathname)] : []
    }
    if (process.platform === 'win32') {
        try {
            const name = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0+$/, '')
            return name ? [name] : []
        } catch {
            return []
        }
    }
    const list = read('x-special/gnome-copied-files') || read('text/uri-list')
    return list.split(/\r?\n/).filter(l => l.startsWith('file://')).map(l => decodeURIComponent(new URL(l).pathname))
}

/**
 * A file on disk, for IronRDP's upload: it reads `slice(start, end)` of a file as the remote asks for each range, so
 * only that range is read, not the whole file up front.
 */
class DiskFile {
    readonly type = ''
    constructor (private file: string, readonly name: string, readonly size: number, readonly lastModified: number) { }

    slice (start = 0, end = this.size): Blob {
        const length = Math.max(0, Math.min(end, this.size) - start)
        const buffer = Buffer.alloc(length)
        const fd = fs.openSync(this.file, 'r')
        try {
            let done = 0
            while (done < length) {
                const n = fs.readSync(fd, buffer, done, length - done, start + done)
                if (!n) {
                    break
                }
                done += n
            }
            return new Blob([buffer.subarray(0, done)])
        } finally {
            fs.closeSync(fd)
        }
    }
}

/** IronRDP's DroppedFile entries for paths on disk: files, and folders with everything in them (`path`: the folder, `\`-separated). */
function entriesFor (paths: string[]): any[] {
    const entries: any[] = []
    const walk = (file: string, parent: string | undefined, depth: number) => {
        if (entries.length >= MAX_ENTRIES || depth > MAX_DEPTH) {
            return
        }
        const stat = fs.statSync(file, { throwIfNoEntry: false })
        const name = path.basename(file)
        if (stat?.isFile()) {
            entries.push({ file: new DiskFile(file, name, stat.size, stat.mtimeMs), name, size: stat.size, lastModified: stat.mtimeMs, path: parent })
        } else if (stat?.isDirectory()) {
            entries.push({ file: null, name, size: 0, lastModified: 0, path: parent, isDirectory: true })
            const inner = parent !== undefined ? `${parent}\\${name}` : name
            for (const child of fs.readdirSync(file).sort()) {
                walk(path.join(file, child), inner, depth + 1)
            }
        }
    }
    paths.forEach(p => walk(p, undefined, 0))
    return entries
}

/** On a download's result: the temporary file holding it (see DiskStorage). */
const DISK_PATH = Symbol('tabby-rdp download')

/**
 * Where downloads are kept while they arrive (IronRDP's FileStorageBackend): a file each in a private temporary
 * folder, written chunk by chunk, so a large file takes its size on disk rather than twice that in memory. The
 * result handed back is an empty Blob that names the file; saveAll moves it into place.
 */
export class DiskStorage {
    readonly name = 'disk'
    private dir: Promise<string> | null = null
    private count = 0

    async createWriteHandle (_fileName: string, _expectedSize: number): Promise<any> {
        this.dir ??= fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-rdp-'))  // 0700, a name nobody could prepare
        const file = path.join(await this.dir, String(++this.count))
        const handle = await fs.promises.open(file, 'wx', 0o600)
        let bytesWritten = 0
        let open = true
        const close = async () => {
            if (open) {
                open = false
                await handle.close()
            }
        }
        return {
            get bytesWritten () { return bytesWritten },
            async write (chunk: Uint8Array) {
                await handle.appendFile(chunk)
                bytesWritten += chunk.length
            },
            async finalize () {
                await close()
                return Object.assign(new Blob([]), { [DISK_PATH]: file })
            },
            async abort () {
                await close().catch(() => null)
                await fs.promises.rm(file, { force: true })
            },
        }
    }

    async dispose (): Promise<void> {
        const dir = this.dir
        this.dir = null
        if (dir) {
            await dir.then(d => fs.promises.rm(d, { recursive: true, force: true }), () => null)
        }
    }
}

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
    /** The copied files offered for a paste and not pasted yet (see pasteClipboardFiles). */
    private pendingPaste: string | null = null
    /** Resolves when the remote has taken in the files last offered (its Format List Response): true if it accepted them. */
    private offerTaken: Promise<boolean> | null = null
    /**
     * Takes the overlay's drop listeners off again: the overlay outlives this (a reconnect makes a new FileTransfer
     * on it). With removeEventListener, not an AbortSignal: zone.js keeps one native listener per event and its own
     * list of handlers, and a signal removes the native one behind its back, so the next handlers never get attached.
     */
    private readonly stopListening: (() => void)[] = []

    constructor (rdp: any, private overlay: HTMLElement, private log: (msg: string) => void) {
        this.provider = new rdp.RdpFileTransferProvider({ storageBackend: new DiskStorage() })
        this.provider.on('files-available', (files: RemoteFile[]) => this.offer(files))
        this.provider.on('error', (e: any) => {
            this.log(`files: ${e?.message ?? JSON.stringify(e)}`)
            this.toast(`File transfer failed: ${e?.message ?? 'unknown error'}`)
        })

        // Drop files on the desktop to send them. Handled here so Tabby doesn't paste their paths into
        // the console under the desktop.
        const listen = (type: 'dragover' | 'dragleave' | 'drop', handler: (event: DragEvent) => void, capture = false) => {
            overlay.addEventListener(type, handler, capture)
            this.stopListening.push(() => overlay.removeEventListener(type, handler, capture))
        }
        listen('dragover', event => {
            if (event.dataTransfer?.types.includes('Files')) {
                event.preventDefault()
                event.stopPropagation()
                overlay.classList.add('trd-drop-target')
            }
        })
        listen('dragleave', event => {
            if (!overlay.contains(event.relatedTarget as Node)) {
                overlay.classList.remove('trd-drop-target')
            }
        })
        listen('drop', event => {
            overlay.classList.remove('trd-drop-target')
            if (!event.dataTransfer?.types.includes('Files')) {
                return
            }
            event.preventDefault()
            event.stopPropagation()
            this.provider.handleDrop(event).then((dropped: any[]) => this.send(dropped), (e: any) => {
                this.log(`files: drop: ${e?.message ?? e}`)
                this.toast(`Couldn't read the dropped files: ${e?.message ?? e}`)
            })
        }, true)
    }

    /** Mac → remote: offers the files on the remote clipboard; the remote copies them when they're pasted. */
    send (files: any[], pasting = false): Promise<void> | null {
        const count = files.filter(f => !f.isDirectory).length
        if (!count) {
            return null
        }
        try {
            // The remote answers the new clipboard before it can paste it; a paste sent sooner gets what it had.
            this.offerTaken = new Promise<boolean>(resolve => {
                const answered = (ok: boolean) => {
                    this.provider.off('format-list-response', answered)
                    resolve(!!ok)
                }
                this.provider.on('format-list-response', answered)
            })
            const upload = this.provider.uploadFiles(files)
            this.log(`files: offered ${count} to the remote${pasting ? ' (copied here, pasted there)' : ''}`)
            this.toast(pasting ? `Pasting ${plural(count, 'file')}…` : `${plural(count, 'file')} ready: paste on the remote desktop (⌘V) to copy ${count === 1 ? 'it' : 'them'} there`, [], 0)
            return upload.completion.then(
                () => { this.log('files: pasted on the remote'); this.toast(`Copied ${plural(count, 'file')} to the remote desktop`) },
                (e: any) => { this.log(`files: upload: ${e?.message ?? e}`); this.toast(`Copying to the remote desktop failed: ${e?.message ?? e}`) },
            )
        } catch (e: any) {
            this.log(`files: not offered: ${e?.message ?? e}`)
            this.toast(`Couldn't offer the files: ${e?.message ?? e}`)
            return null
        }
    }

    /**
     * Resolves once the remote has taken in the files just offered (true), or said no (false), or after `timeoutMs`
     * without an answer (true: paste anyway), so that a paste sent then gets them.
     */
    offerAnswered (timeoutMs = 3000): Promise<boolean> {
        const taken = this.offerTaken
        return taken ? Promise.race([taken, new Promise<boolean>(resolve => setTimeout(() => resolve(true), timeoutMs))]) : Promise.resolve(true)
    }

    /**
     * Resolves with the remote's next answer to a new clipboard (its Format List Response): true if it took it in,
     * and after `timeoutMs` without one (paste anyway). Call it before sending the clipboard.
     */
    clipboardAnswered (timeoutMs = 3000): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            const answered = (ok: boolean) => {
                clearTimeout(timer)
                this.provider.off('format-list-response', answered)
                resolve(!!ok)
            }
            const timer = setTimeout(() => answered(true), timeoutMs)
            this.provider.on('format-list-response', answered)
        })
    }

    /**
     * ⌘V (Ctrl+V) on the desktop with files copied here (Finder, Explorer, Files): offers them on the remote clipboard
     * for that paste. True when it did, and the paste should wait a moment for the remote to see them; false when the
     * clipboard holds no files, or these are already offered and not pasted yet.
     */
    pasteClipboardFiles (): boolean {
        const paths = clipboardPaths()
        if (!paths.length) {
            return false
        }
        const key = paths.join('\n')
        if (this.pendingPaste === key) {
            return false
        }
        let entries: any[]
        try {
            entries = entriesFor(paths)
        } catch (e: any) {
            this.toast(`Couldn't read the copied files: ${e?.message ?? e}`)
            return false
        }
        const done = this.send(entries, true)
        if (!done) {
            return false
        }
        this.pendingPaste = key
        done.finally(() => { if (this.pendingPaste === key) this.pendingPaste = null })
        return true
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
                if (file.isDirectory) {
                    continue
                }
                const wanted = savePath(dir, file.path, file.name)
                const blob: Blob = await this.provider.downloadFile(file, index).completion
                saved.push(await place(dir, wanted, blob))
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
    toast (text: string, actions: { label: string, run: () => void }[] = [], hideAfter = 6000): void {
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
        this.stopListening.splice(0).forEach(stop => stop())
        this.overlay.classList.remove('trd-drop-target')
        clearTimeout(this.toastTimer)
        this.toastEl?.remove()
        try { this.provider.dispose() } catch { }
    }
}

/**
 * Where a file the remote offered goes under `dir`, keeping its folder structure. The names come from the remote
 * (a server or anything on it can put them on the clipboard), so every component is cut at both separators (`\\` is
 * the wire convention, but a name may hold `/`), `.`, `..` and drive letters are dropped, and the result must stay
 * inside `dir`: a name like `../../Library/LaunchAgents/x.plist` must not land outside Downloads.
 */
export function savePath (dir: string, folder: string | undefined, name: string): string {
    const parts = [folder ?? '', name]
        .flatMap(p => String(p).split(/[\\/]+/))
        .map(p => p.replace(/[\u0000-\u001f]/g, '').replace(/^[A-Za-z]:$/, '').trim())
        .filter(p => p && p !== '.' && p !== '..')
    const root = path.resolve(dir)
    const target = path.resolve(root, ...parts.length ? parts : ['file'])
    if (!target.startsWith(root + path.sep)) {
        throw new Error(`refused a file name that leaves the folder: ${JSON.stringify(name)}`)
    }
    return target
}

/** `file.txt`, or `file 2.txt`, `file 3.txt`… if taken. For names of the plugin's own choosing (screenshots). */
export function uniquePath (target: string): string {
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

/**
 * Makes the folders from `dir` down to `folder` (which savePath put under it), one at a time, and returns the
 * folder's real path. An existing component may be a link only if it stays inside `dir`: folder names come from the
 * remote, and a link in Downloads with a matching name would otherwise take the files wherever it points.
 */
export async function foldersInside (dir: string, folder: string): Promise<string> {
    await fs.promises.mkdir(dir, { recursive: true })
    const root = await fs.promises.realpath(dir)
    let at = root
    for (const part of path.relative(path.resolve(dir), folder).split(path.sep).filter(Boolean)) {
        const next = path.join(at, part)
        await fs.promises.mkdir(next).catch((e: any) => {
            if (e?.code !== 'EEXIST') {
                throw e
            }
        })
        at = await fs.promises.realpath(next)
        if (at !== root && !at.startsWith(root + path.sep)) {
            throw new Error(`refused to save through a link that leaves the folder: ${JSON.stringify(part)}`)
        }
    }
    return at
}

/**
 * Puts a download at `wanted` under `dir` (or `name 2.ext`, `name 3.ext`… when taken) and returns where it went.
 * The file is created there and never replaces or follows what exists: a name can be taken, or made a link,
 * between looking and writing.
 */
export async function place (dir: string, wanted: string, blob: Blob): Promise<string> {
    const folder = await foldersInside(dir, path.dirname(wanted))
    const { name, ext } = path.parse(wanted)
    const temporary: string | undefined = (blob as any)[DISK_PATH]
    for (let n = 1; ; n++) {
        const target = path.join(folder, n === 1 ? `${name}${ext}` : `${name} ${n}${ext}`)
        try {
            if (temporary) {
                await fs.promises.copyFile(temporary, target, fs.constants.COPYFILE_EXCL)
                await fs.promises.rm(temporary, { force: true })
            } else {
                await fs.promises.writeFile(target, Buffer.from(await blob.arrayBuffer()), { flag: 'wx' })
            }
            return target
        } catch (e: any) {
            if (e?.code !== 'EEXIST' || n >= 10000) {
                throw e
            }
        }
    }
}
