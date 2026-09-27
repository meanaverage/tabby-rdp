// An SSH host that is itself Windows (OpenSSH Server on Windows; TRD_TEST_WIN_OPENSSH): the plugin finds out on the
// first connect, and the host's own desktop becomes its RDP server, signed in to with the Windows account, instead of
// the GNOME setup. See test/README.md.
import { suite } from '../lib/harness.mjs'

await suite('winhost', async t => {
    const { ev, check, sleep } = t
    const win = t.env.windows
    const m = /^(?:([^@]+)@)?([^@:]+)(?::(\d+))?$/.exec(process.env.TRD_TEST_WIN_OPENSSH ?? '')
    if (!m || !win.password) {
        t.skip('winhost', 'set TRD_TEST_WIN_OPENSSH (user@host of a Windows machine running OpenSSH Server) and TRD_TEST_WIN_PASSWORD')
        return
    }
    const [, user = win.account, host, port = '22'] = m
    await ev(`Object.assign(H, {
        signin () {
            const f = H.overlay(H.pane)?.querySelector('.trd-signin form')
            return f ? { user: f.querySelector('[name=username]').value, title: f.parentElement.querySelector('.trd-signin-title').textContent } : null
        },
        submit (user, password) {
            const f = H.overlay(H.pane).querySelector('.trd-signin form')
            f.querySelector('[name=username]').value = user
            f.querySelector('[name=password]').value = password
            f.requestSubmit()
        },
    })`)
    check('SSH tab to the Windows host connected', await ev(`H.pane = await H.openSSH({ host: ${JSON.stringify(host)}, user: ${JSON.stringify(user)}, port: ${Number(port)} }); return !!H.pane`))
    const key = await ev('return (await RD.targets.targetOf(H.pane)).key')
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.save() })`))
    const keychainWorks = await t.keychainWorks()
    if (keychainWorks) {
        await t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`)
        t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`))
    }

    // 1. The first open finds out: no GNOME setup error, but a sign-in form for the host's own desktop.
    const t0 = Date.now()
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    const form = await t.waitFor('return H.signin()', 30)
    t.time('open → sign-in form (detecting Windows)', Date.now() - t0)
    check('detected as Windows: a sign-in form, the SSH user filled in', form?.user === user, { form, log: await ev('return RD.desktop.logOf(H.pane)') })
    const spec = await ev('return RD.desktop.desktopOf(H.pane)')
    check('the host\'s own desktop is Windows\' RDP server at 127.0.0.1:3389', spec?.id === 'own' && spec.kind === 'windows' && spec.host === '127.0.0.1' && spec.port === 3389, spec)
    check('no error shown', !(await ev('return H.status(H.pane)?.buttons?.length')))

    // 2. Signing in with the Windows account: connected, with a picture.
    await ev(`H.submit(${JSON.stringify(win.account || user)}, ${JSON.stringify(win.password)})`)
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane)', 40)), await ev('return RD.desktop.logOf(H.pane).slice(-4)'))
    check('its certificate is remembered on first use, under the SSH account', !!(await ev(`return (H.config.store.remoteDesktop.trustedCertificates ?? []).find(e => e?.desktop === ${JSON.stringify(key)})?.sha256`)))
    check('Windows frame decoded', !!(await t.waitFor('const c = H.canvas(H.pane); return c?.colors > 10 ? c : null', 10)), await ev('return H.canvas(H.pane)'))
    await t.dump('H.pane', 'winhost-connected')
    check('the menu offers the way back to the console', (await ev('return (await H.menu(H.pane)).map(i => i.label)')).includes('Back to console'))

    // 3. Opened again: known to be Windows now (no setup attempt), and with the saved account, no form.
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    await sleep(500)
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    if (keychainWorks) {
        check('reopened with the saved account, no form', !!(await t.waitFor('return H.connected(H.pane)', 40)) && !(await ev('return H.signin()')))
    } else {
        check('reopened: straight to the sign-in form', !!(await t.waitFor('return H.signin()', 10)))
        t.skip('reopened with the saved account', 'the system keychain does not answer (Linux: no unlocked keyring)')
    }
    check('no GNOME setup the second time', !(await ev('return RD.desktop.logOf(H.pane).some(l => /Preparing the remote desktop/.test(l))')))
}, { needsHost: false })
