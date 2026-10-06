// Two real GNOME desktops, with one reconnecting or failing while the other keeps its connection and input.
// The failure is a tiny synthetic WASM `unreachable`, inserted into a benign size getter by test instrumentation;
// it exercises the export watcher and normal recovery without malformed protocol input or an unpublished fix.
import { suite } from '../lib/harness.js'

const SECOND_USER = process.env.TRD_TEST_ISOLATION_USER

await suite('wasm-isolation', async t => {
    const { ev, check } = t
    if (!SECOND_USER) {
        t.skip('two desktops', 'set TRD_TEST_ISOLATION_USER to a second GNOME account on the test host')
        return
    }
    await t.settings({ desk: false })
    // Observe the real loader and instances without retaining their backends. Restore both hooks on every exit.
    await ev(`
        const bytes = new Uint8Array([
            0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,3,2,0,0, 5,3,1,0,1,
            7,25,3,6,109,101,109,111,114,121,2,0,4,116,114,97,112,0,0,5,118,97,108,117,101,0,1,
            10,10,2,3,0,0,11,4,0,65,7,11
        ])
        const synthetic = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.trap
        H.iso = { instantiate: WebAssembly.instantiate, create: RD.desktop.ironrdp.create,
            records: [], controls: new WeakMap(), injected: 0 }
        WebAssembly.instantiate = async function (...args) {
            const result = await H.iso.instantiate.apply(this, args)
            if (!(result instanceof WebAssembly.Instance) || !result.exports.__wbg_get_desktopsize_width) return result
            const control = { armed: false }
            const exports = { ...result.exports }
            const width = exports.__wbg_get_desktopsize_width
            exports.__wbg_get_desktopsize_width = (...values) => {
                if (control.armed) { control.armed = false; H.iso.injected++; return synthetic() }
                return width(...values)
            }
            H.iso.controls.set(exports.memory, control)
            // An Instance proxy preserves instanceof and the initializer's real instance path.
            return new Proxy(result, { get: (target, key) => key === 'exports' ? exports : Reflect.get(target, key, target) })
        }
        RD.desktop.ironrdp.create = async function (...args) {
            const backend = await H.iso.create.apply(this, args)
            H.iso.records.push({ backend: new WeakRef(backend), memory: new WeakRef(backend.runtime.memory),
                control: H.iso.controls.get(backend.runtime.memory) })
            return backend
        }
        H.iso.record = pane => {
            const module = H.overlay(pane)?.querySelector('iron-remote-desktop')?.module
            return H.iso.records.find(r => r.backend.deref()?.Backend === module)
        }
    `)
    t.onCleanup(() => ev(`
        if (H.iso) {
            WebAssembly.instantiate = H.iso.instantiate
            RD.desktop.ironrdp.create = H.iso.create
            delete H.iso
        }
    `))
    const connected = (pane: string) => t.waitFor<boolean>(`return H.connected(${pane}) && !H.status(${pane})`, 60, 100)
    check('first SSH account connected', await ev('H.a = await H.openSSH(); return !!H.a'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.a))')
    check('first desktop connected', !!await connected('H.a'))
    check('second SSH account connected', await ev(`H.b = await H.openSSH({ user: ${JSON.stringify(SECOND_USER)} }); return !!H.b`))
    t.onCleanup(() => t.remote('H.b', 'systemctl --user stop tabby-headless-shell gnome-remote-desktop-headless; true'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.b))')
    check('second desktop connected', !!await connected('H.b'))
    check('both desktops decoded a picture', !!await t.waitFor(`return [H.a,H.b].every(p => H.canvas(p)?.colors > 3)`, 20))
    check('connected desktops own different memory and backend classes', await ev(`
        H.iso.a = H.iso.record(H.a); H.iso.b = H.iso.record(H.b)
        return H.iso.a && H.iso.b && H.iso.a !== H.iso.b &&
            H.iso.a.memory.deref() !== H.iso.b.memory.deref() &&
            H.iso.a.backend.deref().Backend.DesktopSize !== H.iso.b.backend.deref().Backend.DesktopSize
    `))
    console.log('NOTE  connected backend memory (MiB):', await ev(`
        return [H.iso.a,H.iso.b].map(r => r.memory.deref().buffer.byteLength / 1024 / 1024)
    `))
    await ev('H.iso.bSession = H.session(H.b); H.iso.bProxy = H.iso.bSession.proxy; H.iso.bUI = H.iso.bSession.ui')
    const healthy = () => ev<boolean>(`return H.connected(H.b) && !H.status(H.b) &&
        H.session(H.b) === H.iso.bSession && H.session(H.b).proxy === H.iso.bProxy &&
        H.session(H.b).ui === H.iso.bUI && !H.iso.b.backend.deref().runtime.trapped`)

    // Explicit disconnect releases the component/resources; opening again creates fresh memory.
    await ev('H.iso.oldA = H.session(H.a); H.inZone(() => RD.desktop.disconnect(H.a))')
    check('closing one desktop releases its component and connection resources', await ev(`
        const s = H.iso.oldA
        return !s.ui && !s.audio && !s.mic && !s.files && !s.drives && !s.h264 && !s.host.querySelector('iron-remote-desktop')
    `))
    check('the other desktop keeps its connection when its neighbor closes', await healthy())
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.a))')
    check('closed desktop opens again', !!await connected('H.a'))
    check('reopening uses a fresh backend and memory', await ev(`
        const next = H.iso.record(H.a)
        const fresh = next && next !== H.iso.a && next.memory.deref() !== H.iso.a.memory.deref()
        H.iso.a = next; return fresh
    `))

    // Repeated, controlled faults go through the production watcher and bounded automatic reconnect path.
    for (let cycle = 1; cycle <= 3; cycle++) {
        const started = Date.now()
        check(`fault ${cycle}: the size getter raises a WASM trap`, await ev(`
            H.iso.before = H.iso.record(H.a); H.iso.failedSession = H.session(H.a)
            const backend = H.iso.before.backend.deref()
            const size = new backend.Backend.DesktopSize(640, 480)
            H.iso.before.control.armed = true
            try { void size.width; return false } catch (e) { return e instanceof WebAssembly.RuntimeError }
            finally { size.free() }
        `))
        check(`fault ${cycle}: only the failed pane reconnects`, !!await t.waitFor(`
            return H.connected(H.a) && !H.status(H.a) && H.iso.record(H.a) !== H.iso.before
        `, 60, 100))
        t.time(`fault ${cycle} → connected`, Date.now() - started)
        check(`fault ${cycle}: failed resources are released and memory is replaced`, await ev(`
            const s = H.iso.failedSession, next = H.iso.record(H.a)
            return !s.ui && !s.files && !s.drives && !s.mic && !s.audio && !s.h264 && !s.host.querySelector('iron-remote-desktop') &&
                next && next.memory.deref() !== H.iso.before.memory.deref() && !next.backend.deref().runtime.trapped
        `))
        check(`fault ${cycle}: the other desktop never reconnects`, await healthy())
    }

    // Actual keyboard events still reach the healthy remote after its neighbor's faults.
    await ev('H.inZone(() => RD.app.selectTab(H.topOf(H.b)))')
    const keylog = `import gi\ngi.require_version('Gtk','3.0')\nfrom gi.repository import Gtk\nw=Gtk.Window(title='trd isolation input'); e=Gtk.Entry(); w.add(e); w.fullscreen()\ndef save(*_):\n open('/tmp/trd-isolation-input','w').write(e.get_text())\ne.connect('changed',save); w.connect('destroy',Gtk.main_quit); w.show_all(); w.present(); e.grab_focus(); Gtk.main()\n`
    await t.remote('H.b', 'cat > /tmp/trd-isolation-keylog.py', keylog)
    t.onCleanup(() => t.remote('H.b', `pkill -u "$(id -u)" -f '^python3 /tmp/trd-isolation-keylog'; rm -f /tmp/trd-isolation-keylog.py /tmp/trd-isolation-input; true`))
    await t.remote('H.b', `W=$(systemctl --user show-environment | sed -n 's/^WAYLAND_DISPLAY=//p'); rm -f /tmp/trd-isolation-input; WAYLAND_DISPLAY=\${W:-wayland-0} GDK_BACKEND=wayland setsid python3 /tmp/trd-isolation-keylog.py >/dev/null 2>&1 < /dev/null & sleep 2; echo started`)
    await t.clickDesktop('H.b')
    await t.type('healthy42')
    let text = ''
    for (let i = 0; i < 20 && text !== 'healthy42'; i++) {
        await t.sleep(250)
        text = (await t.remote('H.b', 'cat /tmp/trd-isolation-input 2>/dev/null')).trim()
    }
    check('the healthy desktop still accepts keyboard input', text === 'healthy42', text)
    check('exactly three synthetic faults were injected', await ev('return H.iso.injected') === 3)
    await t.remote('H.b', `pkill -u "$(id -u)" -f '^python3 /tmp/trd-isolation-keylog'; rm -f /tmp/trd-isolation-keylog.py /tmp/trd-isolation-input; true`)
    await ev(`
        H.inZone(() => { RD.desktop.disconnect(H.a); RD.desktop.disconnect(H.b) })
        delete H.iso.bUI; delete H.iso.bProxy; delete H.iso.bSession
        delete H.iso.failedSession; delete H.iso.oldA
    `)
    // Forced GC checks that ended instances can be released; it does not promise a collection schedule in use.
    let retained = -1
    for (let i = 0; i < 12 && retained !== 0; i++) {
        await t.sleep(250)
        await t.c.send('HeapProfiler.collectGarbage', {})
        retained = await ev<number>('return H.iso.records.filter(r => r.memory.deref()).length')
    }
    check('ended and faulted connections retain no WASM memories after GC', retained === 0, { retained })
})
