# How tabby-rdp works

## The connection

```
Tabby window
 ├─ SSH tab (Tabby's SSH connection)
 │    └─ desktop layer over the terminal
 │         └─ iron-remote-desktop  (IronRDP, WebAssembly)
 │              │  WebSocket, RDCleanPath
 │              ▼
 │         RDCleanPath proxy  (src/rdcleanpath.ts, 127.0.0.1, random port, per-desktop token)
 │              │  X.224 request/confirm, then TLS; the server's certificate is checked and goes back to the client for CredSSP
 │              ▼
 └─ direct-tcpip channel on the same SSH connection  (src/ssh.ts, src/sshChannelStream.ts)
                │
                ▼
     remote: 127.0.0.1:3389 (GNOME Remote Desktop), xrdp's port,  or  any host:port the SSH host can reach (Windows)
```

Nothing is opened on the network. IronRDP's web client speaks RDCleanPath to a WebSocket proxy, as it would to
Devolutions Gateway; here the proxy runs inside Tabby and relays to an SSH channel instead of a TCP socket.

- **SSH tabs** use Tabby's own SSH connection (`sshSession.ssh`): tunnels are `direct-tcpip` channels, setup commands
  are exec channels.
- **Local terminals running `ssh`** (macOS and Linux): the plugin finds the `ssh` process under the shell (one `ps`
  snapshot of the process tree), keeps its connection options (`-p -i -J -l -F -o …`, not forwards or TTY flags) and
  opens its own non-interactive connections with the system `ssh` (`BatchMode=yes`): `-W host:port` for tunnels,
  `sh -s` for setup. That needs key or agent authentication (or a ControlMaster).
- **One desktop per account:** targets are compared as `user@hostname:port`, as resolved by `ssh -G`. A second tab to
  the same account switches to the tab that has the desktop open, instead of connecting a second client.

## The desktop layer

The desktop is a layer (`.trd-overlay`) over the terminal inside the pane, not a separate tab. The terminal stays
attached underneath; while the desktop shows, its input textarea is disabled, so nothing can type into the shell by
accident. IronRDP only takes keys while its element has focus, and Tabby focuses the terminal whenever a pane gets
focus, so the layer takes focus back on pane focus and on click.

Messages (connecting, errors, sign-in, reconnecting) show in the layer, with buttons where there is something to do.
A desktop keeps running while hidden, until it is disconnected or its tab closes.

## Setting up a GNOME desktop

GNOME Remote Desktop (grd) accepts a client only with a TLS certificate, a password and a running session. On each
connect, the plugin runs a short script as the SSH user over an exec channel (`src/remoteSetup.ts`). No root, nothing
installed beforehand:

1. **Keys and password:** `~/.local/share/tabby-rdp/` (mode 0700) holds a self-signed TLS key and certificate and a
   random RDP password (0600), made once.
