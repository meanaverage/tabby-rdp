import { DesktopSpec } from './desktops'
import { RemoteTarget } from './targets'

/** A virtual machine on an SSH host (libvirt) that looks like it has a desktop to connect to. */
export interface FoundVM {
    name: string
    /** 'running', or 'off' (shut off, paused, suspended: started when opened). */
    state: 'running' | 'off'
    windows: boolean
    /** Its IPv4 address as the host sees it: live, or for one that's off, its DHCP reservation or last lease. */
    address: string
    /** Running, and its RDP port answered just now. */
    rdp: boolean
}

/**
 * RDP security the server chose when offered TLS and NLA (RDP_NEG_RSP): Windows and GNOME Remote Desktop take NLA
 * (2), xrdp only TLS (1). A Linux VM that takes NLA is GNOME's, whose sign-in the plugin manages over SSH to that VM:
 * not one to offer here.
 */
const XRDP_LIKE = '1'

// For each libvirt domain of the SSH user (system instance, then session), one line:
// TRD_VM <name>|<state>|<os id>|<address>|<rdp>. The address: live (guest agent, DHCP lease, ARP), else the DHCP
// reservation or lease for its MAC in its network. RDP: an X.224 connection request must get a TPKT reply (as in
// wake.ts) within a second; the protocol the server chose, or 0 without a negotiation response ('' if none).
// Read-only: starts nothing, changes nothing.
const SCAN_SCRIPT = String.raw`
command -v virsh >/dev/null 2>&1 || exit 0
probe () {
    if command -v python3 >/dev/null 2>&1; then
        python3 -c '
import socket, sys
try:
    s = socket.create_connection((sys.argv[1], 3389), 1); s.settimeout(1)
    s.sendall(bytes.fromhex("030000130ee000000000000100080003000000")); r = s.recv(64)
    print("" if r[:2] != b"\x03\x00" else int.from_bytes(r[15:19], "little") if len(r) >= 19 and r[11] == 2 else 0)
except Exception:
    print("")
' "$1"
    else
        timeout 1 bash -c 'exec 3<>"/dev/tcp/$0/3389"' "$1" >/dev/null 2>&1 && echo 0
    fi
}
for uri in qemu:///system qemu:///session; do
    virsh -q -c "$uri" list --all --name 2>/dev/null | while IFS= read -r d; do
        [ -n "$d" ] || continue
        state=$(virsh -c "$uri" domstate "$d" 2>/dev/null | head -n 1)
        os=$(virsh -c "$uri" dumpxml "$d" 2>/dev/null | sed -n 's/.*libosinfo:os id="\([^"]*\)".*/\1/p' | head -n 1)
        ip=
        if [ "$state" = running ]; then
            for src in agent lease arp; do
                ip=$(virsh -c "$uri" domifaddr "$d" --source "$src" 2>/dev/null | awk '$3 == "ipv4" { split($4, a, "/"); if (a[1] !~ /^(127|169\.254)\./) { print a[1]; exit } }')
                [ -n "$ip" ] && break
            done
        fi
        if [ -z "$ip" ]; then
            set -- $(virsh -c "$uri" domiflist "$d" 2>/dev/null | awk '$2 == "network" { print $3, $5; exit }')
            if [ -n "${"$"}{2:-}" ]; then
                ip=$(virsh -c "$uri" net-dumpxml "$1" 2>/dev/null | tr -d '\n' | grep -o "<host [^>]*mac=.$2[^>]*>" | sed -n "s/.*ip=.\([0-9.]*\).*/\1/p" | head -n 1)
                [ -n "$ip" ] || ip=$(virsh -c "$uri" net-dhcp-leases "$1" --mac "$2" 2>/dev/null | awk '$4 == "ipv4" { split($5, a, "/"); print a[1]; exit }')
            fi
        fi
        rdp=
        [ "$state" = running ] && [ -n "$ip" ] && rdp=$(probe "$ip")
        printf 'TRD_VM %s|%s|%s|%s|%s\n' "$d" "$state" "$os" "$ip" "$rdp"
    done
done
`

/** The host's VMs that have (or, being off, may have) a desktop: running ones whose RDP answers, and Windows ones that are off. */
export async function scanVMs (target: RemoteTarget): Promise<FoundVM[]> {
    const out = await target.exec('sh -s', SCAN_SCRIPT)
    const found: FoundVM[] = []
    for (const line of out.split('\n')) {
        const m = /^TRD_VM ([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)\|(\d*)\s*$/.exec(line.trim())
        if (!m) {
            continue
        }
        const [, name, state, os, address, protocol] = m
        const windows = /microsoft\.com\/win/i.test(os)
        // Windows: RDP answering, or off (started when opened). Others: only xrdp (see XRDP_LIKE).
        const rdp = windows ? protocol !== '' : protocol === XRDP_LIKE
        const vm: FoundVM = { name, state: state === 'running' ? 'running' : 'off', windows, address, rdp }
        if (vm.address && (vm.rdp || vm.state === 'off' && vm.windows) && !found.some(f => f.name === vm.name)) {
            found.push(vm)
        }
    }
    return found
}

/** A found VM as a desktop behind its host: started by name when it's off (see wake.ts). */
export function vmSpec (vm: FoundVM): DesktopSpec {
    return {
        id: `${vm.address}:3389`,
        name: vm.name,
        kind: vm.windows ? 'windows' : 'xrdp',
        host: vm.address,
        port: 3389,
        wake: { vm: vm.name },
        found: vm.state,
    }
}
