// A GNOME desktop that's open somewhere else already, on a Linux desktop host (TRD_TEST_HOST) with GNOME. Two SSH tabs
// to the same account stand for two computers: one by the test host's address, one by "localhost" through the same
// port, which the plugin takes for two hosts.
// - opening it in the second asks: take it over, open a second screen, or cancel;
// - taking it over disconnects the first (one client left), in the same session, and the first doesn't take it back by itself: it says
//   the desktop was opened elsewhere, and offers to take it back or to open a second screen;
// - a second screen: both connected (two clients);
// - cancel: not connected, the choices stay on the layer.
import { suite } from '../lib/harness.mjs'

await suite('takeover', async t => {
    const { ev, check, sleep } = t
    const clients = async () => Number((await t.remote('H.a', 'ss -tnH state established "( sport = :$(grdctl --headless status 2>/dev/null | awk \'/Port:/ { print $2; exit }\') )" | grep -c .')).trim())
    const status = pane => ev(`return H.status(${pane})`)
    const waitStatus = async (pane, re, seconds = 40) => {
        for (let i = 0; i < seconds * 2; i++) {
            const s = await status(pane)
            if (s && re.test(s.text)) return s
            await sleep(500)
        }
        return await status(pane)
    }

    check('first SSH tab connected', await ev('H.a = await H.openSSH(); return !!H.a'))
    if (!/yes/.test(await t.remote('H.a', 'command -v grdctl >/dev/null && command -v gnome-shell >/dev/null && echo yes'))) {
        t.skip('takeover', 'no GNOME on the test host')
        return
    }
    check('second SSH tab (as "localhost") connected', await ev(`H.b = await H.openSSH({ host: 'localhost' }); return !!H.b`))
    check('... which the plugin takes for another host', await ev('return (await RD.targets.targetOf(H.a)).key !== (await RD.targets.targetOf(H.b)).key'))

    // 1. The first opens it.
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.a))')
    check('first desktop connected', !!(await t.waitFor('return H.connected(H.a)', 60)))
    await sleep(2000)
    check('one client', await clients() === 1)

    // 2. The second is asked.
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.b))')
    const asked = await waitStatus('H.b', /open somewhere else too/)
    check('the second asks: take it over, a second screen, or cancel', asked?.buttons.join() === 'Take it over,Open a second screen,Cancel', asked)

    // 3. It takes it over: the first gives way, and stays off. The session (its shell, and so its apps) goes on.
    const shell = async () => (await t.remote('H.a', 'pgrep -u "$(id -u)" -x gnome-shell | head -n 1')).trim()
    const shellBefore = await shell()
    await ev(`H.inZone(() => H.clickStatus(H.b, 'Take it over'))`)
    check('the second connected', !!(await t.waitFor('return H.connected(H.b)', 60)))
    const gave = await waitStatus('H.a', /was opened somewhere else/)
    check('the first says it was opened elsewhere, and offers to take it back or open a second screen', gave?.buttons.join() === 'Take it back,Open a second screen', gave)
    await sleep(12000)
    check('... and doesn\'t reconnect by itself', !(await ev('return H.connected(H.a)')) && /was opened somewhere else/.test((await status('H.a'))?.text ?? ''), await status('H.a'))
    check('one client (the second)', await clients() === 1)
    check('the same GNOME session (its apps stay open)', !!shellBefore && await shell() === shellBefore, [shellBefore, await shell()])
    check('the second is still connected', await ev('return H.connected(H.b) && RD.desktop.sessions.get(H.b)?.state !== "ended"'))

    // 4. The first chooses a second screen: both connected.
    await ev(`H.inZone(() => H.clickStatus(H.a, 'Open a second screen'))`)
    check('the first connected again, with a screen of its own', !!(await t.waitFor('return H.connected(H.a)', 60)), await ev('return RD.desktop.logOf(H.a).slice(-4)'))
    await sleep(2000)
    check('two clients', await clients() === 2)
    check('the second is still connected', await ev('return H.connected(H.b) && RD.desktop.sessions.get(H.b)?.state !== "ended"'))

    // 5. Cancel.
    await ev('H.inZone(() => RD.desktop.disconnect(H.b))')
    await sleep(1500)
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.b))')
    await waitStatus('H.b', /open somewhere else too/)
    await ev(`H.inZone(() => H.clickStatus(H.b, 'Cancel'))`)
    const cancelled = await waitStatus('H.b', /Not opened/, 5)
    check('cancel: not connected, the choices stay', /Not opened/.test(cancelled?.text ?? '') && cancelled?.buttons.join() === 'Take it over,Open a second screen' && !(await ev('return H.connected(H.b)')), cancelled)
    check('the first is still connected', await ev('return H.connected(H.a) && RD.desktop.sessions.get(H.a)?.state !== "ended"'))
})
