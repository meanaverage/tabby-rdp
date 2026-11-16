# FreeRDP preview

Settings › Remote Desktop › Settings › **RDP client** selects the default client. RDP profiles and the add/edit
desktop form have an override. An empty override follows Settings. IronRDP remains the default. Existing FreeRDP selections use the bundled WebAssembly build on reconnect; `freerdp-wasm` is accepted as an alias for `freerdp`.
Changes apply on the next connection; use Reconnect to compare clients on the same desktop. Accounts, certificate
trust and desktop identities are shared between the clients.

**Settings › Remote Desktop › Settings › FreeRDP compatibility** groups three independent options:

| Option | Default | Use |
|---|---|---|
| Glyph caching (experimental) | Off | Older RDP servers or PAM login screens that send text as cached glyphs. May cause display artifacts; enable only for connections that need it. |
| Bitmap caching (experimental) | Off | Servers or PAM login screens that draw pictures, such as a logo, from cached bitmaps. May cause display artifacts; enable only for connections that need it. |
| Relax drawing order checks | Off | Servers or PAM proxies that send orders the client did not announce. Useful when the native log reports an unannounced order. |

Each RDP profile or configured desktop can follow Settings, enable any of these options, or explicitly disable it.
Changes apply on the next FreeRDP connection. IronRDP uses its own graphics capabilities.

An RDP profile tab's ellipsis/right-click menu also has **RDP client**: **Follow default**, **IronRDP**, or
**FreeRDP WebAssembly (experimental)**. The checkmark shows the saved next-connection choice; **Current session** names the
client already running. Changing the choice offers **Reconnect to apply** or **Keep current session**, without
disconnecting automatically. A saved profile keeps its override; an unsaved quick connection keeps it in that tab.

The initial FreeRDP preview renders inside the Tabby tab and supports keyboard, mouse, Unicode input, view only,
screenshots, scaling, reconnect and the display-control channel. It uses the plugin's existing direct, SSH and RD
Gateway transports, credential store and certificate/NLA prompts. Each FreeRDP attempt has its own Electron utility process.

FreeRDP shares clipboard **text and files/folders** the ways the clipboard setting allows (both ways, only from the remote desktop, or
off, which leaves the clipboard channel out); in view only, no clipboard goes either way. It does **not** yet implement pictures on the clipboard, audio
playback/capture, shared folders, or Hyper-V VMConnect.
The supplied FreeRDP 3.33.1 build uses bitmap decoding (and the graphics pipeline for GNOME), with optional H.264
codecs disabled. Authentication uses NTLM on every platform; Windows SSPI, Kerberos and domain-policy behavior
are not qualified. Hyper-V consoles that inherit the global client setting continue to use IronRDP.

This is FreeRDP's core compiled to WebAssembly with Tabby's adapter and canvas. It is not FreeRDP's separate SDL/browser
client. The bracketed PAM username handling, TLS-only consent, caching options and opaque desktop pixels are shared
with the earlier native integration. Synthetic tests cannot qualify a particular PAM appliance, MFA flow or policy.

## Native comparison build

Native builds are retained for development and benchmarks, not published as dependencies. Build on each intended OS and CPU architecture. Requires Node 18+, CMake, a C compiler and an OpenSSL 3 development
installation with its license text. macOS also needs Xcode command-line tools; Linux needs `patchelf`; Windows
needs Visual Studio C++ build tools (including `dumpbin`), Perl and Ninja for the target architecture.

```sh
npm run build:freerdp -- --openssl-prefix /path/to/openssl3
npm run build
```

For native Windows and Linux builds, `node scripts/build-freerdp-ci.mjs` builds the OpenSSL version and SHA-256 in
`openssl-source.json`, then FreeRDP, and produces a tar archive with executable modes preserved. The
[FreeRDP native builds workflow](../.github/workflows/freerdp.yml) runs this on ARM64 and x64 for both systems, with real native certificate/security checks.
Windows OpenSSL currently builds without assembly optimizations; these functional builds do not establish performance.

On macOS, omitting `--openssl-prefix` uses `brew --prefix openssl@3`. Additional arguments are passed directly to
CMake, e.g. `-DCMAKE_TOOLCHAIN_FILE=/path/to/vcpkg.cmake`. Build from this repository checkout; an installed npm
package does not contain the build tools or native source.

The script downloads the source archive identified by `freerdp-source.json`, verifies its pinned SHA-256, and builds
an unmodified FreeRDP with `options.cmake`. Build tools and source stay under `.qa/freerdp-build`. The output is
`native/bin/<platform>-<arch>/`, including the helper, its FreeRDP/WinPR/OpenSSL libraries and NTLM's required OpenSSL
legacy provider, license notices and a
`BUILD.json` with source identity and artifact hashes. macOS libraries are relocated beside the executable and signed
ad hoc; the helper does not depend on a user's Homebrew directory. Linux builds require a compatible target distro's
system ABI; Windows requires the applicable Microsoft C runtime. Builds for other platforms are independent.

