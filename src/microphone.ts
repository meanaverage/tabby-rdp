/**
 * Redirects the local microphone to a remote desktop (IronRDP's `audioInput` extension). The server asks for it when it
 * likes (by its own account, while an application there records): IronRDP says `open` (with the format the server
 * chose) and `close`, and the microphone is captured only in between. The browser's capture runs at the audio device's
 * rate; it is resampled and converted to interleaved 16-bit PCM here, in blocks of about 20 ms.
 *
 * It keeps capturing while the desktop layer is hidden: the remote application is still recording (a call, say), and
 * the console being in front doesn't mean the user stopped talking to it. What the remote does with it is out of
 * sight then, so it shows elsewhere (see RemoteDesktopService.microphoneChanged): a red microphone in Tabby's header
 * for as long as it lasts, and a note when a capture starts on a desktop that isn't showing. turnOff() stops it here,
 * and turnOn() takes the remote's requests again.
 */
export class Microphone {
    /** The format the server asked for, while it has the microphone open. */
    format: { sampleRate: number, channels: number } | null = null
    /** Whether the microphone is being captured right now. */
    capturing = false
    /** Seconds of audio sent (for tests and troubleshooting). */
    sent = 0
    /** Loudest sample sent, 0..1 (for tests: tells sound from silence). */
    peak = 0

    private stream: MediaStream | null = null
    private context: AudioContext | null = null
    private nodes: AudioNode[] = []
    /** Bumped by stop(), so that a capture still starting when the remote closes is dropped. */
    private generation = 0
    private starting = false
    private resampler: Resampler | null = null
    private reportedError = false
    /** Turned off here (see turnOff): the remote's requests are refused for the rest of the connection. */
    private off = false

    /**
     * `send`: pushes PCM to IronRDP. `changed`: capturing started or stopped (for the indicator). `error`: the
     * microphone couldn't be opened (reported once per connection).
     */
    constructor (
        private readonly send: (pcm: Int16Array) => void,
        private readonly changed: () => void,
        private readonly log: (message: string) => void,
        private readonly error: (message: string) => void,
    ) { }

    /** The callback for IronRDP's audioInput extension. */
    readonly callback = (message: any): void => {
        try {
            if (message?.type === 'open') {
                const sampleRate = Number(message.sampleRate)
                const channels = Number(message.channels)
                if (!(sampleRate > 0) || !(channels === 1 || channels === 2)) {
                    this.log(`microphone: unsupported format ${sampleRate} Hz × ${channels}`)
                    return
                }
                this.format = { sampleRate, channels }
                this.log(`microphone: the remote opened it (${sampleRate} Hz, ${channels === 1 ? 'mono' : 'stereo'})`)
                if (this.off) {
                    this.log('microphone: not sent: turned off here')
                    return
                }
                this.start().catch(e => this.failed(e))
            } else if (message?.type === 'close') {
                this.log('microphone: the remote closed it')
                this.format = null
                this.stop()
            }
        } catch (e) {
            console.warn('remote desktop microphone:', e)
        }
    }

    private async start (): Promise<void> {
        this.resampler = null  // the format may have changed; the next block starts a new one
        if (this.stream || this.starting) {
            return
        }
        this.starting = true
        try {
            await this.open(this.generation)
        } finally {
            this.starting = false
        }
        // Closed and opened again while starting: that start was dropped, so start over (unless turned off meanwhile).
        if (!this.stream && this.format && !this.off) {
            await this.start()
        }
    }

