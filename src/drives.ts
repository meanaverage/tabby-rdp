import * as fs from 'fs'
import * as path from 'path'

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
 * The shared folders as the remote desktop's file system (MS-RDPEFS drive redirection), on Tabby's Node side.
 * IronRDP asks one thing at a time and waits for the answer, so everything here is asynchronous (Node's thread
 * pool): a slow disk or network mount holds up the drive, not Tabby's window.
 *
 * The server's paths are relative to the drive, with backslashes. Each resolves inside its folder, also once
 * symbolic links are followed: a path that leaves the folder, by `..` or through a link, doesn't exist as far as
 * the remote is concerned. Only regular files and folders are served (no devices, pipes or sockets, which could
 * block or do things on being opened). Read-only folders refuse anything that writes.
 */
export class SharedDrives {
    readonly drives: { id: number, name: string }[]
    private readonly byId = new Map<number, SharedFolder>()
    private readonly roots = new Map<SharedFolder, Promise<string>>()
    private readonly handles = new Map<number, Handle>()
    private nextHandle = 1

    constructor (folders: SharedFolder[], private log: (message: string) => void = () => null) {
        // RDPDR device ids are the session's: the audio device, when there is one, takes 0 in IronRDP.
        this.drives = folders.map((folder, i) => {
            this.byId.set(i + 1, folder)
            return { id: i + 1, name: folder.name }
        })
    }

    /** Closes whatever the server left open (the connection ended). */
    dispose (): void {
        for (const handle of this.handles.values()) {
            handle.file.close().catch(() => null)
        }
        this.handles.clear()
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
            readonly: folder.readOnly || (s.mode & 0o200) === 0,
        }
    }

    async list (deviceId: number, remote: string): Promise<string[]> {
        const { local } = await this.locate(deviceId, remote, true)
        return fsp.readdir(local)
    }

    async open (deviceId: number, remote: string, mode: DriveOpenMode): Promise<number> {
        const { folder, local } = await this.locate(deviceId, remote, true)
        if (mode.write || mode.create || mode.truncate) {
            this.writable(folder, `can't write ${remote}`)
        }
        const existing = await fsp.stat(local).catch(() => null)
        if (existing && !existing.isFile()) {
            fail(existing.isDirectory() ? 'EISDIR' : 'EACCES', `${remote}: not a file`)
        }
        // The path was resolved just now: a link (or a pipe) put in its place meanwhile isn't followed (or waited on).
        const { O_RDONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC } = fs.constants
        const guard = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
        const flags = (mode.write ? O_RDWR : O_RDONLY) | (mode.create ? O_CREAT : 0) | (mode.exclusive ? O_EXCL : 0) | (mode.truncate ? O_TRUNC : 0) | guard
        const file = await fsp.open(local, flags, 0o644)
        if (!(await file.stat()).isFile()) {
            await file.close()
            fail('EACCES', `${remote}: not a file`)
        }
        const id = this.nextHandle++
        this.handles.set(id, { file, folder })
        return id
    }

    async read (handle: number, offset: number, length: number): Promise<Uint8Array> {
        const { file } = this.handle(handle)
        const buffer = Buffer.allocUnsafe(Math.min(length, READ_LIMIT))
        let read = 0
        // A read can come back short before the end of the file: fill what was asked.
        while (read < buffer.length) {
            const { bytesRead } = await file.read(buffer, read, buffer.length - read, offset + read)
            if (bytesRead === 0) {
                break
            }
            read += bytesRead
        }
        return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
    }

    async write (handle: number, offset: number, data: Uint8Array): Promise<number> {
        const { file, folder } = this.handle(handle)
        this.writable(folder, 'can\'t write')
        let written = 0
        while (written < data.length) {
            written += (await file.write(data, written, data.length - written, offset + written)).bytesWritten
        }
        return written
    }

    async truncate (handle: number, size: number): Promise<void> {
        const { file, folder } = this.handle(handle)
        this.writable(folder, 'can\'t resize')
        await file.truncate(size)
    }

    async close (handle: number): Promise<void> {
        const entry = this.handles.get(handle)
        if (entry) {
            this.handles.delete(handle)
            await entry.file.close()
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
            return { total: s.bsize * s.blocks, free: s.bsize * s.bavail, label: folder.name }
        } catch (e: any) {
            this.log(`drives: ${folder.name}: no volume information: ${e?.message ?? e}`)
            return { total: 0, free: 0, label: folder.name }
        }
    }
}
