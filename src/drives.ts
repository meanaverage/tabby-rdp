import * as fs from 'fs'
import * as path from 'path'
import type { ServerFlow } from './rdcleanpath'

const fsp = fs.promises

/** A local folder shared with remote desktops as a drive (`remoteDesktop.sharedFolders`). */
export interface SharedFolder {
    /** The folder on this computer, absolute. */
    path: string
    /** The drive's name on the remote desktop (`\\tsclient\<name>`, "<name> on <this computer>" in Explorer). */
    name: string
    /** The remote can read but not change, add or remove anything. */
    readOnly: boolean
}

/** The folders configured, tidied: strings and booleans where expected, no duplicate paths, each with a name. */
export function sharedFolders (store: any): SharedFolder[] {
    const list = Array.isArray(store?.sharedFolders) ? store.sharedFolders : []
    const folders: SharedFolder[] = []
    for (const entry of list) {
        const folder = typeof entry?.path === 'string' ? entry.path.trim() : ''
        if (!folder || folders.some(f => f.path === folder)) {
            continue
        }
        folders.push({
            path: folder,
            name: driveName(typeof entry.name === 'string' && entry.name.trim() ? entry.name : path.basename(folder) || folder, folders),
            readOnly: entry.readOnly === true,
        })
    }
    return folders
}

/**
 * A drive name the remote can show: no characters a Windows file name can't have, not empty, and not another
 * shared folder's name (a number is added).
 */
export function driveName (wanted: string, others: { name: string }[]): string {
    const base = wanted.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'Folder'
    let name = base
    for (let n = 2; others.some(o => o.name.toLowerCase() === name.toLowerCase()); n++) {
        name = `${base} ${n}`
    }
    return name
}

/** What a shared drive's file operations see and return (iron-remote-desktop-rdp's `DriveFs`). */
interface DriveStat {
    dir: boolean
    size: number
    created: number
    accessed: number
    modified: number
    readonly: boolean
}

interface DriveOpenMode {
    write: boolean
    create: boolean
    exclusive: boolean
    truncate: boolean
}

interface Handle {
    file: fs.promises.FileHandle
    folder: SharedFolder
    /** Where it was opened (its folder tells which disk it is on, see spaceOf). */
    local: string
}

/** Where a server path is on this computer, once checked to be inside its shared folder. */
interface Place {
    folder: SharedFolder
    /** The path to work on: links resolved up to (or, when following, including) the last component. */
    local: string
    /** The shared folder itself. */
    root: boolean
}

/** An error with a Node-style `code`, which IronRDP maps to the matching NT status for the server. */
function fail (code: string, message: string): never {
    const error = new Error(message) as NodeJS.ErrnoException
    error.code = code
    throw error
}

/** One read's worth: the server asks for 64 KiB or so; the proxy takes messages up to 32 MiB. */
const READ_LIMIT = 4 * 1024 * 1024

/**
 * Files a desktop may have open at once. Each one holds a file descriptor of Tabby's window, which all its tabs and
 * connections share, and the server decides how many it opens and when it closes them: with no limit, a hostile one
 * could take them all, and the window could then open no file or connection, or crash. Programs on the remote keep
 * far fewer open. More are refused (EMFILE) until the server closes some.
 */
export const MAX_OPEN_FILES = 1024

/**
 * Files all the desktops in a window may have open at once. The window's descriptors are one process's, so a limit per
 * desktop alone would let several desktops together hold that many times more. The window may have 8192 open on
 * Windows (the C runtime's most); on macOS, Node raises its soft limit to the hard one as it starts, which
 * kern.maxfilesperproc caps (some 138,000 on a Mac measured with Electron 40). This many is a quarter of the smaller of
 * those, which leaves most of them to everything else whatever the desktops do, and one desktop can't take it all
 * (MAX_OPEN_FILES is half of it). On Linux the window's limit wasn't measured (the system's hard limit, often half a
 * million or more, if Node raises it there as on macOS): where it is 4,096 or less, this many is half of it or more.
 */
