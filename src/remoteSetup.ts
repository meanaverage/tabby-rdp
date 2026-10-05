import * as fs from 'fs'
import * as path from 'path'
import { keyUser } from './desktops'
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
    /** GNOME: RDP clients connected to it already, from elsewhere (each gets a screen of its own). */
    clients?: number
    /**
     * GNOME: how many seconds ago another client (pane) took the desktop over, within the last 2 minutes (its connection
     * may still be on the way).
     */
    takenOver?: number
    /** GNOME, with `desk` set up there: the key its requests carry (see openConsole). */
    deskKey?: string
    /** GNOME: what the setup couldn't do and the user may want to know (an rc file it couldn't change), for the log. */
    notes?: string[]
}


// Runs as the SSH user; needs no root. Prints exactly one `RD_OK port=N user=U pass=P cert=SHA256`,
// `RD_XRDP port=N user=U` (no GNOME, but xrdp), `RD_WINDOWS` (a Windows host's POSIX sh) or `RD_ERR <reason>` line;
// with RD_OK, also an RD_XRDP line when xrdp runs besides GNOME, `RD_CLIENTS N`, the clients connected already,
// `RD_TAKEN_OVER <client> <seconds ago>` after a recent take-over, `RD_DESK <key>` with 'desk' on, and an `RD_NOTE <text>`
// for each rc file it couldn't change.
// The RDP password is generated once per remote user and kept in a 0600 file; grd reads credentials only
// at startup, so grd is restarted only when its configuration actually changes (that drops live sessions).
// Secrets never go on a command line, which any user there can see in the process list, except where grdctl can't
// read the password from its input: then it is an argument once, when the credentials are set.
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
mkdir -p "$D" && chmod 700 "$D" || fail "could not create $D"
# The login hook ('desk'): this one line in ~/.bashrc and ~/.zshrc, added and removed exactly, so that a line of the
# user's own that only looks like it stays.
HOOK='[ -f "$HOME/.local/share/tabby-rdp/login.sh" ] && . "$HOME/.local/share/tabby-rdp/login.sh"  # tabby-rdp'
# Takes the lines that are exactly $2 out of rc file $1 and changes nothing else. grep reads it byte by byte, as text
# (LC_ALL=C, -a): otherwise a NUL byte, or a byte the host's locale can't read, has it leave lines out or print "Binary
# file … matches" in their place. What it leaves must be the file less those lines, to the byte, and is written into
# the file itself, so that a symbolic link to it, another name for it (a hard link), its mode and its owner all stay.
# A file that can't be written (read-only) or doesn't add up is left as it is, and the setup says so (RD_NOTE).
unhook () {
    [ -f "$1" ] || return 0
    LC_ALL=C grep -a -q -xF -- "$2" "$1" 2>/dev/null
    case $? in 0) ;; 1) return 0 ;; *) say "RD_NOTE desk's line may be in $1, which can't be read"; return 0 ;; esac
    uh_tmp=$(mktemp "$D/rc.XXXXXX") || { say "RD_NOTE desk's line stays in $1: no temporary file could be made in $D"; return 0; }
    LC_ALL=C grep -a -v -xF -- "$2" "$1" > "$uh_tmp"
    # 1: no line left, the file held only the hook. Each line taken out goes with its newline, and grep ends a last line
    # that has none with one: so what is left is shorter by exactly that, or one byte longer than that. A step that fails
    # counts as a mismatch (rather than ending the script, as a failed sum would).
    if [ $? -le 1 ] && uh_was=$(wc -c < "$1") && uh_lines=$(LC_ALL=C grep -a -c -xF -- "$2" "$1") && uh_now=$(wc -c < "$uh_tmp"); then
        uh_more=$(( $uh_now - ($uh_was - $uh_lines * (${"$"}{#2} + 1)) ))
    else
        uh_more=-1
    fi
    if [ "$uh_more" != 0 ] && [ "$uh_more" != 1 ]; then
        say "RD_NOTE desk's line stays in $1: the rest of it didn't copy exactly"
    elif ! cat "$uh_tmp" 2>/dev/null > "$1"; then
        # Not opened (read-only), the file is as it was, its line in it. Otherwise writing it failed on the way (a full
        # disk): what it is to hold stays where the user can find it.
        if ! LC_ALL=C grep -a -q -xF -- "$2" "$1" 2>/dev/null; then
            say "RD_NOTE writing $1 failed; what it should hold (without desk's line) is in $uh_tmp"
            return 0
        fi
        say "RD_NOTE desk's line stays in $1: it can't be written (read-only?)"
    fi
    rm -f "$uh_tmp"
}
# The hook from before 0.2, as those versions wrote it, and what it sources, where the old folder is still there (it
# couldn't be moved over): so that a copy of the line that was changed since, and stays, does nothing either.
OLD_HOOK='[ -f "$HOME/.local/share/tabby-remote-desktop/login.sh" ] && . "$HOME/.local/share/tabby-remote-desktop/login.sh"  # tabby-remote-desktop'
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    unhook "$rc" "$OLD_HOOK"
done
rm -f "$OLD/login.sh"
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
DESK_KEY=
if [ "${"$"}{TRD_DESK:-0}" = 1 ]; then
mkdir -p "$D/bin"
# 'desk' sends this key with each request, and the plugin (told it below) ignores requests without it: anything shown
# in a terminal could print the rest. Only this user can read it. Made once, like the RDP password: a key is a file of
# this user's own (not a link), private, holding 128 bits in hex.
desk_key () {
    DESK_KEY=
    [ -f "$D/desk-key" ] && [ ! -L "$D/desk-key" ] && [ -O "$D/desk-key" ] || return 1
    DESK_KEY=$(cat "$D/desk-key")
    case $DESK_KEY in *[!0-9a-f]*) DESK_KEY= ;; esac
    [ ${"$"}{#DESK_KEY} = 32 ] || { DESK_KEY=; return 1; }
    chmod 600 "$D/desk-key"
}
if ! desk_key; then
    # Put in place in one step, where there is none: of two setups making one at once (two panes, or two computers),
    # the first one's stays, and both report it.
    T=$(mktemp "$D/desk-key.XXXXXX") && od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$T" || fail "could not create a key for desk"
    { [ -e "$D/desk-key" ] || [ -L "$D/desk-key" ]; } && ! desk_key && rm -f "$D/desk-key"
    ln "$T" "$D/desk-key" 2>/dev/null || desk_key || mv -f "$T" "$D/desk-key"
    rm -f "$T"
    desk_key || fail "could not create a key for desk"
fi
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
# What Tabby knows a real request by: other output can't read this.
KEY=$(cat "$HOME/.local/share/tabby-rdp/desk-key" 2>/dev/null)
SEQ=$(printf '\033]7777;desk;%s;%s;%s;%s;%s;%s;%s\007' "$(b64 "$SESSION")" "$(b64 "$SOCKET")" "$(b64 "$PWD")" "$(b64 "$KIND")" "$(b64 "$MACHINE")" "$(b64 "$(hostname)")" "$(b64 "$KEY")")
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
    LC_ALL=C grep -a -q -xF -- "$HOOK" "$rc" && continue
    # Only one line: turning desk off deletes exactly it, so on/off cycles leave the file as it was. A line of its own:
    # a newline first, unless the file is empty or its last byte is one (counted, as a NUL there reads as nothing).
    { [ ! -s "$rc" ] || [ $(( $(tail -c1 "$rc" | wc -l) )) = 1 ] || echo; printf '%s\n' "$HOOK"; } 2>/dev/null >> "$rc" \
        || say "RD_NOTE desk's line couldn't be added to $rc (read-only?): logins there don't start in a shared session"
done
else
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        unhook "$rc" "$HOOK"
    done
    # Sessions already running keep going; new logins are plain again.
    rm -f "$D/login.sh" "$D/tmux.conf" "$D/backend" "$D/bin/desk" "$D/bin/trd-pty" "$D/desk-key"
fi
if [ ! -s "$D/rdp-password" ]; then
    ( umask 077; od -An -N18 -tx1 /dev/urandom | tr -d ' \n' > "$D/rdp-password" ) || fail "could not create credentials"
fi
RD_USER=tabby
RD_PASS=$(cat "$D/rdp-password")

STATUS=$(grdctl --headless status --show-credentials 2>/dev/null)
TAB=$(printf '\t') NL='
'
# Whether grd's status has this line. Compared in the shell: as a command's argument, the password would show in the
# process list on every connect.
has () { case "$NL$STATUS$NL" in *"$NL$TAB$1$NL"*) return 0 ;; esac; return 1; }
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
    # Left off the command line, the password stays out of the process list: grdctl versions that ask for it then read
    # it from their input. Where that didn't take, it goes as an argument. Without timeout(1) on the host, grdctl runs
    # as it is: its input is a pipe that ends after the password, so it doesn't wait for more.
    if command -v timeout >/dev/null 2>&1; then
        printf '%s\n' "$RD_PASS" | timeout 10 grdctl --headless rdp set-credentials "$RD_USER" >/dev/null 2>&1
    else
        printf '%s\n' "$RD_PASS" | grdctl --headless rdp set-credentials "$RD_USER" >/dev/null 2>&1
    fi
    STATUS=$(grdctl --headless status --show-credentials 2>/dev/null)
    if ! has "Username: $RD_USER" || ! has "Password: $RD_PASS"; then
        g set-credentials "$RD_USER" "$RD_PASS" || fail "grdctl could not set credentials"
    fi
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
        -p "ExecStopPost=/bin/sh -c 'rm -f $XDG_RUNTIME_DIR/systemd/user/gnome-session-x11-services-ready.target $XDG_RUNTIME_DIR/systemd/user/tabby-gsd-xsettings.service; systemctl --user --no-block stop tabby-gsd-xsettings.service; systemctl --user unset-environment DISPLAY XAUTHORITY'" \
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
# X11 apps. The shell reserves an X display at startup and starts XWayland when an X11 app connects to it; apps find it
# through DISPLAY, which gnome-session would pass on: do that here (the lowest of its sockets, which the shell holds, or
# its XWayland once running; and the shell's X authority).
PIDS=" $SHELL_PID $(pgrep -P "$SHELL_PID" -x Xwayland | tr '\n' ' ')"
XD=$(ss -xlpH 2>/dev/null | awk -v pids="$PIDS" '$5 ~ /^\/tmp\/\.X11-unix\/X[0-9]+$/ && match($0, /pid=[0-9]+,/) && index(pids, " " substr($0, RSTART + 4, RLENGTH - 5) " ") { sub(/.*X/, "", $5); print $5 }' | sort -n | head -1)
XA=$(ls -t "$XDG_RUNTIME_DIR"/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
if [ -n "$XD" ]; then
    dbus-update-activation-environment --systemd DISPLAY=:$XD ${"$"}{XA:+XAUTHORITY=$XA} >/dev/null 2>&1
fi
# Once XWayland is up, the shell starts gnome-session's X11 services (gnome-session-x11-services-ready.target), and gives
# up on X11 if that fails, which it does without gnome-session. A runtime unit of that name (in $XDG_RUNTIME_DIR, gone at
# logout; removed when the shell stops) stands in for it, with GNOME's X11 settings daemon, as a session would start it.
U="$XDG_RUNTIME_DIR/systemd/user"
X11_UNITS="[Unit]
Description=X11 services for tabby-rdp's headless GNOME Shell
Wants=tabby-gsd-xsettings.service
--
[Unit]
Description=GNOME XSettings (tabby-rdp's headless GNOME Shell)
Before=gnome-session-x11-services-ready.target
[Service]
ExecStart=/usr/libexec/gsd-xsettings
TimeoutStopSec=5"
if [ -n "$XD" ] && [ -x /usr/libexec/gsd-xsettings ] && [ -n "$XDG_RUNTIME_DIR" ]; then
    mkdir -p "$U"
    if [ "$(cat "$U/gnome-session-x11-services-ready.target" 2>/dev/null; echo --; cat "$U/tabby-gsd-xsettings.service" 2>/dev/null)" != "$X11_UNITS" ]; then
        printf '%s\n' "$X11_UNITS" | sed '/^--$/,$d' > "$U/gnome-session-x11-services-ready.target"
        printf '%s\n' "$X11_UNITS" | sed '1,/^--$/d' > "$U/tabby-gsd-xsettings.service"
        systemctl --user daemon-reload >/dev/null 2>&1
        # A shell from before this: its XWayland, if one runs, started without these and has no X11 display (no X11
        # app works there). End it; the shell starts a new one for the next X11 app.
        pkill -P "$SHELL_PID" -x Xwayland 2>/dev/null
    fi
fi
# GNOME's settings daemons for the session (keyboard settings, media keys and custom shortcuts, accessibility, sound,
# disk space and cache upkeep), which gnome-session would start; for as long as the shell runs. Not power (it would
# suspend the machine when the session looks idle), sharing (it manages GNOME Remote Desktop), or the ones for local
# hardware (tablets, smartcards, radios, printers, color profiles).
for d in keyboard media-keys a11y-settings sound housekeeping; do
    [ -x /usr/libexec/gsd-$d ] || continue
    systemctl --user is-active -q tabby-gsd-$d && continue
    systemctl --user reset-failed tabby-gsd-$d >/dev/null 2>&1
    systemd-run --user --unit=tabby-gsd-$d --collect -p BindsTo=tabby-headless-shell.service -p After=tabby-headless-shell.service \
        /usr/libexec/gsd-$d >/dev/null 2>&1
done
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
# Clients connected already (another Tabby window or computer): grd gives each one a screen of its own, so the plugin
# asks. Taking over (TRD_TAKEOVER=1) disconnects them, as Windows does: a restart of grd, which leaves the session and
# its apps running.
# (Counted again for up to 2 s: a connection of the plugin's own that is being replaced, a reconnect, is closing.)
clients () { ss -tnH state established "( sport = :$PORT )" 2>/dev/null | grep -c .; }
CLIENTS=$(clients)
i=0; while [ "$CLIENTS" -gt 0 ] && [ $i -lt 8 ]; do sleep 0.25; CLIENTS=$(clients); i=$((i+1)); done
if [ "$CLIENTS" -gt 0 ] && [ "${"$"}{TRD_TAKEOVER:-0}" = 1 ]; then
    systemctl --user restart gnome-remote-desktop-headless.service >/dev/null 2>&1 || fail "could not restart gnome-remote-desktop-headless"
    i=0; while [ $i -lt 40 ] && ! ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .; do sleep 0.25; i=$((i+1)); done
    CLIENTS=0
    # Who took over, and when: the client that gave way reconnects by itself, possibly before this one is connected.
    printf '%s %s\n' "$TRD_CLIENT" "$(date +%s)" > "$D/taken-over"
fi
say "RD_CLIENTS $CLIENTS"
if [ -s "$D/taken-over" ]; then
    read -r BY AT < "$D/taken-over"
    AGE=$(( $(date +%s) - ${"$"}{AT:-0} ))
    [ "$AGE" -lt 120 ] && say "RD_TAKEN_OVER $BY $AGE"
fi
# xrdp besides GNOME (on a port of its own; on grd's, one of them couldn't listen): offered as another desktop.
[ -z "$XRDP_PORT" ] || [ "$XRDP_PORT" = "$PORT" ] || say "RD_XRDP port=$XRDP_PORT user=$(id -un)"
[ -z "$DESK_KEY" ] || say "RD_DESK $DESK_KEY"
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
export async function prepareRemoteDesktop (
    target: RemoteTarget, desk: boolean, backend: SessionBackend = 'native', client = '', takeOver = false,
): Promise<RemoteDesktopEndpoint> {
    // client: which pane asks (letters and digits), for the note a take-over leaves on the host (RD_TAKEN_OVER).
    client = client.replace(/[^A-Za-z0-9]/g, '') || 'none'
    const script = `TRD_DESK=${desk ? 1 : 0}\nTRD_BACKEND=${backend === 'tmux' ? 'tmux' : 'native'}\nTRD_TAKEOVER=${takeOver ? 1 : 0}\nTRD_CLIENT=${client}\n` +
        SETUP_SCRIPT.replace('@@TRD_PTY_PY@@', trdPty().trimEnd())
    const out = await target.exec('sh -s', script)
    // Without a sh, Windows prints its complaint on stderr, which exec() doesn't return: nothing came back. Only then is
    // it worth asking, so a Linux host costs nothing extra.
    if (/^RD_WINDOWS$/m.test(out) || !/^RD_(OK|XRDP|ERR) /m.test(out) && await isWindows(target)) {
        // Its RDP server makes its own certificate: trusted on first use, like a desktop behind the host.
        return { kind: 'windows', port: 3389, username: keyUser(target.key), password: '', certificate: '' }
    }
    // The host's reason, as much of it as a status line shows: the host decides how long the line is.
    const err = /^RD_ERR (.{0,1000})/m.exec(out)
    if (err) {
        throw new Error(err[1])
    }
    const ok = /^RD_OK port=(\d+) user=(\S+) pass=(\S+) cert=(\S+)$/m.exec(out)
    const xrdp = /^RD_XRDP port=(\d+) user=(\S*)$/m.exec(out)
    if (ok) {
        const certificate = normalizeFingerprint(ok[4])
        if (!certificate) {
            // What the host put there, as long as it likes: as much of it as a fingerprint takes, for a status line.
            throw new Error(`Remote setup reported no usable certificate fingerprint (${ok[4].slice(0, 100)})`)
        }
        const clients = Number(/^RD_CLIENTS (\d+)$/m.exec(out)?.[1] ?? 0)
        const taken = /^RD_TAKEN_OVER (\S+) (\d+)$/m.exec(out)
        return {
            kind: 'gnome', port: Number(ok[1]), username: ok[2], password: ok[3], certificate, xrdpPort: xrdp ? Number(xrdp[1]) : undefined, xrdpUser: xrdp?.[2],
            clients, takenOver: taken && taken[1] !== client ? Number(taken[2]) : undefined, deskKey: /^RD_DESK ([0-9a-f]{32})$/m.exec(out)?.[1],
            notes: [...out.matchAll(/^RD_NOTE (.+)$/gm)].map(m => m[1]),
        }
    }
    if (xrdp) {
        // xrdp makes its own certificate: trusted on first use, like a desktop behind the host.
        return { kind: 'xrdp', port: Number(xrdp[1]), username: xrdp[2], password: '', certificate: '', xrdpPort: Number(xrdp[1]), xrdpUser: xrdp[2] }
    }
    throw new Error('Remote setup gave no result')
}
