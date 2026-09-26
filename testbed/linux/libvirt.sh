#!/bin/sh
# Creates a Linux test host as a libvirt VM from Ubuntu's 24.04 cloud image, provisioned with provision.sh and
# reachable over SSH with your key, then prints the settings for the test suites. Run it on the libvirt host, as a
# user in the libvirt group (no root needed); it needs virt-install and cloud-localds (cloud-image-utils).
#
#     testbed/linux/libvirt.sh [vm-name] [public-key-file]
#
# Defaults: tabby-rdp-linux, and ~/.ssh/id_ed25519.pub (or id_rsa.pub). The key file can hold several keys, one per
# line: this host's (for provisioning) and that of the machine that runs the tests, if another.
#
# The VM's disks go in a storage pool of the same name, on libvirt's default NAT network; the image and the seed are
# kept in $TESTBED_DIR (default ~/.cache/tabby-rdp-testbed). Remove it with:
#     virsh undefine --remove-all-storage <name> (after virsh destroy <name>); virsh pool-destroy/pool-undefine <name>
set -eu
NAME="${1:-tabby-rdp-linux}"
KEY="${2:-}"
if [ -z "$KEY" ]; then
    for k in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
        [ -f "$k" ] && { KEY="$k"; break; }
    done
fi
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "no public key found; pass one: $0 $NAME ~/.ssh/key.pub" >&2; exit 2; }
for c in virsh virt-install cloud-localds; do
    command -v $c >/dev/null || { echo "$c is not installed (virtinst, cloud-image-utils)" >&2; exit 2; }
done
HERE="$(cd "$(dirname "$0")" && pwd)"
V="virsh -c ${LIBVIRT_DEFAULT_URI:-qemu:///system}"
IMAGE_URL=https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
WORK="${TESTBED_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tabby-rdp-testbed}"
mkdir -p "$WORK"

# The cloud image (kept for next time) and a cloud-init seed with the key.
[ -f "$WORK/noble.img" ] || curl -fL -o "$WORK/noble.img" "$IMAGE_URL"
printf 'instance-id: %s\nlocal-hostname: %s\n' "$NAME" "$NAME" > "$WORK/meta-data"
{
    printf '#cloud-config\nhostname: %s\nusers:\n  - default\nssh_pwauth: false\nssh_authorized_keys:\n' "$NAME"
    grep -v '^[[:space:]]*$' "$KEY" | sed 's/^/  - /'
} > "$WORK/user-data"
cloud-localds "$WORK/seed.iso" "$WORK/user-data" "$WORK/meta-data"

# Disks in a storage pool of the VM's name, uploaded through libvirt, so no root is needed.
if ! $V pool-info "$NAME" >/dev/null 2>&1; then
    $V pool-define-as "$NAME" dir --target "/var/lib/libvirt/images/$NAME" >/dev/null
    $V pool-build "$NAME" >/dev/null
    $V pool-start "$NAME" >/dev/null
    $V pool-autostart "$NAME" >/dev/null
fi
$V vol-create-as "$NAME" "$NAME.qcow2" 4G --format qcow2 >/dev/null
$V vol-upload --pool "$NAME" "$NAME.qcow2" "$WORK/noble.img"
$V vol-resize --pool "$NAME" "$NAME.qcow2" 20G >/dev/null
$V vol-create-as "$NAME" seed.iso "$(wc -c < "$WORK/seed.iso")" --format raw >/dev/null
$V vol-upload --pool "$NAME" seed.iso "$WORK/seed.iso"

virt-install --connect "${LIBVIRT_DEFAULT_URI:-qemu:///system}" --name "$NAME" --memory 4096 --vcpus 2 --import \
    --disk "vol=$NAME/$NAME.qcow2,bus=virtio" --disk "vol=$NAME/seed.iso,device=cdrom" --os-variant ubuntu24.04 \
    --network network=default,model=virtio --graphics none --noautoconsole >/dev/null

printf 'Waiting for its address'
IP=
i=0; while [ $i -lt 90 ] && [ -z "$IP" ]; do
    sleep 2; printf .; i=$((i+1))
    IP="$($V domifaddr "$NAME" 2>/dev/null | awk '/ipv4/ { sub(/\/.*/, "", $4); print $4; exit }')"
done
echo
[ -n "$IP" ] || { echo "no address after 3 minutes; check: $V console $NAME" >&2; exit 1; }

SSH="ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$WORK/known_hosts -o BatchMode=yes ubuntu@$IP"
i=0; until $SSH true 2>/dev/null; do
    i=$((i+1)); [ $i -lt 60 ] || { echo "no SSH to ubuntu@$IP" >&2; exit 1; }; sleep 3
done
# Let cloud-init finish first (it exits 2 for "done, with warnings", which is fine here).
$SSH cloud-init status --wait >/dev/null 2>&1 || true
$SSH 'cat > /tmp/provision.sh' < "$HERE/provision.sh"
$SSH sudo sh /tmp/provision.sh ubuntu

echo
echo "Test host ready at $IP (on this host's libvirt network). For the suites, on this host:"
echo "    export TRD_TEST_HOST=$IP TRD_TEST_USER=ubuntu"
echo "From another machine, forward a port to it, for example:"
echo "    ssh -N -L 127.0.0.1:2222:$IP:22 $(id -un)@$(hostname)"
echo "    export TRD_TEST_HOST=127.0.0.1 TRD_TEST_PORT=2222 TRD_TEST_USER=ubuntu"
