/**
 * Scene environment automation (Phase 4 of the inbuilt weather subsystem).
 *
 * Behaviours, all driven off the live calendar + weather engine, applied to
 * the CURRENTLY VIEWED scene (`canvas.scene`):
 *
 *   1. Darkness + daylight tint (LOCAL, every client) — `environment.darknessLevel`
 *      ramps from 0 (midday) to 1 (deep night) across the season's dawn/dusk
 *      twilight, with a weather "dimming" bump so storms/fog darken the daytime
 *      too; `environment.base` is tinted by sky cover (warm/bright when clear,
 *      cool/dim/desaturated when overcast) — the gloom the additive weather
 *      layer can't paint. Both gated behind `autoSceneDarkness` and animated via
 *      CanvasAnimation (see applyEnvironment) so they taper instead of snapping.
 *   2. Weather FX (local, every client) — Foundry's native weather layer draws
 *      rain / snow / hail / fog from the weather `tags`, composed into a native
 *      weather config by weather-effects.mjs. Lightning flashes are a separate
 *      overlay (lightning-fx.mjs), wired in below.
 *
 * The environment is driven by a per-frame canvas.environment.initialize render
 * call on EVERY client (no scene-doc write), gated behind the master
 * `weatherEnabled` switch AND the `autoSceneDarkness` toggle. The weather
 * renderer is likewise local, gated behind `weatherEnabled` + `autoWeatherFx`.
 * The lone surviving GM-only doc write is the legacy `weather=""` cleanup.
 *
 * The pure helpers (timeDarkness / weatherDarkBump / darknessForTime) have no
 * Foundry dependency beyond the calendar read, so they're unit-testable under a
 * mocked game global.
 */

import { getActiveWeather } from "./manual-weather.mjs";
import { syncWeatherEffects, stopWeatherEffects, invalidateWeatherEffects } from "./weather-effects.mjs";
import { syncLightning, stopLightning } from "./lightning-fx.mjs";
import { syncWeatherSound } from "./weather-sound.mjs";
import { suppressWeatherVisuals, isTimeDarknessDisabled } from "./scene-weather-mode.mjs";
import { syncSceneWeatherAudio } from "./scene-weather-audio.mjs";
import { isPitchBlack, moonBrightness } from "./weather-modifiers.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Twilight shape (hours), ASYMMETRIC because real light is: sunlight holds
 * almost full through the afternoon, dims gently as the sun nears the horizon,
 * then keeps fading well PAST sunset through civil/nautical twilight before
 * true dark. So the half-dark point sits AFTER dusk, not on it — and the whole
 * thing is smoothstep-eased, so there's no hard snap between adjacent hours.
 *
 *   DAWN_LEAD   pre-dawn glow begins this long before sunrise
 *   DAY_RISE    full daylight reached this long after sunrise
 *   DUSK_LEAD   light starts dimming this long before sunset
 *   NIGHT_FALL  true dark reached this long after sunset
 */
const DAWN_LEAD  = 2.0;
const DAY_RISE   = 1.0;
const DUSK_LEAD  = 1.5;
const NIGHT_FALL = 2.5;

/* How much a FULL moon lifts a clear night out of darkness. Night darkness is
 * scaled by (1 − moonBrightness × MOON_LIFT): at MOON_LIFT 0.30 a full moon
 * (brightness 1) brings deep-night darkness 1.0 → 0.70 (the Dim tier), a new
 * moon (0) leaves it at 1.0 (Darkness), and the phases in between ramp smoothly.
 * Clouds zero out moonBrightness, so an occluded night ignores the moon. */
const MOON_LIFT = 0.30;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampSym = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);   // luminosity/saturation ∈ [-1,1]

/* Night colour cast. As the day/night darkness deepens we fold a subtle cool-blue
 * tint into the scene base so night reads as night-COLOURED, not flat grey. Kept
 * deliberately gentle (low intensity); the slight +saturation keeps it from
 * greying out. hue ≈ 0.62 is a deep blue on Foundry's 0–1 hue wheel. */