export const WINDOW_OPEN_FILES = 2 * MAX_OPEN_FILES

/**
 * Files open, being opened, or being closed, through every SharedDrives of this window (the plugin is loaded once per
 * window). A file counts until its close has finished: closing waits for what is under way on the file (a slow disk or
 * network folder), and the descriptor is the window's until then.
 */
let openInWindow = 0

/** Files open, being opened or being closed, on the desktops of this window (see WINDOW_OPEN_FILES). */
export function openFilesInWindow (): number {
    return openInWindow
}

/**
 * Space a desktop leaves free on the disk a shared file is on when it makes the file larger than the data it sends:
 * a write past the end of a file, or a larger end of file. One request can ask for any size, and where files can't
 * have holes (HFS+, NTFS, exFAT) the space is taken at once, on the whole disk; elsewhere the file looks petabytes
 * long, and grows again with every request. Explorer sets a copy's size before writing it, so sizes aren't capped as
 * such: the part of a file the server sent no data for (its size beyond what it has on disk, see room) may be no
 * larger than the disk's free space less this much (1 GB, or a twentieth of a disk smaller than 20 GB). Data the
 * server does send isn't checked: that takes as long as any copy.
 */
function reserve (total: number): number {
    return Math.min(1024 ** 3, Math.floor(total / 20))
}

/**
 * Growth on each disk (by device number) in this window, one at a time across its desktops: from the reading of the
 * disk's free space (see room) until the file has grown. A check then never goes by free space another desktop's growth
 * has taken since it was read, so two desktops can't each be told the same free space is theirs. The latest growth's
 * end, which the next one on that disk waits for.
 */
const growth = new Map<number, Promise<void>>()

/** Runs `grow` once the growth before it on disk `dev`, in any desktop of this window, has ended (see growth). */
async function inTurn<T> (dev: number, grow: () => Promise<T>): Promise<T> {
    const before = growth.get(dev)
    let done = () => { }
    const mine = new Promise<void>(resolve => { done = resolve })
    growth.set(dev, mine)
    try {
        await before
        return await grow()
    } finally {
        done()
        if (growth.get(dev) === mine) {
            growth.delete(dev)
        }
    }
}

/**
 * The shared folders as the remote desktop's file system (MS-RDPEFS drive redirection), on Tabby's Node side.
 * IronRDP asks one thing at a time and waits for the answer, so everything here is asynchronous (Node's thread
 * pool): a slow disk or network mount holds up the drive, not Tabby's window.
 *
 * The server's paths are relative to the drive, with backslashes. Each resolves inside its folder, also once
 * symbolic links are followed: a path that leaves the folder, by `..` or through a link, doesn't exist as far as
 * the remote is concerned. Only regular files and folders are served (no devices, pipes or sockets, which could
 * block or do things on being opened). Read-only folders refuse anything that writes, and so does a file with more
 * than one name (a hard link), which may be outside the folder too. What the server opens and how much space it
 * takes without sending data are limited (MAX_OPEN_FILES and WINDOW_OPEN_FILES, reserve).
 */
export class SharedDrives {
    readonly drives: { id: number, name: string }[]
    private readonly byId = new Map<number, SharedFolder>()
    private readonly roots = new Map<SharedFolder, Promise<string>>()
    private readonly handles = new Map<number, Handle>()
    private nextHandle = 1
    /** Opens under way, which count towards MAX_OPEN_FILES too. */
    private opening = 0
    /** Closes under way, which count too: the descriptor is still open until the close has finished. */
    private closing = 0
    /** A limit on open files was reached (and logged, once). */
    private full = false
    /** The connection ended (see dispose): nothing more is opened, and what was still opening is closed again. */
    private disposed = false

