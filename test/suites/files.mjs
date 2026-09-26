// Files through the clipboard, on a Linux desktop host (TRD_TEST_HOST) with Files (Nautilus):
// - remote → here: a file selected and copied in Files is offered; saving writes it (into a temporary folder here);
// - here → remote: a file dropped on the desktop is offered on the remote clipboard; Ctrl+V in Files copies it
//   there, content intact, and nothing lands in the console under the desktop.
import { suite } from '../lib/harness.mjs'

await suite('files', async t => {
    const { ev, check, sleep } = t
    await t.settings({ desk: true })
    const DIR = `/tmp/trd-files-${Date.now() % 100000}`
    const openFolder = `W=$(systemctl --user show-environment | sed -n 's/^WAYLAND_DISPLAY=//p'); WAYLAND_DISPLAY=\${W:-wayland-0} setsid nautilus --new-window ${DIR} >/dev/null 2>&1 < /dev/null & sleep 3; echo ok`
    const here = await t.tempDir('trd-files-')

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    t.onCleanup(() => t.remote('H.pane', `rm -rf ${DIR}`))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    check('file transfer set up', await ev('return !!H.session(H.pane)?.files'))
    await t.remote('H.pane', `mkdir -p ${DIR} && printf 'made on the remote\\n' > ${DIR}/from-remote.txt`)
    await ev(`H.pane.sendInput('clear\\r')`)

    // A Files window on that folder (maximized; its first icon a fixed distance from the corner).
    await t.remote('H.pane', openFolder)
    await sleep(1500)
    t.onCleanup(() => t.press('w', ['Control']))  // closes the Files window

    // 1. Remote → here: select the file, copy, save what the remote offers.
    await t.clickDesktop('H.pane', 348, 160)
    await sleep(300)
    await t.dump('H.pane', 'files-selected')
    await t.press('c', ['Control'])
    const offered = await t.waitFor(`const f = H.session(H.pane)?.files?.offered ?? []; return f.length ? f.map(x => x.name).sort() : null`, 15)
    check('remote → here: the copied file is offered', offered?.includes('from-remote.txt'), offered)
    check('with "Save to Downloads"', /copied on the remote/.test(await ev('return H.toast(H.pane)')) && await ev(`return !![...H.overlay(H.pane).querySelectorAll('.trd-toast button')].find(b => b.textContent === 'Save to Downloads')`))
    const t0 = Date.now()
    const saved = await ev(`return await H.session(H.pane).files.saveAll(${JSON.stringify(here)})`)
    t.time('save → file here', Date.now() - t0)
    const got = saved?.find(p => p.endsWith('from-remote.txt'))
    check('saved here, same content', !!got && await t.readFile(got) === 'made on the remote\n', saved)

    // 2. Here → remote: drop a file on the desktop, paste in the Files window.
    const content = `made here ${Date.now()}\n`
    await ev(`const overlay = H.overlay(H.pane); const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(content)}], 'from-here.txt', { type: 'text/plain' }))
        overlay.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); overlay.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))`)
    check('drop: offered, with a "paste on the remote" note', !!(await t.waitFor(`return /ready: paste/.test(H.toast(H.pane))`, 10)), await ev('return H.toast(H.pane)'))
    check('drop: nothing typed into the console under the desktop', !(await ev('return H.screen(H.pane)')).includes('from-here.txt'))
    const t1 = Date.now()
    await t.press('v', ['Control'])
    let arrived = ''
    for (let i = 0; i < 30 && arrived !== content; i++) {
        await sleep(500)
        arrived = await t.remote('H.pane', `cat ${DIR}/from-here.txt 2>/dev/null`)
    }
    t.time('paste → file on the remote', Date.now() - t1)
    check('here → remote: pasted in Files, same content', arrived === content, arrived)
})
