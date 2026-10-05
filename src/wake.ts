import { shq } from './deskScript'
import { hyperVState, startHyperV, vmId } from './hyperv'
import { configNumber } from './osd'
import { RemoteTarget } from './targets'

/**
 * `wake` of a desktop behind a host: how to start it when it is off. `vm`: a libvirt domain on the SSH host,
 * started with `virsh` as the SSH user. `mac`: a Wake-on-LAN magic packet, sent from the SSH host (UDP broadcast,
 * by default to 255.255.255.255 port 9). `hyperv`: a Hyper-V VM on a Windows SSH host, by its id, started with
 * Start-VM as the SSH user.
 */
export type WakeSpec = { vm: string } | { mac: string, broadcast?: string, port?: number } | { hyperv: string }

const MAC = /^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/i
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** A `wake` config value, checked; undefined when absent or unusable. */
export function parseWake (raw: any): WakeSpec | undefined {
    if (vmId(raw?.hyperv)) {
        return { hyperv: vmId(raw.hyperv) }
    }
    if (typeof raw?.vm === 'string' && raw.vm.trim()) {
        return { vm: raw.vm.trim() }
    }
    const mac = typeof raw?.mac === 'string' ? raw.mac.trim() : ''
    if (MAC.test(mac)) {
        const port = configNumber(raw.port ?? 9)
        return {
            mac,
            ...typeof raw.broadcast === 'string' && IPV4.test(raw.broadcast.trim()) ? { broadcast: raw.broadcast.trim() } : {},
            ...Number.isInteger(port) && port > 0 && port < 65536 && port !== 9 ? { port } : {},
        }
    }
    return undefined
}

/** The add-desktop form's wake field: a MAC address means Wake-on-LAN, anything else names a libvirt VM. */
export function wakeFromText (text: string): WakeSpec | undefined {
    const value = text.trim()
    return !value ? undefined : MAC.test(value) ? { mac: value } : { vm: value }
}

// Whether an RDP server answers at $H:$P, as seen from the SSH host: an X.224 connection request must get a TPKT
// reply, since a port can accept connections before the server behind it does (QEMU's user-mode port forwarding,
// for one). Without python3, an open TCP port will do.
const PROBE_SCRIPT = String.raw`
if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import socket, sys
try:
    s = socket.create_connection((sys.argv[1], int(sys.argv[2])), 3)
    s.settimeout(3)
    s.sendall(bytes.fromhex("030000130ee000000000000100080003000000"))
    print("RD_OPEN" if s.recv(2) == b"\x03\x00" else "RD_CLOSED")
except Exception:
    print("RD_CLOSED")
' "$H" "$P"
elif command -v nc >/dev/null 2>&1; then
    nc -z -w 3 "$H" "$P" >/dev/null 2>&1 && echo RD_OPEN || echo RD_CLOSED
else
    timeout 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$H" "$P" >/dev/null 2>&1 && echo RD_OPEN || echo RD_CLOSED
fi
`

// Starts (or resumes) the libvirt domain $VM as the SSH user: the system instance first, where VMs usually are
// (needs the libvirt group or polkit), then the user's own session instance.
const VM_SCRIPT = String.raw`
command -v virsh >/dev/null 2>&1 || { echo "RD_ERR virsh is not installed on the SSH host"; exit 0; }
errors=""
for uri in qemu:///system qemu:///session; do
    if ! state=$(virsh -c "$uri" domstate "$VM" 2>&1); then
        errors="$errors${"$"}{errors:+; }$uri: $(printf '%s' "$state" | tr '\n' ' ' | sed 's/^error: //' | cut -c1-160)"
        continue
    fi
    case $(printf '%s\n' "$state" | head -n 1) in
        running) echo "RD_OK $VM is already running ($uri)"; exit 0 ;;
        paused) how=resumed; out=$(virsh -c "$uri" resume "$VM" 2>&1) ;;
        pmsuspended) how="woken up"; out=$(virsh -c "$uri" dompmwakeup "$VM" 2>&1) ;;
        *) how=started; out=$(virsh -c "$uri" start "$VM" 2>&1) ;;
    esac && { echo "RD_OK $VM $how ($uri)"; exit 0; }
    echo "RD_ERR virsh: $(printf '%s' "$out" | tr '\n' ' ' | sed 's/^error: //' | cut -c1-240)"
    exit 0
done
echo "RD_ERR no libvirt VM named $VM for this user ($errors)"
`

