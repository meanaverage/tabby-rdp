# Visual QA operations (Phases 1–5)

The dashboard runs native macOS, Windows and Linux Tabby clients against **real Windows, GNOME/GRD, Xfce/xrdp and KDE/KRDP desktops through IronRDP** (KDE uses the documented private encoder fix and fixed monitor), plus local settings checks. Select a client/desktop combination before running. Existing CDP suites remain available through `npm test`.

## Start and use

Requirements: Node 22 or newer, `npm ci`, and an installed Tabby. The existing runner finds Tabby at its standard
installation path; otherwise set `TABBY_BIN` to the executable. The checked-in baseline was reviewed on macOS arm64,
Tabby **1.0.236**, Electron **43.7.0**, xterm declaration **^6.0.0**. This is the installed build's reported identity,
not a qualification of every build with that version. Different hosts require their own reviewed baseline.

```sh
npm ci
npm run qa
# In a separate terminal, read the token printed only as a file path by the server:
cat .qa/token
```

Open <http://127.0.0.1:4317>, sign in with the token, and choose **Run visual test**. The server builds the current
checkout, starts the existing isolated test runner, and invokes Playwright against that Tabby's CDP port. Select
any run to see its status, source commit/dirty flag, duration, actual/expected screenshots, host metadata, execution
log, and Playwright HTML report. Open a test in the report and select its trace thumbnail to use the locally hosted
trace viewer. Downloadable `trace.zip` also works with `npx playwright show-trace <file>`.

The dashboard and all evidence are served locally. Requested and configured automatic **AI reviews** send selected PNGs and independent fixture
sequence values to OpenAI. Failed-run investigations add allowlisted diagnostic signal names; raw logs, traces, credentials and mutation labels remain local.
DOM replay of Electron `file://` pages can have missing local fonts/icons and a checkerboard canvas placeholder; use the actual PNG and trace filmstrip
for pixel evidence. The trace still records real actions, timings, assertions, source and DOM snapshots.

The runner uses its existing credential guard and temporary profile; it disables update checks. Only one dashboard
run executes at a time; concurrent requests receive 409. Host runs time out after 180 seconds; RDP runs after 300 seconds. **Cancel run** terminates
execution and removes the disposable Tabby/profile. Use a dedicated checkout and avoid editing or invoking other
tests during a dashboard run: it tests the current working tree, not a separate immutable commit checkout.

## Central host and access

Keep one dashboard process on the chosen test machine with a persistent writable data directory. Configuration is
operator-controlled environment, never request parameters:

| Setting | Default | Purpose |
|---|---|---|
| `TRD_QA_PORT` | `4317` | Loopback HTTP port |
| `TRD_QA_DATA` | `.qa` in this checkout | Persistent run history and token |
| `TRD_QA_ENV_FILE` | unset | Private operator JSON containing string `TRD_TEST_*` settings |
| `TRD_QA_OPENAI_KEY_FILE` | unset | Absolute path to a private, mode-600 OpenAI API key file; takes precedence over `OPENAI_API_KEY` |
| `TRD_QA_AI_BUDGET_USD` | `2` | Lifetime estimated API spend plus unresolved reservations; persists across restarts |
| `TABBY_BIN` | Existing runner's platform default | Tabby executable |

Use an SSH tunnel to access a central host: `ssh -N -L 4317:127.0.0.1:4317 <qa-host>`, then open the same localhost URL.
The server deliberately listens only on `127.0.0.1`; it rejects other Host names and cross-origin mutations.
Token holders have the same operator privileges. There is no arbitrary command, argument, environment, baseline
update, or checkout endpoint. All results/artifacts require authentication, including the trace viewer. Browser
sessions last eight hours, use an HttpOnly/SameSite=Strict cookie, and expire on service restart. Restart after
rotating the token file. Keep this data directory and SSH account private.

For a persistent service, run `node /absolute/checkout/scripts/qa/server.mjs` under your existing user service manager,
with an absolute `TRD_QA_DATA` and `TABBY_BIN`. On macOS use a logged-in user LaunchAgent; on Linux use the documented
Xvfb/window-manager setup in `test/README.md` (the Tabby window must remain mapped). A server OS without a GUI session
cannot qualify the desktop application just by serving the dashboard. This phase was executed on macOS only; it
does not deploy the dashboard as a remote service. Dedicated Linux and Windows guests were provisioned separately for Phase 2.

On normal shutdown children are terminated. After an unexpected server exit, the runner watches its parent PID and
cleans up Tabby. Restart marks unfinished records as **Infrastructure failure**, never Passed. Completed records and
artifacts survive restart. A PID lock prevents two servers sharing one data directory. If a stale PID was reused by
another process, inspect it before removing `server.pid`.

## Results and storage

Each `.qa/runs/<id>/` holds `run.json`, `results.json`, bounded `execution.log`, independent copies of attachments in
`evidence/`, raw Playwright `artifacts/`, and the self-contained `report/`. Back up/restore these directories together.
The result index is atomically replaced. Passed requires an executed passing test with actual screenshot and trace
files, a passing reporter result, and exit zero. Failed assertions, skipped tests, launch/build/report failures,
not-executed tests, and cancellation remain distinct. A missing baseline is an explicit failing visual assertion.

There is a 2 MB log limit per command. Phase 5 retention and capacity are described below; protected evidence is never removed merely to make another test pass.

## Baselines and local commands

```sh
npm run test:visual       # build + real Tabby screenshot check, no baseline writes
npm run qa:baseline       # explicitly create/update this platform + host runtime baseline
npm run test:qa           # HTTP controls, lifecycle/recovery and result-classification tests
npm run typecheck
```

`qa:baseline` is a local maintainer action. Inspect every changed PNG in `test/visual/baselines/`, explain the change,
and commit it through review. Normal execution, including a missing baseline, never writes baselines. Dashboard
children explicitly disable baseline updates even if the parent environment requested them.

