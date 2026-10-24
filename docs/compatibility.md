[← README](../README.md)

# Supported desktops, requirements and test coverage

## Requirements

- **Tabby 1.0.236 or newer**, on macOS, Windows or Linux. On a fresh Windows, Tabby
  itself needs the [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist)
  for SSH. The experimental **FreeRDP client also requires this runtime**, for the client architecture
  (ARM64 or x64), including for direct RDP connections. It is a prerequisite and is not bundled by the plugin.
- **Automatic headless GNOME setup:** GNOME Shell and GNOME Remote Desktop 46 or newer (Ubuntu 24.04, for example), a systemd user
  session, and SSH access with a key or agent. `desk` also needs `python3` and GNOME Terminal. No root, no display, no
  login screen.
- **Linux desktops through xrdp:** xrdp running on the machine, with a desktop for its sessions (on Debian and Ubuntu:
  `sudo apt install xrdp xfce4`, or KDE, MATE, …), and an account with a password. xrdp's default settings work
  (`security_layer=negotiate`, its own certificate); the port is read from `/etc/xrdp/xrdp.ini`. Sound needs
  `pipewire-module-xrdp` or `pulseaudio-module-xrdp`.
- **Windows desktops:** Windows 10 or 11 Pro, or Windows Server, with Remote Desktop turned on, reachable directly, through an SSH host or through an RD Gateway. Opening Windows
  itself as an SSH host also requires OpenSSH Server.

The plugin checks the host's available features through a shared compatibility layer. Connection logs include the
host and runtime versions, declared xterm dependency and observed capabilities to help diagnose forks and nightlies.

## Tested environments

The visual QA matrix runs real remote desktops in native Tabby clients on **macOS, Windows and Linux**. The current
RDP matrix uses ARM64 Tabby 1.0.236 / Electron 43.7.0 on all three client platforms:

| Remote desktop | Server stack | Visual QA coverage |
|---|---|---|
| Ubuntu 24.04 | GNOME 46 / GNOME Remote Desktop | Desktop pixels, keyboard input, resize, tab return and reconnect |
| Fedora 44 | GNOME 50 / GNOME Remote Desktop | Same RDP lifecycle checks |
| Debian 13.7 | GNOME 48 / GNOME Remote Desktop | Same RDP lifecycle checks |
| Rocky Linux 9 | Xfce 4.18 / xrdp 0.10.6.1 / xorgxrdp 0.10.5 | Same RDP lifecycle checks |
| Windows 11 | Windows Remote Desktop | Same RDP lifecycle checks, with H.264 disabled |
| Fedora 44 KDE Plasma | KRDP / KPipeWire 6.7.5, FreeRDP 3.32.1; two opt-in server patches | H.264 pixels, input, tab return, reconnect and fixed-monitor client fitting |

The KDE row is experimental: the tested profile needs server-side color and authentication compatibility patches.
Stock KDE builds and live remote monitor resizing are not qualified. FreeRDP is a dependency of that KRDP server;
this matrix records the IronRDP client. The new FreeRDP client preview is qualified separately below. Rocky's Xfce desktop uses **xrdp**, a different RDP server.
The testbed includes the opt-in KDE patches and reproducible setup instructions; see the
[visual QA guide](visual-qa.md) for exact identities, evidence and remaining gaps.

Hosted CI also runs native settings and plugin smoke checks on macOS, Windows and Linux; those checks do not qualify
x86_64 RDP sessions. Recent host compatibility tests cover official Tabby **1.0.238** on macOS with xterm 5, and
upstream xterm 6 builds on macOS and Linux. The package installation dialog is tested on macOS with Tabby 1.0.238;
Windows qualification of that dialog remains pending. See the [host test matrix](../test/README.md#host-qualification).
These focused checks do not establish clipboard, shared-folder, audio or microphone coverage across every matrix cell.

## FreeRDP client preview

Native helpers are bundled for macOS ARM64 and Windows/Linux ARM64 and x64. The native protocol/security checks
pass on all five targets. Packed-plugin lifecycle tests against Windows Server 2025 pass in the existing Windows 11
ARM64 and Ubuntu 24.04 ARM64 client VMs: pixels, input routing, live resize in both directions, fixed-resolution
fitting, view only, cleanup, reconnect, switching to IronRDP, input-burst recovery and stable Automatic headers with reconnect resizing.
macOS ARM64 has earlier lifecycle coverage and current native protocol/security checks. Live x64 RDP qualification,
domain-policy qualification and performance comparisons remain pending.
See [capabilities and build coverage](../native/README.md).

## Limitations

- **One screen per connection on GNOME.** GNOME Remote Desktop's headless mode can't show the same screen to two
  clients (another computer, or another Tabby window): a second one gets an extra, empty screen. Opening a desktop
  that's open elsewhere asks whether to take it over (the other connection is disconnected, as on Windows; the session
  and its apps carry on) or to open a second screen.
- **The headless GNOME session is a shell without `gnome-session`.** Apps work, X11 ones too (through XWayland), and so
  do GNOME's settings daemons for keyboard, media keys and custom shortcuts, accessibility and sound. The ones for
  power, sharing and local hardware don't run, so the session never suspends or blanks the machine.
- **GNOME's login-screen mode** isn't supported: it hands clients over with a server redirection, which IronRDP can't
  follow yet. The plugin uses per-user headless sessions instead.
- **Remembering a Windows password on Linux** needs an unlocked keyring (GNOME Keyring or KWallet), as it does for
  Tabby's own passwords. Without one, the plugin asks each time.
- **GNOME Remote Desktop listens on all interfaces** (password-protected, TLS); it has no setting to listen on
  loopback only. See [docs/architecture.md](architecture.md#security-notes) to restrict it.
- **The microphone** needs the system's permission: macOS asks the first time a remote app records (if it was denied,
  allow Tabby in System Settings › Privacy & Security › Microphone, then restart Tabby), and Windows needs "Let desktop
  apps access your microphone". On GNOME, apps record from GNOME Remote Desktop's "Remoteaudio Source", which is the
  default input on a machine without a microphone of its own; otherwise pick it in Settings › Sound. On Windows, the
  remote machine must allow audio recording redirection (the Remote Desktop Session Host policy "Allow audio recording
  redirection").
- **xrdp sessions are separate X sessions**, not the machine's screen, and use whatever `~/.xsession` or the system
  default starts. Don't have them start GNOME for a user who also has a GNOME session (the plugin's headless one, or
  a login at the machine): GNOME runs once per user.
- **xrdp and a wrong password:** xrdp doesn't refuse the connection, it shows its own login window instead, where you
  can sign in. A remembered password that no longer works leads there each time; **Sign in again…** replaces it.
- **What works on xrdp** depends on its channels: the clipboard through `xrdp-chansrv` (text; images and files as
  far as that xrdp version supports them), sound through the PipeWire or PulseAudio module. Live resize needs xrdp
  0.10 or newer; with 0.9 (Ubuntu 24.04), the desktop keeps its size, scaled to fit, or choose **Reconnect at the new
  size**. xrdp's standard RDP security without TLS (`security_layer=rdp`) isn't supported. `desk` needs GNOME.
- **RD Gateways** are signed in to with a user name and password; ones that ask for a smart card, a sign-in page or
  a one-time code, or that only take Kerberos, can't be used. Gateways before Windows Server 2012 R2 (no WebSocket
  transport) can't either. A desktop behind a gateway isn't started when it is off.
- **Waking a desktop** over the network (Wake-on-LAN) starts it but never shuts it down again; for VMs, see
  [Shut down VMs it started](connections.md#vms-on-a-host).
