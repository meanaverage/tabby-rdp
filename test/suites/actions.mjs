// The desktop's actions and keyboard extras, on a Linux desktop host (TRD_TEST_HOST):
// - the menus offer Send keys (GNOME's set), View only and Save a screenshot for a connected desktop;
// - Send keys: Super opens and closes the Activities overview (GNOME Shell's OverviewActive), also from the console;
// - ⌃⌘ with a key is Super with it (macOS, Mac shortcuts on): ⌃⌘A opens the app grid; a ⌘ tap is still Super;
// - View only: the label shows, the layer takes the mouse, keys don't reach the remote, Send keys is off; it stays
//   on across a reconnect, and once off, keys go through again;
// - Save a screenshot: a PNG in Downloads at the remote resolution, a second one next to it, the image on the
//   clipboard (the clipboard's text is put back afterwards);
// - Keep the resolution at actual size: 1:1 with scroll bars in a smaller pane; scale to fit shrinks it again.
import { suite } from '../lib/harness.mjs'

await suite('actions', async t => {
    const { ev, check, sleep } = t
    const MAC = t.platform === 'darwin'
    await t.settings({ resize: 'live', sharpness: 'standard', macShortcuts: true, zoom: 'fit' })
    await t.clipboard()

    const shell = method => `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.freedesktop.DBus.Properties.${method}`
    const overview = async () => /true/.test(await t.remote('H.pane', `${shell('Get')} org.gnome.Shell OverviewActive`))
    const setOverview = on => t.remote('H.pane', `${shell('Set')} org.gnome.Shell OverviewActive '<${on}>'`)
    const waitOverview = async (on, seconds = 5) => {
        for (let i = 0; i < seconds * 4; i++) {
            if (await overview() === on) return true
            await sleep(250)
        }
        return false
    }
    // The pane's menu (terminal context menu), and clicking an item in it or in one of its submenus.
    const menu = () => ev('return (await H.menu(H.pane)).map(i => ({ label: i.label, type: i.type, checked: i.checked, enabled: i.enabled, submenu: i.submenu?.map(s => s.label) }))')
    const click = (label, sub) => ev(`const item = (await H.menu(H.pane)).find(i => i.label === ${JSON.stringify(label)})
        const target = ${sub ? `item?.submenu?.find(s => s.label === ${JSON.stringify(sub)})` : 'item'}
        if (!target) return false
        await H.inZone(() => target.click())
        return true`)
    const SEND = 'Send keys'
    const VIEW_ONLY = 'View only (no keyboard or mouse input)'
    const SCREENSHOT = 'Save a screenshot (to Downloads and the clipboard)'

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    t.onCleanup(() => setOverview(false))
    await sleep(2000)
    await setOverview(false)

    // 1. The menus.
    const items = await menu()
    const send = items.find(i => i.label === SEND)
    check('menu: Send keys, with GNOME\'s keys', !!send && send.submenu.includes('Super (Activities)') && !send.submenu.includes('Ctrl+Alt+Del'), send)
    check('menu: View only, off', items.some(i => i.label === VIEW_ONLY && i.type === 'checkbox' && !i.checked))
    check('menu: Save a screenshot', items.some(i => i.label === SCREENSHOT))

    // 2. Send keys, from the console: the desktop comes back and gets the key.
    await ev('H.inZone(() => RD.desktop.showConsole(H.pane))')
    await sleep(300)
    await click(SEND, 'Super (Activities)')
    check('Send keys › Super: the desktop shows again', !!(await t.waitFor('return RD.desktop.isVisible(H.pane)', 3)))
    check('Send keys › Super: the Activities overview opens', await waitOverview(true), await ev('return RD.desktop.logOf(H.pane).filter(l => /keys:/.test(l))'))
    await click(SEND, 'Super (Activities)')
    check('Send keys › Super again: the overview closes', await waitOverview(false))

    // 3. ⌃⌘+key as Super+key, and the ⌘ tap as Super (unchanged).
    if (MAC) {
        await t.clickDesktop('H.pane')
        await t.press('a', ['Control', 'Meta'])
        check('⌃⌘A: Super+A opens the app grid (overview)', await waitOverview(true))
        await setOverview(false)
        await waitOverview(false)
        await t.tap('Meta')
        check('a ⌘ tap is still Super', await waitOverview(true))
        await setOverview(false)
        await waitOverview(false)
    } else {
        t.skip('⌃⌘ for the Windows key', 'macOS only')
    }

    // 4. View only.
    await click(VIEW_ONLY)
    const layer = await ev(`const o = H.overlay(H.pane), shield = o.querySelector('.trd-view-only'), cv = H.canvasElement(H.pane).getBoundingClientRect()
        return { on: o.classList.contains('trd-view-only-on'), display: getComputedStyle(shield).display, label: getComputedStyle(shield, '::after').content,
            onTop: document.elementFromPoint(cv.x + cv.width / 2, cv.y + cv.height / 2) === shield }`)
    check('view only: the "View only" label shows', layer.on && layer.display === 'block' && /View only/.test(layer.label), layer)
    check('view only: the layer takes the mouse', layer.onTop, layer)
    check('view only: Send keys is disabled', (await menu()).find(i => i.label === SEND)?.enabled === false)
    await t.clickDesktop('H.pane')
    await t.tap('Meta')
    await sleep(1500)
    check('view only: keys don\'t reach the remote (the overview stays closed)', !(await overview()))
    check('view only: keys from the menu are refused', !(await ev('return await RD.desktop.takeKeyboard(H.pane)')))
    await ev('await H.inZone(() => RD.desktop.reopen(H.pane, RD.desktop.desktopOf(H.pane)))')
    check('view only: reconnected', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    check('view only: still on after a reconnect', await ev('return RD.desktop.isViewOnly(H.pane) && H.overlay(H.pane).classList.contains("trd-view-only-on")'))
    await sleep(1500)
    await click(VIEW_ONLY)
    check('view only off: the label is gone', await ev('return !RD.desktop.isViewOnly(H.pane) && getComputedStyle(H.overlay(H.pane).querySelector(".trd-view-only")).display === "none"'))
    await t.clickDesktop('H.pane')
    await setOverview(false)
    await click(SEND, 'Super (Activities)')
    check('view only off: keys go through again', await waitOverview(true))
    await setOverview(false)
    await waitOverview(false)

    // 5. Screenshots.
    const shot = async () => {
        const before = await ev('return RD.desktop.logOf(H.pane).filter(l => /screenshot: saved/.test(l)).length')
        await click(SCREENSHOT)
        const line = await t.waitFor(`const l = RD.desktop.logOf(H.pane).filter(l => /screenshot: saved/.test(l)); return l.length > ${before} ? l.at(-1) : null`, 10)
        const file = line?.replace(/^.*screenshot: saved /, '') ?? null
        if (file) t.onCleanup(() => ev(`require('fs').rmSync(${JSON.stringify(file)}, { force: true })`))
        return file
    }
    const first = await shot()
    const canvas = await ev('return H.canvas(H.pane)')
    const png = first && await ev(`const b = require('fs').readFileSync(${JSON.stringify(first)})
        return { png: b.subarray(1, 4).toString() === 'PNG', w: b.readUInt32BE(16), h: b.readUInt32BE(20) }`)
    check('screenshot: a PNG in Downloads', !!first && png?.png && inDownloads(first), first)
    check('screenshot: at the remote resolution', !!png && png.w === canvas?.w && png.h === canvas?.h, { png, canvas })
    const clip = await ev('const i = require("electron").clipboard.readImage(); return i.isEmpty() ? null : i.getSize()')
    check('screenshot: the image is on the clipboard', !!clip && Math.abs(clip.width / clip.height - canvas.w / canvas.h) < 0.01, clip)
    check('screenshot: says where it went', /Screenshot saved/.test(await ev('return H.toast(H.pane)')))
    const second = await shot()
    check('screenshot: a second one doesn\'t overwrite the first', !!second && second !== first
        && await ev(`return require('fs').existsSync(${JSON.stringify(first)}) && require('fs').existsSync(${JSON.stringify(second)})`), { first, second })

    // 6. Keep the resolution: actual size, then scale to fit.
    const setPane = (width, height) => ev(`const el = H.pane?.element.nativeElement; if (el) { el.style.flex = 'none'; el.style.width = '${width}px'; el.style.height = '${height}px' }`)
    const settle = async () => {
        let last = ''
        for (let i = 0; i < 30; i++) {
            await sleep(300)
            const now = JSON.stringify(await ev(`const c = H.canvas(H.pane), w = H.overlay(H.pane)?.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('.screen-wrapper')
                return c && { w: c.w, h: c.h, cssW: c.cssW, cssH: c.cssH, paneW: c.paneW, paneH: c.paneH, scrolls: !!w && (w.scrollWidth > w.clientWidth || w.scrollHeight > w.clientHeight) }`))
            if (now === last) return JSON.parse(now)
            last = now
        }
        return JSON.parse(last)
    }
    await setPane(780, 560)
    const big = await settle()
    await t.settings({ resize: 'off', zoom: 'actual' })
    const radios = (await ev('return (await H.menu(H.pane)).find(i => i.label === "Remote desktop settings")?.submenu.filter(i => i.checked).map(i => i.label) ?? []'))
    check('the settings show "actual size" chosen', radios.includes('Keep the resolution (actual size, scroll)'), radios)
    await setPane(600, 420)
    const actual = await settle()
    check('actual size: resolution kept', actual.w === big.w && actual.h === big.h, { big, actual })
    check('actual size: shown 1:1', Math.abs(actual.cssW - actual.w) <= 1 && Math.abs(actual.cssH - actual.h) <= 1, actual)
    check('actual size: scroll bars in the smaller pane', actual.scrolls, actual)
    await t.settings({ zoom: 'fit' })
    const fit = await settle()
    check('scale to fit: shrunk into the pane', fit.cssW <= fit.paneW + 1 && fit.cssH <= fit.paneH + 1 && fit.cssW < fit.w, fit)
})

/** The file is in a Downloads folder (the plugin's own choice of folder). */
function inDownloads (file) {
    return /[\\/]Downloads[\\/]Screenshot [^\\/]+\.png$/.test(file)
}
