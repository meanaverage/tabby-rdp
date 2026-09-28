# Changelog

## 0.3.0

**New**
- **Settings › Remote Desktop:** getting started, every setting with a line on what it does, keys and tips, the
  desktops and certificates the plugin keeps, troubleshooting, and each open desktop's log to copy for a bug report.
  A tip the first time a desktop connects, and **What does this mean?** under a message that ends a connection.
- **Several desktops in one tab:** **Paste to all desktops in this tab** (text, pictures, or files copied here),
  **Type into all desktops in this tab** (a label on each says so while it's on), and **Make panes even**. As you
  click into a desktop, its name shows in its corner for a moment; when, and its font, size, place and color, are in
  the settings, with a preview.
- **Files copied in Finder** (Explorer, Files) paste on the desktop with ⌘V (Ctrl+V), and the paste waits until the
  remote has taken them in.
- **VMs on a host:** the libvirt VMs with a desktop on an SSH host (RDP answering, or Windows and shut off) show up in
  its menu, ready to open, or to start and open. **Find virtual machines on SSH hosts** turns it off.
- **`ssh` typed in an SSH tab:** **Desktop** and `desk` there open the machine it went to, through the tab's host, and
  Reconnect stays with it.
- **Remote desktop (RDP) profiles:** desktops as Tabby profiles, in their own tab: connect directly to an RDP server
  this machine reaches (LAN, VPN), or through an SSH profile. They show up in the profile list, quick connect
  (`user@host:port`), recent profiles and tab recovery. **Import an .rdp file…** turns a saved Remote Desktop
  connection into one.
- **Linux desktops through xrdp** (KDE, XFCE, MATE, …): the SSH host's own desktop is xrdp's when GNOME isn't there,
  and offered next to GNOME when both are; `kind: xrdp` for desktops behind a host. Signs in with the Linux account.
- **Windows as the SSH host:** an SSH host that is itself Windows (OpenSSH server) opens its own RDP desktop.
- **H.264 video decoding** (setting **Video decoding**, on by default), hardware-accelerated where Tabby's engine can:
  Windows desktops now use the graphics pipeline with H.264 for what changes like video, instead of bitmaps; GNOME
  uses it when its machine has a hardware encoder.
- **Microphone** (off by default): an app on the remote desktop that records gets your microphone, only while it
  records, with an indicator.
- **Send keys:** Ctrl+Alt+Del, Win+R, Win+L, Task Manager and more for Windows; Super, the app grid, Alt+F2 for GNOME.
  From a Mac, ⌃⌘ with a key is the Windows key with it (⌃⌘R for Win+R).
- **View only**, **Save a screenshot** (to Downloads and the clipboard), and **actual size** with scroll bars for a
  fixed resolution.
- **Certificates:** GNOME desktops accept only the certificate the plugin made for them; other desktops remember theirs
  on first use and stop to ask, before signing in, if it changes.
- **Edit a desktop** behind a host from the menus (name, address, account, kind).
- **Wake before connecting:** `wake: { vm }` starts a libvirt VM on the SSH host, `wake: { mac }` sends Wake-on-LAN,
  when the desktop doesn't answer.
- **Connection status** (off by default): throughput, frames per second, SSH round trip and how it's connected, in the
  desktop's corner.

**Fixed**
- `desk` run on another machine than the tab's (after `ssh` there, or with a shared home folder) opened a terminal on
  the wrong desktop; it's refused now, with a note that says why.
- Windows over the graphics pipeline: IronRDP's RemoteFX Progressive decoder rejected Windows' refinement passes and
  ended the session (patch 0010, for upstream).

**Package**
- IronRDP's WebAssembly ships as its own file instead of a 6.6 MB base64 string inside the JavaScript: the package is
  about 2 MB instead of 2.7 MB.
- Releases are built and staged on npm by GitHub Actions, with provenance.

**Changed**
- Hosts are called by their SSH profile's name (not its address) in messages and the on-screen name.
- **Remove a desktop** asks first.
- **Menus:** the plugin's items in a terminal's or tab's menu start with a **Remote Desktop** heading (naming the
  desktop while one is connected), so they read as the plugin's rather than Tabby's. Under it the items are shorter:
  **Send files…**, **Disconnect** and **Settings**, and the host's other desktops (and VMs found there) and
  **Add a desktop behind \<host\>…** are under **Desktops**.

## 0.2.7

(0.2.6 carries the same change: its staged publish on npm looked like it had failed and only appeared later, so the
change was released again as 0.2.7.)

