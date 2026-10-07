// Help, on a Linux desktop host (TRD_TEST_HOST): Settings › Remote Desktop (opened from the menu and at a section,
// its settings following the config both ways, remembered certificates, open desktops), the one-time tip on the first
// connection, and "What does this mean?" under a message that ends a connection.
import { suite } from '../lib/harness.js'
import { rendererErrors } from '../lib/smoke.js'

await suite('help', async t => {
    const { ev, check, sleep } = t
    const errors = await rendererErrors(t)
    t.onCleanup(async () => {
        await ev('await H.closeAll()')
        await sleep(1000)
        errors()
    })
    await ev(`Object.assign(H, {
        settingsTab () { const { SettingsTabComponent } = require('tabby-settings'); return RD.app.tabs.find(x => x instanceof SettingsTabComponent) ?? null },
        page () { return document.querySelector('.trd-settings') },
        async closeSettings () { const s = H.settingsTab(); if (s) await H.inZone(() => RD.app.closeTab(s, false)) },
        async helpItem () { return (await H.menu(H.pane)).find(i => i.label === 'Settings').submenu.find(i => /help/i.test(i.label ?? '')) },
        tip () { return H.overlay(H.pane)?.querySelector('.trd-tip') ?? null },
    })`)
    t.onCleanup(() => ev('await H.closeSettings()'))
    // Isolate every release/external-link action for the whole suite: opening Settings must not reach npm or a browser.
    await ev(`await RD.updates.ready; if (RD.updates.inFlight) await RD.updates.inFlight;
        H.releaseBefore = { env: { ...RD.updates.env }, state: { ...RD.updates.state }, catalog: RD.updates.catalog,
            checkedAt: RD.updates.checkedAt, lastAttempt: RD.updates.lastAttempt, error: RD.updates.error,
            catalogError: RD.updates.catalogError, updateNoted: H.config.store.remoteDesktop.updateNoted };
        H.externalBefore = RD.help.platform.openExternal; H.externalURLs = [];
        RD.help.platform.openExternal = url => H.externalURLs.push(url);
        H.releaseCatalog = { versions: [], stable: null, preview: null };
        let localState = JSON.stringify({ channel: 'stable', paused: false, rollbackFloor: '0.5.1' });
        Object.assign(RD.updates.env, {
            storage: { getItem: () => localState, setItem: (_key, value) => { localState = value } },
            fetchCatalog: async () => H.releaseCatalog,
            install: async () => { throw new Error('Package installation is disabled in this suite') },
            uninstall: async () => { throw new Error('Package removal is disabled in this suite') },
            confirm: async () => false,
        });
        RD.updates.syncFromStorage(); RD.updates.catalog = null; RD.updates.lastAttempt = -Infinity;
        H.offerVersion = async version => {
            H.releaseCatalog = { stable: version, preview: null, versions: [{ version, deprecated: false,
                policy: { minimumTabbyVersion: '1.0.236', rollbackFloor: '0.5.1' } }] };
            RD.updates.lastAttempt = -Infinity;
            return await RD.updates.check();
        };
    `)
    t.onCleanup(() => ev(`if (RD.updates.inFlight) await RD.updates.inFlight;
        Object.assign(RD.updates.env, H.releaseBefore.env);
        for (const key of Object.keys(RD.updates.state)) delete RD.updates.state[key];
        Object.assign(RD.updates.state, H.releaseBefore.state);
        Object.assign(RD.updates, { catalog: H.releaseBefore.catalog, checkedAt: H.releaseBefore.checkedAt,
            lastAttempt: H.releaseBefore.lastAttempt, error: H.releaseBefore.error, catalogError: H.releaseBefore.catalogError });
        RD.help.platform.openExternal = H.externalBefore;
        H.config.store.remoteDesktop.updateNoted = H.releaseBefore.updateNoted; H.config.save();
        RD.updates.changed$.next();
    `))
    await t.settings({ sound: false, microphone: false, clipboard: 'off', sharpness: 'standard', resize: 'live' })
    const tipShown = await ev('return H.config.store.remoteDesktop.tipShown')
    t.onCleanup(() => ev(`H.config.store.remoteDesktop.tipShown = ${JSON.stringify(tipShown)}; H.config.save()`))
    await ev('H.config.store.remoteDesktop.tipShown = false; H.config.save()')

    // The tip: the first connection, once.
    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    const tip = await t.waitFor<string>('return H.tip()?.innerText ?? null', 3)
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
    const named = await ev<{ label: string, hostname: string }>(`const p = await H.openSSH({ name: 'lab-1 (.ssh/config)' }); const t = await RD.targets.targetOf(p); return { label: t.label, hostname: t.hostname }`)
    check('a host is called by its profile\'s name (without Tabby\'s "(.ssh/config)")', named.label === 'lab-1' && named.hostname === t.env.host, named)

    // The page, from the menu.
    const item = await ev('const i = await H.helpItem(); return i?.label ?? null')
    check('the settings menu offers the page', !!item, item)
    await ev('const i = await H.helpItem(); H.inZone(() => i.click())')
    check('Settings opens at Remote Desktop', !!(await t.waitFor('return H.settingsTab()?.activeTab === "remote-desktop" && !!H.page()', 5)))
    check('it is in the sidebar', await ev('return [...document.querySelectorAll("settings-tab .nav-link")].some(a => a.textContent.trim() === "Remote Desktop")'))
    const sections = await ev<string[]>('return [...H.page().querySelectorAll("[data-topic]")].map(s => s.dataset.topic)')
    check('its sections', ['start', 'settings', 'keyboard', 'desktops', 'accounts', 'certificates', 'updates'].every(s => sections.includes(s)), sections)

    // The tabs along the top (as Tabby's Profiles & connections page has): one body shows at a time, help opens the right one.
    const tabs = await ev<string[]>('return [...H.page().querySelectorAll("[data-tab]")].map(a => a.textContent)')
    check('tabs: Getting started, Settings, Overlay, Desktops, Accounts, Updates', tabs.join('|') === 'Getting started|Settings|Overlay|Desktops|Accounts|Updates', tabs)
    await ev('H.page().querySelector("[data-tab=accounts]").click()')
    check('clicking a tab shows its body alone', await ev('return [...H.page().querySelectorAll("[data-body]")].filter(b => !b.hidden).map(b => b.dataset.body).join() === "accounts"'))
    await ev('RD.help.open("certificates")')
    check('help opens the tab holding a section', !!(await t.waitFor('return [...H.page().querySelectorAll("[data-body]")].filter(b => !b.hidden).map(b => b.dataset.body).join() === "desktops"', 3)))

    check('troubleshooting is a header link', await ev('return [...H.page().querySelectorAll(".trd-links [data-link]")].some(a => a.dataset.link.endsWith("TROUBLESHOOTING.md"))'))
    check('troubleshooting follows Ask a question and has no settings tab', await ev(`
        const question = H.page().querySelector('.trd-links [data-link$="/q-a"]');
        return question?.nextElementSibling?.textContent === 'Troubleshooting' &&
            !H.page().querySelector('[data-tab=troubleshooting], [data-topic=troubleshooting]');
    `))
    check('the desktop empty state uses concise text', await ev('return H.page().querySelector("[data-list=desktops]").textContent.trim() === "No saved desktops."'))
    await ev('RD.help.open("updates")')
    check('version and all update controls are on Updates', !!await t.waitFor(`
        const body = H.page().querySelector('[data-body=updates]');
        return body && !body.hidden && body.textContent.includes('tabby-rdp ' + RD.updates.running) &&
            ['[data-channel]', '[data-pause]', '[data-check]', '[data-version]', '[data-restore]', '[data-uninstall]', '[data-update]'].every(s => body.querySelector(s)) &&
            !H.page().querySelector('[data-body=settings] [data-setting=checkUpdates]');
    `, 3))
    await ev(`const select = H.page().querySelector('[data-channel]'); select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true }))`)
    check('Preview is an explicit persisted opt-in', !!await t.waitFor('return RD.updates.state.channel === "preview" && H.page().querySelector("[data-channel]").value === "preview"', 3), await ev('return { channel: RD.updates.state.channel, control: H.page().querySelector("[data-channel]").value, error: RD.updates.error }'))
    await ev(`const check = H.page().querySelector('[data-pause]'); check.checked = false; check.dispatchEvent(new Event('change', { bubbles: true }))`)
    check('automatic checks can be disabled from Updates', !!await t.waitFor('return RD.updates.state.paused && !H.page().querySelector("[data-pause]").checked', 3))
    await ev(`const check = H.page().querySelector('[data-pause]'); check.checked = true; check.dispatchEvent(new Event('change', { bubbles: true }))`)
    check('automatic checks can be enabled from Updates', !!await t.waitFor('return !RD.updates.state.paused && H.page().querySelector("[data-pause]").checked', 3))
    await ev(`await RD.updates.setChannel('stable')`)

    // Shortcuts: the plugin's hotkeys with Tabby's chips; a binding another hotkey has is refused; the switch has its default.
    await ev('RD.help.open("keyboard")')
    const rows = await ev<string[]>('return [...H.page().querySelectorAll("[data-list=hotkeys] .trd-hotkey-name")].map(e => e.textContent)')
    check('the shortcuts listed', rows.length === 8 && rows[0] === 'Switch between the desktop and the console', rows)
    const chips = await ev<string[]>('return [...H.page().querySelector("[data-list=hotkeys] .row").querySelectorAll(".stroke, .add")].map(e => e.textContent.trim())')
    check('the switch shows its binding as a chip, with Add…', chips.length === 2 && /G$/.test(chips[0]) && chips[1] === 'Add…', chips)
    await ev('H.config.store.hotkeys["remote-desktop-view-only"] = H.config.store.hotkeys["remote-desktop-toggle"]; H.config.save()')
    t.onCleanup(() => ev('H.config.store.hotkeys["remote-desktop-view-only"] = []; H.config.save()'))
    check('a collision made elsewhere is shown in red', !!(await t.waitFor('return H.page().querySelectorAll("[data-list=hotkeys] .duplicate").length === 2 && /also/.test(H.page().querySelector("[data-list=hotkeys] .trd-conflict")?.textContent ?? "")', 3)))
    await ev('H.config.store.hotkeys["remote-desktop-view-only"] = []; H.config.save()')

    // Accounts: added from the page, listed with its sign-in name, used by nothing yet; removed with its password.
    await ev('RD.help.open("accounts")')
    await ev('H.page().querySelector("[data-action=account]").click()')
    check('Add an account… opens the form', !!(await t.waitFor('return !!H.page().querySelector(".trd-account-form")', 2)))
    await ev(`const f = H.page().querySelector(".trd-account-form"); f.querySelector("[name=name]").value = "Lab admin"; f.querySelector("[name=username]").value = "labadmin"; f.querySelector("[name=domain]").value = "LAB"; f.requestSubmit()`)
    check('saved in the config', !!(await t.waitFor('return H.config.store.remoteDesktop.accounts?.some(a => a.name === "Lab admin" && a.username === "labadmin" && a.domain === "LAB" && /^[a-z0-9]{8}$/.test(a.id))', 3)), await ev('return H.config.store.remoteDesktop.accounts'))
    t.onCleanup(() => ev('H.config.store.remoteDesktop.accounts = (H.config.store.remoteDesktop.accounts ?? []).filter(a => a.name !== "Lab admin"); H.config.save()'))
    const accountRow = await t.waitFor<string>('return [...H.page().querySelectorAll("[data-list=accounts] .trd-row")].find(r => /Lab admin/.test(r.textContent))?.innerText ?? null', 3)
    check('listed with its sign-in name, unused', /LAB\\labadmin/.test(accountRow ?? '') && /Not used/.test(accountRow ?? ''), accountRow)
    check('the account dropdown of a desktop form offers it', await ev('return RD.desktop.accounts().some(a => a.name === "Lab admin")'))

    // Desktops: profiles and desktops behind hosts in one list; Add a desktop… is Tabby's profile editor.
    await ev('RD.help.open("desktops")')
    await ev('H.page().querySelector("[data-action=desktop]").click()')
    check('Add desktop… opens Tabby\'s profile editor for a remote desktop profile', !!(await t.waitFor('return !!document.querySelector(".modal rdp-profile-settings")', 4)))
    const accountOptions = await ev<string[]>('return [...document.querySelector(".modal rdp-profile-settings [name=account]").options].map(o => o.text)')
    check('its Account field offers the saved account and New account…', accountOptions.some(o => /Lab admin/.test(o)) && accountOptions.at(-1) === 'New account…', accountOptions)
    // The strip over the dialog, where the tab bar is (hit-tested at the corner: a small window's dialog covers the middle).
    check('the window stays draggable by its tab bar', await ev(`
        const modal = document.querySelector('.modal'), bar = modal?.querySelector(':scope > .trd-form-dragbar');
        const el = document.elementFromPoint(4, 4), native = modal && getComputedStyle(modal, '::before');
        return !!bar && getComputedStyle(bar).webkitAppRegion === 'drag' && el === bar ||
            !!native && native.content !== 'none' && native.content !== 'normal' && native.display !== 'none' &&
            native.getPropertyValue('-webkit-app-region') === 'drag' && parseFloat(native.height) > 4 && el === modal;
    `))
    await ev('RD.injector.get(require("@ng-bootstrap/ng-bootstrap").NgbModal).dismissAll()')
    await sleep(300)

    // Settings, both ways.
    await t.settings({ sound: true })
    check('the sound switch follows the configured value', !!await t.waitFor('return H.page().querySelector("[data-setting=sound]").checked', 3))
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
    const row = await t.waitFor<string>('return [...H.page().querySelectorAll("[data-list=certificates] .trd-row")].find(r => r.textContent.includes("192.0.2.1:3389"))?.textContent ?? null', 3)
    check('a remembered certificate is listed', !!row && row.includes('behind nobody@example.invalid'), row)
    await ev('[...H.page().querySelectorAll("[data-list=certificates] .trd-row")].find(r => r.textContent.includes("192.0.2.1:3389")).querySelector("button").click()')
    check('Forget forgets it', !!(await t.waitFor(`return !H.config.store.remoteDesktop.trustedCertificates.some(e => e.desktop === ${JSON.stringify(fake.desktop)})`, 2)))

    // Open desktops, with their logs.
    const session = await ev<string | null>('return H.page().querySelector("[data-list=sessions] .trd-row")?.textContent ?? null')
    check('the open desktop is listed', !!session && /connected/.test(session), session)

    check('Open desktops moved to Desktops', await ev('return H.page().querySelector("[data-list=sessions]").closest("[data-body]").dataset.body === "desktops"'))
    check('Copy log still copies diagnostic text', await ev(`const platform = RD.help.platform; const before = platform.setClipboard;
        let copied; platform.setClipboard = value => { copied = value };
        try { H.page().querySelector('[data-list=sessions] button').click(); return /tabby-rdp/.test(copied?.text ?? ''); }
        finally { platform.setClipboard = before; }`))

    // Topic help opens the linked guide at a stable anchor; the external opener is stubbed above.
    await ev('RD.help.open("troubleshooting", "certificate")')
    check('opens the certificate guide anchor', await ev('return H.externalURLs.at(-1)?.endsWith("TROUBLESHOOTING.md#certificate")'))
    await ev('await H.closeSettings()')
    await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.pane)))')
    await ev('H.session(H.pane).status("Remote desktop failed: Wrong user name or password.", [], true)')
    check('"What does this mean?" under a message that ends a connection', await ev('return H.overlay(H.pane).querySelector(".trd-status-help").style.display !== "none"'))
    await ev('H.inZone(() => H.overlay(H.pane).querySelector(".trd-status-help").click())')
    check('it opens the guide anchor for that message', await ev('return H.externalURLs.at(-1)?.endsWith("TROUBLESHOOTING.md#sign-in")'))
    await ev('H.session(H.pane).status("Connecting…")')
    check('not under other messages', await ev('return H.overlay(H.pane).querySelector(".trd-status-help").style.display === "none"'))
    await ev('H.session(H.pane).status("")')

    // A newer tabby-rdp (given here; the suites don't ask npm): a note once, the menu item, the settings page's banner.
    await ev('H.config.store.remoteDesktop.updateNoted = ""; H.config.save()')
    await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.pane)))')
    await sleep(300)
    check('an older version is not offered', await ev('return await H.offerVersion("0.0.1")') === null)
    check('a newer one is', await ev('return await H.offerVersion("9.9.9")') === '9.9.9')
    const updateNote = await t.waitFor<string>('return H.pane.element.nativeElement.querySelector(".trd-note")?.innerText || null', 3)
    check('a note says so, with Upgrade', /tabby-rdp 9\.9\.9 is available/.test(updateNote ?? '') && /Upgrade/.test(updateNote ?? ''), updateNote)
    await ev('H.pane.element.nativeElement.querySelector(".trd-note [data-ok]").click()')
    await ev('await H.offerVersion("9.9.9")')
    await sleep(500)
    check('... once per version', !(await ev('return !!H.pane.element.nativeElement.querySelector(".trd-note")')))
    const updateItem = await ev('return (await H.menu(H.pane)).map(i => i.label).find(l => /^Update available/.test(l ?? "")) ?? null')
    check('the menu offers it', updateItem === 'Update available: 9.9.9…', updateItem)
    await ev('RD.help.open("updates")')
    const banner = await t.waitFor<string>('return H.page()?.querySelector("[data-update]")?.innerText || null', 5)
    check('the settings page says so', /tabby-rdp 9\.9\.9 is available/.test(banner ?? ''), banner)
    await ev('H.page().querySelector("[data-update] [data-upgrade]").click()')
    check('Upgrade opens the Updates tab', !!(await t.waitFor('return H.settingsTab()?.activeTab === "remote-desktop" && H.page()?.querySelector("[data-body=updates]")?.hidden === false', 3)))
    await ev('await H.closeSettings()')
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    await sleep(250)
})