The local settings checkpoint is the visible 1100×800 settings viewport at device scale 1, with animations disabled and caret hidden.
There are zero allowed differing pixels (Playwright's default per-pixel perceptual threshold), zero retries, and a
pinned Playwright version in the lockfile. Baselines are keyed by OS, architecture, Tabby version and Electron version.
Compare only under the same theme/fonts/runtime; this phase does not provision those dependencies on other hosts.

## Repeat the browser acceptance demonstration

Start the dashboard, then:

```sh
npx playwright install chromium
node scripts/qa/acceptance.mjs
# Or use an already installed browser by setting TRD_QA_BROWSER to its executable.
```

This signs in through the UI, clicks Run, waits for Passed, verifies screenshot loading, opens the HTML report and
its trace viewer, verifies the recorded screenshot assertion, and checks the dashboard at 390 px width. It writes
`<test>-acceptance.json`, `<test>-dashboard.png`, `<test>-mobile.png`, `<test>-mobile-evidence.png`, and `<test>-trace.png`
to the data directory. Mobile captures are bounded overview/evidence views so growing history does not require a huge screenshot.
A fresh run consumes one history slot. The dashboard itself needs no downloaded Playwright browser: its test attaches
to the existing Tabby. Only this browser acceptance script needs Chromium/Chrome.

## Dedicated real RDP environments

Use dedicated guests/accounts; these tests open a fullscreen fixture, resize the session and reconnect it. Do not
point them at a desktop someone is using. Provision Ubuntu with `testbed/linux/libvirt.sh` and `provision.sh`; the
libvirt script now selects amd64/arm64, verifies the downloaded image against Canonical's SHA256 manifest, accepts
`UBUNTU_IMAGE=/absolute/reviewed-image` and `UBUNTU_IMAGE_SHA256` for reviewed local media, plus
`TEST_SSH_KEY=/absolute/key` for provisioning. The GUI fixture
requires GTK 3, Python GI/Cairo and DejaVu Sans, installed by `provision.sh`. Keep networkd as the explicit cloud
image renderer; defer package-triggered service restarts until reboot so provisioning does not lose SSH.

Provision Windows 11 Pro with `testbed/windows/setup.ps1`, which accepts `-PasswordFile` to avoid putting a new test
account password in the command line. The test account needs RDP and WinRM permissions, and its SSH jump host needs
pywinrm (`provision.sh` installs it in `/opt/tabby-rdp-test/winrm`). Windows credentials are delivered through the
existing raw CDP/SSH helpers, with the disposable credential guard; Playwright tracing begins after sign-in.
Restrict WinRM/RDP to the isolated VM network and reach it through SSH.

Example private `.qa/private/environments.json` (replace all placeholders; chmod 600, parent directory 700):

```json
{
  "TRD_TEST_HOST": "127.0.0.1",
  "TRD_TEST_PORT": "2226",
  "TRD_TEST_USER": "ubuntu",
  "TRD_TEST_SSH_KEY": "/absolute/private/qa-key",
  "TRD_TEST_WIN_SSH_HOST": "127.0.0.1",
  "TRD_TEST_WIN_SSH_USER": "ubuntu",
  "TRD_TEST_WIN_ADDRESS": "<windows-private-ip>:3389",
  "TRD_TEST_WIN_USER": "tabbyrdp",
  "TRD_TEST_WIN_PASSWORD": "<dedicated-test-password>",
  "TRD_TEST_WIN_WINRM": "<windows-private-ip>:5985"
}
```

Forward the SSH transport with `ssh -N -L 127.0.0.1:2226:<ubuntu-private-ip>:22 <qa-host>`, then start:

```sh
TRD_QA_ENV_FILE="$PWD/.qa/private/environments.json" npm run qa
```

The JSON is read only at startup and is never returned by the API. Alternatively set the existing `TRD_TEST_*`
environment variables directly. The catalog reports missing setting names, not their values. **Configured** means
settings exist, not that the VM is reachable. Only an executed passing run establishes health. A missing setting,
failed connection or failed fixture setup produces Infrastructure failure, never Passed. Token holders cannot edit
configuration or supply commands. Protect the data directory: remote addresses and guest diagnostic details can
appear in authenticated artifacts even though credentials are excluded.

For CLI execution, export the same variables, build, then use `npm test -- --hidden visual-linux` or
`visual-windows`. Explicit reviewed baseline creation is `npm run qa:baseline -- visual-linux` (or `visual-windows`).
The baseline command uses exported environment variables, not the dashboard's private JSON. Browser acceptance is
`node scripts/qa/acceptance.mjs visual-linux` or `visual-windows` against the running dashboard.

## RDP assertions and evidence

The versioned fixtures in `test/fixtures/visual/` own the fullscreen background, fonts, shapes, gradient, color
references, text and input marker. Independent remote JSON reports sequence, input source, dimensions and scale.
The real client framebuffer must agree with this state, four corner markers and the sequence tile. RDP mouse and
keyboard input must change both remote state and visible pixels. Baselines cover initial 800×600, tab return at
800×600, resize to 900×650 and reconnect. Device/remote scale is 1; H.264, clipboard, audio and microphone are off.
The first decoded frame (which can still show the Windows sign-in transition) is captured as connection evidence, not a stable regression baseline.

Each checkpoint retains decoded raw canvas and final visible canvas screenshots; Windows also captures the guest
screen using CopyFromScreen in the same interactive RDP session. Ubuntu Wayland currently has independent fixture
state, **not an independent guest pixel oracle**. Guest images supplement diagnosis; they are not silently accepted
as new baselines. The fixture automatically exits after five minutes and normally removes its own task/process and
temporary directory during cleanup. Forced cancellation may leave that directory until operator cleanup; it cannot
keep the fixture running indefinitely.

Resize additionally records twelve bounded observations, targeting 500 ms spacing (guest-oracle calls can extend it), including raw/visible filmstrips,
remote state, geometry, sampled RGBA and client monotonic timestamps/capture cost. A Windows guest-screen capture is also retained midway through the transition. The final four samples must be
correct; a later invalid sample after the first correct repaint fails. Transient settling is retained explicitly.
Measured clean runs: Linux collected twelve observations over 5.5 s; Windows took 39 s because each WinRM state read costs about 2.4 s and the guest-image observation cost 11.9 s. These are bounded observations, not exact repaint timing or high-frequency Windows coverage. The five point samples do not quantify whole-frame damage area or prove all text remains readable; screenshot
comparison supplies broader spatial coverage at settled checkpoints. These observations do not infer presentation
from decoder counters or equate remote and local clocks. Every lifecycle has zero retries.

The dashboard shows current per-environment run status, the latest actual preview, checkpoints, reports and traces.
Expand **Raw canvas and resize filmstrip** for transition evidence. A later passing run does not overwrite a failure.
Broader Section 5 scenarios (simultaneous sessions, non-default DPI, clipboard, window movement, rapid animation,
long idle), H.264 controls and detailed invalid-region area/recovery metrics remain unimplemented coverage.

## Phase 2 testbed provenance

The executed Ubuntu guest uses the Canonical 24.04 ARM64 cloud image dated 20260926, GNOME Remote Desktop
46.3-0ubuntu1.2 and the installed package/font versions recorded in each report. Pin/retain the VM image and package
manifest when reproducing baselines; a package upgrade requires fresh review. Windows uses a fresh Windows 11 Pro
ARM64 guest, build 26300.9457, secure AAVMF, TPM 2 and signed virtio-win 0.1.285-1 NetKVM/vioscsi drivers. Windows
installation on this ARM host needed manual WinPE image application plus driver injection and the existing
specialize/OOBE answer file; the repository's x86 Windows libvirt script is not claimed to automate ARM installation.

The reused Microsoft installer remains `.UNVERIFIED`: its SHA256
`8992f2d2cfd2fa647e579e9eb31fc21f34da8333c29b6170fde17d2ed6623e9c` matches the published Arabic row despite
English API/WIM identification, and differs from the published English row. This disclosed inherited provenance
limitation is retained for this isolated testbed; it is not verified English media. No repository checksum gate was
weakened. New VM disks and credentials were created; another thread's existing guest was not modified. Private VM
addresses, credential paths and installation receipts are in ignored `.qa/private/` on the operator machine.

A separate thread observed persistent black center samples after Windows H.264 resize, with decoder activity and
recovery on reconnect. It did not establish full-screen blackness or a client-side cause. This suite's non-H.264
passes do not resolve that observation. Its follow-up requires same-session guest pixels during the failure,
spatial damage measurement and repaint/resize/reconnect recovery controls; preserve the original failure evidence.

## Native client and desktop matrix

The fixed catalog now separates the **native Tabby client** (macOS, Windows, Linux) from the **remote RDP desktop**:
Ubuntu 24.04 / GNOME 46, Fedora 44 / GNOME 50, Debian **13.7** / GNOME 48, Rocky Linux 9 / Xfce / xrdp, Windows 11, and Fedora 44 / KDE Plasma / KRDP with the private QA encoder fix. Each client also has a local
settings test. macOS is a Tabby client target; this does not promise a native macOS RDP server. Windows → Windows needs
a separate Windows server from the client VM for independent coverage. The original three Phase 1/2 IDs remain available.

The test reads the actual Tabby process's platform/architecture, checks its installed plugin bytes against the current
build, then verifies `/etc/os-release`, Debian's point release, GNOME Shell and GNOME Remote Desktop versions (or the
Windows edition/build, or Rocky/Xfce/xrdp/xorgxrdp versions). A wrong version fails preparation. Screenshot keys include **observed** desktop/distro, GNOME/GRD or Xfce/xrdp/xorgxrdp
versions, client OS/architecture, Tabby and Electron. Updating a VM therefore requires explicit baseline review.

