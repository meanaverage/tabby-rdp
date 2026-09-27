// Linux desktops served by xrdp (TRD_TEST_XRDP_*; testbed/linux/xrdp.sh sets up the test host): found by the setup
// next to GNOME and offered as a second desktop; a host without GNOME (simulated: the setup runs with a PATH without
// grdctl and gnome-shell) gets xrdp as its own desktop: the sign-in form, the Linux password, xrdp signing in by
// itself (INFO_AUTOLOGON), the picture, typing and the clipboard in the XFCE session, the keychain, "Sign in again…",
// live resize (xrdp 0.10 and later); and the error with its hint when neither runs.
import { suite } from '../lib/harness.mjs'

await suite('xrdp', async t => {
    const { ev, check, sleep } = t
    const x = t.env.xrdp
    if (!x.password) {
        t.skip('xrdp', 'set TRD_TEST_XRDP_PASSWORD (and TRD_TEST_XRDP_USER, TRD_TEST_XRDP_PORT); see testbed/linux/xrdp.sh')
        return
    }
    const host = t.env.host
    const XRDP_ID = `127.0.0.1:${x.port}`
    const NO_GNOME = '$HOME/.cache/trd-test-no-gnome'
    const log = pane => ev(`return RD.desktop.logOf(${pane})`)
    // How the first connection attempt from log line `from` on ended: connected (the status cleared, '…Z '), failed or
    // ended. (Counting from "Connecting to": the status is also cleared for the sign-in form, before it.)
    const outcome = (pane, from = 0) => t.waitFor(`const log = RD.desktop.logOf(${pane}); const i = log.findIndex((l, n) => n >= ${from} && /Connecting to/.test(l))
        if (i < 0) return null
        const after = log.slice(i + 1)
        return after.find(l => /Z $/.test(l)) ?? after.find(l => /failed|ended|cancelled/.test(l)) ?? null`, 40)
    await ev(`Object.assign(H, {
        signin (p) {
            const f = H.overlay(p)?.querySelector('.trd-signin form')
            if (!f) return null
            return { title: f.querySelector('.trd-signin-title').textContent, user: f.querySelector('[name=username]').value, focused: document.activeElement?.name ?? null }
        },
        submit (p, password) {
            const f = H.overlay(p).querySelector('.trd-signin form')
            f.querySelector('[name=password]').value = password
            f.requestSubmit()
        },
        async labels (p) { return (await H.menu(p)).map(i => i.label) },
    })`)
    await t.settings({ resize: 'live', sharpness: 'standard', sound: false })
    const desktops = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${desktops}; H.config.save() })`))
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = []; H.config.save() })`)

    // 0. xrdp runs only for this suite (testbed/linux/xrdp.sh leaves it stopped), through the test user's sudo.
    check('SSH tab for the test user connected', await ev('H.admin = await H.openSSH(); return !!H.admin'))
    const listening = async () => /LISTEN/.test(await t.remote('H.admin', `ss -ltnH 'sport = :${x.port}' | sed 's/^/LISTEN /'`))
    const wasRunning = await listening()
    if (!wasRunning) {
        const started = await t.remote('H.admin', 'sudo -n systemctl start xrdp 2>&1 && echo started')
        t.onCleanup(() => t.remote('H.admin', 'sudo -n systemctl stop xrdp; true'))
        check('xrdp started (sudo -n systemctl start xrdp)', /started/.test(started), started.trim())
        for (let i = 0; i < 20 && !await listening(); i++) await sleep(250)
    }
    check(`xrdp listens on ${x.port}`, await listening())
    const version = (await t.remote('H.admin', `dpkg-query -W -f '\${Version}' xrdp 2>/dev/null`)).trim()
    console.log(`NOTE  xrdp ${version || 'version unknown'}`)
    const adminKey = await ev('return (await RD.targets.targetOf(H.admin)).key')
    t.onCleanup(() => ev(`RD.desktop.ownDesktops.delete(${JSON.stringify(adminKey)})`))

    // 1. GNOME and xrdp on one host: GNOME stays the own desktop, xrdp is offered next to it once the setup has run.
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.admin))')
    check('GNOME desktop connected', /Z $/.test(await outcome('H.admin') ?? ''), (await log('H.admin')).slice(-3))
    check('its kind is still GNOME', await ev('return RD.desktop.desktopOf(H.admin)?.kind') === 'gnome')
    const labels = await ev('return await H.labels(H.admin)')
    check(`the menu offers "Open ${host} desktop (xrdp)"`, labels.includes(`Open ${host} desktop (xrdp)`), labels)
    await ev(`await H.inZone(() => RD.desktop.showDesktop(H.admin, ${JSON.stringify(XRDP_ID)}))`)
    const both = await t.waitFor('return H.signin(H.admin)', 15)
    check('opening it: the sign-in form, with the SSH user filled in', both?.user === t.env.user && both?.title === `Sign in to ${host} desktop (xrdp)`, both)
    check('xrdp as a desktop at the loopback port', await ev(`const s = RD.desktop.desktopOf(H.admin); return s?.kind === 'xrdp' && s.port === ${x.port}`))
    await t.escape()
    await sleep(300)
    await ev('H.inZone(() => RD.desktop.disconnect(H.admin))')

    // 2. A configured desktop of kind xrdp keeps its kind.
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = [{ name: 'xrdp (config)', via: ${JSON.stringify(host)}, host: '127.0.0.1', port: ${x.port}, kind: 'xrdp' }]; H.config.save() })`)
    const configured = await ev(`return RD.desktop.desktopsOf(await RD.targets.targetOf(H.admin)).map(s => s.name + ':' + s.kind)`)
    check('remoteDesktop.desktops: kind xrdp, and it replaces the detected entry for that port', configured.includes('xrdp (config):xrdp') && !configured.some(c => c.includes('desktop (xrdp)')), configured)
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = []; H.config.save() })`)

    // 3. A host without GNOME, as the xrdp account sees it: the setup runs with a PATH that lacks grdctl and gnome-shell.
    check(`SSH tab for ${x.user} connected`, await ev(`H.pane = await H.openSSH({ user: ${JSON.stringify(x.user)} }); return !!H.pane`))
    await t.remote('H.pane', `D=${NO_GNOME}; rm -rf "$D"; mkdir -p "$D"
        for f in /usr/local/bin/* /usr/bin/* /usr/sbin/* /bin/* /sbin/*; do n=\${f##*/}; [ -e "$D/$n" ] || ln -s "$f" "$D/$n"; done
        rm -f "$D/grdctl" "$D/gnome-shell"; true`)
    t.onCleanup(() => t.remote('H.pane', `rm -rf ${NO_GNOME}; true`))
    await ev(`const target = await RD.targets.targetOf(H.pane)
        const exec = target.exec.bind(target)
        target.exec = (command, stdin) => exec(command === 'sh -s' && stdin.includes('RD_XRDP') ? 'PATH="${NO_GNOME}" sh -s' : command, stdin)`)
    t.onCleanup(() => ev('RD.targets.targetOf(H.pane).then(target => { delete target.exec })'))
    const key = await ev('return (await RD.targets.targetOf(H.pane)).key')
    t.onCleanup(() => ev(`RD.desktop.ownDesktops.delete(${JSON.stringify(key)})`))
    const keychainWorks = await t.keychainWorks()
    if (keychainWorks) {
        await t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`)
        t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`))
    }
    // End the XFCE session at the end (xrdp would otherwise keep it for the next run).
    t.onCleanup(() => t.remote('H.pane', 'pkill -u "$(id -u)" -x xfce4-session; true'))

    const t0 = Date.now()
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    const form = await t.waitFor('return H.signin(H.pane)', 20)
    check('the own desktop asks for the Linux account, user name filled in, password focused', form?.user === x.user && form?.focused === 'password' && form?.title === `Sign in to ${host} desktop`, form)
    check('its kind is xrdp', await ev('return RD.desktop.desktopOf(H.pane)?.kind') === 'xrdp')
    const t1 = Date.now()
    const before = (await log('H.pane')).length
    await ev(`H.submit(H.pane, ${JSON.stringify(x.password)})`)
    check('xrdp desktop connected', /Z $/.test(await outcome('H.pane', before) ?? ''), (await log('H.pane')).slice(-4))
    t.time('sign-in → connected', Date.now() - t1)
    const session = (await t.remote('H.pane', `for i in $(seq 80); do p=$(pgrep -u "$(id -u)" -x xfce4-session) && break; sleep 0.25; done; echo "$p"`)).trim()
    check('xrdp signed in by itself (no login window): an XFCE session runs', /^\d+/.test(session), session)
    const frame = await t.waitFor('const c = H.canvas(H.pane); return c?.colors > 10 ? c : null', 20)
    t.time('open → first frame', Date.now() - t0)
    check('XFCE frame decoded', !!frame, await ev('return H.canvas(H.pane)'))
    await t.dump('H.pane', 'xrdp-connected')
    check('resolution = pane size', frame && Math.abs(frame.w - frame.paneW) <= 2 && Math.abs(frame.h - frame.paneH) <= 2, frame)
    if (keychainWorks) {
        check('the account is saved in the keychain', !!(await t.waitFor(`return await require('keytar').getPassword('tabby-rdp', ${JSON.stringify(key)})`, 5)))
    } else {
        t.skip('the account is saved in the keychain, and reused', 'the system keychain does not answer (Linux: no unlocked keyring)')
    }

    // 4. Typing and the clipboard: a terminal in the XFCE session reads two lines into files.
    const display = `$(tr '\\0' '\\n' < /proc/${session.split('\n')[0]}/environ | sed -n 's/^DISPLAY=//p')`
    await t.remote('H.pane', `rm -f /tmp/trd-xrdp-typed /tmp/trd-xrdp-pasted
        DISPLAY=${display} nohup xfce4-terminal --disable-server --maximize --title trd-xrdp-test -x sh -c 'read l; printf %s "$l" > /tmp/trd-xrdp-typed; read l; printf %s "$l" > /tmp/trd-xrdp-pasted' >/dev/null 2>&1 &
        for i in $(seq 60); do pgrep -u "$(id -u)" -f 'trd-xrdp-typed' >/dev/null && break; sleep 0.25; done; sleep 1.5`)
    t.onCleanup(() => t.remote('H.pane', `pkill -u "$(id -u)" -f 'trd-xrdp-typed'; rm -f /tmp/trd-xrdp-typed /tmp/trd-xrdp-pasted; true`))
    await t.clickDesktop('H.pane')
    await t.type('xrdpok42')
    await t.enter()
    let typed = ''
    for (let i = 0; i < 10 && !typed; i++) {
        await sleep(500)
        typed = (await t.remote('H.pane', 'cat /tmp/trd-xrdp-typed 2>/dev/null')).trim()
    }
    check('typing reaches the xrdp desktop', typed === 'xrdpok42', typed)
    const clip = `xrdpclip${Date.now() % 100000}`
    await t.clipboard(clip)
    await sleep(800)
    await t.press('v', ['Control', 'Shift'])  // xfce4-terminal's paste
    await t.enter()
    let pasted = ''
    for (let i = 0; i < 10 && !pasted; i++) {
        await sleep(500)
        pasted = (await t.remote('H.pane', 'cat /tmp/trd-xrdp-pasted 2>/dev/null')).trim()
    }
    check('clipboard here → xrdp (its cliprdr channel): pasted in the terminal', pasted === clip, pasted)

    // 5. Live resize: xrdp 0.10 answers display control (a deactivation-reactivation); 0.9 keeps its size.
    const [major, minor] = (/^(?:\d+:)?(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number)
    if (major > 0 || minor >= 10) {
        const connects = (await log('H.pane')).filter(l => /Connecting to/.test(l)).length
        await ev(`const el = H.pane.element.nativeElement; el.style.flex = 'none'; el.style.width = '760px'; el.style.height = '540px'`)
        const resized = await t.waitFor(`const c = H.canvas(H.pane); return c && Math.abs(c.w - c.paneW) <= 2 && Math.abs(c.h - c.paneH) <= 2 && c.w !== ${frame?.w ?? 0} ? c : null`, 10, 250)
        check('live resize: the xrdp resolution follows the pane', !!resized, { before: frame, now: await ev('return H.canvas(H.pane)') })
        check('live resize: same session', (await log('H.pane')).filter(l => /Connecting to/.test(l)).length === connects && await ev('return RD.desktop.isConnected(H.pane)'))
    } else {
        t.skip('live resize', `xrdp ${version} has no display control (0.10 and later)`)
    }

    // 6. Reconnecting uses the saved account: no form.
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    if (keychainWorks) {
        const t2 = Date.now()
        await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
        const again = await outcome('H.pane')
        t.time('reconnect with the saved account', Date.now() - t2)
        check('reopens with the saved account, no form', /Z $/.test(again ?? '') && !(await ev('return H.signin(H.pane)')), again)

        // 7. "Sign in again…": forgets the saved account and asks.
        const item = await ev(`return (await H.menu(H.pane)).some(i => i.label === 'Sign in again…')`)
        check('the menu offers "Sign in again…"', item)
        await ev(`const i = (await H.menu(H.pane)).find(i => i.label === 'Sign in again…'); H.inZone(() => i?.click())`)
        check('"Sign in again…": the form again', !!(await t.waitFor('return H.signin(H.pane)', 20)))
        check('"Sign in again…": the saved account is forgotten', !(await t.keychain(`getPassword('tabby-rdp', ${JSON.stringify(key)})`)))
        await t.escape()
        await sleep(300)
        await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    }

    // 8. Neither GNOME nor a running xrdp: the error says what to do.
    if (!wasRunning) {
        await t.remote('H.admin', 'sudo -n systemctl stop xrdp; true')
        await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
        const failed = await t.waitFor(`const s = H.status(H.pane); return s && /failed/.test(s.text) ? s.text : null`, 20)
        check('no GNOME, xrdp stopped: the error names both, and how to start xrdp', /gnome/i.test(failed ?? '') && /xrdp is installed but not running/.test(failed ?? '') && /systemctl enable --now xrdp/.test(failed ?? ''), failed)
        await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    }
})
