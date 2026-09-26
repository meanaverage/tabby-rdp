// The keyboard while a desktop has it, on a Linux desktop host (TRD_TEST_HOST), through the terminal `desk` opens:
// - Tabby's shortcuts don't act on the covered console (⌘V pasted into it, ⌘W closed the tab); the desktop/console
//   switch and tab switching still work.
// - Mac shortcuts (macOS): ⌘ is sent as Ctrl (⌘C interrupts, ⌘⇧V pastes in the terminal); with the setting off it
//   isn't. Uses the Mac clipboard (put back afterwards).
import { suite } from '../lib/harness.mjs'

const MAC = process.platform === 'darwin'

await suite('keyboard', async t => {
    const { ev, check, sleep } = t
    const cmd = MAC ? 'Meta' : 'Control'
    await t.settings({ desk: true, macShortcuts: true })
    await t.clipboard()

    // `desk`: the desktop, with a terminal attached to this console.
    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    t.onCleanup(() => t.remote('H.pane', `pkill -u "$(id -u)" -f '[t]rd-pty attach'; true`))
    await sleep(2500)
    await ev(`H.pane.sendInput('desk\\r')`)
    check('desk: the desktop, with the console in a terminal', !!(await t.waitFor(`return RD.desktop.logOf(H.pane).some(l => /desk: opened/.test(l))`, 10, 100)))
    await sleep(1500)
    await t.clickDesktop('H.pane')

    // 1. ⌘V doesn't paste into the SSH console under the desktop.
    await ev(`H.pane.sendInput('clear\\r')`)
    await sleep(500)
    await t.clipboard('leaked-into-console')
    await sleep(400)
    await t.press('v', [cmd])
    await sleep(1200)
    check(`${MAC ? '⌘' : 'Ctrl+'}V: nothing pasted into the covered console`, !(await ev('return H.screen(H.pane)')).includes('leaked-into-console'))

    // 2. ⌘W doesn't close the tab.
    await t.press('w', [cmd])
    await sleep(800)
    check(`${MAC ? '⌘' : 'Ctrl+'}W: the tab stays open, the desktop still shows`, await ev('return H.panes().includes(H.pane) && RD.desktop.isVisible(H.pane)'))

    if (MAC) {
        // 3. ⌘C reaches the remote as Ctrl+C: it interrupts a command.
        await ev(`H.pane.sendInput('clear; sleep 30; echo after-sleep-$((6*7))\\r')`)
        await sleep(800)
        await t.press('c', ['Meta'])
        check('⌘C interrupts the command on the remote (sent as Ctrl+C)',
            !!(await t.waitFor('return /\\^C/.test(H.screen(H.pane))', 5)) && !(await t.waitFor('return /after-sleep-42/.test(H.screen(H.pane))', 1)))

        // 4. ⌘⇧V reaches the remote as Ctrl+Shift+V: the terminal pastes the Mac clipboard.
        await ev(`H.pane.sendInput('clear\\r')`)
        await sleep(500)
        await t.clipboard('echo mapped-$((6*7))')
        await sleep(500)
        await t.press('v', ['Meta', 'Shift'])
        await sleep(500)
        await t.enter()
        check('⌘⇧V pastes in the remote terminal (sent as Ctrl+Shift+V)', !!(await t.waitFor('return /^mapped-42\\s*$/m.test(H.screen(H.pane))', 6)))

        // 5. No stuck key after ⌘ combinations (macOS sends no keyup for them).
        await sleep(1000)
        const prompt = (await ev('return H.screen(H.pane)')).split('\n').filter(l => l.trim()).pop() ?? ''
        check('no repeated characters from a stuck key', !/([cvw])\1{3,}/i.test(prompt), prompt)

        // 6. Setting off: ⌘ is the Windows/Super key, so ⌘⇧V doesn't paste.
        await t.settings({ macShortcuts: false })
        await ev(`H.pane.sendInput('clear\\r')`)
        await sleep(500)
        await t.clipboard('echo unmapped-$((6*7))')
        await sleep(500)
        await t.press('v', ['Meta', 'Shift'])
        await sleep(800)
        await t.enter()
        check('setting off: ⌘⇧V is not Ctrl+Shift+V', !(await t.waitFor('return /^unmapped-42\\s*$/m.test(H.screen(H.pane))', 3)))
        await t.settings({ macShortcuts: true })
        await t.clickDesktop('H.pane')
    } else {
        t.skip('Mac shortcuts', 'macOS only')
    }

    // 7. Tabby shortcuts that stay: switching tabs, and the desktop/console switch.
    const hotkey = await ev(`return RD.injector.get(require('tabby-core').ConfigService).store.hotkeys['remote-desktop-toggle'][0] ?? ''`)
    const other = await ev('return RD.app.tabs.findIndex(x => x !== H.topOf(H.pane))')
    if (other >= 0 && other < 9) {
        await t.press(String(other + 1), [cmd])
        await sleep(500)
        check('⌘<n> still switches Tabby tabs', await ev(`return RD.app.activeTab === RD.app.tabs[${other}]`))
        await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.pane)))')
        await sleep(500)
        await t.clickDesktop('H.pane')
    }
    const expected = MAC ? '⌘-Shift-G' : 'Ctrl-Shift-G'
    if (hotkey === expected) {
        await t.press('g', [cmd, 'Shift'])
        await sleep(500)
        check('the switch hotkey still goes back to the console', !(await ev('return RD.desktop.isVisible(H.pane)')))
    } else {
        t.skip('switch hotkey', `bound to ${JSON.stringify(hotkey)}`)
    }
})
