// Makes the README screenshots (docs/images) from a Linux desktop host (TRD_TEST_HOST): `npm test -- screenshots`.
// Prompts and titles are set to neutral values, so the host's name and account don't show.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from '../lib/harness.mjs'

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
    // The SSH toolbar shows user@host: show the demo name there instead.
    const neutralize = keepToasts => ev(`const real = ${JSON.stringify(`${t.env.user}@${t.env.host}`)}
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let n; (n = walk.nextNode());) if (n.nodeValue.includes(real)) n.nodeValue = n.nodeValue.split(real).join('you@ubuntu')
        if (!${!!keepToasts}) document.querySelectorAll('.trd-toast').forEach(el => el.remove())`)
    // Moves the pointer out of the way (no tooltips in the picture).
    const parkPointer = () => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: WIDTH - 40, y: HEIGHT - 40, button: 'none' })
    const shot = async (name, keepToasts = false) => {
        await parkPointer()
        await sleep(1200)
        await neutralize(keepToasts)
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
})
