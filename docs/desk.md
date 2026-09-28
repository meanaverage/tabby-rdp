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
| Setup | With `desk` on, the next desktop connect installs `~/.local/share/tabby-rdp/` (`login.sh`, `bin/desk`, `bin/trd-pty`, `tmux.conf`, `backend`) and one line in `~/.bashrc` / `~/.zshrc`. Turning `desk` off removes exactly that line and those files on the next connect. | `src/remoteSetup.ts` |
| Login | Interactive SSH logins start inside a shareable session: `trd-pty` (default) or tmux. | `login.sh` |
| `desk` | `bin/desk` prints an OSC 7777 sequence (session, socket, working directory, kind). | `login.sh`, `bin/desk` |
| Interception | A `SessionMiddleware` on every terminal session strips the sequence and asks the plugin to open the console on the desktop. | `src/desk.ts` |
| Desktop | The host's own desktop opens over the pane (or the one already open for that account is shown). | `src/desktop.service.ts` |
| Terminal | Over an SSH exec channel, in the headless session: `gnome-terminal --maximize -- trd-pty attach <id>` (or `tmux attach`). | `src/deskScript.ts` |

`TABBY_NO_SESSION=1` skips the shared session for one login. `desk` outside a shared session opens a terminal in the
same folder. Logins that started before the hook was installed need to reconnect.

## `trd-pty`: a shared terminal session, not a multiplexer

The shared session only has to do a few things, which is why it isn't tmux by default:

- own the shell's PTY, so the shell survives SSH disconnects;
- let several terminals attach at once, with output to all of them and input from any;
- show the current screen to a terminal that attaches late;
- follow one terminal's size at a time, without flapping;
- end like a plain SSH login when its last terminal goes.

tmux does all of that, but also takes Ctrl-B, re-renders output (so the terminal's own scrollback needs overrides),
needs passthrough for OSC sequences such as working-directory reporting, clipboard and `desk` itself, and nests with a
tmux of your own. `remote/trd-pty.py` (Python 3 standard library, about 460 lines of code) does only the list above:

```
                 ┌── trd-pty client ◀─▶ Tabby console (SSH PTY → xterm.js)
login shell ◀─▶ PTY ◀─▶ session owner ──┤
                 └── trd-pty client ◀─▶ GNOME Terminal on the desktop
```

- **One owner process per session** holds the PTY (login shell, `TRD_SESSION` / `TRD_SOCKET` in its environment),
  detached with `setsid`.
- **Access:** a Unix socket in `$XDG_RUNTIME_DIR/trd-pty/` (directory `0700`, checked; socket `0600`), and the peer's
  uid must match (`SO_PEERCRED`). No network listener.
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
- **Fallbacks:** if `trd-pty` can't start a session (no `python3`, exit code 3), the login falls back to tmux, then to
  a plain shell. The `remoteDesktop.sessionBackend: tmux` setting uses tmux throughout.

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
  user refused; shell exit, SIGHUP on last detach, linger, and stale-socket cleanup.
- `test/suites/desk.mjs` (`npm test -- desk`, with `TRD_TEST_BACKEND=native` or `tmux`): logins inside the session,
  `desk` to the desktop with the same session attached, typing reaching the shell once, RDP and SSH disconnects keeping
  the session, and turning `desk` off and on leaving `~/.bashrc` as it was.

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
