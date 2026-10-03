// A Windows desktop behind an SSH host (TRD_TEST_WIN_*): configured under remoteDesktop.desktops and offered in the
// host's menus; the sign-in form (a wrong password, then the right one); the keychain; its certificate, remembered on
// first use and a changed one stopped before signing in; the picture; live resize; reconnecting with the saved account.
// With WinRM (TRD_TEST_WIN_WINRM), also typing, the clipboard both ways, sound, files both ways with Explorer, and
// shared folders as drives (\\tsclient, read-write and read-only), each checked inside Windows, and H.264: a window
// flipping between two colors comes out in those colors. See test/README.md for the test machine.
import { suite, type AudioStats, type CanvasInfo, type H264Stats, type StatusInfo } from '../lib/harness.js'
import { windowsGuest } from '../lib/windows.js'
import { sampleFlip, windowsFlip } from '../lib/graphics.js'

const NAME = 'Windows (test)'

await suite('windows', async t => {
    const { ev, check, sleep } = t
    const win = t.env.windows
    if (!win.host || !win.account || !win.password) {
        t.skip('windows', 'set TRD_TEST_WIN_USER and TRD_TEST_WIN_PASSWORD (and TRD_TEST_WIN_SSH_HOST / TRD_TEST_WIN_ADDRESS)')
        return
    }
    const [winHost, winPort] = [win.address.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(win.address)?.[1] ?? 3389)]
    const ID = `${winHost}:${winPort}`
    const log = () => ev<string[]>('return RD.desktop.logOf(H.pane)')
    // Waits for the latest connection attempt to end one way or another.
    const outcome = () => t.waitFor<string>(`const log = RD.desktop.logOf(H.pane); const after = log.slice(log.findLastIndex(l => /Connecting to/.test(l)) + 1)
        return after.find(l => /Z $/.test(l)) ?? after.find(l => /failed|ended|cancelled/.test(l)) ?? (H.signin() ? 'signin' : null)`, 40)
    const { guest, inSession, dropTask, dpi } = windowsGuest(t, 'H.pane')
    await ev(`Object.assign(H, {
        signin () {
            const f = H.overlay(H.pane)?.querySelector('.trd-signin form')
            if (!f) return null
            return { user: f.querySelector('[name=username]').value, error: f.querySelector('.trd-signin-error').textContent, focused: document.activeElement?.name ?? null }
        },
        submit (password) {
            const f = H.overlay(H.pane).querySelector('.trd-signin form')
            f.querySelector('[name=password]').value = password
            f.requestSubmit()
        },
        async entries () { return (await H.menuItems(H.pane)).filter(i => i.enabled !== false && !i.submenu && /desktop|console|Windows/i.test(i.label ?? '') && !/^(Send files|Add a desktop|Save |Paste to all|Type into all)/.test(i.label ?? '')).map(i => i.label) },
        trusted (key) { return (H.config.store.remoteDesktop.trustedCertificates ?? []).find(e => e?.desktop === key)?.sha256 ?? null },
        setTrusted (key, sha256) {
            H.inZone(() => {
                const others = (H.config.store.remoteDesktop.trustedCertificates ?? []).filter(e => e?.desktop !== key)
                H.config.store.remoteDesktop.trustedCertificates = sha256 ? [...others, { desktop: key, sha256 }] : others
                H.config.save()
            })
        },
    })`)

    // 0. The desktop behind the host.
    const desktops = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${desktops}; H.config.save() })`))
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = [{ name: ${JSON.stringify(NAME)}, via: ${JSON.stringify(win.host)}, host: ${JSON.stringify(winHost)}, port: ${winPort}, kind: 'windows', username: ${JSON.stringify(win.account)} }]; H.config.save() })`)
    await t.settings({ sound: true, macShortcuts: true, sharpness: 'standard', h264: true })
    // Two folders shared as drives from the start (they apply at connect): one read-write, one read-only.
    const shareDir = await t.tempDir('trd-share-')
    await ev(`const fs = require('fs'); for (const d of ['rw', 'ro']) { fs.mkdirSync(${JSON.stringify(shareDir)} + '/' + d); fs.writeFileSync(${JSON.stringify(shareDir)} + '/' + d + '/hello.txt', 'hello from ' + d) }`)
    const foldersBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.sharedFolders ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.sharedFolders = ${foldersBefore}; H.config.save() })`))
    await ev(`H.inZone(() => RD.desktop.setSharedFolders([{ path: ${JSON.stringify(shareDir)} + '/rw', name: 'trd rw', readOnly: false }, { path: ${JSON.stringify(shareDir)} + '/ro', name: 'trd ro', readOnly: true }]))`)
    check('SSH tab connected', await ev(`H.pane = await H.openSSH({ host: ${JSON.stringify(win.host)}, user: ${JSON.stringify(win.user)} }); return !!H.pane`))
    const key = await ev(`return (await RD.targets.targetOf(H.pane)).key + '#' + ${JSON.stringify(ID)}`)
    const keychainWorks = await t.keychainWorks()
    if (keychainWorks) {
        await t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`)
        t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`))
    }
    const trustedBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.trustedCertificates ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.trustedCertificates = ${trustedBefore}; H.config.save() })`))
    await ev(`H.setTrusted(${JSON.stringify(key)}, null)`)
    const reachable = (await t.remote('H.pane', `timeout 3 bash -c '</dev/tcp/${winHost}/${winPort}' && echo open`)).trim()
    check(`RDP port ${ID} reachable from ${win.host}`, reachable === 'open', reachable)
    const winrm = !!win.winrm && /ready/.test(await guest("'ready'").catch(() => ''))
    if (!winrm) {
        t.skip('checks inside Windows (typing, clipboard, sound, files)', win.winrm ? `no answer from WinRM at ${win.winrm} (pywinrm installed on ${win.host}?)` : 'set TRD_TEST_WIN_WINRM')
    }

    // 1. The menus offer both desktops.
    const menu = await ev<string[]>('return await H.entries()')
    check('the menu offers the host\'s own desktop and the Windows one', menu.includes(`Open ${win.host} desktop`) && menu.includes(`Open ${NAME}`), menu)

    // 2. The sign-in form; a wrong password brings it back with an error.
    const t0 = Date.now()
    await ev(`await H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(ID)}))`)
    let form = await t.waitFor<{ user: string, error: string, focused: string | null }>('return H.signin()', 10)
    check('sign-in form, user name filled in, password focused', form?.user === win.account && form?.focused === 'password', form)
    check('terminal input disabled under the form', await ev(`return [...H.pane.element.nativeElement.querySelectorAll('textarea.xterm-helper-textarea')].every(x => x.disabled)`))
    await ev('H.submit("definitely-not-the-password")')
    await sleep(500)
    form = await t.waitFor<{ user: string, error: string, focused: string | null }>('const f = H.signin(); return f?.error ? f : null', 40)
    check('wrong password: the form again, with an error', /wrong|refused/i.test(form?.error ?? ''), { form, log: (await log()).slice(-3) })
    if (keychainWorks) {
        check('a wrong password is not saved', !(await t.keychain(`getPassword('tabby-rdp', ${JSON.stringify(key)})`)))
    }

    // 3. The right password: connected, saved in the keychain, the picture drawn.
    const t1 = Date.now()
    await ev(`H.submit(${JSON.stringify(win.password)})`)
    check('desktop connected', /Z $/.test(await outcome() ?? ''), (await log()).slice(-4))
    t.time('sign-in → connected', Date.now() - t1)
    const frame = await t.waitFor<CanvasInfo>('const c = H.canvas(H.pane); return c?.colors > 10 ? c : null', 10)
    t.time('open → first frame', Date.now() - t0)
    check('Windows frame decoded', !!frame, await ev('return H.canvas(H.pane)'))
    await t.dump('H.pane', 'windows-connected')
    check('resolution = pane size', frame && Math.abs(frame.w - frame.paneW) <= 2 && Math.abs(frame.h - frame.paneH) <= 2, frame)
    if (keychainWorks) {
        check('the account is saved in the keychain', !!(await t.waitFor(`return await require('keytar').getPassword('tabby-rdp', ${JSON.stringify(key)})`, 5)))
    } else {
        t.skip('the account is saved in the keychain, and reused', 'the system keychain does not answer (Linux: no unlocked keyring)')
    }
    check('the header names the desktop', /Windows|console/.test(await ev<string>(`return document.querySelector('.trd-header-toggle')?.title ?? ''`)))
    // With H.264 (on by default, where Tabby's WebCodecs decodes it) Windows gets the graphics pipeline; else bitmaps.
    const graphics = await ev<string | null>('return RD.desktop.logOf(H.pane).findLast(l => /^graphics: /.test(l)) ?? null')
    const decodes = await ev('return !!H.session(H.pane)?.h264')
    check(decodes ? 'graphics pipeline with H.264' : 'bitmaps (this Tabby does not decode H.264)', decodes ? /with H\.264/.test(graphics ?? '') : /bitmaps/.test(graphics ?? ''), graphics)
    // The certificate: remembered on first use, and checked after the legacy TLS retry when Windows needed one.
    const certificate = await ev<string | null>(`return H.trusted(${JSON.stringify(key)})`)
    check('its certificate remembered on first use', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(certificate ?? ''), certificate)
    const order = await ev<number[]>('const log = RD.desktop.logOf(H.pane); return [log.findIndex(l => /using TLS 1\\.2/.test(l)), log.findIndex(l => /^certificate: /.test(l))]')
    check(`the certificate checked${order[0] >= 0 ? ' after the TLS 1.2 retry' : ''}`, order[1] >= 0 && order[1] > order[0], order)

    if (winrm) {
        // 4. Typing: Start (the Windows key), "notepad", Enter; Windows runs Notepad.
        const notepad = async () => {
            let id = ''
            for (let i = 0; i < 20 && !/\d/.test(id); i++) {
                await sleep(500)
                id = (await guest('(Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -First 1).Id')).trim()
            }
            return id
        }
        // Notepad keeps unsaved tabs across restarts. Note its saved tabs before this suite touches it; at the end,
        // stop it and remove the ones that appeared since (this suite's), nothing else.
        const TAB_STATE = "$state = Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.WindowsNotepad_8wekyb3d8bbwe\\LocalState\\TabState'"
        const stopNotepad = () => guest('Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Milliseconds 500')
        await stopNotepad()
        const notepadTabs = (await guest(`${TAB_STATE}; if (Test-Path $state) { (Get-ChildItem $state -File | ForEach-Object Name) -join '|' }`)).trim()
        t.onCleanup(async () => {
            await stopNotepad()
            await guest(`${TAB_STATE}; $keep = '${notepadTabs}'.Split('|')
if (Test-Path $state) { Get-ChildItem $state -File | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Force }`)
        })
        // The first sign-in after a boot shows "Welcome" for a while: wait for the desktop shell.
        for (let i = 0; i < 40 && !/\d/.test((await guest('(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).Id')).trim()); i++) {
            await sleep(1500)
        }
        await sleep(3000)

        // H.264: a full-screen window flipping between two colors (fast-changing, which Windows streams as video).
        const h264 = () => ev<H264Stats | null>('const d = H.session(H.pane)?.h264; return d ? { ...d.stats, failed: d.failed } : null')
        const h264Before = await h264()
        await inSession('trd-flip', windowsFlip(20))
        await sleep(8000)  // Windows takes the noise for video after about five seconds
        const picture = await sampleFlip(t, 'H.pane')
        await t.dump('H.pane', 'windows-flip')
        check('the picture has the window\'s colors (both of them, nothing else)', picture.ok, picture)
        if (decodes) {
            const after = await h264()
            const frames = (after?.frames ?? 0) - (h264Before?.frames ?? 0)
            check('no H.264 decoder failure', !after?.failed, after)
            const auxiliary = (after?.auxiliary ?? 0) - (h264Before?.auxiliary ?? 0)
            check(`H.264 frames decoded (${frames}, ${auxiliary} of them AVC444 auxiliary views; last ${after?.lastLatencyMs?.toFixed(1)} ms from arrival to pixels)`, frames > 0, after)
            t.time('H.264 frame, arrival to pixels (last, Windows)', Math.round(after?.lastLatencyMs ?? 0))
        }
        await sleep(9000)  // the window closes by itself
        await dropTask('trd-flip')

        await t.clickDesktop('H.pane')
        // Right after a first sign-in, Start can take a while to accept typing: one more try if needed.
        let typed = ''
        for (let attempt = 0; attempt < 2 && !/\d/.test(typed); attempt++) {
            await t.escape()
            await t.tap('Meta')  // the Windows key (on macOS a ⌘ tap, with Mac shortcuts on)
            await sleep(3000)    // Start takes a moment to take keys
            await t.type('notepad')
            await sleep(2000)
            await t.enter()
            typed = await notepad()
        }
        check('typing reaches Windows (Start, "notepad", Enter: Notepad runs)', /\d/.test(typed))
        await stopNotepad()

        // 5. Clipboard, here → Windows: "notepad" copied here, pasted into Start search.
        await t.clipboard('notepad')
        await sleep(600)
        await t.tap('Meta')
        await sleep(3000)
        await t.press('v', ['Control'])
        await sleep(2000)
        await t.enter()
        const running = await notepad()
        check('clipboard here → Windows: pasted into Start search, Notepad runs', /\d/.test(running))

        // 6. Clipboard, Windows → here: type in Notepad, select all, copy.
        if (/\d/.test(running)) {
            await sleep(2500)
            await t.clickDesktop('H.pane')  // Notepad opens over the middle of the screen: give it the keyboard
            await t.press('n', ['Control'])
            await sleep(1500)
            const marker = `winclip${Date.now() % 100000}`
            await t.type(marker)
            await t.clipboard('placeholder')
            let got = ''
            for (let attempt = 0; attempt < 2 && !got.includes(marker); attempt++) {
                await t.press('a', ['Control'])
                await t.press('c', ['Control'])
                for (let i = 0; i < 25 && !got.includes(marker); i++) {
                    await sleep(200)
                    got = await t.clipboard()
                }
            }
            check('clipboard Windows → here: text copied in Notepad', got.includes(marker), got.slice(0, 80))
            // Leave nothing for Notepad to restore: clear the tab and close it.
            await t.press('a', ['Control'])
            await t.key('Delete', 'Delete', 46)
            await t.press('w', ['Control'])
        }
        await stopNotepad()

        // 7. Sound: a system sound played in the session arrives here.
        const audio = () => ev<AudioStats | null>('const a = H.session(H.pane)?.audio; return a ? { received: a.received, peak: a.peak } : null')
        const before = await audio()
        const play = () => inSession('trd-sound', "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav').PlaySync()")
        t.onCleanup(() => dropTask('trd-sound'))
        let after = before
        // Windows now and then drops the first sound of a new session: play it once more if nothing came.
        for (let attempt = 1; attempt <= 2 && (after?.received ?? 0) - (before?.received ?? 0) < 1; attempt++) {
            if (attempt === 2) console.log('NOTE  sound: nothing arrived, playing it again')
            await play()
            for (let i = 0; i < 30 && (after?.received ?? 0) - (before?.received ?? 0) < 1; i++) {
                await sleep(500)
                after = await audio()
            }
        }
        const seconds = (after?.received ?? 0) - (before?.received ?? 0)
        check(`sound: a Windows sound arrived (${seconds.toFixed(1)} s)`, seconds > 1 && (after?.peak ?? 0) > 0.05, { before, after })

        // 8. Files: Explorer on a folder with a file made on Windows.
        // In the account's own profile: a non-administrator can't create folders in C:\Users\Public.
        const folder = (await guest('$env:USERPROFILE')).trim() + '\\trd-test-files'
        await guest(`New-Item -ItemType Directory -Force -Path '${folder}' | Out-Null; Set-Content -Path '${folder}\\from-windows.txt' -Value 'made on Windows' -NoNewline`)
        t.onCleanup(() => guest(`Remove-Item -Recurse -Force '${folder}' -ErrorAction SilentlyContinue`))
        await inSession('trd-explorer', `explorer.exe ${folder}`)
        await sleep(4000)
        await dropTask('trd-explorer')
        await t.press('a', ['Control'])
        await t.press('c', ['Control'])
        const offered = await t.waitFor<string[]>('const f = H.session(H.pane)?.files?.offered ?? []; return f.length ? f.map(x => x.name) : null', 10, 300)
        check('files: copied in Explorer, offered here', offered?.includes('from-windows.txt'), offered)
        const here = await t.tempDir('trd-winfiles-')
        const saved = offered ? await ev<string[]>(`return await H.session(H.pane).files.saveAll(${JSON.stringify(here)})`) : []
        const savedFile = saved.find(f => f.endsWith('from-windows.txt'))
        check('files: saved here, same content', !!savedFile && await t.readFile(savedFile) === 'made on Windows', saved)
        const content = `made here ${Date.now()}`
        await ev(`const overlay = H.overlay(H.pane); const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(content)}], 'from-here.txt', { type: 'text/plain' }))
            overlay.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); overlay.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))`)
        await sleep(800)
        await t.press('v', ['Control'])
        let arrived = ''
        for (let i = 0; i < 20 && arrived !== content; i++) {
            await sleep(500)
            arrived = (await guest(`Get-Content -Raw -ErrorAction SilentlyContinue '${folder}\\from-here.txt'`)).trim()
        }
        check('files: dropped on the desktop, pasted in Explorer, same content', arrived === content, arrived)
        await t.key('F4', 'F4', 115, ['Alt'])  // close Explorer

        // 8b. Shared folders: drives in the session (\\tsclient\<name>), read and written from Windows; the read-only
        // one refuses a write. PowerShell in the session reports what it saw.
        check('drives announced at connect', (await log()).some(l => /^drives: trd rw, trd ro \(read-only\)/.test(l)), (await log()).filter(l => /^drives/.test(l)))
        await guest('Remove-Item "$env:TEMP\\trd-drive.txt" -ErrorAction SilentlyContinue')
        const stamp = `from Windows ${Date.now()}`
        // A few megabytes too: reads and writes at offsets, in the server's pieces.
        const bigHash = await ev<string>(`const crypto = require('crypto'); const data = crypto.randomBytes(3 * 1024 * 1024 + 12345); require('fs').writeFileSync(${JSON.stringify(shareDir)} + '/rw/big.bin', data); return crypto.createHash('sha256').update(data).digest('hex')`)
        await inSession('trd-drive', `
$r = @()
try { $r += 'read:' + (Get-Content -Raw '\\\\tsclient\\trd rw\\hello.txt') } catch { $r += "read failed: $_" }
try { [IO.File]::WriteAllText('\\\\tsclient\\trd rw\\from-windows.txt', '${stamp}'); $r += 'written' } catch { $r += "write failed: $_" }
try { New-Item -ItemType Directory -Path '\\\\tsclient\\trd rw\\made' | Out-Null; Rename-Item '\\\\tsclient\\trd rw\\made' 'renamed'; $r += 'folder' } catch { $r += "folder failed: $_" }
try { $r += 'list:' + ((Get-ChildItem '\\\\tsclient\\trd rw' | Select-Object -ExpandProperty Name | Sort-Object) -join ',') } catch { $r += "list failed: $_" }
try { $r += 'hash:' + (Get-FileHash -Algorithm SHA256 '\\\\tsclient\\trd rw\\big.bin').Hash.ToLower() } catch { $r += "hash failed: $_" }
try { Copy-Item '\\\\tsclient\\trd rw\\big.bin' '\\\\tsclient\\trd rw\\copy.bin'; $r += 'copied' } catch { $r += "copy failed: $_" }
try { $r += 'ro read:' + (Get-Content -Raw '\\\\tsclient\\trd ro\\hello.txt') } catch { $r += "ro read failed: $_" }
try { [IO.File]::WriteAllText('\\\\tsclient\\trd ro\\x.txt', 'x'); $r += 'ro write: allowed' } catch { $r += 'ro write: refused' }
Set-Content "$env:TEMP\\trd-drive.txt" ($r -join '|')`)
        let report = ''
        for (let i = 0; i < 40 && !report; i++) {
            await sleep(500)
            report = (await guest('Get-Content -Raw "$env:TEMP\\trd-drive.txt" -ErrorAction SilentlyContinue')).trim()
        }
        await dropTask('trd-drive')
        check('drives: Windows reads a file from the shared folder', /read:hello from rw/.test(report), report)
        check('drives: Windows writes a file into it, same content here', await t.readFile(`${shareDir}/rw/from-windows.txt`) === stamp, report)
        check('drives: a folder made and renamed from Windows', /\|folder\|/.test(report) && await ev(`return require('fs').existsSync(${JSON.stringify(shareDir)} + '/rw/renamed')`), report)
        check('drives: Windows lists the folder', /list:big.bin,from-windows.txt,hello.txt,renamed/.test(report), report)
        check('drives: a 3 MB file read on Windows hashes the same', report.includes(`hash:${bigHash}`), report)
        const copyHash = await ev<string>(`try { return require('crypto').createHash('sha256').update(require('fs').readFileSync(${JSON.stringify(shareDir)} + '/rw/copy.bin')).digest('hex') } catch (e) { return String(e) }`)
        check('drives: ... and copied on Windows, back here, the same', copyHash === bigHash, { report, copyHash })
        check('drives: the read-only folder reads but refuses a write', /ro read:hello from ro\|ro write: refused/.test(report) && !(await ev(`return require('fs').existsSync(${JSON.stringify(shareDir)} + '/ro/x.txt')`)), report)
    }

    // 9. Live resize: Windows follows the pane.
    await ev(`const el = H.pane.element.nativeElement; el.style.flex = 'none'; el.style.width = '760px'; el.style.height = '540px'`)
    const resized = await t.waitFor<CanvasInfo>(`const c = H.canvas(H.pane); return c && Math.abs(c.w - c.paneW) <= 2 && Math.abs(c.h - c.paneH) <= 2 && c.w !== ${frame?.w ?? 0} ? c : null`, 10, 250)
    check('live resize: the Windows resolution follows the pane', !!resized, { before: frame, now: await ev('return H.canvas(H.pane)') })
    check('live resize: same session', (await log()).filter(l => /Connecting to/.test(l)).length === 2)  // wrong password, then right

    // 9b. Windows' scale follows the sharpness: Retina for this desktop only is 200% there (at device pixels), and
    // "As above" (the default, Standard) back to 100%.
    const dpr = await ev<number>('return window.devicePixelRatio')
    if (winrm && dpr > 1) {
        const sharpness = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktopSharpness ?? [])')
        t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktopSharpness = ${sharpness}; H.config.save() })`))
        await ev('H.inZone(() => RD.desktop.setOwnSharpness(H.pane, "retina"))')
        await sleep(3000)
        const retina = await dpi()
        check(`Retina for this desktop: Windows at ${Math.round(96 * dpr)} DPI`, retina === Math.round(96 * dpr), retina)
        await ev('H.inZone(() => RD.desktop.setOwnSharpness(H.pane, null))')
        await sleep(3000)
        const standard = await dpi()
        check('"As above" (Standard): Windows back at 96 DPI', standard === 96, standard)
    }

    // 10. Back to the console; then the toggle reopens Windows with the saved account (no form).
    await ev('H.inZone(() => RD.desktop.showConsole(H.pane))')
    check('the toggle names the Windows desktop', (await ev<string[]>('return await H.entries()'))[0] === `Show ${NAME}`, await ev('return await H.entries()'))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    if (keychainWorks) {
    const t2 = Date.now()
    await ev('await H.inZone(() => RD.desktop.toggle(H.pane))')  // the last-used desktop: Windows
    const last = await outcome()
    t.time('reconnect with the saved account', Date.now() - t2)
    check('the toggle reopens Windows with the saved account, no form', /Z $/.test(last ?? '') && !(await ev('return H.signin()')), last)

    // 11. A changed certificate: stopped before signing in, with both fingerprints; trusting it connects.
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    const bogus = Array(32).fill('AB').join(':')
    await ev(`H.setTrusted(${JSON.stringify(key)}, ${JSON.stringify(bogus)})`)
    await ev('await H.inZone(() => RD.desktop.toggle(H.pane))')
    const changed = await t.waitFor<StatusInfo>(`const s = H.status(H.pane); return s && /has changed/.test(s.text) ? s : null`, 40)
    check('changed certificate: both fingerprints, "Trust the new certificate" and "Cancel"',
        changed?.buttons.join() === 'Trust the new certificate,Cancel' && changed?.text.includes(bogus.slice(0, 47)) && changed.text.includes((certificate ?? "-").slice(0, 47)), changed ?? (await log()).slice(-4))
    check('... stopped before signing in', !(await log()).some(l => /RDCleanPath relay up/.test(l)))
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Trust the new certificate'))`)
    check('"Trust the new certificate": connected, the certificate remembered again', /Z $/.test(await outcome() ?? '') && await ev(`return H.trusted(${JSON.stringify(key)})`) === certificate)
    } else {
        t.skip('reconnecting with the saved account, and a changed certificate', 'the system keychain does not answer (Linux: no unlocked keyring)')
    }

    // 12. A saved account (with or without a keyring: Tabby's Vault is turned on for it): the desktop signs in with it in
    // place of its own saved account; without a password yet, the form asks and saves it as the account's; a wrong one brings the form back with the account's name, and "Sign in again…" asks anew.
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    const vaultWas = await ev<boolean>('return RD.injector.get(require("tabby-core").VaultService).isEnabled()')
    if (!vaultWas) {
        // Tabby remembers the passphrase only through its unlock prompt: answered here by the service itself.
        await ev(`const V = RD.injector.get(require("tabby-core").VaultService); H.vaultMethods = { getPassphrase: V.getPassphrase, isOpen: V.isOpen }
            V.getPassphrase = async () => "trd-test-vault"; V.isOpen = () => true
            await V.setEnabled(true, "trd-test-vault")`)
        // Off again afterwards, its methods put back, and out of the config: a Vault left on would make every later SSH
        // connection ask for it.
        t.onCleanup(() => ev(`H.inZone(() => { const V = RD.injector.get(require("tabby-core").VaultService); V.setEnabled(false); Object.assign(V, H.vaultMethods)
            H.config.store.vault = null; H.config.save() })`))
    }
    const accountsBefore = await ev('return JSON.stringify(H.config.store.remoteDesktop.accounts ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.accounts = ${accountsBefore}; H.config.save() })`))
    const accountId = await ev<string>(`return (await RD.desktop.saveAccount({ name: 'Windows test account', username: ${JSON.stringify(win.account)} })).id`)
    t.onCleanup(() => ev(`await RD.desktop.removeAccount(${JSON.stringify(accountId)})`))
    await ev(`H.inZone(() => { const d = H.config.store.remoteDesktop.desktops.find(d => d.name === ${JSON.stringify(NAME)}); d.account = ${JSON.stringify(accountId)}; H.config.save() })`)
    check('the Accounts list names the desktop that uses the account', (await ev<{ name: string }[]>(`return RD.desktop.accountUses(${JSON.stringify(accountId)})`)).some(u => u.name === NAME))
    await ev('await H.inZone(() => RD.desktop.toggle(H.pane))')
    form = await t.waitFor<{ user: string, error: string, focused: string | null }>('return H.signin()', 20)
    const locked = await ev('return H.overlay(H.pane).querySelector(".trd-signin [name=username]")?.readOnly === true')
    const rememberLabel = await ev<string>('return H.overlay(H.pane).querySelector(".trd-signin-remember")?.textContent.trim() ?? ""')
    check('no password saved yet: the form asks, with the account\'s user name locked and "Save as the password of …"', form?.user === win.account && locked && /Save as the password of "Windows test account"/.test(rememberLabel), { form, locked, rememberLabel })
    await ev('H.submit("definitely-not-the-password")')
    form = await t.waitFor<{ user: string, error: string, focused: string | null }>('const f = H.signin(); return f?.error ? f : null', 40)
    check('a wrong password: the form again, for the account', /wrong|refused/i.test(form?.error ?? '') && form?.user === win.account, form)
    await ev(`H.submit(${JSON.stringify(win.password)})`)
    check('the right one connects', /Z $/.test(await outcome() ?? ''), (await log()).slice(-3))
    check('... and is saved as the account\'s password', !!(await t.waitFor(`return (await RD.desktop.accountHasPassword(${JSON.stringify(accountId)})) === 'yes'`, 5)))
    check('the log says the account was used on the next connection', await (async () => {
        await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
        await ev('await H.inZone(() => RD.desktop.toggle(H.pane))')
        const result = await outcome()
        return /Z $/.test(result ?? '') && !(await ev('return H.signin()')) && (await log()).some(l => /sign-in: the saved account "Windows test account"/.test(l))
    })(), (await log()).slice(-4))
    await ev('H.inZone(() => RD.desktop.signInAgain(H.pane))')
    form = await t.waitFor<{ user: string, error: string, focused: string | null }>('return H.signin()', 20)
    check('"Sign in again…" asks for the account\'s password anew', form?.user === win.account, form)
    await ev(`H.submit(${JSON.stringify(win.password)})`)
    check('connected again', /Z $/.test(await outcome() ?? ''))
})
