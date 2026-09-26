#!/bin/sh
# Prepares an Ubuntu 24.04 machine (a VM is best) as a tabby-rdp test host: GNOME Shell and GNOME Remote Desktop for
# headless sessions, the apps the suites drive (Files, Terminal), PipeWire for sound, and a user systemd instance that
# runs without a login. Run as root, or as the test user with sudo:
#
#     sudo sh testbed/linux/provision.sh [test-user]
#
# The test user defaults to the one running sudo. It needs SSH access with your key (see testbed/README.md).
set -eu

if [ "$(id -u)" != 0 ]; then
    exec sudo sh "$0" "$@"
fi
TEST_USER="${1:-${SUDO_USER:-}}"
if [ -z "$TEST_USER" ] || ! id "$TEST_USER" >/dev/null 2>&1; then
    echo "usage: sudo sh $0 <test-user>" >&2
    exit 2
fi
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != 24.04 ]; then
    echo "note: made for Ubuntu 24.04 (this is ${PRETTY_NAME:-unknown}); continuing" >&2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
# ubuntu-desktop-minimal brings a complete GNOME session (Shell, settings schemas, fonts, portals, Files,
# Terminal); gnome-remote-desktop 46 provides the headless RDP server; pipewire-bin has pw-play (the audio suite);
# python3-gi drives Mutter's DisplayConfig (Retina scaling); tmux is the alternative `desk` backend.
apt-get install -y ubuntu-desktop-minimal gnome-remote-desktop pipewire-bin python3-gi python3-venv tmux openssh-server openssl
# pywinrm lets this host run the Windows suite's checks inside a Windows test machine. Ubuntu's python3-winrm can't
# sign in with NTLM (it needs MD4, which OpenSSL 3 turns off); the current one from PyPI can.
python3 -m venv /opt/tabby-rdp-test/winrm
/opt/tabby-rdp-test/winrm/bin/pip install --quiet --disable-pip-version-check pywinrm

# No graphical login screen needed: the plugin starts its own headless GNOME Shell per user.
systemctl set-default multi-user.target
# Let the test user's systemd (and so the headless session) run without anyone logged in.
loginctl enable-linger "$TEST_USER"

echo "Ready: $(hostname) for user $TEST_USER. GNOME Remote Desktop $(dpkg-query -W -f '${Version}' gnome-remote-desktop)."
