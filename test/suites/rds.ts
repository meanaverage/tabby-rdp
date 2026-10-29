// A Windows Server with Remote Desktop Services licensing (issue #106): such a host runs the whole licensing exchange
// (Server License Request, platform challenge, a new license) and sends network auto-detection requests in the middle
// of it, which ended the connection before the desktop opened. The suite connects a direct desktop to it with the
// diagnostic log file on, and reads the exchange back from that file: the licensing PDUs, the auto-detection requests
// answered after the connect-time phase, a connection that opened, and no keying material in the file.
//
// The host: TRD_TEST_RDS (host[:port]) with TRD_TEST_RDS_USER and TRD_TEST_RDS_PASSWORD: a Windows Server with the
// Remote Desktop Session Host and Remote Desktop Licensing roles (testbed/windows-server/rds.ps1). Skipped without it.
import { suite } from '../lib/harness.js'

const NAME = 'RDS desktop (test)'

await suite('rds', async t => {
    const { ev, check, sleep, waitFor } = t
    const address = process.env.TRD_TEST_RDS || ''
    const user = process.env.TRD_TEST_RDS_USER || ''
    const password = process.env.TRD_TEST_RDS_PASSWORD || ''
    if (!address || !user) {
        t.skip('an RDS host', 'set TRD_TEST_RDS (with TRD_TEST_RDS_USER and TRD_TEST_RDS_PASSWORD)')
        return
    }
    const parts = /^\[?(.*?)\]?(?::(\d+))?$/.exec(address)!
    const host = parts[1]
    const port = Number(parts[2] || 3389)
    await ev(`Object.assign(H, {
        profiles () { return RD.injector.get(require('tabby-core').ProfilesService) },
        async openProfile (profile) {
            const before = new Set(H.panes())
            await H.inZone(() => H.profiles().openNewTabForProfile(profile))
            for (let i = 0; i < 40; i++) {
                const pane = H.panes().find(p => !before.has(p))
                if (pane) { H.opened.push(pane); return pane }
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
        state (p, connections) {
            if (H.signin(p)) return 'form'
            const s = H.status(p)
            if (s && /can't verify/.test(s.text)) return 'question'
            if (s && /failed|ended|refused/i.test(s.text)) return 'failed: ' + s.text
            if (H.connections(p) > connections) return 'connected'
            return null
        },
    })`)

    // The desktop's certificate forgotten, so that the question comes and is answered here, and put back at the end.
    const key = `rdp#${host}:${port}`
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    const profilesBefore = await ev('return JSON.stringify(H.config.store.profiles ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.store.profiles = ${profilesBefore}; H.config.save() })`))
    await ev(`H.inZone(() => { const r = H.config.store.remoteDesktop; r.trustedCertificates = (r.trustedCertificates ?? []).filter(e => e?.desktop !== ${JSON.stringify(key)}); H.config.save() })`)

    // The diagnostic log file, at the debug level, for the desktops opened from now on.
    await t.settings({ diagnosticLog: 'debug' })
    const profile = { type: 'rdp', name: NAME, options: { host, port, kind: 'windows', username: user, via: '' } }
    const log = () => ev<string[]>('return RD.desktop.logOf(H.rdp).slice(-8)')
    const advance = async (): Promise<string | null> => {
        const connections = await ev<number>('return H.connections(H.rdp)')
        for (let i = 0; i < 300; i++) {
            const state = await ev<string | null>(`return H.state(H.rdp, ${connections})`)
            if (state === 'form') {
                await ev(`H.submit(H.rdp, ${JSON.stringify(password)})`)
                await sleep(500)
                continue
            }
            if (state === 'question') {
                await ev(`H.inZone(() => H.clickStatus(H.rdp, 'Trust the certificate'))`)
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

    check('the profile opens a remote desktop tab', await ev(`H.rdp = await H.openProfile(${JSON.stringify(profile)}); return !!H.rdp`))
    const file = await waitFor<string>(`const l = RD.desktop.logOf(H.rdp).find(x => /^diagnostics: writing /.test(x)); return l ? l.replace(/^diagnostics: writing /, '') : null`, 10)
    check('a diagnostic log file is written for the desktop', !!file, await log())
    const outcome = await advance()
    check('the RDS host connects: its licensing exchange and the auto-detection in it got through', outcome === 'connected', { outcome, log: await log() })
    check('... and the desktop draws', !!await waitFor('const c = H.canvas(H.rdp); return c?.colors > 3', 30))
    await sleep(1000)
    await ev('H.inZone(() => RD.desktop.disconnect(H.rdp))')
    await sleep(1000)

    const text = file ? await t.readFile(file) : null
    check('the log file can be read back', !!text, file)
    const lines = (text ?? '').split('\n')
    // The file, kept with the suite's dumps (TRD_TEST_DUMP) as evidence; the test profile goes when Tabby closes.
    if (process.env.TRD_TEST_DUMP && text && file) {
        const fs = await import('node:fs')
        const path = await import('node:path')
        fs.mkdirSync(process.env.TRD_TEST_DUMP, { recursive: true })
        fs.writeFileSync(path.join(process.env.TRD_TEST_DUMP, path.basename(file)), text, { mode: 0o600 })
    }
    const exchange = lines.filter(l => /licens|Auto-Detect|message channel|Multitransport|Capabilities|Finalization/i.test(l))
    const has = (label: string, pattern: RegExp) => check(`the log shows ${label}`, lines.some(l => pattern.test(l)), exchange.slice(0, 40))
    has('the licensing exchange starting', /Licensing Exchange/)
    has('the Server License Request, received', /Received.*ServerLicenseRequest/)
    has('the platform challenge, received', /Received.*ServerPlatformChallenge/)
    // A server may confirm an existing client license instead of issuing another one ([MS-RDPELE] 3.1.5.3.1).
    has('a new, upgraded or valid existing license, received', /Received.*(ServerUpgradeLicense|NewLicense)|License verified|Received LicensingErrorMessage.*error_code: StatusValidClient/)
    // Whether a host sends auto-detection requests in the middle of the exchange is the host's choice (the one in
    // #106 did, between the platform challenge and the license); what matters is that none ended the connection.
    // Answered requests are logged alike in every phase; those after the exchange began are the late ones.
    const began = lines.findIndex(l => /Licensing Exchange/.test(l))
    const answered = began < 0 ? 0 : lines.slice(began).filter(l => /Answering (a connect-time |an )Auto-Detect Request/.test(l)).length
    console.log(`NOTE  auto-detection requests answered during the exchange: ${answered}`)
    check('no message channel PDU during the exchange was taken for a licensing PDU', !lines.some(l => /Ignoring a message channel PDU|invalid security header flags/i.test(l)), exchange.slice(0, 40))
    has('the connection finalized', /Connection Finalization|connected: /)
    check('keying material is withheld: lengths only, no bytes', lines.some(l => /bytes withheld>/.test(l)) && !lines.some(l => /\[\s*(?:\d{1,3}\s*,\s*){7,}\d{1,3}\s*,?\s*\]/.test(l)),
        lines.filter(l => /\[\s*(?:\d{1,3}\s*,\s*){7,}/.test(l)).slice(0, 3))
    // The runner can drive a Windows Tabby from a different OS; use the client OS for this POSIX mode check.
    if (await ev<string>('return process.platform') === 'win32') {
        t.skip('POSIX diagnostic log mode', 'Windows uses ACLs')
    } else {
        check('the file is the user\'s alone', (await ev<number>(`return require('fs').statSync(${JSON.stringify(file)}).mode & 0o777`)) === 0o600)
    }
    console.log(`NOTE  diagnostic log: ${file} (${lines.length} lines)`)
}, { needsHost: false })
