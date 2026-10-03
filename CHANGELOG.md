# Changelog

## 0.5.0

Shared folders, desktops behind an RD Gateway, Hyper-V VMs' consoles, more of what an .rdp file says, text sent as
typed; more care with addresses that come from someone else; and fixes from a review of the code.

**New**
- **Shared folders** ([#26](https://github.com/meanaverage/tabby-rdp/issues/26)): folders from this computer appear as
  drives on the remote desktop, under `\\tsclient` in Explorer, like mstsc's drive redirection. Settings › Remote
  Desktop › Settings › Shared folders: **Share a folder…**, each one read-write or read-only. Every desktop you connect
  to sees them; applies on the next connection. Windows mounts them (xrdp can, with FUSE); GNOME Remote Desktop
  doesn't serve drives. Files move at the drive's pace through the RDP connection, so this is for working with files
  in place rather than copying gigabytes; the clipboard still carries files either way. The remote gets the folder
  and nothing else: `..` and symbolic links that lead out of it don't resolve, and only files and folders are served.
  File operations run in the background (Node's thread pool), one request at a time, so a slow disk or network
  folder slows the drive, not Tabby's window.
- **Hyper-V VMs** ([#28](https://github.com/meanaverage/tabby-rdp/issues/28)): on a Windows SSH host that runs
  Hyper-V, its VMs are listed among the host's desktops (`Get-VM`, with PowerShell over the SSH connection), and one
  that is off is started when opened. What opens is the VM's console, through the host (port 2179), as Hyper-V
  Manager's Connect does: no network or Remote Desktop needed in the VM. A Windows guest that is up gets an enhanced
  session; otherwise it is the basic console. The sign-in is the host's, asked once per host; an account the host
  signs in but doesn't let open the console (it ends the connection at once) brings the form back, saying so.
- **RD Gateway** ([#29](https://github.com/meanaverage/tabby-rdp/issues/29)): a remote desktop profile, or a desktop
  behind an SSH host, can name a Remote Desktop Gateway (**RD Gateway**: `rdgw.example.com`, or `host:port`). The
  connection then goes to the gateway over HTTPS (its WebSocket transport, Windows Server 2012 R2 and later), signs in
  there with a user name and password, and is connected on to the desktop, whose address is as the gateway sees it.
  The desktop's sign-in is the gateway's too unless the profile picks a saved account for the gateway. A sign-in the
  gateway refuses brings the form back saying it was the gateway, before anything goes to the desktop; a desktop its
  policy doesn't allow, or that it can't reach, is an error saying which. The gateway's certificate is accepted when
  valid for its name and otherwise remembered on first use; a changed one stops the connection until it is trusted.
  The sign-in (NTLMv2) is bound to the gateway's TLS certificate, which gateways require by default. Smart cards,
  sign-in pages and one-time codes at the gateway aren't supported.
- **.rdp files** ([#27](https://github.com/meanaverage/tabby-rdp/issues/27)): an import applies the file's display
  scale (`desktopscalefactor` 150 or more becomes the desktop's Retina sharpness) and its RD Gateway
  (`gatewayhostname`, unless the file turns it off), and says which of its other settings the plugin doesn't apply
  (sound left on the remote or off, a fixed window size, its own drives (shared folders are a setting here), printer,
  smart card or USB redirection, several monitors, RemoteApp, an account of its own or a smart card at the gateway),
  instead of ignoring them silently.
- **Send text as typed** ([#31](https://github.com/meanaverage/tabby-rdp/issues/31)), a setting: the characters the
  keyboard produces go to the desktop rather than key positions, so dead keys and a layout the remote doesn't have
  come out right; keys with Ctrl, Alt or ⌘ still go by position, so shortcuts keep working. Off by default. Windows
  types any character; a GNOME desktop only those its own layout has. Input methods (Chinese, Japanese, Korean) need
  more than this and stay open in #31.
- IronRDP's web client gains drive redirection (MS-RDPEFS) through a JavaScript file system (patch 15), and its
  static channels send multi-chunk messages Windows accepts (patch 16): a response over 1600 bytes was flagged for the
  receiver to keep the channel header, which Windows' drive redirector didn't expect and dropped the channel on.

**Safer with addresses that come from someone else**
- **Importing an .rdp file asks first**, naming the address, the gateway and the account the file leads to, with
  **Add and connect**, **Add only** and **Cancel**. It used to add the profile and connect at once. Nothing in a file
  runs on this computer (and a program it names for the remote isn't asked for), but a file decides where your
  sign-in goes.
- **A Windows desktop whose server doesn't use Network Level Authentication stops before the password is sent.**
  Without it the password goes to the server as it is (encrypted on the way, readable to whatever answered), which a
  server posing as a Windows machine can ask for; the first certificate being trusted on sight, nothing stood in the
  way. The connection now stops when the server's answer says so, before TLS, and asks: **Send the password anyway**
  (remembered for that desktop, shown and forgotten with its certificate under Settings › Remote Desktop ›
  Certificates) or **Cancel**. xrdp signs in this way by design: desktops of the xrdp kind aren't asked about.

**Fixed**
- **Save to Downloads** couldn't be led elsewhere by the remote's file names alone, but could by a link already in
  Downloads with a name the remote chose (a folder name, say). Folders are now made one at a time and must stay inside
  the folder once links are followed, and each file is created new: an existing name, link or not, gets a number.
- **Large files copied from the remote** were held in memory, twice over while being saved. They now arrive in a
  private temporary file and are moved into place.
- **The plugin's local proxy** (loopback, one per desktop) kept whatever a local program sent before showing the
  session's token, with no limit or deadline, and an error on such a connection wasn't handled. The first message is
  now capped at a request's size and has ten seconds to arrive, at most four clients connect at once, and messages
  are capped at 32 MB. Reaching the server has a deadline too.
- **A connection given up while the server was being reached** (the tab closed, Cancel) left that connection open
  until it finished; closing a desktop could leave an idle proxy connection behind. Both end at once now.
- **Data waiting for a slow side** was buffered without limit. The proxy now pauses the side it reads from while the
  other has more than 8 MB waiting, and a desktop reached through SSH whose data isn't being read at all is closed at
  64 MB rather than growing.
- **Dropping files on a desktop after a reconnect** (a wrong password first, a certificate question) offered them
  once per connection attempt, through handlers the earlier attempts left behind.
- **Shortcut modifiers could stay held on the remote:** turning on view only, or turning off typing into all
  desktops, by a shortcut sent the modifiers' key-down to the remote but not their release. Keys held at that moment
  are released first.
- **H.264: small changes far apart** (a clock in one corner, a cursor in another) read back everything between them:
  33 MB for a 4K picture to get a few pixels. Regions far apart are read one by one (IronRDP patch 17).
- **A desktop whose server went away could stay on screen, frozen.** Through an SSH host, a server that closes the
  connection (a machine shut down, a VM stopped) is reported as the end of what it sends, and not always as closed;
  the plugin waited for "closed", so the desktop sometimes stayed up, still marked connected, with no reconnect. The
  end of the server's side now ends the desktop, and reconnecting takes over as for any drop.
- **Linux without an unlocked keyring: Tabby could stop opening connections.** A keychain call there never returns
  and keeps one of Node's four worker threads waiting. The plugin gave the keychain up after the first such call, but
  calls started together (the settings page asking whether each saved account has a password, a desktop signing in
  meanwhile) each kept a thread first, and with all four taken, Tabby's file access and name lookups waited forever:
  a new SSH tab stayed at "Connecting". Keychain calls now go one at a time, so at most one thread is ever kept.

## 0.4.1

Fixes from a review of 0.4.0.

**Fixed**
- **Two desktops saving a password at the same moment** could lose one of them: Tabby's Vault rewrites its whole
  contents per change. The plugin's Vault changes now go one after another.
- **A saved account took the desktop's old domain:** an account with a plain user name and no domain was signed in with
  the domain the desktop had been given before, a field the form hides once an account is chosen. The account's domain
  (also none) is what is used.
- **A profile group's account didn't reach profiles reached through an SSH profile** in that host's tab menu; it does
  now, as it did when opening the profile itself.
- **"Ask for the account" on a new profile from the settings page** could be overridden by the "Remote desktops"
  group's default, since the group was assigned after the editor closed. The profile is in the group before the editor
  opens.
- **Removing an account** also clears a profile group default that named it, and says so when the password itself
  couldn't be removed. A desktop whose account is gone asks for one, rather than signing in with a login of its own
  saved earlier. A sign-in prompt left open while its account was removed or renamed no longer saves under it.
- **Editing an account's user name** keeps the old name when the old password couldn't be removed, so the two never
  disagree; a password kept for an account's earlier user name isn't used for the new one. A new account whose password
  couldn't be saved isn't added.
- **Hotkey collisions** are found among all of Tabby's bindings, per-profile and per-group hotkeys included, and named
  by the profile or group; the note says only one of the two would act.
- The settings page checks the accounts' passwords one after another, and not at all once the keychain has stopped
  answering, so a Linux keyring that doesn't answer can't hold every keychain worker.
- Cancelling or finishing **New account…** brings the user name fields back; the Vault lists a saved account's
  password by the account's name, as intended.

## 0.4.0

**New**
- **Saved accounts** ([#11](https://github.com/meanaverage/tabby-rdp/issues/11)): a user name and domain under a
  name, with the password kept once, for desktops that share an account. Chosen in a remote desktop profile's
  **Account** field or in the form for a desktop behind an SSH host (**New account…** there adds one), or for a whole
  profile group through the group's defaults. Listed, added, edited and removed in **Settings › Remote Desktop ›
  Accounts**, which names the desktops using each account. A password a server refuses is asked for again and saved
  for every desktop; **Sign in again…** asks anew.
- **Passwords in Tabby's Vault** when it is enabled, as Tabby keeps SSH passwords: encrypted, and carried by config
  sync. The system keychain as before otherwise, and still read for what was saved before the Vault was turned on.
- **Configurable shortcuts** ([#15](https://github.com/meanaverage/tabby-rdp/issues/15)): view only, a screenshot,
  Ctrl+Alt+Del, typing into all desktops of a tab, pasting to all of them, the connection status and Disconnect join
  the desktop/console switch as Tabby hotkeys, set on the settings page in the look of Tabby's Hotkeys page (or
  there). A key another hotkey already has is refused, and collisions made elsewhere are shown.
- **The settings page in tabs** — Getting started, Settings, Overlay, Desktops, Accounts, Troubleshooting — as
  Tabby's Profiles & connections page is, with the settings grouped (Picture, Sound, Keyboard, SSH hosts, Updates)
  and the detail behind ⓘ tooltips. The Desktops tab lists remote desktop profiles as well as desktops behind SSH
  hosts, and adds, edits and removes both; profiles the plugin makes go into a "Remote desktops" group.
- **A clearer reason when a connection fails** before it is up ("10.3.0.5:3389 did not answer"), in place of
  IronRDP's "general error (code 1)".
- The **name overlay preview** says which desktop resolution it stands for, and lets you pick one
  ([#16](https://github.com/meanaverage/tabby-rdp/issues/16)).

**Fixed**
- **The window could not be moved by its tab bar while a dialog was open**
  ([#19](https://github.com/meanaverage/tabby-rdp/issues/19)), the plugin's and Tabby's alike. Each dialog keeps a
  strip the height of the tab bar draggable. Submitted to Tabby as well.
- **A stale update notice** in a Tabby left open across several releases
  ([#17](https://github.com/meanaverage/tabby-rdp/issues/17)): opening the settings page with an update known asks
  npm again.
- Opening the settings page no longer prompts for the Vault passphrase.

**Docs**
- README: saved accounts, shortcuts, and where passwords are kept. Tabby's Vault page labels the plugin's secrets
  generically until Tabby ships [#11765](https://github.com/Eugeny/tabby/pull/11765)
  ([#18](https://github.com/meanaverage/tabby-rdp/issues/18)).

## 0.3.4

**Fixed**
- **Paste to all desktops in a tab** pasted this computer's clipboard only on the desktop with the focus; the others
  pasted whatever they had copied last. Since 0.3.2 only the focused desktop follows the clipboard, so the text or
  picture is now sent to each desktop before its paste. The paste shortcut while typing into all desktops does the
  same.

## 0.3.3

**Fixed**
- **H.264 video from a hostile remote desktop:** the server picks which parts of a video frame the plugin reads back
  from the browser's decoder, and nothing limited how much. One region larger than the picture, or many overlapping
  copies of the whole screen, could make it allocate enough memory to crash Tabby along with every tab in it. What a
  frame reads back is now bounded by the screen it draws on (overlapping regions are read once, as the box around
  them), and a frame that would still need more than 256 MiB is decoded without reading anything back (IronRDP
  patch 8). H.264 is on by default, so this applies wherever the browser decodes the video.

**Docs**
- The README's table of upstream IronRDP changes lists the keyboard API (#2026), says the Progressive decoding fix is
  covered by IronRDP #2010 and #1977, and says what each patch not submitted yet waits for.

## 0.3.2

**New**
- **Shut down VMs it started:** a VM the plugin started to open its desktop can go back off after 5 minutes, 15 or an
  hour with no desktop open (a setting; never, by default). A watcher on the SSH host sees to it, so it also works after
  the tab is closed or Tabby has quit.

- **A GNOME desktop that's open elsewhere** (another computer, or another Tabby window): opening it asks whether to
  take it over, as Windows does (the other connection is disconnected; the session and its apps carry on), or to open
  a second screen, which is what happened before. A desktop taken over doesn't take itself back.

**Better**
- **The headless GNOME session** runs X11 apps (through XWayland), and GNOME's settings daemons for keyboard, media
  keys and custom shortcuts, accessibility and sound; not power, so it never suspends the machine. A session that's
  already running gets them on the next connect, without closing its apps.

**Fixed**
- **A blank desktop after reconnecting** (GNOME): when the server sent the end of the connection sequence and the start
  of the graphics channel together, IronRDP lost the latter and the desktop stayed transparent. The proxy now hands it
  each server message on its own.
- **The clipboard with several desktops open:** closing one desktop stopped the automatic clipboard for the others,
  and a desktop in the background could overwrite what was copied on another. The desktop with the focus syncs the
  clipboard; copies made on another reach the Mac when it gets the focus (IronRDP patches 12 and 13).
- IronRDP patch 14, meant for upstream: H.264 pictures read correctly in Safari, whose `copyTo` ignores the RGBA format.
- A closed desktop no longer leaves its pane's subscription and its label timer behind.
- The first-connect tip shows the desktop/console hotkey as text: a label from the config could carry markup into
  the page.

**Docs**
- The limitation about Win+R from macOS is gone: ⌃⌘ with a key has been the Windows key with it since 0.3.0.

## 0.3.1

**New**
- **New versions:** Tabby shows plugin upgrades only while its Plugins page is open, so tabby-rdp now says so itself.
  Once a day it asks npm for the latest version (nothing else is sent); a newer one gets a note once, an **Update
  available** item in the menus and a line on Settings › Remote Desktop, each leading to Tabby's Upgrade button.
  **Tell me about new versions** turns it off.

**Docs**
- The README's demo plays in the page (a GIF), on GitHub and on npm.

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
