// The clipboard between this machine and a Linux desktop (TRD_TEST_HOST), through the terminal `desk` opens there:
// here → remote by pasting a command in that terminal (Ctrl+Shift+V) and seeing it run in the console; remote →
// here by selecting a line there (triple click), copying it (Ctrl+Shift+C) and reading the local clipboard (put back
// afterwards). Then view only: no clipboard either way, the desktop's read and set from its console (xclip, or
// wl-clipboard, on the test host), so that no key goes to it.
import { suite } from '../lib/harness.js'

await suite('clipboard', async t => {
    const { ev, check, sleep } = t
    await t.settings({ desk: true })
    await t.clipboard()

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    t.onCleanup(() => t.remote('H.pane', `pkill -u "$(id -u)" -f '[t]rd-pty attach'; true`))
    await t.deskReady('H.pane')
    await sleep(2500)
    await ev(`H.pane.sendInput('desk\\r')`)
    check('desk: the desktop, with the console in a terminal', !!(await t.waitFor(`return RD.desktop.logOf(H.pane).some(l => /desk: opened/.test(l))`, 10, 100)))
    await sleep(1500)
    await t.clickDesktop('H.pane')

    // 1. Here → remote: copy a command, paste it in the desktop terminal, run it.
    const inMarker = `clipin${Date.now() % 100000}`
    await t.clipboard(`echo ${inMarker}-$((6*7))`)
    await sleep(600)  // the component notices clipboard changes by polling (100 ms) and announces them
    const t0 = Date.now()
    await t.press('v', ['Control', 'Shift'])
    await sleep(500)
    await t.enter()
    const pasted = await t.waitFor(`return H.screen(H.pane).includes('${inMarker}-42')`, 6)
    t.time('copy here → pasted on the desktop', Date.now() - t0)
    check('here → remote: the pasted command ran in the console', !!pasted)

    // 2. Remote → here: print a marker, select its line in the terminal (maximized, just below the top bar), copy.
    const outMarker = `clipout${Date.now() % 100000}`
    await ev(`H.pane.sendInput('clear; echo ${outMarker}-$((6*7))\\r')`)
    await sleep(800)
    await t.clipboard('placeholder')
    await sleep(300)
    const t1 = Date.now()
    const box = await ev<{ w: number, h: number }>('const c = H.canvas(H.pane); return { w: c.cssW, h: c.cssH }')
    await t.clickDesktop('H.pane', box.w / 2, 90 * box.h / 562, 3)
    await t.dump('H.pane', 'clipboard-selected')
    await t.press('c', ['Control', 'Shift'])
    let got = ''
    for (let i = 0; i < 30 && !got.includes(`${outMarker}-42`); i++) {
        await sleep(200)
        got = await t.clipboard()
    }
    t.time('copy on the desktop → here', Date.now() - t1)
    check('remote → here: the copied terminal text is on the clipboard', got.includes(`${outMarker}-42`), got.slice(0, 120))

    // 3. View only. The desktop's clipboard is read and set from the console, typed into the SSH session, which no
    // key goes through: rcb prints it between brackets, wcb sets it.
    await ev(`H.pane.sendInput('export XDG_RUNTIME_DIR=/run/user/$(id -u) DISPLAY=:0; export WAYLAND_DISPLAY=$(ls $XDG_RUNTIME_DIR | grep -m1 "^wayland-[0-9]*$"); ' +
        'rcb () { echo "R[$(timeout 3 xclip -selection clipboard -o 2>/dev/null || timeout 3 wl-paste -n 2>/dev/null)]"; }; ' +
        'wcb () { printf %s "$1" | timeout 3 xclip -selection clipboard -i 2>/dev/null || printf %s "$1" | timeout 3 wl-copy; }\\r')`)
    const remoteClipboard = async () => {
        await ev(`H.pane.sendInput('clear; rcb\\r')`)
        await sleep(1500)
        return /R\[([^\]]*)\]/.exec(await ev<string>('return H.screen(H.pane)'))?.[1] ?? null
    }
    const probe = `voprobe${Date.now() % 100000}`
    await t.clipboard(probe)
    await sleep(800)
    const reads = await remoteClipboard() === probe
    check('view only: the console reads the desktop\'s clipboard (what was copied here)', reads)
    if (reads) {
        // What was offered from here is withdrawn as view only comes on (the desktop is sent an empty clipboard: see
        // the unit tests), but not checked here: GNOME's compositor fetches text the moment it is offered and keeps it.
        await ev('H.inZone(() => RD.desktop.setViewOnly(H.pane, true))')
        await sleep(800)
        const during = `voduring${Date.now() % 100000}`
        await t.clipboard(during)
        await sleep(800)
        const reached = await remoteClipboard()
        check('view only: what is copied here doesn\'t reach the desktop', reached !== during, reached)
        const there = `vothere${Date.now() % 100000}`
        await ev(`H.pane.sendInput('clear; wcb ${there}\\r')`)
        await sleep(1500)
        check('view only: what is copied there doesn\'t come here', await t.clipboard() === during, await t.clipboard())
        await ev('H.inZone(() => RD.desktop.setViewOnly(H.pane, false))')
        await t.clickDesktop('H.pane')
        await sleep(1500)
        check('view only off: what was copied there meanwhile isn\'t written here afterwards', await t.clipboard() === during)
        check('view only off: what is copied here goes to the desktop again', await remoteClipboard() === during)
        check('view only: the log says so', await ev<boolean>('return RD.desktop.logOf(H.pane).includes("view only: on") && !RD.desktop.logOf(H.pane).some(l => /not paused for view only/.test(l))'))
    }
})
