import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestContext, type CanvasInfo } from '../lib/harness.js'
import { clientIdentity, verifyLinuxIdentity, type ClientIdentity } from './identity.js'
import { campaign } from './mutations.js'
import { windowsGuest } from '../lib/windows.js'

const kind = process.env.TRD_QA_TEST === 'visual-windows' ? 'windows' : 'linux'
const fixtureLifetime = process.env.TRD_QA_MUTATIONS ? 1200 : 300
const xrdp = kind === 'linux' && process.env.TRD_TEST_EXPECT_STACK === 'xrdp'
const krdp = kind === 'linux' && process.env.TRD_TEST_EXPECT_STACK === 'krdp'
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/visual')
interface FixtureState { version: number, sequence: number, input: string, platform: string, width: number, height: number, ready: boolean, scale: number, font: string, captureId?: number }

// Each selected environment is one serial lifecycle, with named checkpoints and its own report/trace.
test(`Real RDP visual checkpoints: ${kind}`, async ({}, info) => {
    if (process.env.TRD_QA_MUTATIONS && process.env.TRD_QA_UPDATE_BASELINES === '1') throw new Error('Mutation campaigns cannot update baselines')
    info.annotations.push({ type: 'infrastructure', description: 'Preparing dedicated remote environment' })
    const required = kind === 'linux' ? ['TRD_TEST_HOST'] : ['TRD_TEST_WIN_SSH_HOST', 'TRD_TEST_WIN_ADDRESS', 'TRD_TEST_WIN_USER', 'TRD_TEST_WIN_PASSWORD', 'TRD_TEST_WIN_WINRM']
    for (const key of required) expect(process.env[key], `Configure ${key} for this environment`).toBeTruthy()
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.TRD_CDP_PORT}`)
    const context = browser.contexts()[0]
    const page = context.pages().find(p => !p.url().startsWith('devtools:'))!
    const harness = await createTestContext()
    const t = harness.t
    const { ev } = t
    let tracing = false
    let fixtureLog: () => Promise<string> = async () => ''
    let readState: () => Promise<FixtureState | null> = async () => null
    let control: (value: object) => Promise<unknown> = async () => {}
    let guestCapture: (name: string, verify?: boolean) => Promise<void> = async () => {}
    let cleanupFixture: () => Promise<unknown> = async () => {}
    let cleanupSession: () => Promise<unknown> = async () => {}
    const metadata: Record<string, unknown> = { environment: kind, stack: krdp ? 'krdp' : xrdp ? 'xrdp' : kind === 'linux' ? 'grd' : 'windows', coverage: 'Real RDP framebuffer through Tabby / IronRDP', fixtureVersion: 1, h264: krdp, checkpoints: [] }
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
        expect(await ev('return globalThis.__trdSmokeCredentials')).toBe(true)
        metadata.client = await clientIdentity(ev)
        metadata.host = await ev('return RD.compat.snapshot()')
        // Keep Playwright's viewport state in sync so element screenshots restore this size, rather than native window bounds.
        await page.setViewportSize({ width: 1100, height: 850 })
        const cdp = await context.newCDPSession(page)
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false })
        await t.settings({ desk: false, resize: krdp ? 'off' : 'live', zoom: 'fit', sharpness: 'standard', clipboard: 'off', sound: false, microphone: false, h264: krdp, connectionStatus: false })
        const win = t.env.windows
        const over = kind === 'windows' ? { host: win.host, user: win.user, name: 'Windows QA' } : { name: 'Linux QA' }
        expect(await ev(`H.pane = await H.openSSH(${JSON.stringify(over)}); return !!H.pane`), 'SSH test transport').toBe(true)
        let remoteKey = kind as string
        if (kind === 'linux') {
            const identity = JSON.parse((await t.remote('H.pane', `python3 - <<'PYID'
import json, subprocess, pathlib, hashlib, os as operating_system
os = dict(line.split('=', 1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
def value(key): return os.get(key, '').strip('"')
def command(args): return subprocess.check_output(args, text=True).strip()
identity = dict(os=value('ID'), version=value('VERSION_ID'), point=pathlib.Path('/etc/debian_version').read_text().strip() if value('ID') == 'debian' else '')
if ${krdp ? 'True' : 'False'}:
    identity.update({key: command(['rpm', '-q', '--qf', '%{VERSION}', package]) for key, package in [('plasma', 'plasma-workspace'), ('krdp', 'krdp'), ('pipewire', 'pipewire'), ('kpipewire', 'kpipewire'), ('ffmpeg', 'ffmpeg-free'), ('openh264', 'openh264'), ('freerdp', 'freerdp-libs')]})
    identity['kwin'] = command(['rpm', '-qf', '--qf', '%{VERSION}', '/usr/bin/kwin_wayland'])
    identity['session'] = dict(line.split('=', 1) for line in command(['systemctl', '--user', 'show-environment']).splitlines() if '=' in line).get('XDG_SESSION_TYPE', '')
    pid = command(['pgrep', '-u', str(operating_system.getuid()), '-x', 'krdpserver'])
    assert pid.isdigit(), 'Expected one dedicated KRDP service'
    maps = pathlib.Path('/proc/'+pid+'/maps').read_text().splitlines()
    freerdp = {line.split()[-1] for line in maps if '/libfreerdp3.so.' in line}
    assert len(freerdp) == 1, 'Expected one loaded FreeRDP library'
    identity['loadedFreerdp'] = command(['rpm', '-qf', '--qf', '%{VERSION}', next(iter(freerdp))])
    for key, package, library in [('encoder', 'kpipewire', 'libKPipeWireRecord'), ('server', 'krdp', 'libKRdp')]:
        manifest = json.loads((pathlib.Path.home()/('.local/share/tabby-qa-'+package+'/manifest.json')).read_text())
        loaded = {line.split()[-1] for line in maps if '/'+library+'.so.' in line}
        assert loaded == {manifest['library']}, 'KRDP did not load the declared private '+key
        identity[key] = dict(sourceCommit=manifest['sourceCommit'], patchSha256=manifest['patchSha256'], librarySha256=manifest['librarySha256'], loadedLibrarySha256=hashlib.sha256(pathlib.Path(manifest['library']).read_bytes()).hexdigest())
elif value('ID') == 'rocky':
    identity.update({key: command(['rpm', '-q', '--qf', '%{VERSION}', package]) for key, package in [('xfce', 'xfce4-session'), ('xrdp', 'xrdp'), ('xorgxrdp', 'xorgxrdp')]})
else:
    identity.update(gnome=command(['gnome-shell', '--version']), grd=command(['rpm', '-q', '--qf', '%{VERSION}', 'gnome-remote-desktop'] if value('ID') == 'fedora' else ['dpkg-query', '-W', '-f', '\${Version}', 'gnome-remote-desktop']))
print(json.dumps(identity))
PYID`)).trim())
            metadata.remote = identity
            verifyLinuxIdentity(identity)
            remoteKey = krdp ? `${identity.os}-${identity.version}-plasma-${identity.plasma}-krdp-${identity.krdp}-kpipewire-qa-${identity.encoder.patchSha256.slice(0,12)}-freerdp-${identity.freerdp}-qa-${identity.server.patchSha256.slice(0,12)}-h264`
                : xrdp ? `${identity.os}-${identity.version}-xfce-${identity.xfce}-xrdp-${identity.xrdp}-xorgxrdp-${identity.xorgxrdp}`
                : `${identity.os}-${identity.point || identity.version}-gnome-${identity.gnome.match(/\b(\d+\.[\d.]+)/)?.[1]}-grd-${identity.grd.match(/\b(\d+\.[\d.]+)/)?.[1]}`
        }
        t.onCleanup(() => ev('globalThis.__trdMutationRestore?.(); document.getElementById("trd-visual-size")?.remove()'))
        const setSize = async (width: number, height: number) => {
            // Tabby's focus/sign-in layout writes inline dimensions again. Keep the test
            // viewport fixed through those real interactions, scoped to this owned pane.
            await ev(`const el=H.pane.element.nativeElement; el.setAttribute('data-trd-visual-pane','');
                let style=document.getElementById('trd-visual-size'); if(!style){style=document.createElement('style');style.id='trd-visual-size';document.head.append(style)}
                style.textContent='[data-trd-visual-pane] {flex:none!important;min-width:0!important;min-height:0!important;width:${width}px!important;height:${height}px!important}'`)
        }
        await setSize(800, 600)
        // Tabby's new-tab animation can temporarily transform the pane. Negotiate the
        // initial desktop only after its visible geometry settles; live resize stays observed below.
        let stableSizeSamples = 0
        await expect.poll(async () => {
            const rect = await ev<{ width: number, height: number }>('const r=H.pane.element.nativeElement.getBoundingClientRect(); return {width:r.width,height:r.height}')
            stableSizeSamples = Math.abs(rect.width-800)<0.05 && Math.abs(rect.height-600)<0.05 ? stableSizeSamples+1 : 0
            return stableSizeSamples >= 3
        }, { intervals: [100], message: 'Initial native Tabby pane geometry has settled' }).toBe(true)
        // Persistent native clients remember their last desktop behind an SSH host.
        // Select the host's own GNOME desktop explicitly after a Windows-via-SSH run.
        let desktopId = 'own'
        if (krdp) {
            // Existing generic external RDP transport uses the legacy 'windows' kind. Guest identity above
            // establishes KDE/KRDP independently; no GNOME auto-setup or xrdp downgrade is used.
            desktopId = '127.0.0.1:3389'
            await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops=[{name:'Fedora KDE / KRDP QA',via:${JSON.stringify(t.env.host)},host:'127.0.0.1',port:3389,kind:'windows',username:${JSON.stringify(process.env.TRD_TEST_KRDP_USER)}}]; H.config.save() })`)
        } else if (kind === 'windows') {
            const host = win.address.replace(/:\d+$/, '')
            const port = Number(/:(\d+)$/.exec(win.address)?.[1] || 3389)
            desktopId = `${host}:${port}`
            await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops=[{name:'Windows QA',via:${JSON.stringify(win.host)},host:${JSON.stringify(host)},port:${port},kind:'windows',username:${JSON.stringify(win.account)}}]; H.config.save() })`)
        }
        const connect = async () => {
            await ev(`await H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(desktopId)}))`)
            if (kind === 'windows' || xrdp || krdp) {
                if (xrdp) {
                    expect(t.env.user, 'SSH and fixture desktop use the dedicated xrdp account').toBe(t.env.xrdp.user)
                }
                await t.waitFor('return RD.desktop.isConnected(H.pane) || !!H.overlay(H.pane)?.querySelector(".trd-signin form")', 30)
                if (xrdp) expect(await ev('return RD.desktop.desktopOf(H.pane)?.kind'), 'Detected real xrdp desktop').toBe('xrdp')
                // Credentials use raw CDP, never Playwright arguments; initial sign-in precedes tracing.
                await ev(`const f=H.overlay(H.pane)?.querySelector('.trd-signin form'); if(f){f.querySelector('[name=remember]').checked=true; f.querySelector('[name=password]').value=${JSON.stringify(krdp ? process.env.TRD_TEST_KRDP_PASSWORD : xrdp ? t.env.xrdp.password : win.password)};f.requestSubmit()}`)
                if (xrdp || krdp) {
                    await t.waitFor('return RD.desktop.isConnected(H.pane) || /Network Level Authentication/.test(H.status(H.pane)?.text || "")', 30)
                    // Exercise existing certificate-bound consent for this dedicated TLS-authenticated server.
                    await ev('if (/Network Level Authentication/.test(H.status(H.pane)?.text || "")) H.inZone(() => H.clickStatus(H.pane, "Send the password anyway"))')
                }
            }
            expect(await t.waitFor('return RD.desktop.isConnected(H.pane) && (H.canvas(H.pane)?.colors ?? 0)>10', 60), 'Real RDP connection and decoded desktop frame').toBeTruthy()
            if (krdp) {
                await expect.poll(() => ev('return H.session(H.pane)?.h264?.stats.frames ?? 0'), { message: 'KRDP actually delivered decoded H.264 frames' }).toBeGreaterThan(0)
                metadata.codec = await ev('const d=H.session(H.pane).h264; return {name:"H.264",...d.stats,failed:d.failed,graphics:RD.desktop.logOf(H.pane).findLast(l=>/^graphics: /.test(l))}')
            }
        }
        await connect()
        // Sign-in/consent can cause Tabby to lay out the tab again. Establish the fixed
        // initial viewport after those dialogs, before launching the fullscreen fixture.
        await setSize(800, 600)
        await expect.poll(async () => {
            const frame = await ev<CanvasInfo>('return H.canvas(H.pane)')
            return [frame?.w, frame?.h, frame?.cssW, frame?.cssH]
        }, { timeout: 15_000, message: 'Initial remote and visible resolution is 800x600' }).toEqual([800, 600, 800, 600])
        // Store the initial desktop as evidence, not a nondeterministic OS-shell regression baseline.
        await info.attach('initial-desktop', { body: Buffer.from((await ev<string>('return H.canvasElement(H.pane).toDataURL("image/png")')).split(',')[1], 'base64'), contentType: 'image/png' })
        if (kind === 'linux') {
            // An evidence-only OS screenshot must not hide an active crash reporter behind
            // the fullscreen fixture. Inspect only this dedicated account, without dumping
            // crash payloads/process arguments (which can contain credentials).
            const health = JSON.parse((await t.remote('H.pane', `python3 - <<'PYHEALTH'
