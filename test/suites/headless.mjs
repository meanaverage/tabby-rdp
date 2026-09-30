// The headless GNOME session as a desktop, on a Linux desktop host (TRD_TEST_HOST) with GNOME:
// - GNOME's settings daemons for a desktop session run (keyboard, media keys, XSettings, …), and none that would act on
//   the machine itself (power, which would suspend it; sharing, which manages GNOME Remote Desktop);
// - X11 apps start: DISPLAY is in the session's environment, and an X11 app launched as a desktop launcher would be
//   shows a window (through XWayland, started on demand);
// - GNOME Settings opens a window when launched the way the dock does, also the first time in a session;
// - all of it goes away with the shell, and comes back with a new one.
// Windows are listed with GNOME Shell's Introspect interface, which only answers a few callers: the helper takes the
// name of one of them, the GTK portal, which it stops for that moment (D-Bus starts it again when it's needed).
import { suite } from '../lib/harness.mjs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const WINDOWS_PY = String.raw`
import sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
name = 'org.freedesktop.impl.portal.desktop.gtk'
r = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
                  GLib.Variant('(su)', (name, 4)), GLib.VariantType('(u)'), 0, -1, None).unpack()[0]
if r not in (1, 4):
    sys.exit('could not own ' + name)
wins = bus.call_sync('org.gnome.Shell', '/org/gnome/Shell/Introspect', 'org.gnome.Shell.Introspect', 'GetWindows',
                     None, None, 0, -1, None).unpack()[0]
for p in wins.values():
    print('|'.join([p.get('app-id', ''), p.get('wm-class', ''), p.get('title', ''), 'x11' if p.get('client-type') == 1 else 'wayland', 'hidden' if p.get('is-hidden') else 'shown']))
`

await suite('headless', async t => {
    const { ev, check, sleep } = t
    const sh = command => t.remote('H.pane', command)

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    const gnome = await sh('command -v grdctl >/dev/null && command -v gnome-shell >/dev/null && echo yes')
    if (!/yes/.test(gnome)) {
        t.skip('headless', 'no GNOME on the test host')
        return
    }
    await sh(`printf %s ${Buffer.from(WINDOWS_PY).toString('base64')} | base64 -d > /tmp/trd-windows.py`)
    t.onCleanup(() => sh('rm -f /tmp/trd-windows.py; pkill -x xeyes; pkill -x gnome-control-c'))
    const windows = async () => (await sh('systemctl --user stop xdg-desktop-portal-gtk.service 2>/dev/null; python3 /tmp/trd-windows.py 2>&1'))
        .split('\n').filter(Boolean).map(l => { const [app, cls, title, type, state] = l.split('|'); return { app, cls, title, type, state } })
    const waitWindow = async (match, seconds) => {
        for (let i = 0; i < seconds * 2; i++) {
            const w = (await windows()).find(match)
            if (w?.state === 'shown') return w
            await sleep(500)
        }
        const all = await windows()
        return all.find(match) ?? { missing: true, windows: all }
    }

    // A fresh shell, so this is the session's first launch of everything.
    await sh('systemctl --user stop tabby-headless-shell; pkill -x gnome-control-c; pkill -x xeyes; true')
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected', !!(await t.waitFor('return H.connected(H.pane)', 60)))
    await sleep(3000)

    // 1. The settings daemons.
    const daemons = (await sh('pgrep -u "$(id -u)" -l "^gsd-" | awk \'{ print $2 }\' | sort -u')).split('\n').filter(Boolean)
    for (const d of ['gsd-xsettings', 'gsd-keyboard', 'gsd-media-keys', 'gsd-a11y-settin', 'gsd-sound', 'gsd-housekeepin']) {
        check(`settings daemon ${d} runs`, daemons.includes(d), daemons)
    }
    check('no gsd-power (it would suspend the machine) or gsd-sharing (it manages GNOME Remote Desktop)', !daemons.includes('gsd-power') && !daemons.includes('gsd-sharing'), daemons)

    // 2. X11 apps.
    const environment = await sh('systemctl --user show-environment')
    check('DISPLAY in the session\'s environment', /^DISPLAY=:\d+$/m.test(environment), environment.split('\n').filter(l => /DISPLAY|XAUTH/.test(l)))
    await sh('systemd-run --user --collect --quiet xeyes')
    const xeyes = await waitWindow(w => w.cls === 'xeyes' || w.title === 'xeyes', 15)
    check('an X11 app (xeyes) shows a window', xeyes?.state === 'shown' && xeyes?.type === 'x11', xeyes)

    // 3. GNOME Settings, launched as the dock launches it.
    await sh('gapplication launch org.gnome.Settings')
    const settings = await waitWindow(w => w.app === 'org.gnome.Settings.desktop', 20)
    check('GNOME Settings shows a window', settings?.state === 'shown', settings)
    await t.dump('H.pane', 'headless-apps')

    // 4. When the shell stops, so does the rest; the next connection brings all of it back. (Disconnected first, or the
    // desktop would reconnect, starting a new shell, as soon as this one goes.)
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    await sleep(1000)
    await sh('systemctl --user stop tabby-headless-shell')
    await sleep(2000)
    const left = await sh(`pgrep -u "$(id -u)" -l "^gsd-"; systemctl --user show-environment | grep -E '^(DISPLAY|XAUTHORITY)='; ls "$XDG_RUNTIME_DIR/systemd/user" 2>/dev/null; true`)
    check('shell stopped: no settings daemons, DISPLAY or stand-in units left', left.trim() === '', left)
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected again (a new shell)', !!(await t.waitFor('return H.connected(H.pane)', 60)))
    await sleep(3000)
    const again = await sh('pgrep -u "$(id -u)" -l "^gsd-" | wc -l; systemctl --user show-environment | grep -c "^DISPLAY="')
    check('the new shell has its settings daemons and DISPLAY', /^\s*[5-9]\s*\n\s*1\s*$/.test(again), again)
    await sh('pkill -x xeyes; systemd-run --user --collect --quiet xeyes')
    const xeyes2 = await waitWindow(w => w.cls === 'xeyes' || w.title === 'xeyes', 15)
    check('X11 apps work in the new shell too', xeyes2?.state === 'shown', xeyes2)
})
