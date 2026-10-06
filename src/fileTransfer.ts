import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { ClipboardWays } from './clipboard'
import type { ServerFlow } from './rdcleanpath'
import { DISK_PATH, DiskStorage } from './diskStorage'
export { DiskStorage } from './diskStorage'

/**
 * Limits for a folder copied here and pasted with ⌘V: entries offered, and how deep. (IronRDP walks dropped folders
 * itself, with limits of its own.)
 */
export const MAX_ENTRIES = 10000
const MAX_DEPTH = 20

/**
 * What the walk of copied folders may look at to find those entries, whatever becomes of it (offered, links left out,
 * pipes): names read and folders opened, and links resolved, which cost more each. The walk is synchronous, in Tabby's
 * window (⌘V must know at once whether files are offered for it), so a folder of a million names, or of links that
 * lead out of it, mustn't hold the window up for long. Past either limit, nothing more is looked at.
 */
export const MAX_LOOKED_AT = 2 * MAX_ENTRIES
export const MAX_LINKS = 2000

/**
 * The most of a file sent for one request of the remote's. It asks for a range at a time, as much as a read on its
 * side wants, but may ask for up to 4 GB at once, and each range is held whole in memory to be sent. A request for
 * more of a file than this gets an error, not less than it asked for: a remote can take a short answer for the end of
 * the file, and keep the file cut short without a word. xrdp and GNOME Remote Desktop read pasted files through FUSE,
 * which takes a short answer for the end of the file, and reads up to 256 pages at once: 1 MB with 4 KB pages, 16 MB
 * where a page is 64 KB (some ARM Linux).
 */
export const MAX_RANGE = 16 * 1024 * 1024

/**
 * File contents a desktop's remote may have asked for and not been sent yet: more requests wait their turn (at most
 * MAX_WAITING of them; more get an error). Each answer is read whole into memory, and the remote may ask for any
 * number at once: 128 requests for 16 MB each held 2 GB. A remote reading a pasted file asks for a part, or a few, at a
 * time. An answer counts until it is handed to the connection, and takes room there from before it is read until the
 * proxy has read it (see ServerFlow): no part is read for the remote while there is none.
 */
export const MAX_IN_FLIGHT = 4 * MAX_RANGE
export const MAX_WAITING = 256

/**
 * What a request counts as towards MAX_IN_FLIGHT, however little it asks for: each one opens the file and reads it,
 * and requests for nothing at all mustn't pile up in any number.
 */
export const MIN_COST = 64 * 1024

/**
 * How long a request the provider has may stay unanswered before it no longer counts towards MAX_IN_FLIGHT: a read
 * that takes a minute is answered with an error, and one that is dropped (the remote's clipboard changed, say) may not
 * be answered at all. What it answers for such a request later is for no request (see FileTransfer's constructor). A
 * pasted file's part still being read here counts until it has been read (see FileTransfer.fetch).
 */
const READ_EXPIRES = 65 * 1000

/** A request of the remote's for what is on its clipboard from here (MS-RDPECLIP's File Contents Request). */
interface ContentsRequest {
    streamId: number
    index: number
    flags: number
    position: number
    size: number
}

/**
 * A request for part of a file being read for the remote, and not answered yet (see FileTransfer.reading): `streamId`:
 * the remote's number for it; `bytes`: what it counts as towards MAX_IN_FLIGHT, and the room it took (see ServerFlow);
 * `since`: when the provider took it (null while a pasted file's part is still being read for it, see fetch); `number`:
 * what it is handed to the provider as (see Served), once it is.
 */
interface Reading {
    streamId: number
    bytes: number
    since: number | null
    number: number | null
}

/**
 * A request of the remote's handed to the provider, as far as its answer is concerned (see FileTransfer.served): the
 * remote's number for it, which the answer goes to the connection under, and what counts it as being read, if it is a
 * request for part of a file.
 */
interface Served {
    streamId: number
    reading: Reading | null
}

/** FILECONTENTS_SIZE and FILECONTENTS_RANGE: a file's size, or part of what is in it. */
const SIZE = 1
const RANGE = 2

/**
 * How much of a file (`size` bytes) a request for `start` to `end` gets: what there is of it, as long as that isn't
 * more than MAX_RANGE; else the request is refused (see there).
 */
function rangeOf (name: string, size: number, start: number, end: number): number {
    const length = Math.max(0, Math.min(end, size) - start)
    if (length > MAX_RANGE) {
        throw new RangeError(`the remote desktop asked for ${Math.ceil(length / 1024 / 1024)} MB of ${name} at once, more than the ${MAX_RANGE / 1024 / 1024} MB a request gets`)
    }
    return length
}

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
 * How a pasted file is opened to read a part of it. It is the file that was offered, not whatever has its name now:
 * the remote can ask again much later, and a link put in its place meanwhile isn't followed, nor a pipe waited on
 * (opened to read, a pipe waits for a writer).
 */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)

/**
 * A file on disk, for IronRDP's upload: it reads `slice(start, end)` of a file as the remote asks for each range, so
 * only that range is read, not the whole file up front (and no more than MAX_RANGE of it at a time). FileTransfer
 * reads each range ahead, on Node's thread pool (read), and hands it over as the provider slices (serving).
 */
class DiskFile {
    readonly type = ''
    readonly size: number
    readonly lastModified: number
    private readonly dev: number
    private readonly ino: number
    /** The part read ahead for the request being answered (see serving). */
    private ready: { start: number, end: number, data: Buffer<ArrayBuffer> } | null = null

    constructor (private file: string, stat: fs.Stats, readonly name: string) {
        this.size = stat.size
        this.lastModified = stat.mtimeMs
        this.dev = stat.dev
        this.ino = stat.ino
    }

    /**
     * Throws unless the file opened (`now`: its stat) is the one offered: a file still (a file removed leaves its inode
     * number free, and a pipe made in its place can get it), on the same device, with the same inode.
     */
    private check (now: fs.Stats): void {
        if (!now.isFile() || now.dev !== this.dev || now.ino !== this.ino) {
            throw new Error(`${this.name} was replaced after it was offered`)
        }
    }

    /**
     * The file ended before the part asked for, which its size when it was offered says is there. The remote gets an
     * error, not a short answer, which it could take for the end of the file and keep the file cut short.
     */
    private shorter (): never {
        throw new Error(`${this.name} is shorter than when it was offered`)
    }

