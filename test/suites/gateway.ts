// Desktops behind an RD Gateway (TRD_TEST_GATEWAY: the gateway's address as the machine Tabby runs on sees it,
// `host` or `host:port`; TRD_TEST_GATEWAY_USER and TRD_TEST_GATEWAY_PASSWORD: an account the gateway lets through and
// the desktop signs in; TRD_TEST_GATEWAY_TARGET: the desktop as the gateway sees it, default the gateway's own host):
// - a remote desktop profile with a gateway: a password the gateway refuses brings the form back, saying it was the
//   gateway, with nothing sent to the desktop; the right one connects through the gateway's tunnel;
// - the gateway's certificate is remembered by its address, and a changed one stops before the sign-in goes to it;
// - a gateway with a saved account of its own is asked for separately, and a refusal asks for that account again;
// - with a Linux test host (TRD_TEST_HOST): a desktop behind that SSH host, through the gateway as the host sees it.
// See test/README.md and testbed/windows-server.
import { suite, type CanvasInfo, type StatusInfo } from '../lib/harness.js'

const NAME = 'Through a gateway (test)'
const OWN = 'Gateway account (test)'
const BEHIND = 'Behind a gateway (test)'
const BOGUS = Array(32).fill('AB').join(':')

interface Form { user: string, title: string, error: string }