**Security**
- Files copied on the remote desktop are saved inside the folder you save them to (Downloads). Their names come from
  the remote, and a name with `../` and forward slashes could be written elsewhere, such as a folder where macOS
  starts programs at login. Now every part of the path is checked, and a file that would land outside is refused.
  Update if you use **Save to Downloads** with machines you don't fully trust.

## 0.2.5

**New**
- Sharpness per desktop: in the menu of a tab with a desktop open, **For \<desktop\> only**: As above, Standard or
  Retina. For example, Retina for a Windows VM and Standard for a GNOME host. Kept in the config
  (`remoteDesktop.desktopSharpness`).

**Fixed**
- Retina on Windows: Windows stayed at 100%, so its UI was tiny at device pixels. It takes the scale from the monitor
  layout only together with the monitor's physical size, which the plugin now sends; Windows follows every change of
  the setting, also back to 100%.
- Going from Retina back to Standard left GNOME at its Retina scale.

## 0.2.4

Tabby on Linux, tested end to end for the first time (Ubuntu 24.04 on arm64, Tabby 1.0.237):
- Keychain calls give up after 10 seconds. On Linux, a locked or missing keyring can keep them waiting for an unlock
  prompt that never appears; loading a saved Windows password then counts as none saved, and the sign-in form asks.
  After one such call, the plugin leaves the keychain alone for the rest of the session: each call that never returns
  holds one of the few worker threads Tabby's other file and network work needs.

Also:
- Works with IronRDP builds that have no switch for the graphics pipeline, such as one with a pending IronRDP change
  that turns it on by itself ([Devolutions/IronRDP#1977](https://github.com/Devolutions/IronRDP/pull/1977)).

## 0.2.3

**Fixed**
Tabby on Windows, tested end to end for the first time (Windows 11, Tabby 1.0.237):
- The remote desktop didn't load ("A dynamic import callback was not specified"). The IronRDP modules now load
  through the page's own module loader.
- Remote commands could come back empty, so a desktop failed with "Remote setup gave no result". Tabby's SSH binding
  sometimes delivers a command's last output after the channel's close, and then drops it; the plugin now picks it
  up.

## 0.2.2

**Fixed**
- On a freshly set-up machine, GNOME desktops connected but showed nothing: PipeWire, which screen casting goes
  through, hadn't been started for the user when it was installed after the user's systemd was up. The plugin now
  starts it.
- Apps such as Terminal and Files took 25 seconds to open on the desktop: GNOME's portal wouldn't start without a
  graphical session. The headless session now provides one, as a regular login does.
- No sound from machines without sound hardware (VMs, servers): a virtual output is added when there is none.

## 0.2.1

Same as 0.2.0. (npm took long enough to make 0.2.0 available that it was published again under a new version.)

## 0.2.0

**New**
- Windows desktops, and other desktops an SSH host can reach, next to the host's own: added and removed from the
  menus (**Add a desktop behind \<host\>…**, **Remove a desktop**), with a sign-in form and an optional keychain entry.
- Files both ways through the clipboard: drop files on the desktop (or **Send files to the remote desktop…**) and
  paste them there; files copied on the remote offer **Save to Downloads**.
- Sound from the remote desktop.
- Mac shortcuts on macOS (on by default): ⌘ acts as Ctrl on the remote, and a ⌘ tap is the Windows key.
- Reconnecting: a dropped connection is noticed and reconnected by itself once SSH is back ("Reconnect SSH" when SSH
  is down); ended or failed desktops offer Reconnect / Try again.

**Fixed**
- While a desktop covered a pane, Tabby's shortcuts acted on the terminal underneath: ⌘V pasted into the hidden
  console, ⌘W closed the tab. Only switching tabs and returning to the console stay Tabby's now.
- Clipboard: IronRDP's component signaled `ready` before setting up the clipboard, so connections got none.
- A desktop froze instead of noticing that its SSH connection was gone.
- Retina: GNOME Remote Desktop could reset the scale right after a resize.
- Windows' self-signed RDP certificate failed TLS in Tabby; such desktops now use TLS 1.2 with RSA key exchange.

**Changed**
- The remote folder is now `~/.local/share/tabby-rdp` (was `tabby-remote-desktop`); existing installs are moved over
  on the next connection.
- IronRDP is built from a series of focused patches (`ironrdp/patches`).

## 0.1.0

First release: GNOME desktops in SSH tabs and in local terminals running `ssh`, one desktop per account, live resize
and Retina, text and image clipboard, and `desk` (opt-in) with the trd-pty shared session.