    /**
     * Reads what `slice(start, end)` gives, with the same checks, on Node's thread pool: a slow disk or network folder
     * holds up the transfer, not Tabby's window.
     */
    async read (start: number, end: number): Promise<Buffer<ArrayBuffer>> {
        const length = rangeOf(this.name, this.size, start, end)
        const file = await fs.promises.open(this.file, READ_FLAGS)
        try {
            this.check(await file.stat())
            const buffer = Buffer.allocUnsafe(length)
            let done = 0
            while (done < length) {
                const { bytesRead } = await file.read(buffer, done, length - done, start + done)
                if (!bytesRead) {
                    this.shorter()
                }
                done += bytesRead
            }
            return buffer
        } finally {
            await file.close().catch(() => null)
        }
    }

    /** While `fn` runs, `slice(start, end)` is `data`, read for it (IronRDP's provider slices as it answers). */
    serving<T> (start: number, end: number, data: Buffer<ArrayBuffer>, fn: () => T): T {
        this.ready = { start, end, data }
        try {
            return fn()
        } finally {
            this.ready = null
        }
    }

    slice (start = 0, end = this.size): Blob {
        const ready = this.ready
        if (ready && ready.start === start && ready.end === end) {
            this.ready = null
            return new Blob([ready.data])
        }
        // Not read ahead (the provider only slices as FileTransfer has it answer): read now, in the window.
        const length = rangeOf(this.name, this.size, start, end)
        const buffer = Buffer.allocUnsafe(length)
        const fd = fs.openSync(this.file, READ_FLAGS)
        try {
            this.check(fs.fstatSync(fd))
            let done = 0
            while (done < length) {
                const n = fs.readSync(fd, buffer, done, length - done, start + done)
                if (!n) {
                    this.shorter()
                }
                done += n
            }
            return new Blob([buffer])
        } finally {
            fs.closeSync(fd)
        }
    }
}

/**
 * A file dropped on the desktop or picked from the menu (the browser's own File), as IronRDP's upload reads it: a
 * part at a time as the remote asks, and no more than MAX_RANGE per request, as for files pasted (DiskFile). The
 * browser reads it, outside Tabby's window, but the part is held in memory all the same.
 */
class BoundedFile {
    constructor (private file: Blob, readonly name: string, readonly lastModified: number) { }

    get size (): number {
        return this.file.size
    }

    get type (): string {
        return this.file.type
    }

    slice (start = 0, end = this.size): Blob {
        rangeOf(this.name, this.size, start, end)
        return this.file.slice(start, end)
    }
}

/**
 * IronRDP's DroppedFile entries for files to send: the browser's files as entries, as its provider would make them
 * of a picked list, each read no more than MAX_RANGE at a time (BoundedFile; files pasted are DiskFiles already).
 */
function bounded (files: any[]): any[] {
    return files.map(f => {
        const entry = f && 'file' in f ? f : { file: f, name: f.name, size: f.size, lastModified: f.lastModified }
        return entry.file && !(entry.file instanceof DiskFile) ? { ...entry, file: new BoundedFile(entry.file, entry.name, entry.lastModified) } : entry
    })
}

/**
 * A path's real path, links all resolved, for the walk of copied folders. The system's own resolves a link that leads
 * through others (up to the 32 or 40 a system follows) several times quicker than Node's, which counts where a copied
 * folder is full of such links. Not on Windows, where it can name a folder otherwise than Node's (a mapped drive by its
 * share); the walk's paths must all be named one way.
 */
function realpath (file: string): string {
    return process.platform === 'win32' ? fs.realpathSync(file) : fs.realpathSync.native(file)
}

/** Where a link leads, links all resolved; null if nowhere (it dangles, or goes round). */
function resolved (file: string): string | null {
    try {
        return realpath(file)
    } catch {
        return null
    }
}

/** The same file or folder, by device and inode (not by name, which another can take). */
const same = (a: fs.Stats | undefined, b: fs.Stats) => !!a && a.dev === b.dev && a.ino === b.ino

/**
 * Up to `most` names in a folder, in order, and whether it has more. Read a few at a time, so a folder of a million
 * names isn't read whole for the first few.
 */
function namesIn (folder: string, most: number): { names: string[], more: boolean } {
    const dir = fs.opendirSync(folder)
    try {
        const names: string[] = []
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
            if (names.length >= most) {
                return { names: names.sort(), more: true }
            }
            names.push(entry.name)
        }
        return { names: names.sort(), more: false }
    } finally {
        dir.closeSync()
    }
}

/**
 * IronRDP's DroppedFile entries for paths on disk: files, and folders with everything in them (`path`: the folder,
 * `\`-separated). The paths copied are taken as they are, links followed. Inside a copied folder, a link is followed
 * only when it leads somewhere in that folder (and not to a folder it is in, which would go round and round), as a
 * shared folder's links are (drives.ts): a folder from an archive or a repository can hold a link to anywhere
 * (`attachments -> ../../.ssh`), and copying the folder isn't sending what that leads to. `leftOut` counts such links;
 * those that lead nowhere (they dangle, or go round), and pipes and the like, have nothing to send and aren't counted.
 *
 * The walk stops at its limits (MAX_ENTRIES and MAX_DEPTH, MAX_LOOKED_AT and MAX_LINKS), looking at nothing more,
 * and `cut` says something was left out for it. Each folder is checked to still be the one found once its names are
 * read: one put in its place meanwhile (a link to elsewhere, say) would have had its names read, and the files they
 * are found to be would be sent; the walk then stops with an error. Paths are still taken by name, though (Node can't
 * read a folder through what it opened), so a program on this computer swapping folders while the walk runs, at the
 * right moments, can get past that; it could read such files itself.
 */
