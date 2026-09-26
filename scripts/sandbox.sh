#!/bin/sh
# Starts a separate Tabby with this plugin linked in, for development: its own settings folder, plugins and
# single-instance lock, and the DevTools protocol on $CDP_PORT (default 9334). Your normal Tabby is not touched.
# (The test suites start their own, see test/README.md.) Usage: scripts/sandbox.sh [settings-folder]
set -eu
NAME=tabby-rdp
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SB="${1:-${TMPDIR:-/tmp}/tabby-rdp-sandbox}"
REAL="$HOME/Library/Application Support/tabby"
mkdir -p "$SB/plugins/node_modules"
[ -f "$SB/config.yaml" ] || cp "$REAL/config.yaml" "$SB/config.yaml" 2>/dev/null || printf 'enableWelcomeTab: false\n' > "$SB/config.yaml"
[ -f "$SB/plugins/package.json" ] || echo '{}' > "$SB/plugins/package.json"
ln -sfn "$PLUGIN_DIR" "$SB/plugins/node_modules/$NAME"
echo "Sandbox: $SB"
# The last three switches keep timers and rendering running while the window is behind others (tests).
TABBY_CONFIG_DIRECTORY="$SB" exec /Applications/Tabby.app/Contents/MacOS/Tabby --user-data-dir="$SB" --remote-debugging-port="${CDP_PORT:-9334}" \
    --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