// A Wake-on-LAN magic packet ($MAC 16 times after 6 bytes of 0xff) to $BCAST:$PORT, with the standard library.
const WOL_SCRIPT = String.raw`
command -v python3 >/dev/null 2>&1 || { echo "RD_ERR sending Wake-on-LAN needs python3 on the SSH host"; exit 0; }
python3 -c '
import socket, sys
mac = bytes.fromhex(sys.argv[1].replace(":", "").replace("-", ""))
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
s.sendto(b"\xff" * 6 + mac * 16, (sys.argv[2], int(sys.argv[3])))
print("RD_OK Wake-on-LAN sent to %s via %s:%s" % tuple(sys.argv[1:4]))
' "$MAC" "$BCAST" "$PORT" 2>&1 || echo "RD_ERR could not send the Wake-on-LAN packet"
`

// Leaves a watcher on the SSH host that shuts the libvirt domain $VM down once no connection to its RDP server ($H:$P)
// has been open through this host for $IDLE seconds, then ends; it also ends when the VM stops running some other way.
// On the host rather than in Tabby, so it works after the tab closes, the SSH connection drops or Tabby quits. One per
// VM (a pid file). Detached (setsid, no terminal), it outlives the SSH session where logind lets user processes stay
// (KillUserProcesses=no, most distributions' default).
const IDLE_SCRIPT = String.raw`
command -v virsh >/dev/null 2>&1 || { echo "RD_ERR virsh is not installed on the SSH host"; exit 0; }
command -v ss >/dev/null 2>&1 || { echo "RD_ERR ss (iproute2) is not installed on the SSH host"; exit 0; }
# The pid file: with the plugin's other files, or where the home folder isn't writable, in a folder of its own in /tmp.
# Private either way, as the desktop's setup keeps it (this may be the first to make it).
D="$HOME/.local/share/tabby-rdp"
if ! { mkdir -p "$D" && chmod 700 "$D"; } 2>/dev/null; then
    D="/tmp/tabby-rdp-$(id -u)"
    mkdir -p -m 700 "$D" 2>/dev/null
    # One that was there already keeps its mode (mkdir -m only sets one it makes): made private here, or not used.
    [ -d "$D" ] && [ -O "$D" ] && [ ! -L "$D" ] && chmod 700 "$D" 2>/dev/null || { echo "RD_ERR could not create a folder for the watcher's pid file"; exit 0; }
fi
PIDF="$D/idle-$(printf %s "$VM" | tr -c 'A-Za-z0-9._-' _).pid"
if [ -s "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    echo "RD_OK a watcher for $VM already runs"; exit 0
fi
URI=
for u in qemu:///system qemu:///session; do
    [ "$(virsh -c "$u" domstate "$VM" 2>/dev/null | head -n 1)" = running ] && { URI=$u; break; }
done
[ -n "$URI" ] || { echo "RD_ERR $VM is not running"; exit 0; }
A=$(getent ahostsv4 "$H" 2>/dev/null | awk 'NR == 1 { print $1 }')
# The watcher writes its pid file anew (umask 077): one left by an earlier version keeps its mode otherwise.
rm -f "$PIDF"
nohup setsid sh -c '
VM=$1 URI=$2 A=$3 P=$4 IDLE=$5 PIDF=$6
umask 077
echo $$ > "$PIDF"
trap "rm -f \"$PIDF\"" EXIT
idle=0 asked=0
while sleep 30; do
    [ "$(virsh -c "$URI" domstate "$VM" 2>/dev/null | head -n 1)" = running ] || exit 0
    if ss -tnH state established dst "$A:$P" 2>/dev/null | grep -q .; then idle=0; asked=0; continue; fi
    idle=$((idle + 30))
    [ $idle -ge $IDLE ] || continue
    # Asked again every 2 minutes while it keeps running, 5 times at most. Windows ignores the request while its screen
    # sleeps: a Shift press wakes the screen first.
    if [ $(( (idle - IDLE) % 120 )) -eq 0 ]; then
        asked=$((asked + 1))
        [ $asked -le 5 ] || exit 0
        virsh -c "$URI" send-key "$VM" KEY_LEFTSHIFT >/dev/null 2>&1
        virsh -c "$URI" shutdown "$VM" >/dev/null 2>&1
    fi
done
' sh "$VM" "$URI" "${"$"}{A:-$H}" "$P" "$IDLE" "$PIDF" </dev/null >/dev/null 2>&1 &
echo "RD_OK $VM shuts down after $((IDLE / 60)) min without a desktop open ($URI)"
`