    private async open (generation: number): Promise<void> {
        const stream = await navigator.mediaDevices.getUserMedia({
            // Echo cancellation keeps the remote's own sound, played here, out of what goes back to it.
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
        })
        if (generation !== this.generation) {
            stream.getTracks().forEach(track => track.stop())
            return
        }
        this.stream = stream
        const context = new AudioContext({ latencyHint: 'interactive' })
        this.context = context
        const source = context.createMediaStreamSource(stream)
        // Nothing is played: the capture node only needs to be pulled, which a connection to the output ensures.
        const mute = context.createGain()
        mute.gain.value = 0
        mute.connect(context.destination)
        let capture: AudioNode
        try {
            await context.audioWorklet.addModule(workletURL())
            if (generation !== this.generation) {
                return  // closed meanwhile: stop() released the stream and closed the context, which takes no new nodes
            }
            const node = new AudioWorkletNode(context, 'trd-microphone', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
            node.port.onmessage = event => {
                // A block the worklet posted before the capture stopped can still arrive after it: dropped, not sent.
                if (generation === this.generation) {
                    this.captured(event.data, context.sampleRate)
                }
            }
            capture = node
        } catch (e: any) {
            if (generation !== this.generation) {
                return  // closed meanwhile, which may be why the module was refused: as above, and not an error
            }
            // No AudioWorklet (or its module was refused): the deprecated ScriptProcessor does the same on the main thread.
            this.log(`microphone: AudioWorklet unavailable (${e?.message ?? e}), using ScriptProcessor`)
            const node = context.createScriptProcessor(1024, 2, 1)
            node.onaudioprocess = event => {
                if (generation !== this.generation) {
                    return  // stopped: as above
                }
                const input = event.inputBuffer
                this.captured(Array.from({ length: input.numberOfChannels }, (_, i) => input.getChannelData(i).slice()), context.sampleRate)
            }
            capture = node
        }
        source.connect(capture)
        capture.connect(mute)
        this.nodes = [source, capture, mute]
        if (context.state === 'suspended') {
            await context.resume().catch(() => null)
            if (generation !== this.generation) {
                return  // closed or turned off while resuming: stop() released everything, and it isn't capturing
            }
        }
        const track = stream.getAudioTracks()[0]
        this.log(`microphone: capturing from ${track?.label || 'the default input'} at ${context.sampleRate} Hz`)
        track?.addEventListener('ended', () => {
            this.log('microphone: the input device went away')
            this.stop()
        })
        this.capturing = true
        this.changed()
    }

    /** A block of captured audio (per channel, at the device's rate): resample, convert, send. */
    private captured (channels: Float32Array[], inputRate: number): void {
        const format = this.format
        if (!format || !channels.length || !channels[0].length) {
            return
        }
        if (!this.resampler || this.resampler.inputRate !== inputRate) {
            this.resampler = new Resampler(inputRate, format.sampleRate, format.channels)
        }
        const pcm = this.resampler.process(channels)
        if (!pcm.length) {
            return
        }
        for (let i = 0; i < pcm.length; i++) {
            const v = Math.abs(pcm[i]) / 32768
            if (v > this.peak) {
                this.peak = v
            }
        }
        try {
            this.send(pcm)
            this.sent += pcm.length / format.channels / format.sampleRate
        } catch (e: any) {
            this.log(`microphone: sending failed: ${e?.message ?? e}`)
        }
    }

    private failed (e: any): void {
        const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        const message = denied
            ? process.platform === 'darwin'
                ? 'Tabby isn\'t allowed to use the microphone. Allow it in System Settings › Privacy & Security › Microphone, then restart Tabby.'
                : 'Access to the microphone was denied.'
            : `The microphone couldn't be opened: ${e?.message ?? e}`
        this.log(`microphone: ${e?.name ?? 'error'}: ${e?.message ?? e}`)
        this.stop()
        if (!this.reportedError) {
            this.reportedError = true
            this.error(message)
        }
    }

    /** Stops capturing and releases the device (the remote may open it again later). */
    stop (): void {
        this.generation++
        this.resampler = null
        this.nodes.forEach(node => node.disconnect())
        this.nodes = []
        this.stream?.getTracks().forEach(track => track.stop())
        this.stream = null
        this.context?.close().catch(() => null)
        this.context = null
        if (this.capturing) {
            this.capturing = false
            this.changed()
        }
    }

    /**
     * Turned off here (the setting, or Stop for this desktop): stops capturing at once, also a capture still starting,
     * and refuses the remote's later requests on this connection. Whether the next connection gets the microphone is
     * the service's to say (see RemoteDesktopService.stopMicrophone).
     */
    turnOff (): void {
        if (!this.off) {
            this.off = true
            this.log('microphone: turned off here')
        }
        this.stop()
    }

    /** Turned on again here (the desktop's menu): the remote's requests are taken again, one open now included. */
    turnOn (): void {
        if (!this.off) {
            return
        }
        this.off = false
        this.log('microphone: turned on again here')
        if (this.format) {
            this.start().catch(e => this.failed(e))
        }
    }

    /** The connection ended. */
    close (): void {
        this.format = null
        this.stop()
    }
}

/**
 * Linear-interpolation resampler to interleaved 16-bit PCM, carrying its position across blocks so that blocks
 * join without clicks. Channels are mixed down (mono) or duplicated (a mono microphone, stereo requested).
 */
export class Resampler {
    private readonly step: number
    /** Position of the next output frame, in input frames from the start of the next block (-1: the last frame of the previous one). */
    private position = 0
    private last: number[]

