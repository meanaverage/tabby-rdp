# FreeRDP preview

Settings › Remote Desktop › Settings › **RDP client** selects the default client. RDP profiles and the add/edit
desktop form have an override. An empty override follows Settings. Existing configurations continue to use IronRDP.
Changes apply on the next connection; use Reconnect to compare clients on the same desktop. Accounts, certificate
trust and desktop identities are shared between the clients.

An RDP profile tab's ellipsis/right-click menu also has **RDP client**: **Follow default**, **IronRDP**, or
**FreeRDP (experimental)**. The checkmark shows the saved next-connection choice; **Current session** names the
client already running. Changing the choice offers **Reconnect to apply** or **Keep current session**, without
disconnecting automatically. A saved profile keeps its override; an unsaved quick connection keeps it in that tab.

The initial FreeRDP preview renders inside the Tabby tab and supports keyboard, mouse, Unicode input, view only,
screenshots, scaling, reconnect and the display-control channel. It uses the plugin's existing direct, SSH and RD
Gateway transports, credential store and certificate/NLA prompts. Each attempt has its own native process.

The preview does **not** yet implement clipboard, audio playback/capture, shared folders, or Hyper-V VMConnect.
The supplied build uses native bitmap decoding (and the graphics pipeline for GNOME), with optional H.264 codecs
disabled. The macOS/Linux builds omit Kerberos/GSSAPI and use NTLM. Windows can use native SSPI; Kerberos and domain-policy behavior are not qualified. Hyper-V consoles that
inherit the global client setting continue to use IronRDP. A synced global FreeRDP default also uses IronRDP on a computer without its native helper; an explicit desktop/profile choice still reports the missing build. It has not been benchmarked against IronRDP on Windows Server. Native decoding alone does not establish
that this implementation will be faster: the cost of transferring pixels to the canvas also matters.

## Build

Build on each intended OS and CPU architecture. Requires Node 18+, CMake, a C compiler and an OpenSSL 3 development
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

No native executable is downloaded or compiled when Tabby loads the plugin. An explicit FreeRDP choice without the matching
helper produces an installation message before asking for credentials. A global default can be shared across computers:
when only that default requests an unavailable helper, the connection uses IronRDP and records the fallback in its log.

`native/bin` is generated and ignored by Git, but included by `npm run pack:release` when present. For a public release, qualify
each intended platform/architecture and explicitly include the reviewed native outputs in the release commit
(`git add -f native/bin/<platform>-<arch>`). The existing package checks require distributed files to match the
release commit. A build on one computer supplies only that computer's platform/architecture.

Release packages include macOS ARM64, Windows ARM64/x64 and Linux ARM64/x64 helpers. FreeRDP helpers for Intel Macs
are not yet available; IronRDP remains available there.

## Licensing

The Tabby helper is MIT licensed. FreeRDP and WinPR are Apache-2.0; OpenSSL 3 is Apache-2.0. Their full licenses and
FreeRDP's bundled attribution notice accompany the generated binaries. WinPR's built-in Unicode converter also
carries its own full `Unicode-NOTICE`. Keep all these notices in the published package.
The source/build identity is recorded in `BUILD.json`. New codecs, channels or native dependencies require reviewing
their own licensing and updating the packaging inventory; changing FreeRDP's top-level license file is insufficient.

## Verification

```sh
npm run typecheck
npm run test:unit
npm test -- --hidden visual-smoke
# With TRD_TEST_DIRECT, TRD_TEST_DIRECT_USER and TRD_TEST_DIRECT_PASSWORD for a dedicated server:
npm test -- --hidden freerdp
# Verify the installed tarball as well, including executable permissions and relocated native libraries:
npm test -- --packed --hidden freerdp
```

The FreeRDP unit tests run framing, bounds, keyboard and authenticated-relay tests on every platform. When the
helper exists, they additionally run real native TLS/NLA certificate-rejection tests, verifying that no username
routing cookie or authentication payload reaches a rejected peer. Real Windows Server performance and feature
qualification require a dedicated test machine; these local protocol tests do not substitute for that work.

The native protocol/security suite passes on macOS ARM64, Windows ARM64/x64 and Linux ARM64/x64. It exercises
certificate/name/NLA rejection before credentials, the same CredSSP minimum version (5) as IronRDP, large trust stores, relay authentication, IPC and build inventories.

| Client | Live Windows Server 2025 coverage |
|---|---|
| macOS ARM64 | Earlier packed-plugin lifecycle coverage; current native protocol/security checks passed. |
| Linux ARM64, Ubuntu 24.04 | Packed plugin: pixels, input routing, larger/smaller live resize without reconnecting, fixed-resolution fitting, view only, cleanup, reconnect, switching to IronRDP, input-burst recovery and Automatic header/reconnect stability with both clients. |
| Windows ARM64, Windows 11 | Same packed-plugin lifecycle coverage as Linux ARM64. |
| Linux x64 / Windows x64 | Native protocol/security checks in hosted CI; live RDP qualification remains pending. |

Linux binaries are built on Ubuntu 22.04; they require a compatible glibc-based system. These are functional checks,
not performance benchmarks or qualification of every supported remote server, channel and authentication policy.