/**
 * Leaves a watcher on the SSH host that shuts the VM down once its desktop (host:port, as the SSH host reaches it) has
 * had no connection through that host for `idleSeconds` (counted in steps of 30 s). Resolves with what was done; throws with the reason when it
 * couldn't.
 */
export async function shutDownWhenIdle (target: RemoteTarget, vm: string, host: string, port: number, idleSeconds: number): Promise<string> {
    const out = await target.exec('sh -s', `VM=${shq(vm)}\nH=${shq(host)}\nP=${port}\nIDLE=${Math.max(1, Math.round(idleSeconds / 30)) * 30}\n${IDLE_SCRIPT}`)
    // The host's words, as much of them as the log shows: the host decides how long its lines are.
    const err = /^RD_ERR (.{0,1000})/m.exec(out)
    if (err) {
        throw new Error(err[1].trim())
    }
    return /^RD_OK (.{0,1000})/m.exec(out)?.[1] ?? 'no result'
}

/** Whether the RDP server at host:port answers, as seen from the SSH host. */
export async function rdpAnswers (target: RemoteTarget, host: string, port: number): Promise<boolean> {
    const out = await target.exec('sh -s', `H=${shq(host)}\nP=${port}\n${PROBE_SCRIPT}`)
    return /^RD_OPEN$/m.test(out)
}

/** Whether the desktop is up: its RDP server answers, or, for a Hyper-V VM (reached through its host), it runs. */
export async function desktopUp (target: RemoteTarget, host: string, port: number, wake?: WakeSpec): Promise<boolean> {
    return wake && 'hyperv' in wake ? (await hyperVState(target, wake.hyperv)).running : rdpAnswers(target, host, port)
}

/** Starts the desktop as `wake` says. Resolves with what was done; throws with the reason when it couldn't. */
export async function wakeDesktop (target: RemoteTarget, wake: WakeSpec): Promise<string> {
    if ('hyperv' in wake) {
        return startHyperV(target, wake.hyperv)
    }
    const script = 'vm' in wake
        ? `VM=${shq(wake.vm)}\n${VM_SCRIPT}`
        : `MAC=${shq(wake.mac)}\nBCAST=${shq(wake.broadcast ?? '255.255.255.255')}\nPORT=${wake.port ?? 9}\n${WOL_SCRIPT}`
    const out = await target.exec('sh -s', script)
    // The host's words, as much of them as a status line shows (see shutDownWhenIdle).
    const err = /^RD_ERR (.{0,1000})/m.exec(out)
    if (err) {
        throw new Error(err[1].trim())
    }
    return /^RD_OK (.{0,1000})/m.exec(out)?.[1] ?? 'no result'
}

/**
 * Probes until the desktop is up (true; see desktopUp), the time is up or `stopped()` (false). At most one probe
 * every 3 s; `progress` is called every 5 s.
 */
export async function waitForRdp (
    target: RemoteTarget, host: string, port: number, timeoutMs: number, stopped: () => boolean, progress: () => void, wake?: WakeSpec,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const ticker = setInterval(() => stopped() || progress(), 5000)
    try {
        while (Date.now() < deadline && !stopped()) {
            const started = Date.now()
            if (await desktopUp(target, host, port, wake).catch(() => false)) {
                return !stopped()
            }
            await new Promise(resolve => setTimeout(resolve, Math.max(0, 3000 - (Date.now() - started))))
        }
        return false
    } finally {
        clearInterval(ticker)
    }
}
