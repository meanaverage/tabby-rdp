#!/bin/sh
# Rebuilds vendor/iron-remote-desktop*.js: IronRDP at ironrdp/BASE_COMMIT with ironrdp/patches/*.patch applied in
# order (see ironrdp/README.md).
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
cp web-client/iron-remote-desktop-rdp/dist/iron-remote-desktop-rdp.js "$ROOT/vendor/"
{
    echo "vendor/iron-remote-desktop*.js are built from IronRDP (https://github.com/Devolutions/IronRDP) at commit"
    echo "$COMMIT with the patches in ironrdp/patches applied. IronRDP is dual-licensed under MIT or Apache-2.0;"
    echo "its MIT license follows."
    echo
    cat LICENSE-MIT
} > "$ROOT/vendor/IRONRDP-LICENSE"
echo "vendor/ updated from IronRDP $COMMIT + $(ls "$ROOT"/ironrdp/patches/*.patch | wc -l | tr -d ' ') patches"
