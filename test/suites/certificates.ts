// Server certificates, on a Linux desktop host (TRD_TEST_HOST). No Windows needed: the desktop behind the host is the
// host's own GNOME Remote Desktop again, reached as 127.0.0.1:3389 (as in the desktops suite), and it is trusted on
// first use as a Windows machine would be. A changed certificate is simulated: for the own desktop by altering what the
// setup reported, for the one behind the host by altering the remembered fingerprint.
// - The own desktop: checked against the certificate the setup made; another one stops before signing in, with an
//   error and "Try again", and no automatic retries.
// - The desktop behind the host: remembered silently on first use; a changed one stops before signing in with both
//   fingerprints; Cancel keeps the remembered one; "Trust the new certificate" connects without asking for the account
//   again; an automatic reconnect stops at the same question; removing the desktop forgets the certificate.
import { suite, type StatusInfo } from '../lib/harness.js'

const NAME = 'GNOME as an extra'
const ID = '127.0.0.1:3389'
const BOGUS = Array(32).fill('AB').join(':')
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/

await suite('certificates', async t => {
    const { ev, check, sleep } = t
    await ev(`Object.assign(H, {
        /** Log lines of the latest connection attempt, from its "Connecting to". */
        attempt () {
            const log = RD.desktop.logOf(H.pane)
            const i = log.findLastIndex(l => /Connecting to/.test(l))
            return i < 0 ? [] : log.slice(i)
        },
        up () { return H.attempt().slice(1).some(l => /Z $/.test(l)) },
        /** Whether the latest attempt got past the proxy to the server (where CredSSP would start). */
        relayed () { return H.attempt().some(l => /RDCleanPath relay up/.test(l)) },
        attempts () { return RD.desktop.logOf(H.pane).filter(l => /Connecting to/.test(l)).length },
        signin () { return H.overlay(H.pane)?.querySelector('.trd-signin form') ?? null },
        signIn (password) {
            const f = H.signin()
            f.querySelector('[name=password]').value = password
            f.querySelector('[name=remember]').checked = false
            f.requestSubmit()
        },
        trusted (key) { return (H.config.store.remoteDesktop.trustedCertificates ?? []).find(e => e?.desktop === key)?.sha256 ?? null },
        setTrusted (key, sha256) {
            H.inZone(() => {
                const others = (H.config.store.remoteDesktop.trustedCertificates ?? []).filter(e => e?.desktop !== key)
                H.config.store.remoteDesktop.trustedCertificates = sha256 ? [...others, { desktop: key, sha256 }] : others
                H.config.save()
            })
        },
        changed () { const s = H.status(H.pane); return s && /has changed/.test(s.text) ? s : null },
    })`)
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.save() })`))
    const desktops = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${desktops}; H.config.save() })`))
    t.onCleanup(() => ev('delete RD.desktop.endpointFor'))

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    const ownKey = await ev('return (await RD.targets.targetOf(H.pane)).key')

    // 1. The own desktop: the certificate the setup made, nothing remembered in the config.
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('own desktop connected', !!(await t.waitFor('return H.up()', 40)), await ev('return H.attempt()'))
    const onDisk = (await t.remote('H.pane', `openssl x509 -in ~/.local/share/tabby-rdp/tls.crt -noout -fingerprint -sha256 | sed 's/^[^=]*=//'`)).trim().toUpperCase()
    const seen = await ev(`return H.attempt().map(l => /^certificate: SHA-256 (\\S+), as set up$/.exec(l)?.[1]).find(Boolean) ?? null`)
    check('own desktop: checked against the certificate the setup made', FINGERPRINT.test(onDisk) && seen === onDisk, { seen, onDisk })
    check('own desktop: nothing remembered in the config', !(await ev(`return H.trusted(${JSON.stringify(ownKey)})`)))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 2. The own desktop with another certificate than the setup reported.
    await ev(`RD.desktop.endpointFor = async function (...args) {
        const e = await Object.getPrototypeOf(this).endpointFor.apply(this, args)
        if (e?.certificate) e.certificate = ${JSON.stringify(BOGUS)}
        return e
    }`)
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    const refused = await t.waitFor<StatusInfo>(`const s = H.status(H.pane); return s && /other than the one set up/.test(s.text) ? s : null`, 40)
    check('own desktop, another certificate: an error with both fingerprints, and "Try again"',
        refused?.buttons.join() === 'Try again' && refused?.text.includes(BOGUS.slice(0, 47)) && refused.text.includes(onDisk.slice(0, 47)),
        refused ?? await ev('return [H.status(H.pane), H.attempt()]'))
    check('... stopped at the proxy, before signing in', !(await ev('return H.relayed()')) && await ev('return H.attempt().some(l => /RDCleanPath failed: certificate/.test(l))'), await ev('return H.attempt()'))
    await sleep(3000)
    check('... and no automatic retry', await ev('return H.attempts()') === 1 && (await ev('return H.status(H.pane)?.buttons.join()')) === 'Try again')
    await ev('delete RD.desktop.endpointFor')
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Try again'))`)
    check('"Try again" with the right certificate connects', !!(await t.waitFor('return H.up()', 40)), await ev('return H.attempt()'))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 3. The desktop behind the host, first use: remembered without asking.
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = [{ name: ${JSON.stringify(NAME)}, via: H.test.host, host: '127.0.0.1', port: 3389, kind: 'gnome', username: 'tabby' }]; H.config.save() })`)
    const password = (await t.remote('H.pane', 'cat ~/.local/share/tabby-rdp/rdp-password')).trim()
    const key = await ev(`return (await RD.targets.targetOf(H.pane)).key + '#${ID}'`)
    const k = JSON.stringify(key)
    await ev(`H.setTrusted(${k}, null)`)
    if (await t.keychainWorks()) {
        // A saved account would skip the sign-in form this suite fills in.
        await t.keychain(`deletePassword('tabby-rdp', ${k})`)
        t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${k})`))
    }
    const open = async () => {
        await ev(`await H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(ID)}))`)
        const form = await t.waitFor('return !!H.signin()', 15)
        if (form) {
            await ev(`H.signIn(${JSON.stringify(password)})`)
        }
        return form
    }
    check('behind the host: sign-in form', !!(await open()))
    check('first use: connects without asking about the certificate', !!(await t.waitFor('return H.up()', 40)), await ev('return [H.status(H.pane), H.attempt()]'))
    check('first use: the certificate remembered in remoteDesktop.trustedCertificates', await ev(`return H.trusted(${k})`) === onDisk, await ev(`return H.trusted(${k})`))
    check('first use: logged as remembered', await ev('return H.attempt().some(l => /certificate: .*remembered \\(first connection\\)/.test(l))'))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 4. A changed certificate: both fingerprints, stopped before signing in; Cancel keeps the remembered one.
    await ev(`H.setTrusted(${k}, ${JSON.stringify(BOGUS)})`)
    await open()
    const changed = await t.waitFor<StatusInfo>('return H.changed()', 40)
    check('changed certificate: both fingerprints, "Trust the new certificate" and "Cancel"',
        changed?.buttons.join() === 'Trust the new certificate,Cancel' && changed?.text.includes(BOGUS.slice(0, 47)) && changed.text.includes(onDisk.slice(0, 47)),
        changed ?? await ev('return [H.status(H.pane), H.attempt()]'))
    check('... stopped at the proxy, before signing in', !(await ev('return H.relayed()')) && !(await ev('return H.up()')), await ev('return H.attempt()'))
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Cancel'))`)
    await sleep(300)
    const cancelled = await ev<StatusInfo | null>('return H.status(H.pane)')
    check('Cancel: not connected, "Try again" offered, the remembered certificate kept',
        /not trusted/.test(cancelled?.text ?? '') && cancelled?.buttons.join() === 'Try again' && await ev(`return H.trusted(${k})`) === BOGUS, cancelled)

    // 5. Try again, and trust the new certificate: connects with the account already entered.
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Try again'))`)
    await t.waitFor('return !!H.signin()', 15) && await ev(`H.signIn(${JSON.stringify(password)})`)
    check('"Try again": the same question', !!(await t.waitFor('return H.changed()', 40)))
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Trust the new certificate'))`)
    check('"Trust the new certificate": connects, without asking for the account again',
        !!(await t.waitFor('return H.up()', 40)) && !(await ev('return !!H.signin()')), await ev('return [H.status(H.pane), H.attempt()]'))
    check('... and remembers the new certificate', await ev(`return H.trusted(${k})`) === onDisk)

    // 6. An automatic reconnect (after SSH dropped) meets the same question, and waits there.
    await ev(`H.setTrusted(${k}, ${JSON.stringify(BOGUS)})`)
    await ev('await H.inZone(() => H.pane.sshSession.destroy())')
    await t.waitFor(`return H.status(H.pane)?.buttons.includes('Reconnect SSH')`, 15)
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Reconnect SSH'))`)
    // The account isn't saved, so the reconnect asks for it first.
    if (await t.waitFor('return !!H.signin()', 45)) {
        await ev(`H.signIn(${JSON.stringify(password)})`)
    }
    const reconnect = await t.waitFor<StatusInfo>('return H.changed()', 40)
    check('automatic reconnect: stops at the changed certificate, before signing in',
        reconnect?.buttons.join() === 'Trust the new certificate,Cancel' && !(await ev('return H.relayed()')), reconnect ?? await ev('return [H.status(H.pane), H.attempt()]'))
    await sleep(4000)
    check('... and waits there (no further attempts)', !!(await ev('return H.changed()')) && await ev('return H.attempts()') === 1, await ev('return RD.desktop.logOf(H.pane)'))
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Trust the new certificate'))`)
    check('... "Trust the new certificate" connects', !!(await t.waitFor('return H.up()', 40)) && await ev(`return H.trusted(${k})`) === onDisk)
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 7. Removing the desktop forgets its certificate.
    const index = await ev<number>(`return RD.desktop.configuredDesktops().findIndex(d => d.name === ${JSON.stringify(NAME)})`)
    await ev(`H.inZone(() => RD.desktop.removeDesktop(${index}))`)
    await sleep(300)
    check('removing the desktop forgets its certificate', index >= 0 && !(await ev(`return H.trusted(${k})`)))
})
