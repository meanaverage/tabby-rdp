// Desktops reached directly, in a remote desktop tab (a profile, quick connect, an .rdp file, a restored tab): a socket
// from Tabby's window to the desktop, with TLS over it in the window itself. Behind an SSH host, TLS runs over the SSH
// channel instead, a stream of JavaScript; here it shares the socket's native handle, and a connection the plugin ended
// once TLS was up (its certificate refused, the first time any such desktop connects) crashed the window on Linux
// (issue #69). This suite takes a direct desktop through every way its connection ends in a real Tabby: the first
// connection's certificate question, Cancel, Trust, a reconnect as remembered, a changed certificate (Cancel, then
// trusted), the tab closed while the question shows, and the tab closed as the desktop connects. Tabby's window has to
// come through each one, and the desktop has to draw.
//
// The desktop: TRD_TEST_DIRECT (host[:port], any RDP server this machine can reach) with TRD_TEST_DIRECT_USER,
// TRD_TEST_DIRECT_PASSWORD and TRD_TEST_DIRECT_KIND (gnome, xrdp or windows; default gnome). Without it, the GNOME
// Remote Desktop of TRD_TEST_HOST on port 3389 with the plugin's generated account, as the profiles suite uses. Skipped
// with neither, or when that address can't be reached from here.
import { suite, type CanvasInfo, type StatusInfo } from '../lib/harness.js'

const NAME = 'Direct desktop (test)'

