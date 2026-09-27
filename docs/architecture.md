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
 │              │  X.224 request/confirm, then TLS; the server's certificate goes back to the client for CredSSP
 │              ▼
 └─ direct-tcpip channel on the same SSH connection  (src/ssh.ts, src/sshChannelStream.ts)
                │
                ▼
     remote: 127.0.0.1:3389 (GNOME Remote Desktop)  or  any host:port the SSH host can reach (Windows)
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

The script prints one `RD_OK port=… user=… pass=…` or `RD_ERR <reason>` line; errors show in the desktop layer.

grd adds a virtual monitor per client and sizes it from the client's request, so a connection gets a monitor the size
of its pane. (A second client on the same account would get a second, empty monitor; hence one desktop per account.)

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

- **Graphics:** with H.264 (below), the graphics pipeline, as for GNOME. Without it, IronRDP's bitmap path: with
  only the basic EGFX capability set advertised, Windows does better with bitmaps than with the pipeline.
- **TLS:** Windows' self-signed RDP certificate only allows key encipherment, and the TLS library in Electron
  (BoringSSL) enforces that, which rules out every ECDHE and TLS 1.3 handshake. When a handshake fails for that reason,
  the proxy repeats the X.224 exchange on a fresh tunnel and uses TLS 1.2 with RSA key exchange for that desktop. The
  connection is still encrypted, without forward secrecy. A certificate with the digital-signature usage on the
  Windows side avoids the fallback.

## Graphics

GNOME Remote Desktop only speaks RDP's graphics pipeline (EGFX), which the patched web client decodes in
WebAssembly: RemoteFX Progressive, ClearCodec, planar. With H.264 as well (setting `h264`, on by default), the
client advertises EGFX 8.1 with AVC420 and H.264 is decoded by the browser's WebCodecs `VideoDecoder`, hardware-
accelerated where the platform offers it (VideoToolbox on macOS, Direct3D 11 on Windows, VA-API or software on
Linux). That is, where Tabby's WebCodecs says it decodes H.264 (`VideoDecoder.isConfigSupported`, asked once).

- **Order:** the web client hands each H.264 frame to the decoder as it arrives, and applies the decoded pixels (the
  frame's region rectangles, read back as RGBA) to the EGFX surface in the order the server sent them. Commands after
  a frame wait for it, and so does its frame acknowledgement: the server paces what it sends by those, so the queue
  stays short and the picture never runs ahead of what was drawn. Everything after decoding (surfaces, caches,
  ResetGraphics on resize, device pixels for Retina) is the same path as for the other codecs.
- **Latency:** without a VUI `bitstream_restriction` in the stream, conformant decoders (Chromium's among them) hold
  every picture until their buffer is full, so the SPS is amended to declare no reordering, as WebRTC does. Colors
  are decoded as full-range BT.709 whatever the stream signals, as MS-RDPEGFX specifies.
- **Failures:** a decoder error, or a frame that doesn't come out of the decoder within 3 s, ends the connection, which
  reconnects by itself without H.264 for that desktop (until Tabby restarts, or the setting is turned on again).
- **GNOME** sends H.264 only with a hardware encoder (VA-API or NVENC on the remote); otherwise RemoteFX, as before.
- **Windows** gets the graphics pipeline only with H.264. Windows decides what it sends as H.264 (with EGFX 8.1,
  typically what changes a lot, such as video) and sends the rest with its other codecs.
- **AVC444** (H.264 with full chroma, what Windows prefers for text with EGFX 10 and later) isn't advertised: it needs
  two YUV420 pictures combined into 4:4:4, which the decoder doesn't do.

## Keyboard

While a desktop covers the active pane (`src/keyboard.ts`):

- **Tabby's shortcuts** are filtered: only the desktop/console switch, tab switching (⌘1–9, next, previous, last
  used) and full screen stay Tabby's, and those don't reach the remote. Everything else goes to the remote only.
  (Unfiltered, ⌘V would paste into the hidden terminal and ⌘W would close the tab.)
- **Mac shortcuts** (macOS, on by default): ⌘ is sent as Ctrl, and a ⌘ tap on its own as the Windows key.
- **Stuck keys:** macOS sends no keyup for a key pressed while ⌘ is down, so the remote gets one right after the
  keydown.

The router listens on `window`: after Tabby's hotkey listener (on `document`) and, registered at startup, before
IronRDP's.

## Clipboard, files, sound

- **Clipboard:** IronRDP's component, with the browser clipboard API in Tabby's window: text and images both ways.
- **Files:** IronRDP's file transfer provider. Files dropped on the layer (or picked from the menu) are offered on the
  remote clipboard; pasting there pulls them. Files copied on the remote are offered for saving (to Downloads,
  keeping folder structure, never overwriting).
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
- **`desk`'s sessions** are Unix sockets in the user's runtime directory, checked for owner and mode, with the peer's
  uid verified.

## Notes for plugin development

- **Angular's zone:** anything that watches the DOM or runs on timers stays outside Angular's zone (see
  `src/header.ts`); inside it, each callback triggers app-wide change detection. User actions re-enter the zone.
- **IronRDP's component** forwards keys only while its own container is the first child of its shadow root, so styles
  go in through an adopted stylesheet, never an added element.
- **Tabby skips a plugin** whose `package.json` has no `author`.
