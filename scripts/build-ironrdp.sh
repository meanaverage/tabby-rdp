#!/bin/sh
# Rebuilds vendor/iron-remote-desktop*.js and vendor/ironrdp_web_bg.wasm: IronRDP at ironrdp/BASE_COMMIT with
# ironrdp/patches/*.patch applied in order (see ironrdp/README.md). vendor/SHA256SUMS records what they were built
# from and their hashes; the unit tests check vendor/ against it, and CI rebuilds vendor/ and compares
# (.github/workflows/ironrdp.yml, with scripts/check-vendor.mjs).
#
# Needs git, curl, rustup and Node.js (npm). The Rust toolchain IronRDP pins, the wasm32 target and wasm-pack are
# installed if missing; wasm-bindgen and, on an Apple Silicon Mac, binaryen's wasm-opt in the checkout's target/tools.
# All of them at the versions below or in IronRDP's Cargo.lock: other versions build other bytes.
#
# The IronRDP checkout lives in .ironrdp/ (or $IRONRDP_SRC). It is reset to the base commit on every run, so keep
# any work of your own there on a branch.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${IRONRDP_SRC:-$ROOT/.ironrdp}"
UPSTREAM=https://github.com/Devolutions/IronRDP.git
COMMIT="$(cat "$ROOT/ironrdp/BASE_COMMIT")"
WASM_PACK_VERSION=0.15.0
# binaryen's release that wasm-pack 0.15.0 optimizes with, and the SHA-256 of the two files of it that are kept and run
# (the rest of the release is left out): wasm-pack would download it without checking anything.
WASM_OPT_VERSION=117
WASM_OPT_SHA256=e541f303219f9b6caa1661daea44510249da278736b7f2e320910051e7bbd4cd
LIBBINARYEN_SHA256=9dc88d02f1aa84de40a8e8dbe5f3a023a8b5bcafaf1308ae20926ab425c533fb
case "$(uname -s) $(uname -m)" in
"Darwin arm64") ;;
*) echo "Note: vendor/ is built on an Apple Silicon Mac. Built here, the WebAssembly and the bundle around it come out" >&2
   echo "different (ironrdp/README.md, \"Reproducing vendor/\"), so don't commit what this build writes into vendor/." >&2 ;;
esac

# IronRDP's own commit: GitHub serves a commit from any fork of IronRDP through IronRDP's address too, so that it can
# be fetched from there doesn't make it IronRDP's.
node "$ROOT/scripts/check-vendor.mjs" base
if [ ! -d "$SRC/.git" ]; then
    git clone "$UPSTREAM" "$SRC"
