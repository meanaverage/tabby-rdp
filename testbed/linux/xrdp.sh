#!/bin/sh
# Adds xrdp to a Linux test host (after provision.sh), for the xrdp suite: xrdp with XFCE, on port 3390 so that it
# doesn't clash with GNOME Remote Desktop on 3389, and a test account that signs in to it with a password. Run as
# root, or with sudo:
#
#     sudo TEST_PASSWORD='<a password for the xrdp account>' sh testbed/linux/xrdp.sh [xrdp-user] [ssh-user]
#
# xrdp-user (default tabbyxrdp) is created if needed, gets that password and XFCE as its session, and the SSH keys of
# ssh-user (default: the one running sudo), so the suites log in to it with the same key. xrdp is left stopped and
# disabled: the xrdp suite starts it for its run (with the SSH user's sudo) and stops it again, so that for the other
# suites the host stays one with GNOME only.
set -eu

if [ "$(id -u)" != 0 ]; then
    exec sudo TEST_PASSWORD="${TEST_PASSWORD:-}" sh "$0" "$@"
fi
XRDP_USER="${1:-tabbyxrdp}"
SSH_USER="${2:-${SUDO_USER:-}}"
PORT=3390
if [ -z "${TEST_PASSWORD:-}" ] || [ -z "$SSH_USER" ] || ! id "$SSH_USER" >/dev/null 2>&1; then
    echo "usage: sudo TEST_PASSWORD=<password> sh $0 [xrdp-user] <ssh-user>" >&2
    exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
# xorgxrdp runs the sessions (an Xorg per session); XFCE is the desktop, with its terminal and app finder, which the
# suite types into. pipewire-module-xrdp carries the session's sound to the client where the release has it.
apt-get install -y xrdp xorgxrdp xfce4 xfce4-terminal xfce4-appfinder dbus-x11
apt-get install -y pipewire-module-xrdp || echo "note: no pipewire-module-xrdp here; xrdp sessions will have no sound" >&2
# xrdp reads its TLS key, the system's snakeoil key, as a member of ssl-cert.
usermod -aG ssl-cert xrdp 2>/dev/null || true

# Listen on 3390: GNOME Remote Desktop has 3389. Only [Globals] (the session sections have ports of their own).
sed -i "/^\[Globals\]/,/^\[/s/^port=.*/port=$PORT/" /etc/xrdp/xrdp.ini
grep -q "^port=$PORT" /etc/xrdp/xrdp.ini || { echo "could not set port=$PORT in /etc/xrdp/xrdp.ini" >&2; exit 1; }

# The account: a password (xrdp signs in with it), XFCE as its X session, and the SSH user's keys.
id "$XRDP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$XRDP_USER"
printf '%s:%s\n' "$XRDP_USER" "$TEST_PASSWORD" | chpasswd
HOME_DIR="$(getent passwd "$XRDP_USER" | cut -d: -f6)"
SSH_HOME="$(getent passwd "$SSH_USER" | cut -d: -f6)"
echo xfce4-session > "$HOME_DIR/.xsession"
install -d -m 700 "$HOME_DIR/.ssh"
cp "$SSH_HOME/.ssh/authorized_keys" "$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"
chown -R "$XRDP_USER:" "$HOME_DIR/.xsession" "$HOME_DIR/.ssh"
# In an xrdp session, colord asks for an administrator's password to add the virtual display; let the account do it.
mkdir -p /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/50-tabby-rdp-xrdp.rules <<EOF
polkit.addRule(function (action, subject) {
    if (action.id.indexOf("org.freedesktop.color-manager.") == 0 && subject.user == "$XRDP_USER") {
        return polkit.Result.YES;
    }
});
EOF

# Stopped until the suite starts it (see above).
systemctl disable --now xrdp >/dev/null 2>&1 || true
systemctl stop xrdp-sesman >/dev/null 2>&1 || true

echo "Ready: xrdp $(dpkg-query -W -f '${Version}' xrdp) on port $PORT (stopped), account $XRDP_USER. For the suite:"
echo "    export TRD_TEST_XRDP_USER=$XRDP_USER TRD_TEST_XRDP_PASSWORD='<its password>' TRD_TEST_XRDP_PORT=$PORT"
