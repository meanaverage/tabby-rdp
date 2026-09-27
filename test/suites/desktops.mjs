// "Add a desktop behind <host>…" and "Remove a desktop", on a Linux desktop host (TRD_TEST_HOST). No Windows needed:
// the added desktop is the host's own GNOME Remote Desktop, reached as 127.0.0.1:3389 with the plugin's generated
// account, so it goes through the same form, sign-in and keychain path a Windows machine would.
import { suite } from '../lib/harness.mjs'

const NAME = 'GNOME as an extra'
const ID = '127.0.0.1:3389'

await suite('desktops', async t => {
    const { ev, check, sleep } = t
    const host = t.env.host
    await t.settings({ desk: true })
    await ev(`Object.assign(H, {
        form () { return H.pane.element.nativeElement.querySelector('.trd-form-overlay form') },
        fill (values) {
            const f = H.form()
            for (const [k, v] of Object.entries(values)) f.querySelector('[name=' + k + ']').value = v
            f.requestSubmit()
        },
        signin () { return H.overlay(H.pane)?.querySelector('.trd-signin form') ?? null },
        textareasDisabled () { return [...H.pane.element.nativeElement.querySelectorAll('textarea.xterm-helper-textarea')].map(x => x.disabled) },
        async labels () { return (await H.menuItems(H.pane)).map(i => i.label) },
        async removeMenu () { return (await H.menu(H.pane)).find(i => i.label === 'Settings').submenu.find(i => i.label === 'Remove a desktop') },
    })`)
    const saved = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${saved}; H.config.save() })`))
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = []; H.config.save() })`)

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    // The host's own desktop once, so its account exists (the setup creates it).
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('own desktop connected (account created)', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    const password = (await t.remote('H.pane', 'cat ~/.local/share/tabby-rdp/rdp-password')).trim()
    const key = await ev(`return (await RD.targets.targetOf(H.pane)).key + '#${ID}'`)
    const keychainWorks = await t.keychainWorks()
    if (keychainWorks) {
        await t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`)
        t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`))
    }

    // 1. The menu offers adding one.
    const add = await ev(`return (await H.labels()).find(l => /^Add a desktop behind/.test(l ?? ''))`)
    check(`the menu offers "Add a desktop behind ${host}…"`, add === `Add a desktop behind ${host}…`, add)

    // 2. Escape cancels: nothing saved, the terminal can type again.
    ev(`H.inZone(() => RD.desktop.addDesktop(H.pane))`)
    check('form shows, name field focused, terminal input disabled', !!(await t.waitFor(`return H.form() && document.activeElement?.name === 'name' && H.textareasDisabled().every(Boolean)`, 5)))
    await t.escape()
    await sleep(300)
    check('Escape cancels: form gone, nothing saved, terminal input back', await ev(`return !H.form() && (H.config.store.remoteDesktop.desktops ?? []).length === 0 && H.textareasDisabled().every(d => !d)`))

    // 3. Add: a bad address is refused; a good one is saved (via the resolved hostname) and opened.
    ev(`H.inZone(() => RD.desktop.addDesktop(H.pane))`)
    await t.waitFor('return !!H.form()', 5)
    await ev(`H.fill({ name: ${JSON.stringify(NAME)}, address: 'not an address', kind: 'gnome', username: 'tabby' })`)
    await sleep(200)
    check('a bad address is refused with a message', await ev(`return /address/i.test(H.form()?.querySelector('.trd-signin-error')?.textContent ?? '')`))
    await ev(`H.fill({ address: ${JSON.stringify(ID)} })`)
    const entry = await t.waitFor(`return (H.config.store.remoteDesktop.desktops ?? [])[0]`, 5)
    check('saved to remoteDesktop.desktops', entry?.name === NAME && entry.host === '127.0.0.1' && entry.port === 3389 && entry.kind === 'gnome' && entry.username === 'tabby' && !!entry.via, entry)
    check('sign-in form for the new desktop, user name filled in', !!(await t.waitFor(`return H.signin()?.querySelector('[name=username]').value === 'tabby'`, 10)))
    await ev(`const f = H.signin(); f.querySelector('[name=password]').value = ${JSON.stringify(password)}; f.requestSubmit()`)
    check('the added desktop connects', !!(await t.waitFor(`return H.connected(H.pane) && RD.desktop.desktopOf(H.pane)?.id === ${JSON.stringify(ID)}`, 40)), await ev('return RD.desktop.logOf(H.pane).slice(-3)'))
    const labels = await ev('return await H.labels()')
    check('the menus name it, and still offer the own desktop', labels.includes(`Open ${host} desktop`) && labels.includes('Back to console'), labels)
    if (keychainWorks) {
        check('the account is saved in the keychain', !!(await t.waitFor(`return await require('keytar').getPassword('tabby-rdp', ${JSON.stringify(key)})`, 5)))
    } else {
        t.skip('the account is saved in the keychain', 'the system keychain does not answer (Linux: no unlocked keyring)')
    }
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 4. Remove it from the settings menu: config and keychain entry gone, no longer offered.
    const remove = await ev('return (await H.removeMenu()).submenu.map(i => i.label)')
    check('the settings list it under "Remove a desktop"', remove.length === 1 && remove[0].startsWith(NAME), remove)
    await ev('const m = await H.removeMenu(); H.inZone(() => m.submenu[0].click())')
    await sleep(500)
    check('removed from the config', await ev('return (H.config.store.remoteDesktop.desktops ?? []).length === 0'))
    if (keychainWorks) {
        check('its keychain entry removed', !(await t.keychain(`getPassword('tabby-rdp', ${JSON.stringify(key)})`)))
    }
    check('no longer offered', !(await ev('return await H.labels()')).some(l => (l ?? '').includes(NAME)))
})
