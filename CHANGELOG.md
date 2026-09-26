# Changelog

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
