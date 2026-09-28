// Help, on a Linux desktop host (TRD_TEST_HOST): Settings › Remote Desktop (opened from the menu and at a section,
// its settings following the config both ways, remembered certificates, open desktops), the one-time tip on the first
// connection, and "What does this mean?" under a message that ends a connection.
import { suite } from '../lib/harness.mjs'

await suite('help', async t => {
    const { ev, check, sleep } = t
    await ev(`Object.assign(H, {
        settingsTab () { const { SettingsTabComponent } = require('tabby-settings'); return RD.app.tabs.find(x => x instanceof SettingsTabComponent) ?? null },
        page () { return document.querySelector('.trd-settings') },
        async closeSettings () { const s = H.settingsTab(); if (s) await H.inZone(() => RD.app.closeTab(s, false)) },
        async helpItem () { return (await H.menu(H.pane)).find(i => i.label === 'Settings').submenu.find(i => /help/i.test(i.label ?? '')) },
        tip () { return H.overlay(H.pane)?.querySelector('.trd-tip') ?? null },
    })`)
    t.onCleanup(() => ev('await H.closeSettings()'))
    await t.settings({ sound: true, sharpness: 'standard', resize: 'live' })
    const tipShown = await ev('return H.config.store.remoteDesktop.tipShown')
    t.onCleanup(() => ev(`H.config.store.remoteDesktop.tipShown = ${JSON.stringify(tipShown)}; H.config.save()`))
    await ev('H.config.store.remoteDesktop.tipShown = false; H.config.save()')

    // The tip: the first connection, once.
    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    const tip = await t.waitFor('return H.tip()?.innerText ?? null', 3)
    check('a tip shows on the first connection', !!tip && /console/.test(tip) && /Send keys/.test(tip), tip)
    check('it is remembered as shown', await ev('return H.config.store.remoteDesktop.tipShown === true'))
    await ev('H.inZone(() => H.tip().querySelector("[data-ok]").click())')
    check('"Got it" closes it', !!(await t.waitFor('return !H.tip()', 2)))
    check('the desktop has the keyboard again', !!(await t.waitFor('return document.activeElement?.tagName === "IRON-REMOTE-DESKTOP"', 2)))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected again', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    await sleep(1000)
    check('no tip the second time', await ev('return !H.tip()'))

    // A host is called by its profile's name (what the user named it), with its address kept for connecting.
    const named = await ev(`const p = await H.openSSH({ name: 'lab-1 (.ssh/config)' }); const t = await RD.targets.targetOf(p); return { label: t.label, hostname: t.hostname }`)
    check('a host is called by its profile\'s name (without Tabby\'s "(.ssh/config)")', named.label === 'lab-1' && named.hostname === t.env.host, named)

    // The page, from the menu.
    const item = await ev('const i = await H.helpItem(); return i?.label ?? null')
    check('the settings menu offers the page', !!item, item)
    await ev('const i = await H.helpItem(); H.inZone(() => i.click())')
    check('Settings opens at Remote Desktop', !!(await t.waitFor('return H.settingsTab()?.activeTab === "remote-desktop" && !!H.page()', 5)))
    check('it is in the sidebar', await ev('return [...document.querySelectorAll("settings-tab .nav-link")].some(a => a.textContent.trim() === "Remote Desktop")'))
    const sections = await ev('return [...H.page().querySelectorAll("[data-topic]")].map(s => s.dataset.topic)')
    check('its sections', ['start', 'settings', 'keyboard', 'desktops', 'certificates', 'troubleshooting'].every(s => sections.includes(s)), sections)

    // Settings, both ways.
    await ev('const c = H.page().querySelector("[data-setting=sound]"); c.click()')
    check('a switch changes the setting', !!(await t.waitFor('return H.config.store.remoteDesktop.sound === false', 2)))
    await ev('const s = H.page().querySelector("[data-setting=resize]"); s.value = "actual"; s.dispatchEvent(new Event("change"))')
    check('"Keep the size, 1:1" is a fixed resolution at actual size', !!(await t.waitFor('const r = H.config.store.remoteDesktop; return r.resize === "off" && r.zoom === "actual"', 2)))
    await ev('H.inZone(() => RD.desktop.updateSettings({ sound: true, resize: "live" }))')
    check('the page follows changes made elsewhere', !!(await t.waitFor('const p = H.page(); return p.querySelector("[data-setting=sound]").checked && p.querySelector("[data-setting=resize]").value === "live"', 2)))

    // The desktop name overlay: its settings, previewed; shown on the open desktop on request, whatever "show" says.
    const osdBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.osd)')
    t.onCleanup(() => ev(`Object.assign(H.config.store.remoteDesktop.osd, ${osdBefore}); H.config.save()`))
    await ev('const s = H.page().querySelector("[data-osd=font]"); s.value = "slender"; s.dispatchEvent(new Event("change"))')
    check('overlay font saved', !!(await t.waitFor('return H.config.store.remoteDesktop.osd.font === "slender"', 2)))
    check('... and previewed', !!(await t.waitFor('return /Avenir Next Condensed/.test(H.page().querySelector(".trd-osd-preview .trd-osd-box").style.fontFamily) || null', 2)), await ev('return H.page().querySelector(".trd-osd-preview .trd-osd-box").style.fontFamily'))
    await ev('const s = H.page().querySelector("[data-osd=position]"); s.value = "bottom-left"; s.dispatchEvent(new Event("change"))')
    check('overlay position previewed', !!(await t.waitFor('const b = H.page().querySelector(".trd-osd-preview .trd-osd-box").style; return b.bottom === "20px" && b.left === "24px"', 2)))
    await ev('H.page().querySelector("[data-osd=color]").value = "#ffcc00"; H.page().querySelector("[data-osd=color]").dispatchEvent(new Event("input"))')
    check('a custom overlay color', !!(await t.waitFor('return H.config.store.remoteDesktop.osd.color === "#ffcc00"', 2)))
    await ev('H.page().querySelector("[data-action=osd-white]").click()')
    check('"White" puts the default back', !!(await t.waitFor('return H.config.store.remoteDesktop.osd.color === ""', 2)))
    await ev('H.page().querySelector("[data-action=osd-try]").click()')
    check('"Show it on open desktops" shows it on this one (a single tab: not shown by itself)', !!(await t.waitFor('return H.overlay(H.pane).querySelector(".trd-osd.trd-shown .trd-osd-name")?.textContent || null', 2)))

    // Remembered certificates: listed, and forgotten from here.
    const fake = { desktop: 'nobody@example.invalid#192.0.2.1:3389', sha256: 'AB:'.repeat(31) + 'AB' }
    t.onCleanup(() => ev(`const r = H.config.store.remoteDesktop; r.trustedCertificates = r.trustedCertificates.filter(e => e.desktop !== ${JSON.stringify(fake.desktop)}); H.config.save()`))
    await ev(`const r = H.config.store.remoteDesktop; r.trustedCertificates = [...r.trustedCertificates, ${JSON.stringify(fake)}]; H.config.save()`)
    const row = await t.waitFor('return [...H.page().querySelectorAll("[data-list=certificates] .trd-row")].find(r => r.textContent.includes("192.0.2.1:3389"))?.textContent ?? null', 3)
    check('a remembered certificate is listed', !!row && row.includes('behind nobody@example.invalid'), row)
    await ev('[...H.page().querySelectorAll("[data-list=certificates] .trd-row")].find(r => r.textContent.includes("192.0.2.1:3389")).querySelector("button").click()')
    check('Forget forgets it', !!(await t.waitFor(`return !H.config.store.remoteDesktop.trustedCertificates.some(e => e.desktop === ${JSON.stringify(fake.desktop)})`, 2)))

    // Open desktops, with their logs.
    const session = await ev('return H.page().querySelector("[data-list=sessions] .trd-row")?.textContent ?? null')
    check('the open desktop is listed', !!session && /connected/.test(session), session)

    // Opened at a section, and from a message over the desktop.
    await ev('RD.help.open("troubleshooting", "certificate")')
    check('opens a troubleshooting entry', !!(await t.waitFor('return H.page()?.querySelector("details[data-entry=certificate]")?.open === true', 3)))
    await ev('await H.closeSettings()')
    await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.pane)))')
    await ev('H.session(H.pane).status("Remote desktop failed: Wrong user name or password.", [], true)')
    check('"What does this mean?" under a message that ends a connection', await ev('return H.overlay(H.pane).querySelector(".trd-status-help").style.display !== "none"'))
    await ev('H.inZone(() => H.overlay(H.pane).querySelector(".trd-status-help").click())')
    check('it opens the entry for that message', !!(await t.waitFor('return H.page()?.querySelector("details[data-entry=sign-in]")?.open === true', 3)))
    await ev('H.session(H.pane).status("Connecting…")')
    check('not under other messages', await ev('return H.overlay(H.pane).querySelector(".trd-status-help").style.display === "none"'))
    await ev('H.session(H.pane).status("")')

    // A newer tabby-rdp (given here; the suites don't ask npm): a note once, the menu item, the settings page's banner.
    await ev('H.config.store.remoteDesktop.updateNoted = ""; H.config.save()')
    t.onCleanup(() => ev('RD.updates.check("0.0.1"); H.config.store.remoteDesktop.updateNoted = ""; H.config.save()'))
    await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.pane)))')
    await sleep(300)
    check('an older version is not offered', await ev('return await RD.updates.check("0.0.1")') === null)
    check('a newer one is', await ev('return await RD.updates.check("9.9.9")') === '9.9.9')
    const updateNote = await t.waitFor('return H.pane.element.nativeElement.querySelector(".trd-note")?.innerText || null', 3)
    check('a note says so, with Upgrade', /tabby-rdp 9\.9\.9 is available/.test(updateNote ?? '') && /Upgrade/.test(updateNote ?? ''), updateNote)
    await ev('H.pane.element.nativeElement.querySelector(".trd-note [data-ok]").click()')
    await ev('await RD.updates.check("9.9.9")')
    await sleep(500)
    check('... once per version', !(await ev('return !!H.pane.element.nativeElement.querySelector(".trd-note")')))
    const updateItem = await ev('return (await H.menu(H.pane)).map(i => i.label).find(l => /^Update available/.test(l ?? "")) ?? null')
    check('the menu offers it', updateItem === 'Update available: 9.9.9…', updateItem)
    await ev('RD.help.open()')
    const banner = await t.waitFor('return H.page()?.querySelector("[data-update]")?.innerText || null', 5)
    check('the settings page says so', /tabby-rdp 9\.9\.9 is available/.test(banner ?? ''), banner)
    await ev('H.page().querySelector("[data-update] [data-upgrade]").click()')
    check('Upgrade opens Tabby\'s Plugins page', !!(await t.waitFor('return H.settingsTab()?.activeTab === "plugins" || null', 3)))
    await ev('await H.closeSettings()')
})
