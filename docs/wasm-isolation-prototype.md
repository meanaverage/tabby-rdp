# One WASM instance per desktop: release candidate for #49

The original prototype is retained on local branch `proto/wasm-per-desktop`. Its three isolation and lifecycle
commits are now incorporated into `release/0.5.3-rc.1`, based on public main after 0.5.2 and the runner updates.
The candidate uses 0.5.2's IronRDP binary, original JavaScript bundle and patch series unchanged; only the generated
per-instance glue factory is added. No release tag is created by building the candidate.

## What works

- Load the web component and backend factory once, and compile the WASM once per service/window.
- Instantiate fresh glue and WASM for every connection attempt, including sign-in retries and reconnects.
- Keep backend classes, heap tables, cached memory views, finalizers and extension objects together per desktop.
- Observe WASM exports for traps, and signal that desktop even if a Rust async task leaves `run()` pending. Close
  that desktop's proxy; the existing bounded reconnect policy creates a fresh backend for that pane. A connection
  that stayed up for 30 seconds resets the backoff even when it ends through an asynchronous trap.
- Release the component, clipboard listeners/loop, video decoder, sound, microphone, file provider, shared drives
  and size observer when an attempt ends. Restore and release the statistics indicator's canvas hook, including
  while the ended desktop and its snapshot remain open. Skip Rust finalizers after a trap.
- Own and cancel the backend's browser timers and event listeners on a trap or normal disposal. Rust cannot do
  that cleanup after an abort; the initial live fault test found three retained heaps through interval callbacks.
- Keep a plain pixel copy of the last frame for the dimmed disconnect screen, while releasing the old component.

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
shutdown, asynchronous traps whose run promises never resolve, stable-connection backoff resets, bounded repeated
faults, and late Rust settlement after a retry or replacement session. Statistics tests cover releasing the canvas
hook on hide/end/replacement, restoring the original drawing method, and rehooking without duplicate frame counts.

The browser smoke script starts isolated headless Chrome with a disposable profile, mounts two actual web components
with distinct backends, closes one, mounts a replacement and closes both. It also mounts a fourth component in the
actual `DesktopSession` class with statistics enabled, ends it, and checks that its WASM memory is collected while
the session, indicator and pixel snapshot remain alive. The DOM-facing application code is compiled from source
into the test page. The script checks component readiness, snapshot pixels and all seven component-owned global
listeners; it makes no RDP connection. Set `CHROME_BIN` to a Chromium executable if it is not installed at the default
macOS Chrome path.

Initial local verification passed: build and typecheck; 484 unit tests (482 passed, two existing Electron-only skips);
factory output identical with the project's and web build's TypeScript parsers. The subsequent lifecycle review
fixes passed build, typecheck and 105 targeted unit tests. Their new regressions reproduced five failures against
the original build before passing with the fixes. Updated headless Chrome smoke passed: four components ready,
seven listeners per component, zero remaining owned listeners, and the ended backend's memory collected with its
session and snapshot retained. These follow-up checks made no live RDP connections.

## Live verification, 2026-10-06

Ran the default Linux suites and additional Windows, xrdp, Windows-host, Hyper-V console, RD Gateway and PTY suites
with the original packed prototype in an isolated Tabby 1.0.236 running under Xvfb on the Linux test VM.
These results precede the 0.5.3-rc.1 integration; candidate verification is recorded separately below.

After fixture repairs and fresh-session reruns, **27 live suites passed**. The remaining suite, direct profiles,
is blocked by the renderer crash described below; the full standard run is therefore not entirely green.

The new `wasm-isolation` suite opens two GNOME accounts on the same host. It checks separate backend classes and
memories, closes/reopens one, then injects three synthetic WASM faults through a benign size getter. Each failed pane
reconnects with fresh memory; the other keeps the same session, UI and proxy and accepts real keyboard events. All
ended and faulted memories are collected after forced GC. Recovery took approximately 1.4, 2.4 and 4.5 seconds, as
the existing bounded reconnect delays increased. The two connected backends used about 19.8 MiB of linear memory
each in this test, compared with 2.0625 MiB idle; this is a single configuration, not a capacity benchmark.

Live coverage includes input, broadcast input and paste, clipboard, files, shared drives, audio, microphone,
graphics, resize, reconnects, credential and certificate retries, desktop editing, discovery and takeover. Windows
H.264 decoded 182 frames on a successful rerun; an initial run received none. GNOME's hardware-only H.264 encoding
was unavailable here. Its ordinary graphics/pixel checks passed.

The first run also exposed a stale desktop-edit test assertion: public main now retains the certificate at the old
address while taking it along to the new one. The live test now checks both entries and their matching metadata.
GNOME input failures (`Failed to add device`) affected cold/long runs of input-related suites; those passed after
restarting the dedicated headless session. xrdp passed with a temporary known password for its test account.

One blocker remains: the direct RDP profile suite crashes the Linux Tabby renderer after its sign-in form is
submitted. The same test reproduces the crash on unmodified public main (`2bede21`), so direct-profile verification
is incomplete. Keychain checks requiring an unlocked keyring, macOS-specific checks and xrdp 0.9's unsupported live
resize are skipped in this environment. Screenshots/demo generation is not part of these verification runs.

Run the additional regression explicitly with a second GNOME account authorized for the test SSH key:

```sh
TRD_TEST_ISOLATION_USER=second-account npm test -- --port <isolated-tabby-cdp-port> wasm-isolation
```

## Candidate verification, 0.5.3-rc.1

After integration onto public main at `153ad9b`, build and application/test typechecks passed. The full unit suite
passed 551 tests, with two existing Electron-only skips and no failures. Release-plan validation routes this RC to
npm `beta` and an unpublished GitHub prerelease draft. The idle benchmark again collected all eight initial
memories and retained none after 32 further create/use/release cycles.

The browser lifecycle smoke passed: four components initialized, seven owned listeners per component, none
remaining after closure, and the ended backend's memory collected while its session and snapshot remained alive.
The smoke's extracted application class now imports the centralized terminal-input adapter added in 0.5.2.

The packed candidate passed 35/35 host checks and 24/24 live GNOME RDP checks on the macOS arm64 Tabby 1.0.238
test binary, which declares xterm 5. The first live isolation run connected the primary account but could not
connect the second account; further diagnosis is pending. Earlier prototype isolation results remain separate
from qualification of this integrated candidate. The isolation suite now reports the failed connection's status
and bounded log instead of continuing with missing backend records.

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

## Before a stable release

- Resolve the direct-profile renderer crash reproduced on public main and complete that suite. Exercise the
  platform-specific checks and unlocked credential stores that this headless Linux setup skips.
- Repeat one-to-eight measurements with connected desktops at representative resolutions, including GPU usage.
- Extend fault tests to active audio/microphone and transfers, checking late callbacks and global error reporting.
  Two connected desktops, repeated controlled faults, input isolation and collection are exercised by the new suite.
- Benchmark the small wrapper on each WASM export call under active keyboard, clipboard and graphics workloads.
- Run the full clean IronRDP vendor rebuild in CI before merging. The generated factory's reproducibility test
  already checks it against the committed public bundle; this prototype does not rerun the Rust toolchain build.

All desktops still share the renderer's thread and process. Separate WASM heaps contain instance faults, but do
not prevent aggregate renderer memory exhaustion or main-thread stalls.
