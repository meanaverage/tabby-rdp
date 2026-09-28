// Graphics, on a Linux desktop host (TRD_TEST_HOST): with the H.264 setting on (and a Tabby whose WebCodecs decodes
// H.264), the connection advertises H.264 and, when GNOME Remote Desktop sends it (only with a hardware encoder:
// VA-API or NVENC), frames decode; either way, a full-screen window flipping between two known colors comes out in
// those colors. With the setting off, no decoder is set up and the picture is still right. Windows: the windows suite.
import { suite } from '../lib/harness.mjs'
import { GNOME_FLIP, sampleFlip } from '../lib/graphics.mjs'

const FLIP_SECONDS = 15

await suite('graphics', async t => {
    const { ev, check } = t
    const connected = () => t.waitFor('return H.connected(H.pane)', 40, 100)
    const stats = () => ev('const d = H.session(H.pane)?.h264; return d ? { ...d.stats, failed: d.failed } : null')
    /**
     * Starts the flipping window; returns null, or why it didn't start (it needs python3 with GTK 3). pkill and pgrep
     * match the start of the command line: the shell running this has the script's name in its own.
     */
    const flip = async () => {
        await t.remote('H.pane', 'cat > /tmp/trd-flip.py', GNOME_FLIP)
        const out = await t.remote('H.pane', `pkill -u "$(id -u)" -f '^python3 /tmp/trd-flip[.]py'; W=$(systemctl --user show-environment | sed -n 's/^WAYLAND_DISPLAY=//p'); WAYLAND_DISPLAY=\${W:-wayland-0} GDK_BACKEND=wayland setsid python3 /tmp/trd-flip.py ${FLIP_SECONDS} >/tmp/trd-flip.log 2>&1 < /dev/null & sleep 2.5; pgrep -u "$(id -u)" -f '^python3 /tmp/trd-flip[.]py' >/dev/null && echo running || tail -3 /tmp/trd-flip.log`)
        return /running/.test(out) ? null : out.trim() || 'no output'
    }
    t.onCleanup(() => t.remote('H.pane', `pkill -u "$(id -u)" -f '^python3 /tmp/trd-flip[.]py'; rm -f /tmp/trd-flip.py /tmp/trd-flip.log; true`))
    await t.settings({ h264: true, sharpness: 'standard', resize: 'live' })

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected (H.264 on)', !!(await connected()))
    const graphics = await ev('return RD.desktop.logOf(H.pane).findLast(l => /^graphics: /.test(l)) ?? null')
    const decodes = await ev('return !!H.session(H.pane)?.h264')
    if (decodes) {
        check('H.264 advertised (graphics pipeline with H.264)', /with H\.264/.test(graphics ?? ''), graphics)
    } else {
        t.skip('H.264', `this Tabby's WebCodecs does not decode H.264 (${graphics})`)
    }

    const flipError = await flip()
    if (flipError) {
        t.skip('the picture checks', `the test window didn't start (python3 with GTK 3 on the test host?): ${flipError}`)
        return
    }
    const before = await stats()
    const picture = await sampleFlip(t, 'H.pane')
    await t.dump('H.pane', 'graphics-h264')
    check('the picture has the window\'s colors (both of them, nothing else)', picture.ok, picture)
    if (decodes) {
        const after = await stats()
        const frames = (after?.frames ?? 0) - (before?.frames ?? 0)
        check('no decoder failure', !after?.failed, after)
        if (frames > 0) {
            check(`H.264 frames decoded (${frames} while sampling; last ${after.lastLatencyMs.toFixed(1)} ms, slowest ${after.maxLatencyMs.toFixed(1)} ms from arrival to pixels)`, true)
            t.time('H.264 frame, arrival to pixels (last)', Math.round(after.lastLatencyMs))
        } else {
            t.skip('H.264 frames decoded', 'GNOME Remote Desktop sent none: it encodes H.264 only with a hardware encoder (VA-API or NVENC); the picture above came through RemoteFX')
        }
    }

    // The setting off: the graphics pipeline without H.264, as before.
    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    await t.settings({ h264: false })
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected (H.264 off)', !!(await connected()))
    check('H.264 off: no decoder set up', await ev('return H.session(H.pane)?.h264 === null'))
    check('H.264 off: the test window started', !(await flip()))
    const plain = await sampleFlip(t, 'H.pane')
    check('H.264 off: the picture has the window\'s colors', plain.ok, plain)
})
