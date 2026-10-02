// Resizing, on a Linux desktop host (TRD_TEST_HOST): with "resize to fit" the remote resolution follows the pane
// in place (display control, answered with an EGFX ResetGraphics); "reconnect" reconnects at the new size; "keep"
// keeps it, scaled; "retina" uses device pixels, with GNOME's scale set to match.
import { suite, type CanvasInfo } from '../lib/harness.js'

await suite('resize', async t => {
    const { ev, check, sleep } = t
    // DevTools can't resize an Electron window, so resize the pane itself (what the plugin observes).
    const setPane = (width: number, height: number) => ev(`const el = H.pane?.element.nativeElement; if (el) { el.style.flex = 'none'; el.style.width = '${width}px'; el.style.height = '${height}px' }`)
    const connected = () => t.waitFor<string>(`const l = RD.desktop.logOf(H.pane).at(-1) ?? ''; return /Z $/.test(l) || /failed|ended/.test(l) ? l : null`, 40, 100)
    // Waits for the remote display to stop changing.
    const settle = async (): Promise<CanvasInfo> => {
        let last = ''
        for (let i = 0; i < 30; i++) {
            await sleep(300)
            const now = JSON.stringify(await ev('const c = H.canvas(H.pane); return c && { w: c.w, h: c.h, cssW: c.cssW, cssH: c.cssH, paneW: c.paneW, paneH: c.paneH }'))
            if (now === last) return JSON.parse(now)
            last = now
        }
        return JSON.parse(last)
    }
    const fits = (s: CanvasInfo | null) => !!s && Math.abs(s.w - s.paneW) <= 2 && Math.abs(s.h - s.paneH) <= 2
    const firstLog = () => ev('return RD.desktop.logOf(H.pane)[0]')
    const dpr = await ev<number>('return window.devicePixelRatio')

    await t.settings({ resize: 'live', sharpness: 'standard', desk: true })
    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await setPane(700, 480)
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', /Z $/.test(await connected() ?? ''))
    const a = await settle()
    check('initial resolution = pane size (CSS pixels)', fits(a), a)

    // Resize to fit.
    const session = await firstLog()
    const t0 = Date.now()
    await setPane(790, 550)
    const b = await settle()
    t.time('live resize settled (includes the 300 ms debounce and polling)', Date.now() - t0)
    check('live: the resolution follows a bigger pane', b.w > a.w && fits(b), { before: a, after: b })
    check('live: same RDP session (no reconnect)', await firstLog() === session)
    check('live: displayed 1:1 (no scaling blur)', Math.abs(b.cssW - b.w) <= 2, b)
    check('live: the remote frame is drawn at the new size', (await ev<number>('return H.canvas(H.pane)?.colors ?? 0')) > 10)
    await setPane(660, 490)
    const small = await settle()
    check('live: and follows a smaller pane', small.w < b.w && fits(small), small)

    // Keep the resolution.
    await t.settings({ resize: 'off' })
    await setPane(740, 520)
    const off = await settle()
    check('off: resolution kept, scaled to fit', off.w === small.w && off.h === small.h, { small, off })

    // Reconnect at the new size.
    await t.settings({ resize: 'reconnect' })
    const r0 = Date.now()
    await sleep(1500)
    await connected()
    const rc = await settle()
    t.time('reconnect at the new size settled', Date.now() - r0)
    check('reconnect: a new session at the pane size', await firstLog() !== session && fits(rc), rc)

    // Retina.
    await t.settings({ resize: 'live', sharpness: 'retina' })
    const rt = await settle()
    check(`retina: device pixels (devicePixelRatio ${dpr})`, Math.abs(rt.w - rt.paneW * dpr) <= 4 && Math.abs(rt.cssW - rt.paneW) <= 2, rt)
    const requested = await ev<string | undefined>('return RD.desktop.logOf(H.pane).filter(l => /resize:/.test(l)).at(-1)')
    check('retina: the remote scale is requested', dpr <= 1 || (!!requested && new RegExp(`@${Math.round(dpr * 100)}%`).test(requested)), requested)
    const applied = await t.waitFor<string>('return RD.desktop.logOf(H.pane).filter(l => /^scale:/.test(l)).at(-1) ?? null', 6)
    check('retina: GNOME runs the desktop at that scale (same visual size)', dpr <= 1 || /scaled|already set/.test(applied ?? ''), applied)
    // Mutter's own view, once it settles (the mode and the scale change in steps).
    let logical = ''
    for (let i = 0; i < 20 && !(dpr <= 1 || logical.includes(dpr.toFixed(1))); i++) {
        if (i) await sleep(250)
        logical = await t.remote('H.pane', `gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig --method org.gnome.Mutter.DisplayConfig.GetCurrentState | grep -o '\\[(0, 0, [0-9.]*'`)
    }
    check('retina: logical monitor scale in Mutter', dpr <= 1 || logical.includes(dpr.toFixed(1)), { logical, applied, monitors: await t.remote('H.pane', "gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig --method org.gnome.Mutter.DisplayConfig.GetCurrentState | tr -s ' ' | cut -c1-400") })

    // A desktop's own sharpness: Standard for this one while the default is Retina, then "As above" again.
    const sharpness = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktopSharpness ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktopSharpness = ${sharpness}; H.config.save() })`))
    const offered = await ev<string[]>(`const s = (await H.menu(H.pane)).find(i => i.label === 'Settings')?.submenu ?? []
        return s.filter(i => i.type === 'radio').map(i => i.label + (i.checked ? '*' : ''))`)
    check('the settings offer a sharpness for this desktop ("As above" chosen)', offered.includes('As above*') && offered.filter(l => l.startsWith('Retina')).length === 2, offered)
    await ev('H.inZone(() => RD.desktop.setOwnSharpness(H.pane, "standard"))')
    const own = await settle()
    check('own sharpness: Standard for this desktop, while the default is Retina', Math.abs(own.w - own.paneW) <= 4, own)
    let unscaled = ''
    for (let i = 0; i < 20 && !(dpr <= 1 || unscaled.includes('1.0')); i++) {
        if (i) await sleep(250)
        unscaled = await t.remote('H.pane', `gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig --method org.gnome.Mutter.DisplayConfig.GetCurrentState | grep -o '\\[(0, 0, [0-9.]*'`)
    }
    check('own sharpness: GNOME back at 100%', dpr <= 1 || unscaled.includes('1.0'), unscaled)
    check('own sharpness: kept in the config for this desktop', await ev(`const key = (await RD.targets.targetOf(H.pane)).key
        return (H.config.store.remoteDesktop.desktopSharpness ?? []).some(e => e.desktop === key && e.sharpness === 'standard')`))
    await ev('H.inZone(() => RD.desktop.setOwnSharpness(H.pane, null))')
    const back = await settle()
    check('"As above": the default again (Retina)', dpr <= 1 || Math.abs(back.w - back.paneW * dpr) <= 4, back)
})