Windows helpers require the matching Microsoft Visual C++ Redistributable, as described in the
[requirements](../docs/compatibility.md#requirements). The plugin does not install it automatically.

The native comparison build records its sources, binary hashes and licenses in `native/bin/<platform>/BUILD.json`.
These developer artifacts are not published as part of package format 6. The plugin includes portable FreeRDP
WebAssembly and the existing platform-specific Go network helpers used by IronRDP.

## WebAssembly build

The selectable WebAssembly client compiles the same windowless Tabby adapter and upstream FreeRDP/WinPR to WASM.
It does not embed the upstream SDL browser interface. Emscripten pthreads run in an isolated Electron utility process;
a loopback WebSocket bridge carries the existing authenticated direct, SSH or RD Gateway transport. No remote proxy
service is required. It shares native FreeRDP's certificate/NLA policy, canvas, input and clipboard controls.
IronRDP remains the default. See the comparison methodology in [the performance fixture](../test/fixtures/performance/README.md).

Requires Git, Node, CMake, Ninja and Emscripten, with the toolchain commit/version pinned in `wasm-source.json`:

```sh
git clone https://github.com/emscripten-core/emsdk.git .qa/emsdk
git -C .qa/emsdk checkout 35ff8a6d150541276abbc6bae512ca90bcfbe220
.qa/emsdk/emsdk install 6.0.12
.qa/emsdk/emsdk activate 6.0.12
npm run build:freerdp:wasm
npm run build
```

Alternatively set `EMSDK` to an installation of that version. The script verifies the FreeRDP, LibreSSL and zlib
source archives, builds static WASM libraries, and records source/artifact hashes in `wasm/freerdp/BUILD.json`.
The portable output and licenses are committed and included in the plugin package. It never downloads a compiler
or builds at connection time. Native comparison binaries are not published with the plugin.

## Licensing

The Tabby helper is MIT licensed. FreeRDP and WinPR are Apache-2.0; OpenSSL 3 is Apache-2.0. Their full licenses and
FreeRDP's bundled attribution notice accompany the generated binaries. WinPR's built-in Unicode converter also
carries its own full `Unicode-NOTICE`. Keep these notices with native comparison artifacts.
The WebAssembly bundle additionally includes LibreSSL, zlib and Emscripten license/attribution files in
`wasm/freerdp/licenses`. Keep those files with the WASM and JavaScript artifacts.
The source/build identity is recorded in `BUILD.json`. New codecs, channels or native dependencies require reviewing
their own licensing and updating the packaging inventory; changing FreeRDP's top-level license file is insufficient.

## Verification

FreeRDP 3.33.1 native protocol/security and clipboard callback checks pass on macOS ARM64, Linux ARM64/x64 and
Windows ARM64/x64. The WASM protocol/security checks pass on macOS ARM64 and Linux x64. Packaged native and WASM
clients also pass TLS policy, process restart/cleanup and canvas checks inside Tabby on macOS ARM64, Linux x64 and
Windows x64. These hosted checks use synthetic peers and need no private RDP server.

On macOS ARM64, both clients pass live Windows Server 2022 clipboard tests: nested-folder and empty-file downloads,
binary contents, folder uploads with a 2 MiB file verified by SHA-256, drag/drop, Finder folder paste with Command-V,
and Save to Downloads with preserved paths. Windows Server 2025 x64 also passes all 36 applicable packed WASM lifecycle checks against Windows Server 2022,
including text, file/folder upload and download, resize, reconnect and cleanup. Live Linux file-transfer qualification
and Windows Explorer file paste remain pending. The older qualification below does not qualify the new builds.

```sh
npm run typecheck
npm run test:unit
TRD_TEST_FREERDP_RUNTIME=wasm node --import tsx --test test/unit/freerdp.ts
npm test -- --hidden visual-smoke
# With TRD_TEST_DIRECT, TRD_TEST_DIRECT_USER and TRD_TEST_DIRECT_PASSWORD for a dedicated server:
npm test -- --hidden freerdp
# Verify the installed plugin package as well:
npm test -- --packed --hidden freerdp
```

The FreeRDP unit tests run framing, bounds, keyboard and authenticated-relay tests on every platform. When the
helper exists, they additionally run real native TLS/NLA certificate-rejection tests, verifying that no username
routing cookie or authentication payload reaches a rejected peer. Real Windows Server performance and feature
qualification require a dedicated test machine; these local protocol tests do not substitute for that work.

With FreeRDP 3.33.0, the native protocol/security suite passes on macOS ARM64, Windows ARM64/x64 and Linux ARM64/x64. It exercises
certificate/name/NLA rejection before credentials, the same CredSSP minimum version (5) as IronRDP, large trust stores, relay authentication, IPC and build inventories.

On macOS ARM64, synthetic TLS RDP connections with cached bitmap updates verify opaque colors, zero-alpha colors,
omitted alpha and genuine black pixels through the native helper and Tabby's canvas. These checks reproduce the
alpha rendering problem without a PAM server; they do not qualify a real Senhasegura connection.

The packaged FreeRDP 3.33.0 client on macOS ARM64 passes all 31 lifecycle checks against Windows Server 2022 x64:
desktop pixels, keyboard routing, live resize, input-burst recovery, view only, cleanup, cache-mode reconnects,
clipboard text in both directions and paste-to-all, switching to IronRDP, and Automatic header/reconnect stability.
The Windows Server 2025 coverage below predates the 3.33.0 upgrade.

| Client | Live Windows Server 2025 coverage |
|---|---|
| macOS ARM64 | Earlier packed-plugin lifecycle coverage; current native protocol/security checks passed. |
| Linux ARM64, Ubuntu 24.04 | Packed plugin: pixels, input routing, larger/smaller live resize without reconnecting, fixed-resolution fitting, view only, cleanup, reconnect, switching to IronRDP, input-burst recovery and Automatic header/reconnect stability with both clients. |
| Windows ARM64, Windows 11 | Same packed-plugin lifecycle coverage as Linux ARM64. |
| Linux x64 / Windows x64 | Native protocol/security checks in hosted CI; live RDP qualification remains pending. |

Linux binaries are built on Ubuntu 22.04; they require a compatible glibc-based system. These are functional checks,
not performance benchmarks or qualification of every supported remote server, channel and authentication policy.