fi
cd "$SRC"
git cat-file -e "$COMMIT^{commit}" 2>/dev/null || git fetch --quiet "$UPSTREAM" "$COMMIT"
git checkout --quiet --force --detach "$COMMIT"
git clean -fdq -e target -e node_modules
for patch in "$ROOT"/ironrdp/patches/*.patch; do
    git apply --whitespace=nowarn "$patch"
done

# The toolchain IronRDP pins (rust-toolchain.toml), whatever RUSTUP_TOOLCHAIN says, and explicitly: a Rust earlier on
# PATH (e.g. Homebrew's) or an older rustup could build with another one, and that builds other bytes.
RUSTUP_TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml)"
PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
# IronRDP's own wasm flags (.cargo/config.toml), plus: keep this machine's paths (cargo registry, checkout) out of
# the panic messages compiled into the WebAssembly.
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$SRC=/ironrdp"
export RUSTUP_TOOLCHAIN PATH CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS
# Either would replace the flags above.
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

# Explicitly: not every rustup installs a missing toolchain on first use.
rustup toolchain list | grep "^$RUSTUP_TOOLCHAIN-" >/dev/null || rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
rustup target list --installed | grep -x wasm32-unknown-unknown >/dev/null || rustup target add wasm32-unknown-unknown
# The version, not just a wasm-pack: another one on PATH builds differently.
if [ "$(wasm-pack --version 2>/dev/null)" != "wasm-pack $WASM_PACK_VERSION" ]; then
    cargo install --locked wasm-pack --version "$WASM_PACK_VERSION"
    hash -r
    if [ "$(wasm-pack --version)" != "wasm-pack $WASM_PACK_VERSION" ]; then
        echo "wasm-pack $WASM_PACK_VERSION was installed, but the one on PATH is $(command -v wasm-pack) ($(wasm-pack --version))" >&2
        exit 1
    fi
fi

# wasm-bindgen at the version in IronRDP's Cargo.lock, built from its own lock file (--locked) and ahead on PATH, where
# wasm-pack takes it. wasm-pack would otherwise download a prebuilt one, unchecked, or, where it has none (an Apple
# Silicon Mac), build it with cargo from whatever releases of its dependencies are newest that day, any of which can
# change what it writes.
BINDGEN_VERSION="$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"$/\1/p;}' Cargo.lock)"
TOOLS="$SRC/target/tools"
# The marker says the one in $TOOLS/bin was installed here with --locked, by its version and its SHA-256: one of the
# same version installed without the lock file (by an earlier run of another script, or by hand, also over one this
# installed) is built from other releases of its dependencies, and is installed again. It is removed before the install,
# so that one that stops half way leaves none.
sha256 () {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi
}
locked () {
    [ -f "$TOOLS/bin/wasm-bindgen" ] &&
        [ "$(cat "$TOOLS/wasm-bindgen.locked" 2>/dev/null)" = "$BINDGEN_VERSION $(sha256 < "$TOOLS/bin/wasm-bindgen")" ]
}
if [ "$("$TOOLS/bin/wasm-bindgen" --version 2>/dev/null)" != "wasm-bindgen $BINDGEN_VERSION" ] || ! locked; then
    rm -f "$TOOLS/wasm-bindgen.locked"
    cargo install --locked --force --root "$TOOLS" wasm-bindgen-cli --version "$BINDGEN_VERSION"
    echo "$BINDGEN_VERSION $(sha256 < "$TOOLS/bin/wasm-bindgen")" > "$TOOLS/wasm-bindgen.locked"
fi
PATH="$TOOLS/bin:$PATH"

# binaryen's wasm-opt, which wasm-pack runs over the WebAssembly. On an Apple Silicon Mac, where vendor/ is built,
# version_117's release, downloaded and checked here and ahead on PATH, where wasm-pack takes it; elsewhere, what
# wasm-pack downloads. Only wasm-opt and the library it loads (found at ../lib) are kept, in a folder of their own, and
# the folder is held to nothing else being in it, however it came to be there (this is checked of one found in
# target/tools as well): its bin/ goes ahead on PATH, so whatever else it held (a release has more, and a changed
# archive could carry any program, wasm-pack and node among them) would run in place of the real one.
binaryen () {
    # What is in it, listed in full: a listing that fails (a folder that can't be read) fails the check.
    [ -d "$1" ] && [ ! -L "$1" ] && found="$(cd "$1" && find . -mindepth 1)" &&
        [ "$(printf '%s\n' "$found" | LC_ALL=C sort)" = "$(printf '%s\n' ./bin ./bin/wasm-opt ./lib ./lib/libbinaryen.dylib)" ] &&
        [ -d "$1/bin" ] && [ ! -L "$1/bin" ] && [ -f "$1/bin/wasm-opt" ] && [ ! -L "$1/bin/wasm-opt" ] && [ -x "$1/bin/wasm-opt" ] &&
        [ -d "$1/lib" ] && [ ! -L "$1/lib" ] &&
        [ -f "$1/lib/libbinaryen.dylib" ] && [ ! -L "$1/lib/libbinaryen.dylib" ] &&
        [ "$(shasum -a 256 < "$1/bin/wasm-opt" | cut -c1-64)" = "$WASM_OPT_SHA256" ] &&
        [ "$(shasum -a 256 < "$1/lib/libbinaryen.dylib" | cut -c1-64)" = "$LIBBINARYEN_SHA256" ]
}
if [ "$(uname -s) $(uname -m)" = "Darwin arm64" ]; then
    BINARYEN="$TOOLS/binaryen-version_$WASM_OPT_VERSION"
    if ! binaryen "$BINARYEN"; then
        rm -rf "$BINARYEN" "$BINARYEN.download" "$BINARYEN.tar.gz"
        mkdir -p "$BINARYEN.download"
        curl -fsSL -o "$BINARYEN.tar.gz" \
            "https://github.com/WebAssembly/binaryen/releases/download/version_$WASM_OPT_VERSION/binaryen-version_$WASM_OPT_VERSION-arm64-macos.tar.gz"
        tar -xzf "$BINARYEN.tar.gz" -C "$BINARYEN.download"
        rm -f "$BINARYEN.tar.gz"
        # The release's folder, whatever it is called: the one with bin/wasm-opt in it. What is kept of it is the two
        # files, copied into a folder made for them (a link is copied as a link, which the check below refuses); the
        # rest goes, before anything runs.
        opt="$(find "$BINARYEN.download" -path '*/bin/wasm-opt' -type f | head -n 1)"
        if [ -n "$opt" ]; then
            release="$(dirname "$(dirname "$opt")")"
            mkdir -p "$BINARYEN/bin" "$BINARYEN/lib"
            cp -P "$release/bin/wasm-opt" "$BINARYEN/bin/wasm-opt" || true
            cp -P "$release/lib/libbinaryen.dylib" "$BINARYEN/lib/libbinaryen.dylib" || true
        fi
        rm -rf "$BINARYEN.download"
        if ! binaryen "$BINARYEN"; then
            rm -rf "$BINARYEN"
            echo "binaryen version_$WASM_OPT_VERSION's release is not what this script checked it against: its bin/wasm-opt or" >&2
            echo "lib/libbinaryen.dylib is missing or has another SHA-256 (see WASM_OPT_SHA256 above)." >&2
            exit 1
        fi
    fi
    PATH="$BINARYEN/bin:$PATH"
