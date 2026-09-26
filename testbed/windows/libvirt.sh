#!/bin/sh
# Creates a Windows 11 test machine as a libvirt VM, installed unattended from Microsoft's Windows 11 Enterprise
# evaluation ISO and prepared with setup.ps1, then prints the settings for the Windows suite. Run it on the libvirt
# host that runs the Linux test host (testbed/linux/libvirt.sh), as a user in the libvirt group (no root needed); it
# needs virt-install, genisoimage and swtpm (UEFI with Secure Boot and a TPM, as Windows 11 requires).
#
#     TEST_PASSWORD=... testbed/windows/libvirt.sh [vm-name] [windows-iso]
#
# Defaults: tabby-rdp-windows, and the evaluation ISO, downloaded into $TESTBED_DIR (default
# ~/.cache/tabby-rdp-testbed; 7 GB). TEST_PASSWORD is for the test account, tabbyrdp; ADMIN_PASSWORD, for the
# administrator account, tabbyadmin, is random unless set. Installing takes 15 to 30 minutes.
#
# Remove it with: virsh destroy <name>; virsh undefine --nvram --tpm --remove-all-storage <name>
set -eu
NAME="${1:-tabby-rdp-windows}"
ISO="${2:-}"
: "${TEST_PASSWORD:?set TEST_PASSWORD, the password for the test account}"
if [ -z "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')Aa1"
fi
for c in virsh virt-install genisoimage swtpm curl; do
    command -v $c >/dev/null || { echo "$c is not installed (virtinst, genisoimage, swtpm)" >&2; exit 2; }
done
HERE="$(cd "$(dirname "$0")" && pwd)"
URI="${LIBVIRT_DEFAULT_URI:-qemu:///system}"
V="virsh -c $URI"
WORK="${TESTBED_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tabby-rdp-testbed}"
mkdir -p "$WORK"
# Windows 11 Enterprise evaluation (90 days), x64, English, from Microsoft's Evaluation Center.
EVAL_URL='https://go.microsoft.com/fwlink/?linkid=2334167&clcid=0x409&culture=en-us&country=us'
if [ -z "$ISO" ]; then
    ISO="$WORK/win11-eval.iso"
    [ -f "$ISO" ] || { curl -fL -o "$ISO.part" "$EVAL_URL" && mv "$ISO.part" "$ISO"; }
fi

# The config disc: the answer file (found by Windows Setup at the root of any disc) and setup.ps1.
# A value for the answer file: XML-escaped, then escaped for sed's replacement text.
answer_value() { printf %s "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e 's/[\\|&]/\\&/g'; }
CFG="$WORK/$NAME-config"
rm -rf "$CFG"; mkdir -p "$CFG"
COMPUTER=$(printf %s "$NAME" | tr -cd 'A-Za-z0-9-' | cut -c1-15)
ADMIN_VALUE=$(answer_value "$ADMIN_PASSWORD")
TEST_VALUE=$(answer_value "$TEST_PASSWORD")
sed -e "s|@@COMPUTER_NAME@@|$COMPUTER|g" -e "s|@@ADMIN_USER@@|tabbyadmin|g" -e "s|@@TEST_USER@@|tabbyrdp|g" \
    -e "s|@@ADMIN_PASSWORD@@|$ADMIN_VALUE|g" -e "s|@@TEST_PASSWORD@@|$TEST_VALUE|g" \
    "$HERE/autounattend.xml" > "$CFG/autounattend.xml"
cp "$HERE/setup.ps1" "$CFG/setup.ps1"
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
# The Windows ISO from an earlier run is kept if it is the same size (7 GB to upload otherwise).
if [ "$($V vol-info --pool "$NAME" windows.iso --bytes 2>/dev/null | awk '/Capacity/ { print $2 }')" != "$(wc -c < "$ISO")" ]; then
    upload "$ISO" windows.iso
fi
upload "$WORK/$NAME-config.iso" config.iso
rm -f "$WORK/$NAME-config.iso"
$V vol-delete --pool "$NAME" "$NAME.qcow2" >/dev/null 2>&1 || true
$V vol-create-as "$NAME" "$NAME.qcow2" 64G --format qcow2 >/dev/null

# SATA and e1000e: drivers Windows has without extra discs.
virt-install --connect "$URI" --name "$NAME" --osinfo win11 --import --memory 8192 --vcpus 4 --cpu host-passthrough \
    --boot uefi,firmware.feature0.name=secure-boot,firmware.feature0.enabled=yes,firmware.feature1.name=enrolled-keys,firmware.feature1.enabled=yes \
    --tpm backend.type=emulator,backend.version=2.0,model=tpm-crb \
    --disk "vol=$NAME/$NAME.qcow2,bus=sata,boot.order=2" --disk "vol=$NAME/windows.iso,device=cdrom,bus=sata,boot.order=1" \
    --disk "vol=$NAME/config.iso,device=cdrom,bus=sata" \
    --network network=default,model=e1000e --graphics vnc,listen=127.0.0.1 --noautoconsole >/dev/null

# Windows' boot manager waits for "Press any key to boot from CD or DVD": press it.
i=0; while [ $i -lt 15 ]; do sleep 1; $V send-key "$NAME" KEY_SPACE >/dev/null 2>&1 || true; i=$((i+1)); done

printf 'Installing (15 to 30 minutes)'
IP=
i=0; while [ $i -lt 360 ]; do
    sleep 10; printf .; i=$((i+1))
    IP="$($V domifaddr "$NAME" 2>/dev/null | awk '/ipv4/ { sub(/\/.*/, "", $4); print $4; exit }')"
    # setup.ps1 turns on WinRM and then creates the account; it is done once the sign-out after it has happened.
    [ -n "$IP" ] && curl -s -o /dev/null --max-time 3 "http://$IP:5985/wsman" && break
done
echo
[ -n "$IP" ] || { echo "no address after an hour; look at it over VNC: $V vncdisplay $NAME" >&2; exit 1; }
sleep 60

# The installation media aren't needed any more.
for dev in sdb sdc; do $V change-media "$NAME" "$dev" --eject --config --live >/dev/null 2>&1 || true; done
$V vol-delete --pool "$NAME" config.iso >/dev/null

echo
echo "Windows test machine ready at $IP. Administrator: tabbyadmin, password $ADMIN_PASSWORD"
echo "For the Windows suite, with the Linux test host (on the same libvirt network) as the SSH host:"
echo "    export TRD_TEST_WIN_ADDRESS=$IP:3389 TRD_TEST_WIN_WINRM=$IP:5985"
echo "    export TRD_TEST_WIN_USER=tabbyrdp TRD_TEST_WIN_PASSWORD='<TEST_PASSWORD>'"
