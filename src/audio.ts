/**
 * Plays a remote desktop's audio (IronRDP's `audioPlayback` extension): blocks of 16-bit PCM, queued
 * back to back on a Web Audio clock. A little lead absorbs network jitter; if playback falls too far
 * behind (a stall, a busy tab), it skips ahead rather than letting the delay grow.
 */
export class AudioPlayer {
    private context: AudioContext | null = null
    private gain: GainNode | null = null
    /** Web Audio time at which the next block starts. */
    private next = 0
    /** Seconds of audio received and scheduled (for tests and troubleshooting). */
    received = 0
    /** Loudest sample seen, 0..1 (for tests: tells sound from silence). */
    peak = 0

    private static readonly LEAD = 0.08
    private static readonly MAX_AHEAD = 0.5

    /** The callback for IronRDP's audioPlayback extension. */
    readonly callback = (message: any): void => {
        try {
            if (message?.type === 'wave') {
                this.play(message.sampleRate, message.channels, message.data)
            } else if (message?.type === 'volume') {
                this.volume((Number(message.left) + Number(message.right)) / 2)
            } else if (message?.type === 'close') {
                this.next = 0
            }
        } catch (e) {
            console.warn('remote desktop audio:', e)
        }
    }

    private play (sampleRate: number, channels: number, data: Uint8Array): void {
        const frames = Math.floor(data.byteLength / 2 / channels)
        if (!frames || !channels) {
            return
        }
        this.context ??= new AudioContext({ latencyHint: 'interactive' })
        if (!this.gain) {
            this.gain = this.context.createGain()
            this.gain.connect(this.context.destination)
        }
        if (this.context.state === 'suspended') {
            this.context.resume().catch(() => null)
        }
        const buffer = this.context.createBuffer(channels, frames, sampleRate)
        const samples = new DataView(data.buffer, data.byteOffset, data.byteLength)
        for (let ch = 0; ch < channels; ch++) {
            const out = buffer.getChannelData(ch)
            for (let i = 0; i < frames; i++) {
                const v = samples.getInt16((i * channels + ch) * 2, true) / 32768
                out[i] = v
                if (v > this.peak || -v > this.peak) {
                    this.peak = Math.abs(v)
                }
            }
        }
        const now = this.context.currentTime
        if (this.next < now || this.next > now + AudioPlayer.MAX_AHEAD) {
            this.next = now + AudioPlayer.LEAD
        }
        const source = this.context.createBufferSource()
        source.buffer = buffer
        source.connect(this.gain)
        source.start(this.next)
        this.next += buffer.duration
        this.received += buffer.duration
    }

    private volume (level: number): void {
        if (this.gain && Number.isFinite(level)) {
            this.gain.gain.value = Math.max(0, Math.min(1, level))
        }
    }

    close (): void {
        this.context?.close().catch(() => null)
        this.context = null
        this.gain = null
    }
}
