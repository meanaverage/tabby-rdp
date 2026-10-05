import { isIPv4 } from 'net'
import { DesktopSpec, hyperVSpec } from './desktops'
import { MAX_VMS, scanHyperV } from './hyperv'
import { RemoteTarget } from './targets'

/**
 * A virtual machine on an SSH host that looks like it has a desktop to connect to: a libvirt VM whose RDP server
 * answers (or a Windows one that is off), or, on a Windows host, a Hyper-V VM (its console, through the host).
 */
export interface FoundVM {
    /** A Hyper-V VM's id (see hyperv.ts); the address and RDP fields don't apply to it. */
    hyperv?: string
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
echo TRD_SH
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

/**
 * The host's VMs that have (or, being off, may have) a desktop: libvirt's running ones whose RDP answers, and Windows
 * ones that are off; on a Windows host, Hyper-V's. `host.windows` says the host is known to run Windows, and is set
 * when the scan finds out: such a host isn't asked for libvirt again (its shell takes a while to say it has no sh).
 * `host.cut` says whether the list stopped at MAX_VMS (each VM is a menu item) with more there, so that the menu can
 * say only so many are listed.
 */
export async function scanVMs (target: RemoteTarget, host: { windows?: boolean, cut?: boolean } = {}): Promise<FoundVM[]> {
    const out = host.windows ? '' : await target.exec('sh -s', SCAN_SCRIPT)
    // No sh answered: a Windows host (cmd.exe or PowerShell as its SSH shell), which is where Hyper-V is. Asked only
    // then, so that a Linux host costs nothing extra.
    if (!/^TRD_SH$/m.test(out)) {
        const vms = await scanHyperV(target, host)
        host.windows = true
        return vms.map(vm => ({ hyperv: vm.id, name: vm.name, state: vm.state, windows: true, address: '', rdp: false }))
    }
    const found: FoundVM[] = []
    // Names seen so far: looked up, not searched for, so that the time taken grows with the lines, not their square.
    const names = new Set<string>()
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
        // An IPv4 address, as the scan only ever finds: the address is part of the VM's session key, which is also the
        // key its saved password is kept under. Anything else (`10.0.0.5:3389@gateway#gw.example`) could make that the
        // key of a desktop configured behind this host, a password saved for its gateway included (see keyParts).
        if (isIPv4(vm.address) && (vm.rdp || vm.state === 'off' && vm.windows) && !names.has(vm.name)) {
            // One more than are listed: the list is cut short.
            if (found.length === MAX_VMS) {
                host.cut = true
                return found
            }
            names.add(vm.name)
            found.push(vm)
        }
    }
    host.cut = false
    return found
}

/** A found VM as a desktop behind its host: started by name when it's off (see wake.ts). */
export function vmSpec (vm: FoundVM): DesktopSpec {
    if (vm.hyperv) {
        return hyperVSpec(vm.hyperv, vm.name, { found: vm.state })
    }
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
