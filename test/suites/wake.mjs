// Starting a desktop behind a host before connecting (`wake`), on a Linux desktop host (TRD_TEST_HOST). No VM needed:
// a stand-in "machine" on the test host waits for its Wake-on-LAN packet (on a high UDP port, over the loopback),
// "boots" for a few seconds, then forwards a port to the host's own GNOME Remote Desktop, so the plugin goes through
// the probe, the magic packet, the wait, and the sign-in. The libvirt path is checked for its error message (no such
// VM); starting a real VM is left to a live check (see the README).
import { suite } from '../lib/harness.mjs'

const MAC = '52:54:00:74:72:64'
const WOL_PORT = 47009
const FWD_PORT = 47389
const LOST_PORT = 47392  // where nothing ever answers
const FILE = '/tmp/trd-wake-test-$(id -u)'

// The stand-in: checks the magic packet, notes it, waits, then forwards FWD_PORT to grd; stops after 15 minutes.
const MACHINE = String.raw`
import os, socket, sys, threading, time
mac, wol_port, fwd_port, grd_port, log = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
threading.Timer(900, lambda: os._exit(0)).start()
expected = b'\xff' * 6 + bytes.fromhex(mac.replace(':', '')) * 16
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
u.bind(('127.0.0.1', wol_port))
while True:
    data, _ = u.recvfrom(2048)
    open(log, 'a').write('woke\n' if data == expected else 'bad packet\n')
    if data == expected:
        break
time.sleep(6)
l = socket.socket()
l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
l.bind(('127.0.0.1', fwd_port))
l.listen(16)
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    for s in (a, b):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
while True:
    c, _ = l.accept()
    try:
        s = socket.create_connection(('127.0.0.1', grd_port))
    except OSError:
        c.close()
        continue
    threading.Thread(target=pipe, args=(c, s), daemon=True).start()
    threading.Thread(target=pipe, args=(s, c), daemon=True).start()
`

