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
  the same account switches to the tab that has the desktop open, instead of connecting a second client. The fields are
  written into the key so that no two keys are the same and a key keeps its shape (`keyFromConfig`): `%`, `#`, `>` and
  control characters as `%25`, `%23`, `%3E`, …, and so are an `@` in the host name and an `@` or `:` in the port, so the
  user is what comes before the last `@` and the port what comes after the last `:` (`keyFields` reads them back, for
  the user a Windows sign-in suggests and for a desktop's `via`). A user's own `@`, spaces and an IPv6 address's colons
  stay as they are. Up to 0.5.0 the fields went in as they were: a target whose key reads otherwise now (the `%` of an
  IPv6 address's zone, say) is the same target, resolved here, so `RemoteTargets.keyChanged` moves what was kept under
  its former key, its desktops' certificates and sharpness at once, and its saved passwords the first time they are
  looked for (`renameCredentials`). (It moves `withoutNla` entries too, but none under a former key has a certificate,
  which a permission needs: 0.5.0 never saved them, and builds since gave them one only with the new keys.) What else is
  kept by a target's key (desk's key, "from now on" choices) stays behind and is asked about again. Not the saved
  passwords of a former key with a `#` in it, a user name's: a desktop's key splits at its first `#` (`keyParts`), so
  under that key they read as no desktop's, and what forgets or moves a desktop's passwords by its address (removing it,
  a new user name, gateway or address, the gateway passwords 0.5.0 kept) never touched them; moved, a password forgotten
  that way would come back, so that host's desktops ask for their passwords again, and those passwords are forgotten
  (`forgetFormerKey`, once the target is resolved again, as a forget left for later is: see Secrets below): no key a
  target has now has a `#` there, so what is kept under the former key can only be that target's. Nothing moves where
  the former key could be another target's now (`isTargetKey`: a user `alice%23ops` had the key `alice#ops` has now, and
  a numeric IPv6 zone whose first two digits are 10 to 19, 23, 25 or 40 reads as a character `keyField` writes so): that
  target's desktops ask again instead. The other way round isn't told apart: a target whose new key is another's former
  spelling (`alice#ops`, kept as `alice%23ops` now, which is how a user named `alice%23ops` was kept) takes over what
  was kept under it.
