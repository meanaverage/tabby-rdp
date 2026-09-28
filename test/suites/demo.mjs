// Makes the README demo video from the test machines: `npm test -- demo`. Four desktops in one tab (GNOME, Windows,
// GNOME for a second account, xrdp), a file pasted to all of them, a pane switched to its console and back, and
// `desk` bringing that console onto the desktop. Everything in it happens for real through the plugin; the pointer,
// the context menu (Tabby's is a native one, outside the page) and the captions are drawn over the page, since a
// page recording doesn't include them. Titles and prompts are neutral, so the machines' names don't show.
//
// Needs, besides TRD_TEST_HOST (lab-1, the ubuntu account's GNOME):
//   TRD_TEST_WIN_ADDRESS, _USER, _PASSWORD, _WINRM   the Windows desktop behind it (win-11), Explorer opened over WinRM
//   TRD_TEST_DEMO_GNOME_USER (default tabbyxrdp)       a second account there with GNOME (lab-2), same SSH key
//   TRD_TEST_DEMO_XRDP_USER, _PASSWORD                  an xrdp account there (lab-3; testbed/linux/xrdp.sh)
// and ffmpeg here. Writes docs/demo/tabby-rdp-demo.mp4 (not in git: upload it to GitHub) and docs/images/demo.jpg.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from '../lib/harness.mjs'
import { windowsGuest } from '../lib/windows.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WIDTH = 1600
const HEIGHT = 900
const FPS = 30
const GNOME_USER = process.env.TRD_TEST_DEMO_GNOME_USER || 'tabbyxrdp'
const XRDP_USER = process.env.TRD_TEST_DEMO_XRDP_USER || ''
const XRDP_PASSWORD = process.env.TRD_TEST_DEMO_XRDP_PASSWORD || ''
// A neutral prompt in Ubuntu's colors (green name, blue folder), so it shows as a real one does in the color scheme.
const NEUTRAL = name => `export PS1='\\[\\e[01;32m\\]you@${name}\\[\\e[00m\\]:\\[\\e[01;34m\\]\\w\\[\\e[00m\\]\\$ '; unset PROMPT_COMMAND; printf '\\033]0;${name}\\007'; cd ~; clear`
// A Tabby config.yaml whose look (its terminal and appearance settings: color scheme, font, size) the demo takes on.
const LOOK = process.env.TRD_TEST_DEMO_LOOK || ''