export function entriesFor (paths: string[]): { entries: any[], leftOut: number, cut: boolean } {
    const entries: any[] = []
    let leftOut = 0
    let cut = false
    // What the walk has looked at: names read, and folders opened (see MAX_LOOKED_AT); links resolved (MAX_LINKS).
    let looked = 0
    let links = 0
    const full = () => entries.length >= MAX_ENTRIES || looked >= MAX_LOOKED_AT
    // A folder and what is in it. `real`: where it is, links resolved; `stat`: what was found there; `root`: the
    // copied folder's real path; `above`: the real paths of the folders it is in, from that one down.
    const folder = (name: string, real: string, stat: fs.Stats, root: string, above: string[], parent: string | undefined, depth: number) => {
        // Past the limits, a folder is neither opened nor offered: what is in it would be past them too.
        if (full()) {
            cut = true
            return
        }
        entries.push({ file: null, name, size: 0, lastModified: 0, path: parent, isDirectory: true })
        looked++
        if (depth >= MAX_DEPTH) {
            // What is in it would be deeper than the limit.
            cut ||= namesIn(real, 0).more
            return
        }
        const inner = parent !== undefined ? `${parent}\\${name}` : name
        const outer = [...above, real]
        const { names, more } = namesIn(real, MAX_LOOKED_AT - looked)
        looked += names.length
        cut ||= more
        // What each name is, as long as entries could still be offered for it.
        const found: { name: string, real: string, stat: fs.Stats }[] = []
        for (const child of names) {
            if (entries.length + found.length >= MAX_ENTRIES) {
                cut = true
                break
            }
            let at = path.join(real, child)
            let what = fs.lstatSync(at, { throwIfNoEntry: false })
            if (what?.isSymbolicLink()) {
                if (links >= MAX_LINKS) {
                    cut = true
                    continue
                }
                links++
                const target = resolved(at)
                if (!target) {
                    continue
                }
                if (target !== root && !target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
                    leftOut++
                    continue
                }
                if (outer.includes(target)) {
                    continue
                }
                // Its links all resolved: a link there now was put there since, and isn't followed.
                at = target
                what = fs.lstatSync(at, { throwIfNoEntry: false })
            }
            if (what && (what.isFile() || what.isDirectory())) {
                found.push({ name: child, real: at, stat: what })
            }
        }
        if (!same(fs.lstatSync(real, { throwIfNoEntry: false }), stat)) {
            throw new Error(`${inner} changed while it was being read`)
        }
        for (const child of found) {
            if (entries.length >= MAX_ENTRIES) {
                cut = true
                break
            }
            if (child.stat.isFile()) {
                entries.push({ file: new DiskFile(child.real, child.stat, child.name), name: child.name, size: child.stat.size, lastModified: child.stat.mtimeMs, path: inner })
            } else {
                folder(child.name, child.real, child.stat, root, outer, inner, depth + 1)
            }
        }
    }
    for (const p of paths) {
        if (full()) {
            cut = true
            break
        }
        looked++
        let real: string
        try {
            real = realpath(p)
        } catch (e: any) {
            // Gone since it was copied, or a link that leads nowhere: nothing to send, as for a link in a folder.
            if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR' || e?.code === 'ELOOP') {
                continue
            }
            throw e
        }
        const stat = fs.lstatSync(real, { throwIfNoEntry: false })
        if (stat?.isFile()) {
            const name = path.basename(p)
            entries.push({ file: new DiskFile(real, stat, name), name, size: stat.size, lastModified: stat.mtimeMs, path: undefined })
        } else if (stat?.isDirectory()) {
            folder(path.basename(p), real, stat, real, [], undefined, 0)
        }
    }
    return { entries, leftOut, cut }
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
.trd-overlay.trd-drop-target.trd-drop-refused::after { content: "Files don't go to this desktop: its clipboard setting keeps them here";
    background: rgba(90, 90, 90, 0.45); }
`

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** What a paste of copied folders left out (see entriesFor), for its messages: links, and whether limits cut it. */
function leftOutNote (leftOut: number, cut: boolean): string {
    return (leftOut ? `\nLeft out: ${plural(leftOut, 'link')} to outside the copied folder` : '')
        + (cut ? `\nLeft out: what is past a paste's limits (${MAX_ENTRIES.toLocaleString('en')} files and folders, ${MAX_DEPTH} folders deep)` : '')
}

