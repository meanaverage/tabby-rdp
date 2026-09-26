// Sound, on a Linux desktop host (TRD_TEST_HOST): a tone played on the desktop (pw-play) arrives as PCM and is
// scheduled for playback; with the sound setting off, no audio is set up.
import { suite } from '../lib/harness.mjs'

// A one-second 440 Hz tone, played in the desktop's audio session.
const TONE = `python3 -c "
import math, struct, wave
w = wave.open('/tmp/trd-tone.wav', 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
w.writeframes(b''.join(struct.pack('<hh', v, v) for v in (int(12000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(48000))))
w.close()" && XDG_RUNTIME_DIR=/run/user/$(id -u) pw-play /tmp/trd-tone.wav; rm -f /tmp/trd-tone.wav`

await suite('audio', async t => {
    const { ev, check, sleep } = t
    const audio = () => ev('const a = H.session(H.pane)?.audio; return a ? { received: a.received, peak: a.peak } : null')
    const connected = () => t.waitFor('return H.connected(H.pane)', 40, 100)
    await t.settings({ desk: true, sound: true })

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected (sound on)', !!(await connected()))
    await sleep(1500)
    const before = await audio()
    check('audio playback set up', !!before, before)
    await t.remote('H.pane', TONE)
    await sleep(1000)
    const after = await audio()
    const seconds = (after?.received ?? 0) - (before?.received ?? 0)
    check(`the tone arrived (${seconds.toFixed(2)} s of audio)`, seconds > 0.8, { before, after })
    check('and it is sound, not silence', (after?.peak ?? 0) > 0.2, after)

    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    await t.settings({ sound: false })
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected (sound off)', !!(await connected()))
    check('sound off: no audio set up', (await audio()) === null)
})
