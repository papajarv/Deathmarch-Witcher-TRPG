/**
 * Storm lightning — random full-canvas flashes while the active weather carries
 * the `lightning` tag (the "Lightning Storm" state). Plain rain/snow storms do
 * NOT flash; lightning is a separate additive layer you stack on top.
 *
 * Runs on EVERY client (players see the flashes too), driven purely off the
 * locally-computed active weather, so it needs no socket traffic — each client
 * strikes on its own random cadence, which reads fine for ambient lightning.
 *
 * The flash is a fixed overlay sized to the viewport but z-ordered BELOW
 * Foundry's #interface UI (the canvas `#board` is a sibling behind #interface),
 * so it lights the scene and the tokens on it WITHOUT whitewashing sheets, the
 * sidebar, or this system's own windows. A `screen` blend means it brightens
 * rather than paints flat white.
 */

import { getActiveWeather } from "./manual-weather.mjs";
import { Thunder } from "./thunder.mjs";
import { sceneWeatherMode, WEATHER_MODES } from "./scene-weather-mode.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const OVERLAY_ID = "wdm-lightning";
const THUNDER_DIR = `systems/${SYSTEM_ID}/assets/weather/sounds/thunder`;
const THUNDER_FILES = [1, 2, 3, 4, 5].map(n => `${THUNDER_DIR}/thunder-${n}.ogg`);

let _timer = null;
let _active = false;
let _audioOnly = false;               // indoor: thunder rolls, no visual flash
let _thunder = null;                  // procedural fallback (thunder.mjs)
const _claps = {};                    // src → loaded foundry.audio.Sound
const _clapFailed = new Set();        // srcs whose load failed (use the synth)
let _lastClap = -1;                   // last sample index — never picked twice running

const INDOOR_THUNDER_VOL = 0.6;       // ducked "through the walls" indoors
const INDOOR_THUNDER_LOWPASS = 8;     // biquad intensity — muffled timbre indoors

/* A fresh low-pass node on the clap Sound's own context, via the same registry
 * core/the weather ambience use (CONFIG.soundEffects). Null if unavailable. */
function makeThunderLowpass(sound) {
    const cfg = CONFIG?.soundEffects?.lowpass;
    if (!cfg?.effectClass || !sound?.context) return null;
    try { return new cfg.effectClass(sound.context, { type: "lowpass", intensity: INDOOR_THUNDER_LOWPASS }); }
    catch (_) { return null; }
}

function settingOn(key) {
    try { return !!game.settings.get(SYSTEM_ID, key); } catch (_) { return false; }
}

/* Pick the next thunder sample, never the same one twice in a row, so repeated
 * strikes don't audibly reuse a clip back-to-back. */
function pickClap() {
    const n = THUNDER_FILES.length;
    if (n < 2) return 0;
    let i;
    do { i = Math.floor(Math.random() * n); } while (i === _lastClap);
    _lastClap = i;
    return i;
}

/* Play one thunderclap from the CC0 samples; fall back to the procedural synth
 * if the files aren't present (so it's never silent before assets are added).
 * Plays on the environment AudioContext, so Foundry's Ambient volume slider —
 * the same one that scales the weather ambience playlist — sets the loudness.
 * `vol` already carries the per-strike distance loudness; a small jitter on top
 * keeps even same-distance claps from sounding identical. */
async function playClap(vol) {
    // Indoors the storm is heard through the walls: duck the clap and run it
    // through a low-pass so it reads as muffled, matching the weather ambience.
    const indoor = _audioOnly;
    const v = indoor ? vol * INDOOR_THUNDER_VOL : vol;
    const src = THUNDER_FILES[pickClap()];
    const Sound = foundry?.audio?.Sound;
    if (Sound && !_clapFailed.has(src)) {
        try {
            let s = _claps[src];
            if (!s) { s = new Sound(src, { context: game?.audio?.environment }); await s.load(); _claps[src] = s; }
            await s.stop({ fade: 0 });
            // Sound instances are cached + reused, so always (re)set effects:
            // a low-pass indoors, an empty chain outdoors to clear a stale one.
            const lp = indoor ? makeThunderLowpass(s) : null;
            s.applyEffects(lp ? [lp] : []);
            await s.play({ volume: Math.min(1, (0.85 + Math.random() * 0.3) * v) });
            return;
        } catch (_) { _clapFailed.add(src); }
    }
    (_thunder ??= new Thunder()).boom(Math.min(1, (0.85 + Math.random() * 0.3) * v));
}

