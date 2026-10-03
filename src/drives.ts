import * as fs from 'fs'
import * as path from 'path'

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
    fd: number
    folder: SharedFolder
}

/** An error with a Node-style `code`, which IronRDP maps to the matching NT status for the server. */
function fail (code: string, message: string): never {
    const error = new Error(message) as NodeJS.ErrnoException
    error.code = code
    throw error
}

const READ_LIMIT = 16 * 1024 * 1024

/**
 * The shared folders as the remote desktop's file system (MS-RDPEFS drive redirection), on Tabby's Node side.
 * IronRDP calls these synchronously, with the server's paths: relative to the drive, with backslashes. Each
 * resolves inside its folder; a path that would leave it doesn't exist. Read-only folders refuse anything that
 * writes.
 */
export class SharedDrives {
    readonly drives: { id: number, name: string }[]
    private readonly byId = new Map<number, SharedFolder>()
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
            try {
                fs.closeSync(handle.fd)
            } catch {
                // already gone
            }
        }
        this.handles.clear()
    }

    /** The local path for `remote` on drive `deviceId`; `..` and absolute paths don't resolve. */
    private resolve (deviceId: number, remote: string): { folder: SharedFolder, local: string } {
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
        return { folder, local: path.join(folder.path, ...parts) }
    }

    private writable (folder: SharedFolder, what: string): void {
        if (folder.readOnly) {
            fail('EACCES', `${folder.name} is shared read-only: ${what}`)
        }
    }

    private handle (id: number): Handle {
        return this.handles.get(id) ?? fail('EBADF', `no open file ${id}`)
    }

    stat (deviceId: number, remote: string): DriveStat | null {
        const { folder, local } = this.resolve(deviceId, remote)
        const s = fs.statSync(local, { throwIfNoEntry: false })
        if (!s) {
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

    list (deviceId: number, remote: string): string[] {
        const { local } = this.resolve(deviceId, remote)
        return fs.readdirSync(local)
    }

    open (deviceId: number, remote: string, mode: DriveOpenMode): number {
        const { folder, local } = this.resolve(deviceId, remote)
        if (mode.write || mode.create || mode.truncate) {
            this.writable(folder, `can't write ${remote}`)
        }
        const { O_RDONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC } = fs.constants
        const flags = (mode.write ? O_RDWR : O_RDONLY) | (mode.create ? O_CREAT : 0) | (mode.exclusive ? O_EXCL : 0) | (mode.truncate ? O_TRUNC : 0)
        const fd = fs.openSync(local, flags, 0o644)
        const id = this.nextHandle++
        this.handles.set(id, { fd, folder })
        return id
    }

    read (handle: number, offset: number, length: number): Uint8Array {
        const { fd } = this.handle(handle)
        const buffer = Buffer.allocUnsafe(Math.min(length, READ_LIMIT))
        let read = 0
        // A read can come back short before the end of the file (pipes, some file systems): fill what was asked.
        while (read < buffer.length) {
            const n = fs.readSync(fd, buffer, read, buffer.length - read, offset + read)
            if (n === 0) {
                break
            }
            read += n
        }
        return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
    }

    write (handle: number, offset: number, data: Uint8Array): number {
        const { fd, folder } = this.handle(handle)
        this.writable(folder, 'can\'t write')
        let written = 0
        while (written < data.length) {
            written += fs.writeSync(fd, data, written, data.length - written, offset + written)
        }
        return written
    }

    truncate (handle: number, size: number): void {
        const { fd, folder } = this.handle(handle)
        this.writable(folder, 'can\'t resize')
        fs.ftruncateSync(fd, size)
    }

    close (handle: number): void {
        const entry = this.handles.get(handle)
        if (entry) {
            this.handles.delete(handle)
            fs.closeSync(entry.fd)
        }
    }

    mkdir (deviceId: number, remote: string): void {
        const { folder, local } = this.resolve(deviceId, remote)
        this.writable(folder, `can't make ${remote}`)
        fs.mkdirSync(local)
    }

    remove (deviceId: number, remote: string): void {
        const { folder, local } = this.resolve(deviceId, remote)
        this.writable(folder, `can't remove ${remote}`)
        if (local === folder.path) {
            fail('EACCES', `${folder.name}: the shared folder itself stays`)
        }
        // Directories only when empty, as on Windows (ENOTEMPTY otherwise); the server removes contents first.
        if (fs.statSync(local).isDirectory()) {
            fs.rmdirSync(local)
        } else {
            fs.unlinkSync(local)
        }
    }

    rename (deviceId: number, from: string, to: string, replace: boolean): void {
        const source = this.resolve(deviceId, from)
        const target = this.resolve(deviceId, to)
        this.writable(source.folder, `can't rename ${from}`)
        if (source.local === source.folder.path) {
            fail('EACCES', `${source.folder.name}: the shared folder itself stays`)
        }
        const moving = fs.statSync(source.local)
        const existing = fs.statSync(target.local, { throwIfNoEntry: false })
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
        fs.renameSync(source.local, target.local)
    }

    volume (deviceId: number): { total: number, free: number, label: string } {
        const folder = this.byId.get(deviceId) ?? fail('ENOENT', `no drive ${deviceId}`)
        try {
            const s = fs.statfsSync(folder.path)
            return { total: s.bsize * s.blocks, free: s.bsize * s.bavail, label: folder.name }
        } catch (e: any) {
            this.log(`drives: ${folder.name}: no volume information: ${e?.message ?? e}`)
            return { total: 0, free: 0, label: folder.name }
        }
    }
}
