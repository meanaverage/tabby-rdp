// Reconnecting, on a Linux desktop host (TRD_TEST_HOST). A dropped SSH connection (what sleep or a network change
// does) is simulated by destroying the tab's SSH session.
// - The desktop notices, says so and offers "Reconnect SSH"; once SSH is back it reconnects by itself.
// - A hidden desktop reconnects in the background and stays hidden.
// - "Stop" stops; a desktop that never connected offers "Try again" and doesn't retry by itself.
import { suite } from '../lib/harness.mjs'

await suite('reconnect', async t => {
    const { ev, check, sleep } = t
    await t.settings({ desk: true })
    // A reconnect is a new session (with its own log): identify one by its first log line, once connected.
    const sessionId = () => ev('const log = RD.desktop.logOf(H.pane); return H.connected(H.pane) ? log[0] : null')
    const dropSSH = () => ev('await H.inZone(() => H.pane.sshSession.destroy())')

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane) && H.status(H.pane) === null', 40)))

    // 1. SSH drops while the desktop shows.
    const first = await sessionId()
    await dropSSH()
    const lost = await t.waitFor(`const s = H.status(H.pane); return s && /Connection lost/.test(s.text) && /Waiting for the SSH connection/.test(s.text) ? s : null`, 15)
    check('SSH drop: "Connection lost", waiting for SSH, with "Reconnect SSH" and "Stop"', lost?.buttons.includes('Reconnect SSH') && lost.buttons.includes('Stop'), lost ?? await ev('return [H.status(H.pane), RD.desktop.logOf(H.pane).slice(-3)]'))
    check('the last picture is dimmed', await ev(`return H.overlay(H.pane).classList.contains('trd-dim')`))
    const t0 = Date.now()
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Reconnect SSH'))`)
    const back = await t.waitFor(`const log = RD.desktop.logOf(H.pane); return H.connected(H.pane) && log[0] !== ${JSON.stringify(first)} && H.status(H.pane) === null`, 45)
    t.time('"Reconnect SSH" → desktop back', Date.now() - t0)
    check('after "Reconnect SSH", the desktop reconnects by itself, shown', !!back && await ev('return RD.desktop.isVisible(H.pane)'), await ev('return [H.status(H.pane), RD.desktop.logOf(H.pane).slice(-3)]'))

    // 2. The same while the desktop is hidden: it comes back in the background.
    await ev('H.inZone(() => RD.desktop.showConsole(H.pane))')
    const second = await sessionId()
    await dropSSH()
    await sleep(1500)
    await ev('await H.inZone(() => H.pane.reconnect())')
    const back2 = await t.waitFor(`const id = RD.desktop.logOf(H.pane)[0]; return H.connected(H.pane) && id !== ${JSON.stringify(second)}`, 45)
    check('hidden desktop: reconnects in the background once SSH is back, and stays hidden', !!back2 && !(await ev('return RD.desktop.isVisible(H.pane)')) && await ev('return RD.desktop.has(H.pane)'))

    // 3. Stop: no more attempts.
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    await dropSSH()
    await t.waitFor(`return H.status(H.pane)?.buttons.includes('Stop')`, 15)
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Stop'))`)
    const stopped = await ev('return H.status(H.pane)')
    await ev('await H.inZone(() => H.pane.reconnect())')
    await t.waitFor('return H.pane.sshSession?.open', 30)
    await sleep(4000)
    check('"Stop": stays stopped (Reconnect offered, no new connection)', stopped?.buttons.join() === 'Reconnect' && (await ev('return H.status(H.pane)'))?.buttons.join() === 'Reconnect', { stopped, now: await ev('return H.status(H.pane)') })
    await ev(`H.inZone(() => H.clickStatus(H.pane, 'Reconnect'))`)
    check('"Reconnect" connects again', !!(await t.waitFor('return H.connected(H.pane) && H.status(H.pane) === null', 40)))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 4. A desktop that never connects: "Try again", no automatic retries. (Port 9 on the host: nothing there.) Its
    // account comes from the keychain, so the sign-in form doesn't come first.
    if (!(await t.keychainWorks())) {
        t.skip('never connected: "Remote desktop failed" with "Try again"', 'the system keychain does not answer (Linux: no unlocked keyring)')
        return
    }
    const desktops = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${desktops}; H.config.save() })`))
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = [{ name: 'Nothing here', via: H.test.host, host: '127.0.0.1', port: 9, kind: 'windows', username: 'x' }]; H.config.save() })`)
    const key = await ev(`return (await RD.targets.targetOf(H.pane)).key + '#127.0.0.1:9'`)
    await t.keychain(`setPassword('tabby-rdp', ${JSON.stringify(key)}, JSON.stringify({ username: 'x', password: 'y' }))`)
    t.onCleanup(() => t.keychain(`deletePassword('tabby-rdp', ${JSON.stringify(key)})`))
    await ev(`await H.inZone(() => RD.desktop.showDesktop(H.pane, '127.0.0.1:9'))`)
    const failed = await t.waitFor(`const s = H.status(H.pane); return s && /failed/i.test(s.text) ? s : null`, 20)
    await sleep(3000)
    check('never connected: "Remote desktop failed" with "Try again", no automatic retry',
        failed?.buttons.join() === 'Try again' && (await ev(`return RD.desktop.logOf(H.pane).filter(l => /Connecting to/.test(l)).length`)) === 1, failed)
})
