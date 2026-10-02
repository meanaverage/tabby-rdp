// "Add a desktop behind <host>…", "Edit a desktop" and "Remove a desktop", on a Linux desktop host (TRD_TEST_HOST).
// No Windows needed: the added desktop is the host's own GNOME Remote Desktop, reached as 127.0.0.1:3389 with the
// plugin's generated account, so it goes through the same form, sign-in and keychain path a Windows machine would.
import { suite } from '../lib/harness.js'
import type { ExtraDesktopConfig } from '../../src/desktops.js'

const NAME = 'GNOME as an extra'
const ID = '127.0.0.1:3389'
// After editing: the same server under another address, so the desktop's keys have to move.
const EDITED = 'GNOME, edited'
const EDITED_ID = 'localhost:3389'

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
        async editMenu () { return (await H.menu(H.pane)).find(i => i.label === 'Settings').submenu.find(i => i.label === 'Edit a desktop') },
        formValues () {
            const f = H.form()
            return f && Object.fromEntries([...f.querySelectorAll('input[name], select[name]')].map(x => [x.name, x.value]))
        },
    })`)
    const saved = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.save() })`))
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${saved}; H.config.save() })`))
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = []; H.config.save() })`)

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    // The host's own desktop once, so its account exists (the setup creates it).
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('own desktop connected (account created)', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    const password = (await t.remote('H.pane', 'cat ~/.local/share/tabby-rdp/rdp-password')).trim()
    const key = await ev<string>(`return (await RD.targets.targetOf(H.pane)).key + '#${ID}'`)
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
    const entry = await t.waitFor<ExtraDesktopConfig>(`return (H.config.store.remoteDesktop.desktops ?? [])[0]`, 5)
    check('saved to remoteDesktop.desktops', entry?.name === NAME && entry.host === '127.0.0.1' && entry.port === 3389 && entry.kind === 'gnome' && entry.username === 'tabby' && !!entry.via, entry)
    check('sign-in form for the new desktop, user name filled in', !!(await t.waitFor(`return H.signin()?.querySelector('[name=username]').value === 'tabby'`, 10)))
    await ev(`const f = H.signin(); f.querySelector('[name=password]').value = ${JSON.stringify(password)}; f.requestSubmit()`)
    check('the added desktop connects', !!(await t.waitFor(`return H.connected(H.pane) && RD.desktop.desktopOf(H.pane)?.id === ${JSON.stringify(ID)}`, 40)), await ev('return RD.desktop.logOf(H.pane).slice(-3)'))
    const labels = await ev<string[]>('return await H.labels()')
    check('the menus name it, and still offer the own desktop', labels.includes(`Open ${host} desktop`) && labels.includes('Back to console'), labels)
    if (keychainWorks) {
        check('the account is saved in the keychain', !!(await t.waitFor(`return await require('keytar').getPassword('tabby-rdp', ${JSON.stringify(key)})`, 5)))
    } else {
        t.skip('the account is saved in the keychain', 'the system keychain does not answer (Linux: no unlocked keyring)')
    }
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 4. Edit it: the form comes filled in; a new name and address are saved, and the saved account and the desktop's
    // own sharpness move to the new address.
    const editedKey = key.replace(/#.*$/, `#${EDITED_ID}`)
    const sharpness = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktopSharpness ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktopSharpness = ${sharpness}; H.config.save() })`))
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktopSharpness = [{ desktop: ${JSON.stringify(key)}, sharpness: 'standard' }]; H.config.save() })`)
    if (keychainWorks) {
        t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(editedKey)})`))
    }
    const edit = await ev<string[]>('return (await H.editMenu())?.submenu.map(i => i.label) ?? []')
    check('the settings list it under "Edit a desktop"', edit.length === 1 && edit[0].startsWith(NAME), edit)
    const openEdit = () => ev('const m = await H.editMenu(); H.inZone(() => m.submenu[0].click())')
    await openEdit()
    const filled = await t.waitFor<{ name: string, address: string, kind: string, username: string }>('return H.formValues()', 5)
    check('the edit form is filled in from the entry', filled?.name === NAME && filled.address === ID && filled.kind === 'gnome' && filled.username === 'tabby', filled)
    await ev(`H.fill({ name: ${JSON.stringify(EDITED)}, address: ${JSON.stringify(EDITED_ID)} })`)
    const edited = await t.waitFor<ExtraDesktopConfig>(`const d = (H.config.store.remoteDesktop.desktops ?? [])[0]; return d?.name === ${JSON.stringify(EDITED)} ? d : null`, 5)
    check('the edited entry is saved (same host, new address)', edited?.host === 'localhost' && edited.port === 3389 && edited.via === entry?.via && edited.username === 'tabby', edited)
    // These move after the saved account, which the keychain can take a moment for.
    check('its remembered certificate moved to the new address', !!(await t.waitFor(`const list = H.config.store.remoteDesktop.trustedCertificates ?? []
        return list.some(e => e.desktop === ${JSON.stringify(editedKey)}) && !list.some(e => e.desktop === ${JSON.stringify(key)})`, 15)))
    check('its sharpness moved to the new address', !!(await t.waitFor(`const list = H.config.store.remoteDesktop.desktopSharpness ?? []
        return list.some(e => e.desktop === ${JSON.stringify(editedKey)}) && !list.some(e => e.desktop === ${JSON.stringify(key)})`, 15)))
    const renamed = await ev<string[]>('return await H.labels()')
    check('the menus offer it under its new name', renamed.includes(`Open ${EDITED}`) && !renamed.some(l => (l ?? '').includes(NAME)), renamed)
    if (keychainWorks) {
        check('its saved account moved to the new address', !!(await t.waitFor(`return await require('keytar').getPassword('tabby-rdp', ${JSON.stringify(editedKey)})`, 5)) &&
            !(await t.keychain(`getPassword('tabby-rdp', ${JSON.stringify(key)})`)))
        await ev(`await H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(EDITED_ID)}))`)
        const reopened = await t.waitFor(`return H.connected(H.pane) && RD.desktop.desktopOf(H.pane)?.id === ${JSON.stringify(EDITED_ID)}`, 40)
        check('it opens at the new address with the moved account, no form', !!reopened && !(await ev('return !!H.signin()')), await ev('return RD.desktop.logOf(H.pane).slice(-3)'))
        await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
        // A new user name: the saved account was for the old one, so it goes.
        await openEdit()
        await t.waitFor('return !!H.form()', 5)
        await ev(`H.fill({ username: 'someone-else' })`)
        await t.waitFor(`return (H.config.store.remoteDesktop.desktops ?? [])[0]?.username === 'someone-else'`, 5)
        await sleep(500)
        check('a new user name drops the saved account', !(await t.keychain(`getPassword('tabby-rdp', ${JSON.stringify(editedKey)})`)))
    } else {
        t.skip('saved accounts follow an edit', 'the system keychain does not answer (Linux: no unlocked keyring)')
    }
    await openEdit()
    await t.waitFor('return !!H.form()', 5)
    await t.escape()
    await sleep(300)
    check('Escape leaves the entry as it was', await ev(`return !H.form() && (H.config.store.remoteDesktop.desktops ?? [])[0]?.name === ${JSON.stringify(EDITED)}`))

    // 5. Remove it from the settings menu: config and keychain entry gone, no longer offered.
    const remove = await ev<string[]>('return (await H.removeMenu()).submenu.map(i => i.label)')
    check('the settings list it under "Remove a desktop"', remove.length === 1 && remove[0].startsWith(EDITED), remove)
    // It asks first (the dialog is answered here: Remove).
    await ev(`const p = RD.injector.get(require('tabby-core').PlatformService); H.origBox = p.showMessageBox
        p.showMessageBox = async o => { H.box = o; return { response: 0 } }`)
    t.onCleanup(() => ev(`const p = RD.injector.get(require('tabby-core').PlatformService); if (H.origBox) p.showMessageBox = H.origBox`))
    await ev('const m = await H.removeMenu(); H.inZone(() => m.submenu[0].click())')
    await sleep(500)
    const box = await ev<{ message: string, buttons: string[] } | null>('return H.box ? { message: H.box.message, buttons: H.box.buttons } : null')
    check('Remove asks first, naming the desktop', !!box && box.message.includes(EDITED) && box.buttons[0] === 'Remove', box)
    check('removed from the config', await ev('return (H.config.store.remoteDesktop.desktops ?? []).length === 0'))
    if (keychainWorks) {
        check('its keychain entry removed', !(await t.keychain(`getPassword('tabby-rdp', ${JSON.stringify(editedKey)})`)))
    }
    check('no longer offered', !(await ev<string[]>('return await H.labels()')).some(l => (l ?? '').includes(EDITED)))
})
