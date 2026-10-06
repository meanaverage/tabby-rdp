// A small live GNOME/RDP upgrade check; host-only smoke checks run separately when no test host is configured.
import { suite } from '../lib/harness.js'
import { rendererErrors, smokeHost } from '../lib/smoke.js'

if (process.env.TRD_SMOKE_REQUIRE_RDP === '1' && !process.env.TRD_TEST_HOST) {
    console.error('FAIL  smoke-rdp: --require-rdp needs TRD_TEST_HOST; live RDP coverage cannot be skipped')
    process.exit(2)
}

await suite('smoke-rdp', async t => {
    const { ev, check, waitFor } = t
    await smokeHost(t)
    const errors = await rendererErrors(t)
    await t.settings({ resize: 'live', sharpness: 'standard', clipboard: 'off', sound: false, microphone: false })
    check('SSH test pane connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    if (!await ev('return !!H.pane')) throw new Error('SSH test pane did not open')
    t.onCleanup(() => ev('H.inZone(() => RD.desktop.disconnect(H.pane))'))
    t.onCleanup(() => ev(`const s = RD.app.tabs.find(x => x instanceof require('tabby-settings').SettingsTabComponent); if (s) await H.inZone(() => RD.app.closeTab(s, false))`))
    check('SSH toolbar exposes the plugin desktop button', !!await waitFor('return !!H.pane.element.nativeElement.querySelector(".trd-toolbar-button")', 5))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('real RDP connection and decoded frame', !!await waitFor('return RD.desktop.isConnected(H.pane) && (H.canvas(H.pane)?.colors ?? 0) > 10', 45))
    if (!await ev('return RD.desktop.isConnected(H.pane)')) throw new Error('RDP test desktop did not connect')
    await ev('H.smokeSession = H.session(H.pane); H.smokeUI = H.smokeSession.ui; H.smokeProxy = H.smokeSession.proxy')

    // Repeat: a refocused xterm must never capture keys while covered, and must recover when uncovered.
    for (let i = 0; i < 3; i++) {
        await ev('H.inZone(() => RD.desktop.showConsole(H.pane))')
        check(`switch ${i + 1}: console input is enabled and focused`, !!await waitFor(`const input = H.pane.element.nativeElement.querySelector('textarea.xterm-helper-textarea'); return !!input && !input.disabled && document.activeElement === input`, 5))
        await ev('H.pane.frontend.focus()')
        await t.type(`echo SMOKE_CONSOLE_${i}`)
        await t.enter()
        check(`switch ${i + 1}: console input reaches SSH`, !!await waitFor(`return /^SMOKE_CONSOLE_${i}\\s*$/m.test(H.screen(H.pane))`, 5))
        await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
        await t.clickDesktop('H.pane')
        check(`switch ${i + 1}: RDP input owns focus`, !!await waitFor(`return document.activeElement?.tagName === 'IRON-REMOTE-DESKTOP' && H.overlay(H.pane).contains(document.activeElement)`, 5))
        check(`switch ${i + 1}: covered xterm input is disabled`, await ev(`const inputs = [...H.pane.element.nativeElement.querySelectorAll('textarea.xterm-helper-textarea')]; return inputs.length > 0 && inputs.every(e => e.disabled)`))
        // Include host shortcuts that send directly to the session, bypassing xterm's input observable.
        await ev(`H.consoleInput = []; H.consoleInputSub = H.pane.session.middleware.outputToSession$.subscribe(b => H.consoleInput.push(Buffer.from(b).toString('hex')))`)
        t.onCleanup(() => ev('H.consoleInputSub?.unsubscribe()'))
        await ev('H.pane.frontend.focus()')
        await t.press('x')
        await t.key('ArrowLeft', 'ArrowLeft', 37, ['Alt'])
        await t.key('ArrowRight', 'ArrowRight', 39, ['Alt'])
        check(`switch ${i + 1}: no RDP keys leak to the covered console`, await ev('return H.consoleInput.length === 0'), await ev('return H.consoleInput'))
        await ev('H.consoleInputSub.unsubscribe()')
    }
    check('switching preserves the RDP session', await ev('const s = H.session(H.pane); return !!s && s === H.smokeSession && s.ui === H.smokeUI && s.proxy === H.smokeProxy && RD.desktop.isConnected(H.pane)'))

    const style = await ev<string>('return H.pane.element.nativeElement.style.cssText')
    t.onCleanup(() => ev(`H.pane.element.nativeElement.style.cssText = ${JSON.stringify(style)}`))
    // Both sizes exceed the plugin's 640×480 minimum remote display.
    for (const [width, height] of [[680, 540], [800, 640]]) {
        await ev(`const el = H.pane.element.nativeElement; el.style.flex = 'none'; el.style.minWidth = '0'; el.style.minHeight = '0'; el.style.width = '${width}px'; el.style.height = '${height}px'`)
        check(`RDP display follows ${width}×${height} pane`, !!await waitFor(`const c = H.canvas(H.pane); return c && Math.abs(c.w - c.paneW) <= 2 && Math.abs(c.h - c.paneH) <= 2 && c.colors > 10`, 12), await ev('return H.canvas(H.pane)'))
    }
    await ev(`RD.help.open('settings')`)
    await waitFor('return !!document.querySelector(".trd-settings")', 5)
    await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.pane)))')
    await t.clickDesktop('H.pane')
    check('RDP focus returns after switching host tabs', !!await waitFor('return document.activeElement?.tagName === "IRON-REMOTE-DESKTOP"', 5))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    check('disconnect removes the overlay and restores console focus', !!await waitFor(`return !RD.desktop.has(H.pane) && !H.overlay(H.pane) && document.activeElement === H.pane.element.nativeElement.querySelector('textarea.xterm-helper-textarea')`, 5))
    errors()
})
