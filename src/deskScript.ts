import { createHash } from 'crypto'

/**
 * `desk` on the remote prints OSC 7777 ("desk;<session>;<socket>;<cwd>;<kind>;<machine>;<hostname>;<key>", each
 * base64) — directly from a trd-pty session, via passthrough from tmux. It asks Tabby to show that machine's desktop
 * with this console (its shared session) attached in a terminal there, or a new terminal in the same folder outside
 * one. Anything shown in a terminal can carry the same bytes (a file, a log, another machine's output), so a request
 * only counts with desk's key (see openConsole).
 */
export interface DeskRequest {
    /** The shared session: a trd-pty session id, or a tmux session name. */
    session: string
    /** tmux: the server's socket path (trd-pty finds its sessions by id). */
    socket: string
    cwd: string
    /** 'native' (trd-pty), 'tmux', or '' when `desk` ran outside a shared session. */
    kind: string
    /** The machine `desk` ran on: its /etc/machine-id (or host name). */
    machine: string
    /** Its host name, for messages. */
    hostname: string
    /**
     * desk's key on that machine (`~/.local/share/tabby-rdp/desk-key`, which only the user can read there; its setup
     * tells the plugin). '' when missing or malformed: `desk` from an earlier tabby-rdp, or not `desk` at all.
     */
    key: string
}

/** desk's key: 128 random bits in hex, made by the setup (remoteSetup.ts). */
const DESK_KEY = /^[0-9a-f]{32}$/

/** A request's fields, from what follows `desk;`. */
export function parseDeskRequest (payload: string): DeskRequest {
    const [session, socket, cwd, kind, machine, hostname, key] = payload.split(';').map(f => Buffer.from(f, 'base64').toString('utf8'))
    return {
        session: session ?? '', socket: socket ?? '', cwd: cwd ?? '', kind: kind ?? '',
        machine: machine?.trim() ?? '', hostname: hostname?.trim() ?? '', key: DESK_KEY.test(key ?? '') ? key : '',
    }
}

/** What the plugin keeps of a host's desk key: its SHA-256, so that the config never holds the key. '' for no key. */
export function deskKeyDigest (key: string | undefined): string {
    return key && DESK_KEY.test(key) ? createHash('sha256').update(key).digest('hex') : ''
}

const PREFIX = Buffer.from('\x1b]7777;')
const DESK = Buffer.from('desk;')
const PROBE = Buffer.from('probe;')
const BEL = 0x07
const ESC = 0x1b

/** Whether `data` has `prefix` at `at`, before `end`. */
function startsAt (data: Buffer, prefix: Buffer, at: number, end: number): boolean {
    return end - at >= prefix.length && data.compare(prefix, 0, prefix.length, at, at + prefix.length) === 0
}

/**
 * Takes the plugin's OSC 7777 messages out of a chunk of terminal output: one `desk` request (output can repeat one any
 * number of times; one is all a chunk gets), the last one that `counts` (its key: see DeskRequests), so that a
 * look-alike after it can't stand in its place; how many others were looked at and didn't count; and probes (see
 * probe.ts).
 */
export function takeDeskMessages (data: Buffer, counts: (request: DeskRequest) => boolean = () => true): { output: Buffer, desk: DeskRequest | null, ignored: number, probes: string[] } {
    const kept: Buffer[] = []
    const probes: string[] = []
    // Where each desk request's fields are (start, end), read from the last one back once all are out of the output.
    const desks: number[] = []
    let from = 0
    for (let start = data.indexOf(PREFIX); start !== -1; start = data.indexOf(PREFIX, from)) {
        const body = start + PREFIX.length
        // The first BEL or ST (ESC \) ends it; one pass, so many messages in a chunk cost no more than its length.
        let end = body
        while (end < data.length && data[end] !== BEL && !(data[end] === ESC && data[end + 1] === 0x5c)) {
            end++
        }
        if (end >= data.length) {
            break
        }
        kept.push(data.subarray(from, start))
        from = end + (data[end] === BEL ? 1 : 2)
        if (startsAt(data, DESK, body, end)) {
            desks.push(body + DESK.length, end)
        } else if (startsAt(data, PROBE, body, end)) {
            probes.push(data.subarray(body + PROBE.length, end).toString('utf8'))
        }
    }
    let desk: DeskRequest | null = null
    let ignored = 0
    for (let i = desks.length - 2; i >= 0 && !desk; i -= 2) {
        const request = parseDeskRequest(data.subarray(desks[i], desks[i + 1]).toString('utf8'))
        if (counts(request)) {
            desk = request
        } else {
            ignored++
        }
    }
    const output = from === 0 ? data : Buffer.concat([...kept, data.subarray(from)])
    return { output, desk, ignored, probes }
}

/** How long a pane ignores `desk` requests after handling one. */
export const DESK_COOLDOWN_MS = 2000

/** How many keys' lookups a chunk of output keeps, to look each of them up once (see DeskRequests.take). */
const KEYS_KEPT = 16

/**
 * The time the cooldowns go by: a clock that only goes forward. The time of day can step back (set by hand, or
 * corrected after sleep), which would keep `desk` quiet for as long as the step.
 */
const monotonic = () => performance.now()

/**
 * A terminal's `desk` requests as its output brings them, before any goes further: only one with a key `known` (a key
 * some host's setup gave this plugin, see RemoteDesktopService.knowsDeskKey), and then none for the cooldown. Output
 * can carry any number of look-alikes, in one chunk or in many, and each request let through takes a turn of Tabby's
 * window (and, past the key check there, commands on a host): the others end here, as they are read. Those without a
 * known key get a line in the developer console, at most one per cooldown.
 */