/**
 * Files through the clipboard, with IronRDP's RdpFileTransferProvider: files dropped on the desktop (or
 * picked) are offered on the remote clipboard, to paste there; files copied on the remote can be saved to
 * the Mac's Downloads folder. Each goes only the ways the clipboard goes with this desktop (see clipboard.ts),
 * asked each time, since the settings can narrow them while connected. Messages show as a small bar over the desktop.
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
     * Whether the last ⌘V was taken with nothing offered for it (see pasteClipboardFiles), the remote not even asked:
     * offerAnswered's false then isn't the remote's.
     */
    nothingOffered = false
    /** Whether the remote was refused files offered before the clipboard narrowed (said once: it asks for each part). */
    private refused = false
    /** The provider's own handling of the remote's requests for what is offered (see request). */
    private readonly serve: (request: ContentsRequest) => void
    /** The entries last offered (see send), which the remote's requests name by index. */
    private sent: any[] = []
    /** Requests for parts of files being read for the remote and not answered yet (see MAX_IN_FLIGHT). */
    private reading: Reading[] = []
    /**
     * The requests handed to the provider and not answered, by the number each is handed over as: one of the plugin's
     * own, not the remote's number for its stream. The provider answers under the number it was given, and only an
     * answer for a request in here goes to the remote (under its own number) and lets the room that request took go
     * (see the constructor), so an answer is never taken for another request's, whatever the remote numbers its
     * streams.
     */
    private readonly served = new Map<number, Served>()
    /** The number the last request was handed to the provider as (see served). */
    private numbered = 0
    /** Where an answer goes to the connection, under the remote's number for its request (see the constructor). */
    private submit?: (streamId: number, isError: boolean, data: Uint8Array) => void
    /** Requests for parts of files waiting for those (see MAX_WAITING). */
    private waiting: ContentsRequest[] = []
    /** Parts of the pasted files last offered being read, one at a time for those files (see fetch). */
    private disk: Promise<unknown> = Promise.resolve()
    /** Whether a request of the remote's for the files last offered went unanswered (said once: see unreadable). */
    private unanswered = false
    /** The connection ended (see dispose): parts still being read aren't answered. */
    private disposed = false
    /**
     * Takes the overlay's drop listeners off again: the overlay outlives this (a reconnect makes a new FileTransfer
     * on it). With removeEventListener, not an AbortSignal: zone.js keeps one native listener per event and its own
     * list of handlers, and a signal removes the native one behind its back, so the next handlers never get attached.
     */
    private readonly stopListening: (() => void)[] = []

    /** Whether next() waits for room in the connection (see ServerFlow). */
    private roomAwaited = false

    /**
     * `ways`: the ways the clipboard goes with this desktop right now (see RemoteDesktopService.clipboardWaysOf).
     * `flow`: the room in the connection for what is read for the remote (the desktop's proxy, see ServerFlow).
     */
    constructor (rdp: any, private overlay: HTMLElement, private log: (msg: string) => void, private ways: () => ClipboardWays, private flow?: ServerFlow) {
        this.provider = new rdp.RdpFileTransferProvider({ storageBackend: new DiskStorage() })
        // The remote can ask again, later, for files offered from here: their contents go only while this computer's
        // clipboard goes there. The provider's extensions call the method on it, so this one takes its place.
        this.serve = this.provider.handleFileContentsRequest.bind(this.provider)
        this.provider.handleFileContentsRequest = (request: ContentsRequest) => this.ways().toRemote ? this.request(request) : this.refuse(request)
        // The provider answers each request under the number it was handed it as (see read), and this goes with it to
        // the connection under the remote's own number, and lets the room that request took go, which lets the requests
        // waiting be read (see release). What it hands the connection takes room there as it goes (see ServerFlow). An
        // answer for a request that is no more (gone with the files offered, expired, or the connection ended) is
        // dropped: it goes to no one and releases nothing, so that it can't be taken for another request's, on the same
        // stream or not. The plugin's own answers, errors for requests it
        // doesn't hand over (see fail), go to the connection directly, and release what they are for themselves.
        this.submit = this.provider.sendSubmitFileContents?.bind(this.provider)
        if (this.submit) {
            this.provider.sendSubmitFileContents = (number: number, isError: boolean, data: Uint8Array) => {
                const served = this.served.get(number)
                if (!served) {
                    if (!this.disposed && !this.stray) {
                        this.stray = true
                        this.log('files: an answer for a request of the remote\'s that is no more was dropped')
                    }
                    return
                }
                this.served.delete(number)
                this.submit!(served.streamId, isError, data)
                if (!isError && data?.length) {
                    this.flow?.spend(data.length)
                }
                if (served.reading) {
                    this.release(served.reading)
                }
            }
        }
        this.provider.on('files-available', (files: RemoteFile[]) => this.offer(files))
        this.provider.on('error', (e: any) => {
            this.log(`files: ${e?.message ?? JSON.stringify(e)}`)
            this.toast(`File transfer failed: ${e?.message ?? 'unknown error'}`)
        })

        // Drop files on the desktop to send them. Handled here so Tabby doesn't paste their paths into
        // the console under the desktop, also where they don't go to the desktop (the layer says so).
        const listen = (type: 'dragover' | 'dragleave' | 'drop', handler: (event: DragEvent) => void, capture = false) => {
            overlay.addEventListener(type, handler, capture)
            this.stopListening.push(() => overlay.removeEventListener(type, handler, capture))
        }
        listen('dragover', event => {
            if (event.dataTransfer?.types.includes('Files')) {
                event.preventDefault()
                event.stopPropagation()
                overlay.classList.add('trd-drop-target')
                overlay.classList.toggle('trd-drop-refused', !this.ways().toRemote)
            }
        })
        listen('dragleave', event => {
            if (!overlay.contains(event.relatedTarget as Node)) {
                overlay.classList.remove('trd-drop-target', 'trd-drop-refused')
            }
        })
        listen('drop', event => {
            overlay.classList.remove('trd-drop-target', 'trd-drop-refused')
            if (!event.dataTransfer?.types.includes('Files')) {
                return
            }
            event.preventDefault()
            event.stopPropagation()
            if (!this.mayGoThere()) {
                return
            }
            this.provider.handleDrop(event).then((dropped: any[]) => this.send(dropped), (e: any) => {
                this.log(`files: drop: ${e?.message ?? e}`)
                this.toast(`Couldn't read the dropped files: ${e?.message ?? e}`)
            })
        }, true)
    }

    /**
     * Whether files may go to the remote now, that is, whether this computer's clipboard does; when not, says so over
     * the desktop.
     */
    private mayGoThere (): boolean {
        const ways = this.ways()
        if (!ways.toRemote) {
            this.log('files: not sent: this computer\'s clipboard doesn\'t go to the remote')
            this.toast(ways.fromRemote
                ? 'Not sent: the clipboard only goes from this desktop to this computer.'
                : 'Not sent: clipboard sharing with this desktop is off.')
        }
        return ways.toRemote
    }

    /**
     * This computer's clipboard stopped going to the remote while connected: the files offered there are taken back.
     * A paste still pulling them fails at once, the remote's requests still waiting their turn (see request) get an
     * error at once, rather than once the parts being read are done, and those the provider keeps for pasting again are
     * dropped; asked for anyway, they get an error (see refuse). Their names and sizes stay on the remote's clipboard
     * until it reconnects.
     */
    revoke (): void {
        this.pendingPaste = null
        this.waiting.splice(0).forEach(request => this.refuse(request))
        try {
            if (this.provider.isUploadInProgress?.()) {
                this.provider.failPendingUpload?.('this computer\'s clipboard doesn\'t go to this desktop any more')
            }
            this.provider.retainedFiles = undefined
        } catch (e: any) {
            this.log(`files: offered files not taken back: ${e?.message ?? e}`)
        }
    }

    /**
     * The remote asked for files offered before the clipboard narrowed: it gets an error instead of their contents.
     * `reading`: the request is one being read, which the error answers (see fail).
     */
    private refuse (request: { streamId: number }, reading?: Reading): void {
        if (!this.refused) {
            this.refused = true
            this.mayGoThere()
        }
        this.fail(request.streamId, reading)
    }

    /**
     * A request of the remote's for what is offered on its clipboard from here, where this computer's clipboard goes:
     * a file's size is answered at once, part of a file in turn, once what is being read for the remote leaves room
     * for it (MAX_IN_FLIGHT). One on a stream that has a request being read or waiting already gets an error: the
     * remote chooses the streams' numbers, and its answers go back under them, so it couldn't tell which of its two
     * requests on a stream an answer is for. Clients ask one thing at a time on a stream (FreeRDP's and GNOME Remote
     * Desktop's, xrdp's). (An answer is matched to the request it was made for by a number of the plugin's own,
     * whatever the remote numbers its streams: see the constructor.)
     */
    private request (request: ContentsRequest): void {
        // The remote is pulling the files: the provider is told so first, as its own handler does, whether this
        // request is answered at once, waits its turn or is refused. Its watchdogs fail a paste once the remote has
        // asked it for nothing for a minute, and a request waiting its turn here (see next) hasn't reached it.
        this.provider.acknowledgePaste?.()
        // A read the provider dropped long ago no longer holds its stream (see READ_EXPIRES).
        this.expire()
        if (this.reading.some(r => r.streamId === request.streamId) || this.waiting.some(r => r.streamId === request.streamId)) {
            this.fail(request.streamId)
            if (!this.overlapping) {
                this.overlapping = true
                this.log(`files: a request of the remote's was refused: another one on its stream (${request.streamId}) wasn't answered yet`)
            }
            return
        }
        if ((request.flags & SIZE) || !(request.flags & RANGE)) {
            this.read(request)
        } else if (this.waiting.length >= MAX_WAITING) {
            this.unreadable(request, `the remote desktop asked for more than ${MAX_WAITING} parts of files at once`)
        } else {
            this.waiting.push(request)
            this.next()
        }
    }

    /**
     * Reads the requests waiting, oldest first, for as long as what is being read leaves room for them, and the
     * connection has room for what they are read for (see ServerFlow). A part answered is handed to the connection,
     * where it stays, in the window's memory, until the proxy has read it, as the server takes what is sent: one that
     * asks and reads slowly, or not at all, would otherwise have every part it asks for kept there. Each takes room
     * for as much as it may be from the moment it starts to be read until it is answered, and what the answer hands
     * the connection takes room of its own (see the constructor). The requests wait meanwhile, MAX_WAITING at most,
     * and are read once there is room. (The room holds back what is kept there as far as ServerFlow says: the proxy
     * reading the connection's other messages makes room too.)
     */
    private next (): void {
        this.expire()
        while (this.waiting.length) {
            if (this.flow && !this.flow.room()) {
                if (!this.roomAwaited) {
                    this.roomAwaited = true
                    this.flow.whenRoom().then(() => {
                        this.roomAwaited = false
                        if (!this.disposed) {
                            this.next()
                        }
                    })
                }
                return
            }
            const bytes = Math.min(Math.max(this.waiting[0].size, MIN_COST), MAX_RANGE)
            if (this.reading.length && this.reading.reduce((sum, r) => sum + r.bytes, 0) + bytes > MAX_IN_FLIGHT) {
                return
            }
            const request = this.waiting.shift()!
            if (!this.ways().toRemote) {
                this.refuse(request)
                continue
            }
            this.flow?.spend(bytes)
            const reading: Reading = { streamId: request.streamId, bytes, since: null, number: null }
            this.reading.push(reading)
            this.fetch(request, reading)
        }
    }

    /**
     * Has the provider answer a request for part of a file (`reading`: what counts it towards MAX_IN_FLIGHT). IronRDP
     * takes the part as a Blob there and then, so a pasted file's part is read first (DiskFile.read), on Node's thread
     * pool and one at a time for the files offered, and handed over as the provider slices the file: a slow disk or
     * network folder holds up the transfer, not Tabby's window. The browser reads files dropped or picked by itself.
     */
    private fetch (request: ContentsRequest, reading: Reading): void {
        const file = this.sent[request.index]?.file
        if (!(file instanceof DiskFile)) {
            reading.since = Date.now()
            this.read(request, reading)
            return
        }
        const sent = this.sent
        const start = request.position
        const end = request.position + request.size
        const part = this.disk.then(() => file.read(start, end))
        this.disk = part.catch(() => null)
        const settled = (answer: () => void) => {
            reading.since = Date.now()
            if (this.disposed) {
                return
            }
            if (sent !== this.sent) {
                // For the files another offer has replaced since, as those still waiting were (see send): the remote
                // gets an error, and the room the read took goes back now that it is over, not before.
                this.fail(request.streamId, reading)
            } else {
                answer()
            }
        }
        part.then(
            data => settled(() => this.ways().toRemote ? file.serving(start, end, data, () => this.read(request, reading)) : this.refuse(request, reading)),
            (e: any) => settled(() => this.unreadable(request, e?.message ?? String(e), reading)),
        )
    }

    /**
     * An error for the remote's request on `streamId`, from the plugin itself rather than the provider: it goes to the
     * connection at once, under the remote's number, and for a request being read (`reading`) the room it took goes
     * back (see release). For a request that was never read (see request), or isn't any more (see send), there is
     * nothing to give back.
     */
    private fail (streamId: number, reading?: Reading): void {
        this.submit?.(streamId, true, new Uint8Array())
        if (reading) {
            this.release(reading)
        }
    }

    /** Whether a request on a stream with one under way already was refused (logged once: see request). */
    private overlapping = false

    /** Whether an answer for a request that is no more was dropped (logged once: see the constructor). */
    private stray = false

    /**
     * Drops what is being read for requests the provider took longer ago than READ_EXPIRES (see there), and gives
     * back the room they took: nothing was handed to the connection for them. What the provider answers for them later
     * is for no request any more (see the constructor).
     */
    private expire (): void {
        const now = Date.now()
        this.reading = this.reading.filter(r => {
            const live = r.since === null || now - r.since < READ_EXPIRES
            if (!live) {
                this.flow?.refund(r.bytes)
                if (r.number !== null) {
                    this.served.delete(r.number)
                }
            }
            return live
        })
    }

    /**
     * Gives back the room taken for the parts being read that `which` picks (all of them by default; see ServerFlow):
     * none of them will be handed over.
     */
    private dropReading (which: (reading: Reading) => boolean = () => true): void {
        this.reading = this.reading.filter(r => {
            if (!which(r)) {
                return true
            }
            this.flow?.refund(r.bytes)
            return false
        })
    }

    /**
     * What was being read for a request has gone to the remote (or an error has): room for the next, and the room it
     * took while it was read given back (what was handed takes its own, see the constructor). Only for that request:
     * one that isn't being read any more (it expired, or went with the files offered) gives back nothing.
     */
    private release (reading: Reading): void {
        if (reading.number !== null) {
            this.served.delete(reading.number)
        }
        const i = this.reading.indexOf(reading)
        if (i >= 0) {
            this.reading.splice(i, 1)
            this.flow?.refund(reading.bytes)
            this.next()
        }
    }

    /**
     * Has the provider answer a request, handed to it under a number of the plugin's own (see served): the remote's
     * numbers for streams are the remote's to choose, and the provider keeps its reads, and answers, by the number it
     * is given. A file that can't be read for it (one replaced or removed since it was offered, a part larger than
     * MAX_RANGE) throws there, which would leave the remote waiting for an answer: it gets an error. `reading`: the
     * request is one for part of a file, answered when the provider has read it; otherwise (a file's size) the provider
     * answers as it goes, or not at all.
     */
    private read (request: ContentsRequest, reading: Reading | null = null): void {
        const number = ++this.numbered
        this.served.set(number, { streamId: request.streamId, reading })
        if (reading) {
            reading.number = number
        }
        try {
            this.serve({ streamId: number, index: request.index, flags: request.flags, position: request.position, size: request.size })
        } catch (e: any) {
            // Not answered yet, if it is still among those handed over (the provider can answer first, then throw).
            if (this.served.has(number)) {
                this.unreadable(request, e?.message ?? String(e), reading ?? undefined)
            }
        } finally {
            if (!reading) {
                this.served.delete(number)
            }
        }
    }

    /**
     * The remote gets an error for a request it can't have answered, and the user is told why (once for an offer).
     * `reading`: the request is one being read, which the error answers (see fail).
     */
    private unreadable (request: ContentsRequest, why: string, reading?: Reading): void {
        if (!this.unanswered) {
            this.unanswered = true
            this.log(`files: a request of the remote's was refused: ${why}`)
            this.toast(`Copying to the remote desktop failed: ${why}`)
        }
        this.fail(request.streamId, reading)
    }

    /**
     * Mac → remote: offers the files on the remote clipboard; the remote copies them when they're pasted. `leftOut`:
     * links in copied folders that weren't followed, and `cut`, whether the copied folders held more than is sent (see
     * entriesFor), which the messages mention.
     */
    send (files: any[], pasting = false, leftOut = 0, cut = false): Promise<void> | null {
        const entries = bounded(files)
        const count = entries.filter(f => !f.isDirectory).length
        if (!count || !this.mayGoThere()) {
            return null
        }
        const note = leftOutNote(leftOut, cut)
        try {
            // The remote answers the new clipboard before it can paste it; a paste sent sooner gets what it had.
            this.nothingOffered = false
            this.offerTaken = new Promise<boolean>(resolve => {
                const answered = (ok: boolean) => {
                    this.provider.off('format-list-response', answered)
                    resolve(!!ok)
                }
                this.provider.on('format-list-response', answered)
            })
            // The new offer takes the last one's place, and its reads with it: requests still waiting were for those,
            // and so were those being read. Each gets an error, and what the provider answers for them after that is
            // dropped (see the constructor). A pasted file's part still being read from disk goes on being read, and
            // keeps the room it took until then, when its request gets the error (see fetch): what it reads is in
            // memory all the same. The new offer's parts are read on their own, not after those.
            this.sent = entries
            this.disk = Promise.resolve()
            this.served.forEach(served => this.fail(served.streamId))
            this.served.clear()
            this.dropReading(r => r.since !== null)
            this.waiting.splice(0).forEach(request => this.fail(request.streamId))
            this.unanswered = false
            const upload = this.provider.uploadFiles(entries)
            this.log(`files: offered ${count} to the remote${pasting ? ' (copied here, pasted there)' : ''}`)
            this.toast(pasting ? `Pasting ${plural(count, 'file')}…${note}` : `${plural(count, 'file')} ready: paste on the remote desktop (⌘V) to copy ${count === 1 ? 'it' : 'them'} there`, [], 0)
            return upload.completion.then(
                () => { this.log('files: pasted on the remote'); this.toast(`Copied ${plural(count, 'file')} to the remote desktop${note}`) },
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
     * clipboard holds no files, or these are already offered and not pasted yet, or this computer's clipboard doesn't
     * go to the remote (then it isn't even read, and the keys paste what the remote has). Also true, with nothing
     * offered and no paste (offerAnswered: false), when no file can go: the copied folders hold none that can (links
     * left out, or past the walk's limits), or what was copied is gone, links that lead nowhere, pipes or folders with
     * nothing in them; or they couldn't be read (a folder that can't be opened, or one found swapped for another while
     * it was read): the keys would paste whatever the remote had instead.
     */
    pasteClipboardFiles (): boolean {
        if (!this.ways().toRemote) {
            return false
        }
        let key: string
        let found: { entries: any[], leftOut: number, cut: boolean }
        try {
            // Reading what was copied counts too: a file name on the clipboard that isn't one (a bad address) fails
            // here.
            const paths = clipboardPaths()
            if (!paths.length) {
                return false
            }
            key = paths.join('\n')
            if (this.pendingPaste === key) {
                return false
            }
            found = entriesFor(paths)
        } catch (e: any) {
            // Taken, with nothing to paste, as when nothing can go (below): the keys would paste what the remote had.
            this.log(`files: not sent: ${e?.message ?? e}`)
            this.toast(`Couldn't read the copied files: ${e?.message ?? e}`)
            this.offerTaken = Promise.resolve(false)
            this.nothingOffered = true
            return true
        }
        if (found.leftOut) {
            this.log(`files: left out ${plural(found.leftOut, 'link')} leading out of the copied folders`)
        }
        if (found.cut) {
            this.log('files: the copied folders hold more than a paste takes; not all sent')
        }
        // Nothing a file could be sent for: links left out, limits, or nothing there (copied and gone since, links that
        // lead nowhere, pipes, folders with nothing in them). Taken all the same: the keys would paste what the remote
        // had.
        if (!found.entries.some(e => !e.isDirectory)) {
            this.log('files: nothing to send')
            this.toast(`Nothing to send${leftOutNote(found.leftOut, found.cut)}`)
            this.offerTaken = Promise.resolve(false)
            this.nothingOffered = true
            return true
        }
        const done = this.send(found.entries, true, found.leftOut, found.cut)
        if (!done) {
            return false
        }
        this.pendingPaste = key
        done.finally(() => { if (this.pendingPaste === key) this.pendingPaste = null })
        return true
    }

    /** Picks files on the Mac to send (not even asked for where they wouldn't go). */
    async pickAndSend (): Promise<void> {
        if (!this.mayGoThere()) {
            return
        }
        const files = await this.provider.showFilePicker({ multiple: true })
        this.send(files)
    }

    /** Remote → Mac: the remote copied files; offer saving them, where the remote's clipboard comes here. */
    private offer (files: RemoteFile[]): void {
        const count = files.filter(f => !f.isDirectory).length
        if (!this.ways().fromRemote) {
            this.log(`files: the remote copied ${count}; not offered: its clipboard doesn't come here`)
            return
        }
        this.offered = files
        this.log(`files: the remote copied ${count}`)
        if (count) {
            this.toast(`${plural(count, 'file')} copied on the remote desktop`, [{ label: 'Save to Downloads', run: () => this.saveAll() }], 15000)
        }
    }

    /**
     * Downloads what the remote offered into a folder (default ~/Downloads), keeping their folder structure in new
     * folders (see newFolders). The files, and the folders made for them, are marked as downloaded (see
     * markDownloaded).
     */
    async saveAll (dir = path.join(os.homedir(), 'Downloads')): Promise<string[]> {
        if (!this.ways().fromRemote) {
            // Offered before the settings narrowed the clipboard: not any more.
            this.log('files: not saved: the remote\'s clipboard doesn\'t come here')
            this.toast('Not saved: clipboard sharing with this desktop is off.')
            return []
        }
        const files = this.offered
        const saved: string[] = []
        let unmarked = 0
        this.toast(`Saving ${plural(files.filter(f => !f.isDirectory).length, 'file')}…`, [], 0)
        // What was saved, and whether any of it isn't marked as downloaded: also when a later file fails.
        const done = () => {
            this.lastSaved = saved
            this.log(`files: saved ${saved.length}${unmarked ? `, ${unmarked} of them (or their folders) not marked as downloaded` : ''}`)
            return unmarked ? '\nNot all of it could be marked as downloaded, so the system may not warn before opening it' : ''
        }
        const show = () => saved.length ? [{ label: 'Show in Finder', run: () => require('electron').shell.showItemInFolder(saved[0]) }] : []
        const into = newFolders(dir)
        try {
            for (const [index, file] of files.entries()) {
                if (file.isDirectory) {
                    continue
                }
                // The settings can narrow while the files arrive: none is fetched once the remote's clipboard doesn't
                // come here any more. What was saved before keeps its note about marking, as after a failure.
                if (!this.ways().fromRemote) {
                    this.log(`files: stopped saving after ${saved.length}: the remote's clipboard doesn't come here any more`)
                    const note = done()
                    this.toast(`Stopped saving: clipboard sharing with this desktop is off now${saved.length ? ` (${plural(saved.length, 'file')} saved)` : ''}.${note}`, show())
                    return saved
                }
                // The name is checked before the download; the folder it goes in is made once the file is here, so that
                // one that fails doesn't leave an empty folder, and the folder is this file's, not one made since.
                const wanted = savePath(dir, file.path, file.name)
                const blob: Blob = await this.provider.downloadFile(file, index).completion
                const made: string[] = []
                const target = await place(dir, into(wanted, made), blob, made)
                saved.push(target)
                for (const item of [...made, target]) {
                    const error = await markDownloaded(item)
                    if (error && !unmarked++) {
                        this.log(`files: saved without marking it as downloaded: ${error}`)
                    }
                }
            }
            const note = done()
            this.toast(`Saved ${plural(saved.length, 'file')} to ${path.basename(dir)}${note}`, show())
        } catch (e: any) {
            this.log(`files: save: ${e?.message ?? e}`)
            // A folder made for what this save was putting there, with nothing in it: taken away (not one with files).
            await Promise.all(into.made.map(folder => fs.promises.rmdir(folder).catch(() => null)))
            const note = done()
            this.toast(`Saving failed: ${e?.message ?? e}${saved.length ? `\n${plural(saved.length, 'file')} saved before that` : ''}${note}`, show())
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
        this.disposed = true
        this.waiting = []
        this.dropReading()
        this.served.clear()
        this.stopListening.splice(0).forEach(stop => stop())
        this.overlay.classList.remove('trd-drop-target', 'trd-drop-refused')
        clearTimeout(this.toastTimer)
        this.toastEl?.remove()
        try { this.provider.dispose() } catch { }
    }
}

/** Control characters, and the invisible ones that change how a name reads, but for the joiners scripts and emoji use. */
const INVISIBLE = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * A subdivision's flag (England's, Scotland's and Wales' are the ones in Unicode's list): a black flag, the tags of a
 * subdivision's code (two lower-case letters for its country, one to four letters or digits for itself; UTS #51), a
 * cancel tag. Tags of anything else, text of any length that doesn't show, aren't a flag.
 */
const FLAG = /(\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,4}\u{E007F})/u

/**
 * A file or folder name from the remote, as it is saved here. Without control characters or the invisible ones that
 * change how a name reads: a right-to-left override shows `invoice<RLO>fdp.app` as "invoiceppa.pdf", an app made to
 * look like a document (the tags of a flag stay, in a flag). Composed (NFC), so that it is spelled as names typed here
 * are. On Windows, characters Windows doesn't take in a name (`:` would write into a stream of another file) become
 * `_`, dots or spaces at the end go (dropped there, so the file isn't what it says), and a device's name (`CON`,
 * `NUL.txt`, `COM1`: the device, not a file) gets a `_` in front. Letters that look like others remain: a name can't be
 * made to look like nothing else.
 */
export function safeName (name: string, windows = process.platform === 'win32'): string {
    let safe = name.normalize('NFC').split(FLAG).map((part, i) => i % 2 ? part : part.replace(INVISIBLE, '')).join('').trim()
    if (windows) {
        safe = safe.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '')
        if (/^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i.test(safe.split('.')[0].trimEnd())) {
            safe = `_${safe}`
        }
    }
    return safe
}

/**
 * Where a file the remote offered goes under `dir`, keeping its folder structure. The names come from the remote
 * (a server or anything on it can put them on the clipboard), so every component is cut at both separators (`\\` is
 * the wire convention, but a name may hold `/`), `.`, `..` and drive letters are dropped, each is made safe to show
 * (safeName), and the result must stay inside `dir`: a name like `../../Library/LaunchAgents/x.plist` must not land
 * outside Downloads.
 */
export function savePath (dir: string, folder: string | undefined, name: string): string {
    const parts = [folder ?? '', name]
        .flatMap(p => String(p).split(/[\\/]+/))
        .map(p => safeName(p.replace(/^[A-Za-z]:$/, '')))
        .filter(p => p && p !== '.' && p !== '..')
    const root = path.resolve(dir)
    const target = path.resolve(root, ...parts.length ? parts : ['file'])
    if (!target.startsWith(root + path.sep)) {
        throw new Error(`refused a file name that leaves the folder: ${JSON.stringify(name)}`)
    }
    return target
}

/**
 * For one save into `dir`: where each file the remote offered goes, so that the folders at the top of what it sends are
 * new ones (`name 2`, `name 3`… when the name is taken, as for files), not folders that were there before. What the
 * remote sends then never lands among files of the user's (in an app or a repository there, by a name it guessed),
 * and each folder it fills is one made for it, marked as downloaded. A top folder is made as it is chosen (mkdir fails
 * where the name is taken, by a folder, a file or a link), so that it is this save's whatever else is made meanwhile,
 * and is added to `made` (see place) for marking; `made` on the function itself lists them all, for a save that stops
 * to take away the empty ones.
 */
export function newFolders (dir: string): ((wanted: string, made?: string[]) => string) & { made: string[] } {
    const root = path.resolve(dir)
    const chosen = new Map<string, string>()
    const into = (wanted: string, made: string[] = []): string => {
        const [top, ...rest] = path.relative(root, wanted).split(path.sep)
        if (!rest.length) {
            return wanted  // a file at the top: place() numbers it when its name is taken
        }
        let name = chosen.get(top)
        if (name === undefined) {
            const { name: base, ext } = path.parse(top)
            fs.mkdirSync(root, { recursive: true })
            name = top
            for (let n = 2; ; n++) {
                try {
                    fs.mkdirSync(path.join(root, name))
                    break
                } catch (e: any) {
                    // Not into one that was there, whatever its name, or one that was made since.
                    if (e?.code !== 'EEXIST') {
                        throw e
                    }
                }
                if (n >= 10000) {
                    throw new Error(`no free name for a folder like ${JSON.stringify(top)}`)
                }
                name = `${base} ${n}${ext}`
            }
            chosen.set(top, name)
            made.push(path.join(root, name))
            into.made.push(path.join(root, name))
        }
        return path.join(root, name, ...rest)
    }
    into.made = [] as string[]
    return into
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
 * folder's real path; those it made are added to `made`. An existing component may be a link only if it stays inside
 * `dir`: folder names come from the remote, and a link in Downloads with a matching name would otherwise take the
 * files wherever it points.
 */
export async function foldersInside (dir: string, folder: string, made: string[] = []): Promise<string> {
    await fs.promises.mkdir(dir, { recursive: true })
    const root = await fs.promises.realpath(dir)
    let at = root
    for (const part of path.relative(path.resolve(dir), folder).split(path.sep).filter(Boolean)) {
        const next = path.join(at, part)
        const created = await fs.promises.mkdir(next).then(() => true, (e: any) => {
            if (e?.code !== 'EEXIST') {
                throw e
            }
            return false
        })
        at = await fs.promises.realpath(next)
        if (at !== root && !at.startsWith(root + path.sep)) {
            throw new Error(`refused to save through a link that leaves the folder: ${JSON.stringify(part)}`)
        }
        if (created) {
            made.push(at)
        }
    }
    return at
}

/**
 * Puts a download at `wanted` under `dir` (or `name 2.ext`, `name 3.ext`… when taken) and returns where it went.
 * The file is created there and never replaces or follows what exists: a name can be taken, or made a link,
 * between looking and writing. Folders made for it are added to `made`. A file that fails to be written whole (the
 * disk filled up, say) isn't left there part written, and not marked as downloaded (see saveAll); a file this call
 * didn't make isn't removed, whatever fails.
 */
export async function place (dir: string, wanted: string, blob: Blob, made: string[] = []): Promise<string> {
    const folder = await foldersInside(dir, path.dirname(wanted), made)
    const { name, ext } = path.parse(wanted)
    const temporary: string | undefined = (blob as any)[DISK_PATH]
    // Writes the file at `target`, a name that was free just before: false if it has been taken since (EEXIST).
    const write = async (target: string): Promise<boolean> => {
        if (temporary) {
            // The copy makes the file only where the name is free (EXCL), and tries to remove what it made when it
            // fails part way: what is there after any other failure isn't this call's to remove, but is said, in case
            // it is the beginning of this file, which the copy couldn't remove.
            try {
                await fs.promises.copyFile(temporary, target, fs.constants.COPYFILE_EXCL)
                return true
            } catch (e: any) {
                if (e?.code === 'EEXIST') {
                    return false
                }
                const left = await fs.promises.lstat(target).then(() => ` (${path.basename(target)} is there, perhaps saved in part)`, () => '')
                throw Object.assign(new Error(`${e?.message ?? e}${left}`), { code: e?.code })
            }
        }
        // Read before anything is made: a blob that can't be read leaves nothing here that is this call's to remove.
        const data = Buffer.from(await blob.arrayBuffer())
        let file: fs.promises.FileHandle
        try {
            file = await fs.promises.open(target, 'wx')
        } catch (e: any) {
            if (e?.code === 'EEXIST') {
                return false
            }
            throw e
        }
        try {
            await file.writeFile(data)
            await file.close()
            return true
        } catch (e: any) {
            await file.close().catch(() => null)
            // Made here, and only the beginning of this file: it goes, or, if it can't, the message says it stays.
            const left = await fs.promises.rm(target, { force: true }).then(
                () => '',
                (error: any) => ` (${path.basename(target)} was saved in part and couldn't be removed: ${error?.message ?? error})`)
            throw Object.assign(new Error(`${e?.message ?? e}${left}`), { code: e?.code })
        }
    }
    for (let n = 1; ; n++) {
        const target = path.join(folder, n === 1 ? `${name}${ext}` : `${name} ${n}${ext}`)
        if (!await fs.promises.lstat(target).then(() => true, () => false) && await write(target)) {
            // Saved, whatever becomes of the temporary file: one that can't go now goes with its folder when the
            // connection ends (DiskStorage.dispose). Failing the save here would leave the file unmarked (saveAll).
            if (temporary) {
                await fs.promises.rm(temporary, { force: true }).catch(() => null)
            }
            return target
        }
        if (n >= 10000) {
            throw Object.assign(new Error(`${path.basename(wanted)}: no free name for it in ${folder}`), { code: 'EEXIST' })
        }
    }
}

/**
 * Marks a file (or folder) saved from the remote as downloaded, as a browser marks its downloads, so the system
 * treats it as from elsewhere: macOS's quarantine attribute (Gatekeeper asks before an app, script, installer or
 * bundle among them first opens), Windows' Mark of the Web (SmartScreen, Office's Protected View). Linux has no such
 * mark. Resolves with what went wrong when it couldn't be marked (a disk that keeps no such attributes, say); the file
 * stays either way.
 */
export function markDownloaded (file: string): Promise<string | null> {
    if (process.platform === 'darwin') {
        // As browsers write it: flags (downloaded, not yet opened), when (seconds, in hex), by what. Without a
        // shell, so the path is an argument as it is.
        const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Tabby;`
        return new Promise(resolve => execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file], { timeout: 10000 }, (e, _out, err) => {
            resolve(e ? String(err).trim() || e.message : null)
        }))
    }
    if (process.platform === 'win32') {
        // The Internet zone, as a browser's download has.
        return fs.promises.writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').then(() => null, (e: any) => e?.message ?? String(e))
    }
    return Promise.resolve(null)
}