/* Roll the thunder that follows a flash, gated behind the per-client
 * `weatherThunder` toggle. `dist` ∈ [0,1] is how far away the strike is
 * (0 = overhead, 1 = on the horizon): farther strikes both LAG the flash more
 * (sound is slow) and arrive QUIETER, which is what reads as distance. */
function rollThunder(dist) {
    if (!settingOn("weatherThunder")) return;
    const delay = 300 + dist * 2900;                   // ~0.3s overhead → ~3.2s distant
    const vol   = 0.5 - dist * 0.4;                    // ~0.5 overhead → ~0.1 distant
    setTimeout(() => playClap(vol), delay);
}

function overlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = OVERLAY_ID;
        document.body.appendChild(el);
    }
    return el;
}

/* One strike: a quick, slightly irregular double flash. A per-strike `dist`
 * (0 = overhead, 1 = on the horizon) ties the flash brightness and the thunder
 * together — close strikes are bright AND loud AND quick, far ones dim, faint
 * and delayed. Indoors (`_audioOnly`) the flash is skipped but the thunder still
 * rolls — you hear the storm through the walls. */
function strike() {
    const dist = Math.random();
    if (!_audioOnly) {
        const near = 1 - dist;
        const peak = 0.30 + 0.50 * near;               // distant ~0.30 → overhead ~0.80
        const el = overlay();
        el.getAnimations?.().forEach(a => a.cancel());
        el.animate(
            [
                { opacity: 0 },
                { opacity: peak,        offset: 0.06 },
                { opacity: peak * 0.13, offset: 0.18 },
                { opacity: peak * 1.25, offset: 0.28 },
                { opacity: 0,           offset: 1 }
            ],
            { duration: 650, easing: "ease-out" }
        );
    }
    rollThunder(dist);
}

/* Random gap (ms) until the next strike. Real lightning fires in irregular
 * bursts, not on a metronome, so the cadence is deliberately lumpy: usually a
 * 5–16s gap, sometimes a quick follow-up (a nearby cell firing again), and
 * occasionally a long lull — so the timing never settles into a rhythm. */
function nextDelay() {
    const r = Math.random();
    if (r < 0.22) return 1500 + Math.random() * 2500;    // quick follow-up ~1.5–4s
    if (r < 0.85) return 5000 + Math.random() * 11000;   // normal ~5–16s
    return 16000 + Math.random() * 14000;                // long lull ~16–30s
}

function loop() {
    strike();
    _timer = setTimeout(loop, nextDelay());
}

/** Stop the flashing and remove the overlay. Safe to call when idle. */
export function stopLightning() {
    _active = false;
    _audioOnly = false;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    document.getElementById(OVERLAY_ID)?.remove();
}

/**
 * Reconcile the lightning loop with the current weather + toggles. Idempotent
 * and cheap — safe to call on every world-time / setting / canvas change.
 *
 * Scene mode drives WHAT runs: OUTDOOR flashes + thunders; INDOOR runs an
 * audio-only loop (thunder rolls, no flash — you hear it through the walls);
 * OFF is silent. The strike loop is what schedules the thunderclaps, so an
 * indoor scene must keep the loop alive (just muted visually), not stop it.
 */
export function syncLightning() {
    const mode = sceneWeatherMode();
    if (!settingOn("weatherEnabled") || !settingOn("autoWeatherFx") || !canvas?.ready
        || mode === WEATHER_MODES.OFF) {
        stopLightning();
        return;
    }
    // Lightning is its own additive phenomenon now: ONLY the lightning tag
    // flashes. A plain rain/snow storm stays quiet (layer "Lightning Storm" on
    // top of it for a thunderstorm).
    const tags = getActiveWeather().tags ?? {};
    if (!tags.lightning) { stopLightning(); return; }

    const audioOnly = (mode === WEATHER_MODES.INDOOR);
    if (_active && _audioOnly === audioOnly) return;   // already running in this mode

    // Switching modes (e.g. walking indoors): drop any in-flight flash before
    // restarting so an outdoor strike doesn't linger on an indoor scene.
    document.getElementById(OVERLAY_ID)?.remove();
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _active = true;
    _audioOnly = audioOnly;
    _timer = setTimeout(loop, 800 + Math.random() * 3000);
}
