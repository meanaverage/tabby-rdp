// Which pane has the keyboard, and with it this computer's clipboard, with a desktop next to a terminal on a Linux
// desktop host (TRD_TEST_HOST): security review findings 7 and 8.
// - The pointer passing over a desktop in a pane the user isn't in (no click) leaves the keyboard in the terminal the
//   user is typing in; also over the margin a pane maximized over the desktop leaves it.
// - A click on the desktop still gives it the keyboard.
// - Leaving the desktop's tab for one that takes no focus (Settings), as a keyboard shortcut does, takes the keyboard
//   from the desktop; going back gives it back.
// - Leaving it by the shortcut itself (Alt+N, ⌘N), whose modifier is still down as the tab goes, leaves no modifier
//   held on the remote: seen through the terminal `desk` opens there, where one still held would garble what is typed
//   next.
import { suite, type Modifier } from '../lib/harness.js'

/** Tabby's shortcut notation for a modifier, as the hotkey strings spell it. */
const MODIFIERS: Record<string, Modifier> = { '⌘': 'Meta', Cmd: 'Meta', Ctrl: 'Control', '⌃': 'Control', Alt: 'Alt', '⌥': 'Alt', Shift: 'Shift', '⇧': 'Shift' }

await suite('focus', async t => {
    const { ev, check, waitFor, sleep } = t
    // `desk` on from the start: the desktop's setup gives the plugin desk's key then, which step 5 needs.
    await t.settings({ clipboard: 'off', sound: false, microphone: false, desk: true })
    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    t.onCleanup(() => ev('H.inZone(() => RD.desktop.disconnect(H.pane))'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('the desktop connected', !!await waitFor('return RD.desktop.isConnected(H.pane) && (H.canvas(H.pane)?.colors ?? 0) > 10', 45))

    // A terminal next to it: the split's other pane, a console on the same host.
    await ev(`H.top = H.topOf(H.pane); H.b = await H.inZone(() => H.top.splitTab(H.pane, 'r')); H.opened.push(H.b)`)
    check('the terminal next to it connected', !!await waitFor('return H.b?.sshSession?.open ? true : null', 30))
    await ev('H.inZone(() => { H.top.equalize?.(); H.top.layout?.() })')
    await sleep(1000)
    const typing = `const input = H.b.element.nativeElement.querySelector('textarea.xterm-helper-textarea'); return !!input && document.activeElement === input`
    const onDesktop = `return document.activeElement?.tagName === 'IRON-REMOTE-DESKTOP' && H.overlay(H.pane).contains(document.activeElement)`
    const rect = (expr: string) => ev<{ x: number, y: number, w: number, h: number }>(`const r = ${expr}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }`)
    const clickTerminal = async () => {
        const b = await rect('H.b.element.nativeElement')
        await t.mouse(b.x + b.w / 2, b.y + b.h / 2)
        await sleep(400)
    }
    /** The pointer moved to (x, y) without a click, from the middle of the terminal. */
    const pass = async (x: number, y: number) => {
        const b = await rect('H.b.element.nativeElement')
        await t.mouse(b.x + b.w / 2, b.y + b.h / 2, 0)
        await sleep(100)
        await t.mouse(x, y, 0)
        await sleep(400)
    }
    /** Types a command into the terminal; whether its output shows there (the keys went to it, not the desktop). */
    const typedIntoTerminal = async (marker: string) => {
        await t.type(`echo ${marker}`)
        await t.enter()
        return !!await waitFor(`return new RegExp('^${marker}\\\\s*$', 'm').test(H.screen(H.b))`, 5)
    }

    // 1. The pointer passing over the desktop.
    await clickTerminal()
    check('the terminal has the keyboard', !!await waitFor(typing, 5))
    const a = await rect('H.canvasElement(H.pane)')
    await pass(a.x + a.w / 2, a.y + a.h / 2)
    check('pointer over the desktop, no click: the terminal keeps the keyboard', !!await waitFor(typing, 2), await ev('return document.activeElement?.tagName'))
    check('pointer over the desktop, no click: what is typed reaches the terminal', await typedIntoTerminal('HOVERKEEPS1'))

    // 2. A click still hands the desktop the keyboard.
    await t.clickDesktop('H.pane')
    check('a click on the desktop gives it the keyboard', !!await waitFor(onDesktop, 5))

    // 3. Behind a pane maximized over it: the margin it shows in.
    const maximizes = await ev<boolean>('return typeof H.top.maximize === "function"')
    if (maximizes) {
        await ev('H.inZone(() => H.top.maximize(H.b))')
        t.onCleanup(() => ev('H.inZone(() => H.top.maximize(null))'))
        await sleep(600)
        await clickTerminal()
        check('maximized: the terminal has the keyboard', !!await waitFor(typing, 5))
        const b = await rect('H.b.element.nativeElement')
        const c = await rect('H.canvasElement(H.pane)')
        // A point of the desktop's picture outside the maximized pane, if the layout leaves one.
        const candidates = [[c.x + 2, c.y + c.h / 2], [b.x - 3, c.y + c.h / 2], [c.x + c.w / 2, c.y + 2], [c.x + c.w / 2, b.y - 3]]
        const inside = (p: number[], r: typeof b) => p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h
        const margin = candidates.find(p => inside(p, c) && !inside(p, b))
        if (margin) {
            await pass(margin[0], margin[1])
            check('maximized: pointer over the desktop in the margin keeps the keyboard in the terminal', !!await waitFor(typing, 2), await ev('return document.activeElement?.tagName'))
            check('maximized: what is typed reaches the terminal', await typedIntoTerminal('HOVERKEEPS2'))
        } else {
            t.skip('maximized margin', 'the layout leaves no part of the desktop outside the maximized pane')
        }
        await ev('H.inZone(() => H.top.maximize(null))')
        await sleep(600)
    }

    // 4. Leaving the desktop's tab for Settings, which takes no focus, the way a keyboard shortcut does (no click).
    // Keep another top-level tab so the shortcut exercises a higher digit; Ctrl+3 is Escape in a remote terminal.
    check('another host tab connected before the shortcut test', await ev('H.spare = await H.openSSH(); return !!H.spare'))
    await ev('H.inZone(() => RD.app.selectTab(H.top)); H.inZone(() => H.top.focus(H.pane))')
    await t.clickDesktop('H.pane')
    check('the desktop has the keyboard before the switch', !!await waitFor(onDesktop, 5))
    await ev(`RD.help.open('settings')`)
    await waitFor('return !!document.querySelector(".trd-settings")', 5)
    t.onCleanup(() => ev(`const s = RD.app.tabs.find(x => x instanceof require('tabby-settings').SettingsTabComponent); if (s) await H.inZone(() => RD.app.closeTab(s, false))`))
    await sleep(300)
    check('Settings in front: the desktop let go of the keyboard', !await ev<boolean>(`return H.overlay(H.pane).contains(document.activeElement)`), await ev('return document.activeElement?.tagName'))
    // Back to the tab: the desktop's pane is the one in front again, and takes the keyboard back by itself.
    await ev('H.inZone(() => RD.app.selectTab(H.top))')
    await ev('H.inZone(() => H.top.focus(H.pane))')
    check('back on the tab: the desktop has the keyboard again', !!await waitFor(onDesktop, 5))

    // 5. Leaving the tab by Tabby's shortcut for the Settings tab (Alt+N on Linux and Windows, ⌘N on a Mac, which goes
    //    to the remote as Ctrl): the modifier went down on the remote, and its keyup comes once the desktop has let go
    //    of the keyboard, so the desktop lets go of the modifier itself. Seen through `desk`, a terminal on the remote
    //    attached to this console: with the modifier still held there, what is typed next wouldn't come out as typed
    //    (Ctrl+E, Ctrl+C, … for `echo`), and the terminal's output shows in the console under the desktop.
    const settingsAt = await ev<number>(`return RD.app.tabs.findIndex(x => x instanceof require('tabby-settings').SettingsTabComponent)`)
    const tabKey = settingsAt >= 0 && settingsAt < 9 ? await ev<string>(`return RD.injector.get(require('tabby-core').ConfigService).store.hotkeys['tab-${settingsAt + 1}']?.[0] ?? ''`) : ''
    const tabMods = tabKey.split('-').slice(0, -1).map(m => MODIFIERS[m])
    if (!tabKey || !tabMods.length || !tabMods.every(Boolean) || !tabKey.endsWith(`-${settingsAt + 1}`)) {
        t.skip('a modifier held as the tab is left', `tab-${settingsAt + 1} is bound to ${JSON.stringify(tabKey)}`)
        return
    }
    await ev('H.inZone(() => RD.desktop.showConsole(H.pane))')
    await sleep(500)
    await ev(`H.pane.sendInput('desk\\r')`)
    if (!await waitFor(`return RD.desktop.logOf(H.pane).some(l => /^desk: (opened|attached)/.test(l))`, 20, 100)) {
        t.skip('a modifier held as the tab is left', 'desk opened no terminal on the remote (the console\'s login may predate its hook: see test/suites/desk.ts)')
        return
    }
    await sleep(1500)
    await t.clickDesktop('H.pane')
    check('desk: the desktop has the keyboard', !!await waitFor(onDesktop, 5))
    await ev(`H.pane.sendInput('clear\\r')`)
    await sleep(500)
    // The pointer off the desktop first (over the terminal, no click: the desktop keeps the keyboard). Left on it,
    // IronRDP would let go of every key itself as the tab goes and the pointer leaves its canvas, hiding a held one.
    // The desktop's picture can reach over the terminal's pane in a small window (its smallest size is wider than a
    // half), so a point of the terminal that nothing of the desktop's overlay is at.
    const off = await ev<{ x: number, y: number } | null>(`const r = H.b.element.nativeElement.getBoundingClientRect(); const overlay = H.overlay(H.pane)
        for (const fx of [0.9, 0.75, 0.5]) for (const fy of [0.5, 0.25, 0.75]) {
            const x = r.x + r.width * fx, y = r.y + r.height * fy, at = document.elementFromPoint(x, y)
            if (at && H.b.element.nativeElement.contains(at) && !overlay.contains(at)) return { x, y }
        }
        return null`)
    if (!off) {
        t.skip('a modifier held as the tab is left', 'the desktop covers all of the terminal next to it: no place for the pointer off the desktop')
        return
    }
    await t.mouse(off.x, off.y, 0)
    await sleep(300)
    check('desk: the pointer moved off the desktop, the desktop keeps the keyboard', !!await waitFor(onDesktop, 2))
    // The modifier is let go of only once the tab has gone, as a person does: let go of at once (before the switch), its
    // keyup would still reach the desktop, and nothing would be left held to test.
    let switched = false
    await t.press(String(settingsAt + 1), tabMods, async () => {
        switched = !!await waitFor(`return RD.app.tabs.indexOf(RD.app.activeTab) === ${settingsAt} && !H.overlay(H.pane).contains(document.activeElement)`, 5)
        await sleep(300)
    })
    check(`${tabKey} from the desktop, its modifier still down: Settings is in front, and the desktop let go of the keyboard`,
        switched, await ev('return [RD.app.activeTab?.title, document.activeElement?.tagName]'))
    await ev('H.inZone(() => RD.app.selectTab(H.top))')
    await ev('H.inZone(() => H.top.focus(H.pane))')
    check('back on the tab: the desktop has the keyboard again, after the shortcut', !!await waitFor(onDesktop, 5))
    await t.type('echo letgo-42')
    await t.enter()
    check(`${tabKey}: the modifier was let go of on the remote (what is typed next comes out as typed)`,
        !!await waitFor(`return /^letgo-42\\s*$/m.test(H.screen(H.pane))`, 6),
        await ev(`return { screen: H.screen(H.pane).split('\\n').filter(Boolean).slice(-20),
            heldKeys: [...H.session(H.pane).keysDown.keys()],
            pressedHotkey: RD.injector.get(require('tabby-core').HotkeysService).pressedHotkey ?? null }`))
})
