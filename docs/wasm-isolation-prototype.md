# One WASM instance per desktop: prototype for #49

Local branch `proto/wasm-per-desktop`, based on main after #58. Nothing has been pushed or published. Uses main's
public IronRDP binary and patch series; no held IronRDP security changes are included.

## What works

- Load the web component and backend factory once, and compile the WASM once per service/window.
- Instantiate fresh glue and WASM for every connection attempt, including sign-in retries and reconnects.
- Keep backend classes, heap tables, cached memory views, finalizers and extension objects together per desktop.
- Observe WASM exports for traps, and signal that desktop even if a Rust async task leaves `run()` pending. Close
  that desktop's proxy; the existing bounded reconnect policy creates a fresh backend for that pane.
- Release the component, clipboard listeners/loop, video decoder, sound, microphone, file provider, shared drives
  and size observer when an attempt ends. Clear references to the old backend. Skip Rust finalizers after a trap.

The factory is generated ahead of time, without runtime evaluation or new module URLs per desktop. Its generator
rejects imports, nonlocal exports and an unrecognized WASM initializer. `scripts/build-ironrdp.sh` generates it
alongside the existing bundle, and `vendor/SHA256SUMS` covers it. The original JS bundle and WASM are unchanged.

## Checks

```sh
npm ci --ignore-scripts
node scripts/make-ironrdp-factory.mjs
npm run build
npm run typecheck
npm run test:unit
node --expose-gc scripts/bench-ironrdp-instances.mjs /tmp/ironrdp-instances.json
node scripts/smoke-ironrdp-instances.mjs
```

The tests use real IronRDP WASM to show distinct classes, independent clipboard data and independent memory growth.
A tiny synthetic WASM module containing `unreachable` tests trap notification, continued operation of another
backend, and recovery with a new instance of the same compiled module. Service tests cover cleanup after failed
shutdown and an asynchronous trap whose run promise never resolves.

The browser smoke script starts isolated headless Chrome with a disposable profile, mounts two actual web components
with distinct backends, closes one, mounts a replacement and closes both. It checks component readiness and all
seven component-owned global listeners; it makes no RDP connection. Set `CHROME_BIN` to a Chromium executable if
it is not installed at the default macOS Chrome path.

Local verification passed: build and typecheck; 482 unit tests (480 passed, two existing Electron-only skips);
headless Chrome smoke (three components ready, seven listeners per component, zero remaining owned listeners);
factory output identical with the project's and web build's TypeScript parsers.

## Initial measurements

Apple Silicon, Node 26.8.2, idle initialized backends. Each instance uses **2.0625 MiB** of linear memory after setup:

| Instances | WASM memory |
| --- | ---: |
| 1 | 2.0625 MiB |
| 2 | 4.125 MiB |
| 4 | 8.25 MiB |
| 8 | 16.5 MiB |

After the first cold initialization, additional instances took about 0.6–1.3 ms in this run. JS heap growth after
GC was about 0.42 MiB per additional instance. All eight released memory objects were collected; a further 32
create/use/release cycles retained zero memory objects after forced GC. The benchmark emits the binary hash,
environment, all one-to-eight samples, JS heap/RSS deltas and collection counts as JSON.
The captured initial run is in [wasm-isolation-benchmark.json](wasm-isolation-benchmark.json).

These are startup costs, not connected-desktop costs: no framebuffers, protocol queues, audio, microphone or GPU
decoders are active. Forced GC establishes that these idle memories can be collected; it does not predict when
Electron will collect them during use.

## Before merging

- Live Tabby: two connected desktops, focus/clipboard routing, files and shared drives, audio/microphone, H.264,
  close one desktop, reconnect one desktop, and sign-in/certificate retries.
- Repeat one-to-eight measurements with connected desktops at representative resolutions, including GPU usage.
- Exercise instance-scoped fault recovery while another connected desktop continues rendering and accepting input.
  Check pending browser callbacks, global error reporting and collection over repeated fault/reconnect cycles.
- Benchmark the small wrapper on each WASM export call under active keyboard, clipboard and graphics workloads.
- Run the full clean IronRDP vendor rebuild in CI before merging. The generated factory's reproducibility test
  already checks it against the committed public bundle; this prototype does not rerun the Rust toolchain build.

All desktops still share the renderer's thread and process. Separate WASM heaps contain instance faults, but do
not prevent aggregate renderer memory exhaustion or main-thread stalls.