await suite('wake', async t => {
    const { ev, check, sleep } = t
    const host = t.env.host
    await t.settings({ desk: true })
    const saved = await ev('return JSON.stringify(H.config.store.remoteDesktop.desktops ?? [])')
    t.onCleanup(() => ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = ${saved}; H.config.save() })`))
    await ev(`Object.assign(H, {
        signin () { return H.overlay(H.pane)?.querySelector('.trd-signin form') ?? null },
        form () { return H.pane.element.nativeElement.querySelector('.trd-form-overlay form') },
        async target () { return await RD.targets.targetOf(H.pane) },
        async spec (name) { return RD.desktop.desktopsOf(await H.target()).find(s => s.name === name) },
        log () { return RD.desktop.logOf(H.pane) },
    })`)

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    // The stand-in forwards to grd, which needs the headless GNOME session. GNOME Shell 46 sometimes crashes when
    // the last client's monitor goes away; connecting again (the setup) starts a new one.
    for (let i = 0; i < 3; i++) {
        check(i ? 'own desktop connected again (GNOME Shell had crashed)' : 'own desktop connected (account created)', !!(await t.waitFor('return H.connected(H.pane)', 40)))
        await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
        await sleep(3000)
        if ((await t.remote('H.pane', 'systemctl --user is-active tabby-headless-shell')).trim() === 'active') {
            break
        }
        await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    }
    const password = (await t.remote('H.pane', 'cat ~/.local/share/tabby-rdp/rdp-password')).trim()
    const grdPort = Number((await t.remote('H.pane', 'grdctl --headless status 2>/dev/null | sed -n "s/.*Port: *//p" | head -n 1')).trim()) || 3389

    const machine = {
        start: () => t.remote('H.pane', `rm -f ${FILE}.log; setsid nohup python3 ${FILE}.py ${MAC} ${WOL_PORT} ${FWD_PORT} ${grdPort} ${FILE}.log </dev/null >/dev/null 2>&1 & echo started`),
        // The bracket keeps pkill from matching the shell that runs it.
        stop: () => t.remote('H.pane', `pkill -f 'trd-wake-tes[t]' ; sleep 0.3; echo stopped`),
        log: async () => (await t.remote('H.pane', `cat ${FILE}.log 2>/dev/null`)).trim(),
    }
    await t.remote('H.pane', `cat > ${FILE}.py`, MACHINE)
    t.onCleanup(async () => {
        await machine.stop()
        await t.remote('H.pane', `rm -f ${FILE}.py ${FILE}.log`)
    })
    await machine.stop()

    // 1. Config: `wake` is read and checked.
    await ev(`H.inZone(() => { H.config.store.remoteDesktop.desktops = [
        { name: 'Sleeper', via: ${JSON.stringify(host)}, host: '127.0.0.1', port: ${FWD_PORT}, kind: 'gnome', username: 'tabby', wake: { mac: '${MAC}', broadcast: '127.0.0.1', port: ${WOL_PORT} } },
        { name: 'No such VM', via: ${JSON.stringify(host)}, host: '127.0.0.1', port: ${LOST_PORT}, kind: 'windows', wake: { vm: 'trd-test-no-such-vm' } },
        { name: 'Lost', via: ${JSON.stringify(host)}, host: '127.0.0.1', port: ${LOST_PORT + 2}, kind: 'windows', wake: { mac: '${MAC}', broadcast: '127.0.0.1', port: ${WOL_PORT + 1} } },
        { name: 'Bad wake', via: ${JSON.stringify(host)}, host: '127.0.0.1', port: ${LOST_PORT + 1}, kind: 'windows', wake: { mac: 'not a mac' } },
    ]; H.config.save() })`)
    const specs = await ev(`return { sleeper: (await H.spec('Sleeper'))?.wake, vm: (await H.spec('No such VM'))?.wake, bad: (await H.spec('Bad wake'))?.wake ?? null }`)
    check('wake read from the config (Wake-on-LAN, VM; an unusable one ignored)', specs.sleeper?.mac === MAC && specs.sleeper.broadcast === '127.0.0.1' && specs.sleeper.port === WOL_PORT && specs.vm?.vm === 'trd-test-no-such-vm' && specs.bad === null, specs)

    // 2. Off: the probe finds nothing, the magic packet goes out, "Starting…" with the time, then it connects.
    await machine.start()
    const sleeper = await ev(`return (await H.spec('Sleeper')).id`)
    const t0 = Date.now()
    await ev(`H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(sleeper)}))`)
    const starting = await t.waitFor(`const s = H.status(H.pane); return s && /^Starting Sleeper…/.test(s.text) && s.buttons.includes('Cancel') ? s : null`, 20)
    check('"Starting Sleeper…" with a Cancel button', starting?.buttons?.includes('Cancel'), starting)
    check('the magic packet reached the machine', /woke/.test(await t.waitFor(`return await RD.execRemote(H.pane, 'cat ${FILE}.log 2>/dev/null')`, 10) ?? ''), await machine.log())
    const waiting = await t.waitFor(`const s = H.status(H.pane); return s && /Waiting for it to answer: \\d+ s/.test(s.text) ? s.text : null`, 10)
    check('progress while waiting', !!waiting, await ev('return H.status(H.pane)'))
    check('sign-in once it answers', !!(await t.waitFor('return !!H.signin()', 40)), await ev('return H.log().slice(-4)'))
    t.time('wake: open to sign-in form (the stand-in boots for 6 s)', Date.now() - t0)
    await ev(`const f = H.signin(); f.querySelector('[name=password]').value = ${JSON.stringify(password)}; f.querySelector('[name=remember]').checked = false; f.requestSubmit()`)
    check('connected', !!(await t.waitFor('return H.connected(H.pane)', 40)), await ev('return H.log().slice(-4)'))
    const log = await ev('return H.log().join("\\n")')
    check('the log says what was done', /wake: Wake-on-LAN sent to/.test(log) && /wake: answered after \d+ s/.test(log), log)

    // 3. A drop while it is down: automatic reconnects don't start it.
    await machine.stop()
    await machine.start()  // listening for a packet again
    const dropped = await t.waitFor(`const s = H.status(H.pane); return s && /doesn't answer; it may have been shut down|session ended/.test(s.text) ? s : null`, 30)
    if (/session ended/.test(dropped?.text ?? '')) {
        t.skip('automatic reconnect: says it is down, without starting it', 'the drop ended the session cleanly, so nothing reconnected by itself')
    } else {
        check('automatic reconnect: says it is down, without starting it', !!dropped, await ev('return { status: H.status(H.pane), log: H.log().slice(-12) }'))
    }
    await sleep(2000)
    check('no magic packet from automatic reconnects', (await machine.log()) === '', await machine.log())

    // 4. Reconnect by hand: started again, and connects.
    await ev('H.inZone(() => RD.desktop.reopen(H.pane, RD.desktop.desktopOf(H.pane)))')
    check('Reconnect starts it again', !!(await t.waitFor(`return /^Starting Sleeper…/.test(H.status(H.pane)?.text ?? '')`, 20)))
    check('sign-in after it answers again', !!(await t.waitFor('return !!H.signin()', 40)))
    await ev(`const f = H.signin(); f.querySelector('[name=password]').value = ${JSON.stringify(password)}; f.querySelector('[name=remember]').checked = false; f.requestSubmit()`)
    check('connected again', !!(await t.waitFor('return H.connected(H.pane)', 40)))

    // 5. Already up: no wake at all.
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    await ev(`H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(sleeper)}))`)
    check('up already: straight to sign-in', !!(await t.waitFor('return !!H.signin()', 20)))
    check('up already: nothing started', !(await ev('return H.log().some(l => /Starting|wake:/.test(l))')), await ev('return H.log()'))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 6. A VM that doesn't exist (or no virsh): the reason, and Try again.
    const vm = await ev(`return (await H.spec('No such VM')).id`)
    await ev(`H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(vm)}))`)
    const failed = await t.waitFor(`const s = H.status(H.pane); return s && /^Remote desktop failed/.test(s.text) ? s : null`, 30)
    check('no such VM: the reason, with Try again', /virsh|libvirt|trd-test-no-such-vm/.test(failed?.text ?? '') && failed.buttons.includes('Try again'), failed)
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 7. Cancel while waiting.
    const lost = await ev(`return (await H.spec('Lost')).id`)
    await ev(`H.inZone(() => RD.desktop.showDesktop(H.pane, ${JSON.stringify(lost)}))`)
    check('a desktop that never answers: waiting', !!(await t.waitFor(`return (H.status(H.pane)?.buttons ?? []).includes('Cancel')`, 20)))
    await ev(`H.clickStatus(H.pane, 'Cancel')`)
    await sleep(300)
    const stopped = await ev('return H.status(H.pane)')
    check('Cancel: stopped waiting, with Try again', /^Stopped waiting for Lost/.test(stopped?.text ?? '') && stopped.buttons.includes('Try again'), stopped)
    await sleep(3500)
    check('Cancel: stays stopped', /^Stopped waiting/.test((await ev('return H.status(H.pane)'))?.text ?? ''))
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')

    // 8. The add form: a MAC address in the last field is saved as Wake-on-LAN.
    ev(`H.inZone(() => RD.desktop.addDesktop(H.pane))`)
    check('the add form has the wake field', !!(await t.waitFor(`return !!H.form()?.querySelector('[name=wake]')`, 5)))
    await ev(`const f = H.form(); for (const [k, v] of Object.entries({ name: 'Form wake', address: '127.0.0.1:${grdPort}', kind: 'gnome', username: 'tabby', wake: 'aa:bb:cc:dd:ee:01' })) f.querySelector('[name=' + k + ']').value = v; f.requestSubmit()`)
    const added = await t.waitFor(`return (H.config.store.remoteDesktop.desktops ?? []).find(d => d.name === 'Form wake')`, 5)
    check('saved with wake: { mac }', added?.wake?.mac === 'aa:bb:cc:dd:ee:01' && !added.wake.vm, added)
    // It answers (grd itself), so it goes straight to sign-in; cancel that.
    check('opened: straight to sign-in', !!(await t.waitFor('return !!H.signin()', 20)))
    await ev(`H.signin().querySelector('[name=cancel]').click()`)
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
})