const NIGHT_TINT = Object.freeze({ hue: 0.62, intensity: 0.18, luminosity: -0.03, saturation: 0.04 });

/* Hermite smoothstep: 0 below edge0, 1 above edge1, eased in between. */
function smoothstep(edge0, edge1, x) {
    if (edge0 === edge1) return x < edge0 ? 0 : 1;
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

/**
 * Time-of-day darkness in [0,1]. 0 in full day, 1 in deep night, easing
 * gradually across long, asymmetric dawn/dusk twilight windows so the change
 * is slow and realistic (no halfway-dark at the dusk hour itself).
 * @param {number} hour       Hour-of-day (0–24, fractional).
 * @param {{dawn:number,dusk:number}} sunTimes
 */
export function timeDarkness(hour, sunTimes) {
    const dawn = sunTimes?.dawn ?? 6;
    const dusk = sunTimes?.dusk ?? 18;
    const rise = smoothstep(dawn - DAWN_LEAD, dawn + DAY_RISE, hour);       // 0 → 1 over morning
    const set  = 1 - smoothstep(dusk - DUSK_LEAD, dusk + NIGHT_FALL, hour); // 1 → 0 over evening
    return clamp01(1 - rise * set);
}

/**
 * Daytime dimming from weather tags, in [0, 0.9]. Obscurants COMPOUND — an
 * overcast + thickly-fogged blizzard is far darker than any layer alone — via
 * `1 − Π(1 − cut)`, where each `cut` is the fraction of daylight that layer
 * removes. Capped below 1 so daytime never fully blacks out (total dark is the
 * night-only Pitch Black state). Only bites in daylight: the call site scales it
 * by `(1 − darkness)`, so it can't over-darken an already-dark night.
 */
export function weatherDarkBump(tags) {
    if (!tags) return 0;
    const cuts = [];
    const cloud = Number(tags.cloud) || 0;
    if (cloud >= 2)      cuts.push(0.25);
    else if (cloud >= 1) cuts.push(0.12);
    const fog = Number(tags.fog) || 0;
    if (fog >= 3)      cuts.push(0.55);
    else if (fog >= 2) cuts.push(0.35);
    else if (fog >= 1) cuts.push(0.15);
    const precip = Number(tags.precip) || 0;
    if (precip >= 3)      cuts.push(0.50);
    else if (precip >= 2) cuts.push(0.25);
    else if (precip >= 1) cuts.push(0.10);
    const snow = Number(tags.snow) || 0;
    if (snow >= 3)      cuts.push(0.50);
    else if (snow >= 2) cuts.push(0.30);
    else if (snow >= 1) cuts.push(0.12);
    if (tags.storm) cuts.push(0.45);
    let light = 1;
    for (const c of cuts) light *= (1 - c);
    return Math.min(0.90, 1 - light);
}

/* Effective sky cover in [0,2] — precipitation / storm / fog imply overcast even
 * when no explicit cloud layer is picked, so a rainy scene still reads grey. */
function effectiveCloud(tags) {
    const t = tags ?? {};
    const cloud = Number(t.cloud) || 0;
    if (t.storm || (Number(t.precip) || 0) >= 2 || (Number(t.snow) || 0) >= 2
        || (Number(t.fog) || 0) >= 2 || cloud >= 2) return 2;
    if (cloud >= 1 || (Number(t.precip) || 0) >= 1 || (Number(t.snow) || 0) >= 1
        || (Number(t.fog) || 0) >= 1) return 1;
    return 0;
}

/**
 * Scene daylight tint (environment.base) for the active weather. This is the
 * WHOLE cloudy/overcast look now — there is no weather-layer cloud haze — so the
 * gloom lives entirely in the scene environment:
 *   overcast    → cool, dim, desaturated
 *   cloudy      → a milder cool grade
 *   sunny/clear → warm, brighter, more saturated — but ONLY when the sky is
 *                 EXPLICITLY sunny (auto "clear", manual "Sunny Day", or a
 *                 heatwave, all of which carry a `clear`/`heat` tag)
 *   no sky      → NEUTRAL. A manual override with the Sky layer on "None" has no
 *                 sky tag at all, so it must not grade the scene — "None" means
 *                 "leave it as authored", matching Indoor / Disable-FX.
 * Pairs with the darknessLevel bump from weatherDarkBump.
 * @returns {{hue:number,intensity:number,luminosity:number,saturation:number}}
 */
export function cloudTint(tags) {
    switch (effectiveCloud(tags)) {
        case 2: return { hue: 0.60, intensity: 0.22, luminosity: -0.20, saturation: -0.38 };
        case 1: return { hue: 0.60, intensity: 0.12, luminosity: -0.10, saturation: -0.22 };
    }
    // effectiveCloud 0: warm grade ONLY for an explicitly sunny/clear/hot sky;
    // a blank "None" sky has neither tag and stays neutral (no grade).
    if (tags?.clear || tags?.heat) return { hue: 0.10, intensity: 0.10, luminosity: 0.092, saturation: 0.12 };
    return { hue: 0, intensity: 0, luminosity: 0, saturation: 0 };
}

/** Pure day/night darkness for a world time (NO weather dimming), or null if no
 * calendar is registered. This is the scene's baseline brightness — what Indoor /
 * Disable-FX fall back to (storm gloom removed, day/night kept). */
export function timeDarknessNow(worldTime = game.time?.worldTime ?? 0) {
    const cal = game.time?.calendar;
    if (!cal?.timeToComponents) return null;
    const c = cal.timeToComponents(worldTime);
    if (!c) return null;
    const sun = cal.getSunTimes?.(c) ?? { dawn: 6, dusk: 18 };
    const hour = (c.hour ?? 0) + (c.minute ?? 0) / 60;
    return timeDarkness(hour, sun);
}

/** Combined scene darkness for a world time (day/night + weather dimming), or
 * null if no calendar. */
export function darknessForTime(worldTime = game.time?.worldTime ?? 0) {
    const td = timeDarknessNow(worldTime);
    if (td == null) return null;
    const tdMoon = td * (1 - moonBrightness(worldTime) * MOON_LIFT);   // bright moon lifts a clear night
    const bump = weatherDarkBump(getActiveWeather(worldTime).tags);
    return clamp01(tdMoon + bump * (1 - tdMoon));
}

function settingOn(key) {
    try { return !!game.settings.get(SYSTEM_ID, key); } catch (_) { return false; }
}

/* ─────────── environment animation ─────────────────────────────────────────
 * Darkness + daylight tint are driven LOCALLY on every client (not via a GM
 * scene-doc write) so the change tapers instead of snapping: `scene.update`
 * only animates `environment.darknessLevel`, leaving the base tint (hue /
 * intensity / luminosity / saturation) to jump. Instead we interpolate ALL of
 * them with CanvasAnimation and feed each frame to canvas.environment.initialize
 * — the same per-frame render call core uses for its own darkness animation. No
 * doc write means players taper smoothly too (no socket lag) and there's no
 * update churn; the environment is derived state, recomputed on every tick. */
const ENV_ANIM = "wdmSceneEnv";
const ENV_MS = 2000;
const lerp = (a, b, k) => a + (b - a) * k;

let _envApplied = null;   // last env we rendered locally, or null when not overriding
let _envFirst = true;     // snap (no fade) on the first paint of a scene

/* Lightning flash — a transient brightening composited on top of the base env
 * by paintEnv (see flashEnvironment). `_flash` ∈ [0,~1.25]; 0 when idle. It
 * lifts darkness toward 0 and bumps base luminosity, so a strike genuinely
 * lights the scene through the canvas lighting layer rather than washing it
 * with a DOM overlay. `_flashDocBase` holds the scene's own env to compose over
 * when the subsystem isn't driving darkness (autoSceneDarkness off), so a strike
 * still illuminates. */
const FLASH_ANIM = "wdmLightningFlash";
const FLASH_LUM = 0.6;    // base.luminosity added per unit of flash
let _flash = 0;
let _flashDocBase = null;

function readDocEnv(scene) {
    const e = scene?.environment ?? {};
    const b = e.base ?? {};
    return {
        darkness: Number(e.darknessLevel ?? 0),
        hue: Number(b.hue ?? 0), intensity: Number(b.intensity ?? 0),
        luminosity: Number(b.luminosity ?? 0), saturation: Number(b.saturation ?? 0)
    };
}

/* The scene's AUTHORED darkness — read from the persisted document _source, NOT
 * the prepared `scene.environment` which our own per-tick canvas.environment.
 * initialize() overrides drive locally. This is "the darkness before time/weather
 * ever touched it", which is exactly what Disable-Time-Darkness must pin to (and
 * what release restores). Falls back to the prepared value, then 0. */
function authoredDarkness(scene) {
    const src = Number(scene?._source?.environment?.darknessLevel);
    if (Number.isFinite(src)) return src;
    const prep = Number(scene?.environment?.darknessLevel);
    return Number.isFinite(prep) ? prep : 0;
}

/* The environment we want to render for the VIEWED scene right now — a pure,
 * DETERMINISTIC function of (weather, time, scene mode, the disable-time-darkness
 * flag, the scene's authored env). Two INDEPENDENT controls:
 *
 *   - Scene mode (Outdoor / Indoor / Off) governs only the WEATHER presentation.
 *     Suppressed (Indoor / Off) drops the weather TINT and the weather dark-BUMP,
 *     but KEEPS the day/night cycle on the scene's own base — Indoor at 3 a.m. is
 *     still night, just without rain on the walls. (Sound is handled elsewhere.)
 *   - "Disable Time Darkness" (per-scene flag, its own button) pins the darkness
 *     to the scene's AUTHORED level and drops the night cast, REGARDLESS of mode —
 *     for a torch-lit dungeon whose lighting must not follow the outdoor clock.
 *
 * The two compose: e.g. an Indoor scene with time-darkness disabled shows the
 * authored lighting with no weather and no day/night swing. */
function targetEnv() {
    const suppressed = suppressWeatherVisuals();
    const noTimeDark = isTimeDarknessDisabled();
    const doc = readDocEnv(canvas.scene);
    const td = timeDarknessNow();
    const tags = getActiveWeather().tags;

    // Daytime base tint: the weather grade outdoors, the scene's own base when
    // suppressed (Indoor / Off keep their authored colour, just no weather).
    const dayTint = suppressed
        ? { hue: doc.hue, intensity: doc.intensity, luminosity: doc.luminosity, saturation: doc.saturation }
        : cloudTint(tags);

    // Night colour cast, growing with the day/night darkness. Dropped only when the
    // scene opts out of time darkness, or there's no calendar to tell time — NOT by
    // Indoor/Off, which keep the cycle. A single hue channel can't show two tints at
    // once, so the stronger of the (fading) day tint and the (rising) night blue wins
    // the hue — they cross over while both faint, so the swap isn't jarring;
    // luminosity/saturation just sum.
    const nightF = (noTimeDark || td == null) ? 0 : clamp01(td);
    const nInt = NIGHT_TINT.intensity * nightF;
    const hueWin = nInt >= dayTint.intensity
        ? { hue: NIGHT_TINT.hue, intensity: nInt }
        : { hue: dayTint.hue, intensity: dayTint.intensity };
    const luminosity = clampSym(dayTint.luminosity + NIGHT_TINT.luminosity * nightF);
    const saturation = clampSym(dayTint.saturation + NIGHT_TINT.saturation * nightF);

    // Darkness: "Disable Time Darkness" pins to the authored level (a dungeon stays
    // lit at 3 a.m.); a missing calendar holds the current value; otherwise it's the
    // day/night value plus the weather dimming bump (bump dropped when suppressed, so
    // Indoor/Off never end up darker than the plain day).
    let darkness;
    if (noTimeDark) darkness = authoredDarkness(canvas.scene);   // the scene's own configured darkness dictates
    else if (td == null) darkness = null;                    // no calendar: hold current
    else {
        // A bright moon lifts a CLEAR night out of full dark (full → Dim, new →
        // Darkness); clouds cancel it (moonBrightness → 0 when occluded). Dropped
        // when suppressed — an indoor room doesn't catch the moon. Then weather
        // darkens on top, mostly biting in daylight via the (1 − tdMoon) scale.
        const moonLift = suppressed ? 0 : moonBrightness() * MOON_LIFT;
        const tdMoon = td * (1 - moonLift);
        const bump = suppressed ? 0 : weatherDarkBump(tags);
        darkness = clamp01(tdMoon + bump * (1 - tdMoon));
    }

    // Global illumination management → the Darkness vs Pitch Black split. On a
    // scene whose global illumination the GM enabled (an outdoor scene), the
    // subsystem keeps global light active through the night (so a dark night is
    // Darkness — lit, sees with −4) but DISABLES it on the Pitch Black weather
    // category (an occluded, moonless night), which is what makes Pitch read as
    // blinded. `null` = don't manage it: leave the scene's own global light alone
    // when the GM didn't enable it (a torch-only dungeon), when Time Darkness is
    // disabled, or when weather is suppressed (Indoor / Off keep their lit night —
    // Pitch is a weather effect, not a room's own darkness).
    let globalLightEnabled = null;
    const authoredGlobalOn = !!canvas.scene?.environment?.globalLight?.enabled;
    if (authoredGlobalOn && !noTimeDark && !suppressed) {
        globalLightEnabled = !isPitchBlack();
    }

    return {
        darkness,
        hue: hueWin.hue, intensity: hueWin.intensity,
        luminosity, saturation, globalLightEnabled
    };
}

function renderEnv(env) {
    _envApplied = env;
    paintEnv();
}

/* Push the current base env — with any active lightning flash composited in —
 * to the canvas. Base is our managed env when we own it, else the scene's own
 * env captured for the duration of a strike. The flash lifts darkness toward 0
 * and adds base luminosity, so the strike reads as light on the lighting layer.
 * Called every frame by both the env fade (renderEnv) and the flash driver, so
 * the two compose cleanly when they overlap. */
function paintEnv() {
    const base = _envApplied ?? _flashDocBase;
    if (!base) return;
    const environment = { base: {
        hue: base.hue, intensity: base.intensity,
        luminosity: clampSym(base.luminosity + _flash * FLASH_LUM),
        saturation: base.saturation
    } };
    if (base.darkness != null) environment.darknessLevel = clamp01(base.darkness - _flash);
    // Drive global illumination only when we're managing it (Pitch Black kills
    // it; Darkness keeps it). A lightning flash momentarily re-lights it so a
    // strike illuminates even a pitch-black night. Full activation range so
    // "enabled" means active at every darkness level (a dark night stays lit).
    // When not managing (null), the scene's own global light stands.
    if (base.globalLightEnabled != null) {
        environment.globalLight = { enabled: base.globalLightEnabled || _flash > 0, darkness: { min: 0, max: 1 } };
    }
    try { canvas?.environment?.initialize({ environment }); } catch (_) {}
}

/**
 * Lightning strike flash — a brief, local canvas-light pulse composited onto the
 * live scene environment. Transient and per-client; never touches `_envApplied`
 * or the scene doc, so the running day/night + weather darkness resumes exactly
 * where it left off. `peak` ∈ (0,1] scales intensity (near strikes brighter).
 * Reuses the scene-env pipeline, so it composes with whatever darkness/tint is
 * applied and the scene is genuinely lit rather than overlaid with flat white.
 */
export function flashEnvironment(peak = 0.8) {
    if (!canvas?.ready || !canvas.scene) return;
    const CanvasAnimation = foundry.canvas.animation.CanvasAnimation;
    CanvasAnimation.terminateAnimation(FLASH_ANIM);
    // Compose over our managed env if we own it; otherwise capture the scene's
    // own env so a strike still lights scenes where we don't drive darkness.
    _flashDocBase = _envApplied ? null : readDocEnv(canvas.scene);
    const p = clamp01(peak);
    const holder = { t: 0 };
    // Two-pulse strobe over ~0.65s: fast rise, brief dip, a brighter second
    // peak, then decay — the classic lightning double-flash.
    const shape = (t) => {
        if (t < 0.06) return p * (t / 0.06);
        if (t < 0.18) return p * lerp(1, 0.13, (t - 0.06) / 0.12);
        if (t < 0.28) return p * lerp(0.13, 1.25, (t - 0.18) / 0.10);
        return p * 1.25 * clamp01(1 - (t - 0.28) / 0.72);
    };
    CanvasAnimation.animate([{ parent: holder, attribute: "t", to: 1, from: 0 }], {
        name: FLASH_ANIM,
        duration: 650,
        ontick: () => { _flash = shape(holder.t); paintEnv(); }
    }).then(() => { _flash = 0; paintEnv(); })
      .catch(() => { _flash = 0; });
}

/** Cancel any in-flight lightning flash and settle back to the base env. */
export function stopEnvironmentFlash() {
    foundry.canvas.animation.CanvasAnimation.terminateAnimation(FLASH_ANIM);
    _flash = 0;
    _flashDocBase = null;
    paintEnv();
}

function envClose(a, b) {
    return a.globalLightEnabled === b.globalLightEnabled   // a Pitch flip may not move darkness/tint — never skip it
        && Math.abs(a.darkness - b.darkness) < 0.01
        && Math.abs(a.hue - b.hue) < 0.01
        && Math.abs(a.intensity - b.intensity) < 0.01
        && Math.abs(a.luminosity - b.luminosity) < 0.01
        && Math.abs(a.saturation - b.saturation) < 0.01;
}

/* Fully release the environment back to the scene's OWN authored values (base AND
 * darkness) and stop tracking. Used only when the subsystem doesn't own this scene
 * — master switch / autoSceneDarkness off, no live canvas, or teardown. NOT used
 * for Indoor / Disable-FX: those are still actively managed by applyEnvironment
 * (they keep the day/night cycle, just without weather), so routing them here was
 * the source of the fiddly darkness. A bare initialize() doesn't reliably clear a
 * base tint we pushed, so re-push the doc's own base + darkness explicitly. */
function releaseEnv() {
    foundry.canvas.animation.CanvasAnimation.terminateAnimation(ENV_ANIM);
    foundry.canvas.animation.CanvasAnimation.terminateAnimation(FLASH_ANIM);
    _flash = 0;
    _flashDocBase = null;
    if (_envApplied && canvas?.scene) {
        const d = readDocEnv(canvas.scene);
        try {
            canvas.environment.initialize({ environment: {
                base: { hue: d.hue, intensity: d.intensity, luminosity: d.luminosity, saturation: d.saturation },
                darknessLevel: d.darkness
            } });
        } catch (_) {}
    }
    _envApplied = null;
    _envFirst = true;
}

/** Reset on scene teardown so the next scene snaps to its own baseline. */
export function resetSceneEnv() { releaseEnv(); }

function applyEnvironment() {
    // The subsystem owns the scene environment only when BOTH master switches are
    // on and the canvas is live. Otherwise hand control back to the authored scene.
    // Indoor / Off are NOT released here — they're a managed target in targetEnv()
    // (authored base, no weather, day/night kept) so they resolve deterministically.
    if (!settingOn("weatherEnabled") || !settingOn("autoSceneDarkness")
        || !canvas?.ready || !canvas.scene) {
        releaseEnv();
        return;
    }

    const from = _envApplied ?? readDocEnv(canvas.scene);
    const to = targetEnv();
    if (to.darkness == null) to.darkness = from.darkness;   // no calendar: hold current

    const CanvasAnimation = foundry.canvas.animation.CanvasAnimation;
    CanvasAnimation.terminateAnimation(ENV_ANIM);

    if (_envFirst) { _envFirst = false; renderEnv(to); return; }   // no load-time fade
    if (envClose(from, to)) return;

    const holder = { t: 0 };
    CanvasAnimation.animate([{ parent: holder, attribute: "t", to: 1, from: 0 }], {
        name: ENV_ANIM,
        duration: ENV_MS,
        easing: CanvasAnimation.easeInOutCosine,
        ontick: () => renderEnv({
            darkness: lerp(from.darkness, to.darkness, holder.t),
            hue: lerp(from.hue, to.hue, holder.t),
            intensity: lerp(from.intensity, to.intensity, holder.t),
            luminosity: lerp(from.luminosity, to.luminosity, holder.t),
            saturation: lerp(from.saturation, to.saturation, holder.t),
            globalLightEnabled: to.globalLightEnabled   // discrete — snap to target, don't lerp
        })
    });
}

/* Re-apply our env override NOW, snapping (no debounce, no fade) so it lands in
 * the same frame as whatever external canvas.environment.initialize() just wiped
 * it — the wiped state never paints, so there's no visible flash. The fade is
 * only wanted for genuine time-of-day / weather drift, not for restoring after a
 * wipe. Call synchronously when the wipe already happened (config close); defer
 * to a microtask when the wipe lands AFTER us (the updateScene doc path). */
function reapplyEnvNow() {
    _envFirst = true;       // forces applyEnvironment to snap (renderEnv, no fade)
    applyEnvironment();
}

/* Weather particles are driven through Foundry's native weather layer
 * (weather-effects.mjs), not via the scene `weather` key. Clear any legacy key
 * this system wrote before the renderer existed so the two don't double up.
 * GM-only (the lone surviving doc write). */
async function clearLegacyWeatherKey() {
    if (!game.user?.isGM) return;
    const scene = canvas?.scene;
    if (typeof scene?.weather !== "string" || !scene.weather.startsWith("wdmFx_")) return;
    try { await scene.update({ weather: "" }); }
    catch (err) { console.warn("[wdm-scene-fx] scene update failed", err); }
}

/* ─────────── wiring ───────────────────────────────────────────────────────── */

let _applyTimer = null;
function scheduleApply() {
    if (_applyTimer) return;
    _applyTimer = setTimeout(() => { _applyTimer = null; applyEnvironment(); clearLegacyWeatherKey(); }, 120);
}

/* The environment + weather renderers are local visuals every client draws,
 * driven off the same weather read. Bundle them so all react to the same
 * triggers. */
function tick() {
    scheduleApply();
    syncWeatherEffects();
    syncLightning();
    syncWeatherSound();
    syncSceneWeatherAudio();   // local per-client muffle/mute for the viewed scene
}

/* rAF-coalesced tick for the HIGH-FREQUENCY triggers (controlToken / updateToken
 * / updateUser). Those hooks fire once PER token, so a box-select or multi-token
 * move of N tokens ran the full weather/lightning/audio re-sync N times — the
 * single biggest measured cost of a multi-token selection. tick() is idempotent
 * (it re-derives everything from the CURRENT state), so collapsing a frame's
 * burst of control/move events into one tick is exact, not lossy. */
let _tickQueued = false;
function scheduleTick() {
    if (_tickQueued) return;
    _tickQueued = true;
    requestAnimationFrame(() => { _tickQueued = false; tick(); });
}

/** Register the scene-environment automation. No-op when the master switch is
 * off (an external module owns weather/lighting then). */
export function wireSceneFx() {
    if (!settingOn("weatherEnabled")) return;
    Hooks.on("updateWorldTime", tick);
    Hooks.on("canvasReady", tick);
    Hooks.on("canvasTearDown", () => {
        // Ambience is a global synced playlist now — it persists across scene
        // changes, so we deliberately do NOT stop it here.
        if (_applyTimer) { clearTimeout(_applyTimer); _applyTimer = null; }
        stopWeatherEffects(); stopLightning(); resetSceneEnv();
    });
    Hooks.on("updateScene", (scene, changes) => {
        // Saving environment / background / fog-colour changes makes core call
        // canvas.environment.initialize() (scene.mjs _onUpdate), which re-reads the
        // doc and WIPES our LOCAL weather tint + darkness (never written to the doc,
        // by design). Core fires this hook BEFORE that wipe, so re-applying now would
        // just be overwritten — defer to a microtask, which drains after _onUpdate
        // finishes but before the browser paints, so the restore lands in the same
        // frame as the wipe (no flash). Other scene saves (e.g. the terrain tool's
        // flag writes) don't touch the environment — ignore them.
        if (scene !== canvas?.scene) return;
        // Our per-scene weather mode (indoor / off / outdoor) or the
        // disable-time-darkness flag changed → re-evaluate every weather FX
        // (particles, tint, lightning, local ambience) at once. These are DISCRETE
        // GM toggles: SNAP the environment (set _envFirst so applyEnvironment paints
        // without the 2s fade). The slow fade is for gradual time-of-day / weather
        // drift; on a button press it only collides with the running clock's
        // per-second ticks restarting the fade — which made the toggle creep / stall
        // / "not revert". Snapping makes the toggle instant and deterministic.
        const fdm = changes?.flags?.[SYSTEM_ID];
        if (fdm && ("weatherMode" in fdm || "-=weatherMode" in fdm
            || "disableTimeDarkness" in fdm || "-=disableTimeDarkness" in fdm)) {
            _envFirst = true;
            tick();
            return;
        }
        const envReset = ("environment" in changes)
            || ("backgroundColor" in changes)
            || (changes.fog?.colors != null);
        if (!envReset) return;
        queueMicrotask(reapplyEnvNow);
    });
    Hooks.on("closeSceneConfig", (app) => {
        // The scene config previews environment edits live, then on close calls
        // canvas.environment.initialize() (#resetScenePreview) — wiping our LOCAL
        // tint + darkness even on a no-op "edit → save" that changed nothing. That
        // is a direct call, not a doc change, so the updateScene hook never sees it.
        // This hook fires synchronously AFTER #resetScenePreview, so re-applying now
        // lands in the same frame as the wipe (the wiped state never paints).
        if (app?.document !== canvas?.scene) return;
        reapplyEnvNow();
    });
    /* Viewer-token position / control changes cross region boundaries,
     * which affects region-scoped overrides (wdmWeatherAudio, and the
     * viewer-side suppress-weather lightning gate). Re-tick so lightning
     * / audio pick up the new region membership without waiting for the
     * next world-time increment. */
    Hooks.on("controlToken", scheduleTick);
    Hooks.on("updateToken",  scheduleTick);
    Hooks.on("updateUser",   (u) => { if (u.id === game.user.id) scheduleTick(); });

    Hooks.on("updateSetting", (setting) => {
        const k = setting?.key ?? "";
        if (k === `${SYSTEM_ID}.weatherMaxParticles`) {
            invalidateWeatherEffects();   // render-cost knob: force a rebuild
            tick();
        } else if (k === `${SYSTEM_ID}.weatherBiome`
            || k === `${SYSTEM_ID}.manualWeather`
            || k === `${SYSTEM_ID}.weatherSeeds`
            || k === `${SYSTEM_ID}.autoSceneDarkness`
            || k === `${SYSTEM_ID}.autoWeatherFx`
            || k === `${SYSTEM_ID}.weatherThunder`
            || k === `${SYSTEM_ID}.weatherSound`) {
            tick();
        }
    });
    tick();
}

export const sceneFxApi = Object.freeze({
    timeDarkness,
    timeDarknessNow,
    weatherDarkBump,
    darknessForTime,
    cloudTint
});