await suite('gateway', async t => {
    const { ev, check, sleep } = t
    const gateway = (process.env.TRD_TEST_GATEWAY ?? '').trim()
    const user = process.env.TRD_TEST_GATEWAY_USER ?? ''
    const password = process.env.TRD_TEST_GATEWAY_PASSWORD ?? ''
    if (!gateway || !user || !password) {
        t.skip('gateway', 'set TRD_TEST_GATEWAY (an RD Gateway\'s address), TRD_TEST_GATEWAY_USER and TRD_TEST_GATEWAY_PASSWORD')
        return
    }
    const target = process.env.TRD_TEST_GATEWAY_TARGET || gateway.replace(/:\d+$/, '')
    const gatewayKey = `gateway#${/:\d+$/.test(gateway) ? gateway : `${gateway}:443`}`
    const k = JSON.stringify(gatewayKey)
    await ev(`Object.assign(H, {
        profiles () { return RD.injector.get(require('tabby-core').ProfilesService) },
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
        async close (p) { const top = H.topOf(p); if (top) await H.inZone(() => RD.app.closeTab(top, false)) },
        form (p) {
            const f = H.overlay(p)?.querySelector('.trd-signin form')
            return f ? { user: f.querySelector('[name=username]').value, title: f.parentElement.querySelector('.trd-signin-title').textContent, error: f.querySelector('.trd-signin-error').textContent } : null
        },
        /** Signs in without keeping the password: every connection of this suite asks. */
        submit (p, password) {
            const f = H.overlay(p).querySelector('.trd-signin form')
            f.querySelector('[name=password]').value = password
            const remember = f.querySelector('[name=remember]')
            if (remember) remember.checked = false
            f.requestSubmit()
        },
        /** Log lines of the latest connection attempt, from its "Connecting to". */
        attempt (p) {
            const log = RD.desktop.logOf(p)
            const i = log.findLastIndex(l => /Connecting to/.test(l))
            return i < 0 ? [] : log.slice(i)
        },
        up (p) { return H.attempt(p).some(l => /^connected: /.test(l)) },
        trusted (key) { return (H.config.store.remoteDesktop.trustedCertificates ?? []).find(e => e?.desktop === key)?.sha256 ?? null },
        setTrusted (key, sha256) {
            H.inZone(() => {
                const others = (H.config.store.remoteDesktop.trustedCertificates ?? []).filter(e => e?.desktop !== key)
                H.config.store.remoteDesktop.trustedCertificates = [...others, { desktop: key, sha256 }]
                H.config.save()
            })
        },
    })`)
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.save() })`))
    const desktopsBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${desktopsBefore}; H.config.save() })`))
    await ev(`H.setTrusted(${k}, null); H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = H.config.store.remoteDesktop.trustedCertificates.filter(e => e.sha256); H.config.save() })`)
    const log = (p: string) => ev<string[]>(`return H.attempt(${p})`)

    // 1. A profile with a gateway. A password the gateway refuses: the form again, and nothing went to the desktop.
    const profile = { type: 'rdp', name: NAME, options: { host: target, port: 3389, kind: 'windows', username: user, via: '', gateway } }
    check('the profile opens a tab', await ev(`H.rdp = await H.openProfile(${JSON.stringify(profile)}); return !!H.rdp`))
    const form = await t.waitFor<Form>('return H.form(H.rdp)', 20)
    check('the sign-in form: the desktop\'s, its user name filled in', form?.title === `Sign in to ${NAME}` && form.user === user, form)
    await ev('H.submit(H.rdp, "not-the-password-1")')
    const refused = await t.waitFor<Form>('const f = H.form(H.rdp); return f?.error ? f : null', 60)
    check('a password the gateway refuses: the form again, saying it was the gateway', /gateway/i.test(refused?.error ?? ''), refused ?? await log('H.rdp'))
    check('... refused at the gateway: nothing reached the desktop', !(await log('H.rdp')).some(l => /RDCleanPath relay up|^certificate:/.test(l)), await log('H.rdp'))
    check('... its certificate is remembered already, by the gateway\'s address', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(await ev<string | null>(`return H.trusted(${k})`) ?? ''))

    // 2. The right password: through the gateway's tunnel to the desktop.
    const t0 = Date.now()
    await ev(`H.submit(H.rdp, ${JSON.stringify(password)})`)
    check('the desktop connects through the gateway', !!(await t.waitFor('return H.up(H.rdp)', 90)), (await log('H.rdp')).slice(-8))
    t.time('a desktop through the gateway, from the sign-in', Date.now() - t0)
    const connected = await log('H.rdp')
    check('the log tells the way: the gateway signed in to, then a channel to the desktop',
        connected.some(l => /^gateway: signed in to /.test(l)) && connected.some(l => l.startsWith(`gateway: channel to ${target}:3389 through `)), connected.filter(l => /gateway/.test(l)))
    check('signed in to the gateway with the desktop\'s account', connected.some(l => /signing in with the desktop's sign-in/.test(l)), connected.filter(l => /gateway/.test(l)))
    const frame = await t.waitFor<CanvasInfo>('const c = H.canvas(H.rdp); return c?.w > 0 && c.colors >= 2 ? c : null', 60)
    check('the desktop\'s picture arrives', !!frame, { canvas: await ev('return H.canvas(H.rdp)'), log: connected.slice(-8) })
    await sleep(3000)
    check('... and the connection stays up', await ev<boolean>("return H.session(H.rdp)?.state === 'connected'"), (await log('H.rdp')).slice(-6))
    const real = await ev<string>(`return H.trusted(${k})`)
    await ev('H.inZone(() => RD.desktop.disconnect(H.rdp))')
    await sleep(500)

    // 3. The gateway's certificate changed: stopped before the sign-in goes to it; trusting it connects.
    await ev(`H.setTrusted(${k}, ${JSON.stringify(BOGUS)})`)
    await ev(`H.inZone(() => H.rdp.element.nativeElement.querySelector('.trd-rdp-idle button').click())`)
    await t.waitFor('return H.form(H.rdp)', 20) && await ev(`H.submit(H.rdp, ${JSON.stringify(password)})`)
    const changed = await t.waitFor<StatusInfo>('const s = H.status(H.rdp); return s && /has changed/.test(s.text) ? s : null', 60)
    check('a changed gateway certificate: named as the gateway\'s, both fingerprints, "Trust the new certificate" and "Cancel"',
        /gateway/.test(changed?.text ?? '') && changed?.buttons.join() === 'Trust the new certificate,Cancel' && !!changed?.text.includes(BOGUS.slice(0, 47)) && changed.text.includes(real.slice(0, 47)),
        changed ?? await log('H.rdp'))
    check('... stopped before the sign-in went to the gateway', !(await log('H.rdp')).some(l => /^gateway: signed in/.test(l)), await log('H.rdp'))
    await ev(`H.inZone(() => H.clickStatus(H.rdp, 'Trust the new certificate'))`)
    check('trusting it connects, with the account already entered', !!(await t.waitFor('return H.up(H.rdp)', 90)) && !(await ev('return H.form(H.rdp)')), (await log('H.rdp')).slice(-8))
    check('... and the new certificate is the one remembered', await ev(`return H.trusted(${k})`) === real)
    await ev('H.inZone(() => RD.desktop.disconnect(H.rdp))')
    await ev('await H.close(H.rdp)')

    // 4. A gateway with a saved account of its own: asked for after the desktop's, and again when the gateway refuses it.
    const accountId = await ev<string>(`return (await H.inZone(() => RD.desktop.saveAccount({ name: ${JSON.stringify(OWN)}, username: ${JSON.stringify(user)} }))).id`)
    t.onCleanup(() => ev(`await H.inZone(() => RD.desktop.removeAccount(${JSON.stringify(accountId)}))`))
    const own = { type: 'rdp', name: OWN, options: { ...profile.options, gatewayAccount: accountId } }
    check('a profile with a gateway account opens a tab', await ev(`H.own = await H.openProfile(${JSON.stringify(own)}); return !!H.own`))
    const first = await t.waitFor<Form>('return H.form(H.own)', 20)
    check('first the desktop\'s sign-in', first?.title === `Sign in to ${OWN}`, first)
    await ev(`H.submit(H.own, ${JSON.stringify(password)})`)
    const second = await t.waitFor<Form>('const f = H.form(H.own); return f && /gateway/.test(f.title) ? f : null', 20)
    check('then the gateway\'s, for its saved account', /^Sign in to the gateway /.test(second?.title ?? '') && second?.user === user, second ?? await ev('return H.form(H.own)'))
    await ev('H.submit(H.own, "not-the-password-2")')
    const again = await t.waitFor<Form>('const f = H.form(H.own); return f?.error ? f : null', 60)
    check('refused by the gateway: its account is asked for again, not the desktop\'s', /^Sign in to the gateway /.test(again?.title ?? '') && /gateway/i.test(again?.error ?? ''), again ?? await log('H.own'))
    await ev(`H.submit(H.own, ${JSON.stringify(password)})`)
    check('the desktop connects', !!(await t.waitFor('return H.up(H.own)', 90)), (await log('H.own')).slice(-8))
    check('... signed in to the gateway with its saved account', (await log('H.own')).some(l => /signing in with its saved account/.test(l)), (await log('H.own')).filter(l => /gateway/.test(l)))
    await ev('H.inZone(() => RD.desktop.disconnect(H.own))')
    await ev('await H.close(H.own)')

    // 5. Behind an SSH host: the gateway is reached from that host, the desktop from the gateway.
    if (!t.env.host) {
        t.skip('a desktop behind an SSH host, through the gateway', 'set TRD_TEST_HOST (a Linux test host that reaches the gateway)')
        return
    }
    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    const reaches = (await t.remote('H.pane', `timeout 5 bash -c '</dev/tcp/${gateway.replace(/:\d+$/, '')}/${/:(\d+)$/.exec(gateway)?.[1] ?? 443}' 2>/dev/null && echo yes || echo no`)).trim() === 'yes'
    if (!reaches) {
        t.skip('a desktop behind an SSH host, through the gateway', `${t.env.host} doesn't reach ${gateway}`)
        return
    }
    const sshKey = await ev<string>('return (await RD.targets.targetOf(H.pane)).key')
    await ev(`H.inZone(() => {
        H.config.store.remoteDesktop.desktops = [...H.config.store.remoteDesktop.desktops ?? [],
            { name: ${JSON.stringify(BEHIND)}, via: ${JSON.stringify(sshKey)}, host: ${JSON.stringify(target)}, port: 3389, kind: 'windows', username: ${JSON.stringify(user)}, gateway: ${JSON.stringify(gateway)} }]
        H.config.save()
    })`)
    await ev(`H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(`${target}:3389`)}))`)
    const behind = await t.waitFor<Form>('return H.form(H.pane)', 30)
    check('the sign-in form names the desktop and the host it is behind', new RegExp(`^Sign in to ${BEHIND.replace(/[()]/g, '\\$&')} \\(via `).test(behind?.title ?? ''), behind)
    await ev(`H.submit(H.pane, ${JSON.stringify(password)})`)
    check('the desktop connects through the SSH host and the gateway', !!(await t.waitFor('return H.up(H.pane)', 90)), (await log('H.pane')).slice(-8))
    check('... by a channel through the gateway', (await log('H.pane')).some(l => l.startsWith(`gateway: channel to ${target}:3389 through `)), (await log('H.pane')).filter(l => /gateway/.test(l)))
    const picture = await t.waitFor<CanvasInfo>('const c = H.canvas(H.pane); return c?.w > 0 && c.colors >= 2 ? c : null', 60)
    check('the desktop\'s picture arrives', !!picture, await ev('return H.canvas(H.pane)'))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
}, { needsHost: false })
