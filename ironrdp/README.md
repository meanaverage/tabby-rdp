# IronRDP, patched

tabby-rdp's remote desktop is [IronRDP](https://github.com/Devolutions/IronRDP)'s web client (Rust compiled to
WebAssembly, plus its `iron-remote-desktop` web component), bundled in `vendor/`. Released IronRDP connects to
Windows, but not to GNOME Remote Desktop, and its web client has no sound or microphone. The patches here close those gaps. The
fixes among them are meant for upstream, and are submitted there one by one.

`vendor/` is built from IronRDP at [`BASE_COMMIT`](BASE_COMMIT) with the patches in [`patches/`](patches) applied in
order, by `npm run build:ironrdp` ([`scripts/build-ironrdp.sh`](../scripts/build-ironrdp.sh)). `BASE_COMMIT` has to be
one of IronRDP's own commits, in the history of its `master`: GitHub serves a commit from any fork of IronRDP through
IronRDP's address too, so the build checks that before it uses one. The build also writes `vendor/SHA256SUMS`: the
hashes of the base commit, each patch and each file it built, with how and where it was built in comments. The unit
tests check `vendor/` and the series against it on every change, hidden files included; CI rebuilds `vendor/` and
compares every file either side has, byte for byte, when the series, the build or `vendor/` change, and before a
release is staged ([`ironrdp.yml`](../.github/workflows/ironrdp.yml); [below](#reproducing-vendor)). The checks are in
[`scripts/check-vendor.mjs`](../scripts/check-vendor.mjs).

The WebAssembly ships as its own file, `vendor/ironrdp_web_bg.wasm`. Vite's library build inlines it into
`iron-remote-desktop-rdp.js` as a ~7 MB base64 data URL, which supply-chain scanners flag as obfuscated code, so the
build script takes it back out (checking it is byte for byte wasm-pack's output) and points the bundle's default at
the file next to it. The plugin reads the file itself and passes the bytes to `init` (patch 9), since `fetch()` of
`file://` URLs is up to the Electron build.

The local prototype for issue #49 also builds `vendor/ironrdp-factory.js` from that standalone JavaScript bundle,
through [`make-ironrdp-factory.mjs`](../scripts/make-ironrdp-factory.mjs). It parses the bundle's exports and puts its
entire body inside `createBackend(compiledModule, logLevel, logSink?)`: each call owns the wasm-bindgen heap tables, memory
views, classes and finalizers. The web component is registered once and takes that desktop's backend; the compiled
module is shared, the instance is not. The build uses TypeScript's parser from the RDP package's installed build
dependencies. No new Rust patch or WASM rebuild is needed for this factory. See [prototype notes](../docs/wasm-isolation-prototype.md)
for measurements, checks and remaining live tests.

## The patches

| # | Patch | Why | Upstream |
|---|---|---|---|
| 1 | **fix(dvc): drop data for a channel that is not open** | GNOME Remote Desktop sends data on a dynamic channel the client declined (`AUDIO_PLAYBACK_DVC`); IronRDP ended the whole session. | [#2005](https://github.com/Devolutions/IronRDP/pull/2005) |
| 2 | **fix(web): fit the canvas to the host element** | The component sized itself to the browser window. Embedded in anything smaller (a tab pane, a split), it was cropped. | [#2006](https://github.com/Devolutions/IronRDP/pull/2006) |
| 3 | **fix(web): dispatch `ready` after clipboard initialization** | `ready` fired before the clipboard was set up, so a host that connects on `ready` got no clipboard channel at all. | [#2018](https://github.com/Devolutions/IronRDP/pull/2018) |
| 4 | **fix(rdpsnd): echo the Training PDU's `wPackSize`** | The Training Confirm carried the data length instead of the PDU size ([MS-RDPEA] 2.2.3.2). GNOME Remote Desktop checks it and never started sound. | [#2019](https://github.com/Devolutions/IronRDP/pull/2019) |
| 5 | **feat(web): graphics pipeline (EGFX) per connection, following its resets** | GNOME Remote Desktop only speaks the graphics pipeline. A `graphicsPipeline(true)` extension turns it on per connection (off by default, as before), and the canvas follows EGFX ResetGraphics, which is how GNOME answers a resize. | Superseded by [#1977](https://github.com/Devolutions/IronRDP/pull/1977) (not ours), which turns the pipeline on for every connection; drop this patch when it lands |
| 6 | **feat(web): audio playback through an `audioPlayback` callback** | The web client had no sound. An RDPSND backend hands 16-bit PCM to a JavaScript callback; with sound on, a device-less RDPDR is attached too, since Windows only starts playback once RDPDR is up. | [#2020](https://github.com/Devolutions/IronRDP/pull/2020) |
| 7 | **feat(web): microphone redirection (AUDIO_INPUT) through an `audioInput` callback** | The web client couldn't redirect a microphone. With an `audioInput(callback)` extension it advertises audio capture and serves the AUDIO_INPUT channel with `ironrdp-rdpeai`'s client, a fresh one each time the server opens it; the callback hears `open` (the format) and `close`, and JavaScript pushes 16-bit PCM back with `audioInputData`. | Not submitted yet: builds on [#2020](https://github.com/Devolutions/IronRDP/pull/2020) (sound), so it waits for that to land |
| 8 | **feat(web): H.264 in the graphics pipeline, decoded by WebCodecs** | Everything EGFX carried was decoded in WebAssembly. An `h264Decoder` extension advertises the H.264 capability sets (V10.7 down to V10, which Windows needs, and V8.1 with AVC420) and hands the frames to the browser's `VideoDecoder` (`WebCodecsH264Decoder`); ironrdp-egfx gains external decoding (frames applied and acknowledged in order; AVC444 shown as its YUV420 main view) and bitstream fixes for platform decoders (Annex B, an SPS that declares no reordering). What a frame asks to be read back is bounded by its surface (in the order the server created it): regions are clipped to it, overlapping ones are read back once as their bounding box, and nothing beyond the compositor's 256 MiB is read at all; the decoder checks regions against the picture before allocating. | Not submitted yet: builds on patch 5 or [#1977](https://github.com/Devolutions/IronRDP/pull/1977) (the graphics pipeline in the web client), so it waits for that to land |
| 9 | **feat(web): let the host hand `init` the WebAssembly module** | Packaging, for tabby-rdp: `init(logLevel, wasm)` passes `wasm` (URL, bytes or compiled module) to wasm-bindgen's init, so the plugin can load `vendor/ironrdp_web_bg.wasm` itself (below). Without it, nothing changes. | Not for upstream unless they want it |
| 10 | **fix(graphics): read Progressive SRL code words as values need them** | Windows' RemoteFX Progressive upgrade passes failed to decode (a "missing trailing zero byte", then a truncated stream), which ended a Windows session over the graphics pipeline. The SRL decoder read each zero run to its end, past the last value Windows codes; it now reads code words as values need them, as FreeRDP does. | Fixed by [#2010](https://github.com/Devolutions/IronRDP/pull/2010) (not ours), and [#1977](https://github.com/Devolutions/IronRDP/pull/1977) changes the same decoder; drop this patch when either lands |
| 11 | **feat(web): let the host send key events to a session** | A session only takes keys while its canvas has the focus. `sendKeyboardEvent` on the public API is the canvas's own key path, so a host can type into a session that doesn't have it: tabby-rdp's "type into all desktops in this tab". | [#2026](https://github.com/Devolutions/IronRDP/pull/2026) |
| 12 | **fix(web): keep clipboard monitoring and focus writes per component** | The clipboard service stopped monitoring through a module-level "component destroyed" store and queued its focus writes in a module-level queue. With several desktops open, closing one stopped clipboard sync for all of them, and a focus event ran every desktop's queued writes. Each component now owns its loop and its latest pending write; a session's end stops its loop, and a destroyed component stops everything it started. | Not submitted yet |
| 13 | **fix(web): sync the clipboard automatically for the focused session only** | Every open session polled the local clipboard and wrote its server's copies to it, so a desktop open in the background could overwrite a copy made on another. The session whose component has the keyboard focus does the syncing; a remote copy on another waits until it gets the focus. | Not submitted yet: builds on 12 |
| 14 | **fix(web): read H.264 pictures correctly where WebKit ignores copyTo's format** | WebKit (Safari) ignores `copyTo`'s RGBA format and copies NV12, and ignores drawImage's source rectangle for large pictures: remote desktops showed as squashed gray or shrunk copies. The decoder checks `allocationSize` and reads through a canvas, drawing the whole picture shifted. | Not submitted yet: builds on patch 8 |
| 15 | **feat(web): drive redirection through a JavaScript file system** | The web client had no drive redirection. A `driveRedirection(fs)` extension shares folders as drives (MS-RDPEFS): `fs` is a file system the host provides (`stat`, `list`, `open`, `read`, `write`, `truncate`, `close`, `mkdir`, `remove`, `rename`, `volume`, each returning its result or a promise), with the server's paths relative to each drive; Node-style error codes become NT statuses. The SVC processor only queues requests: a worker task serves them one at a time, awaiting the file system, and hands the responses to the session's event loop, so slow file operations don't hold up the page. Directory patterns (the server's) are matched in bounded time. Serves create (every disposition), read, write, directory listing with patterns, basic/standard/volume information, rename, delete and resize. Drive names go to the server as ANSI, which is how Windows reads them (IronRDP sent UTF-16, and Windows showed the first letter). The virtual printer can't share the session with it. | Not submitted yet |
| 16 | **fix(svc): send chunked messages without CHANNEL_FLAG_SHOW_PROTOCOL** | Static-channel messages over one chunk (1600 bytes) were flagged `SHOW_PROTOCOL`, which asks the receiver to hand the channel header to the application; Windows' drive redirector doesn't expect that and dropped the channel on the first chunked read response. mstsc sets the flag only for channels opened with `CHANNEL_OPTION_SHOW_PROTOCOL`; chunks now carry only the flags the message asks for. | Not submitted yet |
| 17 | **perf(web): read H.264 regions that are far apart one by one** | The decoder read a frame's regions back as their bounding box in one call; two small regions in opposite corners made that the whole picture (33 MB for a 4K frame, for eight bytes). When the box holds more than twice what the regions do, each is read on its own, straight into place. | Not submitted yet: builds on patches 8 and 14 |
| 18 | **fix(svc): bound all static channel reassembly paths** | Limit declared and buffered message sizes before allocating, including compressed and unfragmented compatibility messages; grow buffers fallibly and release them on errors. | Not submitted yet |
| 19 | **fix(dvc): bound per-channel and aggregate reassembly** | Reserve each incomplete message's declared size against one aggregate budget, enforce channel-specific limits, and release the reservation on completion, replacement, or close. | Not submitted yet |
| 20 | **fix(web): bound queued drive requests and bytes** | Limit queued and in-flight drive I/O to 1,024 requests and 64 MiB, including an oversized first request; return `STATUS_INSUFFICIENT_RESOURCES` when full. | Not submitted yet |
| 27 | **fix(cliprdr): cap clipboard formats and format names** | Accept at most 1,024 formats and 1,024 code units per name; answer rejected lists with `CB_RESPONSE_FAIL` while allowing the next clipboard update. | Not submitted yet |
| 28 | **fix(web): select clipboard formats in one pass** | Select one text, HTML, and image format in one pass, preserve format preferences, and deduplicate requests. | Not submitted yet |
| 55 | **fix(connector): answer Auto-Detect Requests that come after the connect-time phase** | Windows Server with RDS licensing sends Auto-Detect Requests on the MCS message channel in the middle of the licensing exchange, and again before the Demand Active. IronRDP answered them only in its connect-time auto-detection phase, which the first licensing PDU ends; every later phase decoded them as the PDU it was waiting for, and the connection failed ("invalid security header flags") before the session opened ([#106](https://github.com/meanaverage/tabby-rdp/issues/106)). The message channel is told apart once, ahead of every phase from licensing to connection finalization: an Auto-Detect Request is answered, as mstsc and FreeRDP do, one that doesn't decode is logged and ignored (as connect-time detection always did), anything else there is ignored, and the phase goes on waiting. The log line for an answered request names the phase it came in. As reviewed upstream. | [#2128](https://github.com/Devolutions/IronRDP/pull/2128), for [#1629](https://github.com/Devolutions/IronRDP/issues/1629) |
| 56 | **fix(pdu): keep license keying material and licenses out of Debug output** | The licensing PDUs derived `Debug`, so a log at the debug or trace level printed the premaster secret, the keys, the randoms, the encrypted HWID, the platform challenge and its response, the license itself and the user and machine names, byte by byte. Those print as their length only now (`<48 bytes withheld>`), so a debug log can be handed over; headers, product, scope and error codes stay. The connector also logs the Server License Request at the debug level, so a log shows the whole exchange. For tabby-rdp's diagnostic log ([#106](https://github.com/meanaverage/tabby-rdp/issues/106)). | Not submitted yet |
| 57 | **feat(web): let the host take the log lines** | Packaging, for tabby-rdp: `init(logLevel, wasm, logSink)` hands each log line (level, target, message; no time stamp) to `logSink` in place of the browser console, for the plugin's diagnostic log file. Without one, nothing changes. | Not for upstream unless they want it |
| 58 | **fix(egfx): keep the bitmap cache across ResetGraphics** | Windows repaints a resized desktop from the bitmap cache: the first frame on the surface it creates after `ResetGraphics` is hundreds of `CacheToSurface` pastes of slots filled before the reset (a black 64×64 tile it caches at connect and pastes over the whole new surface to clear it), then it caches regions of the new surface and pastes them along its edges. The compositor cleared the cache on a reset, so those pastes drew nothing: the old picture stayed where the new one should have been cleared, the regions cached from the unpainted surface were black and were pasted as black bars, and the taskbar came out garbled after a live resize ([#115](https://github.com/meanaverage/tabby-rdp/issues/115)). The cache survives the reset, as it does in FreeRDP; one past the protocol's cap is dropped. | [#2011](https://github.com/Devolutions/IronRDP/pull/2011) (merged 2026-10-19), for [#2121](https://github.com/Devolutions/IronRDP/issues/2121) |
| 59 | **fix(graphics): keep Progressive tile state per surface, not per codec context** | Windows moves a surface to a new codec context mid-session, deletes the old one with `DeleteEncodingContext`, and keeps refining the same tiles under the new id. Tile state keyed per codec context made a REGION under the new id that relied on a tile sent earlier in the same frame under the old one paint nothing, and skipped an UPGRADE of such a tile as a first pass: after a live resize, a whole 64-pixel tile column stayed black where the server had cleared the surface ([#115](https://github.com/meanaverage/tabby-rdp/issues/115)). Tile state is now one grid per surface, shared by its codec contexts, and `DeleteEncodingContext` releases nothing (deleting the surface, or a reset, does), as FreeRDP does. Cut down to the keying change on this base, which keeps patch 35's memory accounting. | [#2117](https://github.com/Devolutions/IronRDP/pull/2117) (open) |

Static channels default to 64 MiB per message; clipboard permits 256 MiB and audio/DRDYNVC permit 1 MiB. Dynamic channels default to 64 MiB, with graphics permitting 256 MiB and display/audio-input control permitting 1 MiB. All incomplete dynamic messages together may reserve at most the largest limit of a channel opened in that session. Exceeding a channel or reassembly limit returns a protocol error and ends the session.

Security patch **25 — require nonce-bound CredSSP version 5 or later** rejects legacy server TSRequests before
NTLM AUTHENTICATE or public-key binding is generated, addressing CVE-2018-0886. There is no legacy override.
Offline protocol tests cover versions 2–6. Adapted from the local security candidate; not submitted upstream.

Security patches keep their original candidate numbers so separate release fixes can be combined without renumbering.
Servers offering only CredSSP versions 2–4 must be updated before connecting; TLS certificate acceptance does not bypass this requirement.

Clipboard format lists are limited independently of clipboard content size. Repeated supported formats no longer trigger repeated full-list scans; supported format preference remains MIME HTML over Windows HTML, and PNG over MIME PNG, DIBv5, then DIB.

Drive queue limits include the request currently waiting for the asynchronous filesystem. Dropping a request, completing it, or dropping the queue returns its reservation. Byte accounting uses encoded request size and bounds payloads and paths; fixed per-request overhead is bounded by the request count. A refused close leaves its handle open until session cleanup.

The release security follow-up also applies patches 31–42 and 52:

| # | Patch | Effect |
|---|---|---|
| 31 | Bound Planar images and validate compressed size | At most 8192 pixels per edge; allocate planes and output fallibly after validating the input. |
| 32 | Stream ClearCodec bands | Decode one V-bar at a time without expanding an intermediate object list. |
| 33–34 | Bound pointer decoding and caching | At most 384×384 pixels and the advertised 32 cache slots. |
| 35–37 | Budget Progressive state and stream its blocks | Bound retained contexts/references and decoded tiles; avoid collecting a whole message. |
| 38–41 | Bound ClearCodec working memory and paint work | Fallible image allocation, in-place channel conversion, incremental residual/RLEX/subcodec decoding, row-sized NSCodec buffers, and a cumulative paint budget. |
| 42 | Keep oversized surfaces out of client state | Reject unsupported dimensions before recording them or decoding their content. |
| 52 | Tighten Progressive history and allocation failures | A 512 MiB retained-history budget; fallible pointer and tile-grid buffers with allocation-failure tests. |

These limits reject or skip graphics that exceed the client's supported resource budget.
The Progressive history budget supports one 8K or four 4K displays; larger combinations can exceed it.
The limits apply per session, so opening several sessions still adds their memory use.
The focused tests cover boundary acceptance/rejection, cache replacement and cleanup, bounded peak allocations,
and injected allocation failures without a live server.

The release security follow-up also applies patches 43–51 and 53–54:

| # | Patch | Effect |
|---|---|---|
| 43 | Bound H.264 regions | Limit AVC metadata and bound the regions sent to an external decoder. |
| 44 | Budget queued EGFX work | At most 65,536 waiting commands and 512 MiB of retained commands, access units and completed pixels; constant-time completion membership checks. |
| 45–46 | Process messages incrementally and bound frame acknowledgements | Avoid a whole-message vector of decoded commands; acknowledge at most 65,536 frames per message. |
| 47 | Bound browser decoder input | At most 256 pending frames per decoder and 128 MiB of pending access units across decoders. |
| 48 | Close ended streams and bound decoders | At most 32 active/retiring decoders; surface recreation, deletion and reset end streams. |
| 49–50 | Bound picture readbacks | At most 512 MiB of requested pixels in concurrent readbacks; iterative rectangle bounds. |
| 51 | Limit decoder creation rate | Per-surface and aggregate token buckets prevent repeated construction from monopolizing the renderer. |
| 53 | Complete lifecycle and callback budgets | At most 64 concurrent readbacks, 64 Mi pixels per decoded picture, 128 Mi coded pixels retained across asynchronous readbacks and 256 MiB of decoded pixel events before copying to WASM; close retained pictures on failure/close and ignore late callbacks; immediately deliver stream endings without waiting for another frame; keep the fallback canvas sized to its current rectangle. |
| 54 | Integrate the host's decoder policy | A validated public `maxDecoders` option counts active and retiring decoders together; Tabby sets 16. Delta frames cannot construct a decoder; a bounded first-key-frame wait map is cleared on stream endings, failure and close. |

The plugin passes the original decoder object through to IronRDP, including its `endSurfaces` method and statistics.
It no longer evicts surfaces or changes the decoder's private queues and counters. Exceeding a decoder budget ends
that session with an error and allows the plugin's existing reconnect-without-H.264 path; it does not silently evict
an active or retiring stream to admit another. The maximum in patch 48 remains 32 by default for other consumers;
the plugin's configured limit is 16 including retirement.
If all 16 slots are still draining during a reset, admitting a replacement before they finish also reaches the cap
and takes that fallback path; the limit is not a promise of 16 displays plus additional retiring streams.
Readback byte accounting covers requested pixel buffers independently of the full decoded pictures retained during
asynchronous copying. The coded-picture limit is 512 MiB at four bytes per pixel; it is not a total renderer limit.
The picture, output-buffer, Rust event and command budgets are independently additive; bounded temporary copies and
browser decoder internals also consume memory, and limits are per session.
The focused tests use a browser decoder stand-in to cover stalled output, independent streams, cleanup, budget
boundaries and recovery of budget after work completes.

Each patch carries its own tests where IronRDP has a place for them (`ironrdp-testsuite-core`, the patched crate, the
web packages' vitest suites), and CI runs them: the web component's on every change (`ci.yml`), the Rust crates' and
the RDP package's when the series changes and before a release (`ironrdp.yml`). Left out there, each by its exact name:
one of IronRDP's own tests (`rdpdr::filesystem_drive_announce_encodes_unicode_data_and_valid_dos_name`), which expects
drive names in UTF-16, which patch 15 changes to ANSI on purpose; and the 19 of IronRDP's
`ironrdp-web` clipboard tests that call into JavaScript, which only a browser has. The module's other clipboard tests
run, and so does any a patch adds, so a patch's test that needs a browser fails there until it is added to that list.

## Working on them

```sh
npm run build:ironrdp            # clone (first time) into .ironrdp/, apply the series, build, copy into vendor/
```

The checkout in `.ironrdp/` is reset to `BASE_COMMIT` on every build. To change the series, work on a branch there
and export it again:

```sh
cd .ironrdp
git checkout -b work "$(cat ../ironrdp/BASE_COMMIT)"
git am ../ironrdp/patches/*.patch
# ...edit, test (as CI does: cargo test --lib --tests -p ironrdp-testsuite-core -p <each crate you change>;
#    npm test in web-client/iron-remote-desktop, and in web-client/iron-remote-desktop-rdp after a build), commit...
rm ../ironrdp/patches/*.patch
git format-patch --no-signature --zero-commit -o ../ironrdp/patches "$(cat ../ironrdp/BASE_COMMIT)"..work
cd .. && npm run build:ironrdp
```

Moving to a newer IronRDP: rebase that branch onto the new commit, drop the patches upstream has merged, update
`BASE_COMMIT`, and export as above.

The build pins IronRDP's Rust toolchain and remaps local paths, so no paths from the build machine end up in the
WebAssembly.

## Reproducing vendor/

The same base commit and patches build to the same files, byte for byte, wherever the checkout is, given the same
tools and **the same kind of machine**. The build fixes the tools it can:

- Rust: the toolchain IronRDP's `rust-toolchain.toml` names, whatever `RUSTUP_TOOLCHAIN` says, and IronRDP's crates as
  its `Cargo.lock` has them (`--locked`).
- wasm-pack 0.15.0, installed with its own lock file when the one on PATH is another version.
- wasm-bindgen at the version IronRDP's `Cargo.lock` names, built with its own lock file into the IronRDP checkout's
  `target/tools`, where wasm-pack takes it from; a marker there (`wasm-bindgen.locked`) says it was built that way, and
  one of the right version without it is built again. (Left to itself, wasm-pack downloads a prebuilt one, unchecked,
  or on an Apple Silicon Mac, where it has none, builds it with cargo from whatever releases of its dependencies are
  newest that day.)
- binaryen's `wasm-opt`, version_117 (wasm-pack 0.15.0's): on an Apple Silicon Mac, the release's `bin/wasm-opt` and
  `lib/libbinaryen.dylib` are downloaded into `target/tools` too, and checked against their SHA-256 before they run.
  They are all that is kept of the release, in a folder of their own that is held to nothing else being in it (also
  when an earlier run left it), since its `bin/` goes ahead on PATH. (wasm-pack would download them without checking.)
- The web packages' dependencies, as their lock files have them (`npm ci`).

Node.js is not among them: the bundles come out the same with Node.js 20, 22 and 26 (checked with 20.18.0, 22.22.2
and 26.8.2), so CI builds with Node.js 22. Its version is in the comments of `vendor/SHA256SUMS`, which no check reads.

Cargo mixes the build machine's platform into what it compiles, so a Linux build of these sources is not the same bytes
as a Mac's. Rebuilt on a Mac from a fresh checkout and an empty target directory, `vendor/` came out identical; with
nothing changed but the platform rustc reported to cargo (aarch64-apple-darwin, made to say x86_64-unknown-linux-gnu),
`ironrdp_web_bg.wasm` and the JavaScript bundle around it came out different. So `vendor/` is built on an Apple Silicon
Mac, and CI rebuilds it on one (`macos-latest`). The build says so when it runs anywhere else.

To confirm a build:

- On your Mac: `npm run build:ironrdp` from a clean checkout, then `node scripts/check-vendor.mjs rebuilt`, which
  compares `vendor/` with the commit as CI does. (`git status vendor/` can show `vendor/SHA256SUMS` changed for its
  comments alone: they name the Node.js and Rust that built it.)
- On a clean machine: **Actions › IronRDP › Run workflow** on the branch. The run's summary lists each file's
  committed and rebuilt SHA-256.

When CI's rebuild differs, the run keeps what it built (`gh run download <run-id> -n vendor-rebuilt`). Compare it with
yours (`cmp`; `git diff --no-index` for the JavaScript); the comments in each `SHA256SUMS` say what built it. Find what
made the difference, and if it is the build rather than the sources (a tool at another version, say), pin it in the
build. Then commit only a build that a maintainer's Mac and CI both make. Never commit CI's `vendor-rebuilt` for a
difference nobody has explained: that is the build CI would vouch for from then on.

## Known advisories

- **rsa 0.10.0-rc.18**, [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071) (the Marvin attack):
  its RSA private-key operations take time that depends on their input, so someone who can time many of them on
  inputs of their choosing can recover the key. No fixed release exists. The WebAssembly links it through sspi, picky
  and winscard, for CredSSP's smart-card and PKU2U sign-in. tabby-rdp is not exposed: it never holds an RSA private
  key. The web client signs in with a user name and password only (`Credentials::UsernamePassword` is the only kind
  `ironrdp-web` builds), so the code that would use one never runs. CredSSP binds the sign-in to the server's public key
  with the NTLM or Kerberos session key, not with RSA. RDP licensing uses IronRDP's own public-key code (num-bigint),
  not this crate. Rebuild `vendor/` once IronRDP moves to a fixed release. (`cargo audit` in `.ironrdp/` lists the
  advisories that apply to the lock file; `cargo tree -p ironrdp-web --target wasm32-unknown-unknown -i rsa` shows where
  the crate comes from.)

[MS-RDPEA]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/
