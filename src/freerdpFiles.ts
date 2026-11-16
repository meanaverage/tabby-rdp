import { ClipboardWays } from './clipboard'
import { MAX_ENTRIES, MAX_RANGE } from './fileTransfer'
import { numbers } from './freerdp'

const DESCRIPTOR_SIZE = 592
export const MAX_FILE_LIST = 4 + MAX_ENTRIES * DESCRIPTOR_SIZE
export const MAX_FILE_MESSAGE = MAX_RANGE + 12

interface FileInfo {
    name: string
    path?: string
    size: number
    lastModified?: number
    isDirectory?: boolean
}

/** MS-RDPECLIP FILEGROUPDESCRIPTORW; its fields are little endian, unlike the helper IPC. */
export function encodeFileList (files: FileInfo[]): Buffer {
    if (!files.length || files.length > MAX_ENTRIES) { throw new Error('Too many clipboard files, or an empty offer') }
    const data = Buffer.alloc(4 + files.length * DESCRIPTOR_SIZE)
    data.writeUInt32LE(files.length)
    files.forEach((file, i) => {
        const full = checkedPath(file.path ? `${file.path}\\${file.name}` : file.name)
        // No huge-file capability is negotiated. Reject rather than silently truncate a size or a name.
        if (full.length >= 260 || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 0xffffffff) {
            throw new Error('Clipboard file names must fit 259 UTF-16 characters and files must be smaller than 4 GiB')
        }
        const offset = 4 + i * DESCRIPTOR_SIZE
        data.writeUInt32LE(0x44, offset) // FD_ATTRIBUTES | FD_FILESIZE
        data.writeUInt32LE(file.isDirectory ? 0x10 : 0x80, offset + 36)
        data.writeUInt32LE(file.isDirectory ? 0 : file.size, offset + 68)
        data.write(full, offset + 72, 520, 'utf16le')
    })
    return data
}

function checkedPath (name: string): string {
    if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || name.includes('/')) {
        throw new Error('Invalid clipboard file path')
    }
    const parts = name.split('\\')
    if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part))) {
        throw new Error('Invalid clipboard file path')
    }
    return parts.join('\\')
}

export function decodeFileList (data: Buffer): FileInfo[] {
    if (data.length < 4 || data.length > MAX_FILE_LIST) { throw new Error('Invalid clipboard file list length') }
    const count = data.readUInt32LE(0)
    if (count > MAX_ENTRIES || data.length !== 4 + count * DESCRIPTOR_SIZE) { throw new Error('Invalid clipboard file count') }
    return Array.from({ length: count }, (_, i) => {
        const offset = 4 + i * DESCRIPTOR_SIZE
        const text = data.subarray(offset + 72, offset + 592).toString('utf16le')
        const end = text.indexOf('\0')
        if (end < 0) { throw new Error('Unterminated clipboard file name') }
        const full = checkedPath(text.slice(0, end))
        const parts = full.split('\\'), name = parts.pop()!
        const flags = data.readUInt32LE(offset)
        const size = flags & 0x40 ? data.readUInt32LE(offset + 64) * 0x100000000 + data.readUInt32LE(offset + 68) : 0
        if (!Number.isSafeInteger(size)) { throw new Error('Invalid clipboard file size') }
        return { name, path: parts.length ? parts.join('\\') : undefined, size,
            isDirectory: !!(flags & 4 && data.readUInt32LE(offset + 36) & 0x10) }
    })
}

/** Uses the existing JS transfer provider and disk/UI policy; no IronRDP WASM instance is needed. */
export function freeRDPFileProvider (
    Base: any,
    send: (type: string, data: Buffer) => void,
    ways: () => ClipboardWays,
    localOffer: () => void,
): any {
    return class extends Base {
        private localGeneration = 0
        private remoteGeneration = 0
        private requests = new Map<number, number>()
        private downloads = new Set<number>()

        downloadFile (file: FileInfo, index: number): any {
            const handle = super.downloadFile(file, index)
            handle.completion.finally(() => this.downloads.delete(handle.transferId)).catch(() => undefined)
            return handle
        }

        dispose (): void {
            this.requests.clear()
            this.downloads.clear()
            super.dispose()
        }

        sendInitiateFileCopy (files: FileInfo[]): void {
            if (!ways().toRemote) { throw new Error('Clipboard files cannot go to this desktop') }
            const descriptors = encodeFileList(files)
            this.localGeneration = (this.localGeneration + 1) >>> 0
            localOffer()
            send('o', Buffer.concat([numbers(this.localGeneration), descriptors]))
        }

        sendRequestFileContents (stream: number, index: number, flags: number, position: number, size: number): void {
            if (!ways().fromRemote) { throw new Error('Clipboard files cannot come from this desktop') }
            if (!Number.isSafeInteger(position) || position < 0 || size > MAX_RANGE) { throw new Error('Invalid file contents request') }
            this.downloads.add(stream)
            send('q', numbers(this.remoteGeneration, stream, index, flags, position % 0x100000000, Math.floor(position / 0x100000000), size))
        }

        sendSubmitFileContents (stream: number, error: boolean, data: Uint8Array): void {
            const generation = this.requests.get(stream)
            this.requests.delete(stream)
            if (generation === undefined) { return }
            const refused = error || !ways().toRemote || generation !== this.localGeneration || data.length > MAX_RANGE
            send('s', Buffer.concat([numbers(generation, stream, +refused), refused ? Buffer.alloc(0) : Buffer.from(data)]))
        }

        receive (type: string, data: Buffer): void {
            if (type === 'l' && data.length === 4) {
                this.remoteGeneration = data.readUInt32BE(0)
                for (const [stream, generation] of this.requests) { send('s', numbers(generation, stream, 1)) }
                this.requests.clear()
                // Without clipboard locking, a new offer invalidates unfinished downloads.
                for (const stream of this.downloads) {
                    this.handleFileContentsResponse({ streamId: stream, isError: true, data: new Uint8Array() })
                }
                this.downloads.clear()
                this.handleFilesAvailable([], undefined)
            } else if (type === 'f' && data.length >= 4) {
                if (!ways().fromRemote || data.readUInt32BE(0) !== this.remoteGeneration) { return }
                try { this.handleFilesAvailable(decodeFileList(data.subarray(4)), undefined) } catch (error: any) {
                    this.emit('error', { message: error.message })
                }
            } else if (type === 'a' && data.length === 1) {
                this.handleFormatListResponse(data[0] === 1)
            } else if (type === 'q' && data.length === 28) {
                const generation = data.readUInt32BE(0), stream = data.readUInt32BE(4)
                const position = data.readUInt32BE(16) + data.readUInt32BE(20) * 0x100000000
                if (generation !== this.localGeneration || !ways().toRemote || !Number.isSafeInteger(position) || this.requests.has(stream) || this.requests.size >= 1024) {
                    send('s', numbers(generation, stream, 1))
                    return
                }
                this.requests.set(stream, generation)
                this.handleFileContentsRequest({ streamId: stream, index: data.readUInt32BE(8), flags: data.readUInt32BE(12), position, size: data.readUInt32BE(24) })
            } else if (type === 's' && data.length >= 8) {
                const stream = data.readUInt32BE(0)
                if (!this.downloads.has(stream)) { return }
                this.handleFileContentsResponse({ streamId: stream, isError: !!data.readUInt32BE(4) || !ways().fromRemote, data: data.subarray(8) })
            } else { throw new Error('Invalid FreeRDP clipboard message') }
        }
    }
}
