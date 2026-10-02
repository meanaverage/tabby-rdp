# Tests

The suites drive a real Tabby window over the Chrome DevTools protocol, against real remote desktops: key presses,
clicks, the clipboard, menus, the plugin's own state, and checks on the remote side over SSH. There are no mocks.

```sh
export TRD_TEST_HOST=192.168.64.5 TRD_TEST_USER=ubuntu   # a Linux test host, see ../testbed/README.md
npm test                          # the Linux-desktop suites
npm test -- keyboard files        # some suites
npm test -- trd-pty               # trd-pty's own tests, on the test host
npm test -- windows               # the Windows suite (TRD_TEST_WIN_*)
npm test -- winhost               # SSH to Windows itself (TRD_TEST_WIN_OPENSSH)
npm test -- xrdp                  # the xrdp suite (TRD_TEST_XRDP_*)
npm test -- --packed e2e          # with the plugin installed as npm would install it (npm pack)
npm test -- --keep e2e            # leave the test Tabby open afterwards
npm test -- --port 9334 e2e       # use a Tabby already running with --remote-debugging-port=9334
npm test -- screenshots           # regenerate docs/images from the test machines
```

`npm test` ([`run.ts`](run.ts)) starts a separate Tabby with a fresh, minimal profile in a temporary folder, this
plugin linked in, and DevTools on a free port; runs the suites one after another; and closes that Tabby when done,
also on failure or Ctrl+C. Your own Tabby isn't touched. Tabby is found at its usual install path, or pass
`--tabby <path>` / set `TABBY_BIN`.

The suites need an SSH key or agent that logs in to the test host without a password. A new host key is accepted
automatically in the test profile.

## Settings

| Variable | For | |
|---|---|---|
| `TRD_TEST_HOST` | all | The Linux test host (hostname or address). Suites that need it are skipped without it. |
| `TRD_TEST_USER` | all | SSH user (default: your local user name). |
| `TRD_TEST_PORT` | all | SSH port (default 22). |
| `TRD_TEST_SSH_KEY` | all | A private key for the test profile (default: the SSH agent and default keys). |
| `TRD_TEST_SSH` | e2e, trd-pty | Arguments for the system `ssh`: a destination, with options if needed (default `user@host`, with `-p` for another port). |
| `TRD_TEST_BACKEND` | desk | `native` (default) or `tmux`. |
| `TRD_TEST_WIN_SSH_HOST`, `TRD_TEST_WIN_SSH_USER` | windows | The SSH host the Windows machine is reached through (default: the Linux test host). |
| `TRD_TEST_WIN_ADDRESS` | windows | Its RDP address as seen from that host (default `127.0.0.1:3389`). |
| `TRD_TEST_WIN_USER`, `TRD_TEST_WIN_PASSWORD` | windows | The Windows test account. |
| `TRD_TEST_WIN_WINRM` | windows | Its WinRM address as seen from that host, e.g. `192.168.122.20:5985`. Enables the checks inside Windows. |
| `TRD_TEST_WINRM_PYTHON` | windows | Python with `pywinrm` on that host (default: the one `provision.sh` installs, else `python3`). |
| `TRD_TEST_WIN_OPENSSH` | winhost | `user@host[:port]` of a Windows machine running OpenSSH Server, accepting the test key (`TRD_TEST_SSH_KEY` or the agent). Signs in with `TRD_TEST_WIN_USER` / `TRD_TEST_WIN_PASSWORD`. |
| `TRD_TEST_XRDP_USER`, `TRD_TEST_XRDP_PASSWORD` | xrdp | The account on the test host that signs in to xrdp (default user `tabbyxrdp`; see `testbed/linux/xrdp.sh`). The suite is skipped without the password. |
| `TRD_TEST_XRDP_PORT` | xrdp | xrdp's port on the test host (default 3390). |
| `TRD_TEST_NESTED` | nested | An ssh destination the test host logs in to without a password, with a GNOME desktop of its own (see `testbed/linux/nested.sh`). The suite is skipped without it. |
| `TRD_TEST_VM_HOST`, `TRD_TEST_VM_NAME` | vms | A libvirt host (`user@host`, as this computer sees it) and a VM on it with a desktop (RDP on, or Windows). The suite is skipped without them. |
| `TRD_TEST_VM_GNOME` | vms | Optionally, a running VM on that host with GNOME Remote Desktop, which must not be offered (the test Linux VM is one). |
| `TRD_TEST_DUMP` | all | A folder to save pictures of the remote screen at checkpoints. |