import json, os, pathlib
reporters = []
for p in pathlib.Path('/proc').iterdir():
    try:
        if p.name.isdigit() and p.stat().st_uid == os.getuid():
            name = (p/'comm').read_text().strip()
            if name in ('apport-gtk', 'whoopsie', 'gnome-abrt', 'abrt-applet'):
                reporters.append(dict(pid=int(p.name), name=name))
    except (OSError, ValueError): pass
print(json.dumps(dict(activeCrashReporters=reporters)))
PYHEALTH`)).trim())
            await info.attach('desktop-health', { body: JSON.stringify(health), contentType: 'application/json' })
            expect(health.activeCrashReporters, 'Dedicated desktop has no active crash reporter; inspect initial-desktop before fixture setup').toEqual([])
        }
        if (kind === 'linux') {
            const directory = (await t.remote('H.pane', 'mktemp -d /tmp/tabby-visual-qa-XXXXXX')).trim()
            expect(directory).toMatch(/^\/tmp\/tabby-visual-qa-[A-Za-z0-9]+$/)
            await t.remote('H.pane', `cat > ${directory}/fixture.py`, fs.readFileSync(path.join(fixtures, 'fixture.py'), 'utf8'))
            // Fullscreen fixture owns its fonts/theme/background and has no animations or clock.
            if (xrdp) {
                let session = ''
                await expect.poll(async () => {
                    session = (await t.remote('H.pane', 'pgrep -u "$(id -u)" -x xfce4-session || true')).trim()
                    return /^\d+$/.test(session)
                }, { timeout: 30_000, message: 'One real Xfce session for the dedicated xrdp account' }).toBe(true)
                cleanupSession = () => t.remote('H.pane', `kill ${session} 2>/dev/null || true`)
                await t.remote('H.pane', `python3 - <<'PYFIXTURE'
