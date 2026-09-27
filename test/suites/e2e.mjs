// Every entry point, on a Linux desktop host (TRD_TEST_HOST): the SSH toolbar button, the hotkey (real key events),
// the terminal and tab-header menus, the header controls, "one desktop per account" across tabs, a plain local
// terminal running `ssh` (system ssh), typing, focus, and Disconnect.
import { suite } from '../lib/harness.mjs'

await suite('e2e', async t => {
    const { ev, check, sleep } = t
    await ev(`Object.assign(H, {
        state (p) {
            const o = H.overlay(p)
            return { has: RD.desktop.has(p), visible: RD.desktop.isVisible(p), overlayShown: !!o && o.style.display !== 'none' }
        },
        // The desktop entries of a pane's menu (tab header: the tab's menu).
        async entries (header, p) {
            const { TabContextMenuItemProvider } = require('tabby-core')
            const items = (await Promise.all(RD.injector.get(TabContextMenuItemProvider).map(x => x.getItems(header ? H.topOf(p) : p, header)))).flat()
            return items.filter(i => i.enabled !== false && /remote desktop|console/i.test(i.label ?? '') && i.label !== 'Remote desktop settings' && !/^Send files/.test(i.label ?? ''))
        },
        async clickEntry (header, label, p) {
            const item = (await H.entries(header, p)).find(i => i.label === label)
            if (!item) throw new Error('menu item not found: ' + label)
            item.click()
        },
        header () {
            const g = document.querySelector('app-root .trd-header')
            const toggle = g?.querySelector('.trd-header-toggle'), disconnect = g?.querySelector('.trd-header-disconnect')
            const gear = g?.parentElement.querySelector('button.btn-tab-bar:not(.trd-header-toggle):not(.trd-header-disconnect)')
            const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
            return {
                shown: shown(g), toggleTitle: toggle?.title, disconnectShown: shown(disconnect),
                leftOfGear: !!g && g.parentElement === document.querySelector('app-root .btn-space ~ .btn-group') && g.parentElement.firstElementChild === g,
                styled: !!toggle && !!gear && getComputedStyle(toggle).height === getComputedStyle(gear).height && getComputedStyle(toggle).paddingLeft === getComputedStyle(gear).paddingLeft,
            }
        },
        async openLocal () {
            const { ProfilesService } = require('tabby-core')
            const profiles = RD.injector.get(ProfilesService)
            const local = (await profiles.getProfiles()).find(p => p.id === 'local:default')
            const before = new Set(H.panes())
            await H.inZone(() => profiles.openNewTabForProfile(local))
            for (let i = 0; i < 40; i++) {
                const pane = H.panes().find(p => !before.has(p) && p.profile?.type === 'local')
                if (pane) {
                    H.opened.push(pane)
                    // Tabby starts a terminal's shell on its first focus.
                    H.inZone(() => RD.app.selectTab(H.topOf(pane)))
                    for (let j = 0; j < 40 && !pane.session; j++) await new Promise(r => setTimeout(r, 250))
                    return pane.session ? pane : null
                }
                await new Promise(r => setTimeout(r, 250))
            }
            return null
        },
        terminalFocused (p) { return p.element.nativeElement.contains(document.activeElement) && !H.overlay(p)?.contains(document.activeElement) },
    })`)
    const labels = async (header, pane = 'H.pane') => (await ev(`return (await H.entries(${header}, ${pane})).map(i => i.label)`)).join()
    const header = () => ev('await new Promise(r => setTimeout(r, 150)); return H.header()')
    const state = (pane = 'H.pane') => ev(`return H.state(${pane})`)
    const select = pane => ev(`H.inZone(() => RD.app.selectTab(H.topOf(${pane})))`)
    const waitEnded = async pane => {
        for (let i = 0; i < 60; i++) {
            const log = await ev(`return RD.desktop.logOf(${pane})`)
            if (log.some(l => /Z $/.test(l)) || log.some(l => /failed|ended/.test(l))) return log
            await sleep(1000)
        }
        return await ev(`return RD.desktop.logOf(${pane})`)
    }
    const hotkey = async () => {
        const mods = t.platform === 'darwin' ? ['Meta', 'Shift'] : ['Control', 'Shift']
        await t.key('G', 'KeyG', 71, mods)
        await sleep(500)
    }

    // Let Tabby finish starting up (it opens and selects its startup tab asynchronously).
    await ev('for (let i = 0; i < 40 && !RD.app.tabs.length; i++) await new Promise(r => setTimeout(r, 250)); await new Promise(r => setTimeout(r, 2000))')
    await t.settings({ desk: true })

    // 1. An SSH tab, before connecting.
    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    check('menu offers "Open remote desktop"', await labels(false) === 'Open remote desktop')
    const settings = await ev(`return ((await H.menu(H.pane)).find(i => i.label === 'Remote desktop settings')?.submenu ?? []).filter(i => i.type === 'radio').map(i => i.label + (i.checked ? '*' : ''))`)
    check('"Remote desktop settings" with resize and sharpness choices', settings.length === 5 && settings.filter(l => l.endsWith('*')).length === 2, settings)
    const deskItem = await ev(`const d = ((await H.menu(H.pane)).find(i => i.label === 'Remote desktop settings')?.submenu ?? []).find(i => i.type === 'checkbox'); return d ? { label: d.label, checked: d.checked } : null`)
    check('settings have the desk checkbox (on here)', /desk/.test(deskItem?.label ?? '') && deskItem.checked === true, deskItem)
    check('SSH toolbar has a Desktop button', !!(await t.waitFor(`return !!H.pane.element.nativeElement.querySelector('terminal-toolbar .trd-toolbar-button')`, 5)))
    let hd = await header()
    check('header controls left of the gear, Tabby-styled', hd.shown && hd.leftOfGear && hd.styled && hd.toggleTitle === 'Open remote desktop' && !hd.disconnectShown, hd)

    // 2. The toolbar button opens and connects.
    await ev(`H.pane.element.nativeElement.querySelector('.trd-toolbar-button').click()`)
    const log = await waitEnded('H.pane')
    check('desktop connected', log.some(l => /Z $/.test(l)) && !log.some(l => /failed|ended/.test(l)), log.at(-1))
    check('desktop shown after the toolbar click', (await state()).overlayShown)
    const frame = await t.waitFor('const c = H.canvas(H.pane); return c?.colors > 10 ? c : null', 10)
    check('desktop frame decoded', !!frame, await ev('return H.canvas(H.pane)'))
    hd = await header()
    check('header offers "Back to console" and Disconnect', hd.toggleTitle === 'Back to console' && hd.disconnectShown, hd)

    // 3. Focus and typing: a terminal on the desktop reads one line into a file.
    await t.remote('H.pane', `rm -f /tmp/trd-typed; systemctl --user stop 'trd-typing-test*' 2>/dev/null; systemd-run --user --collect --unit=trd-typing-test --setenv=WAYLAND_DISPLAY=wayland-0 --setenv=XDG_SESSION_TYPE=wayland gnome-terminal --wait -- sh -c 'read l; printf %s "$l" > /tmp/trd-typed' >/dev/null 2>&1; echo started`)
    t.onCleanup(() => t.remote('H.pane', `systemctl --user stop 'trd-typing-test*' 2>/dev/null; rm -f /tmp/trd-typed; true`))
    // Wait for the terminal's shell, then for its window to map.
    await t.remote('H.pane', `for i in $(seq 60); do pgrep -u "$(id -u)" -f 'read l; printf' >/dev/null && break; sleep 0.25; done; sleep 1.5`)
    check('the component keeps its container first in its shadow root (it only forwards keys then)',
        await ev(`return H.overlay(H.pane).querySelector('iron-remote-desktop').shadowRoot.firstElementChild?.tagName === 'DIV'`))
    check('no focus outline around the desktop', await ev(`return getComputedStyle(H.overlay(H.pane).querySelector('iron-remote-desktop').shadowRoot.querySelector('.screen-wrapper')).outlineStyle === 'none'`))
    check('terminal input disabled while the desktop shows', await ev(`return [...H.pane.element.nativeElement.querySelectorAll('textarea.xterm-helper-textarea')].every(x => x.disabled)`))
    // What Tabby does when the pane gets focus; the desktop must keep it.
    await ev('H.pane.frontend?.focus()')
    await sleep(300)
    check('the desktop takes focus back from the terminal', await ev(`return document.activeElement?.tagName === 'IRON-REMOTE-DESKTOP'`), await ev('return document.activeElement?.tagName'))
    // IronRDP clicks at the last pointer position it saw: t.clickDesktop moves there first.
    await t.clickDesktop('H.pane')
    await t.type('trdok42')
    await t.enter()
    let typed = ''
    for (let i = 0; i < 10 && !typed; i++) {
        await sleep(500)
        typed = (await t.remote('H.pane', 'cat /tmp/trd-typed 2>/dev/null')).trim()
    }
    check('typing reaches the remote desktop', typed === 'trdok42', typed)

    // 4. The hotkey (real key events) goes back to the console, and to the desktop again. It acts on the active tab.
    await select('H.pane')
    await sleep(300)
    await hotkey()
    let st = await state()
    check('hotkey returns to the console', st.has && !st.visible && !st.overlayShown, st)
    check('the console has focus', await ev('return H.terminalFocused(H.pane)'))
    check('terminal input enabled again', await ev(`return [...H.pane.element.nativeElement.querySelectorAll('textarea.xterm-helper-textarea')].every(x => !x.disabled)`))
    await hotkey()
    st = await state()
    const sameSession = async () => (await ev('return RD.desktop.logOf(H.pane)[0]')) === log[0]
    check('hotkey shows the desktop again (same session)', st.visible && st.overlayShown && await sameSession(), st)

    // 5. Menus.
    check('terminal menu while shown', await labels(false) === 'Back to console,Disconnect remote desktop')
    await ev(`await H.clickEntry(false, 'Back to console', H.pane)`)
    await sleep(300)
    check('terminal menu "Back to console"', !(await state()).visible)
    check('tab header menu while hidden', await labels(true) === 'Show remote desktop,Disconnect remote desktop')
    await ev(`await H.clickEntry(true, 'Show remote desktop', H.pane)`)
    await sleep(300)
    check('tab header menu "Show remote desktop"', (await state()).visible)

    // 6. Header controls.
    await ev(`document.querySelector('app-root .trd-header-toggle').click()`)
    await sleep(300)
    hd = await header()
    check('header toggle returns to the console', !(await state()).visible && hd.toggleTitle === 'Show remote desktop', hd)
    await ev(`document.querySelector('app-root .trd-header-toggle').click()`)
    await sleep(300)
    check('header toggle shows the desktop (same session)', (await state()).visible && await sameSession())

    // 7. A second SSH tab to the same account switches to the open desktop instead of connecting again.
    check('second SSH tab connected', await ev('H.pane2 = await H.openSSH(); return !!H.pane2'))
    await ev('H.inZone(() => RD.desktop.showConsole(H.pane))')
    check('second tab offers switching', await labels(false, 'H.pane2') === 'Switch to remote desktop (open in another tab)')
    await select('H.pane2')
    await sleep(300)
    hd = await header()
    check('header on the second tab offers switching', hd.toggleTitle === 'Switch to remote desktop (open in another tab)' && !hd.disconnectShown, hd)
    await hotkey()
    st = { first: await state(), second: await state('H.pane2'), activeIsFirst: await ev('return RD.app.activeTab === H.topOf(H.pane)') }
    check('hotkey on the second tab switches to the first tab\'s desktop', st.first.visible && st.activeIsFirst && !st.second.has && await sameSession(), st)
    await ev('H.inZone(() => { RD.desktop.showConsole(H.pane); RD.app.selectTab(H.topOf(H.pane2)) })')
    await sleep(300)
    await ev(`await H.clickEntry(false, 'Switch to remote desktop (open in another tab)', H.pane2)`)
    await sleep(500)
    st = { first: await state(), second: await state('H.pane2'), activeIsFirst: await ev('return RD.app.activeTab === H.topOf(H.pane)') }
    check('the menu on the second tab switches too', st.first.visible && st.activeIsFirst && !st.second.has, st)
    const desktops = await ev('return H.panes().filter(p => RD.desktop.has(p)).length')
    check('still one desktop session', desktops === 1, desktops)

    // 8. A plain local terminal running `ssh` is recognized as the same account (not on Windows).
    if (t.platform === 'win32') {
        t.skip('local terminal running ssh', 'not detected on Windows')
    } else {
        check('local terminal opened', await ev('H.local = await H.openLocal(); return !!H.local'))
        // Let the shell start: prompts like zsh's instant prompt drop typeahead.
        await sleep(5000)
        await select('H.local')
        await sleep(2500)
        check('header hidden on a local terminal without ssh', !(await header()).shown)
        await ev(`H.local.sendInput(${JSON.stringify(`ssh -o BatchMode=yes ${t.env.sshDestination}\r`)})`)
        const expected = await ev('return (await RD.targets.targetOf(H.pane)).key')
        let key = null
        for (let i = 0; i < 20 && key !== expected; i++) {
            await sleep(1000)
            key = await ev('return (await RD.targets.targetOf(H.local))?.key ?? null')
        }
        check('ssh in a local terminal recognized as the same account', key === expected, { key, expected })
        await select('H.local')
        await sleep(2500)
        hd = await header()
        check('header shows on the local terminal, offering the open desktop', hd.shown && hd.toggleTitle === 'Switch to remote desktop (open in another tab)', hd)
        check('local terminal menu offers switching', await labels(false, 'H.local') === 'Switch to remote desktop (open in another tab)')
    }

    // 9. Disconnect from the header (on the tab that has the desktop).
    await select('H.pane')
    await sleep(300)
    await ev(`document.querySelector('app-root .trd-header-disconnect').click()`)
    await sleep(500)
    st = await state()
    check('header Disconnect removes the session', !st.has && !st.overlayShown, st)
    check('menu offers "Open remote desktop" again', await labels(false) === 'Open remote desktop')
    check('the second tab no longer offers switching', await labels(false, 'H.pane2') === 'Open remote desktop')

    if (t.platform !== 'win32') {
        // 10. The local terminal opens its own desktop, through the system ssh.
        await select('H.local')
        await sleep(2500)
        check('header on the local terminal offers opening', (await header()).toggleTitle === 'Open remote desktop')
        await ev(`document.querySelector('app-root .trd-header-toggle').click()`)
        const localLog = await waitEnded('H.local')
        check('desktop connected from a local terminal (system ssh)', localLog.some(l => /Z $/.test(l)) && !localLog.some(l => /failed|ended/.test(l)), localLog.at(-1))
        check('its frame decoded', !!(await t.waitFor('return H.canvas(H.local)?.colors > 10', 10)))
        await ev(`document.querySelector('app-root .trd-header-disconnect').click()`)
        await sleep(500)
        check('local terminal desktop disconnected', !(await ev('return RD.desktop.has(H.local)')))

        // 11. Leaving ssh hides the controls on the local terminal.
        await ev(`H.local.sendInput('exit\\r')`)
        let gone = false
        for (let i = 0; i < 10 && !gone; i++) {
            await sleep(1000)
            gone = !(await header()).shown
        }
        check('header hides after ssh exits', gone)
    }
})
