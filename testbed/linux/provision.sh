#!/bin/sh
# Prepares Ubuntu 24.04, Debian 13 or Fedora 44 with GNOME, or Rocky 9 for the separate xrdp.sh setup.
# A VM is best as a tabby-rdp test host: GNOME Shell and GNOME Remote Desktop for
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
HERE="$(cd "$(dirname "$0")" && pwd)"
# The reviewed WinRM wheel lock is for Ubuntu 24.04's Python 3.12 only.
# Other distro profiles are Linux desktop targets; use the Ubuntu SSH gateway for Windows checks.
if [ "${ID:-}:${VERSION_ID:-}" = ubuntu:24.04 ]; then
    [ -f "$HERE/winrm-requirements.txt" ] || { echo 'copy winrm-requirements.txt next to provision.sh' >&2; exit 2; }
fi

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:24.04)
        apt-get update
        apt-get install -y ubuntu-desktop-minimal gnome-remote-desktop pipewire-bin python3-gi python3-gi-cairo fonts-dejavu-core python3-venv tmux openssh-server openssl qemu-guest-agent xclip wl-clipboard
        ;;
    debian:13)
        apt-get update
        apt-get install -y gnome-core gnome-remote-desktop gnome-terminal pipewire-bin python3-gi python3-gi-cairo fonts-dejavu-core python3-venv tmux openssh-server openssl qemu-guest-agent xclip wl-clipboard
        ;;
    fedora:44)
        dnf install -y gnome-shell gnome-session gnome-settings-daemon gnome-remote-desktop gnome-terminal nautilus pipewire-utils wireplumber python3-gobject python3-cairo dejavu-sans-fonts dejavu-sans-mono-fonts python3-pip tmux openssh-server openssl qemu-guest-agent xclip wl-clipboard
        ;;
    rocky:9.*)
        dnf install -y python3-gobject python3-cairo gtk3 dejavu-sans-fonts dejavu-sans-mono-fonts python3-pip tmux openssh-server openssl qemu-guest-agent
        ;;
    *) echo "Unsupported testbed: ${PRETTY_NAME:-unknown}" >&2; exit 2 ;;
esac
# pywinrm lets this host run the Windows suite's checks inside a Windows test machine. Ubuntu's python3-winrm can't
# sign in with NTLM (it needs MD4, which OpenSSL 3 turns off); this reviewed PyPI version can.
if [ "$ID:$VERSION_ID" = ubuntu:24.04 ]; then
    python3 -m venv /opt/tabby-rdp-test/winrm
    /opt/tabby-rdp-test/winrm/bin/pip --isolated install --quiet --disable-pip-version-check \
        --require-hashes --only-binary=:all: --force-reinstall -r "$HERE/winrm-requirements.txt"
fi

# No graphical login screen needed: the plugin starts its own headless GNOME Shell per user.
systemctl set-default multi-user.target
# Let the test user's systemd (and so the headless session) run without anyone logged in.
loginctl enable-linger "$TEST_USER"

echo "Ready: $PRETTY_NAME for user $TEST_USER"
if [ "$ID" = rocky ]; then exit 0; fi # libvirt.sh adds Xfce/xrdp with xrdp.sh, without GNOME.
gnome-shell --version
if command -v dpkg-query >/dev/null; then dpkg-query -W gnome-remote-desktop; else rpm -q gnome-remote-desktop; fi

# Dedicated visual-test accounts must not show first-login tours or notification banners over the fixture.
GNOME_VERSION=$(gnome-shell --version | awk '{print $NF}')
UID_TEST=$(id -u "$TEST_USER")
# Desktop packages may have installed the session bus after this user manager started.
systemctl start "user@$UID_TEST.service"
runuser -u "$TEST_USER" -- env XDG_RUNTIME_DIR="/run/user/$UID_TEST" systemctl --user daemon-reload
runuser -u "$TEST_USER" -- env XDG_RUNTIME_DIR="/run/user/$UID_TEST" systemctl --user start dbus.socket
runuser -u "$TEST_USER" -- env XDG_RUNTIME_DIR="/run/user/$UID_TEST" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UID_TEST/bus" sh -ec '
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "$1"
    gsettings set org.gnome.desktop.notifications show-banners false
    gsettings set org.gnome.desktop.interface enable-animations false
    test "$(gsettings get org.gnome.desktop.notifications show-banners)" = false
    test "$(gsettings get org.gnome.desktop.interface enable-animations)" = false
' sh "$GNOME_VERSION"