/** A wallpaper: a dark field with bands of one hue sweeping across it (SVG, so GNOME and XFCE take it as it is). */
function wallpaper (hue) {
    const bands = Array.from({ length: 9 }, (_, i) => {
        const r = 520 + i * 70
        const light = 30 + i * 4
        return `<path d="M ${-200 + i * 40} ${1180 - i * 10} C ${420 + i * 30} ${260 + i * 34}, ${1180 - i * 20} ${120 + i * 40}, ${2140} ${380 + i * 50}" fill="none" stroke="hsl(${hue},${70 - i * 2}%,${light}%)" stroke-width="${r / 7}" stroke-linecap="round" opacity="${0.55 + i * 0.04}"/>`
    }).join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<defs><radialGradient id="g" cx="30%" cy="20%" r="95%"><stop offset="0" stop-color="hsl(${hue},35%,14%)"/><stop offset="1" stop-color="#050608"/></radialGradient></defs>
<rect width="1920" height="1080" fill="url(#g)"/>${bands}</svg>`
}

/** The page-side stage: pointer, context menu, captions and key caps, over everything and never in the way. */
const STAGE = `(() => {
    document.getElementById('trd-stage')?.remove()
    const root = document.createElement('div')
    root.id = 'trd-stage'
    root.innerHTML = \`<style>
        #trd-stage { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: -apple-system, system-ui, sans-serif; }
        #trd-stage .ptr { position: absolute; left: 0; top: 0; width: 22px; height: 30px; transition: transform 0ms; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.6)); }
        #trd-stage .ptr.down svg { transform: scale(.88); transform-origin: 2px 2px; }
        #trd-stage .menu { position: absolute; min-width: 290px; padding: 5px; border-radius: 9px; background: rgba(44,44,48,.94); color: #f2f2f2;
            font-size: 13px; box-shadow: 0 10px 34px rgba(0,0,0,.55), 0 0 0 .5px rgba(255,255,255,.14) inset; backdrop-filter: blur(18px); }
        #trd-stage .menu .row { display: flex; justify-content: space-between; gap: 22px; padding: 3px 10px 3px 22px; border-radius: 5px; line-height: 18px; position: relative; white-space: nowrap; }
        #trd-stage .menu .row.head { color: rgba(255,255,255,.45); font-weight: 600; font-size: 12px; padding-left: 10px; }
        #trd-stage .menu .row.on { background: #2f66e0; }
        #trd-stage .menu .row .check { position: absolute; left: 7px; }
        #trd-stage .menu .row .sub { opacity: .7; }
        #trd-stage .menu .sep { height: 1px; margin: 5px 10px; background: rgba(255,255,255,.12); }
        #trd-stage .caption { position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%); padding: 10px 20px; border-radius: 12px;
            background: rgba(12,12,16,.82); color: #fff; font-size: 21px; font-weight: 500; letter-spacing: .01em; opacity: 0; transition: opacity .35s;
            box-shadow: 0 6px 24px rgba(0,0,0,.4); white-space: nowrap; }
        #trd-stage .caption.shown { opacity: 1; }
        #trd-stage .keys { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%) scale(.9); display: flex; gap: 8px; opacity: 0; transition: opacity .2s, transform .2s; }
        #trd-stage .keys.shown { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        #trd-stage .keys kbd { min-width: 54px; padding: 10px 14px; border-radius: 10px; background: rgba(250,250,252,.95); color: #111; font: 600 28px -apple-system, system-ui, sans-serif;
            text-align: center; box-shadow: 0 4px 0 rgba(0,0,0,.35), 0 8px 24px rgba(0,0,0,.4); }
    </style>
    <div class="caption"></div><div class="keys"></div>
    <div class="ptr"><svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 24 L7.5 18.6 L11.2 27.4 L14.6 26 L10.9 17.3 L18.6 17.3 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg></div>\`
    document.body.appendChild(root)
    const ptr = root.querySelector('.ptr')
    let at = { x: ${WIDTH / 2}, y: ${HEIGHT + 40} }
    const place = () => { ptr.style.transform = 'translate(' + at.x + 'px,' + at.y + 'px)' }
    place()
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    return {
        async move (x, y, ms = 600) {
            const from = { ...at }, start = performance.now()
            while (true) {
                const t = Math.min(1, (performance.now() - start) / ms), e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
                at = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e }
                place()
                if (t >= 1) break
                await new Promise(requestAnimationFrame)
            }
        },
        async press () { ptr.classList.add('down'); await sleep(110); ptr.classList.remove('down') },
        where () { return at },
        jump (x, y) { at = { x, y }; place() },
        caption (text) {
            const c = root.querySelector('.caption')
            if (text) { c.textContent = text; c.classList.add('shown') } else c.classList.remove('shown')
        },
        async keys (list) {
            const k = root.querySelector('.keys')
            k.innerHTML = list.map(s => '<kbd>' + s + '</kbd>').join('')
            k.classList.add('shown')
            await sleep(900)
            k.classList.remove('shown')
        },
        menu (items, x, y) {
            root.querySelector('.menu')?.remove()
            const m = document.createElement('div')
            m.className = 'menu'
            for (const i of items) {
                if (i.type === 'separator') { m.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); continue }
                const row = document.createElement('div')
                row.className = 'row' + (i.enabled === false ? ' head' : '')
                row.innerHTML = (i.checked ? '<span class="check">✓</span>' : '') + '<span></span>' + (i.submenu ? '<span class="sub">›</span>' : '')
                row.children[i.checked ? 1 : 0].textContent = i.label
                m.appendChild(row)
            }
            m.style.left = x + 'px'
            m.style.top = y + 'px'
            root.insertBefore(m, root.querySelector('.ptr'))
            return [...m.querySelectorAll('.row')].map(r => { const b = r.getBoundingClientRect(); return { x: b.x + 60, y: b.y + b.height / 2 } })
        },
        highlight (index) { root.querySelectorAll('.menu .row').forEach((r, i) => r.classList.toggle('on', i === index)) },
        closeMenu () { root.querySelector('.menu')?.remove() },
        remove () { root.remove() },
    }
})()`

await suite('demo', async t => {
    const { ev, check, sleep, c } = t
    const win = t.env.windows
    if (!win.account || !win.password || !win.winrm || !XRDP_USER || !XRDP_PASSWORD) {
        t.skip('demo', 'set TRD_TEST_WIN_* (WinRM included) and TRD_TEST_DEMO_XRDP_USER / _PASSWORD')
        return
    }
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    } catch {
        t.skip('demo', 'needs ffmpeg on this computer')
        return
    }
    const outDir = path.join(ROOT, 'docs', 'demo')
    fs.mkdirSync(outDir, { recursive: true })
    // The window at the video's size (in points; the recording is at device pixels, scaled to 1920 wide), so what
    // shows on screen while it runs is what gets recorded.
    const size = await ev(`const w = require('@electron/remote').getCurrentWindow(); H.bounds = w.getBounds(); w.setContentSize(${WIDTH}, ${HEIGHT}); await new Promise(r => setTimeout(r, 800)); return [innerWidth, innerHeight]`)
    t.onCleanup(() => ev(`require('@electron/remote').getCurrentWindow().setBounds(H.bounds)`))
    check(`window at ${WIDTH}×${HEIGHT}`, size[0] === WIDTH && size[1] === HEIGHT, size)
    await t.settings({ desk: true, sharpness: 'retina', resize: 'live', connectionStatus: false })
    // The look of a real Tabby (TRD_TEST_DEMO_LOOK): its terminal and appearance settings, color scheme included. Nested
    // settings take their fields one by one (Tabby's config doesn't replace a nested object). This Tabby's profile is
    // a temporary one, so nothing needs putting back.
    if (LOOK) {
        const applied = await ev(`const look = require('js-yaml').load(require('fs').readFileSync(${JSON.stringify(LOOK)}, 'utf8')) ?? {}
            const into = (store, from) => { for (const [k, v] of Object.entries(from ?? {})) {
                if (v && typeof v === 'object' && !Array.isArray(v) && store[k] && typeof store[k] === 'object') into(store[k], v); else store[k] = v } }
            into(H.config.store.terminal, look.terminal); into(H.config.store.appearance, look.appearance); H.config.save()
            return { scheme: H.config.store.terminal.colorScheme?.name, font: H.config.store.terminal.font, size: H.config.store.terminal.fontSize }`)
        check(`the look of ${path.basename(LOOK)}: ${JSON.stringify(applied)}`, !!applied)
    }
    await ev(`const r = H.config.store.remoteDesktop; H.before = { tip: r.tipShown, osd: JSON.stringify(r.osd), desktops: JSON.stringify(r.desktops ?? []) }
        r.tipShown = true; Object.assign(r.osd, { show: 'always', seconds: 1.6, position: 'top-right', font: 'condensed', size: 'medium', color: '' }); H.config.save()`)
    t.onCleanup(() => ev(`const r = H.config.store.remoteDesktop; r.tipShown = H.before.tip; Object.assign(r.osd, JSON.parse(H.before.osd)); r.desktops = JSON.parse(H.before.desktops); H.config.save()`))

    // ---- the cast ----
    check('lab-1 connected', await ev(`H.a = await H.openSSH({ name: 'lab-1' }); return !!H.a`))
    const run = command => t.remote('H.a', command)
    const gui = cmd => `W=$(systemctl --user show-environment | sed -n 's/^WAYLAND_DISPLAY=//p'); WAYLAND_DISPLAY=\${W:-wayland-0} setsid ${cmd} >/dev/null 2>&1 < /dev/null & sleep 2; echo ok`
    const [winHost, winPort] = win.address.split(':')
    await ev(`const r = H.config.store.remoteDesktop; r.desktops = [...(r.desktops ?? []),
        { name: 'win-11', via: 'lab-1', host: ${JSON.stringify(winHost)}, port: ${Number(winPort || 3389)}, kind: 'windows', username: ${JSON.stringify(win.account)} },
        { name: 'lab-3', via: 'lab-1', host: '127.0.0.1', port: ${t.env.xrdp.port}, kind: 'xrdp', username: ${JSON.stringify(XRDP_USER)} }]; H.config.save()`)
    // A clean Windows session (a new sign-in), and no picture left on its desktop from an earlier run.
    const { guest } = windowsGuest(t, 'H.a')
    const winDesktop = '[Environment]::GetFolderPath("Desktop")'
    await guest('$s = (quser 2>$null | Select-String "^\\s*>?\\s*' + win.account + '\\s") ; if ($s) { $id = ($s.Line -split "\\s+" | Where-Object { $_ -match "^\\d+$" })[0]; if ($id) { logoff $id } }; $d = ' + winDesktop + '; Remove-Item (Join-Path $d "paste-demo.png"), (Join-Path $d "Launch plan.pdf") -ErrorAction SilentlyContinue')
    // The xrdp account's session from an earlier run would make this one a second session for it, which ends at once
    // (a desktop runs once per user): it's for the demo only, so end everything it runs, before and after.
    const endXrdpSession = `sudo -n pkill -KILL -u ${XRDP_USER}; true`
    await run(`${endXrdpSession}; sudo -n systemctl start xrdp; sudo -n rm -f /var/crash/*; true`)
    t.onCleanup(() => run(`sudo -n systemctl stop xrdp; ${endXrdpSession}`))
    // Wallpapers: green for lab-1, purple for lab-2, orange for lab-3 (Windows keeps its blue).
    const setWall = (who, hue) => `f=/tmp/trd-demo-wall-${who}.svg; cat > "$f"; chmod 644 "$f"`
    await t.remote('H.a', setWall('a', 128), wallpaper(128))
    await t.remote('H.a', setWall('b', 272), wallpaper(272))
    await t.remote('H.a', setWall('c', 24), wallpaper(24))
    const gset = (uri) => `export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; for k in picture-uri picture-uri-dark; do gsettings get org.gnome.desktop.background $k; gsettings set org.gnome.desktop.background $k "file://${uri}"; done`
    const wallBefore = await run(gset('/tmp/trd-demo-wall-a.svg'))
    t.onCleanup(() => run(`export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; gsettings set org.gnome.desktop.background picture-uri ${wallBefore.split('\n')[0] || "''"}; gsettings set org.gnome.desktop.background picture-uri-dark ${wallBefore.split('\n')[1] || "''"}; true`))
    // The picture lands on each desktop: none there from an earlier run.
    const desktopDir = 'D=$(xdg-user-dir DESKTOP 2>/dev/null || echo ~/Desktop)'
    await run(`${desktopDir}; mkdir -p "$D"; rm -f "$D/paste-demo.png"; true`)
    // Nothing left open from an earlier run: Files windows, desk terminals.
    const tidy = `pkill -u "$(id -u)" -f '[t]rd-pty attach'; pkill -u "$(id -u)" -x nautilus; pkill -u "$(id -u)" -f '[g]nome-terminal-server'; true`
    await run(tidy)

    // The grid: lab-1 | win-11 over lab-2 | lab-3.
    await ev(`H.top = H.topOf(H.a); H.b = await H.inZone(() => H.top.splitTab(H.a, 'r')); H.opened.push(H.b)`)
    check('win-11 pane connected', !!(await t.waitFor('return H.b?.sshSession?.open ? true : null', 30)))
    check('lab-2 connected', await ev(`H.c = await H.openSSH({ name: 'lab-2', user: ${JSON.stringify(GNOME_USER)} }); return !!H.c`))
    await ev(`await H.inZone(() => H.top.add(H.topOf(H.c), H.a, 'b')); H.inZone(() => RD.app.selectTab(H.top))`)
    // lab-3 is behind lab-1: its pane is a lab-1 one, under win-11's.
    await ev(`H.d = await H.inZone(() => H.top.splitTab(H.b, 'b')); H.opened.push(H.d)`)
    check('lab-3 pane connected', !!(await t.waitFor('return H.d?.sshSession?.open ? true : null', 30)))
    await ev('H.inZone(() => { H.top.equalize(); H.top.layout() }); H.top.setTitle("demo"); H.top.customTitle = "demo"')
    for (const [pane, name] of [['H.a', 'lab-1'], ['H.b', 'lab-1'], ['H.c', 'lab-2'], ['H.d', 'lab-1']]) {
        await ev(`${pane}.customTitle = ${JSON.stringify(name)}; ${pane}.setTitle(${JSON.stringify(name)})`)
    }
    await t.remote('H.c', `${desktopDir}; mkdir -p "$D"; rm -f "$D/paste-demo.png"; ${tidy}`)

    // Every desktop connected, signed in (the forms are filled here, before the recording).
    const signIn = async (pane, user, password) => {
        const form = await t.waitFor(`return H.overlay(${pane})?.querySelector('.trd-signin form') ? true : (H.connected(${pane}) ? 'connected' : null)`, 40)
        if (form === true) {
            await ev(`const f = H.overlay(${pane}).querySelector('.trd-signin form'); f.querySelector('[name=username]').value = ${JSON.stringify(user)}
                f.querySelector('[name=password]').value = ${JSON.stringify(password)}; f.querySelector('[name=remember]').checked = false; f.requestSubmit()`)
        }
        return !!(await t.waitFor(`return H.connected(${pane})`, 60))
    }
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.a))')
    await ev(`await H.inZone(() => RD.desktop.showDesktop(H.b, ${JSON.stringify(`${winHost}:${winPort || 3389}`)}))`)
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.c))')
    // xrdp 0.9 can't scale its desktop, so device pixels would make it tiny: its own sharpness, set before it connects.
    await ev(`const key = (await RD.targets.targetOf(H.d)).key + '#127.0.0.1:${t.env.xrdp.port}'; const r = H.config.store.remoteDesktop
        r.desktopSharpness = [...(r.desktopSharpness ?? []).filter(e => e.desktop !== key), { desktop: key, sharpness: 'standard' }]; H.config.save()`)
    await ev(`await H.inZone(() => RD.desktop.showDesktop(H.d, '127.0.0.1:${t.env.xrdp.port}'))`)
    check('lab-1 desktop', !!(await t.waitFor('return H.connected(H.a)', 60)))
    check('win-11 desktop', await signIn('H.b', win.account, win.password))
    check('lab-2 desktop', !!(await t.waitFor('return H.connected(H.c)', 60)))
    check('lab-3 desktop (xrdp)', await signIn('H.d', XRDP_USER, XRDP_PASSWORD))
    await sleep(4000)
    // lab-2's wallpaper, now that its session is up; and a fresh GNOME session starts in the overview: close it.
    await t.remote('H.c', gset('/tmp/trd-demo-wall-b.svg'))
    const noOverview = 'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive "<false>" >/dev/null; true'
    await run(noOverview)
    await t.remote('H.c', noOverview)
    // GNOME's desktop icons (the paste lands there): started afresh, so they're on this connection's monitor rather
    // than one an earlier connection had.
    // GNOME's hot corner opens the overview when the pointer passes the top left corner: off while this runs.
    const hot = v => `export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; gsettings set org.gnome.desktop.interface enable-hot-corners ${v}; true`
    await run(hot('false'))
    await t.remote('H.c', hot('false'))
    t.onCleanup(() => run(hot('true')))
    t.onCleanup(() => t.remote('H.c', hot('true')))
    const icons = 'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus; gnome-extensions disable ding@rastersoft.com; sleep 1; gnome-extensions enable ding@rastersoft.com; true'
    await run(icons)
    await t.remote('H.c', icons)
    await sleep(2500)

    // lab-3's wallpaper (XFCE, in its xrdp session), and its desktop clear of the picture too.
    await t.remote('H.a', `U=${XRDP_USER}; sudo -n -u $U sh -c '${desktopDir.replace(/'/g, "'\\''")}; mkdir -p "$D"; rm -f "$D/paste-demo.png"'
        P=$(pgrep -u $U -x xfce4-session | head -n1); E=$(sudo -n cat /proc/$P/environ 2>/dev/null | tr '\\0' '\\n'); D=$(printf '%s\\n' "$E" | sed -n 's/^DISPLAY=//p'); B=$(printf '%s\\n' "$E" | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')
        sudo -n -u $U env DISPLAY=$D DBUS_SESSION_BUS_ADDRESS=$B sh -c 'for p in $(xfconf-query -c xfce4-desktop -l | grep last-image); do xfconf-query -c xfce4-desktop -p $p -s /tmp/trd-demo-wall-c.svg; done'; echo ok`)
    await sleep(3000)

    // A picture to paste, as Finder copies it: its thumbnail looks the same on every desktop (a document's icon doesn't).
    const here = await t.tempDir('trd-demo-')
    const pdf = path.join(here, 'paste-demo.png')
    fs.writeFileSync(pdf, Buffer.from(await ev(`const c = document.createElement('canvas'); c.width = 512; c.height = 512; const g = c.getContext('2d')
        const bg = g.createLinearGradient(0, 0, 512, 512); bg.addColorStop(0, '#ff7a59'); bg.addColorStop(.5, '#b04ce8'); bg.addColorStop(1, '#2f7cf6')
        g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, 512, 512, 96); g.fill()
        g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); g.roundRect(96, 150, 320, 212, 26); g.fill()
        g.fillStyle = '#2f7cf6'; g.beginPath(); g.roundRect(120, 174, 272, 164, 12); g.fill()
        g.fillStyle = 'rgba(255,255,255,.95)'; g.fillRect(222, 362, 68, 30); g.beginPath(); g.roundRect(176, 388, 160, 18, 9); g.fill()
        g.fillStyle = '#fff'; g.font = '700 64px -apple-system, system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('paste', 256, 276)
        return c.toDataURL('image/png').split(',')[1]`), 'base64'))
    await t.clipboard('demo')  // put back afterwards

    // The console lab-1 shows after the switch: a neutral prompt, a little state.
    await ev(`H.a.sendInput(${JSON.stringify(NEUTRAL('lab-1') + '\r')})`)
    await sleep(800)
    await ev(`H.a.sendInput(${JSON.stringify("echo 'this console, with its history, is about to go to the desktop'\r")})`)
    await sleep(800)

    // ---- the recording ----
    const frames = []
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-demo-frames-'))
    t.onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }))
    const off = c.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`)
        fs.writeFileSync(file, Buffer.from(data, 'base64'))
        frames.push({ file, at: metadata.timestamp })
        c.send('Page.screencastFrameAck', { sessionId }).catch(() => null)
    })
    await ev(`H.stage = ${STAGE}`)
    // Pane headers show the SSH connection (user@address:port, here the test tunnel's): shown as the demo's names.
    const real = [`${t.env.user}@${t.env.host}:${t.env.port}`, `${GNOME_USER}@${t.env.host}:${t.env.port}`]
    await ev(`const swap = ${JSON.stringify([[real[0], 'you@lab-1'], [real[1], 'you@lab-2']])}
        const fix = () => { const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
            for (let n; (n = walk.nextNode());) for (const [a, b] of swap) if (n.nodeValue.includes(a)) n.nodeValue = n.nodeValue.split(a).join(b) }
        fix(); H.renamer = new MutationObserver(fix); H.renamer.observe(document.body, { subtree: true, childList: true, characterData: true })`)
    t.onCleanup(() => ev('H.renamer?.disconnect()'))
    await c.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
    const S = expr => ev(`return await H.stage.${expr}`)
    // The pointer moves as a real one does: the drawn one and Tabby's (and so the remote desktops') together, eased.
    let pointer = { x: WIDTH / 2, y: HEIGHT + 40 }
    const glide = async (x, y, ms = 650) => {
        const from = { ...pointer }
        const steps = Math.max(8, Math.round(ms / 16))
        for (let i = 1; i <= steps; i++) {
            const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
            pointer = { x: Math.round(from.x + (x - from.x) * e), y: Math.round(from.y + (y - from.y) * e) }
            await ev(`H.stage.jump(${pointer.x}, ${pointer.y})`)
            if (pointer.y < HEIGHT) {
                await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x, y: pointer.y, button: 'none' })
            }
            await sleep(12)
        }
    }
    const centerOf = pane => ev(`const r = ${pane}.element.nativeElement.getBoundingClientRect(); return { x: Math.round(r.x + r.width * .62), y: Math.round(r.y + r.height * .55) }`)
    const click = async (pane, dx = 0, dy = 0) => {
        const p = await centerOf(pane)
        await glide(p.x + dx, p.y + dy, 650)
        await S('press()')
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x + dx, y: p.y + dy, button: 'left', clickCount: 1 })
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + dx, y: p.y + dy, button: 'left', clickCount: 1 })
    }

    // 1. Four desktops in one tab; each says which it is when clicked into.
    await S('caption("Four desktops in one Tabby tab: GNOME, Windows, xrdp")')
    await sleep(900)
    for (const pane of ['H.a', 'H.b', 'H.c', 'H.d']) {
        await click(pane, 0, 60)
        await sleep(900)
    }
    await sleep(600)

    // 2. A file copied in Finder, pasted to all four. (GNOME's overview, if a click opened it, would take the paste.)
    await run(noOverview)
    await t.remote('H.c', noOverview)
    await S('caption("A file copied on the Mac… pasted to all of them at once")')
    const at = await centerOf('H.a')
    await glide(at.x - 120, at.y - 40, 700)
    await S('press()')
    const items = await ev('return (await H.menu(H.a)).map(i => ({ label: i.label, type: i.type, enabled: i.enabled, checked: i.checked, submenu: !!i.submenu }))')
    const rows = await S(`menu(${JSON.stringify(items)}, ${at.x - 116}, ${at.y - 30})`)
    const target = items.filter(i => i.type !== 'separator').findIndex(i => /^Paste to all/.test(i.label))
    check('the menu offers "Paste to all"', target >= 0, items.map(i => i.label))
    for (let i = 1; i <= target; i++) {
        await S(`highlight(${i})`)
        if (i === target) await glide(rows[i].x, rows[i].y, 380)
        await sleep(i === target ? 350 : 45)
    }
    await S('press()')
    await S('closeMenu()')
    // Copied now, as one does right before pasting (the desktops' clipboards come to this one as they connect).
    const writer = spawn('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); var pb = $.NSPasteboard.generalPasteboard; pb.clearContents; pb.writeObjects($([$.NSURL.fileURLWithPath(${JSON.stringify(pdf)})])); delay(120); ''`], { stdio: 'ignore' })
    t.onCleanup(() => writer.kill())
    await sleep(700)
    await ev('H.inZone(() => RD.desktop.pasteToAll(H.a))')
    await sleep(3200)
    // The README's poster: a JPEG at the video's size (desktops are photos more than drawings; a PNG would be 1.6 MB).
    const { data: poster } = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1920 / WIDTH } })
    fs.writeFileSync(path.join(ROOT, 'docs', 'images', 'demo.jpg'), Buffer.from(poster, 'base64'))
    await sleep(900)

    // 3. The desktop/console switch.
    await S('caption("⌘⇧G switches a pane between its desktop and its console")')
    await click('H.a', -80, 40)
    await sleep(500)
    await S('keys(["⌘", "⇧", "G"])')
    await t.key('G', 'KeyG', 71, ['Meta', 'Shift'])
    await sleep(1800)

    // 4. desk: that console onto the desktop, the same shell on both sides.
    await S('caption("desk puts that same shell on the desktop, history and all")')
    await ev(`H.a.sendInput('desk\\r')`)
    check('desk: the console on the desktop', !!(await t.waitFor(`return RD.desktop.logOf(H.a).some(l => /desk: opened/.test(l))`, 15)))
    await sleep(2600)
    await click('H.a', 0, 0)
    await sleep(300)
    await t.type("echo typed on the desktop")
    await t.enter()
    await sleep(1400)
    await S('caption("…and it is still the console: switch back and it is all there")')
    await S('keys(["⌘", "⇧", "G"])')
    await t.key('G', 'KeyG', 71, ['Meta', 'Shift'])
    await sleep(2600)
    await S('caption("tabby-rdp: remote desktops in Tabby, through SSH")')
    await sleep(2200)
    await S('caption(null)')
    await sleep(500)

    await c.send('Page.stopScreencast')
    off()
    // Checked after the recording, so waiting for a slow one doesn't lengthen the video.
    const lists = () => Promise.all([
        run(`${desktopDir}; ls "$D"`), t.remote('H.c', `${desktopDir}; ls "$D"`), run(`sudo -n -u ${XRDP_USER} sh -c '${desktopDir.replace(/'/g, "'\\''")}; ls "$D"'`),
        guest('Get-ChildItem (' + winDesktop + ') | ForEach-Object Name'),
    ])
    let pasted = await lists()
    for (let i = 0; i < 6 && !pasted.every(l => l.includes('paste-demo.png')); i++) {
        await sleep(1000)
        pasted = await lists()
    }
    check('pasted on all four', pasted.every(l => l.includes('paste-demo.png')), pasted)
    if (!pasted.every(l => l.includes('paste-demo.png'))) {
        for (const pane of ['H.a', 'H.b', 'H.c', 'H.d']) {
            console.log(pane, JSON.stringify(await ev(`return RD.desktop.logOf(${pane}).slice(-6)`)))
        }
    }

    await ev('H.stage.remove()')
    check('frames recorded', frames.length > 50, frames.length)

    // ---- the video: each frame for as long as it was on screen, at a constant frame rate ----
    const list = path.join(dir, 'frames.txt')
    fs.writeFileSync(list, frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.at ?? f.at + 0.5) - f.at).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`)
    const out = path.join(outDir, 'tabby-rdp-demo.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-movflags', '+faststart', out])
    const seconds = frames.at(-1).at - frames[0].at
    console.log(`wrote docs/demo/tabby-rdp-demo.mp4 (${seconds.toFixed(1)} s, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB) and docs/images/demo.jpg`)
    check('video written', fs.statSync(out).size > 100000)
})
