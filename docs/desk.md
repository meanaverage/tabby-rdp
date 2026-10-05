# `desk`: the console, on the desktop

Type `desk` in an SSH console and the tab switches to that machine's desktop, where a maximized terminal is attached
to the *same* shell: same scrollback, working directory, jobs and running program. Typing on either side shows on
both. The hotkey or the header button takes you back to the console.

`desk` is off by default, because it changes how SSH logins start on the remote. Turn it on in
the menu's **Remote Desktop › Settings**, or Tabby's Settings › Remote Desktop (the `remoteDesktop.desk` setting).

<p align="center">
  <img src="images/console.png" width="49%" alt="A console before desk">
  <img src="images/desk.png" width="49%" alt="The same shell in a terminal on the desktop">
</p>

## How it fits together

| Step | What happens | Code |
|---|---|---|
| Setup | With `desk` on, the next desktop connect installs `~/.local/share/tabby-rdp/` (`login.sh`, `bin/desk`, `bin/trd-pty`, `tmux.conf`, `backend`, `desk-key`) and one line in `~/.bashrc` / `~/.zshrc`, and tells the plugin desk's key. Turning `desk` off removes exactly that line and those files on the next connect: the rest of each rc file is written back into it byte for byte (a last line without its newline gets one), so links to it, its other names, its mode and its owner stay. A read-only rc file is left as it is, and the desktop's log says so; should writing one fail part way (a full disk), what it should hold stays in `~/.local/share/tabby-rdp/`, and the log says where. | `src/remoteSetup.ts` |
| Login | Interactive SSH logins start inside a shareable session: `trd-pty` (default) or tmux. | `login.sh` |
| `desk` | `bin/desk` prints an OSC 7777 sequence (session, socket, working directory, kind, machine, host name, desk's key). | `login.sh`, `bin/desk` |
| Interception | A `SessionMiddleware` on every terminal session strips the sequence and, if it carries a key a host gave, asks the plugin to open the console on the desktop. | `src/desk.ts`, `src/deskScript.ts` |
| Desktop | The host's own desktop opens over the pane (or the one already open for that account is shown). | `src/desktop.service.ts` |
| Terminal | Over an SSH exec channel, in the headless session: `gnome-terminal --maximize -- trd-pty attach <id>` (or `tmux attach`). | `src/deskScript.ts` |

`TABBY_NO_SESSION=1` skips the shared session for one login. `desk` outside a shared session opens a terminal in the
same folder. Logins that started before the hook was installed need to reconnect.

## Which requests count

`desk` reaches Tabby the way any program's output does, so a file shown with `cat`, a log, or another machine's output
could print the same sequence. What tells them apart is the key `bin/desk` adds: 128 random bits in
`~/.local/share/tabby-rdp/desk-key` (0600, in the plugin's 0700 folder), which only the user's own processes on that
host can read. The setup reports it to the plugin (`RD_DESK`), which keeps its SHA-256 per host account in
`remoteDesktop.deskKeys` (never the key itself), so `desk` keeps working after Tabby restarts.

- **A request counts only with the key of the host it is for:** the tab's host, or the machine `ssh` typed in its
  console went to. A request without a key (a `desk` from before keys) or with one no host gave is dropped as the
  output is read, before anything runs, here or there, and without a word in Tabby's window, `desk` on or off; the
  developer console counts them, once per 2 s. A request with a key known for another host shows a note saying so.
- **So `desk` works on hosts whose desktop this Tabby opened with `desk` on:** the setup that runs as the desktop opens
  reports the key, whether or not the connection that follows gets through (for a machine reached with `ssh` typed in a
  console, its desktop opened through that host, under whose key it is kept). A setup run with `desk` off gives no key,
  whatever the host prints, and has Tabby forget the one it had for that host as it starts (so also when the setup then
  fails or never finishes); one during which `desk` is turned off gives none either, and has Tabby forget it when it
  ends or fails with `desk` still off; with `desk` on again by then, it changes nothing, so that what a setup since kept
  (a new key, or none) stays. A setup that finds xrdp or Windows there instead of GNOME has Tabby forget it too. After
  updating from an earlier version, open each host's desktop once: that installs the new `bin/desk` there and tells
  Tabby its key. The same goes for a host set up from another computer, unless that computer's Tabby shares this one's
  config (config sync): the keys' fingerprints are part of it.
- **Only in the pane in front.** A request from a pane that isn't the focused pane of the active tab, or that stops
  being it by the time the desktop would show (the plugin first asks the machine which one it is), gets a note in that
  pane instead of the desktop: shown there, the desktop would take the keyboard, and this computer's clipboard with
  it, from the pane in use, even from another tab (Tabby keeps those in the page, off screen). A desktop that
  finishes connecting, a sign-in form or a question that shows up, or the first connection's tip as it closes, takes
  the keyboard only in the pane in front too.
- **One at a time:** of the requests with a known key, a terminal passes on one every 2 s (the last one in its chunk
  of output), and a pane handles one at a time, then none for 2 s. Output full of look-alikes costs about what any
  output of its size does. With `desk` off, a request with a known key from the pane in front says that `desk` is off,
  as often as that; from another pane, nothing.
- **Only sessions of the user's own** get a desktop terminal attached: a trd-pty session by its id (the client checks
  that the session runs as the same user), or a tmux server whose socket the user owns, in tmux's folder for them
  (`tmux-<uid>`, no access for others), with no symbolic link on the way and every folder above it root's or the
  user's and one other users can't write to (or sticky, like `/tmp`), so that nobody else can swap the path before the
  attach. Anything else opens a terminal in the folder instead.
- Turning `desk` off and on again (opening the desktop in between) makes a new key.
- The key tells `desk` apart from look-alike output, not from the host itself, which can always read it: a host
  whose desktop you opened with `desk` on can open that desktop again from its console, while you are in its pane.
  Nor from a recording of `desk`'s output (`script`, asciinema, a terminal log), which holds the key: shown again in a
  pane connected to that machine, it counts as `desk`. Open the desktop of a host you don't trust with `desk` off.

## `trd-pty`: a shared terminal session, not a multiplexer

The shared session only has to do a few things, which is why it isn't tmux by default:

- own the shell's PTY, so the shell survives SSH disconnects;
- let several terminals attach at once, with output to all of them and input from any;
- show the current screen to a terminal that attaches late;
- follow one terminal's size at a time, without flapping;
- end like a plain SSH login when its last terminal goes.

tmux does all of that, but also takes Ctrl-B, re-renders output (so the terminal's own scrollback needs overrides),
needs passthrough for OSC sequences such as working-directory reporting, clipboard and `desk` itself, and nests with a
tmux of your own. `remote/trd-pty.py` (Python 3 standard library, about 510 lines of code) does only the list above:

```
                 ┌── trd-pty client ◀─▶ Tabby console (SSH PTY → xterm.js)
login shell ◀─▶ PTY ◀─▶ session owner ──┤
                 └── trd-pty client ◀─▶ GNOME Terminal on the desktop
```

- **One owner process per session** holds the PTY (login shell, `TRD_SESSION` / `TRD_SOCKET` in its environment),
  detached with `setsid`.
- **Access:** a Unix socket in `$XDG_RUNTIME_DIR/trd-pty/` (directory `0700`, checked; socket `0600`), or
  `/tmp/trd-pty-<uid>/` without a runtime directory, only while `/tmp` has its sticky bit (otherwise another user
  could swap the folder). Both ends check that the other runs as the same user (`SO_PEERCRED` on Linux,
  `LOCAL_PEERCRED` on macOS and the BSDs): a session doesn't take another user's keystrokes, and a terminal doesn't
  send its own to another user's session. Where the system can't say, neither end goes on, and `trd-pty new` starts
  no session. No network listener.
- **Protocol:** framed messages (hello, input, resize, claim, query; output, exit). A malformed or oversized frame drops
  that client, never the session; a client more than 8 MB behind is dropped.
- **Output** goes to every terminal byte for byte: colors, titles, OSC sequences and scrollback stay native.
- **Size:** one terminal at a time is the *controller* and sets the PTY size: the one that attached, typed or got
  focus last. Clients turn on focus reporting in their own terminal to notice focus; the program only sees focus
  reports if it asked for them.
- **Late attach:** the last 256 KB of output is replayed (from a line boundary), then a SIGWINCH makes full-screen
  programs repaint. Input from the new terminal is ignored for 300 ms, which swallows its automatic answers to
  replayed queries.
- **Lifetime:** the shell exiting ends the session. When the last terminal detaches, the shell gets SIGHUP, like a
  dropped SSH login (`TRD_PTY_LINGER=<seconds>` keeps it for a reattach). `trd-pty ls` lists sessions and removes
  sockets whose owner is gone.
- **Fallbacks:** if `trd-pty` can't start a session (no `python3`; or exit code 3: no safe folder for its sockets,
  one it can't make, or no way to check who is at the other end of a socket), the login falls back to tmux, then to a
  plain shell. The `remoteDesktop.sessionBackend: tmux` setting uses tmux throughout.

### Alternatives considered

- **dtach / abduco:** multiple attach and raw passthrough, but no size policy or late-attach redraw, and another
  package to install.
- **Keeping screen state on the server** (pyte, libvterm, a headless xterm.js): exact late attach, at the cost of a
  terminal emulator on every host. Replay plus a repaint covers shells and full-screen programs.
- **Moving the PTY (reptyr):** needs ptrace, which hardened hosts restrict.

## Tests

- `test/unit/trd-pty.py`, run on a Linux host (`npm test -- trd-pty`): creating, attaching and reattaching; output to
  two views and each keystroke exactly once; the controller following input and focus; Ctrl-C, job control, UTF-8,
  colors and titles; the alternate screen and repaint on late attach; malformed clients, no network listener, another
  user refused; shell exit, SIGHUP on last detach, linger, and stale-socket cleanup; another user's session socket
  neither counted nor attached; neither end going on without peer credentials; the socket folder's checks, and exit
  code 3 when it is unsafe, can't be made, or no peer can be checked.
- `test/unit/desk.ts`, `test/unit/desk-service.ts` and `test/unit/remote-scripts.ts` (`npm run test:unit`): requests
  taken out of the output and their key, the last one with a known key, floods over one chunk or many, one at a time;
  the terminal's listener with `desk` off; which keys the plugin keeps from which setups, and what a request with no
  key, another host's, desk off, a machine reached with `ssh` typed in the console or a pane not in front gets; a
  sign-in form leaving the keyboard in the pane in front; the setup, `bin/desk`, the terminal script and the idle
  watcher run under `/bin/sh` against a fake host, checking that no command line carries the password or the key, that
  the login hook is added and removed exactly (through a linked, hard-linked or read-only rc file too, with bytes that
  aren't text, and when writing fails part way), that two setups at once agree on the key, and which sockets a desktop
  terminal may attach to.
- `test/suites/desk.ts` (`npm test -- desk`, with `TRD_TEST_BACKEND=native` or `tmux`): logins inside the session,
  `desk` to the desktop with the same session attached, typing reaching the shell once, requests without the key
  ignored, RDP and SSH disconnects keeping the session, and turning `desk` off and on leaving `~/.bashrc` as it was.

Typical timings on a local network: `desk` to the desktop about 0.4 s; the terminal attached after about 1 s, mostly
GNOME Terminal starting.

## Limitations

- A late attach replays output rather than restoring exact screen state. A program that ignores SIGWINCH shows the
  replay until it next redraws.
- Terminals that aren't the controller draw the stream at their own width, so long lines wrap differently there until
  that terminal takes over.
- Typing in the first 300 ms after a late attach is dropped.
- Tabby keeps a closed tab's remote shell while other tabs share its SSH connection, so that terminal stays attached
  until the connection closes.
- Needs `python3` on the remote (for `trd-pty`) and GNOME Terminal on the desktop.