2. **grd, headless mode:** `grdctl --headless` with the user `tabby` and that password, view-only off.
3. **A headless GNOME session:** if none runs, `systemd-run --user --unit=tabby-headless-shell gnome-shell --headless`,
   with a session identity (`XDG_CURRENT_DESKTOP`, Ubuntu's session mode when present) so that Settings and
   `xdg-open` behave. The activation environment is updated so that D-Bus-activated apps find the display, and
   `graphical-session.target` is held up for as long as the shell runs (a small transient unit bound to it), as
   gnome-session would: GNOME's portal requires it, and without the portal every GTK app waits 25 seconds to start.
   PipeWire's user sockets are started if they aren't yet (installed after the user's systemd started), since screen
   casting goes through PipeWire, and a virtual audio output is added if the machine has none, for sound.
4. **`desk`** (only when that setting is on): the login hook and helpers ([desk.md](desk.md)); when off, removes them.
5. **grd restarts only when its configuration changed:** it reads credentials at startup, and a restart drops open
   sessions.

The script prints one `RD_OK port=… user=… pass=… cert=…` or `RD_ERR <reason>` line; errors show in the desktop
layer. `cert` is the SHA-256 fingerprint of the certificate from step 1, the only one the proxy then accepts on that
port (see [Security notes](#security-notes)). A newly made certificate also restarts grd, which would otherwise keep
serving the old one.

## Linux desktops through xrdp

Before anything else, the setup script looks for xrdp: `/etc/xrdp/xrdp.ini`'s `[Globals] port=` (default 3389),
xrdp running (`systemctl is-active xrdp`, or its process) and something listening on that port. Then:

- **No GNOME** (no `grdctl` or `gnome-shell`), **xrdp running:** the script prints `RD_XRDP port=… user=…` and stops;
  nothing is set up, since xrdp starts a session when the user signs in. The host's own desktop becomes xrdp's, signed
  in like a desktop behind a host (the form, the keychain), with the SSH user suggested.
- **Both:** GNOME stays the host's own desktop, set up as before; the script adds an `RD_XRDP` line, and the host
  then also offers xrdp as a desktop at `127.0.0.1:<port>` (unless it shares grd's port, where one of them can't
  listen).
- **Neither:** the error says what's missing, and how to start or install xrdp.

What the setup found is kept per SSH account until Tabby restarts, so menus can offer the right desktops; it is
refreshed on each connection to the host's own desktop.

xrdp needs two things from the proxy (`src/rdcleanpath.ts`):

- **Autologon:** xrdp signs in with the credentials in the Client Info PDU only when it carries `INFO_AUTOLOGON`, and
  shows its own login window otherwise. IronRDP's web client doesn't set the flag, so for xrdp desktops the proxy,
  which has the client's side in the clear, sets that one bit in that one PDU and passes everything else untouched.
  Without NLA, a wrong password isn't refused by xrdp: its login window shows instead, and "Sign in again…" in the
  menus replaces a remembered password.
- **TLS:** xrdp's default (`security_layer=negotiate`) picks TLS, with its own (often the system's snakeoil)
  certificate, which the proxy accepts as it accepts any. A server that only offers RDP's standard security answers
  the negotiation without TLS; the proxy says so, with the setting to change, rather than failing in the handshake.

Graphics use the bitmap path, as for Windows, which every xrdp version serves (the graphics pipeline is newer in
xrdp, 0.10, and depends on how it was built). Resizing is display control, as for Windows: xrdp 0.10 answers it
with a deactivation-reactivation at the new size; 0.9 ignores it.

grd adds a virtual monitor per client and sizes it from the client's request, so a connection gets a monitor the size
of its pane. (A second client on the same account would get a second, empty monitor; hence one desktop per account.)

With a fixed resolution (`resize: off`), the picture is scaled to fit the pane, or shown at actual size in a
scrolling view (IronRDP's `Real` scale; `zoom: actual`).

**Resizing** uses RDP display control: grd answers a new monitor layout with an EGFX ResetGraphics, which the patched
web client follows. **Retina** (device pixels) also needs GNOME's scale set to match, which grd doesn't do from the
RDP scale factor: the plugin sets it through Mutter's `DisplayConfig` (temporarily, like Display settings before
"Keep changes"), and keeps it applied while grd settles its monitor. Windows takes the scale from the monitor layout
itself, but only when the layout also carries the monitor's physical size, which the plugin derives from the pane (96
CSS pixels to the inch). A desktop can have its own sharpness (`desktopSharpness`), overriding the default.

## Desktops behind a host

A configured desktop (`remoteDesktop.desktops`) is reached through the same SSH connection, as `host:port` from the
SSH host; nothing runs on either machine. It signs in with its own account: a form in the desktop layer, and
optionally the keychain (service `tabby-rdp`, through the `keytar` module Tabby itself uses for SSH passwords). A
wrong password brings the form back and drops the saved one.

- **Graphics:** Windows gets IronRDP's bitmap path. The graphics pipeline, which GNOME requires, stays off for it:
  without an H.264 decoder only the basic EGFX capability set is advertised, and Windows does better with bitmaps.
- **TLS:** Windows' self-signed RDP certificate only allows key encipherment, and the TLS library in Electron
  (BoringSSL) enforces that, which rules out every ECDHE and TLS 1.3 handshake. When a handshake fails for that reason,
  the proxy repeats the X.224 exchange on a fresh tunnel and uses TLS 1.2 with RSA key exchange for that desktop. The
  connection is still encrypted, without forward secrecy. A certificate with the digital-signature usage on the
  Windows side avoids the fallback.

## Keyboard

While a desktop covers the active pane (`src/keyboard.ts`):

- **Tabby's shortcuts** are filtered: only the desktop/console switch, tab switching (⌘1–9, next, previous, last
  used) and full screen stay Tabby's, and those don't reach the remote. Everything else goes to the remote only.
  (Unfiltered, ⌘V would paste into the hidden terminal and ⌘W would close the tab.)
- **Mac shortcuts** (macOS, on by default): ⌘ is sent as Ctrl, and a ⌘ tap on its own as the Windows key. ⌃⌘ with
  a key is sent as the Windows key with that key (Ctrl is let go on the remote first): with ⌘ as Ctrl, ⌃⌘ would only
  mean Ctrl again, so no combination is lost. Tabby's ⌃⌘F (full screen) stays Tabby's.
- **View only** (per desktop, kept across reconnects): keys stop at the router, and a layer over the picture takes
  the mouse (the wheel scrolls an actual-size picture instead). The layer carries the "View only" label.
- **Send keys** (menus): the desktop is shown and focused, and the combination goes to IronRDP as key events with
  their `code`, which it sends as scancodes, the way typed keys go.
- **Stuck keys:** macOS sends no keyup for a key pressed while ⌘ is down, so the remote gets one right after the
  keydown.

The router listens on `window`: after Tabby's hotkey listener (on `document`) and, registered at startup, before
IronRDP's.

## Clipboard, files, sound

- **Clipboard:** IronRDP's component, with the browser clipboard API in Tabby's window: text and images both ways.
- **Files:** IronRDP's file transfer provider. Files dropped on the layer (or picked from the menu) are offered on the
  remote clipboard; pasting there pulls them. Files copied on the remote are offered for saving (to Downloads,
  keeping folder structure, never overwriting).
- **Screenshots:** IronRDP draws into a 2D canvas at the remote resolution; it is saved as a PNG (to Downloads, never
  overwriting) and put on the clipboard through Electron.
- **Sound:** the patched web client hands 16-bit PCM to the plugin, which schedules it back to back on a Web Audio
  clock with a small lead, skipping ahead rather than letting delay grow, and follows the server's volume.

## Reconnecting

Tabby doesn't close an SSH session's channels when it tears the session down (sleep, network change, Reconnect), and
the session still reports itself open. The plugin watches each session's `willDestroy$`: tunnels end with it, and
"connected" means not torn down. A desktop that was connected and drops reconnects by itself (after 1, 2, 4, 8, 15 and
30 s, then it stops and offers Reconnect); while SSH is down it waits for it and offers "Reconnect SSH", since the
console, where Tabby offers that itself, is under the desktop. A hidden desktop reconnects in the background. A clean
end (signed out) or a desktop that never connected only offers a button.

## Security notes

- **grd listens on all interfaces:** it has no bind-address setting, so port 3389 is reachable from the network
  (password-protected, TLS). The plugin doesn't change the firewall. For loopback-only access, as root:
  `iptables -I INPUT -p tcp --dport 3389 ! -i lo -j DROP` (and the same with `ip6tables`).
- **Credentials:** the generated RDP password is in a 0600 file in a 0700 folder. `grdctl` takes it as an argument, so
  it is briefly visible in the remote's process list while the setup runs.
- **The local proxy** listens on 127.0.0.1 only, and requires a random token per desktop.
- **Server certificates:** RDP servers have self-signed certificates, so upstream TLS accepts any certificate and the
  proxy checks its SHA-256 fingerprint itself: after the handshake (the legacy TLS 1.2 retry included), and before the
  RDCleanPath response that the client waits for to start CredSSP. A refused server gets nothing of the account. The
  host's own desktop must show the certificate its setup made (`cert=` in the `RD_OK` line, from `openssl x509`);
  anything else is an error in the desktop layer, since something other than grd would be answering on its port.
  Desktops behind a host are trusted on first use: the fingerprint is remembered in `remoteDesktop.trustedCertificates`
  by desktop (`user@host#address`), without asking, since the way there already runs inside SSH. When it changes, the
  desktop layer shows the remembered and the new fingerprint and connects only after "Trust the new certificate".
  Every connection is checked, automatic reconnects included, and those stop at that question. Removing a desktop
  forgets its certificate; so does deleting its entry from the config file.
- **`desk`'s sessions** are Unix sockets in the user's runtime directory, checked for owner and mode, with the peer's
  uid verified.

## Notes for plugin development

- **Angular's zone:** anything that watches the DOM or runs on timers stays outside Angular's zone (see
  `src/header.ts`); inside it, each callback triggers app-wide change detection. User actions re-enter the zone.
- **IronRDP's component** forwards keys only while its own container is the first child of its shadow root, so styles
  go in through an adopted stylesheet, never an added element.
- **Tabby skips a plugin** whose `package.json` has no `author`.
