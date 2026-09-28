import * as fs from 'fs'
import * as path from 'path'
import { RemoteTarget } from './targets'
import { normalizeFingerprint } from './rdcleanpath'

export interface RemoteDesktopEndpoint {
    /**
     * 'gnome': grd, with the generated account. 'xrdp': no GNOME there, but xrdp, which signs in with the Linux account.
     * 'windows': the host runs Windows; its RDP server signs in with the Windows account.
     */
    kind: 'gnome' | 'xrdp' | 'windows'
    port: number
    username: string
    /** Empty for xrdp and Windows: the user signs in. */
    password: string
    /** SHA-256 fingerprint of grd's TLS certificate (made by this script): the only one to accept on the port. */
    certificate: string
    /** xrdp's port, when it also runs besides GNOME (on a port of its own). */
    xrdpPort?: number
    /** The account to suggest for xrdp: the SSH user. */
    xrdpUser?: string
}

// Runs as the SSH user; needs no root. Prints exactly one `RD_OK port=N user=U pass=P cert=SHA256`,
// `RD_XRDP port=N user=U` (no GNOME, but xrdp), `RD_WINDOWS` (a Windows host's POSIX sh) or `RD_ERR <reason>` line;
// with RD_OK, also an RD_XRDP line when xrdp runs besides GNOME.
// The RDP password is generated once per remote user and kept in a 0600 file; grd reads credentials only
// at startup, so grd is restarted only when its configuration actually changes (that drops live sessions).
// (grdctl takes the credentials as arguments, so they are briefly visible in the remote's process list.)
const SETUP_SCRIPT = String.raw`
say () { printf '%s\n' "$*"; }
fail () { say "RD_ERR $*"; exit 0; }
# A Windows host whose PATH has a POSIX sh (Git, MSYS2, Cygwin): its desktop is Windows' own RDP server.
case "$(uname -s 2>/dev/null)" in CYGWIN*|MINGW*|MSYS*) say "RD_WINDOWS"; exit 0 ;; esac
# xrdp serves the Linux desktops other than GNOME (KDE, XFCE, MATE, …). Its port is [Globals] port= in xrdp.ini
# (default 3389): a number, or a listener such as tcp://:3390 (the first one, when there are several). Only used when
# it runs and listens, so the host's own desktop isn't one that can't answer.
XRDP_PORT= XRDP_WHY=
if [ -f /etc/xrdp/xrdp.ini ]; then
    P=$(sed -n '/^\[Globals\]/,/^\[/s/^[[:space:]]*port[[:space:]]*=[[:space:]]*//p' /etc/xrdp/xrdp.ini 2>/dev/null | tr -d '\r' | head -1)
    P=${"$"}{P%%[[:space:]]*}
    case $P in
        '') P=3389 ;;
        vsock://*) P= ;;
        *:*) P=${"$"}{P##*:} ;;
    esac
    case $P in *[!0-9]*) P= ;; esac
    if ! systemctl is-active -q xrdp 2>/dev/null && ! pgrep -x xrdp >/dev/null 2>&1; then
        XRDP_WHY="xrdp is installed but not running (start it: sudo systemctl enable --now xrdp)"
    elif [ -z "$P" ]; then
        XRDP_WHY="xrdp does not listen on a TCP port (see port= in /etc/xrdp/xrdp.ini)"
    elif command -v ss >/dev/null 2>&1 && ! ss -ltnH "sport = :$P" 2>/dev/null | grep -q .; then
        XRDP_WHY="xrdp runs, but nothing listens on its port $P"
    else
        XRDP_PORT=$P
    fi
fi
NO_GNOME=
command -v grdctl >/dev/null 2>&1 || NO_GNOME="GNOME Remote Desktop (grdctl) is not installed"
[ -n "$NO_GNOME" ] || command -v gnome-shell >/dev/null 2>&1 || NO_GNOME="gnome-shell is not installed"
if [ -n "$NO_GNOME" ]; then
    # No GNOME: the host's own desktop is xrdp's, if it runs. Nothing to set up for it: xrdp starts a session
    # when the user signs in.
    [ -z "$XRDP_PORT" ] || { say "RD_XRDP port=$XRDP_PORT user=$(id -un)"; exit 0; }
    [ -z "$XRDP_WHY" ] || fail "$NO_GNOME, and $XRDP_WHY"
    fail "$NO_GNOME. For other Linux desktops, install xrdp and a desktop (Debian, Ubuntu: sudo apt install xrdp xfce4)"
fi
if systemctl --user is-active -q gnome-remote-desktop.service; then
    fail "a desktop-session GNOME Remote Desktop is already running for this user"
fi
D="$HOME/.local/share/tabby-rdp"
# Before 0.2 this was ~/.local/share/tabby-remote-desktop, with a '# tabby-remote-desktop' login hook: move it over
# once (keys, password, helpers) and drop the old hook line (the 'desk' part below adds the current one if wanted).
OLD="$HOME/.local/share/tabby-remote-desktop"
if [ -d "$OLD" ] && [ ! -e "$D" ]; then
    mv "$OLD" "$D" || fail "could not move $OLD to $D"
fi
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && grep -qF '# tabby-remote-desktop' "$rc"; then
        sed -i.trd-bak '/# tabby-remote-desktop$/d' "$rc" && rm -f "$rc.trd-bak"
    fi
done
mkdir -p "$D" && chmod 700 "$D" || fail "could not create $D"
NEW_CERT=0
if [ ! -s "$D/tls.key" ]; then
    openssl req -new -newkey rsa:3072 -days 3650 -nodes -x509 -subj "/CN=$(hostname)" \
        -keyout "$D/tls.key" -out "$D/tls.crt" >/dev/null 2>&1 || fail "could not create a TLS certificate"
    NEW_CERT=1
fi
# The plugin accepts only this certificate on grd's port.
CERT=$(openssl x509 -in "$D/tls.crt" -noout -fingerprint -sha256 2>/dev/null | sed 's/^[^=]*=//')
[ -n "$CERT" ] || fail "could not read the TLS certificate $D/tls.crt (openssl x509)"
# 'desk' support (setting, off by default): interactive SSH logins start inside a shareable session (trd-pty,
# or tmux), so 'desk' can attach this exact console to a terminal on the desktop. Rewritten on every connect;
# opt out per login with TABBY_NO_SESSION=1. When the setting is off, the hook and helpers are removed.
if [ "${"$"}{TRD_DESK:-0}" = 1 ]; then
mkdir -p "$D/bin"
cat > "$D/login.sh" <<'TRD_EOF'
# tabby-rdp ('desk' setting): interactive SSH logins run inside a shareable session, so 'desk' in Tabby can
# bring this console to the remote desktop. Backend ("native" trd-pty or "tmux") is in $TRD_HOME/backend.
# Set TABBY_NO_SESSION=1 (or TABBY_NO_TMUX=1) to skip; turning 'desk' off in Tabby removes this hook.
TRD_HOME="$HOME/.local/share/tabby-rdp"
case ":$PATH:" in *":$TRD_HOME/bin:"*) ;; *) PATH="$TRD_HOME/bin:$PATH"; export PATH ;; esac
case $- in *i*) ;; *) return 0 ;; esac
if [ -n "$SSH_TTY" ] && [ -z "$TMUX" ] && [ -z "$TRD_SESSION" ] && [ -z "$TABBY_NO_TMUX$TABBY_NO_SESSION" ]; then
    TRD_BACKEND=$(cat "$TRD_HOME/backend" 2>/dev/null)
    if [ "$TRD_BACKEND" = native ] && command -v python3 >/dev/null 2>&1; then
        "$TRD_HOME/bin/trd-pty" new
        case $? in 0) exit ;; 3) TRD_BACKEND=tmux ;; esac   # 3: no session could be started
    fi
    if [ "$TRD_BACKEND" != native ] && command -v tmux >/dev/null 2>&1; then
        tmux -L tabby -f "$TRD_HOME/tmux.conf" new-session && exit
    fi
fi
TRD_EOF
cat > "$D/tmux.conf" <<'TRD_EOF'
# tmux server for SSH logins (tabby-rdp 'desk'). Your ~/.tmux.conf is applied on top.
set -g status off
# Like a plain SSH login: the session ends when its last client (console or desktop terminal) goes away.
set -g destroy-unattached on
# Console and desktop terminal can differ in size: follow whichever was used last. Focus reports make
# switching back (Tabby focuses the console) count as use, so the window resizes right away.
set -g window-size latest
set -g focus-events on
# Lets 'desk' reach Tabby from inside tmux.
set -g allow-passthrough on
# Keep the terminal's own scrollback (no alternate screen).
set -ga terminal-overrides ',*:smcup@:rmcup@'
source-file -q ~/.tmux.conf
TRD_EOF
cat > "$D/bin/desk" <<'TRD_EOF'
#!/bin/sh
# desk: open this machine's desktop in Tabby, with this console (its shared session) waiting in a terminal there.
b64 () { printf %s "$1" | base64 | tr -d '\n'; }
KIND= SESSION= SOCKET=
if [ -n "$TRD_SESSION" ]; then
    KIND=native SESSION=$TRD_SESSION SOCKET=$TRD_SOCKET
elif [ -n "$TMUX" ]; then
    KIND=tmux
    SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
    SOCKET=$(tmux display-message -p '#{socket_path}' 2>/dev/null)
    tmux set-option -p allow-passthrough on 2>/dev/null
fi
# Which machine this is: a shared home folder puts this script on others too, and the tab may be connected to another
# machine than the one this runs on (ssh typed in its console).
MACHINE=$(cat /etc/machine-id 2>/dev/null || hostname)
SEQ=$(printf '\033]7777;desk;%s;%s;%s;%s;%s;%s\007' "$(b64 "$SESSION")" "$(b64 "$SOCKET")" "$(b64 "$PWD")" "$(b64 "$KIND")" "$(b64 "$MACHINE")" "$(b64 "$(hostname)")")
if [ "$KIND" = tmux ]; then
    printf '\033Ptmux;\033%s\033\\' "$SEQ"   # tmux only lets it through as passthrough
else
    printf '%s' "$SEQ"                       # trd-pty passes output through byte for byte
fi
TRD_EOF
chmod 755 "$D/bin/desk"
cat > "$D/bin/trd-pty" <<'TRD_PY_EOF'
@@TRD_PTY_PY@@
TRD_PY_EOF
chmod 755 "$D/bin/trd-pty"
printf '%s\n' "${"$"}{TRD_BACKEND:-native}" > "$D/backend"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -qF '# tabby-rdp' "$rc" && continue
    # Only one line: turning desk off deletes exactly it, so on/off cycles leave the file as it was.
    [ -z "$(tail -c1 "$rc")" ] || echo >> "$rc"
    printf '[ -f "$HOME/.local/share/tabby-rdp/login.sh" ] && . "$HOME/.local/share/tabby-rdp/login.sh"  # tabby-rdp\n' >> "$rc"
done
else
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [ -f "$rc" ] && grep -qF '# tabby-rdp' "$rc"; then
            sed -i.trd-bak '/# tabby-rdp$/d' "$rc" && rm -f "$rc.trd-bak"
        fi
    done
    # Sessions already running keep going; new logins are plain again.
    rm -f "$D/login.sh" "$D/tmux.conf" "$D/backend" "$D/bin/desk" "$D/bin/trd-pty"
fi
if [ ! -s "$D/rdp-password" ]; then
    ( umask 077; od -An -N18 -tx1 /dev/urandom | tr -d ' \n' > "$D/rdp-password" ) || fail "could not create credentials"
fi
RD_USER=tabby
RD_PASS=$(cat "$D/rdp-password")

STATUS=$(grdctl --headless status --show-credentials 2>/dev/null)
has () { printf '%s\n' "$STATUS" | grep -qxF "$(printf '\t%s' "$1")"; }
g () { grdctl --headless rdp "$@" >/dev/null 2>&1; }
RESTART=0
# grd reads the certificate at startup: a new one at the same path needs a restart too, or grd would keep serving
# the old one, which the plugin would then refuse.
if [ $NEW_CERT = 1 ] || ! has "TLS key: $D/tls.key" || ! has "TLS certificate: $D/tls.crt"; then
    g set-tls-key "$D/tls.key" && g set-tls-cert "$D/tls.crt" || fail "grdctl could not set the TLS certificate"
    RESTART=1
fi
if ! has "View-only: no"; then g disable-view-only || fail "grdctl could not disable view-only"; RESTART=1; fi
if ! has "Status: enabled"; then g enable || fail "grdctl could not enable RDP"; RESTART=1; fi
if ! has "Username: $RD_USER" || ! has "Password: $RD_PASS"; then
    g set-credentials "$RD_USER" "$RD_PASS" || fail "grdctl could not set credentials"
    RESTART=1
fi

# Session identity for the headless shell: apps like Settings refuse to run without XDG_CURRENT_DESKTOP,
# and xdg-open picks the desktop's handlers from it. Use Ubuntu's session mode when present (dock etc.).
if [ -f /usr/share/gnome-shell/modes/ubuntu.json ]; then SESS=ubuntu; DESK=ubuntu:GNOME; else SESS=gnome; DESK=GNOME; fi
SESSION_VERSION=2
SHELL_PID=$(pgrep -u "$(id -u)" -f 'gnome-shell --headless' | head -1)
if [ -n "$SHELL_PID" ] && ! tr '\0' '\n' < /proc/$SHELL_PID/environ 2>/dev/null | grep -qx "TABBY_RD_SESSION=$SESSION_VERSION"; then
    # A shell from an older setup (no session identity): replace it (closes its windows).
    kill "$SHELL_PID" 2>/dev/null
    i=0; while [ $i -lt 40 ] && kill -0 "$SHELL_PID" 2>/dev/null; do sleep 0.25; i=$((i+1)); done
    SHELL_PID=
fi
# Screen casting (and sound) goes through PipeWire. Its sockets are normally up with the user's systemd, but not
# when PipeWire was installed after that started (a lingering user on a freshly set-up server); start them.
systemctl --user start pipewire.socket pipewire-pulse.socket wireplumber.service >/dev/null 2>&1
if [ -z "$SHELL_PID" ]; then
    # Apps from a previous headless session (marked below) outlive their display; single-instance apps
    # would then swallow new launches without showing a window. End them before starting afresh.
    for p in $(pgrep -u "$(id -u)"); do
        grep -qz '^TABBY_RD_SESSION=' /proc/$p/environ 2>/dev/null && kill "$p" 2>/dev/null
    done
    systemctl --user stop tabby-headless-shell >/dev/null 2>&1
    systemctl --user reset-failed tabby-headless-shell >/dev/null 2>&1
    systemd-run --user --unit=tabby-headless-shell --setenv=XDG_SESSION_TYPE=wayland \
        --setenv=XDG_CURRENT_DESKTOP=$DESK --setenv=XDG_SESSION_DESKTOP=$SESS --setenv=DESKTOP_SESSION=$SESS \
        --setenv=GNOME_SHELL_SESSION_MODE=$SESS --setenv=TABBY_RD_SESSION=$SESSION_VERSION \
        gnome-shell --headless >/dev/null 2>&1 \
        || fail "could not start a headless GNOME Shell"
    i=0; while [ $i -lt 40 ] && ! busctl --user status org.gnome.Mutter.RemoteDesktop >/dev/null 2>&1; do sleep 0.25; i=$((i+1)); done
    SHELL_PID=$(pgrep -u "$(id -u)" -f 'gnome-shell --headless' | head -1)
    RESTART=1
fi
# What gnome-session does for a real login: let D-Bus/systemd-activated apps find this display.
WL=$(tr '\0' '\n' < /proc/$SHELL_PID/environ 2>/dev/null | sed -n 's/^WAYLAND_DISPLAY=//p')
[ -n "$WL" ] || WL=$(ls -t "$XDG_RUNTIME_DIR" 2>/dev/null | grep -m1 -x 'wayland-[0-9]*')
dbus-update-activation-environment --systemd WAYLAND_DISPLAY=${"$"}{WL:-wayland-0} XDG_SESSION_TYPE=wayland \
    XDG_CURRENT_DESKTOP=$DESK XDG_SESSION_DESKTOP=$SESS DESKTOP_SESSION=$SESS >/dev/null 2>&1
# Mark D-Bus-activated apps as part of this session too (not in systemd's environment: user services would inherit it).
dbus-update-activation-environment TABBY_RD_SESSION=$SESSION_VERSION >/dev/null 2>&1
# Also what gnome-session does: bring up graphical-session.target, which the GNOME portal requires. Without it the
# portal service hangs, and every GTK app waits 25 seconds for it before showing a window. Held for as long as the
# shell runs (the target can't be started directly).
if ! systemctl --user is-active -q graphical-session.target; then
    systemctl --user stop tabby-graphical-session >/dev/null 2>&1
    systemctl --user reset-failed tabby-graphical-session >/dev/null 2>&1
    systemd-run --user --unit=tabby-graphical-session --remain-after-exit \
        -p BindsTo=tabby-headless-shell.service -p After=tabby-headless-shell.service \
        -p Wants=graphical-session.target -p Before=graphical-session.target true >/dev/null 2>&1
fi
# Remote sound is what plays on the default output. A machine without sound hardware (a VM, most servers) has
# none: add a virtual one, which lasts until PipeWire restarts.
if command -v pw-cli >/dev/null && ! timeout 5 pw-cli ls Node 2>/dev/null | grep -q '"Audio/Sink"'; then
    timeout 5 pw-cli create-node adapter '{ factory.name=support.null-audio-sink node.name=tabby-rdp-output
        node.description="Remote desktop" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }' >/dev/null 2>&1
fi
if [ $RESTART = 1 ] || ! systemctl --user is-active -q gnome-remote-desktop-headless.service; then
    systemctl --user restart gnome-remote-desktop-headless.service >/dev/null 2>&1 || fail "could not start gnome-remote-desktop-headless"
fi
PORT=$(grdctl --headless status 2>/dev/null | awk '/Port:/ { print $2; exit }')
PORT=${"$"}{PORT:-3389}
i=0; while [ $i -lt 40 ] && ! ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .; do sleep 0.25; i=$((i+1)); done
ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q . || fail "nothing is listening on port $PORT"
# xrdp besides GNOME (on a port of its own; on grd's, one of them couldn't listen): offered as another desktop.
[ -z "$XRDP_PORT" ] || [ "$XRDP_PORT" = "$PORT" ] || say "RD_XRDP port=$XRDP_PORT user=$(id -un)"
say "RD_OK port=$PORT user=$RD_USER pass=$RD_PASS cert=$CERT"
`

