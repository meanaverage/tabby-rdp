/** Maximum data retained by a WASM socket when its peer stops reading. */
export const MAX_WASM_SOCKET_BACKLOG = 64 * 1024 * 1024

/** Used only in the isolated WASM worker, before Emscripten loads its ws constructor. */
export function boundedWebSocket (Socket: any, overflow: () => void): any {
    return class extends Socket {
        private overflowed = false

        send (data: any, ...args: any[]): void {
            if (this.overflowed) { return }
            const size = typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? data?.length ?? 0
            if (!Number.isSafeInteger(size) || size < 0 || this.bufferedAmount + size > MAX_WASM_SOCKET_BACKLOG) {
                this.overflowed = true
                this.terminate()
                overflow()
                return
            }
            super.send(data, ...args)
        }
    }
}