await suite('direct', async t => {
    const { ev, check, sleep, waitFor } = t
    await ev(`Object.assign(H, {
        profiles () { return RD.injector.get(require('tabby-core').ProfilesService) },
        /** Opens a profile; returns the new pane (a remote desktop tab). */
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
        signin (p) { return !!H.overlay(p)?.querySelector('.trd-signin form') },
        submit (p, password) {
            const f = H.overlay(p).querySelector('.trd-signin form')
            f.querySelector('[name=password]').value = password
            f.requestSubmit()
        },
        connections (p) { return RD.desktop.logOf(p).filter(l => /^connected: /.test(l)).length },
        /** Where the tab's connection stands: what it waits for, or how it ended. */
        state (p, connections) {
            if (H.signin(p)) return 'form'
            const s = H.status(p)
            if (s && /can't verify/.test(s.text)) return 'question'
            if (s && /has changed since it was last used/.test(s.text)) return 'changed'
            if (s && /Network Level Authentication/.test(s.text)) return 'without NLA'
            if (s && /not trusted/.test(s.text)) return 'not trusted'
            if (s && /failed|ended|refused/i.test(s.text)) return 'failed: ' + s.text
            if (H.connections(p) > connections) return 'connected'
            return null
        },
        idle (p) { const e = p.element.nativeElement.querySelector('.trd-rdp-idle'); return e && e.style.display !== 'none' ? e.textContent : null },
        /** Whether Tabby's window is there and answering, its plugin loaded. */
        alive () { return !!window.__remoteDesktop && document.readyState === 'complete' },
    })`)

    // The desktop, and the account to sign in to it with.
    const direct = t.env.direct
    let { address, user, password, kind } = direct
    if (!address) {
        if (!t.env.host) {
            t.skip('a direct desktop', 'set TRD_TEST_DIRECT (with TRD_TEST_DIRECT_USER and TRD_TEST_DIRECT_PASSWORD), or TRD_TEST_HOST')
            return
        }
        // The host's own desktop once, over SSH, so that its account exists; then its password.
        check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
        await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
        check('own desktop connected (account created)', !!await waitFor('return H.connected(H.pane)', 40))
        await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
        password = (await t.remote('H.pane', 'cat ~/.local/share/tabby-rdp/rdp-password')).trim()
        address = `${t.env.host}:3389`
        user = 'tabby'
        kind = 'gnome'
    }
    const parts = /^\[?(.*?)\]?(?::(\d+))?$/.exec(address)!
    const host = parts[1]
    const port = Number(parts[2] || 3389)
    const reachable = await ev<boolean>(`return await new Promise(resolve => {
        const s = require('net').connect(${port}, ${JSON.stringify(host)})
        const done = ok => { s.destroy(); resolve(ok) }
        s.once('connect', () => done(true)); s.once('error', () => done(false)); setTimeout(() => done(false), 3000)
    })`)
    if (!reachable) {
        t.skip('a direct desktop', `${host}:${port} can't be reached from this machine`)
        return
    }
    console.log(`NOTE  ${kind} desktop at ${host}:${port}, as ${user}`)

    // A desktop never seen before: its certificate forgotten (and the account, where the keychain answers), and put back
    // as it was at the end.
    const key = `rdp#${host}:${port}`
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    const profilesBefore = await ev('return JSON.stringify(H.config.store.profiles ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.store.profiles = ${profilesBefore}; H.config.save() })`))
    const forget = () => ev(`H.inZone(() => { const r = H.config.store.remoteDesktop; r.trustedCertificates = (r.trustedCertificates ?? []).filter(e => e?.desktop !== ${JSON.stringify(key)}); H.config.save() })`)
    await forget()
    if (await t.keychainWorks()) {
        await t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`)
        t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`))
    }
    const remembered = () => ev<{ sha256: string, authority?: boolean } | null>(`return (H.config.store.remoteDesktop.trustedCertificates ?? []).find(e => e?.desktop === ${JSON.stringify(key)}) ?? null`)
    const profile = { type: 'rdp', name: NAME, options: { host, port, kind, username: user, via: '' } }
    const log = () => ev<string[]>('return RD.desktop.logOf(H.rdp).slice(-6)')

    /** Waits for where the connection goes next, signing in on the way (the password is saved only where the keychain answers). */
    const advance = async (): Promise<string | null> => {
        const connections = await ev<number>('return H.connections(H.rdp)')
        for (let i = 0; i < 300; i++) {
            const state = await ev<string | null>(`return H.state(H.rdp, ${connections})`)
            if (state === 'form') {
                await ev(`H.submit(H.rdp, ${JSON.stringify(password)})`)
                await sleep(500)
                continue
            }
            if (state) {
                return state
            }
            await sleep(200)
        }
        return null
    }
    /** Disconnects the tab, then connects it again from its "not connected" screen. */
    const reconnect = async () => {
        await ev('H.inZone(() => RD.desktop.disconnect(H.rdp))')
        await waitFor('return H.idle(H.rdp)', 5)
        await ev(`H.inZone(() => H.rdp.element.nativeElement.querySelector('.trd-rdp-idle button').click())`)
        return advance()
    }
    /** That Tabby's window came through, a second later (what a crash follows comes within a moment). */
    const survived = async (label: string) => {
        await sleep(1000)
        check(`Tabby's window came through: ${label}`, await ev('return H.alive()'))
    }

    // 1. The first connection: the certificate refused, after TLS, before anything of the sign-in went to it. This is
    // where the window crashed.
    check('the profile opens a remote desktop tab', await ev(`H.rdp = await H.openProfile(${JSON.stringify(profile)}); return !!H.rdp && RD.desktopPaneOf(H.rdp) === H.rdp`))
    const first = await advance()
    check('first connection: its certificate, never seen, asked about', first === 'question', { first, log: await log() })
    await survived('the connection ended at its certificate')
    const asked = await ev<StatusInfo | null>('return H.status(H.rdp)')
    check('... with its address and fingerprint, Trust or Cancel', !!asked && asked.text.toLowerCase().includes(`${host}:${port}`.toLowerCase()) &&
        /([0-9A-F]{2}[:\s]){31}[0-9A-F]{2}/.test(asked.text) && asked.buttons.join() === 'Trust the certificate,Cancel', asked)
    check('... the proxy ended the connection there, nothing relayed', await ev<boolean>('const l = RD.desktop.logOf(H.rdp); return l.some(x => /RDCleanPath failed: certificate/.test(x)) && !l.some(x => /relay up/.test(x))'), await log())

    // 2. Cancel: not connected, nothing remembered.
    await ev(`H.inZone(() => H.clickStatus(H.rdp, 'Cancel'))`)
    check('Cancel: not connected, the certificate not trusted', !!await waitFor(`return H.state(H.rdp, 0) === 'not trusted'`, 10), await ev('return H.status(H.rdp)'))
    check('... and not remembered', await remembered() === null)
    await survived('Cancel')

    // 3. Asked again, then trusted: connected, and the picture drawn.
    const again = await reconnect()
    check('connecting again: asked again', again === 'question', { again, log: await log() })
    await survived('the second refusal')
    await ev(`H.inZone(() => H.clickStatus(H.rdp, 'Trust the certificate'))`)
    check('trusted: the desktop connects', await advance() === 'connected', await log())
    const frame = await waitFor<CanvasInfo>('const c = H.canvas(H.rdp); return c?.colors > 3 ? c : null', 20)
    check('... and draws, sized to the tab', !!frame && Math.abs(frame.w - frame.paneW) <= 2 && Math.abs(frame.h - frame.paneH) <= 2, frame)
    const trusted = await remembered()
    check('its certificate is remembered as trusted by you', !!trusted?.sha256 && trusted.authority === false, trusted)
    await survived('a connection up')

    // 4. Disconnected and connected again: as remembered, no question.
    check('reconnecting: connects with the certificate as remembered', await reconnect() === 'connected', await log())
    check('... the log says so', (await log()).some(l => l.includes(`SHA-256 ${trusted?.sha256}, as remembered`)), await log())
    await survived('a reconnect')

    // 5. A changed certificate (the one remembered made up): refused after TLS too. Cancel keeps the old one; trusting
    // the new one connects.
    const madeUp = Array(32).fill('AB').join(':')
    await ev(`H.inZone(() => { const e = H.config.store.remoteDesktop.trustedCertificates.find(e => e?.desktop === ${JSON.stringify(key)}); e.sha256 = ${JSON.stringify(madeUp)}; H.config.save() })`)
    const changed = await reconnect()
    check('a changed certificate: the connection stops, asked about', changed === 'changed', { changed, log: await log() })
    await survived('a changed certificate refused')
    check('... the proxy ended the connection there', (await log()).some(l => /RDCleanPath failed: certificate SHA-256 .* is not the one remembered/.test(l)), await log())
    await ev(`H.inZone(() => H.clickStatus(H.rdp, 'Cancel'))`)
    check('Cancel: not connected, the old certificate still the one remembered', !!await waitFor(`return H.state(H.rdp, 0) === 'not trusted'`, 10) && (await remembered())?.sha256 === madeUp)
    check('connecting again: asked again', await reconnect() === 'changed', await log())
    await ev(`H.inZone(() => H.clickStatus(H.rdp, 'Trust the new certificate'))`)
    check('the new certificate trusted: connects', await advance() === 'connected', await log())
    check('... and it is the one remembered now', (await remembered())?.sha256 === trusted?.sha256)
    await survived('a changed certificate trusted')

    // 6. The tab closed while the question shows.
    await forget()
    check('forgotten again: asked again', await reconnect() === 'question', await log())
    await ev('await H.inZone(() => RD.app.closeTab(H.topOf(H.rdp), false))')
    check('the tab closed while its question shows: gone', !!await waitFor('return !H.panes().includes(H.rdp)', 5))
    await survived('a tab closed at the question')

    // 7. The tab closed as the desktop connects: the client leaves the proxy wherever it is (TLS, the relay, CredSSP).
    // Trusted again, so that the connection goes as far as it can: TLS, the relay, CredSSP and on.
    await forget()
    await ev(`H.inZone(() => { const r = H.config.store.remoteDesktop; r.trustedCertificates = [...(r.trustedCertificates ?? []), ${JSON.stringify({ desktop: key, sha256: trusted?.sha256, authority: false })}]; H.config.save() })`)
    for (const wait of [0, 50, 150, 400]) {
        check(`opened again (closing ${wait} ms into connecting)`, await ev(`H.rdp = await H.openProfile(${JSON.stringify(profile)}); return !!H.rdp`))
        // Into the connection: signed in where the form asks, then closed at once or a moment later.
        await waitFor(`return H.signin(H.rdp) || /Connecting/.test(H.status(H.rdp)?.text ?? '')`, 20, 20)
        if (await ev('return H.signin(H.rdp)')) {
            await ev(`H.submit(H.rdp, ${JSON.stringify(password)})`)
        }
        await sleep(wait)
        await ev('await H.inZone(() => RD.app.closeTab(H.topOf(H.rdp), false))')
        await survived(`a tab closed ${wait} ms into connecting`)
    }

    // 8. And a direct desktop still connects after all that.
    check('opened once more', await ev(`H.rdp = await H.openProfile(${JSON.stringify(profile)}); return !!H.rdp`))
    check('... connects', await advance() === 'connected', await log())
    check('... and draws', !!await waitFor('const c = H.canvas(H.rdp); return c?.colors > 3', 20))
    await ev('H.inZone(() => RD.desktop.disconnect(H.rdp))')
}, { needsHost: false })