    /** `flow`: the room for what is read for the server (the desktop's proxy, see ServerFlow and read). */
    constructor (folders: SharedFolder[], private log: (message: string) => void = () => null, private flow?: ServerFlow) {
        // RDPDR device ids are the session's: the audio device, when there is one, takes 0 in IronRDP.
        this.drives = folders.map((folder, i) => {
            this.byId.set(i + 1, folder)
            return { id: i + 1, name: folder.name }
        })
    }

    /**
     * Closes whatever the server left open (the connection ended), and what it was still opening once that is open.
     * Each counts towards the limits until its close has finished (see closeFile), not before.
     */
    dispose (): void {
        this.disposed = true
        for (const handle of this.handles.values()) {
            this.closeFile(handle.file).catch(() => null)
        }
        this.handles.clear()
    }

    /**
     * Closes a file that was counted as open (or being opened), and stops counting it once the close has finished,
     * whether it worked or not: closing waits for what is under way on the file, and a slot handed on before then would
     * let more descriptors be open than the limits allow.
     */
    private async closeFile (file: fs.promises.FileHandle): Promise<void> {
        this.closing++
        try {
            await file.close()
        } finally {
            this.closing--
            openInWindow--
        }
    }

    /** The folder's own real path (it may be reached through a link itself, as /tmp is on macOS). */
    private rootOf (folder: SharedFolder): Promise<string> {
        let root = this.roots.get(folder)
        if (!root) {
            root = fsp.realpath(folder.path)
            this.roots.set(folder, root)
            root.catch(() => this.roots.delete(folder))  // not there now: look again next time
        }
        return root
    }

    /**
     * The place of `remote` on drive `deviceId`. `..` doesn't resolve, and neither does a path whose links lead out
     * of the shared folder (ENOENT either way). With `follow`, the last component's link is followed too (reading,
     * listing, opening); without, it is left alone (removing or renaming a link works on the link, not its target).
     * What is there, if anything, is for the caller to find out.
     */
    private async locate (deviceId: number, remote: string, follow: boolean): Promise<Place> {
        const folder = this.byId.get(deviceId) ?? fail('ENOENT', `no drive ${deviceId}`)
        const parts: string[] = []
        for (const part of remote.split(/[\\/]+/)) {
            if (part === '' || part === '.') {
                continue
            }
            if (part === '..' || part.includes('\0')) {
                fail('ENOENT', `${remote}: not inside ${folder.name}`)
            }
            parts.push(part)
        }
        const root = await this.rootOf(folder)
        if (!parts.length) {
            return { folder, local: root, root: true }
        }
        const inside = (real: string) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
        const outside = () => fail('ENOENT', `${remote}: leads out of ${folder.name}`)
        // The folder it is in, links followed: there, and inside.
        const parent = await fsp.realpath(path.join(root, ...parts.slice(0, -1)))
        if (!inside(parent)) {
            outside()
        }
        const local = path.join(parent, parts[parts.length - 1])
        if (!follow) {
            return { folder, local, root: false }
        }
        try {
            const real = await fsp.realpath(local)
            return inside(real) ? { folder, local: real, root: real === root } : outside()
        } catch (e: any) {
            if (e?.code !== 'ENOENT') {
                throw e
            }
        }
        // Nothing there. A link to nothing isn't a place to make something: it would be made where the link points.
        if (await fsp.lstat(local).then(() => true, () => false)) {
            outside()
        }
        return { folder, local, root: false }
    }

    private writable (folder: SharedFolder, what: string): void {
        if (folder.readOnly) {
            fail('EACCES', `${folder.name} is shared read-only: ${what}`)
        }
    }

    private handle (id: number): Handle {
        return this.handles.get(id) ?? fail('EBADF', `no open file ${id}`)
    }