    constructor (readonly inputRate: number, readonly outputRate: number, readonly channels: number) {
        this.step = inputRate / outputRate
        this.last = new Array(channels).fill(0)
    }

    process (input: Float32Array[]): Int16Array {
        const frames = input[0].length
        // The requested channels from what the device gave.
        const mixed: Float32Array[] = []
        if (this.channels === 1 && input.length > 1) {
            const mono = new Float32Array(frames)
            for (const channel of input) {
                for (let i = 0; i < frames; i++) {
                    mono[i] += channel[i] / input.length
                }
            }
            mixed.push(mono)
        } else {
            for (let c = 0; c < this.channels; c++) {
                mixed.push(input[c] ?? input[0])
            }
        }
        const count = Math.max(0, Math.ceil((frames - 1 - this.position) / this.step))
        const out = new Int16Array(count * this.channels)
        let t = this.position
        for (let n = 0; n < count; n++, t += this.step) {
            const i = Math.floor(t)
            const frac = t - i
            for (let c = 0; c < this.channels; c++) {
                const samples = mixed[c]
                const a = i < 0 ? this.last[c] : samples[i]
                const b = samples[i + 1]
                const v = Math.max(-1, Math.min(1, a + (b - a) * frac))
                out[n * this.channels + c] = Math.round(v * 32767)
            }
        }
        this.position = t - frames
        for (let c = 0; c < this.channels; c++) {
            this.last[c] = mixed[c][frames - 1]
        }
        return out
    }
}

/**
 * The capture processor: collects the render quanta (128 frames) into blocks of about 20 ms and posts copies to
 * the main thread, which does the rest.
 */
const WORKLET = `
class TrdMicrophone extends AudioWorkletProcessor {
    constructor () {
        super()
        this.blocks = []
        this.frames = 0
    }
    process (inputs) {
        const input = inputs[0]
        if (input && input.length && input[0].length) {
            this.blocks.push(input.map(channel => channel.slice()))
            this.frames += input[0].length
            if (this.frames >= sampleRate / 50) {
                const channels = Math.max(...this.blocks.map(b => b.length))
                const out = []
                for (let c = 0; c < channels; c++) {
                    const merged = new Float32Array(this.frames)
                    let offset = 0
                    for (const block of this.blocks) {
                        merged.set(block[c] ?? block[0], offset)
                        offset += block[0].length
                    }
                    out.push(merged)
                }
                this.port.postMessage(out, out.map(a => a.buffer))
                this.blocks = []
                this.frames = 0
            }
        }
        return true
    }
}
registerProcessor('trd-microphone', TrdMicrophone)
`

let workletBlobURL: string | null = null
function workletURL (): string {
    workletBlobURL ??= URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    return workletBlobURL
}
