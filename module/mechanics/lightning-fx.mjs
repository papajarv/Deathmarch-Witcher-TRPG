/**
 * Storm lightning — random full-canvas flashes while the active weather carries
 * the `lightning` tag (the "Lightning Storm" state). Plain rain/snow storms do
 * NOT flash; lightning is a separate additive layer you stack on top.
 *
 * Runs on EVERY client (players see the flashes too), driven purely off the
 * locally-computed active weather, so it needs no socket traffic — each client
 * strikes on its own random cadence, which reads fine for ambient lightning.
 *
 * The flash is a real canvas-light pulse, not a DOM overlay: it briefly lifts
 * the scene's darkness toward 0 and bumps base luminosity through the same local
 * `canvas.environment` pipeline the day/night + weather darkness already use (see
 * scene-fx.flashEnvironment). So the strike actually lights the scene — tokens,
 * terrain and walls all catch it and it reads as light — and composes with the
 * current darkness instead of whitewashing the whole viewport.
 */

import { getActiveWeather } from "./manual-weather.mjs";
import { Thunder } from "./thunder.mjs";
import { sceneWeatherMode, WEATHER_MODES, viewerInsideSuppressWeather } from "./scene-weather-mode.mjs";
import { flashEnvironment, stopEnvironmentFlash } from "./scene-fx.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const THUNDER_DIR = `systems/${SYSTEM_ID}/assets/weather/sounds/thunder`;
const THUNDER_FILES = [1, 2, 3, 4, 5].map(n => `${THUNDER_DIR}/thunder-${n}.ogg`);

let _timer = null;
let _active = false;
let _muffled = false;                 // sheltered: thunder ducked + low-passed
let _flashScale = 1;                  // flash intensity: 1 outdoors, dimmed sheltered in a region, 0 fully indoors
let _thunder = null;                  // procedural fallback (thunder.mjs)
const _claps = {};                    // src → loaded foundry.audio.Sound
const _clapFailed = new Set();        // srcs whose load failed (use the synth)
let _lastClap = -1;                   // last sample index — never picked twice running

const INDOOR_THUNDER_VOL = 0.6;       // ducked "through the walls" indoors
const INDOOR_THUNDER_LOWPASS = 8;     // biquad intensity — muffled timbre indoors
const SHELTERED_FLASH = 0.35;         // flash scale when sheltered by a suppress-weather region (storm seen from the opening)

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
    // Sheltered (indoor scene or inside a suppress-weather region) the storm is
    // heard through the walls: duck the clap and run it through a low-pass so it
    // reads as muffled, matching the weather ambience.
    const indoor = _muffled;
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

/* One strike: a quick, slightly irregular double flash driven through the
 * canvas lighting layer (scene-fx.flashEnvironment does the two-pulse strobe
 * shaping). A per-strike `dist` (0 = overhead, 1 = on the horizon) ties the
 * flash brightness and the thunder together — close strikes are bright AND loud
 * AND quick, far ones dim, faint and delayed. `_flashScale` attenuates the flash
 * when sheltered: full outdoors, dimmed inside a suppress-weather region (the
 * sky still lights up, seen from the opening), 0 on a fully-Indoor scene — but
 * the thunder still rolls in every case (you hear the storm through the walls). */
function strike() {
    const dist = Math.random();
    if (_flashScale > 0) {
        const near = 1 - dist;
        const peak = (0.30 + 0.50 * near) * _flashScale;   // distant ~0.30 → overhead ~0.80, scaled by shelter
        flashEnvironment(peak);
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

/** Stop the flashing and settle the canvas light back. Safe to call when idle. */
export function stopLightning() {
    _active = false;
    _muffled = false;
    _flashScale = 1;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    stopEnvironmentFlash();
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

    /* Shelter handling. The flash is the storm lighting the SKY (a scene-global
     * canvas-light pulse now, not a region-shaped overlay), so it stays visible
     * to a viewer merely sheltered by a Suppress-Weather region — just dimmed, as
     * if seen from the opening. Only a scene explicitly set Indoor hides it.
     * Thunder is muffled in either sheltered case (heard through the walls). */
    const viewerSuppressed = viewerInsideSuppressWeather();
    const indoor = (mode === WEATHER_MODES.INDOOR);
    const muffled = indoor || viewerSuppressed;
    const flashScale = indoor ? 0 : (viewerSuppressed ? SHELTERED_FLASH : 1);
    if (_active && _muffled === muffled && _flashScale === flashScale) return;   // already running like this

    // Switching modes (e.g. walking indoors): drop any in-flight flash before
    // restarting so an outdoor strike doesn't linger on an indoor scene.
    stopEnvironmentFlash();
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _active = true;
    _muffled = muffled;
    _flashScale = flashScale;
    _timer = setTimeout(loop, 800 + Math.random() * 3000);
}
