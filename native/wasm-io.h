/* Bounded byte streams between the Emscripten pthread and its Node worker host.
 * No filesystem, process stdio, credentials in argv, or renderer-wide shared memory. */
#include <stdatomic.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#define WASM_RING_SIZE (1024u * 1024u)
typedef struct {
    _Atomic uint32_t read, write, closed;
    BYTE data[WASM_RING_SIZE];
} WasmRing;
static WasmRing wasm_input, wasm_output;
EMSCRIPTEN_KEEPALIVE uintptr_t tabby_input_buffer(void) { return (uintptr_t)&wasm_input; }
EMSCRIPTEN_KEEPALIVE uintptr_t tabby_output_buffer(void) { return (uintptr_t)&wasm_output; }
static BOOL wasm_read(void* target, size_t size) {
    BYTE* p = target;
    while (size) {
        uint32_t read = atomic_load(&wasm_input.read), write = atomic_load(&wasm_input.write);
        if (atomic_load(&wasm_input.closed)) return FALSE;
        uint32_t available = write - read;
        if (!available) { emscripten_futex_wait((void*)&wasm_input.write, write, 1000); continue; }
        size_t count = WASM_RING_SIZE - (read % WASM_RING_SIZE);
        if (count > available) count = available;
        if (count > size) count = size;
        memcpy(p, wasm_input.data + read % WASM_RING_SIZE, count);
        atomic_store(&wasm_input.read, read + (uint32_t)count);
        emscripten_futex_wake((void*)&wasm_input.read, INT_MAX);
        p += count; size -= count;
    }
    return TRUE;
}
static BOOL wasm_write(const void* source, size_t size) {
    const BYTE* p = source;
    while (size) {
        uint32_t read = atomic_load(&wasm_output.read), write = atomic_load(&wasm_output.write);
        if (atomic_load(&wasm_output.closed)) return FALSE;
        uint32_t available = WASM_RING_SIZE - (write - read);
        if (!available) { emscripten_futex_wait((void*)&wasm_output.read, read, 1000); continue; }
        size_t count = WASM_RING_SIZE - (write % WASM_RING_SIZE);
        if (count > available) count = available;
        if (count > size) count = size;
        memcpy(wasm_output.data + write % WASM_RING_SIZE, p, count);
        atomic_store(&wasm_output.write, write + (uint32_t)count);
        emscripten_futex_wake((void*)&wasm_output.write, INT_MAX);
        p += count; size -= count;
    }
    return TRUE;
}
