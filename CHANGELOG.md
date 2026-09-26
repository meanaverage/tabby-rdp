# Changelog

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
