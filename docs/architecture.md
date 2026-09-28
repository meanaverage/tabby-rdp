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
- **Remote desktop tabs** (RDP profiles, [below](#remote-desktop-tabs-rdp-profiles)): the proxy relays to a plain
  TCP socket to the server; this is the one case that goes over the network without SSH.
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

Graphics use the bitmap path, which every xrdp version serves (the graphics pipeline is newer in xrdp, 0.10, and
its H.264 depends on how it was built), even with H.264 on, where Windows gets the pipeline. Resizing is display
control, as for Windows: xrdp 0.10 answers it with a deactivation-reactivation at the new size; 0.9 ignores it.

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

## Windows as the SSH host

With OpenSSH Server on Windows, the SSH host's own desktop is Windows' RDP server at 127.0.0.1:3389. The setup script
assumes a POSIX shell, and Windows' default shell (cmd.exe or PowerShell) has no `sh`, so the setup comes back empty
(the complaint goes to stderr). Only then (no `RD_OK`, `RD_XRDP` or `RD_ERR` line) does the plugin ask the host
`echo %OS% $env:OS`, which cmd.exe and PowerShell both answer with `Windows_NT` and `sh` doesn't; a Windows host with
a `sh` on its PATH (Git, MSYS2, Cygwin) is caught by the script itself, from `uname`, before it looks for xrdp or
GNOME. Linux hosts pay nothing for this. The setup then reports the own desktop as `windows`, the way it reports xrdp
(`ownDesktops`), and it connects like a desktop behind a host: sign-in form with the SSH user filled in, keychain, its
certificate trusted on first use, bitmaps (the graphics pipeline with H.264), Windows' Send keys, no GNOME scale script;
keyed by `user@host:port` like any own desktop. Later connects skip the setup there. The finding is kept in memory for
as long as Tabby runs; after a restart, the first open finds out again (one failed setup and one `echo`).

## Desktops behind a host

A configured desktop (`remoteDesktop.desktops`) is reached through the same SSH connection, as `host:port` from the
SSH host; nothing runs on either machine. It signs in with its own account: a form in the desktop layer, and
optionally the keychain (service `tabby-rdp`, through the `keytar` module Tabby itself uses for SSH passwords). A
wrong password brings the form back and drops the saved one.

What is kept per desktop (the keychain entry, `desktopSharpness`, `trustedCertificates`) is keyed by the session key,
which ends in the desktop's address (`user@host:port#address`). Editing a desktop's address therefore renames those
keys rather than leaving them behind; editing its user name or domain drops the saved account instead, since it
belonged to the old user. The edit form is the add form, filled in (`wake` included).

- **Graphics:** Windows with H.264 (see [Graphics](#graphics)) gets the graphics pipeline, as GNOME does. Without
  H.264, and always for xrdp, IronRDP's bitmap path: with only the basic EGFX capability set advertised, Windows does
  better with bitmaps than with the pipeline, and xrdp encodes H.264 only in some builds.
- **TLS:** Windows' self-signed RDP certificate only allows key encipherment, and the TLS library in Electron
  (BoringSSL) enforces that, which rules out every ECDHE and TLS 1.3 handshake. When a handshake fails for that reason,
  the proxy repeats the X.224 exchange on a fresh tunnel and uses TLS 1.2 with RSA key exchange for that desktop. The
  connection is still encrypted, without forward secrecy. A certificate with the digital-signature usage on the
  Windows side avoids the fallback.
- **Starting it (`wake`, `src/wake.ts`):** before connecting, a short script on the SSH host checks that the RDP
  server answers: an X.224 connection request must get a reply (with `python3`; else an open port will do, with `nc`
  or bash), since a port can be open before the server behind it is, as with QEMU's user-mode port forwarding. If
  it doesn't answer, the plugin runs `virsh` (`qemu:///system`, then `qemu:///session`) or sends a Wake-on-LAN packet
  from the SSH host, then probes every 3 s for up to 3 minutes, and connects; a connection that still fails right
  after gets three more tries, 5 s apart, with the same account. A connection that fails later, to a desktop that no
  longer answers, starts it again, except during automatic reconnects. The waiting runs outside Angular's zone.

## Remote desktop tabs (RDP profiles)

For an RDP server reached without SSH, the plugin registers a Tabby profile type, `rdp` (`src/rdpProfile.ts`). A
profile provider is what puts connections in Tabby's profile list, quick connect, recent profiles and tab recovery,
so a desktop there behaves like any other connection. Tabby opens a profile as a tab component, so this is the
plugin's one component: an empty host element that the same desktop layer (`DesktopSession`) fills, plus a line and a
Connect button for when no desktop is open. Everything else (sign-in, keychain, certificates, reconnecting, resize,
sharpness, keyboard and Send keys, view only, screenshots, files, sound, microphone, the connection status) is the SSH
tabs' code, unchanged; the status has no round trip there, since there is no SSH connection to measure:

- **The target:** `RemoteTarget` already abstracted "how to reach the RDP server"; a direct one (`DirectTarget` in
  `src/targets.ts`) opens a plain `net` socket to the server instead of an SSH channel, runs no commands, and is always
  "open", so reconnecting just retries. It has no `wake`, which needs an SSH host to start a machine from. Its key is
  `rdp`, so its session key (keychain, `desktopSharpness`, `trustedCertificates`) is
  `rdp#host:port`, apart from desktops behind hosts.
- **No console:** the toggle, the header's switch button and "Back to console" leave a remote desktop tab alone, and
  "Add a desktop behind…" isn't offered there.
- **One desktop per server** still holds: opening the profile while another tab has that desktop brings that tab
  forward and drops the new one.
- **The profile's settings** in Tabby's editor are built by hand like the other forms. Editing the address moves the
  saved account and sharpness to the new key, as the edit form does for desktops behind a host.
- **.rdp files** become such profiles (`src/rdpFile.ts`): `key:type:value` lines, UTF-16LE with a byte order mark as
  Remote Desktop Connection writes them, or UTF-8. Only `full address` (host, `host:port`, `[v6]:port`),
  `server port`, `username` and `domain` are read. Importing a file whose address and user a profile already has
  opens that profile instead of adding another.

**Through an SSH profile** (`via`): Tabby's SSH sessions need their tab for host-key questions, passwords and
keyboard-interactive prompts, so the plugin doesn't open SSH connections of its own. Opening such a profile opens the
SSH profile's own tab, and once it is connected shows the desktop over it, which is the existing desktops-behind-a-host
path; the RDP profile then counts among the desktops of tabs opened from that SSH profile (matched by profile id). A
local terminal running `ssh` can't be matched to a profile, so those desktops aren't offered there.

## Graphics

GNOME Remote Desktop only speaks RDP's graphics pipeline (EGFX), which the patched web client decodes in
WebAssembly: RemoteFX Progressive, ClearCodec, planar. With H.264 as well (setting `h264`, on by default), the
client also advertises the EGFX versions with H.264 (10.7 down to 10, and 8.1 with AVC420), and H.264 is decoded by
the browser's WebCodecs `VideoDecoder`, hardware-accelerated where the platform offers it (VideoToolbox on macOS, Direct3D 11 on Windows, VA-API or software on
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
- **Windows** gets the graphics pipeline only with H.264. It streams H.264 only to EGFX 10 and later (to 8.1 it
  confirms the version without AVC420), and only for what it takes for video: areas of natural picture that keep
  changing for a few seconds. Text, windows and flat colors come with ClearCodec and RemoteFX Progressive, which keep
  them sharp. (Windows' Progressive upgrade passes needed a fix in IronRDP's decoder, patch 10: without it, a Windows
  session over the pipeline dropped as soon as a picture was refined.)
- **AVC444:** EGFX 10 and later imply AVC444 (a YUV420 main view plus a chroma view, one H.264 stream). The client
  decodes both views but shows only the main view, a complete 4:2:0 picture, so AVC444 comes out with 4:2:0 chroma;
  combining the views into 4:4:4 is not done. Windows' default (no AVC444 policy) sends AVC420 anyway.

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

## Clipboard, files, sound, microphone

- **Clipboard:** IronRDP's component, with the browser clipboard API in Tabby's window: text and images both ways.
- **Files:** IronRDP's file transfer provider. Files dropped on the layer (or picked from the menu) are offered on the
  remote clipboard; pasting there pulls them. Files copied on the remote are offered for saving (to Downloads,
  keeping folder structure, never overwriting).
- **Screenshots:** IronRDP draws into a 2D canvas at the remote resolution; it is saved as a PNG (to Downloads, never
  overwriting) and put on the clipboard through Electron.
- **Sound:** the patched web client hands 16-bit PCM to the plugin, which schedules it back to back on a Web Audio
  clock with a small lead, skipping ahead rather than letting delay grow, and follows the server's volume.
- **Microphone** (off by default): the patched web client advertises audio capture and tells the plugin when the
  server opens or closes the AUDIO_INPUT channel ([MS-RDPEAI]), which servers do while an application there records.
  Only then is the microphone captured (`getUserMedia`, with the browser's echo cancellation, so the remote's own
  sound playing here stays out of it), resampled to the server's format and sent as 16-bit PCM. It keeps capturing
  while the desktop is hidden, as long as the remote records: hiding the desktop to use the console shouldn't cut a
  call short; macOS and Windows show their own microphone indicator meanwhile. GNOME Remote Desktop offers the
  microphone as a PipeWire source ("Remoteaudio Source", `grd_remote_audio_source`) and opens the channel when
  something records from it; it only takes 44.1 kHz stereo. Tabby grants web permission requests (it installs no
  permission handler), so the only prompt is the system's: macOS asks once whether Tabby may use the microphone
  (Tabby's `Info.plist` has `NSMicrophoneUsageDescription` and its signature the audio-input entitlement).

[MS-RDPEAI]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeai/

## Connection status

The indicator (setting `connectionStatus`, off by default; `src/connectionStatus.ts`) runs only while its desktop
shows and is connected, and ticks once a second:

- **Throughput:** the proxy counts the RDP bytes it relays each way (after TLS, inside SSH).
- **Frames per second:** IronRDP's web client draws each changed region with `putImageData` and has no event for it,
  so the indicator wraps `putImageData` on that canvas's own 2D context and counts each synchronous batch of draws as
  one frame.
- **Round trip:** every 5 s, the time to open a session channel on Tabby's SSH connection (the server confirms it,
  and nothing runs until a command is requested; the channel is closed right away). Not measured for a local
  terminal running `ssh`, where each channel would be a new connection, nor while the window is hidden.
- **Path:** the desktop, the SSH host it is reached through, the resolution, the graphics mode (graphics pipeline, with
  H.264 where it decodes it, or bitmaps) and the sharpness.

It doesn't take the pointer (clicks go to the remote), and fades while the pointer is near it.

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
  A Windows host's own desktop (`user@host`) and a remote desktop tab's (`rdp#address`) are trusted on first use the
  same way; for a direct connection, which doesn't run inside SSH, that first connection is the one to make on a
  network you trust. Editing a desktop's address moves its certificate along with its saved account, so that another
  machine answering at the new address stops at the question instead of being trusted as a first use; deleting a
  direct profile forgets its certificate.
- **`desk`'s sessions** are Unix sockets in the user's runtime directory, checked for owner and mode, with the peer's
  uid verified.

## Notes for plugin development

- **Angular's zone:** anything that watches the DOM or runs on timers stays outside Angular's zone (see
  `src/header.ts`); inside it, each callback triggers app-wide change detection. User actions re-enter the zone.
- **IronRDP's component** forwards keys only while its own container is the first child of its shadow root, so styles
  go in through an adopted stylesheet, never an added element.
- **Tabby skips a plugin** whose `package.json` has no `author`.
- **Components** (`src/rdpProfile.ts`) are compiled at runtime by Angular's JIT compiler, which Tabby bootstraps with,
  so plain `tsc` output works: inline templates, declared in the plugin's module. Their DOM is built by hand like the
  rest of the plugin, so they need neither Angular's forms nor common modules. Tabby creates profile settings
  components and tab components itself; a provider that ProfilesService depends on can't inject ProfilesService back,
  so it looks it up from the injector when needed.