fi
if command -v wasm-opt >/dev/null && ! wasm-opt --version | grep -q "version $WASM_OPT_VERSION "; then
    echo "$(command -v wasm-opt) ($(wasm-opt --version)) is on PATH, so wasm-pack would optimize with it instead of" >&2
    echo "binaryen version_$WASM_OPT_VERSION, and the build would differ from CI's. Run the build without it on PATH." >&2
    exit 1
fi

# --locked: dependencies at the versions in Cargo.lock (as the patches leave it), never newer ones.
(cd crates/ironrdp-web && wasm-pack build --target web -- --locked)
(cd web-client/iron-remote-desktop && npm ci --no-audit --no-fund && npm run build)
(cd web-client/iron-remote-desktop-rdp && npm ci --no-audit --no-fund && npm run build-alone)

cp web-client/iron-remote-desktop/dist/iron-remote-desktop.js "$ROOT/vendor/"
# Vite's library build inlines the WebAssembly as one ~7 MB base64 data URL, which package scanners flag as
# obfuscated code. Ship it as vendor/ironrdp_web_bg.wasm instead, with the bundle's default pointing next to itself
# (the plugin reads the file and hands init() the bytes; see loadIronRDP). The data URL is checked to be exactly
# wasm-pack's output, so nothing else is lost with it.
node - web-client/iron-remote-desktop-rdp/dist/iron-remote-desktop-rdp.js crates/ironrdp-web/pkg/ironrdp_web_bg.wasm "$ROOT/vendor" <<'EOF'
const fs = require('fs')
const path = require('path')
const [bundle, wasm, vendor] = process.argv.slice(2)
const js = fs.readFileSync(bundle, 'utf8')
const inlined = [...js.matchAll(/new URL\("data:application\/wasm;base64,([A-Za-z0-9+/=]+)"(, import\.meta\.url)?\)/g)]
if (inlined.length !== 1) throw new Error(`${bundle}: expected one inlined WebAssembly module, found ${inlined.length}`)
const bytes = fs.readFileSync(wasm)
if (!Buffer.from(inlined[0][1], 'base64').equals(bytes)) throw new Error(`${bundle}: the inlined module is not ${wasm}`)
const out = js.replace(inlined[0][0], () => 'new URL("ironrdp_web_bg.wasm", import.meta.url)')
if (out.includes(';base64,')) throw new Error(`${bundle}: another inlined asset is left`)
fs.writeFileSync(path.join(vendor, 'iron-remote-desktop-rdp.js'), out)
fs.writeFileSync(path.join(vendor, 'ironrdp_web_bg.wasm'), bytes)
EOF
{
    echo "vendor/iron-remote-desktop*.js and vendor/ironrdp_web_bg.wasm are built from IronRDP"
    echo "(https://github.com/Devolutions/IronRDP) at commit $COMMIT with the patches in"
    echo "ironrdp/patches applied. IronRDP is dual-licensed under MIT or Apache-2.0; its MIT license follows."
    echo
    cat LICENSE-MIT
} > "$ROOT/vendor/IRONRDP-LICENSE"

# What vendor/ was built from (the base commit and each patch) and what it holds, in sha256sum's format, with paths
# from the repository's root. The comments say how and where it was built, for whoever compares builds; CI's rebuild
# compares the hashes only.
HOST="$(rustc -vV | sed -n 's/^host: //p')"
cd "$ROOT"
sha256 () {
    if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
{
    echo "# vendor/ is IronRDP $COMMIT with the patches below, built by scripts/build-ironrdp.sh with"
    echo "# $(rustc --version), wasm-pack $WASM_PACK_VERSION (wasm-bindgen $BINDGEN_VERSION, binaryen version_$WASM_OPT_VERSION) and"
    echo "# Node.js $(node --version), on $HOST. Check from the repository's root: sha256sum -c vendor/SHA256SUMS"
    echo "# (or shasum -a 256 -c vendor/SHA256SUMS)."
    sha256 ironrdp/BASE_COMMIT ironrdp/patches/*.patch
    sha256 vendor/IRONRDP-LICENSE vendor/iron-remote-desktop-rdp.js vendor/iron-remote-desktop.js vendor/ironrdp_web_bg.wasm
} > vendor/SHA256SUMS
echo "vendor/ updated from IronRDP $COMMIT + $(ls ironrdp/patches/*.patch | wc -l | tr -d ' ') patches (vendor/SHA256SUMS)"
