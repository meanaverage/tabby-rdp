// Makes the README screenshots (docs/images) from a Linux desktop host (TRD_TEST_HOST), and with TRD_TEST_WIN_*
// (WinRM included) the Windows one: `npm test -- screenshots`. Prompts and titles are set to neutral values, so the
// hosts' names and accounts don't show.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from '../lib/harness.mjs'
import { windowsGuest } from '../lib/windows.mjs'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'images')
const WIDTH = 1280
const HEIGHT = 800
const DEMO = '/tmp/tabby-rdp-demo'
// A neutral prompt and title, a clean screen.
const NEUTRAL = `export PS1='you@ubuntu:\\w$ '; unset PROMPT_COMMAND; printf '\\033]0;ubuntu\\007'; cd ~; clear`

await suite('screenshots', async t => {
    const { ev, check, sleep, c } = t
    fs.mkdirSync(OUT, { recursive: true })
    await c.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 0, mobile: false })
    t.onCleanup(() => c.send('Emulation.clearDeviceMetricsOverride'))
    // The SSH toolbar shows user@host: show a demo name there instead.
    const neutralize = (keepToasts, real, shown) => ev(`const real = ${JSON.stringify(real)}
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let n; (n = walk.nextNode());) if (n.nodeValue.includes(real)) n.nodeValue = n.nodeValue.split(real).join(${JSON.stringify(shown)})
        if (!${!!keepToasts}) document.querySelectorAll('.trd-toast').forEach(el => el.remove())`)
    // Moves the pointer out of the way (no tooltips in the picture).
    let pointerAt = { x: WIDTH - 40, y: HEIGHT - 40 }
    const parkPointer = () => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointerAt, button: 'none' })
    const shot = async (name, keepToasts = false, real = `${t.env.user}@${t.env.host}`, shown = 'you@ubuntu') => {
        await parkPointer()
        await sleep(1200)
        await neutralize(keepToasts, real, shown)
        const { data } = await c.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
        console.log(`wrote docs/images/${name}.png`)
    }
    const run = (pane, command) => t.remote(pane, command)
    const gui = cmd => `W=$(systemctl --user show-environment | sed -n 's/^WAYLAND_DISPLAY=//p'); WAYLAND_DISPLAY=\${W:-wayland-0} setsid ${cmd} >/dev/null 2>&1 < /dev/null & sleep 3; echo ok`
    await t.settings({ desk: true, sharpness: 'retina', resize: 'live' })

    // Demo files, and nothing left open on the desktop from earlier.
    check('SSH tab connected', await ev(`H.pane = await H.openSSH({ name: 'ubuntu' }); return !!H.pane`))
    await run('H.pane', `pkill -u "$(id -u)" -f '[t]rd-pty attach'; rm -rf ${DEMO}; mkdir -p ${DEMO}/photos ${DEMO}/src && cd ${DEMO} && printf '# Notes\\n' > notes.md && printf 'Quarterly report\\n' > report.txt && printf 'month,total\\njan,12\\n' > data.csv && : > slides.pdf && printf 'print(1)\\n' > src/main.py && printf '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" rx="14" fill="#2f6fde"/><circle cx="58" cy="60" r="28" fill="#ffffff"/><rect x="96" y="36" width="44" height="48" rx="8" fill="#9cc2ff"/></svg>' > diagram.svg; true`)
    t.onCleanup(() => run('H.pane', `rm -rf ${DEMO}; pkill -u "$(id -u)" -f '[t]rd-pty attach'; true`))
    await ev(`H.pane.sendInput(${JSON.stringify(NEUTRAL + '\r')})`)
    await sleep(1000)

    // 1. The desktop in the SSH tab, with Files open.
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    await run('H.pane', gui(`nautilus --new-window ${DEMO}`))
    await sleep(2500)
    await shot('desktop')

    // 2. File transfer: copy a file on the remote; the bar offers to save it.
    await t.clickDesktop('H.pane', 348, 160)
    await t.press('c', ['Control'])
    check('files offered', !!(await t.waitFor('return (H.session(H.pane)?.files?.offered ?? []).length > 0', 10)))
    await shot('files', true)
    await t.press('w', ['Control'])  // close Files
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 3. desk: a console with some state, then `desk`: the same shell in a terminal on the desktop.
    check('second SSH tab connected', await ev(`H.console = await H.openSSH({ name: 'ubuntu' }); return !!H.console`))
    await sleep(2500)
    await ev(`H.console.sendInput(${JSON.stringify(NEUTRAL + '\r')})`)
    await sleep(800)
    await ev(`H.console.sendInput(${JSON.stringify(`cd ${DEMO} && ls -1 && echo 'this shell moves to the desktop with: desk'\r`)})`)
    await sleep(1500)
    await shot('console')
    await ev(`H.console.sendInput('desk\\r')`)
    check('desk: the console on the desktop', !!(await t.waitFor(`return RD.desktop.logOf(H.console).some(l => /desk: opened/.test(l))`, 15)))
    await sleep(3000)
    await shot('desk')

    // 4. A Windows desktop behind a host (with TRD_TEST_WIN_*, WinRM included): Explorer on some files, maximized.
    const win = t.env.windows
    if (!win.account || !win.password || !win.winrm) {
        t.skip('windows', 'set TRD_TEST_WIN_USER, TRD_TEST_WIN_PASSWORD and TRD_TEST_WIN_WINRM')
        return
    }
    const [winHost, winPort] = [win.address.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(win.address)?.[1] ?? 3389)]
    const id = `${winHost}:${winPort}`
    const desktops = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${desktops}; H.config.save() })`))
    // Only this tab in the picture (the Linux demo cleaned up first, through its tab), and the default sharpness:
    // Windows keeps its own scale (100%), which is tiny at device pixels.
    await run('H.pane', `rm -rf ${DEMO}; pkill -u "$(id -u)" -f '[t]rd-pty attach'; true`)
    await ev('for (const tab of [...RD.app.tabs]) await H.inZone(() => RD.app.closeTab(tab, false))')
    await t.settings({ sharpness: 'standard' })
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = [{ name: 'Windows', via: ${JSON.stringify(win.host)}, host: ${JSON.stringify(winHost)}, port: ${winPort}, kind: 'windows', username: ${JSON.stringify(win.account)} }]; H.config.save() })`)
    check('SSH tab to the Windows host connected', await ev(`H.win = await H.openSSH({ host: ${JSON.stringify(win.host)}, user: ${JSON.stringify(win.user)}, name: 'buildhost' }); return !!H.win`))
    const { guest, inSession, dropTask } = windowsGuest(t, 'H.win')
    const folder = (await guest('$env:USERPROFILE')).trim() + '\\Documents\\Projects'
    await guest(`$d = '${folder}'; New-Item -ItemType Directory -Force "$d\\photos", "$d\\src" | Out-Null
        Set-Content "$d\\notes.md" '# Notes'; Set-Content "$d\\report.txt" 'Quarterly report'; Set-Content "$d\\data.csv" "month,total\`njan,12"
        Set-Content "$d\\src\\main.py" 'print(1)'; New-Item -Force "$d\\slides.pdf" | Out-Null`)
    t.onCleanup(() => guest(`Remove-Item -Recurse -Force '${folder}' -ErrorAction SilentlyContinue`))
    await ev(`H.inZone(() => RD.desktop.showDesktop(H.win, ${JSON.stringify(id)}))`)
    check('Windows sign-in form', !!(await t.waitFor(`return !!H.overlay(H.win)?.querySelector('.trd-signin form')`, 20)))
    await ev(`const f = H.overlay(H.win).querySelector('.trd-signin form'); f.querySelector('[name=remember]').checked = false
        f.querySelector('[name=password]').value = ${JSON.stringify(win.password)}; f.requestSubmit()`)
    check('Windows desktop connected', !!(await t.waitFor('return H.connected(H.win)', 40)))
    t.onCleanup(() => ev('H.inZone(() => RD.desktop.disconnect(H.win))'))
    await sleep(8000)  // the first sign-in of a session: let Explorer and the taskbar settle
    // Explorer on the folder, maximized and in front (the picture is the window, not the desktop behind it).
    await inSession('trd-shot-explorer', `
$shell = New-Object -ComObject Shell.Application
$shell.Open('${folder}')
Add-Type -Namespace Trd -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr w, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);'
foreach ($i in 1..20) {
    $window = $shell.Windows() | Where-Object { $_.LocationURL -like '*/Projects' } | Select-Object -First 1
    if ($window) { [Trd.Win]::ShowWindow([IntPtr]$window.HWND, 3) | Out-Null; [Trd.Win]::SetForegroundWindow([IntPtr]$window.HWND) | Out-Null; break }
    Start-Sleep -Milliseconds 500
}`)
    t.onCleanup(() => inSession('trd-shot-close', `(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationURL -like '*/Projects' } | ForEach-Object { $_.Quit() }`)
        .then(() => sleep(2000)).then(() => dropTask('trd-shot-close')))
    await sleep(8000)
    await dropTask('trd-shot-explorer')
    pointerAt = { x: WIDTH - 200, y: HEIGHT / 2 }  // an empty part of the window: Windows' clock is in the corner
    await shot('windows', false, `${win.user}@${win.host}`, 'you@buildhost')
})