    /**
     * Makes sure the disk of an open file (`now`: its stat) can take the file being `end` bytes long without the server
     * sending data for what that adds (see reserve). What counts is the part of the file that isn't on disk, from what
     * the file has there, not from its size: on file systems with holes, growing a file takes no space, so growing it
     * again and again would pass a check of each growth alone. Called in the disk's turn (see grow).
     */
    private async room (handle: Handle, now: fs.Stats, end: number): Promise<void> {
        const space = await this.spaceOf(handle, now)
        // 512-byte blocks, as POSIX counts them (and libuv on Windows); a file system that doesn't say has its size.
        const onDisk = Number.isFinite(now.blocks) ? now.blocks * 512 : now.size
        const unsent = Math.max(0, end - onDisk)
        if (unsent > space.bsize * space.bavail - reserve(space.bsize * space.blocks)) {
            fail('ENOSPC', `${handle.folder.name}: not enough free space for a file ${end} bytes long`)
        }
    }

    /**
     * Makes an open file larger than the data the server sends for it, with `change`: `end` bytes long, with no data
     * from `from` (past the end of the file now) on. In its disk's turn (see growth), once room() has checked the space
     * against the file as it is then: another request may have changed it while this one waited its turn.
     */
    private grow<T> (handle: Handle, dev: number, from: number, end: number, change: () => Promise<T>): Promise<T> {
        return inTurn(dev, async () => {
            const now = await handle.file.stat()
            if (from > now.size) {
                await this.room(handle, now, end)
            }
            return change()
        })
    }

    /**
     * The free space of the disk an open file (`now`) is on: that of the folder it was opened in, or else of the shared
     * folder, whichever is on that disk (the same device). A disk mounted somewhere in a shared folder (a USB stick in
     * a shared /Volumes, a disk image in a shared home) has its own free space, which the shared folder's doesn't say.
     * When neither is on it (the file's folder was moved away meanwhile), the space isn't known, and the file isn't
     * grown (ENOSPC).
     */
    private async spaceOf (handle: Handle, now: fs.Stats): Promise<fs.StatsFs> {
        for (const dir of [path.dirname(handle.local), await this.rootOf(handle.folder).catch(() => null)]) {
            if (dir === null) {
                continue
            }
            const [at, space] = await Promise.all([fsp.stat(dir), fsp.statfs(dir)]).catch(() => [null, null])
            if (at && space && at.dev === now.dev) {
                return space
            }
        }
        return fail('ENOSPC', `${handle.folder.name}: the free space of this file's disk isn't known`)
    }

