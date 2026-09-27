// "Remote desktop (RDP)" profiles, on a Linux desktop host (TRD_TEST_HOST), using its GNOME Remote Desktop with the
// plugin's generated account as the RDP server (no Windows needed):
// - a direct one: its own tab, a plain TCP connection from here to TRD_TEST_HOST:3389 (skipped if that port can't be
//   reached from here, e.g. firewalled to the loopback as docs/architecture.md suggests);
// - one going through a saved SSH profile: it opens that profile's SSH tab and shows the desktop over it;
// - .rdp files: the parser, and importing one as a profile.
import { suite } from '../lib/harness.mjs'

const DIRECT = 'Direct (test)'
const VIA = 'Through SSH (test)'

await suite('profiles', async t => {
    const { ev, check, sleep } = t
    const host = t.env.host
    await ev(`Object.assign(H, {
        profiles () { return RD.injector.get(require('tabby-core').ProfilesService) },
        provider () { return H.profiles().getProviders().find(p => p.id === 'rdp') },
        /** Opens a profile; returns the new pane (a remote desktop tab, or an SSH tab). */
        async openProfile (profile) {
            const before = new Set(H.panes())
            await H.inZone(() => H.profiles().openNewTabForProfile(profile))
            for (let i = 0; i < 40; i++) {
                const pane = H.panes().find(p => !before.has(p))
                if (pane) {
                    H.opened.push(pane)
                    return pane
                }
                await new Promise(r => setTimeout(r, 100))
            }
            return null
        },
        signin (p) {
            const f = H.overlay(p)?.querySelector('.trd-signin form')
            return f ? { user: f.querySelector('[name=username]').value, title: f.parentElement.querySelector('.trd-signin-title').textContent } : null
        },
        submit (p, password) {
            const f = H.overlay(p).querySelector('.trd-signin form')
            f.querySelector('[name=password]').value = password
            f.requestSubmit()
        },
        idle (p) { const e = p.element.nativeElement.querySelector('.trd-rdp-idle'); return e && e.style.display !== 'none' ? e.textContent : null },
        async labels (p) { return (await H.menu(p)).map(i => i.label) },
    })`)
    const profilesBefore = await ev('return JSON.stringify(H.config.store.profiles ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.profiles = ${profilesBefore}; H.config.save() })`))

    // 0. The host's own desktop once, so that its account exists; then its password.
    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('own desktop connected (account created)', !!(await t.waitFor('return H.connected(H.pane)', 40)))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    const password = (await t.remote('H.pane', 'cat ~/.local/share/tabby-rdp/rdp-password')).trim()
    const sshKey = await ev('return (await RD.targets.targetOf(H.pane)).key')
    const keychainWorks = await t.keychainWorks()
    const directKey = `rdp#${host}:3389`
    const viaKey = `${sshKey}#127.0.0.1:3389`
    if (keychainWorks) {
        for (const k of [directKey, viaKey]) {
            await t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(k)})`)
            t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(k)})`))
        }
    }

    // 1. The profile type: a template in Tabby's profile list, quick connect.
    check('"Remote desktop (RDP)" is a profile type with a template', await ev(`const p = H.provider(); return !!p && (await p.getBuiltinProfiles()).some(x => x.isTemplate && x.type === 'rdp')`))
    const quick = await ev(`return H.provider().quickConnect('alice@${host}:3390')`)
    check('quick connect: user@host:port', quick?.type === 'rdp' && quick.options.host === host && quick.options.port === 3390 && quick.options.username === 'alice', quick)

    // 2. A direct profile: its own tab, filled by the desktop.
    const reachable = await ev(`return await new Promise(resolve => {
        const s = require('net').connect(3389, ${JSON.stringify(host)})
        const done = ok => { s.destroy(); resolve(ok) }
        s.once('connect', () => done(true)); s.once('error', () => done(false)); setTimeout(() => done(false), 3000)
    })`)
    if (!reachable) {
        t.skip('a direct remote desktop tab', `${host}:3389 can't be reached from this machine`)
    } else {
        const direct = { type: 'rdp', name: DIRECT, options: { host, port: 3389, kind: 'gnome', username: 'tabby', via: '' } }
        const tabs = await ev('return RD.app.tabs.length')
        check('the profile opens a tab', await ev(`H.rdp = await H.openProfile(${JSON.stringify(direct)}); return !!H.rdp`))
        check('it is a remote desktop tab (no terminal)', await ev('return RD.desktopPaneOf(H.rdp) === H.rdp && !H.rdp.frontend && !H.rdp.element.nativeElement.querySelector(".xterm")'))
        const form = await t.waitFor('return H.signin(H.rdp)', 20)
        check('sign-in form: the profile\'s name, its user name filled in', form?.title === `Sign in to ${DIRECT}` && form.user === 'tabby', form)
        await ev(`H.submit(H.rdp, ${JSON.stringify(password)})`)
        check('the direct desktop connects', !!(await t.waitFor('return H.connected(H.rdp)', 40)), await ev('return RD.desktop.logOf(H.rdp).slice(-4)'))
        check('connected directly, not via a host', await ev(`return RD.desktop.logOf(H.rdp).some(l => l.includes(${JSON.stringify(`Connecting to ${DIRECT}…`)}))`))
        const frame = await t.waitFor('const c = H.canvas(H.rdp); return c?.colors > 3 ? c : null', 10)
        check('picture drawn, sized to the tab', !!frame && Math.abs(frame.w - frame.paneW) <= 2 && Math.abs(frame.h - frame.paneH) <= 2, frame)
        const labels = await ev('return await H.labels(H.rdp)')
        check('its menu has no console or host entries', !labels.includes('Back to console') && !labels.some(l => /^Add a desktop behind/.test(l ?? '')) && labels.includes('Disconnect remote desktop'), labels)
        await ev('await H.inZone(() => RD.desktop.toggle(H.rdp))')
        check('the desktop/console switch leaves it showing', await ev('return RD.desktop.isVisible(H.rdp)'))
        await sleep(100)
        check('the header offers no console switch', await ev(`return document.querySelector('.trd-header-toggle')?.style.display === 'none'`))
        if (keychainWorks) {
            check('the account is saved under rdp#<address>', !!(await t.waitFor(`return await require('keytar').getPassword('tabby-rdp', ${JSON.stringify(directKey)})`, 5)))
        }
        const token = await ev('return await H.rdp.getRecoveryToken()')
        check('the tab can be restored (recovery token)', token?.type === 'app:rdp-tab' && token.profile?.options?.host === host, token)

        // Opened again: the tab that has it comes forward, no second tab.
        await ev(`await H.openProfile(${JSON.stringify(direct)})`)
        await sleep(1000)
        check('opening it again switches to its tab instead of a second one', await ev(`return RD.app.tabs.length === ${tabs + 1} && H.topOf(H.rdp) === RD.app.activeTab`), await ev('return RD.app.tabs.length'))

        // Disconnect: the tab says so and offers Connect, which reconnects (with the saved account: no form).
        await ev('H.inZone(() => RD.desktop.disconnect(H.rdp))')
        await sleep(200)
        check('after Disconnect the tab offers Connect', /not connected/.test(await ev('return H.idle(H.rdp)') ?? ''))
        await ev(`H.inZone(() => H.rdp.element.nativeElement.querySelector('.trd-rdp-idle button').click())`)
        if (keychainWorks) {
            check('Connect reconnects with the saved account', !!(await t.waitFor('return H.connected(H.rdp)', 40)) && !(await ev('return H.signin(H.rdp)')))
        } else {
            check('Connect brings the sign-in form back', !!(await t.waitFor('return H.signin(H.rdp)', 20)))
        }
        await ev('H.inZone(() => RD.desktop.disconnect(H.rdp))')
    }

    // 3. Through a saved SSH profile: the profile opens that SSH tab and shows the desktop over it.
    const ssh = await ev(`const p = H.profile({ name: 'SSH for RDP (test)' }); p.id = 'ssh:trd-test-via'; return p`)
    const via = { id: 'rdp:trd-test-via', type: 'rdp', name: VIA, options: { host: '127.0.0.1', port: 3389, kind: 'gnome', username: 'tabby', via: ssh.id } }
    await ev(`H.inZone(() => { H.config.store.profiles = [...H.config.store.profiles, ${JSON.stringify(ssh)}, ${JSON.stringify(via)}]; H.config.save() })`)
    check('its description names the SSH profile', await ev(`return H.provider().getDescription(${JSON.stringify(via)})`) === '127.0.0.1:3389 via SSH for RDP (test)')
    check('the profile opens an SSH tab', await ev(`H.via = await H.openProfile(H.config.store.profiles.find(p => p.id === ${JSON.stringify(via.id)})); return H.via?.profile?.type === 'ssh'`))
    for (let i = 0; i < 160 && !(await ev('return !!H.via.sshSession?.open')); i++) {
        await ev(`const a = [...document.querySelectorAll('ngb-modal-window button')].find(b => /Accept and remember/.test(b.innerText)); if (a) H.inZone(() => a.click())`)
        await sleep(250)
    }
    const viaForm = await t.waitFor('return H.signin(H.via)', 30)
    check('once SSH is up, the desktop shows over it, with the sign-in form', !!viaForm && viaForm.title === `Sign in to ${VIA} (via ${host})` && viaForm.user === 'tabby', viaForm)
    check('it is the profile\'s desktop', await ev('return RD.desktop.desktopOf(H.via)?.id') === '127.0.0.1:3389')
    await ev(`H.submit(H.via, ${JSON.stringify(password)})`)
    check('the desktop behind the SSH profile connects', !!(await t.waitFor('return H.connected(H.via)', 40)), await ev('return RD.desktop.logOf(H.via).slice(-4)'))
    const viaLabels = await ev('return await H.labels(H.via)')
    check('that SSH tab offers the console and its own desktop too', viaLabels.includes('Back to console') && viaLabels.includes(`Open ${host} desktop`), viaLabels)
    await ev('H.inZone(() => RD.desktop.disconnect(H.via))')
    const otherLabels = await ev('return await H.labels(H.pane)')
    check('an SSH tab not opened from that SSH profile doesn\'t list it', !otherLabels.some(l => (l ?? '').includes(VIA)), otherLabels)
    if (keychainWorks) {
        await ev(`await H.inZone(() => H.profiles().deleteProfile(H.config.store.profiles.find(p => p.id === ${JSON.stringify(via.id)})))`)
        check('deleting a profile behind a host keeps that host\'s saved account', !!(await t.keychain(`getPassword('tabby-rdp', ${JSON.stringify(viaKey)})`)))
    }

    // 4. .rdp files: the parser (UTF-16LE with a byte order mark, as mstsc writes them; UTF-8), then an import.
    const utf16 = text => `Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(${JSON.stringify(text)}, 'utf16le')])`
    const parsed = await ev(`return RD.parseRdpFile(${utf16('screen mode id:i:2\r\nfull address:s:pc.example:3390\r\nusername:s:CORP\\alice\r\ndomain:s:CORP\r\n')})`)
    check('.rdp (UTF-16LE): address, port, user name, domain', parsed?.host === 'pc.example' && parsed.port === 3390 && parsed.username === 'CORP\\alice' && parsed.domain === 'CORP', parsed)
    const utf8 = await ev(`return RD.parseRdpFile(Buffer.from('full address:s:[fe80::1]\\nserver port:i:3391\\n'))`)
    check('.rdp (UTF-8): an IPv6 address, the port from "server port"', utf8?.host === 'fe80::1' && utf8.port === 3391, utf8)
    check('.rdp without an address: refused', await ev(`return RD.parseRdpFile(Buffer.from('audiomode:i:0\\n')) === null`))
    const menu = await ev(`return (await H.menu(H.pane)).find(i => i.label === 'Remote desktop settings').submenu.map(i => i.label)`)
    check('the settings menu offers "Import an .rdp file…"', menu.includes('Import an .rdp file…'), menu)
    check('so does the command palette', await ev(`const { CommandProvider } = require('tabby-core')
        return (await Promise.all(RD.injector.get(CommandProvider).map(p => p.provide({})))).flat().some(c => c.id === 'tabby-rdp:import-rdp-file')`))
    const file = utf16(`full address:s:${host}\r\nusername:s:tabby\r\n`)
    const importOnce = () => ev(`const before = new Set(H.panes())
        const profile = await H.inZone(() => RD.desktop.importRdp(${file}, '/somewhere/Imported (test).rdp'))
        await new Promise(r => setTimeout(r, 500))
        H.opened.push(...H.panes().filter(p => !before.has(p)))
        return { profile: profile && JSON.parse(JSON.stringify(profile)), count: H.config.store.profiles.filter(p => p.type === 'rdp' && p.name === 'Imported (test)').length }`)
    const imported = await importOnce()
    check('import: a profile named after the file, with the address and user name', imported.count === 1 && imported.profile?.type === 'rdp' && imported.profile.options.host === host &&
        imported.profile.options.port === 3389 && imported.profile.options.username === 'tabby' && !imported.profile.options.via, imported)
    check('import: the new profile opens in a remote desktop tab', !!(await t.waitFor(`const p = H.panes().find(p => p.profile?.type === 'rdp' && p.profile.name === 'Imported (test)'); return p && RD.desktopPaneOf(p) === p`, 5)))
    const again = await importOnce()
    check('importing the same file again opens that profile instead of adding one', again.count === 1, again)
})
