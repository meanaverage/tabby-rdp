// The connection-status indicator, on a Linux desktop host (TRD_TEST_HOST): off by default, toggled from the settings
// menu and kept in the config; throughput, frames per second, SSH round trip and the connection path; runs only
// while the desktop shows; fades when the pointer comes near.
import { suite } from '../lib/harness.mjs'

await suite('status', async t => {
    const { ev, check, sleep } = t
    const host = t.env.host
    await ev(`Object.assign(H, {
        stats () { return H.overlay(H.pane)?.querySelector('.trd-stats') ?? null },
        statsText () { const s = H.stats(); return s ? { numbers: s.querySelector('.trd-stats-numbers').textContent, path: s.querySelector('.trd-stats-path').textContent } : null },
        async statusItem () { return (await H.menu(H.pane)).find(i => i.label === 'Settings').submenu.find(i => /connection status/i.test(i.label ?? '')) },
    })`)
    // As a fresh profile has it; the previous value comes back at the end.
    await t.settings({ connectionStatus: false, sharpness: 'standard', desk: true })

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    await sleep(1500)
    check('off by default: no indicator', await ev('return !H.stats()'))
    const item = await ev('const i = await H.statusItem(); return i && { type: i.type, checked: i.checked }')
    check('the settings menu has an unchecked "connection status" checkbox', item?.type === 'checkbox' && item.checked === false, item)

    // Turn it on from the menu.
    await ev('const i = await H.statusItem(); H.inZone(() => i.click())')
    check('saved in the config', await ev('return H.config.store.remoteDesktop.connectionStatus === true'))
    check('the indicator shows', !!(await t.waitFor('return !!H.stats()', 3)))
    check('the menu item is checked now', await ev('return (await H.statusItem()).checked === true'))

    // Numbers: throughput and fps after a tick, the SSH round trip within a few seconds.
    const numbers = await t.waitFor(`const s = H.statsText(); return s && /↓ [\\d.]+ [kM]?B\\/s  ↑ [\\d.]+ [kM]?B\\/s  \\d+ fps/.test(s.numbers) && /ping [\\d.]+ ms/.test(s.numbers) ? s.numbers : null`, 8)
    check('throughput in and out, fps and ping', !!numbers, await ev('return H.statsText()'))
    const stats = await ev('return { ...H.session(H.pane).proxy.stats }')
    check('the proxy counted bytes both ways', stats.bytesIn > 10000 && stats.bytesOut > 100, stats)
    const path = (await ev('return H.statsText()?.path')) ?? ''
    check('the path names the desktop, resolution, graphics mode and sharpness', path.includes(`${host} desktop`) && /\d+×\d+/.test(path) && path.includes('graphics pipeline') && path.includes('Standard'), path)

    // Frames: opening and closing the overview redraws the screen. GNOME Shell turns its animations off while a
    // remote desktop session is active, so each change is a single frame: several changes.
    const before = await ev('return H.session(H.pane).indicator.frames')
    await t.clickDesktop('H.pane')
    for (let i = 0; i < 6; i++) {
        await t.tap('Meta')  // Super (on macOS a ⌘ tap, with Mac shortcuts on): the overview, then back
        await sleep(700)
    }
    const after = await ev('return H.session(H.pane).indicator.frames')
    check('screen updates are counted as frames', after - before >= 4, { before, after })
    const fps = await t.waitFor(`return Number(/(\\d+) fps/.exec(H.statsText()?.numbers ?? '')?.[1] ?? -1) >= 0`, 3)
    check('fps shown as a number', !!fps)

    // Fades while the pointer is near it, and comes back.
    const r = await ev('const r = H.stats().getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }')
    await t.c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' })
    check('fades when the pointer comes near', !!(await t.waitFor('return H.stats().classList.contains("trd-stats-away")', 2)))
    await t.clickDesktop('H.pane')
    check('back when it leaves', !!(await t.waitFor('return !H.stats().classList.contains("trd-stats-away")', 2)))

    // Only while the desktop shows: the console stops it, the desktop brings it back.
    await ev('H.inZone(() => RD.desktop.showConsole(H.pane))')
    await sleep(300)
    check('console: indicator removed and its timer stopped', await ev('return !H.stats() && H.session(H.pane).indicator.timer === null'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop again: indicator back', !!(await t.waitFor('return !!H.stats() && H.session(H.pane).indicator.timer !== null', 3)))

    // Sharpness shows as it changes.
    await t.settings({ sharpness: 'retina' })
    check('the path follows the sharpness', !!(await t.waitFor('return /Retina/.test(H.statsText()?.path ?? "")', 4)))
    await t.settings({ sharpness: 'standard' })

    // Off again from the menu.
    await ev('const i = await H.statusItem(); H.inZone(() => i.click())')
    await sleep(300)
    check('off: indicator removed, saved', await ev('return !H.stats() && H.config.store.remoteDesktop.connectionStatus === false && H.session(H.pane).indicator.timer === null'))
})