Configure matrix cells with a private JSON file, selected by `TRD_QA_TARGETS_FILE` on both dashboard and baseline commands:

```json
{
  "visual-macos-fedora44": {
    "TRD_TEST_HOST": "127.0.0.1",
    "TRD_TEST_PORT": "2229",
    "TRD_TEST_USER": "fedora",
    "TRD_TEST_SSH_KEY": "/private/path/test-key"
  },
  "visual-windows-ubuntu2404": {
    "TRD_TEST_CLIENT_CDP_PORT": "9336",
    "TRD_TEST_HOST": "192.0.2.10",
    "TRD_TEST_PORT": "22",
    "TRD_TEST_USER": "ubuntu",
    "TRD_TEST_SSH_KEY": "C:\\TabbyVisualQA\\ssh-key"
  },
  "visual-macos-host": {},
  "visual-linux-host": { "TRD_TEST_CLIENT_CDP_PORT": "9337" }
}
```

The addresses and SSH key paths are **as seen by the native Tabby client**, while `TRD_TEST_CLIENT_CDP_PORT` is an
SSH-forwarded loopback port on the dashboard/test-driver machine. Windows desktop cells use the same `TRD_TEST_WIN_*`
variables documented above. Matrix cells do not inherit any `TRD_TEST_*` settings from other cells or the legacy environment
file. Absent cells display Not configured / Not executed. Configuration alone is never passing coverage. Keep both private
JSON files mode 0600; restart the dashboard after changing them. HTTP callers can select only fixed IDs, never configuration.

### Dedicated native clients

Run `node scripts/qa/bundle-client.mjs` to build an installation directory containing only the plugin, its runtime
dependencies (every platform's FreeRDP helper package among them), the launcher and credential guard. Copy that directory to each dedicated client VM. Install a checksum-verified
Tabby release there, plus Node 18 or newer. The initial Linux/Windows clients use checksum-verified official 1.0.236
ARM64 binaries (xterm ^5); the existing macOS installation reports 1.0.236 with xterm ^6.0.0. All report Electron 43.7.0.
Those are separate observed builds, not a claim that the same version label means identical host contents. Start:

```sh
node scripts/qa/client.mjs /path/to/Tabby /path/to/client-bundle 9335
```

The launcher creates a temporary profile, disables analytics/updates, installs the same test-only credential guard used by
`test/run.ts`, keeps the native window mapped, and removes its profile/process tree when stopped. It stays alive for the
operator-managed CDP session; stop it after testing. Rebuild and redeploy the bundle after plugin changes. A stale bundle
fails the content check, even if its package version is unchanged. The dashboard executes the existing suites using `--port`,
with screenshots, traces and reports remaining on the central test driver. It does not install or remotely launch clients.

On Linux, install Xvfb and xfwm4 and start them on a dedicated display (for example `:91`, 1280×1024×24, `-nolisten tcp`).
Run both xfwm4 and the launcher with `DISPLAY=:91`. Use the distribution package's correctly owned/mode-4755
`chrome-sandbox`; the tested ARM64 package needed its permissions corrected. Forward CDP through SSH to the **guest's
loopback**, not its network address. Keep the window mapped; minimize/unmap can stop Chromium's animation frames.

On Windows, install Microsoft's signed ARM64 Visual C++ redistributable before the portable ARM64 Tabby build (otherwise
`russh.win32-arm64-msvc.node` fails to load). Run the launcher as the dedicated interactive test user, for example with an
interactive-token scheduled task. A WinRM service session cannot supply that desktop. If SSH is unavailable on Windows,
a `netsh interface portproxy` can forward the guest address to loopback CDP: firewall that port to the libvirt host alone,
then SSH-forward it from that host. Remove the firewall rule, portproxy and task at teardown. Never publish CDP to a LAN.

```sh
TRD_QA_TARGETS_FILE=/private/targets.json node scripts/qa/baseline.mjs visual-linux-fedora44
# Review new baseline PNGs, then use the dashboard (baseline updates always disabled):
TRD_QA_TARGETS_FILE=/private/targets.json npm run qa
TRD_QA_BROWSER=/path/to/chrome node scripts/qa/acceptance.mjs visual-linux-fedora44
```

### Additional Linux guests

