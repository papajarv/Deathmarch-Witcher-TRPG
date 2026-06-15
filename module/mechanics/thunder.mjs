/**
 * Procedural thunder for the canvas weather renderer. Generates a short rumble
 * with the Web Audio API so the system ships no sound assets. One shared
 * AudioContext is created lazily on first use (after a user gesture, which
 * Foundry always has by the time the canvas is live) and reused for every clap.
 */

export class Thunder {
    constructor() {
        this._ctx = null;
        this._noiseBuffer = null;
    }

    _context() {
        if (this._ctx) return this._ctx;
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        try { this._ctx = new Ctor(); } catch (_e) { this._ctx = null; }
        return this._ctx;
    }

    /** A reusable ~2s buffer of white noise, generated once. */
    _noise(ctx) {
        if (this._noiseBuffer) return this._noiseBuffer;
        const len = Math.floor(ctx.sampleRate * 2.0);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        this._noiseBuffer = buf;
        return buf;
    }

    /**
     * Play one thunderclap.
     * @param {number} volume  0..1 master gain for this clap.
     */
    boom(volume = 0.6) {
        const ctx = this._context();
        if (!ctx) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});

        const now = ctx.currentTime;
        const v = Math.max(0, Math.min(1, volume));

        // Two crackle/rumble layers with slightly different timing for body.
        const layers = [
            { delay: 0.0,  dur: 1.8, lp: 380, peak: 0.9 * v, attack: 0.012 },
            { delay: 0.06, dur: 2.4, lp: 190, peak: 0.7 * v, attack: 0.05 }
        ];

        for (const L of layers) {
            const src = ctx.createBufferSource();
            src.buffer = this._noise(ctx);
            src.loop = true;

            const lp = ctx.createBiquadFilter();
            lp.type = "lowpass";
            lp.frequency.setValueAtTime(L.lp * 2.0, now + L.delay);
            lp.frequency.exponentialRampToValueAtTime(L.lp, now + L.delay + 0.5);

            const lows = ctx.createBiquadFilter();
            lows.type = "lowshelf";
            lows.frequency.value = 120;
            lows.gain.value = 9;

            const gain = ctx.createGain();
            const t0 = now + L.delay;
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, L.peak), t0 + L.attack);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, L.peak * 0.35), t0 + L.dur * 0.4);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + L.dur);

            src.connect(lp);
            lp.connect(lows);
            lows.connect(gain);
            gain.connect(ctx.destination);

            src.start(t0);
            src.stop(t0 + L.dur + 0.05);
        }
    }
}
