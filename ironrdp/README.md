# IronRDP, patched

tabby-rdp's remote desktop is [IronRDP](https://github.com/Devolutions/IronRDP)'s web client (Rust compiled to
WebAssembly, plus its `iron-remote-desktop` web component), bundled in `vendor/`. Released IronRDP connects to
Windows, but not to GNOME Remote Desktop, and its web client has no sound or microphone. The patches here close those gaps. The
fixes among them are meant for upstream, and are submitted there one by one.

`vendor/` is built from IronRDP at [`BASE_COMMIT`](BASE_COMMIT) with the patches in [`patches/`](patches) applied in
order, by `npm run build:ironrdp` ([`scripts/build-ironrdp.sh`](../scripts/build-ironrdp.sh)).

The WebAssembly ships as its own file, `vendor/ironrdp_web_bg.wasm`. Vite's library build inlines it into
`iron-remote-desktop-rdp.js` as a ~7 MB base64 data URL, which supply-chain scanners flag as obfuscated code, so the
build script takes it back out (checking it is byte for byte wasm-pack's output) and points the bundle's default at
the file next to it. The plugin reads the file itself and passes the bytes to `init` (patch 9), since `fetch()` of
`file://` URLs is up to the Electron build.

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
| 15 | **feat(web): drive redirection through a JavaScript file system** | The web client had no drive redirection. A `driveRedirection(fs)` extension shares folders as drives (MS-RDPEFS): `fs` is a synchronous file system the host provides (`stat`, `list`, `open`, `read`, `write`, `truncate`, `close`, `mkdir`, `remove`, `rename`, `volume`), with the server's paths relative to each drive; Node-style error codes become NT statuses. Serves create (every disposition), read, write, directory listing with patterns, basic/standard/volume information, rename, delete and resize. Drive names go to the server as ANSI, which is how Windows reads them (IronRDP sent UTF-16, and Windows showed the first letter). The virtual printer can't share the session with it. | Not submitted yet |
| 16 | **fix(svc): send chunked messages without CHANNEL_FLAG_SHOW_PROTOCOL** | Static-channel messages over one chunk (1600 bytes) were flagged `SHOW_PROTOCOL`, which asks the receiver to hand the channel header to the application; Windows' drive redirector doesn't expect that and dropped the channel on the first chunked read response. mstsc sets the flag only for channels opened with `CHANNEL_OPTION_SHOW_PROTOCOL`; chunks now carry only the flags the message asks for. | Not submitted yet |

Each patch carries its own tests where IronRDP has a place for them (`ironrdp-testsuite-core`, the web component's
vitest suite).

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
# ...edit, test (cargo test -p ironrdp-testsuite-core; npm test in web-client/iron-remote-desktop), commit...
rm ../ironrdp/patches/*.patch
git format-patch --no-signature --zero-commit -o ../ironrdp/patches "$(cat ../ironrdp/BASE_COMMIT)"..work
cd .. && npm run build:ironrdp
```

Moving to a newer IronRDP: rebase that branch onto the new commit, drop the patches upstream has merged, update
`BASE_COMMIT`, and export as above.

The build pins IronRDP's Rust toolchain and remaps local paths, so no paths from the build machine end up in the
WebAssembly.

[MS-RDPEA]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/