- **`ssh` typed in an SSH tab's console** (`NestedSSHTarget`): the plugin asks the host for `ssh` clients in the
  foreground of a terminal there, and finds out which one is the pane's with a probe that terminal echoes back (see
  `src/probe.ts`). Tunnels and commands run that host's own `ssh` (`-W`, `BatchMode=yes`). Everything about such a
  machine is the host's word: its process list, its `ssh -G` reply, the machine's setup output. So its key is the
  tab's key, `>`, and what `ssh -G` there resolves (`alice@bastion:22>bob@build:22`), written as above, so no field
  carries a `#` or `>`: a host can only ever name its own desktops, never give one the key of a desktop reached another
  way. (So the same machine in a tab of its own is another desktop, not the one switched to; GNOME's setup then asks
  about the other connection, as for another computer.) For the same reason no configured desktop's `via` names such a
  machine: its name and what `ssh -G` says about it could be any host's the user configured desktops behind, with their
  saved accounts. Only its own desktop opens through the host: VMs are looked for on a tab's own host only, and one
  found on such a machine wouldn't be offered for saving to a host's desktops anyway (`canSaveFoundDesktop`), since it
  would be kept behind the name the host gave. A destination with a character that could hide part of its name or show
  it in another order isn't offered at all: the .rdp import's measure (`UNSHOWABLE` in `src/unshowable.ts`: control and
  format characters, the other default-ignorable ones such as variation selectors and Hangul fillers, separators, blanks
  other than the space). While a console's `ssh` leads somewhere, Desktop asks which desktop to open, the tab's own
  first, then that machine's this time or "from now on"; only the latter is remembered (`remoteDesktop.nestedSSH`, once
  the machine resolved; removing the entry there takes it back), and opens it at once while that `ssh` is the only one;
  several always ask. What is remembered is a destination the host named, not a machine it proved. A desktop picked in
  the tab's menus is the tab's host's, never looked up among the desktops of where the `ssh` leads, and a desktop open
  in the pane is taken for the one asked for only when its key is that desktop's on that host (the id alone would take a
  machine's own desktop for the host's).

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
   Also as gnome-session would: `DISPLAY` for X11 apps (the display the shell reserved, served by XWayland on demand);
   GNOME's settings daemons for keyboard, media keys, accessibility, sound and housekeeping, bound to the shell (not
   power, which would suspend the machine, sharing, which manages grd, or the ones for local hardware); and, since the
   shell gives up on X11 when it can't start gnome-session's X11 services, a runtime stand-in for
   `gnome-session-x11-services-ready.target` (in `$XDG_RUNTIME_DIR`, removed when the shell stops) that starts GNOME's
   XSettings daemon.
   PipeWire's user sockets are started if they aren't yet (installed after the user's systemd started), since screen
   casting goes through PipeWire, and a virtual audio output is added if the machine has none, for sound.
4. **`desk`** (only when that setting is on): the login hook and helpers, and desk's key ([desk.md](desk.md)); when
   off, removes them. The hook is one exact line in `~/.bashrc` and `~/.zshrc` (and the line before 0.2 was, as those
   versions wrote it). Removing it reads the file byte for byte (`LC_ALL=C grep -a`, so that a NUL byte or one the
   locale can't read is copied like any other), checks that what is left is the file less those lines, and writes
   that into the file itself: a symbolic link to it, its other names (hard links), its mode and its owner stay. A file
   that can't be written (read-only) is left as it is, with a note (`RD_NOTE`) in the desktop's log; one whose writing
   fails part way (a full disk) leaves what it should hold in the plugin's folder, and the note says where.
5. **grd restarts only when its configuration changed:** it reads credentials at startup, and a restart drops open
   sessions.
6. **Clients connected already:** the script counts the established connections to grd's port (again for up to 2 s,
   so a connection of the plugin's own being replaced isn't one) and reports them. grd gives each client a screen of
   its own, so the plugin asks before connecting: take it over (the script runs again with `TRD_TAKEOVER=1`, which
   restarts grd, dropping those connections but not the session) or a second screen. A take-over leaves a note on the
   host (which pane, when); a pane whose desktop dropped at that moment doesn't reconnect by itself, even when the
   new connection isn't up yet, so two clients don't take turns taking it back.

The script prints one `RD_OK port=… user=… pass=… cert=…` or `RD_ERR <reason>` line (and `RD_DESK <key>` with
`desk` on, `RD_NOTE <text>` for what goes to the log); errors show in the desktop layer. `cert` is the SHA-256 fingerprint of the certificate from step 1, the
only one the proxy then accepts on that port (see [Security notes](#security-notes)). A newly made certificate also
restarts grd, which would otherwise keep serving the old one.

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
- **No NLA, unasked, only on the user's word:** xrdp never uses Network Level Authentication, so the stop before a
  password goes to a server without it ([Security notes](#security-notes)) lets an xrdp desktop through, but only
  where its kind is the user's (a configured desktop or profile of the xrdp kind; `DesktopSpec.kindTrusted`). The
  host's own xrdp, an xrdp VM the host lists, and the xrdp of a machine reached with `ssh` typed in its console are
  xrdp on that host's word: they ask once, like a Windows desktop, and the answer is remembered for them. The host's
  own is no exception, since a host the user signs in to with a key need not have the password typed for its desktop.
  A found VM saved to the host's desktops gets `kindFromHost: true`, so it is asked about the same way; one saved up to
  0.5.0, without the mark, is told by what such a save always wrote (`kind: xrdp` and `wake.vm`: `xrdpFromHost`). The
  edit form shows such a kind as the host's, a choice of its own: a kind picked there is the user's
  (`kindFromHost: false` where the entry would otherwise read as a VM saved without the mark).
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
which ends in the desktop's address (`user@host:port#address`). Editing a desktop's address therefore renames those keys
rather than leaving them behind (a certificate is copied, and also stays at the old address: below), but not over what a
desktop at the new address has already, which stays its own (the moved entry is dropped). Where a desktop at the new
address is known (its certificate is remembered), the saved password doesn't move either: that desktop's certificate
stays and checks out, and it would sign in with the moved password unasked, a desktop of another host's or profile's
perhaps; the edited one asks. And a saved password moves only along with the certificate remembered for its desktop at
the old address, which goes along: one without (forgotten in Settings, which keeps the password) is dropped, and that
desktop asks, since at the new address its first certificate would be trusted unasked. Editing its user name, domain,
saved account or gateway drops the saved password instead, since it belonged to the old one. The keys hold the host only
as ssh resolved it (`user@host:port`), while a desktop's `via` can name it by an alias or a profile's name (saving a VM
from a host's list writes the host's label), so which host's keys an entry made can't be told from them: an edit or a
removal applies to the address behind every host. A desktop at that address behind another host then asks for its
password again, and after a removal remembers its certificate anew, as on a first use behind a host (an edit leaves its
certificate there). The edit form is the add form, filled in (`wake` included).

- **Graphics:** Windows with H.264 (see [Graphics](#graphics)) gets the graphics pipeline, as GNOME does. Without
  H.264, and always for xrdp, IronRDP's bitmap path: with only the basic EGFX capability set advertised, Windows does
  better with bitmaps than with the pipeline, and xrdp encodes H.264 only in some builds.
- **TLS:** Windows' self-signed RDP certificate only allows key encipherment, and the TLS library in Electron
  (BoringSSL) enforces that, which rules out every ECDHE and TLS 1.3 handshake. When a handshake fails for that reason,
  the proxy repeats the X.224 exchange on a fresh tunnel and uses TLS 1.2 with RSA key exchange for that desktop. The
  connection is still encrypted, without forward secrecy. A certificate with the digital-signature usage on the
  Windows side avoids the fallback. The reason is the TLS library's own (its error code,
  `ERR_SSL_KEY_USAGE_BIT_INCORRECT`), never an error's text, which a gateway or an SSH host can word; and only as the
  TLS socket raises it itself: an error the stream under it (an SSH channel, a gateway's tunnel) failed with reaches
  the TLS socket as it is, code and all, and doesn't count (BoringSSL's own refusal leaves that stream as it was, so
  its `errored` is unset; seen with Electron 43). The certificate the fallback handshake gets must also show that it
  leaves digital signatures out of its key usage: one that allows them, has none, or whose key usage can't be read
  means the first handshake failed for some other reason (something on the way can make it fail on purpose), and the
  connection stops, saying so. The proxy remembers the fallback for later attempts of the same desktop's connection
  only once a connection with it worked and its certificate was accepted, and each later one with it has to show that
  again: one that doesn't get that far, whatever stops it (a failure, the server not answering within the 45 s it has,
  the client leaving), or that finds a certificate that doesn't need it, has the next start with modern TLS again. The
  unit tests simulate the refusal (plain Node doesn't check key usage), and one runs the proxy against BoringSSL's real
  one in Electron (`TRD_ELECTRON`, see CONTRIBUTING.md), over a socket, an SSH channel's stream and a stream like a
  gateway's tunnel.
- **Starting it (`wake`, `src/wake.ts`):** before connecting, a short script on the SSH host checks that the RDP
  server answers: an X.224 connection request must get a reply (with `python3`; else an open port will do, with `nc`
  or bash), since a port can be open before the server behind it is, as with QEMU's user-mode port forwarding. If
  it doesn't answer, the plugin runs `virsh` (`qemu:///system`, then `qemu:///session`) or sends a Wake-on-LAN packet
  from the SSH host, then probes every 3 s for up to 3 minutes, and connects; a connection that still fails right
  after gets three more tries, 5 s apart, with the same account. A connection that fails later, to a desktop that no
  longer answers, starts it again, except during automatic reconnects. The waiting runs outside Angular's zone.
- **Shutting it down again (`shutDownIdle`):** after starting a VM, and only then, the plugin can leave a watcher on the
  SSH host: `setsid nohup sh`, detached from the SSH session, one per VM (a pid file with the plugin's files, or in
  `/tmp/tabby-rdp-<uid>` when the home folder isn't writable). Every 30 s it checks that the VM still runs and whether
  an established TCP connection goes from the host to the desktop's address and port (`ss`); after the set time
  without one, it presses Shift in the VM (`virsh send-key`: Windows ignores ACPI requests while its screen sleeps) and
  asks for a shutdown, again every 2 minutes, five times at most, and ends when the VM is off. On the host rather than
  in Tabby, so closing the tab (and with it the SSH connection) or quitting Tabby doesn't keep the VM running; it needs
  logind to let user processes outlive the session (`KillUserProcesses=no`, the usual default).

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
  `rdp`, so its session key (`desktopSharpness`, `trustedCertificates`) is `rdp#host:port`, apart from desktops behind
  hosts. The keychain key is that key, plus the gateway (`…@gateway#host:port`, as `parseGateway` has it) whenever the
  desktop is reached through one, whichever account signs in to it, so a saved password is scoped to the way it goes.
- **No console:** the toggle, the header's switch button and "Back to console" leave a remote desktop tab alone, and
  "Add a desktop behind…" isn't offered there.
- **One desktop per server** still holds: opening the profile while another tab has that desktop brings that tab
  forward and drops the new one.
- **The profile's settings** in Tabby's editor are built by hand like the other forms. Editing the address moves the
  saved password and sharpness to the new key and copies the certificate there (it stays at the old address too), as the
  edit form does for desktops behind a host, unless a desktop at the new address is known already (its certificate
  remembered), whose own stay and whose certificate keeps the password from moving; a new user name, domain, account or
  gateway forgets the password instead. Removing the profile, or pointing it at an SSH profile, forgets its passwords
  through any gateway, the ones it had before included, and its certificate. An open tab connects with its profile as
  saved at each connection, Reconnect and a reconnect at a new size included, not with the profile it holds: Tabby's
  proxy of that keeps the options of when the tab opened (saving the editor puts new ones in their place), and a
  restored tab holds a copy. One changed to go through an SSH profile isn't connected from the tab any more.
- **.rdp files** become such profiles (`src/rdpFile.ts`): `key:type:value` lines, UTF-16LE with a byte order mark as
  Remote Desktop Connection writes them, or UTF-8. Only `full address` (host, `host:port`, `[v6]:port`),
  `server port`, `username` and `domain` are read for the connection; `redirectclipboard:i:0` (zero in decimal digits,
  on any of its lines) turns the profile's clipboard off, and nothing in a file turns it on. Importing a file whose
  address, user, domain (in any case, as Windows takes it) and gateway a profile already has (as Tabby resolves the
  profile, its group's defaults included, and the gateway in any spelling) opens that profile instead of adding another:
  where it leads and as whom are the user's own. One that turns the clipboard off first asks whether to turn it off in
  that profile too, unless it is off there already (`clipboardOffForFile`).

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
  reconnects by itself without H.264 for that desktop (until Tabby restarts, or the setting is turned on again). A
  decoder the browser takes back (`QuotaExceededError`: an idle one, in a hidden window) reconnects with H.264, as a new
  stream starts with a key frame; taken back again within ten minutes, it counts as a failure like the others.
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

- **Clipboard:** IronRDP's component, with the browser clipboard API in Tabby's window: text and images, and files
  (below), over RDP's clipboard channel (CLIPRDR). While a desktop has the keyboard, the component reads this
  computer's clipboard every 100 ms and announces each change to the server, and writes what the server's clipboard
  gets to this one (patch 13: only the desktop with the keyboard does either). The setting `clipboard`, or a desktop's
  own (`clipboard` in its `remoteDesktop.desktops` entry or its profile's options; an .rdp file's
  `redirectclipboard:i:0` makes it `off`), says how far that goes (`src/clipboard.ts`), set up on the component before
  each connection:
  - **Both ways** (`both`, the default): as it always was.
  - **Only from the remote desktop to this computer** (`fromRemote`): the component's reading is stopped through the
    hook it composes into the file transfer provider (`enableFileTransfer` wraps `onUploadStarted` with the
    suppression it uses to keep the reading from overwriting a paste of files), and the matching `onUploadFinished`
    is held back, so nothing starts it again. The server only gets an empty clipboard from this side, also when it
    asks for one as the channel starts.
  - **Off** (`off`): the component's clipboard is turned off (`setEnableClipboard(false)`, after registering the
    provider, which turns it on), so it hands IronRDP no clipboard callbacks and no file transfer extensions, and
    IronRDP leaves the clipboard channel out of the connection (it attaches CLIPRDR only with the remote clipboard
    callback). The reading is stopped too, so this computer's clipboard isn't even read.
  - **Only from this computer to the remote desktop** isn't offered.

  The plugin's own clipboard work checks the same ways each time: **Paste to all desktops** (the menu, its hotkey,
  and ⌘V while typing into all) goes only to the desktops showing, and leaves out those that don't take this
  computer's clipboard, Ctrl+V included, and says which (`splitPaste`); ⌘V on such a desktop doesn't look for files
  copied here, and is just the keys; dropped and picked files aren't offered there, and the layer says why; files
  copied on the remote aren't offered for saving where nothing comes from it.

  A connection keeps what it was set up with; a change applies on the next connection (Reconnect is one). When the
  setting narrows while connected, the open desktops that follow it narrow at once, however the config changed: from
  here, in another Tabby window, in Settings › Config file or by config sync, each of which ends with Tabby's
  `config.changed$`. Their reading is stopped, and stays stopped when a paste of files ends; the files offered to them
  are taken back (`FileTransfer.revoke`: a paste still pulling them fails, the remote's requests still waiting their
  turn get an error, and those the provider keeps for pasting again are dropped), and are refused if the remote asks
  for them anyway (FileTransfer puts its own `handleFileContentsRequest` in place of the provider's); and the plugin's
  own checks follow the setting as it is now, also after their waits: a paste to all desktops sends Ctrl+V only if the
  desktop still takes a paste from here once it has the clipboard, and a save of several files checks before fetching
  each. A narrowed clipboard applies in full from the desktop's next connection ([Security notes](#security-notes)).
  Widening waits for the next connection. A desktop with a clipboard setting of its own doesn't follow the setting; its
  own, edited, applies on its next connection: a remote desktop tab reads its profile as saved each time it connects
  ([above](#remote-desktop-tabs-rdp-profiles)), its group's and type's defaults included. The profile template has no
  clipboard, so that a new profile has none of its own either until one is picked: a value saved with it, even the
  setting's `''`, would hide those defaults. A desktop configured twice behind a host (an entry and an RDP profile
  through it, at one address) opens as the first of them, with the narrower clipboard of the two. One desktop per
  server holds for the clipboard too: a desktop asked for with a narrower clipboard than the one open for it was
  connected with (another profile for the same server, say) narrows the open one (`DesktopSession.clipboardCap`),
  which keeps to it until it is closed: `reopen`, a reconnect at a new size and a desktop shown again after it ended
  (its server can end it whenever it likes) carry it over to the session made in its place, since a server can bring
  those about. The desktop's Clipboard menu says so meanwhile. Screenshots, and the connection log's **Copy log**, are
  copied to the clipboard either way: they are the user's own actions.
- **Files:** IronRDP's file transfer provider, on the clipboard channel, so they go the ways the clipboard does.
  Files dropped on the layer (or picked from the menu) are offered on the remote clipboard; pasting there pulls them.
  Files copied on the remote are offered for saving (to Downloads, keeping folder structure, never overwriting).
  - **⌘V of files copied here** (`fileTransfer.ts`): the plugin reads the paths from the clipboard and walks copied
    folders itself (`entriesFor`), synchronously (the keydown has to know whether files are offered), so within limits
    on what it offers (10,000 entries, 20 levels deep) and on what it looks at to find them (`MAX_LOOKED_AT`: 20,000
    names read and folders opened; `MAX_LINKS`: 2,000 links resolved). Past them it looks at nothing more (a folder past
    them is neither opened nor offered), and the message says something was left out; a folder's names are read a few at
    a time (`opendir`), not all at once. Links are resolved with the system's `realpath` (Node's, on Windows), several
    times quicker through chains of links. The worst walks measured on a Mac took about a quarter of a second (10,000
    empty folders; 2,000 links each through a chain of 30). What was copied is taken as it is, links followed; one that
    leads nowhere is skipped. Inside a copied folder, a link is followed only when its real path stays in that folder
    and isn't a folder it is in (no cycles); those leading out are counted and left out, those leading nowhere skipped.
    When what was copied holds no file that can go, whether links were left out, or it is past the limits, or there is
    nothing there to send (files gone since, links that lead nowhere, pipes, folders with nothing in them), ⌘V is taken
    and nothing is pasted (it would paste what the remote had), and the message says so. A folder is checked once its
    names are read to still be the one found (device and inode): one swapped for a link to elsewhere meanwhile, itself
    or a folder it is in, stops the walk with an error, as one that can't be read does: ⌘V is then taken and nothing is
    pasted. Paths are still taken by name, as Node has no `openat` to read a folder through what was opened: a program
    here that can write in a copied folder, swapping folders at the right moments (and back), can get past that. One of
    the user's own could read those files anyway; another user's, with write access to a copied folder that is shared or
    writable by a group (`/Users/Shared`, a team's folder), could have files of the user's sent that it can't read
    itself. That is left as it is: copy such a folder's files, not the folder. Each file is offered as a `DiskFile`,
    bound to the file found (device and inode), with the size the remote is told.
  - **What the remote asks for of files sent from here** (pasted, dropped or picked): FileTransfer puts its own
    `handleFileContentsRequest` on the provider (as for the clipboard's ways, below) and handles each request before the
    provider does, and wraps `sendSubmitFileContents` to see each answer go. A request is handed to the provider under a
    number of the plugin's own (`served`), not the remote's number for its stream, and the provider answers under that
    number: the wrapper sends the answer to the connection under the remote's number and gives back the room that
    request took, and only for a request handed over and not answered yet. An answer for a request that is no more
    (expired after `READ_EXPIRES`, gone with the files offered, or the connection ended) is dropped, so it can't be
    taken for another request's, on the same stream or not. The plugin's own errors go to the connection directly, under
    the remote's number, with their accounting done where they are made. The remote numbers its streams itself, and a
    request on a stream that has one being read or waiting already gets an error: clients ask one thing at a time on a
    stream, and the remote couldn't tell which of its two requests an answer is for. A part of more than 16 MB of a file
    (`MAX_RANGE`) gets an error, not less than was asked for: a remote can take a short answer for the end of the file
    (FUSE, which xrdp and GNOME Remote Desktop serve pasted files through, does, and asks for up to 256 pages at once:
    16 MB with 64 KB pages, 1 MB with 4 KB ones). Asking for more than there is near the end gets the end, as before.
    Dropped and picked files, the browser's own, are wrapped (`BoundedFile`) to be held to the same; the browser reads
    them outside the window. At most 64 MB of parts (`MAX_IN_FLIGHT`, counting each request as what it may cost, and at
    least 64 KB, `MIN_COST`) is being read for a desktop at a time; more wait their turn in order (a request answered
    lets the next go), and past 256 waiting (`MAX_WAITING`) get an error. Each also takes room in the connection for as
    much as it may be, from before it is read until it is answered (`ServerFlow`, which the desktop's proxy gives), and
    what its answer hands the connection takes room of its own: the room is 64 MB (`FLOW_WINDOW`) less what was taken
    and the proxy hasn't read from the connection since. Whatever the proxy reads from it makes room, the connection's
    other messages too. What is handed to the connection waits in the window until the proxy reads it, and the proxy
    reads no further than `HIGH_WATER`, 8 MB, ahead of what the server takes. With a server that reads nothing at all,
    what was read for the remote and not yet taken by the proxy stays within the room and one part more (80 MB), with
    about those 8 MB more in the proxy. With one that reads while it keeps asking, it can grow past that: each byte of
    the connection's other messages the proxy reads makes room for a byte of answers, so what waits grows by as much as
    the proxy reads of them meanwhile. A request waits its turn while there is no room; the room it took is given back
    once it is answered, or stops counting (below). Sizes and errors are answered at once, without waiting for room:
    each is about as large as the request it answers. A shared folder's answers other than its reads (the names in a
    folder, a file's details) take no room either (below). Every request tells the provider that the remote is pulling
    the files (`acknowledgePaste`), as its own handler does, whether it is answered at once or waits its turn: the
    provider fails a paste whose remote hasn't asked it for anything in a minute, and over a slow link a part can wait
    for room longer than that. A part the provider has and doesn't answer (it drops reads when the remote's clipboard
    changes) stops counting after 65 seconds. A new offer, or the files being taken back (`revoke`), answers those still
    waiting with an error: they were for those files. IronRDP's provider takes a part as a Blob there and then, so a
    pasted file's part is read first (`DiskFile.read`, on Node's thread pool, one at a time for an offer, and counting
    until it has been read however long that takes), then handed over as the provider slices (`DiskFile.serving`); a
    slow disk or network folder holds up that transfer, not the window. Each read reopens the file without following a
    link or waiting on a pipe (`O_NOFOLLOW`, `O_NONBLOCK`) and checks it is still the file offered, since the remote can
    ask again much later; one that has become shorter than the size the remote was told gets an error, not a short
    answer. A request whose file can't be read (replaced, removed or cut short since it was offered, or a part too
    large) would leave the remote waiting, as the provider doesn't catch it: it gets an error instead, and the message
    says why, once for an offer. Dropped folders are walked by IronRDP through Chromium's dropped-files file system,
    which lists no links below what was dropped (checked with Electron 40).
  - **Save to Downloads:** each name from the remote loses control characters and the invisible ones that change how it
    reads (Unicode's Cc, Cf, Zl and Zp, but for the zero-width joiners scripts and emoji use, and the tags of a
    subdivision's flag, England's, Scotland's and Wales' among them, within such a flag: a subdivision's code, two
    letters for its country and one to four letters or digits, between a black flag and a cancel tag; tags of anything
    else go), is composed (NFC), and on Windows has the characters it refuses replaced with `_`, trailing dots and
    spaces dropped, and `_` before a device name. Look-alike letters stay. The folders at the top of what the remote
    sends are made anew, as each is chosen (`newFolders`: an exclusive `mkdir`, `name 2` when the name is taken), so
    nothing it sends goes into a folder that was there before, such as an app of the user's, or one made since. Each
    saved file, and each folder made for one, is marked as downloaded: macOS's `com.apple.quarantine`
    (`0081;<time>;Tabby;`, set with `/usr/bin/xattr`, no shell), Windows' `Zone.Identifier` stream (`ZoneId=3`). The
    system then checks them as it checks a browser's downloads, which isn't every kind of file or every way of opening
    one. A file is marked once it is in place, whether or not its temporary copy could be removed (one left goes when
    the connection ends); one that fails to be written whole is removed again, if this save made it (a copy made with
    `COPYFILE_EXCL` takes away what it made when it fails; one written from memory is made with an exclusive open and
    removed here, or the message says it stays). That removal goes by the file's name, so a file another program put in
    its place in that moment would go instead; what another program made there before the exclusive open is never
    touched. Marking failing doesn't stop the save; the message says the system may not warn before opening what wasn't
    marked, also when a later file fails to save. Nothing saved is made executable.
- **Shared folders** (`drives.ts`, MS-RDPEFS through IronRDP patch 15): `SharedDrives` serves the folders on Node's
  thread pool, one request at a time. Paths are resolved with `realpath` and must stay inside their folder; files are
  opened with `O_NOFOLLOW`/`O_NONBLOCK` and checked to be regular files. A file with more than one link is refused for
  writing and truncation (checked on the open file, before truncating, where the file system counts links: some network
  and FUSE ones say 1) and shown read-only; a link made to it while it is open isn't looked for. A desktop has at most
  `MAX_OPEN_FILES` (1,024) files open, opens under way included, and all the desktops of a window `WINDOW_OPEN_FILES`
  (2,048) together, since the window's file descriptors are one process's (the module counts them; it is loaded once per
  window); more get `EMFILE`. That leaves most of what the window may have open to everything else where it may have far
  more: on macOS, where Node raises its limit to the system's hard one as it starts (some 138,000 on a Mac, measured
  with Electron 40), and on Windows (8,192, the C runtime's most). On Linux the window's limit wasn't measured: where it
  is 4,096 or less, these 2,048 are half of it or more. A file counts until its close has finished, not from when the
  server asks for it (`closeFile`): closing waits for what is under way on the file, and a slot handed on before then
  would let more descriptors be open than the limits allow. Once the connection has ended (`dispose`), nothing more is
  opened, and a file still opening is closed as soon as it is open. Offsets and sizes must be safe integers. A write
  past the end of a file or a larger end of file is refused (`ENOSPC`, the server's "disk full") when it would leave
  more of the file not on disk (its size beyond its blocks: what was sent no data for, holes included) than the free
  space of the disk the file is on, less a reserve (1 GB, or a twentieth of a disk under 20 GB). Such growth takes turns
  across the window's desktops, by disk (device number): from the reading of the disk's free space until the file has
  grown, so that no check goes by free space another desktop's growth has taken since it was read. A file is looked at
  again in its turn. The disk is that of the folder the file was opened in, or else the shared folder's, whichever has
  the file's device; when neither has (the folder was moved meanwhile), the file isn't grown. Counting from its blocks
  keeps a file from growing past that bit by bit where files have holes, but each file can grow so (taking no space
  until written), and where a file system compresses, data it compressed counts as not on disk. The volume's free space
  is reported less the reserve. Whether a write grows its file is decided before it takes a turn, and making a file
  smaller takes none: two desktops sharing a folder read-write in one window could have a write past the end of a file
  another one just made smaller grow it unchecked, by what that one took off. Writing real data takes the space anyway.
  A read takes room in the connection for what it asks (4 MB at most) before it reads, waiting while there is none, and
  gives back what it didn't read: the room parts of files sent from here take too (`ServerFlow`, see above, which says
  how far it holds them back). The folder's other answers (the names in a folder, a file's details, the free space) take
  none.
- **Screenshots:** IronRDP draws into a 2D canvas at the remote resolution; it is saved as a PNG (to Downloads, never
  overwriting) and put on the clipboard through Electron.
- **Sound:** the patched web client hands 16-bit PCM to the plugin, which schedules it back to back on a Web Audio
  clock with a small lead, skipping ahead rather than letting delay grow, and follows the server's volume.
- **Microphone** (off by default): the patched web client advertises audio capture and tells the plugin when the
  server opens or closes the AUDIO_INPUT channel ([MS-RDPEAI]), which servers do while an application there records.
  Only then is the microphone captured (`getUserMedia`, with the browser's echo cancellation, so the remote's own
  sound playing here stays out of it), resampled to the server's format and sent as 16-bit PCM. It keeps capturing
  while the desktop is hidden, as long as the remote records: hiding the desktop to use the console shouldn't cut a
  call short; macOS and Windows show their own microphone indicator meanwhile. So does the plugin, beyond the dot on
  the desktop (out of sight while the console is in front or the tab is in the background): a red microphone in
  Tabby's header (`src/header.ts`) for as long as any desktop is sent the microphone, whatever tab is in front, and,
  where there is no header (Tabby leaves its tab bar out in full screen unless told otherwise), a red microphone in
  the window at its top in the middle for the desktops not in view (in the corner, it would take clicks meant for a
  maximized remote window's close button, or GNOME's system menu). Its menu shows a desktop, or stops sending the
  microphone there: `Microphone.turnOff` refuses the remote's later requests on the connection, and the service keeps
  the stop for the desktop (by session key, until Tabby quits), so that the connections made in its place after a
  drop, which the server can bring about, get a microphone that is off from the start. **Send the microphone** in the
  desktop's menu takes it back (and stops it beforehand). A capture that starts on a desktop not in view (hidden, its
  tab in the background, or the window hidden) also brings a note, at most once a minute per desktop, saying the
  desktop receives the microphone: the plugin knows that much, not what records there. A block of audio captured
  before a stop and handed over after it isn't sent, and a stop while the capture is still being set up (the device,
  the worklet, a context still resuming) leaves it stopped. Turning the setting off stops every capture at once, also
  when another window or the config file turns it off (`config.changed$`), and a connection being set up reads the
  setting where it makes its microphone; turning it on applies on the next connection, which sets the channel up.
  GNOME Remote Desktop offers the microphone as a PipeWire source ("Remoteaudio Source", `grd_remote_audio_source`)
  and opens the channel when something records from it; it only takes 44.1 kHz stereo. Tabby grants web permission
  requests (it installs no permission handler), so the only prompt is the system's: macOS asks once whether Tabby may
  use the microphone (Tabby's `Info.plist` has `NSMicrophoneUsageDescription` and its signature the audio-input
  entitlement).

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
end (signed out) or a desktop that never connected only offers a button. The waits start over once a reconnected
desktop has stayed up for 30 s: one that drops again sooner (a server that ends every connection at once) goes on to
the next wait, and the reconnecting stops after the last.

## Security notes

- **grd listens on all interfaces:** it has no bind-address setting, so port 3389 is reachable from the network
  (password-protected, TLS). The plugin doesn't change the firewall. For loopback-only access, as root:
  `iptables -I INPUT -p tcp --dport 3389 ! -i lo -j DROP` (and the same with `ip6tables`).
- **Credentials:** the generated RDP password is in a 0600 file in a 0700 folder. The setup compares it with grd's
  in the shell, never as a command's argument, which other users of the host could read in its process list. Setting
  it (the first connect, or when grd's differs) first leaves it off `grdctl`'s command line and gives it on its input,
  which versions that ask for a missing password read; where that doesn't take, `grdctl` gets it as an argument, and
  it is briefly visible in the process list then. Another user of the host who caught it could sign in to grd from
  there (the loopback-only rule above doesn't stop that).
- **The local proxy** listens on 127.0.0.1 only, and requires a random token per desktop (24 bytes), twice: as the
  path of its WebSocket address, checked before a connection is let in, and in the client's RDCleanPath request. Both
  checks take the same time however much of a guess is right. Anything on the computer can reach the port, and so can
  a web page in a browser: a connection without the token is turned away at the upgrade, so it can't take one of the
  four places a proxy has (which would keep the desktop's own client out), and one that says it comes from any page
  but a file's (an `http:` or `https:` page, a sandboxed one's `null`, an extension's) is turned away whatever it has.
  The plugin's client is in Tabby's window, whose WebSockets say `Origin: file://` (Tabby 1.0.236, Electron 43); a
  client that is no page sends no Origin. A file's page says `file://` only while Electron's
  GrantFileProtocolExtraPrivileges fuse is on, as it is in Tabby's builds (checked on macOS); a build with it off would
  have its pages say `null`, as sandboxed ones do, and its desktops refused by their own proxy, which would show at the
  first connection. `null` stays refused rather than let sandboxed pages in. Past that, the first message is capped at a
  request's size and has ten seconds to arrive, messages at 32 MB, and data waiting for a slow side at 8 MB (64 MB
  inside an SSH channel). The token being the address's path, the plugin takes it out of IronRDP's errors (one names the
  address it couldn't connect to) before they reach the desktop's status and its log, which **Copy log** hands out.
  IronRDP itself prints the address only at its debug and trace levels (`localStorage.trdLogLevel`), to the window's
  console, which Tabby doesn't write to its log file; its debug level printed the token before too, in the request it
  logs.
- **What hosts and servers send is bounded**, in size and in the work it takes, since all of it is handled on the
  thread that runs Tabby's window:
  - A command's output (setup, VM scans, `desk`; through Tabby's SSH connection or the system `ssh`) is read up to
    4 MB; past that the command fails. It is copied into one buffer as it comes (`Output` in `src/ssh.ts`), not kept
    as the pieces it came in, which a host can make a byte each. Through Tabby's connection, its minute runs from the
    moment its channel is asked for, so a server that stops confirming the channel or the command doesn't keep it
    waiting. The answers are read in time that grows with them, not with its square: line by line, or taken apart by
    hand where a pattern's parts could take the same characters (the Hyper-V scan's lines, the line that says how an
    `ssh` typed on a host ended), and so is the list of this computer's processes that a local terminal's `ssh` is
    found in. A VM scan lists 256 VMs at most (each is a menu item; the menu says so when a host has more), and 16
    `ssh` clients typed in a terminal. Of the probes that tell which pane such an `ssh` runs in (`src/probe.ts`), which
    the host can print any number of while answering, only those of the form the plugin's script prints (`<prefix>-<n>`,
    n up to 999) count, 64 at most. A scan that fails while the SSH connection is up waits its minute like any
    other. Of what the system `ssh` prints on stderr (a host's sign-in banners, for a tunnel's whole life), only the
    last 4 KB is kept, for the line that says why it stopped. A host's reason for an error (an `RD_ERR` line, the line
    its own `ssh` ended with) is shown and logged as far as 1,000 characters, and a certificate fingerprint the setup
    reports that isn't one as far as 100.
  - What comes through an SSH channel (Tabby's connection's) while the desktop's side isn't reading is kept in one queue
    of its bytes (`SSHChannelStream`, past what the stream buffers itself), not as the pieces it came in, which a host
    can make a byte each: kept so, 64 MB would cost gigabytes. Past 64 MB the channel is closed.
  - A desktop's log (`SessionLog`: Copy log, the settings page) keeps its first 200 lines and its latest 2,000 to
    4,000, with a line saying how many it left out between them, and each line cut at 4,096 characters: a gateway
    decides how many administrator's messages it sends, and a server what it does to have lines logged, for as long as
    the desktop is open. A gateway's messages are logged ten at most. Each line is kept as a copy of its own: V8 keeps
    a part cut out of a string as a view of all of it, so a line made from a host's answer (desk's error, a setup's
    note) would keep the whole answer, up to 4 MB, for as long as the line is kept.
  - What the RDP server sends is put together into whole messages once, when each is complete (`src/byteQueue.ts`),
    however small the pieces it comes in: joining every piece to everything waiting cost the square of a message's
    size. What waits is copied into the queue's own 64 KB slabs as it comes, so that a piece doesn't keep the larger
    read it is part of (a gateway's frame of a byte among others it throws away), and the queue holds what is waiting
    and two slabs more. Its CredSSP messages, a few kilobytes, may be 256 KB at most. The same goes for the RD
    Gateway's packets and WebSocket frames (their control frames 125 bytes at most, as RFC 6455 has it). The server's
    answer to the connection request has to be a TPKT (version 3, long enough for X.224) to be waited on.
  - An RD Gateway's HTTP answers: status line and headers 64 KB at most, each header split at its first colon, and an
    answer with a CR or LF inside a line is refused. A 401's page, the one body the sign-in has to get past (its next
    round goes over the same connection), is counted off and dropped rather than kept, and its `Content-Length` must be
    digits and 256 KB at most; any other answer ends the sign-in at its headers. Each answer has the step's time (20 s),
    and so does the TLS handshake with the gateway. A desktop closed meanwhile ends the sign-in: the proxy's connection
    gives its upstream factory an `AbortSignal` that aborts when the client leaves (the gateway's stream is none of the
    connection's own until its tunnel is up), which `openThroughGateway` checks before each step and each message of the
    sign-in and ends its sockets on, rather than leaving them to those timeouts. Opening the connection to the gateway
    (TCP, or an SSH channel) isn't cut short: once it is open, nothing goes over it. Its pings are answered one at a
    time: while a pong waits to go out, a later ping replaces the next one (RFC 6455 lets a client answer only the
    latest), so a gateway that reads nothing can't have them pile up. Its administrator's message is read as far as the
    300 characters the log shows.
  - The update check reads npm's answer for 15 s and 256 KB at most.
- **Server certificates:** most RDP servers make their own certificates, so upstream TLS accepts any certificate and
  the proxy decides itself: after the handshake (the legacy TLS 1.2 retry included), and before the RDCleanPath
  response that the client waits for to start CredSSP. A refused server gets nothing of the account: before the check,
  it has had only the X.224 connection request, which the proxy sends without the routing cookie IronRDP fills in with
  the user name (`Cookie: mstshash=<user>`, in the clear; only load balancers that route by user name use it, and the
  plugin doesn't support those). A request that still has the cookie after that, in a form the proxy doesn't know,
  isn't sent at all. The check gets the SHA-256 fingerprint and, for a desktop connected to directly, whether the
  certificate is valid for the desktop's name by this computer's certificate authorities, and why not: the proxy is
  given that name (`serverName`: a host name as it resolves, punycode, or an address), and Node's TLS checks the
  chain, the dates and the name (a host name also goes as SNI; an address is matched to the certificate's addresses,
  and goes without SNI). The authorities (`src/authorities.ts`) are Node's own list and, where Node can read
  it (`tls.getCACertificates('system')`, Node 22.15 and later, as in Tabby's Electron), the system's store, read once;
  without it the question says that an organisation's own authority counts as unknown. Without a name nothing is
  checked that way, and the certificate is never taken for valid (Node would check it against `localhost`). The host's
  own desktop must show the certificate its setup made (`cert=` in the `RD_OK` line, from `openssl x509`); anything
  else is an error in the desktop layer, since something other than grd would be answering on its port. The rest are
  remembered in `remoteDesktop.trustedCertificates`, by session key:
  - **Connected to directly** (`rdp#address`: a profile, quick connect, an import, a restored tab), as RD Gateways are
    (below): nothing but TLS stands between them and the network on the way. A certificate valid for the name connects
    unasked and is remembered with `authority: true`. Any other is asked about the first time, before anything of the
    sign-in goes to the server (it has had the connection request and the TLS handshake), with the address, why it
    isn't valid (`whyNotValid`: self-signed, an authority not trusted here, no way to one from what the server sent,
    another name, expired, …), its fingerprint, and what it says of itself (`CertificateDetails`: its subject's name,
    the names and addresses it is for, its issuer, its dates; the server's word, shown as an .rdp file's names are,
    with what could reorder or hide part of it as U+FFFD, and logged too), Cancel being what Enter picks; it is
    remembered with `authority: false` once trusted. Why it isn't valid is the plugin's own reading, since Node's code
    (`authorizationError`) is the last of the TLS library's checks that failed (OpenSSL's in Node, BoringSSL's in
    Tabby's Electron) and whoever makes the certificate chooses which: one marked for Remote Desktop use only reports
    `INVALID_PURPOSE`, whatever issued it, and Node checks the name only once the chain checked out. The proxy and the
    gateway check it themselves (`certificateDetails`), against the name and the authorities the connection used: where
    its chain stands (`chainStanding`: each certificate signed with the next one's key, and each issuer an authority by
    its basic constraints (or one of the authorities whatever it says: an old root says nothing), so that a certificate
    signed with the key of one issued to a server leads nowhere; ending at one of those authorities, known by its
    fingerprint or by its subject and key as the TLS library knows a trust anchor, so a root sent along cross-signed by
    another counts; at a certificate that names itself as its issuer and is signed with its own key, whatever its key
    usage (Node takes one for its own issuer only where its key usage allows signing certificates, which that of
    Windows' own RDP certificate doesn't): self-signed if it is the server's own, an authority of its own above that; or
    at a certificate whose issuer isn't there or may not issue certificates), whether it was issued for the name
    (`tls.checkServerIdentity`, a host name or an address), and its extended key usage. A name Node found wrong
    (`ERR_TLS_CERT_ALTNAME_INVALID`) comes only once the library took the chain to an authority, which then counts
    whatever Node's reading of the chain shows. `whyNotValid` says, in that order: where the chain stands, unless it
    leads to a trusted authority; another name; expired or not valid yet, by its own dates; marked for other uses than a
    server's, said to be like some organisations' Remote Desktop certificates only for one for that name whose chain
    leads to a trusted authority; and, for such a chain, what else the library's code says (another certificate in the
    chain expired, or not one that may vouch for it). An issuer that isn't there is put as no likelier than one named by
    a certificate it never signed. Unless an authority vouched for the certificate, or its chain leads to a trusted one
    (`vouched`: the authority's word, whose names show another machine's certificate for what it is) and the TLS library
    didn't refuse it for a reason of its own (a code that the reading above doesn't account for, such as a limit on the
    length of a path or the names an authority may sign for, marks the details `unchecked`, and `whyNotValid` says "it
    couldn't be verified (CODE)"), the question marks what it says of itself as its own word, which nothing has checked:
    a certificate anyone made can name the organisation's own issuer. A certificate whose only use is Remote Desktop
    Authentication (Active Directory's Remote Desktop templates) is never valid by these rules, so it is asked about, at
    each renewal too: accepting that use for
    a chain that checks out, as mstsc does, is left for later. For a server that doesn't use NLA (let on, see below),
    the question says that signing in sends it the password itself. The same certificate then connects, except that one
    remembered on an authority's word (`authority: true`) connects only while it is valid: once it isn't (expired, or
    its authority gone from this computer's store) nobody has confirmed it, so it is asked about as a first use
    (`expected` empty; the log says it was remembered but is no longer valid), and trusted it is remembered with
    `authority: false`. A different one stops the connection and asks, except that one remembered on an authority's word
    gives way to another valid one (a renewal, logged); one the user trusted stays until the user trusts another,
    whatever vouches for that. Entries from before (`authority` absent) keep their rule: a desktop's is held to its
    certificate, and the question for a valid replacement says it was remembered unasked; a gateway's gives way to a
    valid one, as before. Such an entry whose certificate turns out valid for its name becomes the authority's, as if
    met for the first time now; one the user trusted stays the user's. Trusting one never allows signing in without NLA,
    which is asked about before TLS, on its own.
  - **Behind a host** (`user@host#address`, and a Windows host's own desktop, `user@host`): trusted on first use,
    remembered without asking, since the way there runs inside SSH and a question on every new desktop would only teach
    clicking it away. SSH vouches for the host, though, not for what answers behind it: a host the user doesn't trust,
    or something on its network, can answer that first connection. Such a certificate isn't checked against a name: the
    host's names for it are only the host's. When it changes, the desktop layer shows the remembered and the new
    fingerprint and connects only after "Trust the new certificate".
  Every connection is checked, automatic reconnects included, and those stop at the question. Removing a desktop forgets
  its certificate, after its saved passwords (`forgetDesktop`: the desktop is gone from the list at once, its passwords
  go from each store that can be read, and the certificates only when no store waits; with one that can't be read just
  now, the certificates stay so that a password still there goes only to the machine it was saved for, and the user is
  told: Settings can forget them); so does deleting its entry from the config file. A direct profile deleted, or pointed
  at an SSH profile, is the same. Editing a desktop's address copies its certificate to the new address along with its
  saved password, so that another machine answering there stops at the question instead of being trusted as a first use,
  unless a desktop at the new address has one remembered already, which stays, and then the password doesn't move either
  (the machine there would check out, and get it unasked): the edited desktop asks. Behind a host, a password moves only
  along with its desktop's certificate: one without is dropped, as it would go unasked to whatever answers first at the
  new address. The certificate stays at the old address as well, whatever else stays there: another desktop's password
  at that address, reached another way (a certificate belongs to the address, a password to the way there), or what a
  store of passwords that can't be read has (see Secrets below), so that it still goes only to the machine it was saved
  for, and another machine answering there is asked about. These keys are matched on their whole parts (target and
  address, split on `#`), never by an unanchored suffix test, and a `#` is not allowed in an address nor left in a
  host's key (see `keyField`), so removing or editing one desktop can't drop a gateway's certificate or an unrelated
  desktop's that merely ends the same way. Desktops at the same address behind different hosts are edited and removed
  together ([above](#desktops-behind-a-host)). A Hyper-V VM's certificate, and the password it signs in with, are its
  host's, for all of that host's VMs: removing one VM's desktop leaves them.
- **Gateway certificates** (`gateway#host:port`): the sign-in to an RD Gateway is NTLM, a proof of the password the
  gateway keeps, sent before the desktop is reached, so a gateway is not trusted silently the way a desktop behind an
  SSH host is: it is checked as a desktop connected to directly is (above), whether it is reached from here or from an
  SSH host, and the check comes before the gateway gets anything of the sign-in. The gateway's host is canonicalised for
  the key, the credential scope, the SNI and what is shown (lower case, international names as punycode, one trailing
  dot dropped, IPv6 compressed), so an alternate spelling of the same gateway isn't a first use; a setting that names
  no host (an empty label, a character no host name has, at which the URL parser behind `domainToASCII` would cut the
  name or which it would decode) is refused. Entries 0.5.0 remembered under another spelling are dropped
  (`migrateConfig`): nothing looks them up any more.
- **Secrets go only where they were entered for.** A saved desktop password is kept under the desktop's key and,
  whenever the desktop is reached through a gateway (an account of its own for the gateway or not), that gateway too
  (`…@gateway#host:port`), so a password saved for one gateway (or a direct connection) is never sent through a
  different gateway named for the same address without asking. Editing what it was entered for (the gateway, the user
  name, domain or account) forgets it, a new address takes it along (unless a desktop is known at that address already,
  and behind a host only with its desktop's certificate, see above), and removing a direct profile forgets it through
  every gateway. A sign-in that ends after one of those in the same window (the server took its time) doesn't save its
  password again, and one forgotten while it is being written is forgotten again once it is there: `forgetMark` is taken
  when the sign-in form shows, and `forgottenSince` asked before the save, against the latest 256 forgets
  (`forgetCredentialsFor`, the old address of `moveCredentialsFor`, `forgetFormerKey` and `forgetCredentialsOrFail`,
  each with what it covers); a mark older than those kept counts as forgotten, and the desktop asks again. Forgetting or
  moving a desktop's passwords lists each store in full, on its own (`entriesOf`), and does its part at once in each
  that could be listed. Where one can't be listed or won't forget (the Vault's prompt cancelled, the keychain not
  answering), that store's part is left for later (`forgetLater`, which keeps the store): `loadCredentials` finds
  nothing under those keys in that store meanwhile, and they go from it the next time the stores are used and it can be
  read (the keychain when it answers; the Vault when it is open, not at the cost of a prompt of its own: it is unlocked
  by a sign-in or a save, after which the next use does it), except a key a password was saved under in it since. The
  other store's part doesn't wait: a keychain that never answers (Linux without a Secret Service, where the Vault is
  what keeps the passwords) doesn't keep the Vault's from being done. What waits is kept in that window's memory only
  (another window knows nothing of it): should the window close first, such a password is found again by a desktop at
  that address (the edit's notification names the store, without saying a password was there, which it can't tell, and
  **Sign in again…** replaces it). After a new address that is the old one, which the edited desktop no longer signs in
  to: so `desktopEdited` leaves the certificates it copies at the old address as well (always: another desktop's
  password there needs it too), and such a password still goes only to the machine it was saved for. A store that
  couldn't be listed doesn't show what it has at the new address, so a moved password is kept from taking another's
  place there only as far as the other store shows. What isn't to be used (left for later, or by the work below) isn't
  moved either. One saved by 0.5.0 for a desktop behind a gateway is under the bare key, which is now the key of that
  address without a gateway, where any desktop there (a quick connect, an .rdp file naming it) would use it unasked:
  such entries are forgotten (`gatewayPasswords` says which: for every address a profile or a desktop behind a host
  reaches through a gateway, behind every host, as edits are), once in each store (`forgetOnce`), when the store is
  first used (so a locked Vault asks for its passphrase at a sign-in, as it would anyway). Each store keeps its own
  mark: this computer's keychain an entry of its own (`migration#gateway-passwords`, a name no key takes), the Vault the
  config's `gatewayPasswordsMigrated`, since config sync takes the config and the Vault in it to other computers but not
  their keychains. The marks are read as the work is about to be done, so a window that asked for it before another
  finished it does nothing. The keychain's part comes first and on its own; a part that can't be done (the keychain
  doesn't answer or can't list what it holds, the Vault's prompt is cancelled) is tried again at the next use, and until
  then `loadCredentials` finds nothing in that store under a key it would forget. Both desktops ask once. A saved
  account (`account#<id>`) is one password for every desktop that names it, wherever each leads: the user gives it to
  desktops, and only the config can do so otherwise, which is no boundary (the config can also run commands, through a
  local profile's or an SSH profile's settings). An imported .rdp profile is written with `account: null`, so it never
  adopts a profile group's or the global default saved account: Tabby's config proxy takes null as the profile's own
  value, and its editor keeps it on save, where it drops a value equal to the default ('' would be while no default is
  set, and a default set later would then be taken). So are its gateway account (a default one's proof would go to the
  gateway the file named) and its kind (a default of xrdp would have the password go without NLA, unasked): null, the
  desktop's own sign-in and Windows. Its first connection asks, unless a password was saved for that address reached the
  same way. Profiles imported before (0.3 to 0.5) are known by the shape the import gave them, which a save in the
  editor changes (it drops the empty `via`), and get the same, at startup and whenever the config changes
  (`migrateConfig`). Removing a saved account sets the profiles that used it to null too, so they ask as the
  confirmation says, rather than take their group's default; a group's default for it becomes none (''), and desktops
  behind hosts lose it, for the gateway too.
- **A .rdp file is untrusted text.** Its address, gateway, user name and domain are shown in the import confirmation,
  which is the only gate on the import, so one with a character that could reorder or hide part of it is refused
  (`UNSHOWABLE`: control and format characters, bidi overrides and zero-width ones among them, the other
  default-ignorable ones such as variation selectors and tags, separators, private-use characters, blanks other than the
  space), but for the zero-width joiners between letters that Persian and Indic scripts write words with, in a user name
  or a domain (`withoutWordJoiners`: between two letters of one of those scripts, where a joiner can change how they
  join; between Latin ones, say, it doesn't show at all): those names are people's own, and decide nothing of where the
  sign-in goes. An international name is shown and stored as its punycode (a gateway's host apart from its port), and
  the account with its domain; the file's own name, and notes that quote the file, show such characters as U+FFFD. The
  file's keys are looked up by own property, so a key like `__proto__` is no note rather than an error that fails the
  import in silence.
- **Servers without Network Level Authentication:** without NLA the client sends the password itself, in its Client
  Info PDU, readable to whatever answered. The server's answer to the connection request says whether it chose NLA,
  so the proxy stops there, before TLS, and the desktop asks: "Send the password anyway" or Cancel. The proxy can't be
  started without that decision: left out, such servers are refused. Only xrdp desktops of the user's own kind go on
  unasked ([above](#linux-desktops-through-xrdp)). The permission belongs to the server with the certificate it was
  given for, and is remembered only with one (`remoteDesktop.withoutNla`: session key and SHA-256). The answer lets the
  next attempt on to TLS, and once the certificate check has taken that server's certificate, the proxy hands it to a
  second decision (`withoutNlaCertificate`, before the client hears back and so before the password goes), which
  records the permission with it. A remembered one lets a connection on to TLS too, and that second decision holds it
  to its certificate: an attempt that never got a certificate leaves nothing behind, and a connection let on before
  the permission was taken back (by another that trusted a new certificate) stops there and asks. Trusting a changed
  certificate, a new address, or forgetting the certificate (or the desktop) takes it back, so another server there is
  asked about again. An entry without a certificate counts for none, and its desktop asks once more: only development
  builds wrote those, since 0.5.0 never saved the permission (`withoutNla` was missing from its defaults, so Tabby kept
  the answer only until it restarted).
- **What an SSH host says** is its word only: which `ssh` runs in its consoles, what `ssh -G` resolves there, the setup
  output, its VMs. None of it can give a desktop the key of one reached another way (a machine reached through a host
  is keyed under that host's key, [above](#the-connection), and a found VM's address, part of its key, is an IPv4
  address: anything else, such as `10.0.0.5:3389@gateway#gw.example`, could read as another desktop's key with its
  gateway's suffix), and none of it spares a desktop the NLA question, the host's own included: a host the user signs
  in to with a key need not have the password typed for its desktop.
- **`desk` requests** come in the terminal's output, where any program, file or other machine can print the same
  sequence. One counts only with desk's key for that host: 128 random bits in a 0600 file there (made once, put in
  place in one step so that two setups at once agree on it), reported by its setup and kept as a SHA-256 in
  `remoteDesktop.deskKeys`, by the host's key (for a machine reached with `ssh` typed in a console, its key under that
  host's, learned when its desktop is opened that way). Only a setup run with `desk` on, still on as it ends, gives a
  key; any other, or one that finds xrdp or Windows, removes the host's (a host whose setup ran with `desk` off has no
  key, so one it reports anyway is ignored). So does one during which `desk` was turned off, though it is on again as
  it ends: each setup takes the host's `deskGeneration` as it starts, a count of the key's being forgotten and of
  `desk` going from on to off (for every host, wherever the setting changed), and gives a key only if it is the same
  as it ends. One run with `desk` off removes it before the host is asked anything, and one that fails after `desk`
  was turned off removes it too: a host that answers with an error, nothing usable, or not at all doesn't keep its key
  that way. Others are dropped as the output is read (`DeskRequests`: the last request
  with a known key in a chunk, one per terminal every 2 s; nothing shown in the window, a count in the developer
  console at most every 2 s), so a flood costs about what any output of its size does; a pane then handles one request
  at a time, then none for 2 s. A request from a pane that isn't the focused one of the active tab, or no longer is
  when the desktop is about to show, gets a note there instead: shown, the desktop would take the keyboard (and this
  computer's clipboard, which follows the focused desktop) from the pane in use, even from another tab, as Tabby keeps
  those in the page, off screen. For the same reason a desktop that finishes connecting, a sign-in form (the desktop's
  or its gateway's) or a question with a default answer (a certificate to trust) that shows up, and the first
  connection's tip as it closes, take the keyboard only if their pane is in front; the pane's focus hands it over when
  the user goes there, and a question out of view brings a note (`info`, which stays a few seconds, not `notice`, gone
  in one). The cooldowns go by a clock that only goes forward (`performance.now`): the time of day set back would
  otherwise keep `desk` quiet for as long. The host itself can always send its own key, and a recording of `desk`'s
  output holds it, so a host you don't trust shouldn't have `desk` set up (it only is where its desktop was opened
  with `desk` on).
- **`desk`'s sessions** are Unix sockets in the user's runtime directory (or `/tmp/trd-pty-<uid>`, while `/tmp` is
  sticky), checked for owner and mode, with both ends checking the other's uid as the system reports it; where it
  can't, neither end goes on, and no session starts. A desktop terminal attaches only to one of the user's own
  sessions: trd-pty's by id, or a tmux socket the user owns in tmux's folder for them (no access for others), with no
  symbolic link on the way and every folder above it root's or the user's and not writable by others unless sticky,
  since a tmux client doesn't check who serves the socket it is given.
- **The IronRDP build (`vendor/`)** runs in Tabby's window, with Node's access to this computer, and is committed as
  built (5 MB of WebAssembly), which a review can't read. `vendor/SHA256SUMS`, which the build writes, names the IronRDP
  commit (one of IronRDP's own, which the build checks: GitHub serves forks' commits through IronRDP's address too) and
  the hash of each patch and each built file; the unit tests check `vendor/` and the series against it, every file in
  `vendor/` included. CI rebuilds `vendor/` from the series on a clean machine, with the build's tools pinned
  (wasm-bindgen built from its own lock file, binaryen's wasm-opt checked by hash), and compares every file either side
  has, byte for byte, when the series, the build or `vendor/` change, and before a release is staged, which happens
  only if they match ([ironrdp/README.md](../ironrdp/README.md#reproducing-vendor)). A release is checked against the
  tagged commit in the repository, never against the package's own copy of the list, which could only vouch for
  itself: the job that stages the package checks the very file it stages, and a maintainer can check the staged
  package the same way before approving it (`scripts/check-vendor.mjs`; CONTRIBUTING.md, "Releasing"). The job that
  stages takes the package by the SHA-256 the job that packed it reported, since any job of the run can replace an
  artifact by its name (the IronRDP jobs run the build scripts and tests of a great many crates and packages). `dist/`
  is trusted as the package job built it: only a maintainer's `--same-as`, against a build of their own before
  approving, checks it. The release workflow's actions are pinned to commits, and its npm is the one that comes with an
  exact Node.js version; only the job that publishes can get npm's token, and it runs none of the dependencies' code.
- **Advisories in the IronRDP build:** it links rsa 0.10.0-rc.18 (RUSTSEC-2023-0071, timing of RSA private-key
  operations), for smart-card sign-in, which the plugin doesn't offer: the web client only signs in with a password and
  never holds an RSA private key ([ironrdp/README.md](../ironrdp/README.md#known-advisories)).
- **Values in Tabby's window:** Tabby's renderer has Node integration and no content security policy, so markup made
  from a value would run as code. Values from the config, a remote or a file go into the page as text (`textContent`,
  or `esc()` where markup is built); the desktop name overlay (`src/osd.ts`) is built node by node, its styles set
  through the CSSOM. Its color must be a plain color (a name, `#hex`, or a color function of numbers): `CSS.supports`
  is no check for this, as it accepts anything after a `var()`. Lookups keyed by config values (the overlay's fonts and
  sizes, hotkey names and ids) take own properties only, so `constructor` or `__proto__` find nothing inherited, and
  numbers in the settings are read only from numbers and text (`configNumber`): `Number()` of an object from the
  config runs its conversions, and throws for one whose `valueOf` and `toString` aren't functions. So do `String()` and
  a template: in the menus, the settings page, the desktop form and what Tabby's profile selector shows of a profile,
  the fields of a desktop's entry or a profile's options are read only from text and numbers too (`configText`), as
  are the ids what is kept for a desktop is filed under (`desktopIdOf`). Tabby builds a tab's right-click menu from
  every plugin's items at once, so one entry that failed there would take the whole menu. A failure with the overlay,
  reading its settings included, is logged; it doesn't fail the connection it names.
- **The clipboard:** a desktop that has the keyboard gets everything copied on this computer meanwhile (passwords from a
  password manager included), and what it copies is written to this computer's clipboard (a command waiting to be pasted
  into a terminal here, say). A hostile or compromised desktop can do both. `clipboard`, or a desktop's own, limits it
  ([above](#clipboard-files-sound-microphone)): only from the remote desktop keeps this computer's clipboard from it,
  and off leaves the clipboard channel out of the connection, files included. A setting that can't be applied as it says
  fails closed: an unknown value (a way that isn't offered, such as only to the remote desktop, written by hand, say) is
  off, and a component without the hooks to stop its reading gets the clipboard off. An .rdp file can turn the clipboard
  off for its desktop, never on. Otherwise the profile it makes has no clipboard of its own, so the defaults of its
  group and type apply, as the import's question says: they are the user's word, so a "Remote desktops" group set to off
  keeps imported desktops off. Its account, by contrast, is written `null` (above): a default saved account would send
  its password to the file's address. A clipboard narrowed while a desktop is open applies in full only once the desktop
  reconnects: until then the last text or picture the desktop got from here stays there to be pasted, and so do the
  names and sizes of files offered there before. Their contents aren't handed out: the plugin takes the offer back and
  refuses them. A desktop is opened with the narrowest clipboard asked for it: an .rdp file that turns it off doesn't
  open a profile for the same desktop that shares it without asking, and a narrower way of opening a desktop that is
  open already narrows the open one for as long as it stays open, its reconnects included.
- **The microphone** is the server's to open (see [above](#clipboard-files-sound-microphone)): with the setting on,
  every desktop that connects gets it while it asks for it, also while it is hidden. The microphone in Tabby's header
  shows that whatever is in front (in full screen, at the top of the window), with Stop, and a capture starting out of
  view brings a note. Stop holds for that desktop through the reconnects a server can cause by dropping the
  connection, until the user turns it back on; there is no per-desktop permission beyond that, and none is kept once
  Tabby quits. Minimized, Tabby shows nothing of its own: the system's microphone indicator does.
- **Paste to all, typing into all:** they go to the desktops of the split tab that show (connected, taking input, not
  hidden behind their console nor behind a pane maximized over them, which leaves them nearly transparent), each
  labelled while typing into all is on; a desktop whose console is in front gets neither, since nothing on screen
  would say it does. A key held down when a desktop is hidden is still let go there. Which desktops share a tab is the
  user's choice: the plugin has no notion of trusted and untrusted desktops to sort them by.
- **Files between here and the remote** (see [Clipboard, files](#clipboard-files-sound-microphone)), with a remote that
  may not deserve trust: a shared folder serves only what is in it (links that lead out don't resolve; a hard-linked
  file is read-only, since its other name may be outside, though still readable as any file in the folder), and the
  server's use of it is bounded where it would reach beyond the folder: open files (each a file descriptor of Tabby's
  window, which all tabs share: per desktop and per window) and space taken without data (on the disk each file is
  on). A copied folder's links that lead out of it aren't sent, and walking it stops at its limits. What the remote
  asks for of files sent from here is bounded per request (16 MB) and per desktop (64 MB being read at a time, 256
  requests waiting, one at a time on a stream), and pasted files are read off the window's thread. What is read for the
  remote, parts of files and a shared folder's reads (4 MB at most), waits in the window until the server takes it, so a
  remote that keeps asking while it reads its connection slowly, or not at all, could have it fill the window's memory:
  what is read for it, or handed to the connection, beyond what the local proxy has read from the connection stays
  within 64 MB and one answer more (`ServerFlow`), and the proxy lets no more than `HIGH_WATER` (8 MB) wait for the
  server. Whatever the proxy reads from the connection makes room, its other messages too: a server that reads nothing
  at all has no more than that waiting, and one that reads while it keeps asking can have what waits grow past it by as
  much as the proxy reads of those messages meanwhile. A file's size and errors, and a shared folder's answers other
  than its reads (the names in a folder, a file's details), are answered outside that; a size or an error is about as
  large as the request it answers. Saved files get names without invisible characters, folders of their own and the
  system's mark for downloads, so Gatekeeper and SmartScreen can apply.

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
