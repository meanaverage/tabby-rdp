# Test machines

The suites need a Linux desktop host, and for the Windows suite, a Windows machine. Use dedicated virtual machines,
not machines you use: the suites start and stop desktop sessions, change settings, and install `desk`'s login hook
on the test account.

## Linux desktop host

Ubuntu 24.04 with GNOME Remote Desktop 46, reachable over SSH with your key. Either:

**A Multipass VM** ([Multipass](https://canonical.com/multipass) runs on macOS, Linux and Windows):

```sh
testbed/linux/multipass.sh                 # creates "tabby-rdp-linux", provisions it, adds ~/.ssh/id_ed25519.pub
# prints: export TRD_TEST_HOST=<address> TRD_TEST_USER=ubuntu
```

**A libvirt VM** on a Linux host, from Ubuntu's cloud image, without root (as a user in the `libvirt` group; needs
`virtinst` and `cloud-image-utils`):

```sh
testbed/linux/libvirt.sh [name] [keys.pub]   # on the libvirt host; keys.pub: this host's key and your test machine's
# prints the address, and how to forward a port to it from another machine
```

**Or any Ubuntu 24.04 VM** (virt-manager, UTM, Hyper-V, a cloud instance), with SSH set up for your key:

```sh
scp testbed/linux/provision.sh user@host: && ssh -t user@host sudo sh provision.sh
```

[`provision.sh`](linux/provision.sh) installs a minimal GNOME desktop (`ubuntu-desktop-minimal`), GNOME Remote
Desktop, PipeWire's tools, Python's GObject bindings, `pywinrm`, tmux and OpenSSH; switches the boot target to text
mode (the plugin runs its own headless GNOME session); and lets the test user's systemd run without a login. Give the
VM 2 CPUs, 4 GB of memory and 20 GB of disk. No GPU is needed.

### xrdp, for the xrdp suite (optional)

On the same host, after `provision.sh`:

```sh
scp testbed/linux/xrdp.sh user@host: && ssh -t user@host "sudo TEST_PASSWORD='<a password>' sh xrdp.sh"
```

[`xrdp.sh`](linux/xrdp.sh) installs xrdp with XFCE (and `pipewire-module-xrdp` for sound, where the release has it),
sets xrdp's port to 3390 so that it doesn't clash with GNOME Remote Desktop on 3389, and creates an account,
`tabbyxrdp`, with that password, XFCE as its session and the test user's SSH keys. It leaves xrdp stopped: the xrdp
suite starts it for its run with the test user's `sudo` (passwordless on Ubuntu's cloud images) and stops it
afterwards, so that for the other suites the host has GNOME only. Then:

```sh
export TRD_TEST_XRDP_PASSWORD='<the password>'   # TRD_TEST_XRDP_USER=tabbyxrdp and TRD_TEST_XRDP_PORT=3390 are the defaults
npm test -- xrdp
```

The suite checks both ways a host offers xrdp: next to GNOME, as a second desktop (with the test user), and as the
host's own desktop where GNOME isn't installed (with `tabbyxrdp`, running the plugin's setup with a `PATH` that has no
`grdctl` or `gnome-shell`).

## Windows machine

Windows 10 or 11 Pro (or Windows Server), for example a VM on the same virtual network as the Linux test host.

**A libvirt VM**, next to the Linux one, installed unattended from Microsoft's Windows 11 Enterprise evaluation ISO
(90 days; downloaded the first time, 7 GB) and prepared with `setup.ps1`. It needs `virtinst`, `genisoimage` and
`swtpm` (Windows 11 wants UEFI Secure Boot and a TPM), and takes 15 to 30 minutes:

```sh
TEST_PASSWORD='<a password for the test account>' testbed/windows/libvirt.sh   # on the libvirt host
# prints the settings for the Windows suite, and the administrator's password
```

**Or any Windows machine.** In an elevated PowerShell on it:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1 -Password '<a password for the test account>'
```

[`setup.ps1`](windows/setup.ps1) turns on Remote Desktop (with Network Level Authentication) and WinRM (marking the
network private, which WinRM's settings require), and creates a local test account, `tabbyrdp`, that can use both
without being an administrator.

The suite reaches Windows through an SSH host, as users do: the Linux test host works, if it can reach the Windows
machine. It runs its checks inside Windows over WinRM from that host (`provision.sh` installs `pywinrm`):

```sh
export TRD_TEST_WIN_ADDRESS=192.168.122.20:3389 TRD_TEST_WIN_WINRM=192.168.122.20:5985
export TRD_TEST_WIN_USER=tabbyrdp TRD_TEST_WIN_PASSWORD='<its password>'
npm test -- windows
```

If the Windows VM runs on a host with user-mode networking (QEMU's `-netdev user`), forward its ports to that host's
loopback instead (`hostfwd=tcp:127.0.0.1:13389-:3389,hostfwd=tcp:127.0.0.1:15985-:5985`), use that host as
`TRD_TEST_WIN_SSH_HOST`, and `127.0.0.1:13389` / `127.0.0.1:15985` as the addresses.
