#!/bin/sh
# Creates a Windows Server test machine as a libvirt VM: a Hyper-V host with a guest VM in it, and an RD Gateway, for
# the two ways to a desktop that need a server (a VM's console through its Hyper-V host; a desktop behind a gateway).
# Installed unattended from Microsoft's Windows Server 2025 evaluation ISO (180 days), prepared with
# ../windows/setup.ps1 (Remote Desktop, WinRM, the test account) and server.ps1 (the roles, the gateway's policies,
# the guest). Run it on the libvirt host that runs the Linux test host (testbed/linux/libvirt.sh), as a user in the
# libvirt group (no root needed); it needs virt-install, genisoimage and swtpm.
#
# Hyper-V in a VM needs nested virtualization: the host's KVM with `nested` on (kvm_intel or kvm_amd; check
# /sys/module/kvm_*/parameters/nested). It also works where the libvirt host is itself a VM, if its own host passes
# virtualization on; the guest VM is slow there, not broken.
#
#     TEST_PASSWORD=... testbed/windows-server/libvirt.sh [vm-name] [windows-server-iso]
#
# Defaults: tabby-rdp-winserver, and the evaluation ISO, downloaded into $TESTBED_DIR (default
# ~/.cache/tabby-rdp-testbed; 6 GB). TEST_PASSWORD is for the test account, tabbyrdp, here and in the guest VM, and
# has to meet Windows Server's complexity rules (three of: capitals, small letters, digits, symbols); ADMIN_PASSWORD,
# for the administrator account, tabbyadmin, is random unless set. It takes 16 GB of memory and one CPU (VCPUS) while it runs,
# and up to 120 GB of disk. Installing takes one to two hours on one CPU.
#
# Remove it with: virsh destroy <name>; virsh undefine --nvram --tpm --remove-all-storage <name>
set -eu
NAME="${1:-tabby-rdp-winserver}"
ISO="${2:-}"
: "${TEST_PASSWORD:?set TEST_PASSWORD, the password for the test account}"
if [ -z "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')Aa1"
fi
for c in virsh virt-install genisoimage swtpm curl bash; do
    command -v $c >/dev/null || { echo "$c is not installed (virtinst, genisoimage, swtpm)" >&2; exit 2; }
done
HERE="$(cd "$(dirname "$0")" && pwd)"
URI="${LIBVIRT_DEFAULT_URI:-qemu:///system}"
V="virsh -c $URI"
WORK="${TESTBED_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tabby-rdp-testbed}"
mkdir -p "$WORK"
# Windows Server 2025 evaluation (180 days), x64, English, from Microsoft's Evaluation Center.
EVAL_URL='https://go.microsoft.com/fwlink/?linkid=2293312&clcid=0x409&culture=en-us&country=us'
if [ -z "$ISO" ]; then
    ISO="$WORK/winserver-eval.iso"
    [ -f "$ISO" ] || { curl -fL -o "$ISO.part" "$EVAL_URL" && mv "$ISO.part" "$ISO"; }
fi

# The config disc: the answer file (found by Windows Setup at the root of any disc), setup.ps1 and server.ps1.
# A value for the answer file: XML-escaped, then escaped for sed's replacement text.
answer_value() { printf %s "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e 's/[\\|&]/\\&/g'; }
CFG="$WORK/$NAME-config"
rm -rf "$CFG"; mkdir -p "$CFG"
COMPUTER=$(printf %s "$NAME" | tr -cd 'A-Za-z0-9-' | cut -c1-15)
ADMIN_VALUE=$(answer_value "$ADMIN_PASSWORD")
TEST_VALUE=$(answer_value "$TEST_PASSWORD")
# START_GUEST=0: the Windows guest is made but left off (see below, and server.ps1).
SERVER_ARGS=; [ "${START_GUEST:-1}" = 0 ] && SERVER_ARGS=-NoGuestStart
sed -e "s|@@COMPUTER_NAME@@|$COMPUTER|g" -e "s|@@ADMIN_USER@@|tabbyadmin|g" -e "s|@@TEST_USER@@|tabbyrdp|g" \
    -e "s|@@SERVER_ARGS@@|$SERVER_ARGS|g" \
    -e "s|@@ADMIN_PASSWORD@@|$ADMIN_VALUE|g" -e "s|@@TEST_PASSWORD@@|$TEST_VALUE|g" \
    "$HERE/autounattend.xml" > "$CFG/autounattend.xml"
cp "$HERE/../windows/setup.ps1" "$HERE/server.ps1" "$CFG/"
genisoimage -quiet -J -R -V TABBYRDP -o "$WORK/$NAME-config.iso" "$CFG"
rm -rf "$CFG"   # it holds the passwords

# A storage pool of the VM's name, with its disk and both discs, uploaded through libvirt (no root needed).
if ! $V pool-info "$NAME" >/dev/null 2>&1; then
    $V pool-define-as "$NAME" dir --target "/var/lib/libvirt/images/$NAME" >/dev/null
    $V pool-build "$NAME" >/dev/null
    $V pool-start "$NAME" >/dev/null
    $V pool-autostart "$NAME" >/dev/null
fi
$V dominfo "$NAME" >/dev/null 2>&1 && { echo "a VM named $NAME exists already" >&2; exit 1; }
upload() {  # upload <file> <volume>, replacing a volume left by an earlier run
    $V vol-delete --pool "$NAME" "$2" >/dev/null 2>&1 || true
    $V vol-create-as "$NAME" "$2" "$(wc -c < "$1")" --format raw >/dev/null
    $V vol-upload --pool "$NAME" "$2" "$1"
}
# The Windows ISO from an earlier run is kept if it is the same size (6 GB to upload otherwise).
if [ "$($V vol-info --pool "$NAME" windows.iso --bytes 2>/dev/null | awk '/Capacity/ { print $2 }')" != "$(wc -c < "$ISO")" ]; then
    upload "$ISO" windows.iso
fi
upload "$WORK/$NAME-config.iso" config.iso
rm -f "$WORK/$NAME-config.iso"
$V vol-delete --pool "$NAME" "$NAME.qcow2" >/dev/null 2>&1 || true
$V vol-create-as "$NAME" "$NAME.qcow2" 120G --format qcow2 >/dev/null

# SATA and e1000e: drivers Windows has without extra discs. host-passthrough: the CPU's virtualization, for Hyper-V.
# With Hyper-V on, Windows itself runs under its own hypervisor, one level further down than the VM. Where the
# libvirt host is a VM too (AMD, kernel 6.8), that is three levels, and the machine froze (every CPU spinning in the
# hypervisor) within minutes of starting until it got: one CPU (VCPUS), none of AMD's newer virtualization extras
# (virtual GIF and NMI, AVIC, LBR virtualization, pause filtering, TSC scaling; turning them off does nothing on
# Intel), and no Hyper-V enlightenments from KVM. Even so, a guest that starts an operating system froze it within
# a minute, Windows or Linux; a guest left at its firmware's screen didn't. So on such a host: START_GUEST=0, and
# the empty guest is what there is to connect to. On a libvirt host that isn't a VM itself, VCPUS=4 should do.
virt-install --connect "$URI" --name "$NAME" --osinfo win2k22 --import --memory 16384 --vcpus "${VCPUS:-1}" \
    --cpu host-passthrough,disable=vgif,disable=vnmi,disable=v-vmsave-vmload,disable=avic,disable=lbrv,disable=pause-filter,disable=pfthreshold,disable=tsc-scale \
    --features hyperv.relaxed.state=off,hyperv.vapic.state=off,hyperv.spinlocks.state=off \
    --boot uefi,firmware.feature0.name=secure-boot,firmware.feature0.enabled=yes,firmware.feature1.name=enrolled-keys,firmware.feature1.enabled=yes \
    --tpm backend.type=emulator,backend.version=2.0,model=tpm-crb \
    --disk "vol=$NAME/$NAME.qcow2,bus=sata,boot.order=2" --disk "vol=$NAME/windows.iso,device=cdrom,bus=sata,boot.order=1" \
    --disk "vol=$NAME/config.iso,device=cdrom,bus=sata" \
    --network network=default,model=e1000e --graphics vnc,listen=127.0.0.1 --noautoconsole >/dev/null

# Windows' boot manager waits for "Press any key to boot from CD or DVD": press it.
i=0; while [ $i -lt 15 ]; do sleep 1; $V send-key "$NAME" KEY_SPACE >/dev/null 2>&1 || true; i=$((i+1)); done

printf 'Installing Windows Server (30 to 60 minutes)'
IP=
i=0; while [ $i -lt 360 ]; do
    sleep 10; printf .; i=$((i+1))
    IP="$($V domifaddr "$NAME" 2>/dev/null | awk '/ipv4/ { sub(/\/.*/, "", $4); print $4; exit }')"
    # setup.ps1 turns on WinRM; server.ps1 then installs the roles and restarts.
    [ -n "$IP" ] && curl -s -o /dev/null --max-time 3 "http://$IP:5985/wsman" && break
done
echo
[ -n "$IP" ] || { echo "no address after an hour; look at it over VNC: $V vncdisplay $NAME" >&2; exit 1; }

# The roles, a restart, then the gateway and the guest VM (server.ps1's second stage): done once the gateway (443)
# and Hyper-V's VM consoles (2179) both answer. The Windows disc stays in its drive: the guest is made from it.
open_port() { timeout 3 bash -c "exec 3<>/dev/tcp/$IP/$1" 2>/dev/null; }
printf 'Hyper-V, RD Gateway and the guest VM (30 to 60 minutes)'
READY=
i=0; while [ $i -lt 540 ]; do
    sleep 10; printf .; i=$((i+1))
    if open_port 443 && open_port 2179; then READY=1; break; fi
done
echo
[ -n "$READY" ] || { echo "the gateway or Hyper-V didn't come up; see C:\\tabby-rdp\\server.log there (VNC: $V vncdisplay $NAME)" >&2; exit 1; }
sleep 60
$V change-media "$NAME" sdc --eject --config --live >/dev/null 2>&1 || true
$V vol-delete --pool "$NAME" config.iso >/dev/null 2>&1 || true

echo
echo "Windows Server test machine ready at $IP. Administrator: tabbyadmin, password $ADMIN_PASSWORD"
echo "Test account tabbyrdp, here and in the Hyper-V guest \"tabby-rdp-guest\" (Windows; it finishes its first start in"
echo "the background, unless START_GUEST=0 left it off). \"tabby-rdp-empty\" is a guest without a disk, at its firmware's"
echo "screen. C:\\tabby-rdp\\ready.txt has their ids:"
echo "    RD Gateway:        https://$IP (self-signed), any computer behind it, e.g. the Windows test machine"
echo "    Hyper-V consoles:  $IP:2179; SSH (PowerShell) on $IP:22 to list the VMs (Get-VM, as tabbyadmin)"
echo "    Remote Desktop:    $IP:3389, WinRM on $IP:5985"