Run on an isolated libvirt host with the existing public test key. For each command, set `TEST_IMAGE` and
`TEST_IMAGE_SHA256` to that distro's reviewed local cloud image and digest; follow the
[media verification instructions](../testbed/README.md#linux-desktop-host) first:

```sh
TEST_DISTRO=ubuntu2404 testbed/linux/libvirt.sh qa-ubuntu /path/test-key.pub
TEST_DISTRO=debian13 testbed/linux/libvirt.sh qa-debian /path/test-key.pub
TEST_DISTRO=fedora44 testbed/linux/libvirt.sh qa-fedora /path/test-key.pub
```

The provisioner selects distro-specific packages/users (`ubuntu`, `debian`, `fedora`), verifies the selected local image
against its reviewed SHA-256, and refuses existing VM names. Verify the publisher checksum before recording that digest;
there is no automatic latest-image download. The runtime matrix requires Debian 13.7 exactly and will
reject a later point release until deliberately updated. The qualified Fedora guest used image 44-1.7. Provisioning suppresses welcome tours,
notification banners and animations only for the dedicated test user. The fixture dismisses GNOME's startup overview through
real RDP Escape input. A failed assertion retains raw, visible and final-window evidence before cleanup.

On the tested ARM host, Fedora's shim was rejected by the installed Secure Boot firmware. The disposable Fedora test VM
uses non-Secure-Boot AAVMF; its image checksum was still verified. `TEST_SECURE_BOOT=0` explicitly requests UEFI without
Secure Boot for that case. This matrix does not qualify Secure Boot. Debian's initial provision attempt stopped before reboot
on an unsupported `grdctl --version`; package-version reporting now uses dpkg/rpm. Linux fixture VMs omit the
unnecessary virtual TPM: the tested Debian ARM kernel exposed no `/dev/tpmrm0` for the default device, causing a
90-second systemd device wait before SSH. The provisioner also freezes cloud-init before ejecting its seed. MAC-based DHCP with explicit
networkd prevents its desktop packages from changing the address. Reboot after provisioning so the installed user D-Bus
services are present before the first GNOME setup. The Debian and Fedora guests were reboot-checked.

The Windows test guests are unactivated. An activation watermark appeared on the older VM during preparation; it remains
in the retained evidence. Final matrix cells use the separate server VM. No licensing bypass or watermark masking is
performed. If activation state or another OS overlay changes later, strict comparisons can fail and require environment
review. The Phase 2 Windows installation-media provenance limitation also carries forward to the offline server clone.

### Rocky Linux 9 / Xfce / xrdp

The existing `test/suites/xrdp.ts` covers functional xrdp behavior on a GNOME/Xfce host. The new Rocky visual cells
exercise a separate Xfce-only server through the same visual fixture and screenshot/report pipeline, on all three native clients.

```sh
TEST_DISTRO=rocky9 TEST_XRDP_PASSWORD_FILE=/private/rocky-password \
  testbed/linux/libvirt.sh qa-rocky /path/test-key.pub
```

The private password file contains one password and a newline. Provisioning sends it over SSH stdin, installs
Xfce/xrdp/xorgxrdp from Rocky/EPEL with CRB enabled, and creates `tabbyxrdp` with the supplied SSH keys.
The qualified Rocky image was `9.8-20260525.0`. Supply that reviewed local image and its digest through
`TEST_IMAGE` and `TEST_IMAGE_SHA256`; authenticate its publisher checksum first.
Sources: [Rocky Xfce setup](https://docs.rockylinux.org/9/guides/desktop/xfce_installation/),
[Rocky cloud images](https://download.rockylinux.org/pub/rocky/9/images/aarch64/),
[EPEL xrdp package](https://packages.fedoraproject.org/pkgs/xrdp/xrdp/epel-9.html).

Rocky's xrdp service starts at boot and listens only on guest loopback port 3390; Tabby reaches it through SSH.
SELinux remains enforcing. Its tested versions are Rocky **9.8**, Xfce **4.18.3**, xrdp **0.10.6.1**, xorgxrdp **0.10.5**.
Each `visual-{macos,windows,linux}-rocky9` target supplies `TRD_TEST_USER=tabbyxrdp`, `TRD_TEST_XRDP_USER=tabbyxrdp`,
`TRD_TEST_XRDP_PASSWORD`, and the existing SSH settings as seen by that client. The test verifies real xrdp discovery,
exercises its certificate-bound non-NLA consent through the normal UI, and locates the actual Xfce/Xorg session.
It requires xrdp 0.10 or newer for live resize, reuses the GTK fixture on X11, and closes the test's Xfce session during normal cleanup.
Forced cancellation can leave that account's Xfce session until operator cleanup; the fixture itself times out after five minutes.
Remote JSON and client screenshots are captured; no independent Linux guest pixel oracle is claimed.

Fedora KDE Plasma/KRDP is the planned third Linux RDP stack in [the plan](VISUAL-QA-PLAN.md#planned-third-linux-stack--fedora-kde-plasma--krdp).
It remains Pending and has no passing dashboard cell. Its session and H.264 requirements must be qualified separately.

### Executed matrix (2026-10-11)

All 18 browser workflows passed on clean commits `43a487f` / `8c4dd7c`, with identical RDP implementation and plugin content,
zero lifecycle retries and baseline writes disabled. Only the mobile acceptance capture helper changed between those commits.

| Native Tabby client | Settings | Ubuntu / GNOME 46 | Fedora / GNOME 50 | Debian 13.7 / GNOME 48 | Rocky 9 / Xfce / xrdp | Windows 11 |
|---|---|---|---|---|---|---|
| macOS ARM64 | Pass | Pass | Pass | Pass | Pass | Pass |
| Windows ARM64 | Pass | Pass | Pass | Pass | Pass | Pass |
| Linux ARM64 (Ubuntu) | Pass | Pass | Pass | Pass | Pass | Pass |

Exact run IDs, validation, cleanup and remaining limits are in [the plan handoff](VISUAL-QA-PLAN.md#phase-2-extension--distro-and-native-client-coverage-2026-10-11).
These are fifteen RDP lifecycles and three local UI checks, not x86_64 or H.264 qualification. macOS is a native client target;
Linux and Windows supply the remote server roles. Native Linux runs in Xvfb, separately from its host's GRD session.
Dedicated native clients remain running for dashboard use; their launcher/operator owns shutdown and profile cleanup.

To repeat the whole matrix against the configured dashboard, serialize it:

```sh
for client in macos windows linux; do
  for desktop in host ubuntu2404 fedora44 debian13 rocky9 windows11; do
    node scripts/qa/acceptance.mjs "visual-$client-$desktop" || exit
  done
done
```

Each run contributes to the retention/capacity policy below. Keep previous failure evidence when archiving history.

## Test the Tests (Phase 3)

Select a real RDP environment, choose one or more catalog defects and their bounded parameter values, then click
**Run selected mutations**. A campaign uses the existing real-RDP lifecycle and reviewed baseline: healthy control,
selected mutations serially, restoration after each, healthy control, then ordinary input/resize/reconnect checks.
**Campaign completed** is separate from application **Passed**; environment health cards exclude campaigns.
A failure or escape remains in history. **Reproduce campaign** repeats the same values on the current checkout,
whose commit/dirty flag is recorded; it does not automatically check out the historical commit.

The catalog has 13 entries: the twelve plan categories plus a synthetic unexpected-error dialog. Framebuffer
crop/color/blank/freeze/stale hooks wrap only the owned canvas context's `putImageData`; frontend offsets, scale,
geometry and overlays affect only that owned desktop. Missing-control injection changes the real GTK/WinForms fixture
via its existing private command channel. Text degradation alters a captured PNG only and is explicitly **not RDP
rendering coverage**. All values are deterministic (seed null). No mutation is shipped in production plugin code.

Before/after visible pixels establish spatial manifestation separately from reference comparison (RGBA delta >8,
with changed-pixel counts/bounds and a difference image). Temporal cases advance independent remote JSON state and
retain two later captures showing the earlier frame. This witnesses an observed change/stall, not automatic proof
that every changed pixel has the intended cause; inspect retained evidence. The detector receives only image bytes,
the existing baseline name and the ordinary decoded-frame/state assertion. It gets no mutation ID, parameters or
expected failure. Screenshot comparison uses Playwright's existing PNG comparator with zero allowed differing pixels;
frame-state checks reuse the ordinary four corners/sequence/geometry oracle. A fixed viewport capture is essential:
following a transformed canvas's bounding box could conceal an offset. Baselines and retries are unchanged.

Each experiment records parameters/layer/category, timestamps, detection observation latency, manifestation,
individual detector results, classification and restoration. Incomplete, disconnected or nonmanifested experiments
are excluded from detection rates and shown separately; no-op injection is never credited as detection or escape.
Only completed detector observations enter metrics. A restoration failure fails the campaign and remains visible,
even if detection had already completed. Metrics include healthy-control false positives, manifested escapes,
category/layer/detector breakdowns and per-campaign history. Observation latency includes capture, remote queries and
assertion timeout; it is **not** exact repaint or algorithm-only latency. No statistical generalization from this small
catalog, AI judgment, scheduling or automatic issue creation is claimed.

Authenticated `POST /api/campaigns` accepts only `{test, mutations: [{id, value}]}` from the fixed catalog. It shares
the existing single-run guard, cancellation, protected artifacts and retention/capacity policy. One campaign occupies one run.
Campaigns have a 900-second test / 960-second server deadline. Canvas/CSS hooks self-restore after 30 seconds if
normal cleanup is interrupted; remote missing-control injection also expires after 30 seconds. The fixture exits
after 20 minutes for campaigns (five minutes for normal tests); forced termination can leave its temporary directory
until operator cleanup. Normal cleanup restores every experiment and removes the fixture. Persistent native clients
remain operator-owned. Restart treats interrupted campaigns as infrastructure failures, not passing evidence.

Reports retain named before/actual/expected/difference/restored PNGs and the real session trace. Raw and visible
resize evidence remains available. The trace viewer records browser actions, captures and locator screenshot checks;
synchronous buffer comparisons are recorded in `mutation-results.json` and the HTML report rather than as CDP trace
API calls. The dashboard shows live trial progress, final detector results, metrics and reproduction controls.

Run the browser demonstration (healthy → mutation campaign → report/trace → healthy):

```sh
TRD_QA_BROWSER=/path/to/chrome node scripts/qa/mutation-acceptance.mjs visual-macos-ubuntu2404 crop
# All default catalog values:
node scripts/qa/mutation-acceptance.mjs visual-macos-ubuntu2404 crop,offset,scale,freeze,missing,overlay,color,blank,alignment,text,stale,geometry,dialog
```

### Initial-desktop health limitation discovered during review

The user identified a Tabby crash dialog in the evidence-only initial-desktop PNG from
`2026-10-11T10-46-41.888Z-bf325b96`. The later fullscreen fixture obscured it; the original Passed result applies to
fixture checks and does not prove an unobstructed OS desktop. Its historical record and image remain unchanged.
The isolated Ubuntu guest retained an Apport report dated 09:39:12 (signal 5) and an active reporter; Tabby had restarted
at 09:40:40, before that 10:46 run. This does not establish the crash's root cause or a crash during the run.

Linux preparation now records same-account known crash-reporter processes and fails **Infrastructure failure**
before fixture startup if one is active. The actual retained dialog triggered this check in run
`2026-10-11T11-19-50.552Z-ea2fab57`. The crash payload was archived privately and the stale reporter closed on the
isolated QA guest; no report was submitted or application relaunched from the dialog. This is a process-based health
check, not general screenshot understanding. Arbitrary unexpected initial OS dialogs—including Windows dialogs—still
need broader deterministic shell checks or Phase 4 visual review. The synthetic dialog mutation qualifies overlay
detection inside the measured fixture viewport, not generic OS-dialog recognition.

Phase 3 acceptance completed on native macOS→Ubuntu, Windows→Windows and Linux→Rocky/Xfce/xrdp: **39/39** default
mutations manifested and were detected, **0/6** internal healthy-control false positives, and healthy lifecycles
before/after all three campaigns. Dashboard reproduction and the 40-pixel crop parameter also passed. Exact commits,
run IDs, encoder refinement, validation and remaining limitations are in the [Phase 3 handoff](VISUAL-QA-PLAN.md#phase-3--completed-2026-10-11).
Other matrix cells and alternative severity values are not all mutation-qualified. Historical aggregate metrics
include development runs and repeats; use the recorded commits and run IDs when comparing results.

## AI visual review (Phase 4)

Select a finished run and click **Review screenshots with AI**. Campaigns review independently manifested defects
and healthy controls; ordinary runs review available initial/fixture/failure screenshots. The dashboard displays
structured findings, confidence, affected regions, observations, hypotheses, limitations, cache status and detector
version. AI is **advisory**: the original test result does not change. Review may find a visible dialog in a Passed
run whose OS desktop was only evidence, or find no visible explanation for a failed infrastructure check.

### Subscription authentication (default)

The default provider is `codex`, using the operator's existing **ChatGPT sign-in and Codex allowance**, including Pro.
It does not require an OpenAI API key or extract/forward a subscription token to an API. Install the supported Codex
CLI and sign in interactively with `codex login` if needed, then start the dashboard as that same OS user. The
implementation was exercised with `codex-cli 0.162.1`. A newer CLI changing config/events must pass these checks again.

```sh
TRD_QA_AI_PROVIDER=codex npm run qa
# Preserve existing TRD_QA_ENV_FILE / TRD_QA_TARGETS_FILE settings on your configured host.
```

Additional operator settings:

| Setting | Default | Purpose |
|---|---|---|
| `TRD_QA_AI_PROVIDER` | `codex` | `codex` subscription sign-in or `responses` API key |
| `TRD_QA_CODEX_BIN` | `codex` on PATH | Operator-owned CLI executable |
| `TRD_QA_AI_MAX_REQUESTS` | `100` | Persistent subscription review attempt cap, 1–1000 |

The provider uses `codex exec --image --output-schema`, low reasoning, an ephemeral read-only session and a private
temporary directory. It ignores user config and project instructions, omits skills, disables memory, shell, apps,
plugins, hooks, computer use, delegation and the code-mode host, and rejects any tool event or unexpected error.
The installed CLI reports intentional code-mode/skills isolation as notices; only those exact notice classes are
allowed. Test passwords, API keys and the calling Codex thread ID are absent from the child environment. The CLI
itself handles sign-in/refresh through its normal credential store. Existing Codex threads are not resumed or changed.

Each request has a 60-second deadline; cancellation terminates only its process group, escalating after two seconds.
No application retry is automatic; the CLI's own bounded transport behavior remains within that deadline. Temporary
images/schema/output are removed on normal exit. Forced host termination can leave an OS temporary directory.
Sign-in expiry, quota limits, timeouts, invalid output and tool attempts are failed reviews, never healthy results.
Requests consume the same Codex allowance as other work; the dashboard reports attempts/tokens, not a fabricated
subscription dollar price or remaining plan quota. Manage actual allowance/credits in ChatGPT/Codex Usage settings.

### Optional direct Responses API

Set `TRD_QA_AI_PROVIDER=responses` and `TRD_QA_OPENAI_KEY_FILE=/absolute/private/key-file` (mode 600), or provide
`OPENAI_API_KEY` to the dashboard process. Never commit a key or enter it in the browser. The dashboard does not pass
these credentials to test/Tabby children. The endpoint/model are fixed; HTTP callers cannot choose URLs, commands,
files, models or spending limits. Direct API usage has separate billing from ChatGPT Pro.

The implementation follows the official [Responses structured output](https://developers.openai.com/api/docs/guides/structured-outputs)
and [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) contracts. It sends inline PNGs with
`store:false`, standard service tier, low reasoning and at most 4096 output tokens. No logs/traces are uploaded.
`store:false` is not a claim of zero provider retention; the account's data controls still apply.

Verified [standard pricing](https://developers.openai.com/api/docs/pricing) on 2026-10-11: short-context input
$0.10/M, cache writes $0.125/M, output $0.50/M; long-context cache writes $0.25/M and output $0.75/M. The ledger
conservatively uses cache-write input prices without assuming discounts. Each request reserves $0.30, greater than
the model's entire allowed context/output charge at these rates; known usage replaces the reservation. Timeout,
restart, missing usage and HTTP errors keep the reservation because the charge is unresolved. The default $2 lifetime
limit includes reservations. Reconcile unresolved charges with actual billing while the service is stopped before
manually changing the ledger; restarting does not reset it. Recheck prices before changing models/rates. The API
transport is contract-tested; acceptance uses the subscription provider unless explicitly stated otherwise.

### Evidence, metrics and recovery

Only role-labeled PNG bytes and neutral independent fixture sequence enter the detector. Mutation IDs, expected
failures, parameters, manifestation labels, category/layer truth and other detectors' answers are joined afterward.
Images are bounded to three per case, 4 megapixels, 4096 pixels per edge and 4 MB each; batches have at most 20 cases. No single static screenshot
can establish frozen rendering. Temporal cases include a later capture and independent expected sequence. The two
additional native-input controls ensure legitimate sequence advancement is represented in the benchmark.

Detection/false-negative rates cover completed reviews of independently manifested defects. False-positive rates
cover completed reviews of verified controls. Uncertain reviews are abstentions and count as misses for defects;
provider failures remain outside model-effectiveness denominators and have their own pending/failed count. Category,
layer, detector, escaped IDs, unique evaluations and uncached request latency are retained. Totals use each run's
latest review and may include repeated/cached examples; they are not independent samples. Confidence is not calibrated.

A run holds `ai-review.json` (latest) and `ai-reviews/<review-id>.json` (up to 20 retained reviews). The latter records
source/evaluator commits, input SHA-256 receipts, model/CLI/detector version, findings, usage and metrics. Protected
links expose current and previous JSON evidence. Caches and ledgers are in `.qa/ai-codex/` or `.qa/ai/`, separate by
provider. A restart marks unfinished reviews Interrupted; source test results remain untouched. A manual rerun reuses
successful cached evaluations and retries failed work within the remaining budget. Archive review history/cache/ledger
with the original evidence; never clear the ledger just to make a failing budget check pass.

Run the live browser demonstration against retained run IDs:

```sh
TRD_QA_BROWSER=/path/to/chrome node scripts/qa/ai-acceptance.mjs <run-id> [<run-id> ...]
```

This signs in, requests actual reviews, waits for terminal completion, inspects images, verifies unchanged source test
status and mobile layout, then repeats each review to verify local cache hits with no extra provider requests. It
records measured outcomes, including misses and false positives; it does not require or manufacture 100% detection.
`--unconfigured` tests only the missing-API-key path with the Responses provider. Unit/HTTP tests use isolated synthetic
contract responses and cannot establish AI effectiveness. Keep those receipts separate from live-provider acceptance.


## Unattended operation (Phase 5)

Copy `scripts/qa/automation.example.json` into the private configuration directory, set future UTC `firstAt` values,
then set `TRD_QA_AUTOMATION_FILE` when starting the server. The example runs representative tests nightly and expanded
mutations weekly. `everyMinutes` is a fixed UTC interval (no local daylight-saving shift). Restart retains due times;
changing a schedule's ID establishes a new first occurrence. Pause/resume and cancel are available in the dashboard.
A manual campaign profile is also available; it requires the exact clean current commit.

Profiles reuse existing suites: `smoke` runs all three native settings checks; `matrix` runs all 21 cells (including three KDE cells with the private encoder fix); `nightly`
runs three representative RDP cells, a macOS/Ubuntu crop campaign with AI and a restored healthy lifecycle; `weekly`
runs healthy/all-13-mutation/healthy on each of the three representative cells. AI request/budget limits from Phase 4
remain persistent, with no automatic increase or reset. An exhausted AI limit makes a batch require attention;
passing deterministic tests do not imply completed AI evaluation. No infinite retries or catch-up queues.

On the current macOS operator host, with `.qa/private/{environments,targets,automation}.json` present:

```sh
node scripts/qa/service.mjs install
node scripts/qa/service.mjs status
node scripts/qa/service.mjs restart
node scripts/qa/service.mjs stop
```

This installs a user LaunchAgent from `.qa/service.plist`, keeps the local Codex sign-in in its normal credential
store, and restarts the server after a crash while the user session remains available. It needs an awake machine,
GUI session, running native clients and existing SSH forwards. It does not provision or restart VMs/tunnels.
The installer also writes its own plist under `~/Library/LaunchAgents`, so it starts again at user login.
`stop` unloads it for the current session; remove that named plist to disable future login startup.
For a Linux operator, use the same environment and Node entry point under an existing systemd user service plus
Xvfb; that deployment is not covered by the macOS installer acceptance.

The service refuses a second owner of the data directory. Tests, reviews, investigations and profile batches share
one execution lock. A restart marks active work interrupted/unverified and does not replay it. Source changes during
an automatic batch stop further steps; never edit the dedicated checkout while tests run. A blocked schedule retains
its reason and advances to its next occurrence rather than repeatedly consuming resources.

### Hosted CI and the private credential boundary

`.github/workflows/visual-qa.yml` runs on pushes, PRs and manual dispatch using standard GitHub-hosted Ubuntu 24.04 x64,
Windows 2025 x64 and macOS 15 ARM64. It checks the build/types, installs checksum-pinned official Tabby,
and runs existing `smoke-host` plus `visual-smoke`. The latter reuses actual settings navigation, renderer checks,
client identity, screenshots and traces; it explicitly does not perform a reviewed hosted baseline comparison.
It cannot establish real RDP rendering without a remote desktop. Missing private credentials are never treated as
passing private-RDP coverage. Hosted environment-specific baselines require separate review before enabling them.
The full unit suite remains required by the existing Linux `ci.yml` workflow. Exploratory full-suite runs on hosted
Windows/macOS exposed fixture/tooling portability failures; native smoke success does not qualify those unit suites.

No OpenAI secret or login, private configuration, local cache or RDP network access is supplied to hosted workflows.
Checkout has credential persistence disabled. Uploads include only the job's temporary `tabby-qa-evidence` directory,
with seven-day retention, never a checkout-wide glob or `.qa/`. Public screenshots must use only the isolated dummy
smoke profile. AI remains local to the private service. Standard runners are free for public repos; larger runners
are billed. See [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

With `github:true`, the private server queries GitHub using the operator's existing `gh` read access every five
minutes while idle. It records PR links, CI state and hosted-job links for the current commit. Hosted artifact links
open GitHub; untrusted workflow HTML/scripts are not imported into the authenticated private dashboard origin.
A successful existing `ci.yml` run triggers private smoke (main push: matrix) once per observed CI run, only for an
identical clean checked-out commit. The operator provisions that checkout; public PRs are never automatically
checked out on machines holding private access. No GitHub issue/comment/status is automatically posted.

### Evidence history, investigations and retention

The dashboard shows per-environment history, median duration, test versus infrastructure failures and
suspected mixed pass/fail results on the same clean commit/baseline digest. Filter run history by commit prefix.
Run evidence retains the digest of the reviewed baseline set. The first observed bad commit is a historical bound,
not causal attribution; environment changes can still explain a difference. No automatic bisection is claimed.

Failed ordinary runs trigger `investigation.json` automatically. It contains SHA-256 receipts and links for bounded
screenshots, diffs, trace, logs and environment attachments, recognized diagnostic signals, available GitHub context,
and comparable history. One private AI call uses an eligible failure image plus fixed diagnostic signal names.
Raw file text, addresses and credentials are not uploaded. Without eligible images, the record says so; without
model access/budget, investigation fails visibly while preserving diagnostics. Manual investigation of retained
ordinary evidence is available too. Investigations never enter mutation sensitivity/false-positive denominators.

Default retention is 14 days for ordinary passes and 90 days for failures/campaigns. The latest result of each
scenario/mode/status, active work and current batch evidence are protected. Under pressure, ordinary passes older
than one day may be removed earlier; failures retain the full minimum. The default capacity is 500 runs / 10 GB.
Protected evidence can make this a soft storage ceiling: new runs block until the operator archives it. A single
run may cross the threshold before the next admission check. Deletion receipts retain the last 1000 removals;
automation state retains 200 batches. AI caches/reviews remain bounded by their existing request/history caps.
Back up `.qa/runs`, `.qa/automation`, and AI cache/ledger together, privately; never reset a ledger to bypass limits.

### Reproduce the scheduled browser acceptance

After a real scheduled `nightly` batch completes, inspect its retained mutation, restored healthy run, automatic
investigations and responsive dashboard with:

```sh
TRD_QA_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node scripts/qa/automation-acceptance.mjs <nightly-batch-id>
```

Omit `TRD_QA_BROWSER` when the Playwright-managed Chromium is installed. The observer does not launch a campaign or
make AI requests. It preserves real failed results and requires completed investigations for them. Receipts and
screenshots remain in `.qa/`; see the Phase 5 handoff in `VISUAL-QA-PLAN.md` for exact accepted runs and known limits.

### Fedora 44 / KDE Plasma / KRDP (private encoder and FreeRDP fixes)

Three Fedora KDE cells, `visual-{macos,windows,linux}-fedora44-kde`, bring the matrix to 21. They explicitly select a
**private KPipeWire encoder fix, KRDP/FreeRDP compatibility fix and a fixed 800×600 remote monitor**. Stock Fedora's software encoder fails color fidelity
and is not qualified. Tests verify actual client/plugin, Plasma/Wayland, dependencies and both loaded private libraries;
record actual H.264 frames; and retain pixel probes, raw/visible PNGs, counters, logs and traces. Checkpoints cover
initial rendering, keyboard/mouse input, tab return, client fitting into a 900×650 pane, reconnect and cleanup.
**Live remote-resolution changes are unsupported by the tested KRDP monitor path.** Client fitting is reported separately.

The eight-level RGB marker tolerance, zero-different-pixel baseline rule and zero retries are unchanged. Baseline names
include both patch digests and the FreeRDP version. The test rejects a missing manifest, a different source/patch, an unloaded private
library or a changed library digest. The brief desktop-name overlay must finish fading naturally before capture;
it is not hidden with CSS. There is no production Tabby/IronRDP decoder change.

Provision only a dedicated disposable VM, using a fresh private password file (at least 20 characters). Set
`TEST_IMAGE` and `TEST_IMAGE_SHA256` to the reviewed Fedora cloud image and digest before this command:

```sh
TEST_DISTRO=fedora44-kde TEST_KRDP_PASSWORD_FILE=/private/kde-password \
  TEST_SECURE_BOOT=0 testbed/linux/libvirt.sh qa-fedora-kde /path/test-key.pub
```

This installs SDDM autologin, Plasma/KWin/KRDP, PipeWire and software OpenH264, with a loopback VNC console and virtio
video. It disables screen locking and masks PowerDevil only in the disposable account: an inactive physical output
otherwise yields zero decoded frames despite successful RDP authentication. The KRDP user service listens on
`127.0.0.1:3389`; all clients reach it through authenticated SSH. SELinux remains enforcing. It uses monitor 0,
quality 100, and a persistent private self-signed certificate under `~/.local/share/krdpserver/` (directory 0700,
key 0600, 365-day validity). Reconnect preserves the certificate. Rotate it deliberately and review Tabby's changed
certificate prompt; never silently accept replacements. The existing certificate-bound TLS login consent is exercised.

**Provisioning has a one-time console step.** After reboot, create a wallet named `kdewallet` in the dedicated Plasma
session with KWalletManager. The isolated unattended test VM uses an empty wallet unlock password; its wallet contains
only the disposable QA login, protected by account/file permissions, not encryption at rest. Do not apply this setup
to a personal workstation or store service/OpenAI credentials there. Close the welcome tour. Then install/rotate the QA
password through stdin, using the copied provisioner (no secret in command arguments):

```sh
ssh fedora@GUEST sudo sh /tmp/provision.sh fedora credentials < /private/kde-password
```

If `/tmp/provision.sh` has been removed, copy `testbed/linux/kde.sh` there first. The bounded `kwallet-query` write requires
an existing accessible wallet; failure requires console review. `SystemUserEnabled=false` and `Users=fedora` select this
wallet-backed login. The same fresh secret is also the disposable account password. Restart with
`systemctl --user restart app-org.kde.krdpserver.service` as that account. No WinPR SAM file is needed.

Set the virtual output to **800×600 at scale 1** in Plasma display settings before testing. `kscreen-doctor -o` identifies
the numeric mode; on the tested virtio output it is `output.Virtual-1.mode.24 output.Virtual-1.scale.1`. Use the session's
actual `WAYLAND_DISPLAY` from `systemctl --user show-environment`. Mode IDs are not portable. Wake an already inactive
output with `kscreen-doctor --dpms on`. Confirm the selected mode and autologin after reboot.

The observed stack is Fedora 44, Plasma/KWin/KRDP/KPipeWire **6.7.5**, PipeWire **1.6.9**, FFmpeg-free **8.1.3**,
OpenH264 **2.6.0**, and FreeRDP/WinPR **3.32.1-1.fc44**. Initial stock KRDP rejected valid login with 3.32.1; the
first qualification used a temporary 3.24.2 pin. The optional compatibility installer below replaces that pin with
3.32.1 and an isolated KRDP correction. Initial provisioning still uses 3.24.2 until the two private fixes are installed.
The current runtime check requires 3.32.1 both installed and actually mapped, plus both reviewed private libraries.
This remains a patched QA profile, not stock Fedora qualification or a production deployment recommendation.

Each private target supplies normal SSH/client CDP settings plus `TRD_TEST_KRDP_USER=fedora` and
`TRD_TEST_KRDP_PASSWORD`. Keep them in the ignored private target file. Never include these files, wallets, keys, Codex
login material or raw private profiles in GitHub artifacts. Baseline creation remains an explicit local command; do not baseline the stock encoder's distortion.

#### Installing the isolated encoder correction

After the wallet/display setup, copy `testbed/linux/kde-encoder.sh` and `testbed/linux/kpipewire-krdp-color.patch`
into the same directory on the guest. Run `sh kde-encoder.sh` as its dedicated Plasma user (sudo is used only to install
build dependencies). This is an explicit opt-in, not part of stock Fedora provisioning. It fetches upstream KPipeWire
6.7.5 at commit `6318082fe449b50e701abc4d91308c2371cf8741`, verifies the revision, applies the reviewed patch and builds
with two compiler jobs. Existing modified sources must match the exact patch; unexpected source files fail the install.
Build dependencies can update development/runtime packages; retain the DNF transaction and recheck/reboot the guest.

The source fix builds the filter after `setColorRange`, converts RGB directly to full-range BT.709, and supplies the
encoder with matching range/matrix/primaries and the desktop's sRGB transfer metadata. It changes only the full-range
OpenH264 path; upstream's existing limited-range path is retained. This patch derives from KDE's LGPL-licensed
`libopenh264encoder.cpp`; the fetched source preserves its license notices. This is a local QA correction, not an
upstream release or a published upstream submission.

Libraries install under `~/.local/share/tabby-qa-kpipewire/<patch-sha>/install/`; Fedora libraries remain intact.
Only the KRDP user service gets `LD_LIBRARY_PATH` and `KPIPEWIRE_FORCE_ENCODER=libopenh264` through its `encoder.conf`
override. The installer writes `manifest.json` with upstream revision, patch and binary digests. Tests verify the
live KRDP process's mapped `libKPipeWireRecord` path and its bytes against this receipt. The manifest contains no secrets.

Rollback by removing `~/.config/systemd/user/app-org.kde.krdpserver.service.d/encoder.conf`, then running
`systemctl --user daemon-reload` and `systemctl --user restart app-org.kde.krdpserver.service`. The QA identity check will
then reject stock-library use. Restore the earlier test checkout for an intentional stock-color reproduction; retain
its Failed result. Do not claim these patched baselines qualify unpatched Fedora or every H.264 server/encoder.

Use the existing explicit baseline command for each native client, review the images, commit, then run
`scripts/qa/acceptance.mjs visual-CLIENT-fedora44-kde` with the local dashboard. The acceptance receipts and exact limits
are in `VISUAL-QA-PLAN.md`.

#### Installing the isolated FreeRDP compatibility correction

After installing the encoder correction, copy `testbed/linux/kde-freerdp.sh` and
`testbed/linux/krdp-freerdp-compat.patch` into the same guest directory and run `sh kde-freerdp.sh` as the dedicated
Plasma user. It saves the three known-good 3.24.2 RPMs in `~/tabby-qa-freerdp-rollback/`, upgrades and versionlocks
FreeRDP/WinPR to 3.32.1-1.fc44, installs build dependencies and builds only the KRDP library. Keep its DNF/build log;
build dependencies can update other guest packages, so reboot and verify the display/service before qualification.

The patch uses upstream KRDP 6.7.5 commit `270dcf01851229134f74fa7d90ac338ec788ec67` and explicitly disables
extended NLA alongside the existing disabled NLA setting. TLS remains enabled, legacy RDP security remains disabled,
and the existing wallet credential validation is unchanged. This addresses the negotiation incompatibility described
in [KDE bug 526514](https://bugs.kde.org/show_bug.cgi?id=526514); the report is not evidence of our acceptance.
The one-line patch derives from KDE's GPL-2.0-or-later `RdpConnection.cpp`, with upstream notices retained in the clone.
No client security setting, certificate validation or certificate-bound consent is bypassed.

Only `libKRdp` installs under `~/.local/share/tabby-qa-krdp/<patch-sha>/install/lib64/`; Fedora's server executable
and KRDP libraries remain intact. The `freerdp.conf` user-service override sorts after `encoder.conf` and sets
`LD_LIBRARY_PATH` to both private library directories. If changing the encoder installation, rerun this installer
to refresh that combined path. The manifest records source/patch/binary digests; QA checks both mapped libraries
against their receipts. This is a local correction, not an upstream release or published submission.

To roll back to the earlier qualified dependency, stop this guest's KRDP service, remove only `freerdp.conf`, delete
its three FreeRDP versionlocks, and downgrade using the saved RPMs. Newly installed `freerdp-devel`/`libwinpr-devel`
may require removal or a matching downgrade first; inspect the DNF transaction before accepting removals. Relock the
three runtime packages, reload the user manager and restart KRDP. Keep `encoder.conf` for the color correction.
The current QA identity check deliberately rejects that old profile; use its matching earlier checkout and receipts.
Rollback does not qualify stock 3.32.1. An interrupted installer also requires this recovery or a successful rerun.

The 12 baseline images retain the previously reviewed bytes under names containing the new FreeRDP/patch identity.
Normal comparison runs must pass without generating new expected pixels; acceptance receipts are in the plan.
