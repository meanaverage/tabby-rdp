<div align="center">

<img src="docs/images/logo.png" width="150" height="150" alt="tabby-rdp: a Tabby window with a GNOME desktop, a Windows desktop and two terminals side by side">

# tabby-rdp

**Remote desktops in your Tabby SSH tabs.**<br>
Linux and Windows, side by side, through the SSH connections you already have.

[![npm](https://img.shields.io/npm/v/tabby-rdp?color=3b82f6)](https://www.npmjs.com/package/tabby-rdp)
[![License: MIT](https://img.shields.io/badge/license-MIT-3b82f6)](LICENSE)
[![Tabby plugin](https://img.shields.io/badge/Tabby-plugin-6366f1)](https://tabby.sh)

<img src="docs/images/demo.gif" width="860" alt="Four desktops in one Tabby tab (GNOME, Windows, xrdp), a file pasted to all of them, a pane switched to its console, and desk">

<sub>Sharper: <a href="https://github.com/meanaverage/tabby-rdp/releases/download/v0.3.0/tabby-rdp-demo.mp4">the same demo as an MP4</a> (downloads)</sub>

</div>

---

tabby-rdp is a plugin for the [Tabby](https://tabby.sh) terminal. Press a key in an SSH tab and the machine's desktop
appears in its place; press it again and you're back at the shell. Everything travels inside the SSH connection:
nothing is opened on the network, and nothing has to be installed on the remote machine beforehand.

- **Linux desktops without a monitor or a login.** The plugin starts a headless GNOME session for your SSH user with
  GNOME Remote Desktop, on the fly, without root. A server in a rack works as well as a workstation.
- **Other Linux desktops** (KDE, XFCE, MATE, Cinnamon, …) through xrdp, where it runs: the plugin finds it by itself.
- **Windows desktops** behind any SSH host, such as a VM on your build server, and the desktop of a Windows machine
  you SSH into.
- **Remote desktop profiles** for machines you reach without SSH (LAN, VPN): in Tabby's profile list, in a tab of their
  own.
- **Several machines at once:** split a tab into a grid of desktops, then paste to all of them or type into all of them
  at once. A short on-screen name says which one you're in.
- **VMs found for you:** the libvirt VMs on an SSH host that have a desktop show up in its menu, ready to open, or to
  start and open.
- **`ssh` on from a host:** in an SSH tab where you typed `ssh` to another machine, the desktop is that machine's.
- **A proper desktop experience:** clipboard and files both ways, sound and microphone, live resize to the pane,
  sharp Retina rendering, Mac keyboard shortcuts, and automatic reconnects after sleep.
- **`desk`:** type `desk` in the console and the same shell, with its history and running programs, moves into a
  terminal on the desktop.

Everything is in **Settings › Remote Desktop**, in tabs: getting started and the shortcuts, the settings, the name
overlay, the desktops and certificates the plugin keeps, saved accounts, and troubleshooting.

The remote desktop itself is [IronRDP](https://github.com/Devolutions/IronRDP)'s web client, running inside Tabby.
Making it work with GNOME took fixes in IronRDP, which we contribute upstream ([below](#built-on-ironrdp)).

## Contents

- [Install](#install)
- [Use](#use)
- [Features](#features)
- [Windows and other desktops behind a host](#windows-and-other-desktops-behind-a-host)
- [Remote desktop profiles](#remote-desktop-profiles)
- [Saved accounts](#saved-accounts)
- [Shared folders](#shared-folders)
- [Several desktops in one tab](#several-desktops-in-one-tab)
- [VMs on a host](#vms-on-a-host)
- [desk: the console on the desktop](#desk-the-console-on-the-desktop)
- [Settings](#settings)
- [Requirements](#requirements)
- [Built on IronRDP](#built-on-ironrdp)
- [Development](#development)
- [Limitations](#limitations)
- [Questions and problems](#questions-and-problems)
- [License](#license)

## Install

In Tabby: **Settings › Plugins**, search for **tabby-rdp**, install, and restart Tabby.

Or from a terminal, into Tabby's plugin folder (on macOS `~/Library/Application Support/tabby/plugins`, on Linux
`~/.config/tabby/plugins`, on Windows `%APPDATA%\tabby\plugins`):

```sh
npm install tabby-rdp
```

## Use

Open an SSH tab to a Linux machine with GNOME, and:

- press **⌘⇧G** (Ctrl+Shift+G on Windows and Linux), or
- click **Desktop** in the SSH tab's toolbar, or the desktop button in Tabby's header, or
- right-click the terminal or the tab: **Open remote desktop**, under the **Remote Desktop** heading.

<p align="center"><img src="docs/images/desktop.png" width="760" alt="A GNOME desktop in a Tabby SSH tab"></p>

The first connection to a machine takes a few seconds while it prepares GNOME Remote Desktop and a session; later
ones take well under a second. The same shortcut switches between the desktop and the console, and the desktop keeps
running in the background until you disconnect or close the tab.

A machine without GNOME but with [xrdp](https://github.com/neutrinolabs/xrdp) running (the usual RDP server for KDE,
XFCE, MATE and the rest) gets xrdp's desktop instead: sign in with your Linux password, which the plugin can remember
in the system keychain. A machine with both keeps GNOME as the tab's desktop and, once that has been opened, also
offers **Open \<host\> desktop (xrdp)** in its menus.

It also works in a plain local terminal where you typed `ssh host` (macOS and Linux), as long as that host accepts
your key without a password prompt. And in an SSH tab where you typed `ssh` on to another machine: **Desktop** there
opens that machine's desktop, going through the first, as long as the first can log in to it by itself (a key there,
or agent forwarding). So one pane of a split can show the first machine's desktop, and the other, after `ssh other`,
that machine's.

One desktop per account: a second tab to the same `user@host` switches to the tab that has it open, rather than
connecting again.

## Features

| | |
|---|---|
| **Clipboard** | Copy and paste text and images in both directions. |
| **Files** | Copy files or folders in Finder and press ⌘V on the desktop, or drop them onto it, or use **Remote Desktop › Send files…** in the pane's menu; they paste in Files or Explorer. Files copied on the remote offer **Save to Downloads**. |
| **Shared folders** | Folders from this computer as drives on the remote desktop (`\\tsclient\<name>` in Explorer), read-write or read-only, for working with files in place: [below](#shared-folders). Windows (and xrdp with FUSE). |
| **Several desktops in one tab** | Paste to all of them, type into all of them, and see which is which: [below](#several-desktops-in-one-tab). |
| **VMs on a host** | The host's VMs with a desktop, ready to open: [below](#vms-on-a-host). |
| **Sound** | The remote desktop's sound plays locally. |
| **Microphone** | Optional (off by default): an app on the remote desktop that records, such as a call, gets your microphone. It is only captured while the app records, with an indicator in the corner of the desktop. |
| **Resize** | The remote resolution follows the pane as you resize the window or split it. Or reconnect at the new size, or keep a fixed resolution, scaled to fit or at actual size with scroll bars. |
| **Retina** | Optionally renders at device pixels, with the remote's UI scaled to match (GNOME and Windows alike), for sharp text. For all desktops, or only some. |
| **Keyboard on macOS** | ⌘C, ⌘V, ⌘Z and the rest work as on a Mac; tapping ⌘ alone is the Windows key, and ⌃⌘ with a key is the Windows key with it (⌃⌘R for Win+R). Tabby's own shortcuts stay out of the way while a desktop is showing, except switching tabs and returning to the console. |
| **Send keys** | In the desktop's menus: Ctrl+Alt+Del, Win+R, Win+L, Ctrl+Shift+Esc, Print Screen and more for Windows; Super, Super+A, Alt+F2 and more for GNOME. |
| **View only** | In the desktop's menus: watch a desktop without touching it. No keys or clicks go to it while a "View only" label shows; the picture, clipboard and sound carry on. Kept across reconnects, until the desktop is closed. |
| **Screenshots** | **Save a screenshot** in the desktop's menus saves the remote screen at its full resolution as a PNG in Downloads, and copies it to the clipboard. |
| **Connection status** | Optionally, a small line in the corner of the desktop with the throughput each way, frames per second, the SSH round trip, and how it is connected (desktop, host, resolution, graphics mode, sharpness). |
| **Reconnecting** | After sleep or a network change, the desktop reconnects by itself once the connection is back. |
| **Sign-in** | GNOME desktops need none: the plugin manages their credentials. Windows and xrdp desktops ask for the account once and can remember it, in Tabby's Vault when that is on and in the system keychain otherwise; **Sign in again…** in the menu replaces it. Desktops that share an account can use a [saved account](#saved-accounts), whose password is kept once. |
| **Shortcuts** | Switching between the desktop and the console, view only, a screenshot, Ctrl+Alt+Del, typing into or pasting to all desktops of a tab, the connection status and Disconnect each have a hotkey, set on the settings page or in Tabby's Hotkeys. They work while the desktop has the keyboard; a key another hotkey has is refused. |
| **Certificates** | GNOME desktops accept only the certificate the plugin made for them. Windows and xrdp desktops remember theirs on first use and ask before accepting a different one. |

<p align="center"><img src="docs/images/files.png" width="760" alt="A file copied on the remote desktop, offered for saving"></p>

## Windows and other desktops behind a host

An SSH host can lead to other desktops it can reach, such as a Windows VM on the same machine. In that host's menu,
choose **Desktops › Add a desktop behind \<host\>…** and enter a name, the address as seen from the host, and optionally the
user name and domain. It opens right away, and from then on appears under **Desktops** in the host's menu.
**Settings › Edit a desktop** changes one (its saved password, sharpness and remembered certificate
follow a new address; a new user name forgets the saved password), and **Remove a desktop** removes one, along with
its saved password and remembered certificate.

<p align="center"><img src="docs/images/windows.png" width="760" alt="A Windows 11 desktop, reached through an SSH host, in a Tabby tab"></p>

In Tabby's config file, they look like this:

```yaml
remoteDesktop:
  desktops:
    - name: Windows VM
      via: buildhost            # the SSH host: alias, hostname, user@hostname or user@hostname:port
      host: 192.168.122.20      # the RDP server as seen from that host
      port: 3389
      kind: windows             # or xrdp (a Linux desktop served by xrdp), or gnome
      username: alice           # optional; DOMAIN\user works too
      domain: CORP              # optional
      wake: { vm: win11 }       # optional: start it when it's off (see below)
```

The connection runs through the same SSH connection; the Windows machine needs Remote Desktop turned on, and nothing
else.

The first connection to a desktop remembers its TLS certificate, without asking (in Tabby's config, under
`remoteDesktop.trustedCertificates`). If a later connection meets a different one, the plugin stops before signing in
and shows both fingerprints, with **Trust the new certificate** and **Cancel**. Reinstalling Windows or renewing its
certificate changes it; if neither happened, something else is answering at that address. Automatic reconnects stop at
the same question.

**An SSH host that is itself Windows** (with OpenSSH Server): its own desktop is Windows' Remote Desktop, at
127.0.0.1:3389 as seen from the host. The plugin finds this out the first time you open the desktop there, and asks
for the Windows account instead (your SSH user name is filled in), with the same keychain option.

### Starting a desktop that is off

A VM on the SSH host, or a machine next to it, may be shut down when you want its desktop. With `wake`, the plugin
checks from the SSH host whether the desktop answers, and if it doesn't, starts it, shows **Starting \<name\>…** with
the time so far, and connects as soon as it answers (it gives up after 3 minutes):

- `wake: { vm: win11 }` starts the libvirt VM `win11` on the SSH host with `virsh start`, as your SSH user: first in
  `qemu:///system` (you need to be in the `libvirt` group, or allowed by polkit), then in your own `qemu:///session`.
  A paused VM is resumed.
- `wake: { mac: "aa:bb:cc:dd:ee:ff" }` sends a Wake-on-LAN packet from the SSH host (with `python3`, to the broadcast
  address, UDP port 9). Add `broadcast: 192.168.1.255` for a particular network, or `port: 7`.

In the add and edit forms, the last field takes a VM name or a MAC address. Automatic reconnects never start a desktop,
since it may have been shut down on purpose; **Reconnect** does.

## Remote desktop profiles

For an RDP server this computer reaches by itself (on the LAN, or over a VPN), there is a Tabby profile type:
**Settings › Profiles & connections › New profile › Remote desktop (RDP)**. Give it the address, the kind (Windows,
xrdp or GNOME Remote Desktop), and optionally the user name and domain. It then shows up in Tabby's profile list like
SSH profiles do, and opens in a tab of its own that the desktop fills; there is no console under it. Sign-in, the
keychain, certificates, resize, sharpness, clipboard, files, sound, microphone, **Send keys**, view only, screenshots
and reconnecting work as in SSH tabs. After **Disconnect**, the tab offers **Connect**. In the profile selector you can
also type `user@host:port` and pick **Quick connect (REMOTE DESKTOP (RDP))**.

**Import an .rdp file…** (in the menu's **Settings**, or **Remote desktop: import an .rdp file…** in Tabby's
command palette) makes such a profile from a file saved by Remote Desktop Connection or handed out by an admin: its
address, port, user name and domain, named after the file. Other settings in the file (screen size, drives, gateway)
are ignored.

Its **Connect** setting can name an SSH profile instead of connecting directly. The address is then as that host sees
it, and opening the profile opens that SSH tab and shows the desktop over it once SSH is connected. Such a desktop is
also offered in the menus of that SSH profile's tabs, next to the host's own desktop, so it works like a desktop
added with **Desktops › Add a desktop behind \<host\>…**, but with a place in the profile list.

In Tabby's config file:

```yaml
profiles:
  - type: rdp
    name: Office PC
    options:
      host: 192.168.1.20        # as this computer sees it (or as the SSH host sees it, with via)
      port: 3389
      kind: windows             # or xrdp, or gnome
      username: alice           # optional
      via: ''                   # or the id of an SSH profile to go through
```

A direct connection is a plain TCP connection from this computer, encrypted with TLS like any RDP client's. The
server's certificate is remembered on the first connection and checked on every later one, as for desktops behind a
host (above).

## Saved accounts

Several desktops often share one account: a domain admin, a lab user. A saved account keeps that user name (and
domain) under a name, with its password stored once, so when the password changes it is entered once for all of them.

**Settings › Remote Desktop › Accounts** lists them, with the desktops that use each one (click a name to open its
settings), and adds, edits and removes them. A desktop picks its account in its profile's **Account** field, or in the
form that adds a desktop behind an SSH host; **New account…** there adds one on the spot. A profile group's defaults
for **Remote desktop (RDP)** can pick an account for every profile in the group (**Profiles & connections**, the group's
menu), which is how to give a whole group of servers one sign-in.

Signing in with a saved account that has no password yet, or whose password a server refused, asks for it, and the
form saves what you enter as the account's new password for every desktop. A refused password is not dropped by
itself: one server refusing it doesn't make it wrong for the others. **Sign in again…** on such a desktop asks anew.

The accounts' names and user names are in Tabby's config (`remoteDesktop.accounts`); the passwords are in Tabby's
Vault when it is enabled (encrypted, and carried by Tabby's config sync), else in the system keychain. Removing an
account removes its password and sets its desktops back to asking.

## Shared folders

A folder on this computer can appear as a drive on the remote desktop, as mstsc's drive redirection does: in
**Settings › Remote Desktop › Settings › Shared folders**, **Share a folder…** picks one. On the remote it is
`\\tsclient\<name>` ("<name> on <this computer>" under This PC in Explorer), named after the folder; **Read-only**
keeps the remote from changing, adding or removing anything in it. Every remote desktop you connect to sees the shared
folders, so share only what each of them may have, and remove a folder to stop sharing it. Changes apply on the next
connection.

<p align="center"><img src="docs/images/shared-folders.png" width="548" alt="Shared folders in Settings › Remote Desktop: two folders, one read-only, and Share a folder…"></p>

Files are served through the RDP connection as the remote reads and writes them, which suits opening and saving
documents in place; for moving large files, copying through the clipboard is just as quick. They are read and written
in the background, so a slow disk or network folder slows the drive down, not Tabby.

The remote gets the shared folder and nothing else: a symbolic link works when it points inside the folder, and one
that leads out of it isn't shown, read or written through. Only files and folders are served (no devices or pipes).

Windows mounts shared folders (tested); xrdp can when built with FUSE (under `~/thinclient_drives`); GNOME Remote
Desktop doesn't serve drives, so there the clipboard is the way.

## Several desktops in one tab

Split a tab (Tabby's **Split** in the tab's menu, or drag one tab onto another) and each pane can show a desktop: one
machine's desktop next to another's, or next to its own console. Right-click any of them:

- **Paste to all \<n\> desktops in this tab** pastes what's on your clipboard on every desktop in the tab, in whichever
  window is active on each: text, a picture, or files and folders copied in Finder (or Explorer, or Files).
- **Type into all \<n\> desktops in this tab** sends every key you type on one desktop to the others too, shortcuts and
  **Send keys** included, until you turn it off. An orange label on each desktop says so while it's on. The mouse stays
  per desktop, and desktops in view-only mode are left out.
- **Make panes even** evens out the split's panes, which Tabby does itself but offers nowhere else.

As you click into a desktop, its name shows in its corner for a moment, like a TV naming its input ("BUILDBOX", or "WIN-11 ·
via buildhost · 1920×1080"). It shows by default where it helps (in a split, and for a desktop other than the tab's own
connection); **Settings › Remote Desktop › Desktop name overlay** sets when, and its font, size, place and color, with a
preview. Desktops are named after their SSH profile's name.

## VMs on a host

When you right-click an SSH host, the plugin looks at the host's libvirt VMs (`virsh`, as your SSH user; read-only, at
most once a minute) and lists the ones with a desktop under **Desktops**, with nothing to set up:

- a running VM whose RDP port answers: Windows, or Linux with xrdp;
- a Windows VM that's shut off: **Start and open**, which starts it (`virsh start`) and connects as soon as it answers.

A Linux VM that runs GNOME is left out: its desktop is reached by SSH-ing to it (its own desktop, or `ssh` typed in a
console on the host, [above](#use)). A VM found this way asks for its account the first time, like any Windows or xrdp
desktop; **Save \<name\> to this host's desktops** in its menu keeps it, for a name of your own and other settings.
**Settings › Remote Desktop › Find virtual machines on SSH hosts** turns this off.

A VM the plugin started can go back off by itself: **Settings › Remote Desktop › Shut down VMs it started** (5
minutes, 15 or an hour without a desktop open; never, by default). A small watcher on the SSH host sees to it, so it
also works once the tab is closed or Tabby has quit: after that long with no connection to the VM's desktop through the
host, it asks the VM to shut down (`virsh shutdown`, with a key press first, since Windows ignores the request while its
screen sleeps), then ends. VMs that were already running are never touched, and neither are machines woken over the
network.

## desk: the console on the desktop

Type `desk` in an SSH console, and the tab switches to that machine's desktop with a terminal attached to the very same
shell: its scrollback, working directory, jobs and running programs. Type on either side; both show it.

<p align="center">
  <img src="docs/images/console.png" width="49%" alt="A console">
  <img src="docs/images/desk.png" width="49%" alt="The same shell on the desktop, after typing desk">
</p>

`desk` is off by default, because it makes interactive SSH logins on that machine start inside a shareable session.
Turn it on in the pane's menu under **Remote Desktop › Settings**, or in Settings › Remote Desktop. The sessions are handled by a small helper, `trd-pty`, rather than tmux, so
your terminal's scrollback, colors and shortcuts stay as they are. Turning it off removes it again. Details:
[docs/desk.md](docs/desk.md).

## Settings

Open **Settings › Remote Desktop** in Tabby, right-click the desktop button in Tabby's header, or open **Settings** in the Remote Desktop section of a terminal's or tab's menu.
They are stored in Tabby's config under `remoteDesktop`:

| Setting | Default | |
|---|---|---|
| When the pane is resized (`resize`) | Resize the remote desktop to fit (`live`) | Or reconnect at the new size (`reconnect`), or keep the resolution (`off`). |
| Keep the resolution: scale to fit or actual size (`zoom`) | Scale to fit (`fit`) | With `resize: off`: `actual` shows one remote pixel per point, with scroll bars when the desktop is larger than the pane (a Retina-sized desktop shows at twice the size). |
| Sharpness (`sharpness`) | Standard (`standard`) | Retina (`retina`): device pixels, with the remote's scale set to match. |
| For *this desktop* only (`desktopSharpness`) | As above | In the menu of a tab with a desktop open: Standard or Retina for that desktop, whatever the default. Kept by desktop (`user@host`, `user@host#address` for one behind a host, or `rdp#address` for a remote desktop profile's own tab). |
| Sound (`sound`) | On | Applies on the next connection. |
| Video decoding (`h264`) | On | H.264 decoded by Tabby's browser engine (hardware-accelerated where available), for what the remote sends as video; applies on the next connection. |
| Microphone (`microphone`) | Off | Send your microphone while an app on the remote desktop records. Applies on the next connection. |
| Shared folders (`sharedFolders`) | None | `[{ path, name, readOnly }]`: folders shared as drives with every remote desktop ([Shared folders](#shared-folders)). Applies on the next connection. |
| Show connection status (`connectionStatus`) | Off | The indicator in the desktop's corner; fades when the pointer comes near. |
| Mac shortcuts (`macShortcuts`) | On | macOS. Off: ⌘ is the Windows key. |
| Shortcuts (`hotkeys.remote-desktop-*`) | ⌘⇧G / Ctrl+Shift+G for the switch; the rest unbound | Tabby's hotkeys: the switch between desktop and console, view only, screenshot, Ctrl+Alt+Del, type into all, paste to all, connection status, disconnect. Changed on the settings page (Getting started › Shortcuts) or in Settings › Hotkeys. |
| Saved accounts (`accounts`) | None | `[{ id, name, username, domain }]`; see [Saved accounts](#saved-accounts). The passwords are in the Vault (encrypted, part of the config) or the keychain, never in plaintext in the config. |
| Bring the console along with `desk` (`desk`) | Off | Installs `desk` and a login line on each machine you open a desktop on; applies on the next connection there. |
| Session backend (`sessionBackend`) | `native` | For `desk`: `native` (trd-pty) or `tmux`. Config file only. |
| Find virtual machines on SSH hosts (`discoverVMs`) | On | Lists a host's libvirt VMs with a desktop in its menu ([VMs on a host](#vms-on-a-host)). |
| Shut down VMs it started (`shutDownIdle`) | Never | 5, 15 or 60: minutes without a desktop open after which a VM the plugin started is shut down again ([VMs on a host](#vms-on-a-host)). |
| Tell me about new versions (`checkUpdates`) | On | Once a day, asks npm for the latest tabby-rdp (nothing else is sent), and says so in a note, the menus and the settings page when there's a newer one: Tabby itself shows plugin upgrades only on its Plugins page. |
| Desktop name overlay (`osd`) | When it helps | `show` (`auto`, `always`, `off`), `font`, `size`, `position`, `color` (empty: white) and `seconds`; the settings page previews it, at a resolution you pick. |

## Requirements

- **Tabby 1.0.236 or newer**, on macOS, Windows or Linux (tested with 1.0.236 and 1.0.237). On a fresh Windows, Tabby
  itself needs the [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist)
  for SSH.
- **Linux desktops:** GNOME Shell and GNOME Remote Desktop 46 or newer (Ubuntu 24.04, for example), a systemd user
  session, and SSH access with a key or agent. `desk` also needs `python3` and GNOME Terminal. No root, no display, no
  login screen.
- **Other Linux desktops:** xrdp running on the machine, with a desktop for its sessions (on Debian and Ubuntu:
  `sudo apt install xrdp xfce4`, or KDE, MATE, …), and an account with a password. xrdp's default settings work
  (`security_layer=negotiate`, its own certificate); the port is read from `/etc/xrdp/xrdp.ini`. Sound needs
  `pipewire-module-xrdp` or `pulseaudio-module-xrdp`.
- **Windows desktops:** Windows 10 or 11 Pro, or Windows Server, with Remote Desktop turned on, reachable from an SSH
  host or running OpenSSH Server itself.

Tested with Ubuntu 24.04 (GNOME Remote Desktop 46.3) and Windows 11 (Pro and Enterprise), from Tabby on macOS,
Windows 11 and Ubuntu 24.04 (arm64).

## Built on IronRDP

The desktop is [IronRDP](https://github.com/Devolutions/IronRDP)'s web client: an RDP implementation in Rust, compiled
to WebAssembly, with a web component. It connects to Windows, but a browser-based client for GNOME Remote Desktop
needed more: GNOME only speaks RDP's graphics pipeline, which IronRDP's web client didn't offer; it resizes its
monitor in a way the web client didn't follow; and it depends on details of the sound and dynamic-channel protocols
that IronRDP got slightly wrong. The web client also had no sound at all.

tabby-rdp ships IronRDP with a short series of patches ([ironrdp/](ironrdp)). The fixes go upstream, one by one:

| Change | Upstream |
|---|---|
| Keep the session when a server sends data on a channel the client declined | [Devolutions/IronRDP#2005](https://github.com/Devolutions/IronRDP/pull/2005) |
| Fit the web component to its container, not the whole window | [Devolutions/IronRDP#2006](https://github.com/Devolutions/IronRDP/pull/2006) |
| Set up the clipboard before signaling `ready`, so it works for apps that connect right away | [Devolutions/IronRDP#2018](https://github.com/Devolutions/IronRDP/pull/2018) |
| Echo the correct size in the sound channel's Training Confirm | [Devolutions/IronRDP#2019](https://github.com/Devolutions/IronRDP/pull/2019) |
| The graphics pipeline in the web client, following its resets | Covered by [Devolutions/IronRDP#1977](https://github.com/Devolutions/IronRDP/pull/1977) (not ours; [tested with GNOME](https://github.com/Devolutions/IronRDP/pull/1977#issuecomment-5851624036)) |
| Sound in the web client | [Devolutions/IronRDP#2020](https://github.com/Devolutions/IronRDP/pull/2020) |
| Let the host send key events to a session | [Devolutions/IronRDP#2026](https://github.com/Devolutions/IronRDP/pull/2026) (design under discussion) |
| Decode Windows' RemoteFX Progressive refinements | Covered by [Devolutions/IronRDP#2010](https://github.com/Devolutions/IronRDP/pull/2010) and [#1977](https://github.com/Devolutions/IronRDP/pull/1977) (not ours) |
| H.264 in the web client, decoded by the browser (WebCodecs) | Not submitted yet: waits for #1977 |
| Microphone in the web client | Not submitted yet: waits for #2020 |
| Keep clipboard sync working for the other desktops when one closes | Not submitted yet |
| Sync the clipboard only for the desktop that has the focus | Not submitted yet |
| Drive redirection in the web client, through a JavaScript file system | Not submitted yet |
| Send chunked static-channel messages without CHANNEL_FLAG_SHOW_PROTOCOL, as Windows' drive redirector expects | Not submitted yet |

The aim is to make IronRDP's browser client work well with both Linux and Windows desktops, for everyone who embeds
it, not just this plugin.

## Development

```sh
npm install
npm run build                # TypeScript to dist/
scripts/sandbox.sh           # a separate Tabby with this plugin linked in (macOS), DevTools on port 9334
npm test                     # end-to-end suites against a test machine: see test/README.md
npm run build:ironrdp        # rebuild vendor/ from IronRDP and ironrdp/patches: see ironrdp/README.md
```

- [docs/architecture.md](docs/architecture.md): how the pieces fit, the remote setup, and security notes.
- [docs/desk.md](docs/desk.md): `desk` and trd-pty.
- [test/README.md](test/README.md) and [testbed/README.md](testbed/README.md): the tests, and setting up test
  machines for them.
- [CONTRIBUTING.md](CONTRIBUTING.md).

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
  loopback only. See [docs/architecture.md](docs/architecture.md#security-notes) to restrict it.
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
- **Waking a desktop** over the network (Wake-on-LAN) starts it but never shuts it down again; for VMs, see
  [Shut down VMs it started](#vms-on-a-host).

## Questions and problems

Questions ("how do I…", "is this expected?") go to [Discussions › Q&A](https://github.com/meanaverage/tabby-rdp/discussions/categories/q-a);
bugs and feature requests to the [issues](https://github.com/meanaverage/tabby-rdp/issues). A bug report is most useful
with the connection log: **Settings › Remote Desktop › Troubleshooting › Open desktops › Copy log**.

## License

[MIT](LICENSE). The bundled IronRDP build is MIT or Apache-2.0 ([vendor/IRONRDP-LICENSE](vendor/IRONRDP-LICENSE)).
Icons in the header are from [Font Awesome Free](https://fontawesome.com) (CC BY 4.0).

tabby-rdp is an independent project, not affiliated with Tabby, Devolutions or the GNOME Project.