## Tabby on another machine

The suites can also drive a Tabby running elsewhere, such as on the Windows test machine. Start it there with this
plugin in its profile and `--remote-debugging-port=9222`, make that port reachable here as `127.0.0.1:9222` (DevTools
listens on the loopback only: on Windows, `netsh interface portproxy` plus an SSH tunnel does it), and run:

```sh
TRD_TEST_HOST=192.168.122.10 TRD_TEST_USER=ubuntu TRD_TEST_SSH_KEY='C:\Users\tabbyrdp\.ssh\id_ed25519' \
    npm test -- --port 9222 e2e desk resize keyboard clipboard files audio reconnect desktops
```

The test host, user and key are then as that machine sees them. The suites take the platform (shortcuts, local
terminals) from that Tabby, and put local files on its machine. On a Linux machine without a desktop, Xvfb does:
`xvfb-run -a ./tabby --no-sandbox --user-data-dir=<profile> --remote-debugging-port=9222` (with
`TABBY_CONFIG_DIRECTORY=<profile>`), and an SSH agent forwarded into that session signs in to the test host. Where the
system keychain doesn't answer (Linux without an unlocked keyring), the keychain checks are skipped, with a note.

## Suites

| Suite | What it covers |
|---|---|
| [e2e](suites/e2e.ts) | Every entry point (toolbar button, hotkey, menus, header), focus and typing, one desktop per account across tabs, a local terminal running `ssh`, Disconnect. |
| [desk](suites/desk.ts) | Logins in the shared session, `desk`, typing in the desktop terminal, RDP and SSH disconnects keeping the session, turning `desk` off and on. |
| [resize](suites/resize.ts) | Resize to fit, reconnect at the new size, keep the resolution, Retina with GNOME's scale. |
| [keyboard](suites/keyboard.ts) | Tabby shortcuts kept off the covered console, ⌘ as Ctrl, no stuck keys, the shortcuts that stay Tabby's. |
| [actions](suites/actions.ts) | Send keys (also from the console), ⌃⌘ with a key as Super with it, View only (label, mouse, keys, across a reconnect), screenshots to Downloads and the clipboard, actual size with a fixed resolution. |
| [clipboard](suites/clipboard.ts) | Text both ways, through the terminal `desk` opens. |
| [files](suites/files.ts) | Files both ways with Files (Nautilus): copy there and save here; drop here and paste there. |
| [audio](suites/audio.ts) | A tone played on the desktop arrives as sound; with sound off, none is set up. |
| [microphone](suites/microphone.ts) | Recording on the desktop opens the microphone here, a tone fed in as the microphone arrives there, and it is released when the recording stops; with the setting off, none is set up. |
| [graphics](suites/graphics.ts) | H.264: advertised where Tabby decodes it, frames decoded when GNOME sends it (it needs a hardware encoder); a window flipping between two colors comes out in them, with H.264 on and off. |
| [reconnect](suites/reconnect.ts) | A dropped SSH connection: "Reconnect SSH", automatic reconnect (also while hidden), Stop, Try again. |
| [desktops](suites/desktops.ts) | "Add a desktop behind…", its sign-in and keychain entry, "Edit a desktop" (keychain entry, sharpness and remembered certificate following a new address), "Remove a desktop" (using the host's own GNOME desktop as the extra one). |
| [profiles](suites/profiles.ts) | "Remote desktop (RDP)" profiles: quick connect; a direct one in its own tab (sign-in, certificate remembered, picture, no console, desktop actions, one tab per server, Disconnect and Connect, recovery); one through a saved SSH profile, opening its SSH tab with the desktop over it; .rdp files: the parser, "Import an .rdp file…" (the test host's GNOME as the RDP server). |
| [certificates](suites/certificates.ts) | The own desktop's certificate checked against the setup's; a desktop behind the host remembered on first use, a changed certificate stopped before sign-in (Cancel, "Trust the new certificate", also on an automatic reconnect), forgotten on removal. |
| [windows](suites/windows.ts) | A Windows desktop behind an SSH host: sign-in, keychain, picture, resize, reconnect, its certificate remembered and a changed one stopped; with WinRM, typing, clipboard, sound and files, each checked inside Windows, and H.264 with a window flipping between two colors. |
| [winhost](suites/winhost.ts) | An SSH host that is itself Windows: detected on the first open, its own desktop signed in to with the Windows account, its certificate remembered, no setup the second time. |
| [xrdp](suites/xrdp.ts) | xrdp next to GNOME (a second desktop) and without GNOME (the host's own desktop): sign-in and xrdp's autologon, picture, typing, clipboard, keychain, "Sign in again…", live resize (xrdp 0.10+), and the error when neither runs. |
| [status](suites/status.ts) | The connection-status indicator: off by default, the menu toggle and its config, throughput, fps, round trip and path, only while the desktop shows. |
| [wake](suites/wake.ts) | Starting a desktop behind a host (`wake`): the probe, a Wake-on-LAN packet to a stand-in machine on the test host, the wait, no waking on automatic reconnects, a missing VM, Cancel, the add form's field. |
| [help](suites/help.ts) | Settings › Remote Desktop: opened from the menu and at a section, its settings following the config both ways, remembered certificates, open desktops; the one-time tip on the first connection; "What does this mean?" under a message that ends a connection. |
| [nested](suites/nested.ts) | `ssh` typed in an SSH tab: the host's desktop in one pane, a split, `ssh` on to another account there, and Desktop in that pane opens that account's desktop through the host; the first pane keeps its own; typing into both and pasting to both; Make panes even; Reconnect stays with it after the ssh ends; without the ssh, the note about the pane next to it. |
| [vms](suites/vms.ts) | VMs found on an SSH host (libvirt): the one with a desktop offered in the host's menu with its address, kind and start-by-name, none without a desktop, none with the setting off. |
| [demo](suites/demo.ts) | Not a test: makes the demo video (`docs/demo/`, attached to the GitHub release rather than committed) and the README's GIF of it (`docs/images/demo.gif`) from the test machines: four desktops in one tab, a file pasted to all of them, the console switch and `desk`. Needs the Windows machine (WinRM included), an xrdp account (`TRD_TEST_DEMO_XRDP_USER`, `_PASSWORD`) and a second GNOME account (`TRD_TEST_DEMO_GNOME_USER`, default `tabbyxrdp`) on the test host, and ffmpeg; `TRD_TEST_DEMO_LOOK` points at a Tabby config.yaml whose look (color scheme, font) it takes on. |
| [trd-pty](unit/trd-pty.py) | The shared-session helper on its own, on the test host. |

Checks print `PASS`, `FAIL` or `SKIP`; some suites also print `TIME` lines (connection and reconnection times, for
example). Everything a suite opens (tabs, desktops, settings, keychain entries, files on either side, the local
clipboard's text) is put back when it ends, also after a failure. The clipboard suites use your real clipboard for a
few seconds.

## Writing a suite

```ts
import { suite } from '../lib/harness.js'

await suite('example', async t => {
    t.check('SSH tab connected', await t.ev('H.pane = await H.openSSH(); return !!H.pane'))
    await t.ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    t.check('desktop connected', !!(await t.waitFor<boolean>('return H.connected(H.pane)', 40)))
})
```

`t.ev` runs in Tabby's page, where `RD` is the plugin's test handle and `H` the helpers in
[`lib/harness.ts`](lib/harness.ts). Node-side, `t` has input (`key`, `press`, `type`, `clickDesktop`), the
clipboard, remote commands, settings, waiting, and cleanup registration.

## TypeScript

The suites, the harness and the runner are TypeScript, run from source by [`tsx`](https://tsx.is) (`npm test`), so
there is no build step before running them. They need Node 22 or later, as before (the DevTools client uses Node's
own `WebSocket`); with `tsx` any Node 22 will do, where Node's own type stripping would take 22.18. The plugin itself
still supports Node 18. `test/package.json` marks the tree as ESM (the plugin itself is CommonJS).

`npm run typecheck` checks the plugin and the tests; `npm run typecheck:test` only the tests (what CI runs beyond the
build). A page expression is a string, so nothing can check what it returns: `ev` and `waitFor` default to `unknown`,
and a suite that reads a shape out of one states it (`ev<CanvasInfo>(...)`) — the shared ones are exported from
[`lib/harness.ts`](lib/harness.ts).
