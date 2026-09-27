// Microphone, on a Linux desktop host (TRD_TEST_HOST): with the microphone setting on, recording from GNOME Remote
// Desktop's audio source on the remote opens the microphone here, and a tone fed in as the local microphone (a fake
// getUserMedia) arrives there as sound; when the recording stops, the microphone is released. With the setting off,
// none is set up.
import { suite } from '../lib/harness.mjs'

const SECONDS = 8

// Records from GNOME Remote Desktop's microphone source (grd_remote_audio_source, 44.1 kHz stereo) for SECONDS, and
// prints the length and the loudest sample of the last 3 s (0..1).
const RECORD = `
import array, os, shutil, signal, subprocess, sys, time
env = dict(os.environ, XDG_RUNTIME_DIR='/run/user/%d' % os.getuid())
path = '/tmp/trd-mic-test.raw'
if shutil.which('pw-record'):
    cmd, header = ['pw-record', '--target', 'grd_remote_audio_source', '--rate', '44100', '--channels', '2', '--format', 's16', path + '.wav'], 44
    path += '.wav'
elif shutil.which('parec'):
    cmd, header = ['parec', '-d', 'grd_remote_audio_source', '--rate=44100', '--channels=2', '--format=s16le', '--raw', path], 0
else:
    print('RD_ERR neither pw-record nor parec is installed'); sys.exit(0)
recorder = subprocess.Popen(cmd, env=env, stderr=subprocess.PIPE)
time.sleep(${SECONDS})
recorder.send_signal(signal.SIGINT)
try:
    recorder.wait(5)
except subprocess.TimeoutExpired:
    recorder.kill()
try:
    with open(path, 'rb') as f:
        data = f.read()[header:]
    os.remove(path)
except OSError as e:
    print('RD_ERR %s %s' % (e, recorder.stderr.read().decode(errors='replace')[-300:])); sys.exit(0)
samples = array.array('h')
samples.frombytes(data[:len(data) // 2 * 2])
tail = samples[-44100 * 2 * 3:]
print('RD_OK seconds=%.2f peak=%.3f' % (len(samples) / 88200, max((abs(v) for v in tail), default=0) / 32768))
`

await suite('microphone', async t => {
    const { ev, check, sleep } = t
    const mic = () => ev(`const m = H.session(H.pane)?.mic; return m ? { capturing: m.capturing, format: m.format, sent: m.sent, peak: m.peak,
        indicator: !!H.session(H.pane)?.overlay.classList.contains('trd-mic-on') } : null`)
    const connected = () => t.waitFor('return H.connected(H.pane)', 40, 100)

    // A 440 Hz tone at half scale stands in for the local microphone.
    await ev(`
        const devices = navigator.mediaDevices
        H.realGetUserMedia = devices.getUserMedia
        H.fakeMic = { requests: 0, tracks: [] }
        devices.getUserMedia = async constraints => {
            if (!constraints?.audio) return H.realGetUserMedia.call(devices, constraints)
            H.fakeMic.requests++
            H.fakeMic.context ??= new AudioContext()
            const context = H.fakeMic.context
            await context.resume()
            const tone = context.createOscillator()
            tone.frequency.value = 440
            const gain = context.createGain()
            gain.gain.value = 0.5
            const out = context.createMediaStreamDestination()
            tone.connect(gain).connect(out)
            tone.start()
            H.fakeMic.tracks.push(...out.stream.getAudioTracks())
            return out.stream
        }`)
    t.onCleanup(() => ev('navigator.mediaDevices.getUserMedia = H.realGetUserMedia; H.fakeMic?.context?.close()'))
    await t.settings({ desk: true, microphone: true })

    check('SSH tab connected', await ev('H.pane = await H.openSSH(); return !!H.pane'))
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected (microphone on)', !!(await connected()))
    await sleep(1500)
    const idle = await mic()
    check('microphone set up, not capturing until the remote records', idle?.capturing === false && idle?.sent === 0, idle)
    check('microphone not requested yet', (await ev('return H.fakeMic.requests')) === 0)

    const recording = t.remote('H.pane', 'python3 -', RECORD)
    const during = await t.waitFor('const m = H.session(H.pane)?.mic; return m?.capturing && m.sent > 1 ? { format: m.format, sent: m.sent } : null', SECONDS - 1, 250)
    check('the remote opened the microphone while recording', !!during, await mic())
    check('in 44.1 kHz stereo (GNOME Remote Desktop\'s format)', during?.format?.sampleRate === 44100 && during?.format?.channels === 2, during)
    const shown = await mic()
    check('the layer shows the microphone indicator', shown?.indicator === true, shown)
    const out = await recording
    const result = /^RD_OK seconds=([\d.]+) peak=([\d.]+)/m.exec(out)
    check('the remote recorded audio', !!result && Number(result[1]) > SECONDS - 3, out.trim().slice(-300))
    check(`and it is the tone, not silence (peak ${result?.[2]})`, !!result && Number(result[2]) > 0.2, out.trim().slice(-300))

    const released = await t.waitFor('const m = H.session(H.pane)?.mic; return m && !m.capturing && H.fakeMic.tracks.every(track => track.readyState === "ended")', 15, 250)
    check('recording stopped: the microphone is released and the indicator hidden', !!released && (await mic())?.indicator === false, await mic())

    await ev('H.inZone(() => RD.desktop.disconnect(H.pane))')
    await t.settings({ microphone: false })
    await ev('await H.inZone(() => RD.desktop.showDesktop(H.pane))')
    check('desktop connected (microphone off)', !!(await connected()))
    check('microphone off: none set up', (await mic()) === null)
})
