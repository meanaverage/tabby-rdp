// Real Tabby lifecycle against a dedicated RDP test server. Also accepts the local FreeRDP sample server.
// No provisioning, VM startup, or performance claim. Credentials use the runner's isolated in-memory store.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { suite, type CanvasInfo } from '../lib/harness.js'
import { parseAddress } from '../../src/desktopForm.js'

await suite('freerdp', async t => {
    const client = process.env.TRD_TEST_FREERDP_RUNTIME === 'wasm' ? 'freerdp-wasm' : 'freerdp'
    const address = parseAddress(t.env.direct.address)
    if (!address || !t.env.direct.user || !t.env.direct.password) {
        t.skip('FreeRDP desktop lifecycle', 'set TRD_TEST_DIRECT, TRD_TEST_DIRECT_USER and TRD_TEST_DIRECT_PASSWORD for a dedicated test server')
        return
    }
    // Clipboard ownership and Automatic header behavior require a genuinely focused window.
    await t.ev(`const w = require('@electron/remote').getCurrentWindow(); w.show(); w.focus()`); await t.sleep(500)
    await t.settings({ client: 'ironrdp', resize: 'off', sharpness: 'standard', h264: false, microphone: false, sound: false })
    await t.ev(`
        const before = new Set(H.panes())
        await H.inZone(() => RD.injector.get(require('tabby-core').ProfilesService).openNewTabForProfile({
            id: 'rdp:freerdp-test', type: 'rdp', name: 'FreeRDP test', options: {
                host: ${JSON.stringify(address.host)}, port: ${address.port}, kind: ${JSON.stringify(t.env.direct.kind)},
                username: ${JSON.stringify(t.env.direct.user)}, client: ${JSON.stringify(client)}, glyphCache: false, bitmapCache: false, relaxOrderChecks: false,
                clipboard: 'off', via: '', gateway: '', account: null
            }
        }))
        for (let i = 0; i < 80; i++) {
            H.nativePane = H.panes().find(p => !before.has(p))
            if (H.nativePane) { H.opened.push(H.nativePane); break }
            await new Promise(r => setTimeout(r, 100))
        }
    `)
    t.check('remote desktop tab opened', await t.ev('return !!H.nativePane'))
    const settle = async (): Promise<boolean> => {
        await t.ev('H.nativeCredentialsSubmitted = false')
        for (let i = 0; i < 120; i++) {
            const state = await t.ev<string>(`
                if (H.session(H.nativePane)?.state === 'connected') return 'connected'
                const form = H.overlay(H.nativePane)?.querySelector('.trd-signin form')
                if (form) {
                    const error = form.querySelector('.trd-signin-error')?.textContent
                    if (H.nativeCredentialsSubmitted && error?.trim()) return 'The sign-in was refused: ' + error
                    if (H.nativeCredentialsSubmitted) return 'waiting'
                    form.querySelector('[name=password]').value = ${JSON.stringify(t.env.direct.password)}
                    H.inZone(() => form.requestSubmit())
                    H.nativeCredentialsSubmitted = true
                    return 'waiting'
                }
                const status = H.status(H.nativePane)
                for (const label of ['Trust the certificate', 'Send the password anyway']) {
                    if (status?.buttons.includes(label)) { H.inZone(() => H.clickStatus(H.nativePane, label)); return 'waiting' }
                }
                return status?.text ?? 'waiting'
            `)
            if (state === 'connected') return true
            if (/connection failed|not installed|not support|not connected|sign-in was refused/i.test(state)) {
                t.check('FreeRDP connection succeeds', false, state)
                return false
            }
            await t.sleep(250)
        }
        return false
    }
    if (!await settle()) { t.check('FreeRDP connected before timeout', false, await t.ev('return H.status(H.nativePane)')); return }
    // A new Windows test account can spend time initializing its profile after RDP is already active.
    const settleMs = Number(process.env.TRD_TEST_RDP_SETTLE_MS || 0)
    if (Number.isFinite(settleMs) && settleMs > 0) await t.sleep(Math.min(30000, settleMs))
    t.check('per-profile FreeRDP overrides the IronRDP global default', await t.ev(`return !!H.overlay(H.nativePane).querySelector('.trd-freerdp')`))
    t.check('FreeRDP draws desktop pixels', !!await t.waitFor(`return H.canvas(H.nativePane)?.colors > 2`, 10), await t.ev<CanvasInfo>('return H.canvas(H.nativePane)'))
    await t.dump('H.nativePane', 'freerdp-connected')
    await t.ev(`
        H.nativeProcess = H.session(H.nativePane).ui.native
        H.nativeChild = H.nativeProcess.child
        H.nativeClosed = false
        H.nativeChild.once('close', () => { H.nativeClosed = true })
        H.nativeKeys = 0
        const send = H.nativeProcess.send.bind(H.nativeProcess)
        H.nativeProcess.send = (type, data) => { if (type === 'K') H.nativeKeys++; send(type, data) }
    `)
    await t.clickDesktop('H.nativePane')
    await t.escape() // Clear a transient desktop menu/dialog in this dedicated test account.
    t.check('remote display contains visible content after pointer input', !!await t.waitFor(`return H.canvas(H.nativePane)?.colors > 20`, 5))
    await t.dump('H.nativePane', 'freerdp-input')
    await t.press('a')
    t.check('ordinary keys reach the native client through Tabby keyboard routing', await t.ev('return H.nativeKeys >= 2'))
    const paneStyle = await t.ev<string>('return H.nativePane.element.nativeElement.style.cssText')
    t.onCleanup(() => t.ev(`if (H.nativePane?.element?.nativeElement) H.nativePane.element.nativeElement.style.cssText = ${JSON.stringify(paneStyle)}`))
    const setPane = (width: number, height: number) => t.ev(`
        const el = H.nativePane.element.nativeElement
        el.style.flex = 'none'; el.style.minWidth = '0'; el.style.minHeight = '0'; el.style.width = '${width}px'; el.style.height = '${height}px'
    `)
    await setPane(800, 560)
    await t.settings({ resize: 'live' })
    const matchesPane = (width: number, height: number) => `const c = H.canvas(H.nativePane); return !!c && Math.abs(c.paneW - ${width}) <= 2 && Math.abs(c.paneH - ${height}) <= 2 && Math.abs(c.w - c.paneW) <= 2 && Math.abs(c.h - c.paneH) <= 2 && c.colors > 20`
    t.check('live resize draws pixels at the larger pane resolution', !!await t.waitFor(matchesPane(800, 560), 15), await t.ev('return H.canvas(H.nativePane)'))
    const large = await t.ev<CanvasInfo>('return H.canvas(H.nativePane)')
    await setPane(640, 480)
    t.check('live resize draws pixels at the smaller pane resolution', !!await t.waitFor(matchesPane(640, 480), 15), await t.ev('return H.canvas(H.nativePane)'))
    const small = await t.ev<CanvasInfo>('return H.canvas(H.nativePane)')
    t.check('display-control resize changes the remote dimensions without reconnecting', small.w < large.w &&
        await t.ev('return H.nativeProcess.child === H.nativeChild'), { large, small })
    await t.dump('H.nativePane', 'freerdp-resized')
    // Hold the renderer pipe while a resize produces several tiles. The input reader must bound/coalesce a
    // burst, retaining key ordering and applying backpressure rather than ending a live desktop normally.
    await t.ev(`
        H.nativeProcess.child.stdout.pause()
        H.nativeProcess.send('R', Buffer.from([0,0,3,0, 0,0,2,0, 0,0,0,100]))
    `)
    await t.sleep(350)
    await t.ev(`
        const numbers = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((n,i) => b.writeUInt32BE(n,i*4)); return b }
        try {
            for (let i = 0; i < 4096; i++) H.nativeProcess.send('M', numbers(0x0800, i % 500, i % 400))
            // F24 has no default desktop action; repeated Shift would open Windows Sticky Keys.
            for (let i = 0; i < 1200; i++) { H.nativeProcess.send('K', numbers(0, 0x6f, 0)); H.nativeProcess.send('K', numbers(0x8000, 0x6f, 0)) }
        } finally { H.nativeProcess.child.stdout.resume() }
    `)
    await t.sleep(1500)
    t.check('renderer backpressure and an input burst retain the native session', await t.ev(`return H.session(H.nativePane)?.state === 'connected' && H.session(H.nativePane).ui.native.child === H.nativeChild`),
        await t.ev(`return { state: H.session(H.nativePane)?.state, sameChild: H.session(H.nativePane)?.ui?.native?.child === H.nativeChild, log: H.session(H.nativePane)?.log.slice(-12) }`))
    await t.ev(`H.session(H.nativePane).ui.resize(640,480,100)`)
    t.check('display/input recover after the pipe drains', !!await t.waitFor(`const c = H.canvas(H.nativePane); return c?.w === 640 && c?.h === 480 && c?.colors > 20`, 15))
    await t.settings({ resize: 'off' })
    await setPane(740, 520)
    await t.sleep(600)
    const fixed = await t.ev<CanvasInfo>('return H.canvas(H.nativePane)')
    t.check('fixed-resolution mode retains the remote size and fits the picture into the pane', fixed.w === small.w && fixed.h === small.h &&
        fixed.cssW <= fixed.paneW + 2 && fixed.cssH <= fixed.paneH + 2, fixed)
    await t.ev('H.inZone(() => RD.desktop.setViewOnly(H.nativePane, true)); H.nativeKeys = 0')
    await t.press('b')
    t.check('view only blocks native keyboard input', await t.ev('return H.nativeKeys === 0'))
    await t.ev('H.inZone(() => RD.desktop.setViewOnly(H.nativePane, false))')
    await t.ev('H.inZone(() => RD.desktop.disconnect(H.nativePane))')
    t.check('disconnect reaps the native process', !!await t.waitFor(`return H.nativeClosed`, 5))
    t.check('disconnect removes the native UI', await t.ev(`return !H.nativePane.element.nativeElement.querySelector('.trd-freerdp')`))
    await t.ev('H.nativePane.profile.options.glyphCache = true; H.inZone(() => RD.desktop.showDesktop(H.nativePane))')
    t.check('FreeRDP reconnects with glyph caching and strict drawing-order checks', await settle())
    t.check('glyph caching keeps order validation strict and draws pixels', !!await t.waitFor(`
        const log = H.session(H.nativePane).log;
        return log.includes('FreeRDP glyph caching: enabled (experimental)') &&
            log.includes('FreeRDP drawing order checks: strict') && H.canvas(H.nativePane)?.colors > 2;
    `, 10), await t.ev('return H.canvas(H.nativePane)'))
    await t.ev('H.inZone(() => RD.desktop.disconnect(H.nativePane))')
    await t.ev('H.nativePane.profile.options.bitmapCache = true; H.inZone(() => RD.desktop.showDesktop(H.nativePane))')
    t.check('FreeRDP reconnects with bitmap caching and strict drawing-order checks', await settle())
    t.check('bitmap caching keeps order validation strict and draws pixels', !!await t.waitFor(`
        const log = H.session(H.nativePane).log;
        return log.includes('FreeRDP bitmap caching: enabled (experimental)') &&
            log.includes('FreeRDP drawing order checks: strict') && H.canvas(H.nativePane)?.colors > 2;
    `, 10), await t.ev('return H.canvas(H.nativePane)'))
    await t.ev('H.inZone(() => RD.desktop.disconnect(H.nativePane))')
    await t.ev('H.nativePane.profile.options.relaxOrderChecks = true; H.inZone(() => RD.desktop.showDesktop(H.nativePane))')
    t.check('FreeRDP reconnects with relaxed drawing-order checks and remembered trust decisions', await settle())
    t.check('reconnect has a new process and fresh pixels', !!await t.waitFor(`return H.session(H.nativePane)?.ui?.native?.child !== H.nativeChild && H.canvas(H.nativePane)?.colors > 2`, 10))
    await t.dump('H.nativePane', 'freerdp-reconnected')
    if (t.env.direct.kind === 'windows') {
        await t.ev('H.inZone(() => RD.desktop.disconnect(H.nativePane))')
        await t.ev(`H.nativePane.profile.options.clipboard = 'both'; H.inZone(() => RD.desktop.showDesktop(H.nativePane))`)
        t.check('FreeRDP reconnects with the clipboard both ways', await settle())
        t.check('its clipboard is set up for text both ways', !!await t.waitFor(`return H.session(H.nativePane).log.some(line => line.startsWith('clipboard: both ways'))`, 5))
        await t.sleep(3000)
        await t.clickDesktop('H.nativePane')
        await t.ev(`const w = require('@electron/remote').getCurrentWindow(); w.show(); w.focus(); H.canvasElement(H.nativePane).focus()`)
        await t.escape()
        await t.clipboard('notepad'); await t.sleep(500)
        // Run opens Notepad directly; clicking the centre of a restored desktop could focus Explorer instead.
        await t.ev(`
            const n = H.session(H.nativePane).ui.native
            const send = (scan, up = false) => { const b = Buffer.alloc(12); b.writeUInt32BE(up ? 0x8000 : 0); b.writeUInt32BE(scan, 4); n.send('K', b) }
            send(0x15b); send(0x13); send(0x13, true); send(0x15b, true)
        `)
        await t.sleep(1200)
        await t.press('a', ['Control'])
        await t.press('v', ['Control']); await t.sleep(500)
        await t.enter()
        await t.sleep(3000)
        await t.ev(`const w = require('@electron/remote').getCurrentWindow(); w.show(); w.focus(); H.canvasElement(H.nativePane).focus()`)
        await t.press('n', ['Control'])
        await t.sleep(1500)
        const copyBack = async (expected: string) => {
            let got = ''
            for (let attempt = 0; attempt < 2 && !got.includes(expected); attempt++) {
                await t.press('a', ['Control'])
                await t.press('c', ['Control'])
                for (let i = 0; i < 25 && !got.includes(expected); i++) {
                    await t.sleep(200)
                    got = await t.clipboard() ?? ''
                }
            }
            return got
        }
        await t.dump('H.nativePane', 'freerdp-notepad')
        // Windows → here: typed in Notepad, copied there.
        const marker = `fclip${Date.now() % 100000}`
        await t.type(marker)
        await t.clipboard('placeholder')
        // Changing the clipboard here and copying there within moments makes the two clipboards race for ownership,
        // which Windows can lose track of; a pause keeps the steps apart, as a person's would be.
        await t.sleep(800)
        const copied = await copyBack(marker)
        t.check('FreeRDP clipboard Windows → here: text copied in Notepad', copied.includes(marker), copied.slice(0, 80))
        // Here → Windows: pasted into Notepad, then marked there, so that only a paste that worked comes back this way.
        const pasted = `fpaste${Date.now() % 100000}`
        await t.sleep(800)
        await t.clipboard(pasted)
        await t.sleep(800)
        await t.press('a', ['Control'])
        await t.press('v', ['Control'])
        await t.sleep(800)
        await t.type('-x')
        const round = await copyBack(`${pasted}-x`)
        t.check('FreeRDP clipboard here → Windows: pasted into Notepad', round.includes(`${pasted}-x`), round.slice(0, 80))
        // Paste to all: this computer's text sent to the desktop and Ctrl+V pressed there by the plugin, not typed here.
        const toAll = `fall${Date.now() % 100000}`
        await t.clipboard(toAll)
        await t.sleep(300)
        await t.press('a', ['Control'])
        const targets = await t.ev<number>('return H.inZone(() => RD.desktop.pasteToAll(H.nativePane))')
        await t.sleep(1500)
        await t.type('-y')
        const all = await copyBack(`${toAll}-y`)
        t.check('FreeRDP paste to all: pasted into Notepad', targets >= 1 && all.includes(`${toAll}-y`), { targets, got: all.slice(0, 80) })
        // Leave nothing for Notepad to restore: clear the tab and close it.
        await t.press('a', ['Control'])
        await t.key('Delete', 'Delete', 46)
        await t.press('w', ['Control'])
        // Exercise the shared FileTransfer UI/storage layer, in addition to the standalone protocol fixture.
        const here = await t.tempDir('trd-freerdp-files-')
        const folder = 'tabby-ui-files-' + Date.now()
        const remote = `$p=Join-Path $env:TEMP '${folder}';`
        const command = async (script: string) => {
            await t.clipboard('powershell -NoProfile'); await t.sleep(500)
            await t.ev(`
                const n = H.session(H.nativePane).ui.native
                const send = (scan, up = false) => { const b = Buffer.alloc(12); b.writeUInt32BE(up ? 0x8000 : 0); b.writeUInt32BE(scan, 4); n.send('K', b) }
                send(0x15b); send(0x13); send(0x13, true); send(0x15b, true)
            `)
            await t.sleep(600); await t.press('v', ['Control']); await t.sleep(400); await t.enter(); await t.sleep(2000)
            await t.clipboard(script + ';exit'); await t.sleep(500)
            await t.press('v', ['Control']); await t.sleep(400); await t.enter(); await t.sleep(2000)
        }
        await command(remote + `New-Item -ItemType Directory -Force -Path "$p\\nested"|Out-Null;[IO.File]::WriteAllText("$p\\nested\\remote.txt",'remote file marker');Set-Clipboard -Path $p`)
        const offered = await t.waitFor(`return H.session(H.nativePane).files.offered.some(f => f.name === 'remote.txt')`, 10)
        t.check('remote file clipboard offers Save to Downloads', offered && /copied on the remote/.test(await t.ev<string>('return H.toast(H.nativePane)')))
        if (offered) {
            const saved = await t.ev<string[]>(`return await H.session(H.nativePane).files.saveAll(${JSON.stringify(here)})`)
            const file = saved.find(p => p.endsWith('remote.txt'))
            t.check('Save to Downloads keeps nested paths and exact contents', !!file && (await t.readFile(file)) === 'remote file marker', saved.map(p => path.basename(p)))
        }
        await command(remote + 'Start-Process explorer.exe $p')
        await t.ev(`
            const dt = new DataTransfer(); dt.items.add(new File(['dropped file marker'], 'dropped.txt'))
            H.overlay(H.nativePane).dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
        `)
        t.check('dropped file offers a paste notification', !!await t.waitFor(`return /ready: paste/.test(H.toast(H.nativePane))`, 5))
        await t.press('v', ['Control'])
        t.check('dropped file pastes through the FreeRDP provider', !!await t.waitFor(`return /Copied 1 file/.test(H.toast(H.nativePane))`, 10), await t.ev('return H.toast(H.nativePane)'))
        await command(remote + `Set-Clipboard -Value ('DROP:'+ [IO.File]::ReadAllText("$p\\dropped.txt"))`)
        t.check('dropped file has exact contents on Windows', (await t.clipboard()) === 'DROP:dropped file marker')
        if (t.platform === 'darwin' && process.platform === 'darwin') {
            const local = path.join(here, 'copied-folder')
            fs.mkdirSync(local); fs.writeFileSync(path.join(local, 'inner.txt'), 'copied folder marker')
            await command(remote + 'Start-Process explorer.exe $p')
            const writer = spawn('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); var pb = $.NSPasteboard.generalPasteboard; pb.clearContents; pb.writeObjects($([$.NSURL.fileURLWithPath(${JSON.stringify(local)})])); delay(60); ''`], { stdio: 'ignore' })
            t.onCleanup(() => writer.kill())
            await t.sleep(700)
            await t.press('v', ['Meta'])
            t.check('Finder folder clipboard pastes with Command-V', !!await t.waitFor(`return /Copied 1 file/.test(H.toast(H.nativePane))`, 10), await t.ev('return H.toast(H.nativePane)'))
            writer.kill()
            await command(remote + `Set-Clipboard -Value ('FOLDER:'+ [IO.File]::ReadAllText("$p\\copied-folder\\inner.txt"))`)
            t.check('Finder folder arrives with its file intact', (await t.clipboard()) === 'FOLDER:copied folder marker')
        }
        await command(remote + "Remove-Item -LiteralPath $p -Recurse -Force;Set-Clipboard -Value ''")
        await t.ev(`H.nativePane.profile.options.clipboard = 'off'`)
    }
    await t.ev(`
        H.inZone(() => RD.desktop.disconnect(H.nativePane))
        H.nativePane.profile.options.client = 'ironrdp'
        H.inZone(() => RD.desktop.showDesktop(H.nativePane))
    `)
    t.check('the same profile switches back to IronRDP', await settle())
    if (Number.isFinite(settleMs) && settleMs > 0) await t.sleep(Math.min(30000, settleMs))
    t.check('IronRDP uses its own renderer and draws pixels', !!await t.waitFor(`return !!H.overlay(H.nativePane)?.querySelector('iron-remote-desktop') && H.canvas(H.nativePane)?.colors > 2`, 10))
    await t.dump('H.nativePane', 'ironrdp-same-server')
    // Connecting restores the header. A resize reconnect must retain the requested size so Automatic cannot
    // bounce forever between a smaller connecting pane and the larger connected pane, with either backend.
    await t.ev(`H.nativePane.element.nativeElement.style.cssText = ${JSON.stringify(paneStyle)}`)
    await t.settings({ resize: 'reconnect', headerAutoHide: 'automatic' })
    for (const selected of ['ironrdp', client]) {
        await t.ev(`
            H.inZone(() => RD.desktop.disconnect(H.nativePane))
            H.nativePane.profile.options.client = '${selected}'
            H.nativePane.profile.options.relaxOrderChecks = false
            H.inZone(() => RD.desktop.showDesktop(H.nativePane))
        `)
        t.check(selected + ' connects with Automatic header and reconnect resize', await settle())
        await t.sleep(3000)
        const settled = await t.ev<{ connected: boolean, hidden: boolean, matches: boolean }>(`
            H.autoHeaderSession = H.session(H.nativePane)
            const c = H.canvas(H.nativePane)
            return { connected: H.autoHeaderSession?.state === 'connected', hidden: document.querySelector('app-root').classList.contains('trd-auto-hide-header'),
                matches: !!c && Math.abs(c.w-c.paneW) <= 2 && Math.abs(c.h-c.paneH) <= 2 }
        `)
        await t.sleep(2500)
        t.check(selected + ' Automatic header settles without a reconnect loop', settled.connected && settled.hidden && settled.matches &&
            await t.ev(`return H.session(H.nativePane) === H.autoHeaderSession && H.autoHeaderSession.state === 'connected'`), settled)
    }
    await t.settings({ headerAutoHide: 'never', resize: 'off' })
}, { needsHost: false })
