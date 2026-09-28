/**
 * `desk` on the remote prints OSC 7777 ("desk;<session>;<socket>;<cwd>;<kind>", each base64) —
 * directly from a trd-pty session, via passthrough from tmux. It asks Tabby to show that machine's desktop with this console (its tmux
 * session) attached in a terminal there, or a new terminal in the same folder outside tmux.
 */
export interface DeskRequest {
    /** tmux session name, if `desk` ran inside tmux. */
    session: string
    /** Session socket path (tmux server, or trd-pty session). */
    socket: string
    cwd: string
    /** 'native' (trd-pty), 'tmux', or '' when `desk` ran outside a shared session. */
    kind: string
    /** The machine `desk` ran on: its /etc/machine-id (or host name); '' from older `desk` scripts. */
    machine: string
    /** Its host name, for messages. */
    hostname: string
}

/** Remote command printing what `desk` sends as `machine`. */
export const MACHINE_ID_COMMAND = 'cat /etc/machine-id 2>/dev/null || hostname'

/** Single-quotes a value for sh. */
export function shq (value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Remote script: open a maximized terminal on the headless desktop, attached to the given tmux
 * session (unless something already is), or in the given folder. Prints `RD_OK …` or `RD_ERR …`.
 */
export function consoleScript (request: DeskRequest): string {
    return `SESS=${shq(request.session)}
SOCK=${shq(request.socket)}
DIR=${shq(request.cwd)}
KIND=${shq(request.kind)}
` + String.raw`
command -v gnome-terminal >/dev/null 2>&1 || { echo "RD_ERR gnome-terminal is not installed"; exit 0; }
W=$(systemctl --user show-environment 2>/dev/null | sed -n 's/^WAYLAND_DISPLAY=//p')
export WAYLAND_DISPLAY=${"$"}{W:-wayland-0}
TRD="$HOME/.local/share/tabby-rdp/bin/trd-pty"
if [ "$KIND" = native ] && [ -n "$SESS" ] && [ -x "$TRD" ] && [ "$("$TRD" clients "$SESS")" -ge 1 ]; then
    # The console itself is one attached terminal; a second one means a desktop terminal is already attached.
    if [ "$("$TRD" clients "$SESS")" -ge 2 ]; then
        echo "RD_OK attached"; exit 0
    fi
    gnome-terminal --maximize -- "$TRD" attach "$SESS" >/dev/null 2>&1 \
        && echo "RD_OK opened" || echo "RD_ERR could not open a terminal"
elif [ -n "$SESS" ] && [ -S "$SOCK" ] && tmux -S "$SOCK" has-session -t "=$SESS" 2>/dev/null; then
    # The console itself is one client; a second one means a desktop terminal is already attached.
    if [ "$(tmux -S "$SOCK" list-clients -t "=$SESS" 2>/dev/null | wc -l)" -ge 2 ]; then
        echo "RD_OK attached"; exit 0
    fi
    gnome-terminal --maximize -- tmux -S "$SOCK" attach-session -t "=$SESS" >/dev/null 2>&1 \
        && echo "RD_OK opened" || echo "RD_ERR could not open a terminal"
else
    [ -d "$DIR" ] || DIR=$HOME
    gnome-terminal --maximize --working-directory="$DIR" >/dev/null 2>&1 \
        && echo "RD_OK opened-folder" || echo "RD_ERR could not open a terminal"
fi
`
}
