# Tests

The suites drive a real Tabby window over the Chrome DevTools protocol. The desktop suites use real remote desktops:
key presses, clicks, the clipboard, menus, plugin state, and checks on the remote side over SSH. The host smoke suite
needs no remote machine; smoke profiles substitute in-memory credentials for the native keychain.

```sh
export TRD_TEST_HOST=192.168.64.5 TRD_TEST_USER=ubuntu   # a Linux test host, see ../testbed/README.md
npm test                          # the Linux-desktop suites
npm test -- keyboard files        # some suites
npm test -- trd-pty               # trd-pty's own tests, on the test host
npm test -- windows               # the Windows suite (TRD_TEST_WIN_*)
npm test -- winhost               # SSH to Windows itself (TRD_TEST_WIN_OPENSSH)
npm test -- hyperv                # Hyper-V VMs on a Windows host (TRD_TEST_HYPERV)
npm test -- gateway               # desktops behind an RD Gateway (TRD_TEST_GATEWAY)
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

## Host upgrade smoke tests

Build the plugin, then test an unmodified Tabby release, release candidate, or nightly binary:

```sh
npm run build
npm run test:smoke -- --tabby /path/to/Tabby --expect-xterm 5
# When testing a host built with xterm 6:
npm run test:smoke -- --tabby /path/to/Tabby --expect-xterm 6
# Require live RDP coverage as well (TRD_TEST_HOST and SSH test credentials must be configured):
npm run test:smoke -- --tabby /path/to/Tabby --expect-xterm 6 --require-rdp
```

On macOS, pass the executable inside the app: `/path/to/Tabby.app/Contents/MacOS/Tabby`.
The command installs a local `npm pack` tarball in a fresh profile, runs `smoke-host` and
`smoke-rdp`, then closes the host and removes the profile. The credential guard is a profile-local test plugin;
it does not change the application bundle or signature. These checks do not read or write the native keychain or
use the system clipboard. Run them against a dedicated test desktop: the RDP suite sends a few harmless keystrokes.

On macOS the test window is hidden. Linux and Windows keep it mapped so Chromium advances the animation frames
used for terminal fitting; `--hidden` applies only on macOS. For unattended Linux runs, use Xvfb with a window
manager such as xfwm4 and keep Tabby's window visible inside that virtual display. An unmapped Linux window can
leave terminal geometry stale and produce false resize failures. When attaching with `--port`, prepare the host
with the same mapped-window requirement.

Each suite prints `HOST` from the plugin's shared compatibility snapshot: host name/version, platform, Electron/Node
versions, xterm dependency declared by the host, and observed capabilities. Unknown or unobserved values are `null`.
`--expect-xterm` fails on a different or missing declaration. A version number alone does not establish xterm 6
coverage: a tagged release can precede the xterm upgrade. Run both the shipping release and a build containing the
upgrade. The suites accept host-provided modal drag regions and the plugin's fallback on older hosts.

`smoke-host` exercises both terminal frontend choices (`xterm` and `xterm-webgl`), actual local PTY input,
Alt+arrow word-jump sequences, output through session middleware, resize, font changes, scroll position, background
output, tab closing, plugin settings, dummy-account revision saves, RDP profile editing, and modal/plugin drag bars.
Profile validation checks call the real host Save method with invalid address and gateway drafts, verify that the
modal stays open and the stored profile stays unchanged, then correct the fields and save through the host button.
Blank type/group defaults are also checked through the host's real ConfigProxy cleanup, including explicit port 3390
and group defaults inheriting port 3390. An unrelated gateway edit preserves both the effective port and whether it
follows later global-default changes. These checks need no remote connection.
It also checks the compatibility snapshot against the real terminal inputs and modal behavior.
Gateway-account checks use dummy credentials without a remote connection: real group-default resolution in the
inventory and removal confirmation, then separate gateway prompts after removal, including cancellation.
`smoke-rdp` covers a real decoded RDP frame, repeated console/RDP switching, keyboard focus and covered-console
input isolation, live display resize, host-tab switching, and disconnect cleanup. Renderer exceptions, console
errors, and caught xterm resize failures fail either suite. Neither suite recreates a complete terminal-renderer
or protocol conformance test.

Without `TRD_TEST_HOST`, `smoke-rdp` explicitly reports `SKIP`; `--require-rdp` makes missing configuration a failure
before launching Tabby. The host suite still runs without a remote. Smoke tests require the runner's credential
guard, so `--port` only works with a test profile already prepared by this runner (`--keep`).

### Host qualification

The compatibility changes merged in [PR #60](https://github.com/meanaverage/tabby-rdp/pull/60) passed this matrix.
All live RDP checks used Ubuntu 24.04 GNOME Remote Desktop as the server.

| Host | Client platform | Declared xterm | Host checks | Live RDP checks |
|---|---|---|---|---|
| Official Tabby 1.0.238 | macOS arm64 | `^5` | 35/35 | 24/24 |
| Upstream source build at `467ce8e` | macOS arm64 | `^6.0.0` | 35/35 | 24/24 |
| Upstream 1.0.239-nightly.0 artifact at `467ce8e` | Linux amd64 | `^6.0.0` | 35/35 | 24/24 |
| Windows client / Windows RDP server | Windows | — | Pending for these changes | Pending for these changes |

Tabby 1.0.238 ships xterm 5; xterm 6 was tested separately. These results record the tested builds, rather than
qualifying every later host release. Rerun the relevant suites when the plugin or host changes.

## Package-change smoke tests

Test the package-change dialog with `npm test -- --packed --hidden --tabby /path/to/Tabby smoke-updates`.
This suite checks the persisted gateway-prompt minimum and refusal of 0.5.1/0.5.2 before installation, then checks
confirmation, cancellation, progress, elapsed time, errors and success using a simulated compatible release and disk
result. It also checks persistence of the target release's minimum before restart. It does not install from npm;
the current RC cannot safely use the former real downgrade to 0.5.1 as an installer test.
The runner uses a disposable profile and keeps the actual packed plugin and credential guard installed throughout.
No remote desktop is required. The confirmation, progress and verified result must remain in the same modal, including
when Settings closes. Set `TRD_TEST_DUMP` to retain screenshots of progress, failure and success.

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
| `TRD_TEST_HYPERV` | hyperv | `user@host[:port]` of a Hyper-V host running OpenSSH Server, accepting the test key, as an account that may list its VMs (the testbed's `tabbyadmin`). `TRD_TEST_HYPERV_PASSWORD`: its password. `TRD_TEST_HYPERV_VM`: the VM to open (default `tabby-rdp-empty`). `TRD_TEST_HYPERV_CONSOLE` and `TRD_TEST_HYPERV_CONSOLE_PASSWORD`: an account that may open the console, where the first may not (the testbed's `tabbyrdp`). |
| `TRD_TEST_GATEWAY` | gateway | An RD Gateway's address as the machine Tabby runs on sees it (`host` or `host:port`). `TRD_TEST_GATEWAY_USER` and `TRD_TEST_GATEWAY_PASSWORD`: an account the gateway lets through and the desktop signs in (the testbed's `tabbyrdp`). `TRD_TEST_GATEWAY_TARGET`: the desktop as the gateway sees it (default: the gateway's own host). With `TRD_TEST_HOST` set and reaching the gateway, also a desktop behind that SSH host. |
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
| [smoke-host](suites/smoke-host.ts) | Host upgrades without a remote: both terminal frontends, keyboard, resize/font/scroll, tab lifecycle, settings, account revision saves, profile editor, modal dragging. |
| [smoke-rdp](suites/smoke-rdp.ts) | Host upgrades with real RDP: connection/frame, console switching and input isolation, display resize, tab focus, disconnect. |
| [smoke-updates](suites/smoke-updates.ts) | Persistent rollback floor, refused unsafe downgrades, and package-change dialog cancellation/progress/errors/simulated success. |
| [e2e](suites/e2e.ts) | Every entry point (toolbar button, hotkey, menus, header), focus and typing, one desktop per account across tabs, a local terminal running `ssh`, Disconnect. |
| [desk](suites/desk.ts) | Logins in the shared session, `desk`, requests without its key ignored, typing in the desktop terminal, RDP and SSH disconnects keeping the session, turning `desk` off and on. |
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
| [profiles](suites/profiles.ts) | "Remote desktop (RDP)" profiles: quick connect; a direct one in its own tab (sign-in, its self-signed certificate asked about first and then remembered, picture, no console, desktop actions, one tab per server, Disconnect and Connect, recovery); one through a saved SSH profile, opening its SSH tab with the desktop over it; .rdp files: the parser, "Import an .rdp file…" (the test host's GNOME as the RDP server). |
| [certificates](suites/certificates.ts) | The own desktop's certificate checked against the setup's; a desktop behind the host remembered on first use, a changed certificate stopped before sign-in (Cancel, "Trust the new certificate", also on an automatic reconnect), forgotten on removal. |
| [windows](suites/windows.ts) | A Windows desktop behind an SSH host: sign-in, keychain, picture, resize, reconnect, its certificate remembered and a changed one stopped; with WinRM, typing, clipboard, sound, files, and shared folders as drives (read, written, listed, a 3 MB file hashed and copied, a read-only one refusing a write), each checked inside Windows, and H.264 with a window flipping between two colors. |
| [winhost](suites/winhost.ts) | An SSH host that is itself Windows: detected on the first open, its own desktop signed in to with the Windows account, its certificate remembered, no setup the second time. |
| [xrdp](suites/xrdp.ts) | xrdp next to GNOME (a second desktop) and without GNOME (the host's own desktop): sign-in, the question before the password goes without NLA (the host's word that it is xrdp) and the answer kept with its certificate, xrdp's autologon, picture, typing, clipboard, keychain, "Sign in again…", live resize (xrdp 0.10+), and the error when neither runs. |
| [status](suites/status.ts) | The connection-status indicator: off by default, the menu toggle and its config, throughput, fps, round trip and path, only while the desktop shows. |
| [wake](suites/wake.ts) | Starting a desktop behind a host (`wake`): the probe, a Wake-on-LAN packet to a stand-in machine on the test host, the wait, no waking on automatic reconnects, a missing VM, Cancel, the add form's field. |
| [help](suites/help.ts) | Settings › Remote Desktop: opened from the menu and at a section, its settings following the config both ways, remembered certificates, open desktops; the one-time tip on the first connection; "What does this mean?" under a message that ends a connection. |
| [nested](suites/nested.ts) | `ssh` typed in an SSH tab: the host's desktop in one pane, a split, `ssh` on to another account there, and Desktop in that pane asks which desktop, the tab's own first, then opens that account's desktop through the host, keyed under the host's (not asked again once chosen "from now on"); the first pane keeps its own; typing into both and pasting to both; Make panes even; Reconnect stays with it after the ssh ends; without the ssh, the note about the pane next to it. |
| [hyperv](suites/hyperv.ts) | Hyper-V VMs on a Windows SSH host: found with PowerShell and offered among the host's desktops; opening one asks for the host's account; an account that may not open the console is refused the way Hyper-V does it, and the form says so; the console connects through the host's port 2179 and its picture arrives. Needs the [Windows Server test machine](../testbed/README.md). |
| [gateway](suites/gateway.ts) | Desktops behind an RD Gateway: a profile with a gateway connects through it; a password the gateway refuses brings the form back saying so, with nothing sent to the desktop; the gateway's certificate, and the desktop's behind it, asked about the first time (the testbed's are self-signed) before anything goes to either, then remembered (the gateway's by its address), and a changed one stops before the sign-in; a gateway with a saved account of its own is asked for separately, and again when refused; a desktop behind an SSH host goes through the gateway as that host sees it. Needs the [Windows Server test machine](../testbed/README.md). |
| [vms](suites/vms.ts) | VMs found on an SSH host (libvirt): the one with a desktop offered in the host's menu with its address, kind and start-by-name, none without a desktop, none with the setting off. |
| [wasm-isolation](suites/wasm-isolation.ts) | Two connected GNOME desktops with different WASM memories and classes; close/reopen one, then inject three synthetic WASM faults and recover it while the other keeps its connection and accepts keyboard input; collect ended memories after GC. Run explicitly with `TRD_TEST_ISOLATION_USER` naming a second GNOME account on the test host, authorized for the test SSH key, with a separate GNOME Remote Desktop listening port (for example, `grdctl --headless rdp set-port 3392` as that account if the port is free). No malformed server input is used. |
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