export class DeskRequests {
    private quietUntil = 0
    private unknown = 0
    private warnAfter = 0

    constructor (
        private known: (key: string) => boolean,
        private cooldownMs = DESK_COOLDOWN_MS,
        private now: () => number = monotonic,
        private warn: (message: string) => void = message => console.warn(message),
    ) { }

    /** Takes the plugin's messages out of a chunk of output (see takeDeskMessages): the request to act on, if any. */
    take (data: Buffer): { output: Buffer, desk: DeskRequest | null, probes: string[] } {
        // A flood repeats a few keys, one or several in turn: each is looked up once per chunk. A few are kept, not all
        // of them (a flood of different ones costs a lookup each whatever is kept, and holds no more memory for it),
        // and the last one besides, so that one repeated past them isn't looked up again each time either.
        const looked = new Map<string, boolean>()
        let last: { key: string, known: boolean } | null = null
        const counts = (request: DeskRequest) => {
            if (last?.key === request.key) {
                return last.known
            }
            let known = looked.get(request.key)
            if (known === undefined) {
                known = !!request.key && this.known(request.key)
                if (looked.size < KEYS_KEPT) {
                    looked.set(request.key, known)
                }
            }
            last = { key: request.key, known }
            return known
        }
        const { output, desk, ignored, probes } = takeDeskMessages(data, counts)
        const now = this.now()
        this.unknown += ignored
        if (this.unknown && now >= this.warnAfter) {
            this.warn(`desk: ignored ${this.unknown === 1 ? 'a request' : `${this.unknown} requests`} without a key from a host whose desktop this Tabby set desk up on`)
            this.unknown = 0
            this.warnAfter = now + this.cooldownMs
        }
        if (!desk || now < this.quietUntil) {
            return { output, desk: null, probes }
        }
        this.quietUntil = now + this.cooldownMs
        return { output, desk, probes }
    }
}

/**
 * One `desk` request at a time per pane, and none for a moment after one: output can repeat a request any number of
 * times, and each one costs commands on the host (and a `ps` here, for a local terminal).
 */
export class DeskGate {
    private busy = false
    private until = 0

    constructor (private cooldownMs = DESK_COOLDOWN_MS, private now: () => number = monotonic) { }

    /** Runs `task`, unless one runs or the last one ended less than the cooldown ago (false: dropped). */
    async run (task: () => Promise<void>): Promise<boolean> {
        if (this.busy || this.now() < this.until) {
            return false
        }
        this.busy = true
        try {
            await task()
        } finally {
            this.busy = false
            this.until = this.now() + this.cooldownMs
        }
        return true
    }
}

/** Remote command printing what `desk` sends as `machine`. */
export const MACHINE_ID_COMMAND = 'cat /etc/machine-id 2>/dev/null || hostname'

/** Single-quotes a value for sh. */
export function shq (value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Remote script: open a maximized terminal on the headless desktop, attached to the given shared session (unless
 * something already is), or in the given folder. Only sessions of this user's own: a trd-pty session by its id (trd-pty
 * looks it up in its private folder and checks who serves it), or a tmux server whose socket this user owns, in tmux's
 * folder for them. Prints `RD_OK …` or `RD_ERR …`.
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
# A tmux client attaches to whatever server answers on the socket it is given, and another user can let anyone in to
# theirs. So only a socket of this user's, in tmux's folder for them (theirs, no access for others, as tmux makes it),
# with no symbolic link on the way, and every folder above it root's or this user's, where others can't rename or
# replace anything (or only their own entries: sticky, like /tmp): nobody else can swap the path out before the attach,
# later, finds the socket again. (ls -n's first and third fields, its mode and owner, are the portable way to read them.)
own_tmux () {
    [ -S "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ "$(readlink -f "$1" 2>/dev/null)" = "$1" ] || return 1
    ot_uid=$(id -u)
    ot_dir=${"$"}{1%/*}
    [ "${"$"}{ot_dir##*/}" = "tmux-$ot_uid" ] && [ -O "$ot_dir" ] || return 1
    case $(ls -ld "$ot_dir") in d???------*) ;; *) return 1 ;; esac
    ot_up=${"$"}{ot_dir%/*}
    while :; do
        set -- $(ls -ldn "$ot_up/")
        [ "$3" = "$ot_uid" ] || [ "$3" = 0 ] || return 1
        case $1 in d????[!w]??[!w]*|d????????[tT]*) ;; *) return 1 ;; esac
        case $ot_up in '') return 0 ;; /*) ot_up=${"$"}{ot_up%/*} ;; *) return 1 ;; esac
    done
}
# Session names as trd-pty and tmux make them (tmux never puts : or . in one); anything else opens a terminal in the
# folder instead. A tmux name is otherwise any: it only picks among the sessions of a server of this user's own.
case $KIND in
    native) case $SESS in ''|*[!0-9a-f]*) KIND= ;; esac ;;
    tmux) case $SESS in ''|*[:.]*) KIND= ;; esac ;;
    *) KIND= ;;
esac
if [ "$KIND" = native ] && [ -x "$TRD" ] && [ "$("$TRD" clients "$SESS")" -ge 1 ]; then
    # The console itself is one attached terminal; a second one means a desktop terminal is already attached.
    if [ "$("$TRD" clients "$SESS")" -ge 2 ]; then
        echo "RD_OK attached"; exit 0
    fi
    gnome-terminal --maximize -- "$TRD" attach "$SESS" >/dev/null 2>&1 \
        && echo "RD_OK opened" || echo "RD_ERR could not open a terminal"
elif [ "$KIND" = tmux ] && own_tmux "$SOCK" && tmux -S "$SOCK" has-session -t "=$SESS" 2>/dev/null; then
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
