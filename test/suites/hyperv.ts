// Hyper-V VMs on a Windows SSH host (TRD_TEST_HYPERV: user@host of a Hyper-V host running OpenSSH Server, an account
// that may list its VMs; TRD_TEST_HYPERV_PASSWORD; TRD_TEST_HYPERV_VM: a VM's name, default tabby-rdp-empty): the
// host's VMs are among its desktops; opening one asks for the host's account and shows the VM's console, through the
// host's port 2179. Where the SSH account may list VMs but not open their consoles (a local administrator other than
// the built-in one, signing in over the network), TRD_TEST_HYPERV_CONSOLE and _CONSOLE_PASSWORD name one that may:
// the first sign-in is then refused the way Hyper-V refuses (a disconnect at once), and the form says so. See
// test/README.md and testbed/windows-server.
import fs from 'node:fs'
import { suite, type CanvasInfo } from '../lib/harness.js'

await suite('hyperv', async t => {
    const { ev, check } = t
    const m = /^(?:([^@]+)@)?([^@:]+)(?::(\d+))?$/.exec(process.env.TRD_TEST_HYPERV ?? '')
    const password = process.env.TRD_TEST_HYPERV_PASSWORD ?? ''
    const vm = process.env.TRD_TEST_HYPERV_VM || 'tabby-rdp-empty'
    const consoleUser = process.env.TRD_TEST_HYPERV_CONSOLE || ''
    const consolePassword = process.env.TRD_TEST_HYPERV_CONSOLE_PASSWORD || ''
    if (!m?.[1] || !password) {
        t.skip('hyperv', 'set TRD_TEST_HYPERV (user@host of a Hyper-V host running OpenSSH Server) and TRD_TEST_HYPERV_PASSWORD')
        return
    }
    const [, user, host, port = '22'] = m
    const log = () => ev<string[]>('return RD.desktop.logOf(H.pane)')
    await ev(`Object.assign(H, {
        signin () {
            const f = H.overlay(H.pane)?.querySelector('.trd-signin form')
            return f ? { user: f.querySelector('[name=username]').value, title: f.parentElement.querySelector('.trd-signin-title').textContent, error: f.querySelector('.trd-signin-error').textContent } : null
        },
        submit (password, user) {
            const f = H.overlay(H.pane).querySelector('.trd-signin form')
            if (user) f.querySelector('[name=username]').value = user
            f.querySelector('[name=password]').value = password
            f.requestSubmit()
        },
    })`)
    check('SSH tab to the Hyper-V host connected', await ev(`H.pane = await H.openSSH({ host: ${JSON.stringify(host)}, user: ${JSON.stringify(user)}, port: ${Number(port)} }); return !!H.pane`))
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.save() })`))
    await t.settings({ discoverVMs: true })

    // 1. The host's VMs are found (PowerShell over the SSH connection) and offered among its desktops.
    const t0 = Date.now()
    await ev('H.target = await RD.targets.targetOf(H.pane); await RD.desktop.discoverVMs(H.target)')
    t.time('listing the host\'s VMs', Date.now() - t0)
    const specs = await ev<{ id: string, name: string, hyperv?: string, port: number, found?: string, wake?: unknown }[]>('return RD.desktop.desktopsOf(H.target)')
    const spec = specs.find(s => s.name === vm)
    check(`"${vm}" is among the host's desktops, as a Hyper-V VM reached through the host`, !!spec?.hyperv && spec.id === `hyperv:${spec.hyperv}` && spec.port === 2179 && !!spec.wake, specs)
    if (!spec?.hyperv) {
        return
    }
    const items = (await ev<{ label?: string }[]>('return await H.menuItems(H.pane)')).map(i => i.label ?? '')
    check('the menu offers it', items.some(l => l === `Open ${vm} (VM)` || l === `Start and open ${vm} (VM, shut off)`), items.filter(l => /Open|VM/.test(l)))

    // 2. Opening it: the sign-in is the host's, the SSH user to start with; then the VM's console.
    await ev(`H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(spec.id)}))`)
    const form = await t.waitFor<{ user: string, title: string }>('return H.signin()', 120)
    check('the sign-in form asks for the host\'s account, with the SSH user filled in', form?.user === user && new RegExp(`to open ${vm}`).test(form?.title ?? ''), form ?? await log())
    if (consoleUser && consoleUser !== user) {
        // The SSH account lists VMs but may not open their consoles here: Hyper-V signs it in and disconnects at once.
        await ev(`H.submit(${JSON.stringify(password)})`)
        const refused = await t.waitFor<{ user: string, title: string, error: string }>('const f = H.signin(); return f?.error ? f : null', 180)
        check('an account that may not open the console: the form again, saying so', /may not open/.test(refused?.error ?? ''), refused ?? (await log()).slice(-6))
    }
    const t1 = Date.now()
    await ev(`H.submit(${JSON.stringify(consolePassword || password)}, ${JSON.stringify(consoleUser)})`)
    const outcome = await t.waitFor<string>(`const log = RD.desktop.logOf(H.pane); const after = log.slice(log.findLastIndex(l => /RDCleanPath relay up/.test(l)))
        return after.find(l => /^connected:/.test(l)) ?? after.find(l => /failed|ended|refused|lost/.test(l)) ?? null`, 180)
    t.time('the console, from the sign-in', Date.now() - t1)
    check('the VM\'s console connected', /^connected:/.test(outcome ?? ''), (await log()).slice(-8))
    check('the log says which session it is', (await log()).some(l => /^hyper-v: (an enhanced session|the basic console)/.test(l)), (await log()).filter(l => /hyper-v/.test(l)))
    const frame = await t.waitFor<CanvasInfo>('const c = H.canvas(H.pane); return c?.w > 0 && c.colors >= 2 ? c : null', 60)
    check('the console\'s picture arrives', !!frame, { canvas: await ev('return H.canvas(H.pane)'), log: (await log()).slice(-10) })
    await t.sleep(5000)
    if (process.env.TRD_TEST_HYPERV_SHOT) {
        // A picture of the console, for a look at what arrived.
        const { data } = await t.c.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(process.env.TRD_TEST_HYPERV_SHOT, Buffer.from(data, 'base64'))
    }
    check('... and the connection stays up', await ev<boolean>("return H.session(H.pane)?.state === 'connected'"), (await log()).slice(-6))
    check('the host\'s certificate is remembered under the host, for all of its VMs', await ev<boolean>(`return (H.config.store.remoteDesktop.trustedCertificates ?? []).some(e => /#hyperv$/.test(e?.desktop ?? ''))`))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
})
