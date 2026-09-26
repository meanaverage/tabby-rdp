#!/bin/sh
# Creates a Linux test host as a Multipass VM (https://canonical.com/multipass), provisioned with provision.sh and
# reachable over SSH with your key, then prints the settings for the test suites.
#
#     testbed/linux/multipass.sh [vm-name] [public-key-file]
#
# Defaults: tabby-rdp-linux, and ~/.ssh/id_ed25519.pub (or id_rsa.pub). Remove it with: multipass delete --purge <name>
set -eu
NAME="${1:-tabby-rdp-linux}"
KEY="${2:-}"
if [ -z "$KEY" ]; then
    for k in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
        [ -f "$k" ] && { KEY="$k"; break; }
    done
fi
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "no public key found; pass one: $0 $NAME ~/.ssh/key.pub" >&2; exit 2; }
command -v multipass >/dev/null || { echo "multipass is not installed (https://canonical.com/multipass)" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"

multipass launch 24.04 --name "$NAME" --cpus 2 --memory 4G --disk 20G
multipass transfer "$HERE/provision.sh" "$NAME:/tmp/provision.sh"
multipass exec "$NAME" -- sudo sh /tmp/provision.sh ubuntu
multipass exec "$NAME" -- sh -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys' < "$KEY"
IP="$(multipass info "$NAME" --format csv | awk -F, 'NR == 2 { print $3 }')"

echo
echo "Test host ready. For the suites:"
echo "    export TRD_TEST_HOST=$IP TRD_TEST_USER=ubuntu"
