#!/bin/sh
# For the nested suite (ssh typed in an SSH tab): lets the test user ssh on from the test host to a second desktop
# account, as it would to another machine, without a password. Run as the test user, after provision.sh and xrdp.sh
# (which creates the second account):
#
#     sh testbed/linux/nested.sh [other-user] [alias]
#
# other-user (default tabbyxrdp) gets a key of the test user's, made for this; alias (default trdhop) is an ssh alias for
# it in the test user's ~/.ssh/config. Its GNOME Remote Desktop listens on 3391: the test user's has 3389, and on one
# machine both would take that. Undo: remove the alias block and ~/.ssh/trd_hop_test*, and the key's line from the
# other account's authorized_keys.
set -eu
OTHER="${1:-tabbyxrdp}"
ALIAS="${2:-trdhop}"
KEY="$HOME/.ssh/trd_hop_test"
id "$OTHER" >/dev/null 2>&1 || { echo "no account $OTHER (see xrdp.sh)" >&2; exit 2; }
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C trd-hop-test -f "$KEY"
HOME_OTHER=$(getent passwd "$OTHER" | cut -d: -f6)
sudo install -d -m 700 -o "$OTHER" -g "$OTHER" "$HOME_OTHER/.ssh"
sudo sh -c "grep -q trd-hop-test '$HOME_OTHER/.ssh/authorized_keys' 2>/dev/null || cat '$KEY.pub' >> '$HOME_OTHER/.ssh/authorized_keys'"
sudo chown "$OTHER:$OTHER" "$HOME_OTHER/.ssh/authorized_keys"
sudo chmod 600 "$HOME_OTHER/.ssh/authorized_keys"
grep -q "^Host $ALIAS\$" "$HOME/.ssh/config" 2>/dev/null || printf '\n# trd-hop-test\nHost %s\n    HostName localhost\n    User %s\n    IdentityFile %s\n    StrictHostKeyChecking accept-new\n' \
    "$ALIAS" "$OTHER" "$KEY" >> "$HOME/.ssh/config"
chmod 600 "$HOME/.ssh/config"
ssh -o BatchMode=yes "$ALIAS" 'grdctl --headless rdp set-port 3391' 2>/dev/null
echo "ok: ssh $ALIAS logs in as $OTHER; run the suite with TRD_TEST_NESTED=$ALIAS"
