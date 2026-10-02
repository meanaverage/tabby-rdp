// `ssh` typed in an SSH tab, on a Linux desktop host (TRD_TEST_HOST) that can itself ssh non-interactively to another
// desktop account (TRD_TEST_NESTED: an ssh destination as the test host sees it, e.g. an alias for another user; see
// test/README.md). SSH tab to the host, its desktop, a split pane, `ssh` there, Desktop: that pane gets the other
// account's desktop, through the host; the first pane keeps its own. Reconnect stays with it after the ssh ends.
import { suite } from '../lib/harness.js'

const NESTED = process.env.TRD_TEST_NESTED

await suite('nested', async t => {
    const { ev, check, sleep } = t
    if (!NESTED) {
        t.skip('nested', 'set TRD_TEST_NESTED (see test/README.md)')
        return
    }
    const connected = (pane: string) => t.waitFor<boolean>(`return H.connected(${pane})`, 60, 100)
    await t.settings({ desk: false })

    // The host's own desktop in the first pane.
    check('SSH tab connected', await ev('H.a = await H.openSSH(); return !!H.a'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.a))')
    check('its desktop connected', !!(await connected('H.a')))
    const own = await ev('return H.session(H.a).remote.key')

    // Split; in the new pane's console, ssh on to the other account.
    await ev(`const top = H.topOf(H.a); H.c = await H.inZone(() => top.splitTab(H.a, 'r')); H.opened.push(H.c)`)
    check('split pane connected', !!(await t.waitFor('return H.c?.sshSession?.open ? true : null', 30)))
    // "Make panes even": drag the divider off the middle, then even them out from the menu.
    await ev('const top = H.topOf(H.a); top.root.ratios = [0.7, 0.3]; H.inZone(() => top.layout())')
    await sleep(500)
    await ev('const i = (await H.menu(H.c)).find(i => i.label === "Make panes even"); H.inZone(() => i.click())')
    const widths = await t.waitFor('const w = [H.a, H.c].map(p => Math.round(p.element.nativeElement.getBoundingClientRect().width)); return Math.abs(w[0] - w[1]) <= 2 ? w : null', 3)
    check('"Make panes even" evens out the split', !!widths, await ev('return [H.a, H.c].map(p => Math.round(p.element.nativeElement.getBoundingClientRect().width))'))
    await sleep(2000)
    await ev(`H.c.sendInput(${JSON.stringify(`ssh ${NESTED}\r`)})`)
    const prompt = await t.waitFor(`return /\\$ *$/.test(H.screen(H.c).trimEnd()) && H.screen(H.c).split('\\n').filter(l => /\\$/.test(l)).length >= 2 ? H.screen(H.c).trimEnd().split('\\n').pop() : null`, 20)
    check(`ssh ${NESTED} typed in the split pane`, !!prompt, await ev('return H.screen(H.c).slice(-400)'))
    t.onCleanup(() => ev('H.c?.sendInput?.("exit\\r")'))
    // Its GNOME session would be in the way of the xrdp suite, which signs in to the same account.
    t.onCleanup(() => t.remote('H.a', `ssh -o BatchMode=yes ${NESTED} 'systemctl --user stop tabby-headless-shell.service gnome-remote-desktop-headless.service' 2>/dev/null; true`))

    // Desktop there: the other account's, through the host.
    const t0 = Date.now()
    await ev('await H.inZone(() => RD.desktop.toggle(H.c))')
    check('the split pane has a desktop of its own', !!(await connected('H.c')), await ev('return RD.desktop.logOf(H.c).slice(-6)'))
    t.time('Desktop → connected (through the host)', Date.now() - t0)
    const remote = await ev<{ key: string, label: string }>('const r = H.session(H.c).remote; return { key: r.key, label: r.label }')
    check(`its remote is the one ssh went to (${NESTED})`, remote.label === NESTED && remote.key !== own, { remote, own })
    check('the first pane keeps its own desktop', await ev('return RD.desktop.isConnected(H.a) && H.session(H.a).remote.key') === own)
    const picture = await t.waitFor('const c = H.canvas(H.c); return c && c.colors > 3 ? c : null', 20)
    check('the other desktop shows a picture', !!picture, picture)
    check('no note about the pane next to it', await ev('return !H.c.element.nativeElement.querySelector(".trd-note")'))
    const label = (pane: string) => `const o = H.overlay(${pane}).querySelector('.trd-osd.trd-shown'); return o ? o.querySelector('.trd-osd-name').textContent + ' | ' + o.querySelector('.trd-osd-sub').textContent : null`
    const host = await ev<string>('return H.session(H.a).remote.label')
    const shown = await ev<string | null>(label('H.c'))
    check('the on-screen display names it, the host it goes through, and its resolution', new RegExp(`^${NESTED} \\| via ${host.replace(/\./g, '\\.')} · \\d+×\\d+$`).test(shown ?? ''), shown)
    check('... for a moment', !!(await t.waitFor(`return !H.overlay(H.c).querySelector('.trd-osd.trd-shown')`, 5)))
    await ev('H.inZone(() => H.topOf(H.a).focus(H.a))')
    check('focusing the other pane of the split names that one\'s desktop', (await t.waitFor<string>(label('H.a'), 3) ?? '').startsWith(`${host} | `), await ev(label('H.a')))
    await t.dump('H.c', 'nested')

    // Both desktops at once: typing into all of them, and pasting to all of them. A window on each (full screen, a
    // text field with the focus) writes what it holds to a file, one per account.
    const KEYLOG = String.raw`
import gi, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
w = Gtk.Window(title='trd keylog'); e = Gtk.Entry(); w.add(e); w.fullscreen()
def save(*_):
    open(sys.argv[1], 'w').write(e.get_text())
e.connect('changed', save); w.connect('destroy', Gtk.main_quit); w.show_all(); w.present(); e.grab_focus(); Gtk.main()
`
    const launch = (file: string) => `W=$(systemctl --user show-environment | sed -n 's/^WAYLAND_DISPLAY=//p'); rm -f ${file}; WAYLAND_DISPLAY=\${W:-wayland-0} GDK_BACKEND=wayland setsid python3 /tmp/trd-keylog.py ${file} >/dev/null 2>&1 < /dev/null & sleep 2; echo started`
    await t.remote('H.a', 'cat > /tmp/trd-keylog.py; chmod 644 /tmp/trd-keylog.py', KEYLOG)
    await t.remote('H.a', launch('/tmp/trd-keylog-a.txt'))
    await t.remote('H.a', `ssh -o BatchMode=yes ${NESTED} ${JSON.stringify(launch('/tmp/trd-keylog-c.txt'))}`)
    t.onCleanup(() => t.remote('H.a', `pkill -u "$(id -u)" -f '^python3 /tmp/trd-keylog'; ssh -o BatchMode=yes ${NESTED} "pkill -u \\$(id -u) -f '^python3 /tmp/trd-keylog'"; rm -f /tmp/trd-keylog.py /tmp/trd-keylog-a.txt /tmp/trd-keylog-c.txt; true`))
    await sleep(2500)
    const items = await ev<string[]>('return (await H.menu(H.a)).map(i => i.label).filter(Boolean)')
    check('the menu offers pasting to and typing into both desktops of the tab', items.includes('Paste to all 2 desktops in this tab') && items.includes('Type into all 2 desktops in this tab'), items)
    await ev('H.inZone(() => RD.desktop.setBroadcast(H.a, true))')
    check('typing into all: both desktops say so', await ev('return [H.a, H.c].every(p => H.overlay(p).classList.contains("trd-broadcast-on"))'))
    await t.clickDesktop('H.a')
    await sleep(300)
    await t.type('both42')
    const logs = () => t.remote('H.a', 'cat /tmp/trd-keylog-a.txt; printf "|"; cat /tmp/trd-keylog-c.txt')
    let typed = ''
    for (let i = 0; i < 20 && typed !== 'both42|both42'; i++) {
        await sleep(250)
        typed = (await logs()).trim()
    }
    check('typing into all: typed on one desktop, both got it', typed === 'both42|both42', typed)
    await ev('H.inZone(() => RD.desktop.setBroadcast(H.a, false))')
    check('turned off: the badges go', await ev('return [H.a, H.c].every(p => !H.overlay(p).classList.contains("trd-broadcast-on"))'))
    await t.type('x')
    await sleep(800)
    check('turned off: only the focused desktop gets keys', (await logs()).trim() === 'both42x|both42', (await logs()).trim())
    await t.clipboard('pasted7')
    await sleep(1500)  // each desktop's clipboard follows this computer's
    await ev('H.inZone(() => RD.desktop.pasteToAll(H.a))')
    let pasted = ''
    for (let i = 0; i < 20 && pasted !== 'both42xpasted7|both42pasted7'; i++) {
        await sleep(250)
        pasted = (await logs()).trim()
    }
    check('paste to all: the clipboard pasted on both desktops', pasted === 'both42xpasted7|both42pasted7', pasted)
    // The paste shortcut while typing into all: what's copied here goes to both (only the focused one follows the
    // clipboard on its own).
    await ev('H.inZone(() => RD.desktop.setBroadcast(H.a, true))')
    await t.clipboard('keyed9')
    await sleep(500)
    await t.press('v', [t.platform === 'darwin' ? 'Meta' : 'Control'])
    for (let i = 0; i < 20 && pasted !== 'both42xpasted7keyed9|both42pasted7keyed9'; i++) {
        await sleep(250)
        pasted = (await logs()).trim()
    }
    check('typing into all: the paste shortcut pastes the clipboard on both desktops', pasted === 'both42xpasted7keyed9|both42pasted7keyed9', pasted)
    await ev('H.inZone(() => RD.desktop.setBroadcast(H.a, false))')

    // The other pane, whose console runs no ssh, still means the host: the ssh next door is not its (regression: it
    // was taken for this pane's, and Desktop there offered the other account's desktop, open next door).
    await ev('H.inZone(() => RD.desktop.disconnect(H.a))')
    await ev('await H.inZone(() => RD.desktop.toggle(H.a))')
    check('Desktop in the pane without ssh: the host\'s own desktop again', !!(await connected('H.a')) && await ev('return H.session(H.a).remote.key') === own,
        await ev('return { remote: H.session(H.a)?.remote?.key, note: H.a.element.nativeElement.querySelector(".trd-note")?.innerText, log: RD.desktop.logOf(H.a).slice(-4) }'))
    check('... and no probe shows in either terminal', !/7777|probe/.test(await ev<string>('return H.screen(H.a) + H.screen(H.c)')))

    // After the ssh ends, Reconnect goes back to the same desktop, not the host's.
    await ev('H.inZone(() => RD.desktop.showConsole(H.c))')
    await ev('H.c.sendInput("exit\\r")')
    await sleep(1500)
    const spec = await ev('return H.session(H.c).spec.id')
    await ev(`await H.inZone(() => RD.desktop.reopen(H.c, H.session(H.c).spec))`)
    check('reconnected', !!(await connected('H.c')))
    check('Reconnect stays with that desktop after the ssh ended', await ev('return H.session(H.c).remote.label') === NESTED && await ev('return H.session(H.c).spec.id') === spec)
    await ev('H.inZone(() => RD.desktop.disconnect(H.c))')

    // Without the ssh, Desktop in that pane is the host's again: open next door, so a note says so.
    await ev('await H.inZone(() => RD.desktop.toggle(H.c))')
    check('without ssh: the host\'s desktop, already open next door, is explained', !!(await t.waitFor('return H.c.element.nativeElement.querySelector(".trd-note")?.innerText || null', 8)))
})