    async stat (deviceId: number, remote: string): Promise<DriveStat | null> {
        let s: fs.Stats
        let folder: SharedFolder
        try {
            const place = await this.locate(deviceId, remote, true)
            folder = place.folder
            s = await fsp.stat(place.local)
        } catch (e: any) {
            if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
                return null
            }
            throw e
        }
        // Devices, pipes and sockets aren't shown.
        if (!s.isFile() && !s.isDirectory()) {
            return null
        }
        return {
            dir: s.isDirectory(),
            size: s.isDirectory() ? 0 : s.size,
            created: s.birthtimeMs || s.ctimeMs,
            accessed: s.atimeMs,
            modified: s.mtimeMs,
            // A file with other names (hard links) isn't changed through the share (see open), so it shows read-only.
            readonly: folder.readOnly || (s.mode & 0o200) === 0 || (s.isFile() && s.nlink > 1),
        }
    }

    async list (deviceId: number, remote: string): Promise<string[]> {
        const { local } = await this.locate(deviceId, remote, true)
        return fsp.readdir(local)
    }

    async open (deviceId: number, remote: string, mode: DriveOpenMode): Promise<number> {
        if (this.disposed) {
            fail('EBADF', `${remote}: the connection has ended`)
        }
        const mine = this.handles.size + this.opening + this.closing >= MAX_OPEN_FILES
        if (mine || openInWindow >= WINDOW_OPEN_FILES) {
            if (!this.full) {
                this.full = true
                this.log(mine
                    ? `drives: the remote has ${MAX_OPEN_FILES} files open, the most a desktop may; more are refused until it closes some`
                    : `drives: the desktops in this window have ${WINDOW_OPEN_FILES} files open, the most they may together; more are refused until some are closed`)
            }
            fail('EMFILE', `${remote}: ${mine ? MAX_OPEN_FILES : WINDOW_OPEN_FILES} files are open already`)
        }
        this.opening++
        openInWindow++
        let handle: Handle
        try {
            handle = await this.openFile(deviceId, remote, mode)
        } catch (e) {
            openInWindow--
            throw e
        } finally {
            this.opening--
        }
        // The connection ended while the file was being opened: dispose() has closed the others, and nothing would
        // close this one.
        if (this.disposed) {
            await this.closeFile(handle.file).catch(() => null)
            fail('EBADF', `${remote}: the connection has ended`)
        }
        const id = this.nextHandle++
        this.handles.set(id, handle)
        return id
    }

    private async openFile (deviceId: number, remote: string, mode: DriveOpenMode): Promise<Handle> {
        const { folder, local } = await this.locate(deviceId, remote, true)
        if (mode.write || mode.create || mode.truncate) {
            this.writable(folder, `can't write ${remote}`)
        }
        const existing = await fsp.stat(local).catch(() => null)
        if (existing && !existing.isFile()) {
            fail(existing.isDirectory() ? 'EISDIR' : 'EACCES', `${remote}: not a file`)
        }
        // The path was resolved just now: a link (or a pipe) put in its place meanwhile isn't followed (or waited on).
        // Truncating waits until the file is known to be one the remote may change (below).
        const { O_RDONLY, O_RDWR, O_CREAT, O_EXCL } = fs.constants
        const guard = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
        const flags = (mode.write || mode.truncate ? O_RDWR : O_RDONLY) | (mode.create ? O_CREAT : 0) | (mode.exclusive ? O_EXCL : 0) | guard
        const file = await fsp.open(local, flags, 0o644)
        try {
            const s = await file.stat()
            if (!s.isFile()) {
                fail('EACCES', `${remote}: not a file`)
            }
            // A file with another name (a hard link) is the same file there, which may be outside the shared folder:
            // what the remote writes would change it there too. Reading it is reading what is in the folder.
            if ((mode.write || mode.truncate) && s.nlink > 1) {
                fail('EACCES', `${remote}: has more than one name (a hard link), so it isn't changed from the remote`)
            }
            if (mode.truncate) {
                await file.truncate(0)
            }
        } catch (e) {
            await file.close().catch(() => null)
            throw e
        }
        return { file, folder, local }
    }

    /**
     * A read of the server's: up to READ_LIMIT, as much as it asks for. Its answer is handed to the connection, where
     * it stays, in the window's memory, until the proxy has read it, as the server takes what is sent: a server that
     * keeps asking and reads slowly, or not at all, would otherwise have every answer kept there. So it takes room for
     * it first (see ServerFlow), waiting while there is none, and gives back what it didn't read.
     *
     * How far the room holds the answers back: see ServerFlow (the proxy reading the connection's other messages makes
     * room too).
     */
    async read (handle: number, offset: number, length: number): Promise<Uint8Array> {
        const size = Math.min(length, READ_LIMIT)
        while (this.flow && !this.flow.room()) {
            await this.flow.whenRoom()
        }
        const { file } = this.handle(handle)
        this.flow?.spend(size)
        const buffer = Buffer.allocUnsafe(size)
        let read = 0
        try {
            // A read can come back short before the end of the file: fill what was asked.
            while (read < buffer.length) {
                const { bytesRead } = await file.read(buffer, read, buffer.length - read, offset + read)
                if (bytesRead === 0) {
                    break
                }
                read += bytesRead
            }
        } catch (e) {
            this.flow?.refund(size)
            throw e
        }
        this.flow?.refund(size - read)
        return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
    }

    async write (handle: number, offset: number, data: Uint8Array): Promise<number> {
        const entry = this.handle(handle)
        const { file, folder } = entry
        this.writable(folder, 'can\'t write')
        const end = offset + data.length
        if (!(offset >= 0 && Number.isSafeInteger(offset) && Number.isSafeInteger(end))) {
            fail('ENOSPC', `can't write at ${offset}: past what a file can hold`)
        }
        const writeAll = async () => {
            let written = 0
            while (written < data.length) {
                written += (await file.write(data, written, data.length - written, offset + written)).bytesWritten
            }
            return written
        }
        // Past the end of the file, the gap up to the data is made as well, with nothing sent for it (see room).
        if (offset > 0) {
            const now = await file.stat()
            if (offset > now.size) {
                return this.grow(entry, now.dev, offset, end, writeAll)
            }
        }
        return writeAll()
    }

    async truncate (handle: number, size: number): Promise<void> {
        const entry = this.handle(handle)
        const { file, folder } = entry
        this.writable(folder, 'can\'t resize')
        if (!(size >= 0 && Number.isSafeInteger(size))) {
            fail('ENOSPC', `can't make a file ${size} bytes long`)
        }
        // A larger end of file: what it adds has no data sent for it (see room).
        const now = await file.stat()
        if (size > now.size) {
            return this.grow(entry, now.dev, size, size, () => file.truncate(size))
        }
        await file.truncate(size)
    }

    async close (handle: number): Promise<void> {
        const entry = this.handles.get(handle)
        if (entry) {
            this.handles.delete(handle)
            await this.closeFile(entry.file)
        }
    }

    async mkdir (deviceId: number, remote: string): Promise<void> {
        const { folder, local } = await this.locate(deviceId, remote, true)
        this.writable(folder, `can't make ${remote}`)
        await fsp.mkdir(local)
    }

    async remove (deviceId: number, remote: string): Promise<void> {
        const { folder, local, root } = await this.locate(deviceId, remote, false)
        this.writable(folder, `can't remove ${remote}`)
        if (root) {
            fail('EACCES', `${folder.name}: the shared folder itself stays`)
        }
        // Directories only when empty, as on Windows (ENOTEMPTY otherwise); the server removes contents first. A
        // link is removed itself, whatever it points to.
        if ((await fsp.lstat(local)).isDirectory()) {
            await fsp.rmdir(local)
        } else {
            await fsp.unlink(local)
        }
    }

    async rename (deviceId: number, from: string, to: string, replace: boolean): Promise<void> {
        const source = await this.locate(deviceId, from, false)
        const target = await this.locate(deviceId, to, false)
        this.writable(source.folder, `can't rename ${from}`)
        if (source.root || target.root) {
            fail('EACCES', `${source.folder.name}: the shared folder itself stays`)
        }
        const moving = await fsp.lstat(source.local)
        const existing = await fsp.lstat(target.local).catch(() => null)
        // Something else in the way: only when asked to replace it. The same file under another spelling of its
        // name (a case-insensitive file system) is a plain rename.
        if (existing && !(existing.dev === moving.dev && existing.ino === moving.ino)) {
            if (!replace) {
                fail('EEXIST', `${to} exists`)
            }
            if (existing.isDirectory() || moving.isDirectory()) {
                fail('EACCES', `${to}: folders aren't replaced`)
            }
        }
        await fsp.rename(source.local, target.local)
    }

    async volume (deviceId: number): Promise<{ total: number, free: number, label: string }> {
        const folder = this.byId.get(deviceId) ?? fail('ENOENT', `no drive ${deviceId}`)
        try {
            const s = await fsp.statfs(await this.rootOf(folder))
            const total = s.bsize * s.blocks
            // Free space less the reserve, which the remote can't take by making files larger (see room): Explorer
            // checks a copy fits before starting it.
            return { total, free: Math.max(0, s.bsize * s.bavail - reserve(total)), label: folder.name }
        } catch (e: any) {
            this.log(`drives: ${folder.name}: no volume information: ${e?.message ?? e}`)
            return { total: 0, free: 0, label: folder.name }
        }
    }
}
