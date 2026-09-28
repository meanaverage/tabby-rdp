#!/bin/sh
# Rebuilds vendor/iron-remote-desktop*.js and vendor/ironrdp_web_bg.wasm: IronRDP at ironrdp/BASE_COMMIT with
# ironrdp/patches/*.patch applied in order (see ironrdp/README.md).
#
# Needs git, rustup and Node.js (npm). The Rust toolchain IronRDP pins and the wasm32 target are installed by rustup
# on first use; wasm-pack is installed with cargo if missing.
#
# The IronRDP checkout lives in .ironrdp/ (or $IRONRDP_SRC). It is reset to the base commit on every run, so keep
# any work of your own there on a branch.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${IRONRDP_SRC:-$ROOT/.ironrdp}"
COMMIT="$(cat "$ROOT/ironrdp/BASE_COMMIT")"
WASM_PACK_VERSION=0.15.0

if [ ! -d "$SRC/.git" ]; then
    git clone https://github.com/Devolutions/IronRDP.git "$SRC"
fi
cd "$SRC"
git cat-file -e "$COMMIT^{commit}" 2>/dev/null || git fetch --quiet origin
git checkout --quiet --force --detach "$COMMIT"
git clean -fdq -e target -e node_modules
for patch in "$ROOT"/ironrdp/patches/*.patch; do
    git apply --whitespace=nowarn "$patch"
done

# The toolchain IronRDP pins (rust-toolchain.toml), explicitly: a Rust earlier on PATH (e.g. Homebrew's) or an older
# rustup could build with the wrong one.
RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml)}"
PATH="$HOME/.cargo/bin:$PATH"
# IronRDP's own wasm flags (.cargo/config.toml), plus: keep this machine's paths (cargo registry, checkout) out of
# the panic messages compiled into the WebAssembly.
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$SRC=/ironrdp"
export RUSTUP_TOOLCHAIN PATH CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS

rustup target add wasm32-unknown-unknown
command -v wasm-pack >/dev/null || cargo install --locked wasm-pack --version "$WASM_PACK_VERSION"

(cd crates/ironrdp-web && wasm-pack build --target web)
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
echo "vendor/ updated from IronRDP $COMMIT + $(ls "$ROOT"/ironrdp/patches/*.patch | wc -l | tr -d ' ') patches"