/** Which shareable session SSH logins get (for 'desk'): our own trd-pty, or the earlier tmux setup. */
export type SessionBackend = 'native' | 'tmux'

let trdPtySource: string | null = null
function trdPty (): string {
    trdPtySource ??= fs.readFileSync(path.join(__dirname, '..', 'remote', 'trd-pty.py'), 'utf8')
    return trdPtySource
}

/**
 * Whether the SSH host is Windows, i.e. its shell is cmd.exe or PowerShell. One command each of the three shells answers
 * differently: cmd expands %OS%, PowerShell $env:OS (both to Windows_NT), sh neither.
 */
async function isWindows (target: RemoteTarget): Promise<boolean> {
    try {
        return /Windows_NT/.test(await target.exec('echo %OS% $env:OS', ''))
    } catch {
        return false
    }
}

/**
 * Makes sure the remote user has a headless GNOME session served by grd, with fresh credentials. Without GNOME,
 * reports xrdp's port instead, when xrdp runs there; on a Windows host (OpenSSH Server on Windows), Windows' own RDP
 * server, which signs in with the Windows account (the SSH user, to start with).
 */
export async function prepareRemoteDesktop (target: RemoteTarget, desk: boolean, backend: SessionBackend = 'native'): Promise<RemoteDesktopEndpoint> {
    const script = `TRD_DESK=${desk ? 1 : 0}\nTRD_BACKEND=${backend === 'tmux' ? 'tmux' : 'native'}\n` +
        SETUP_SCRIPT.replace('@@TRD_PTY_PY@@', trdPty().trimEnd())
    const out = await target.exec('sh -s', script)
    // Without a sh, Windows prints its complaint on stderr, which exec() doesn't return: nothing came back. Only then is
    // it worth asking, so a Linux host costs nothing extra.
    if (/^RD_WINDOWS$/m.test(out) || !/^RD_(OK|XRDP|ERR) /m.test(out) && await isWindows(target)) {
        // Its RDP server makes its own certificate: trusted on first use, like a desktop behind the host.
        return { kind: 'windows', port: 3389, username: target.key.replace(/@[^@]*$/, ''), password: '', certificate: '' }
    }
    const err = /^RD_ERR (.*)$/m.exec(out)
    if (err) {
        throw new Error(err[1])
    }
    const ok = /^RD_OK port=(\d+) user=(\S+) pass=(\S+) cert=(\S+)$/m.exec(out)
    const xrdp = /^RD_XRDP port=(\d+) user=(\S*)$/m.exec(out)
    if (ok) {
        const certificate = normalizeFingerprint(ok[4])
        if (!certificate) {
            throw new Error(`Remote setup reported no usable certificate fingerprint (${ok[4]})`)
        }
        return { kind: 'gnome', port: Number(ok[1]), username: ok[2], password: ok[3], certificate, xrdpPort: xrdp ? Number(xrdp[1]) : undefined, xrdpUser: xrdp?.[2] }
    }
    if (xrdp) {
        // xrdp makes its own certificate: trusted on first use, like a desktop behind the host.
        return { kind: 'xrdp', port: Number(xrdp[1]), username: xrdp[2], password: '', certificate: '', xrdpPort: Number(xrdp[1]), xrdpUser: xrdp[2] }
    }
    throw new Error('Remote setup gave no result')
}