import os, pathlib, subprocess
session = dict(part.split('=', 1) for part in pathlib.Path('/proc/${session}/environ').read_text().split('\\0') if '=' in part)
for key in ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']:
    if key in session: os.environ[key] = session[key]
assert os.environ.get('DISPLAY'), 'Xfce session has no X11 display'
os.environ.update(GDK_BACKEND='x11', TRD_VISUAL_DESKTOP='xfce')
with open('${directory}/fixture.log', 'w') as log:
    child = subprocess.Popen(['python3', '${directory}/fixture.py', '${directory}', '${fixtureLifetime}'], stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
pathlib.Path('${directory}/pid').write_text(str(child.pid))
PYFIXTURE`)
            } else {
                await t.remote('H.pane', `W=$(systemctl --user show-environment | sed -n 's/^WAYLAND_DISPLAY=//p'); WAYLAND_DISPLAY=\${W:-wayland-0} GDK_BACKEND=wayland TRD_VISUAL_DESKTOP=${krdp ? 'kde' : 'gnome'} setsid python3 ${directory}/fixture.py ${directory} ${fixtureLifetime} >${directory}/fixture.log 2>&1 < /dev/null & echo $! > ${directory}/pid`)
            }
            fixtureLog = () => t.remote('H.pane', `cat ${directory}/fixture.log 2>/dev/null || true`)
            readState = async () => { try { return JSON.parse(await t.remote('H.pane', `cat ${directory}/state.json 2>/dev/null || true`)) } catch { return null } }
            control = value => t.remote('H.pane', `cat > ${directory}/command.json`, JSON.stringify(value))
            cleanupFixture = async () => {
                await control({ quit: true })
                await t.sleep(300)
                const removed = await t.remote('H.pane', `pkill -f '^python3 ${directory}/fixture.py ${directory}( [0-9]+)?$' 2>/dev/null || true; rm -rf ${directory}; test ! -e ${directory} && echo cleaned`)
                expect(removed.trim(), 'Remote fixture directory removed').toBe('cleaned')
            }
        } else {
            await t.key('Escape', 'Escape', 27)
            const guest = windowsGuest(t, 'H.pane')
            metadata.remote = await guest.guest("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' | Select-Object EditionID,DisplayVersion,CurrentBuildNumber,UBR | ConvertTo-Json -Compress")
            const version = JSON.parse(metadata.remote as string)
            expect(Number(version.CurrentBuildNumber), 'Windows 11 build (22000 or newer)').toBeGreaterThanOrEqual(22000)
            expect(version.EditionID, 'Windows client edition').not.toMatch(/Server/i)
            if (process.env.TRD_TEST_EXPECT_VERSION) expect(version.DisplayVersion, 'Actual Windows release').toBe(process.env.TRD_TEST_EXPECT_VERSION)
            if (process.env.TRD_TEST_EXPECT_BUILD) expect(version.CurrentBuildNumber, 'Actual Windows build').toBe(process.env.TRD_TEST_EXPECT_BUILD)
            remoteKey = `windows-${version.DisplayVersion}-${version.CurrentBuildNumber}.${version.UBR}`
            const directory = (await guest.guest("$d=Join-Path $env:TEMP ('tabby-visual-qa-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $d | Out-Null; $d")).trim()
            expect(directory).toMatch(/^[A-Za-z]:\\[^'\r\n]+\\tabby-visual-qa-[a-f0-9]+$/)
            const script = fs.readFileSync(path.join(fixtures, 'fixture.ps1'), 'utf8')
            // WinRM encodes the request again; bounded chunks stay below Windows' command-line limit.
            const encoded = Buffer.from(script).toString('base64')
            await guest.guest(`[IO.File]::WriteAllText('${directory}\\fixture.b64','')`)
            for (let offset = 0; offset < encoded.length; offset += 1600) await guest.guest(`[IO.File]::AppendAllText('${directory}\\fixture.b64','${encoded.slice(offset, offset+1600)}')`)
            await guest.guest(`[IO.File]::WriteAllBytes('${directory}\\fixture.ps1',[Convert]::FromBase64String([IO.File]::ReadAllText('${directory}\\fixture.b64')))`)
            await guest.inSession('tabby-visual-qa', `& '${directory}\\fixture.ps1' -Directory '${directory}' -LifetimeSeconds ${fixtureLifetime} *> '${directory}\\fixture.log'`)
            fixtureLog = () => guest.guest(`Get-Content -Raw '${directory}\\fixture.log' -ErrorAction SilentlyContinue`)
            readState = async () => { try { return JSON.parse((await guest.guest(`Get-Content -Raw '${directory}\\state.json' -ErrorAction SilentlyContinue`)).replace(/^\uFEFF/, '')) } catch { return null } }
            control = value => guest.guest(`[IO.File]::WriteAllText('${directory}\\command.json','${JSON.stringify(value)}')`)
            guestCapture = async (name, verify = true) => {
                const previous = (await readState())?.captureId || 0
                await control({ capture: true })
                await expect.poll(async () => (await readState())?.captureId).toBe(previous + 1)
                const png = await guest.guest(`[Convert]::ToBase64String([IO.File]::ReadAllBytes('${directory}\\guest.png'))`)
                await info.attach(`${name}-guest-screen`, { body: Buffer.from(png.trim(), 'base64'), contentType: 'image/png' })
                const pixels = await ev<number[][]>(`const image = new Image(); image.src = 'data:image/png;base64,${png.trim()}'; await image.decode();
                    const c = document.createElement('canvas'); c.width=image.width; c.height=image.height; const g=c.getContext('2d'); g.drawImage(image,0,0);
                    return [[24,24],[c.width-24,24],[24,c.height-24],[c.width-24,c.height-24]].map(([x,y])=>Array.from(g.getImageData(x,y,1,1).data))`)
                if (verify) expect(pixels, 'Same-session guest displayed edge markers').toEqual([[220,40,60,255],[30,200,80,255],[40,80,220,255],[240,200,40,255]])
            }
            cleanupFixture = async () => { await control({ quit: true }); await t.sleep(500); await guest.dropTask('tabby-visual-qa'); expect((await guest.guest(`Remove-Item -LiteralPath '${directory}' -Recurse -Force; if (!(Test-Path -LiteralPath '${directory}')) { 'cleaned' }`)).trim(), 'Remote fixture directory removed').toBe('cleaned') }
        }
        await expect.poll(async () => (await readState())?.ready, { timeout: 30_000, message: 'Remote fixture starts in the real desktop session' }).toBe(true)
        const initial = (await readState())!
        expect(initial.scale, 'Dedicated remote display scale').toBe(1)
        // GNOME opens its overview on a fresh headless session; dismiss it through actual RDP input.
        if (kind === 'linux' && !xrdp) await t.key('Escape', 'Escape', 27)
        metadata.fixture = initial
        metadata.guestPixelOracle = kind === 'windows' ? 'CopyFromScreen in the same interactive RDP session' : 'Not captured by the Linux fixture; remote JSON describes application state, not independently captured guest pixels'
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); tracing = true
        const canvas = page.locator('.trd-overlay iron-remote-desktop canvas')
        const samples = async () => ev<{ width: number, height: number, points: number[][] }>(`const cv=H.canvasElement(H.pane), c=cv.getContext('2d'),w=cv.width,h=cv.height;
            return {width:w,height:h,points:[[24,24],[w-24,24],[24,h-24],[w-24,h-24],[w-120,h-112]].map(([x,y])=>Array.from(c.getImageData(x,y,1,1).data))}`)
        const assertFrame = async (sequence: number, timeout = 15_000) => {
            const remote = await readState()
            expect(remote?.sequence, 'Independent remote fixture state').toBe(sequence)
            const expected = [[220,40,60],[30,200,80],[40,80,220],[240,200,40], sequence%2 ? [240,200,40] : [30,100,200]]
            await expect.poll(async () => {
                const frame = await samples()
                return frame.width === remote?.width && frame.height === remote?.height && frame.points.every((rgb,i)=>rgb[3] === 255 && rgb.slice(0,3).every((value,j)=>Math.abs(value-expected[i][j])<=8))
            }, { timeout, message: 'Decoded framebuffer geometry, four edge markers and remote sequence color' }).toBe(true)
        }
        const snapshotName = (name: string) => {
            const host = metadata.host as { version: string, electron: string }
            return `${remoteKey}-${(metadata.client as ClientIdentity).platform}-${(metadata.client as ClientIdentity).arch}-tabby-${host.version}-electron-${host.electron}-${name}.png`
        }
        const checkpoint = async (name: string, baseline = true) => {
            await guestCapture(name)
            // The external-desktop label fades naturally. Never baseline its transient overlay or hide it with CSS.
            if (krdp) await expect.poll(() => ev('const label=H.overlay(H.pane)?.querySelector(".trd-osd"); return !label || getComputedStyle(label).opacity === "0"'), { message: 'Transient desktop label finished fading' }).toBe(true)
            if (name === 'actual') info.annotations.splice(info.annotations.findIndex(a => a.type === 'infrastructure'), 1)
            const state = (await readState())!
            const frame = await ev<CanvasInfo>('return H.canvas(H.pane)')
            ;(metadata.checkpoints as unknown[]).push({ name, state, frame })
            if (krdp) await info.attach(`${name}-pixel-probes`, { body: JSON.stringify(await samples()), contentType: 'application/json' })
            await info.attach(`${name}-raw-canvas`, { body: Buffer.from((await ev<string>('return H.canvasElement(H.pane).toDataURL("image/png")')).split(',')[1], 'base64'), contentType: 'image/png' })
            await info.attach(name, { body: await canvas.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' }), contentType: 'image/png' })
            await assertFrame(state.sequence)
            if (baseline) {
                expect([state.width, state.height], 'Remote checkpoint uses the requested resolution').toEqual(
                    !krdp && (name === 'resized' || name === 'reconnected') ? [900, 650] : [800, 600])
                const snapshot = snapshotName(name)
                if (fs.existsSync(info.snapshotPath(snapshot))) await info.attach(`${name}-expected`, { path: info.snapshotPath(snapshot), contentType: 'image/png' })
                await expect(canvas).toHaveScreenshot(snapshot, { maxDiffPixels: 0 })
            }
        }
        await test.step('Initial deterministic full desktop rendering', async () => { await checkpoint('actual') })
        if (process.env.TRD_QA_MUTATIONS) {
            const clip = await canvas.boundingBox()
            expect(clip).toBeTruthy()
            await test.step('Test the Tests: healthy controls, mutations and restoration', async () => {
                await campaign({ info, ev, snapshot: snapshotName('actual'),
                    capture: () => page.screenshot({ clip: clip!, animations: 'disabled', caret: 'hide', scale: 'css' }),
                    frameAssertion: async () => { await assertFrame((await readState())!.sequence, 2000) },
                    control, sequence: async () => (await readState())?.sequence,
                    settle: async () => { await assertFrame(0); await expect(canvas).toHaveScreenshot(snapshotName('actual'), { maxDiffPixels: 0 }) },
                })
            })
        }
        await test.step('Mouse and keyboard traverse the real RDP connection', async () => {
            await t.clickDesktop('H.pane', 160, initial.height-90)
            await expect.poll(async () => (await readState())?.input).toBe('mouse')
            await assertFrame(1); await checkpoint('mouse-input', false)
        })
        // Real scancode, then independently verify both the remote state and changed decoded color.
        await t.key(' ', 'Space', 32, [], ' ')
        await expect.poll(async () => (await readState())?.input).toBe('keyboard')
        await assertFrame(2); await checkpoint('keyboard-input', false)
        await control({ reset: true }); await expect.poll(async () => (await readState())?.sequence).toBe(0)
        await test.step('Tab switch restores the same real framebuffer', async () => {
            await ev("RD.help.openSettings('remote-desktop')")
            // Tabby may first show its default Settings page while opening the tab. Select the plugin page explicitly.
            await page.getByRole('tab', { name: /Remote Desktop/ }).click()
            await expect(page.locator('.trd-settings')).toBeVisible()
            await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.pane)))')
            await setSize(800, 600)
            await expect.poll(async () => (await readState())?.width).toBe(800)
            await checkpoint('tab-return')
        })
        await test.step(krdp ? 'Fixed KRDP monitor: client fit with bounded transition evidence (remote resize unsupported)' : 'Live remote resolution change with bounded transition evidence', async () => {
            const timeline: { elapsedMs: number, valid: boolean, frame: unknown, remote: unknown, captureMs: number }[] = []
            await checkpoint('before-resize', false)
            const started = performance.now()
            await setSize(900, 650)
            // Observe every sample, including settling/failure. Never retry a failed lifecycle until green.
            for (let index = 0; index < 12; index++) {
                const captured = performance.now()
                const remote = await readState()
                const frame = { ...await samples(), geometry: await ev<CanvasInfo>('return {...H.canvas(H.pane), devicePixelRatio}') }
                const observed = performance.now()-started
                const expected = [[220,40,60],[30,200,80],[40,80,220],[240,200,40],[30,100,200]]
                const [width, height] = krdp ? [800, 600] : [900, 650]
                const geometry = frame.geometry
                // KRDP shares a fixed compositor output; explicitly exercise client fit, not remote resize.
                const fitted = !krdp || (Math.abs(geometry.cssW-866.667)<=1 && Math.abs(geometry.cssH-650)<=1 && geometry.paneW===900 && geometry.paneH===650)
                const valid = fitted && remote?.width === width && remote?.height === height && frame.width === width && frame.height === height && frame.points.every((rgb,i) => rgb[3] === 255 && rgb.slice(0,3).every((v,j) => Math.abs(v-expected[i][j]) <= 8))
                await info.attach(`resize-${index}-raw`, { body: Buffer.from((await ev<string>('return H.canvasElement(H.pane).toDataURL("image/png")')).split(',')[1], 'base64'), contentType: 'image/png' })
                await info.attach(`resize-${index}-visible`, { body: await canvas.screenshot(), contentType: 'image/png' })
                if (kind === 'windows' && index === 5) await guestCapture('resize-5', false)
                timeline.push({ elapsedMs: observed, valid, frame, remote, captureMs: performance.now()-captured })
                await t.sleep(Math.max(0, 500-(performance.now()-captured)))
            }
            const firstCorrect = timeline.findIndex(s => s.valid)
            const summary = { mode: krdp ? 'Fixed 800x600 remote monitor; client fit into 900x650 pane; remote resize unsupported' : 'Live remote resolution', samples: timeline, firstCorrectMs: timeline[firstCorrect]?.elapsedMs ?? null,
                sampledRegions: 'Four 1px edge-marker centers and 1px sequence-tile center; does not estimate whole-screen damage area',
                classification: firstCorrect < 0 ? 'Persistent sampled-region/geometry failure' : timeline.slice(firstCorrect).every(s => s.valid) ? (firstCorrect ? 'Transient settling then sustained presentation' : 'Sustained presentation') : 'Presentation became invalid after a correct sample',
                clocks: 'Client monotonic elapsed time. Remote state is requested serially; no cross-host clock equivalence assumed.' }
            await info.attach('resize-timeline', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' })
            metadata.resizeObservation = summary
            expect(timeline.slice(-4).every(s => s.valid), 'Sustained correct geometry and sampled-region colors in the final four observations').toBe(true)
            expect(firstCorrect >= 0 && timeline.slice(firstCorrect).every(s => s.valid), 'No subsequent invalid sampled frame after correct repaint').toBe(true)
            await checkpoint('resized')
        })
        await test.step('Disconnect and reconnect the real desktop', async () => {
            await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
            await expect.poll(() => ev('return RD.desktop.isConnected(H.pane)')).toBe(false)
            await connect()
            await checkpoint('reconnected')
        })
        expect(errors, 'Renderer exceptions').toEqual([])
    } finally {
        if (krdp) metadata.finalCodec = await ev('const d=H.session(H.pane)?.h264; return {connected:RD.desktop.isConnected(H.pane),frame:H.canvas(H.pane),decoder:d?{...d.stats,failed:d.failed}:null}').catch(() => null)
        await ev('globalThis.__trdMutationRestore?.()').catch(() => {})
        await info.attach('final-window', { body: await page.screenshot({ timeout: 5000 }), contentType: 'image/png' }).catch(() => {})
        await info.attach('fixture-log', { body: (await fixtureLog().catch(() => 'Fixture log unavailable')).slice(-16000), contentType: 'text/plain' })
        await info.attach('environment', { body: JSON.stringify(metadata, null, 2), contentType: 'application/json' })
        await info.attach('rdp-log', { body: JSON.stringify(await ev('return H.pane ? RD.desktop.logOf(H.pane) : []').catch(() => []), null, 2), contentType: 'application/json' })
        if (tracing) {
            const trace = info.outputPath('trace.zip')
            await context.tracing.stop({ path: trace }); await info.attach('trace', { path: trace, contentType: 'application/zip' })
        }
        try { try { await cleanupFixture() } finally { await cleanupSession() } } finally {
            try { await harness.close() } finally { await browser.close() }
        }
    }
})
