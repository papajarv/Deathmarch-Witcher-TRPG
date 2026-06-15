/**
 * Native weather-effects adapter — the bridge between the live weather tags and
 * Foundry's built-in weather layer (`canvas.weather`).
 *
 * Instead of a custom PIXI renderer, this composes a Foundry
 * WeatherAmbienceConfiguration (the same shape as the entries in
 * `CONFIG.weatherEffects`: rain / snow / fog) from the death-march weather tags
 * and hands it to `canvas.weather.initializeEffects(config)`. Foundry owns the
 * shaders, particle generators, occlusion masking and the per-frame ticker.
 *
 * Runs on EVERY client (it's a local visual; no scene-document writes), so all
 * players see the weather the GM has set. Idempotent and signature-guarded.
 *
 * What the native layer can express (and what it can't):
 *   precip → RainShader (+ FogShader haze when storming, like Foundry's rainStorm)
 *   snow   → SnowShader (+ FogShader when blizzard, like Foundry's blizzard)
 *   fog    → FogShader
 *   hail   → a white particle generator (no native hail shader)
 *   wind   → tilts rain rotation / snow direction; no standalone wind visual
 *   cloud  → NO weather-layer effect: cloudy/overcast gloom is entirely the
 *            scene environment tint (scene-fx), since a SCREEN-blend haze can
 *            only brighten. A clear sky still gets a faint warm wash here.
 *   lightning → not a weather-layer effect; a separate full-screen flash overlay
 *            (lightning-fx.mjs) handles it, driven off the same tags
 *
 * Native shader effects size to the inner sceneRect; we stretch them to the full
 * padded canvas (see coverFullCanvas) because these overlay environment art.
 */

import { getActiveWeather } from "./manual-weather.mjs";
import { suppressWeatherVisuals } from "./scene-weather-mode.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function settingOn(key) {
    try { return !!game.settings.get(SYSTEM_ID, key); } catch (_) { return false; }
}

/* Client particle budget → a 0.25–2× multiplier on generator counts. */
function particleScale() {
    let budget = 2000;
    try { budget = Number(game.settings.get(SYSTEM_ID, "weatherMaxParticles")) || 2000; } catch (_) {}
    return clamp(budget / 2000, 0.25, 2);
}

/* The Foundry weather shader namespace (always available, canvas or not). */
const shaders = () => foundry.canvas.rendering.shaders;

/* ── tag → effect builders ──────────────────────────────────────────────────
 * Each returns 0+ WeatherEffectConfiguration entries to push onto the layer.
 * Tints/blend/config values are taken from Foundry's own presets and scaled by
 * intensity so heavier weather reads as heavier. */

/* Rain. Wind leans the streaks; a storm adds a moving fog haze underneath. */
function rainEffects(precip, storm, wind) {
    const S = shaders();
    const rotation = clamp(0.18 + wind * 0.10, 0.18, 0.62); // radians, leans with wind
    const tier = { 1: { opacity: 0.18, intensity: 0.7, strength: 0.7, speed: 0.18 },
                   2: { opacity: 0.30, intensity: 1.0, strength: 1.0, speed: 0.22 },
                   3: { opacity: 0.45, intensity: 1.5, strength: 1.5, speed: 0.30 } }[precip];
    const out = [{
        id: "wdmRain",
        effectClass: S.WeatherShaderEffect,
        shaderClass: S.RainShader,
        blendMode: PIXI.BLEND_MODES.SCREEN,
        config: { tint: [0.7, 0.9, 1.0], rotation, ...tier }
    }];
    if (storm) {
        out.unshift({
            id: "wdmRainHaze",
            effectClass: S.WeatherShaderEffect,
            shaderClass: S.FogShader,
            blendMode: PIXI.BLEND_MODES.SCREEN,
            performanceLevel: 2,
            config: { slope: 1.5, intensity: 0.05, speed: -55.0, scale: 25 }
        });
    }
    return out;
}

/* Snow. Wind steers the drift; a storm (blizzard) adds driving fog. Flake COUNT
 * is the intensity lever: SnowShader samples flakes per integer cell of (uv *
 * scale), so a bigger `scale` packs in MANY small flakes and a small `scale`
 * leaves a FEW big, sparse ones — that's how flurries → heavy read as more and
 * more snow. (Don't bother with `alpha`: base-weather.mjs clobbers the shader's
 * alpha uniform with the mesh worldAlpha every frame, so a config alpha is a
 * no-op.) `speed` sets the fall rate on top of that. */
function snowEffects(snow, storm, wind) {
    const S = shaders();
    // SnowShader shears each layer by 1.2·(rand − direction): at direction 0.5 the
    // shears cancel (flakes fall straight), and only values WELL above 0.5 lean
    // every layer the same way into a visible wind slant. The old 0.4–0.76 range
    // barely cleared that vertical pivot, so snow never showed wind. Ramp from a
    // ~vertical calm to a gale lean that matches the rain streaks per tier.
    const direction = clamp(0.55 + wind * 0.14, 0.5, 1.0);
    if (storm) {
        return [
            { id: "wdmSnow", effectClass: S.WeatherShaderEffect, shaderClass: S.SnowShader,
              blendMode: PIXI.BLEND_MODES.SCREEN,
              config: { tint: [0.95, 1, 1], direction: clamp(direction + 0.1, 0.5, 1.15), speed: 8, scale: 4.2 } },
            { id: "wdmSnowHaze", effectClass: S.WeatherShaderEffect, shaderClass: S.FogShader,
              blendMode: PIXI.BLEND_MODES.SCREEN, performanceLevel: 2,
              config: { slope: 1.0, intensity: 0.15, speed: -4.0 } }
        ];
    }
    const tier = { 1: { speed: 1.0, scale: 1.2 },    // flurries — few big lazy flakes
                   2: { speed: 2.0, scale: 2.4 },    // snowfall — moderate
                   3: { speed: 3.2, scale: 3.8 } }[snow]; // heavy — dense fine flakes
    return [{
        id: "wdmSnow",
        effectClass: S.WeatherShaderEffect,
        shaderClass: S.SnowShader,
        blendMode: PIXI.BLEND_MODES.SCREEN,
        config: { tint: [0.85, 0.95, 1], direction, ...tier }
    }];
}

/* Fog, three densities scaled off Foundry's default fog preset. */
function fogEffects(fog) {
    const S = shaders();
    const tier = { 1: { slope: 0.35, intensity: 0.20, speed: 0.3 },
                   2: { slope: 0.45, intensity: 0.40, speed: 0.4 },
                   3: { slope: 0.60, intensity: 0.70, speed: 0.5 } }[fog];
    return [{
        id: "wdmFog",
        effectClass: S.WeatherShaderEffect,
        shaderClass: S.FogShader,
        blendMode: PIXI.BLEND_MODES.SCREEN,
        config: tier
    }];
}

/* Hail — no native shader, so a fast white particle fall (snow.png beads).
 * Wind shears the fall angle off vertical.
 *
 * Ambient generators respawn particles at a uniform random spot in the budget
 * rect (particle-generator.mjs ambientRect). A particle that respawns INSIDE the
 * visible view starts at age 0 and visibly pops in; only ones that respawn in the
 * off-screen PADDING get a randomized age and read as already-falling. So the way
 * to avoid popping — especially under wind, which makes particles cross (and thus
 * respawn) faster, and would otherwise leave a bare triangle on the upwind edge —
 * is to give the generator a real off-screen intake zone:
 *   - `bounds` gains an off-screen intake margin (see intakeBounds), but biased to
 *     the TOP (where falling hail enters) and the SIDES (for wind drift) — NOT a
 *     fat symmetric margin below, which is wasted area that just dilutes the
 *     visible density (adjustedMax = count × paddedView / bounds).
 *   - `viewPadding` defines how big that margin reads as a fraction of the view.
 * Density is then tuned via `count`. */
const HAIL_VIEW_PAD = 0.4;
function hailEffects(precip, storm, wind) {
    const heavy = storm || precip >= 3;
    const count = Math.round((heavy ? 1200 : 800) * particleScale());
    const tilt = wind * 5;                       // degrees off vertical
    const speed = heavy ? [1650, 2100] : [1350, 1750];
    return [{
        id: "wdmHail",
        particles: [{
            textures: ["ui/particles/snow.png"],
            count,
            bounds: intakeBounds({ top: 0.6, bottom: 0.1, side: 0.15 + wind * 0.04 }),
            lifetime: 2200,
            viewPadding: HAIL_VIEW_PAD,
            velocity: { speed, angle: [90 - tilt - 4, 90 - tilt + 4] },
            rotation: { speed: [0, 0] },
            alpha: [0.75, 0.95],
            scale: heavy ? [0.10, 0.20] : [0.08, 0.16],
            fade: { in: 0.12, out: 0.18 }
        }]
    }];
}

/**
 * Compose a native Foundry weather config from death-march weather tags, or
 * null when nothing should render.
 */
export function buildWeatherConfig(tags) {
    const t = tags ?? {};
    const precip = Number(t.precip) || 0;
    const snow   = Number(t.snow)   || 0;
    const wind   = Number(t.wind)   || 0;
    const fog    = Number(t.fog)    || 0;
    const storm  = !!t.storm;
    const hail   = !!t.hail;

    const effects = [];

    // Sky cover draws NO weather-layer effect at all. Clear / cloudy / overcast
    // mood is entirely the scene environment tint (darkness / luminosity /
    // saturation / hue) in scene-fx — a SCREEN-blend fog haze can only brighten
    // and just reads as a weird drifting cloud overlay on the art.

    // Precipitation is mutually exclusive in look: snow → hail → rain.
    if (snow >= 1)      effects.push(...snowEffects(snow, storm, wind));
    else if (hail)      effects.push(...hailEffects(precip, storm, wind));
    else if (precip >= 1) effects.push(...rainEffects(precip, storm, wind));

    if (fog >= 1) effects.push(...fogEffects(fog));

    if (!effects.length) return null;
    return { id: "wdmWeather", label: "WITCHER.Weather.Clear", filter: { enabled: false }, effects };
}

/* ── reconciler ─────────────────────────────────────────────────────────────*/

let _sig = "";

/* Only the tags that change the picture; temperature/label are irrelevant. */
function tagSignature(tags) {
    const t = tags ?? {};
    return [
        t.cloud || 0, t.precip || 0, t.snow || 0, t.wind || 0, t.fog || 0,
        t.storm ? 1 : 0, t.hail ? 1 : 0, t.lightning ? 1 : 0
    ].join(",") + ":" + particleScale();
}

/* Native shader effects size themselves to the inner sceneRect (effect.mjs),
 * which leaves the scene's padding uncovered. These overlays sit on environment
 * art, not battlemaps, so stretch every shader quad to the full padded canvas
 * (canvas.dimensions.rect) — otherwise fog/rain stop short of the left/edges. */
function coverFullCanvas() {
    const r = canvas?.dimensions?.rect;
    const WeatherShaderEffect = shaders()?.WeatherShaderEffect;
    if (!r || !WeatherShaderEffect || !canvas?.weather?.effects) return;
    for (const fx of canvas.weather.effects.values()) {
        if (!(fx instanceof WeatherShaderEffect)) continue;
        fx.position.set(r.x, r.y);
        fx.width = r.width;
        fx.height = r.height;
    }
}

/* A spawn-bounds rect for ambient particle generators: the full padded canvas
 * grown by a per-edge fraction of its size, so an off-screen intake zone exists
 * for aged spawns to fall in from (see hailEffects). Biased so callers can add a
 * big TOP margin (where falling particles enter) and SIDE margins (wind drift)
 * without wasting area below. Fractions are of canvas width (side) / height
 * (top, bottom). Null pre-canvas. */
function intakeBounds({ top = 0, bottom = 0, side = 0 } = {}) {
    const r = canvas?.dimensions?.rect;
    if (!r) return undefined;
    const t = r.height * top, b = r.height * bottom, s = r.width * side;
    return { x: r.x - s, y: r.y - t, width: r.width + s * 2, height: r.height + t + b };
}

/** Clear the native weather layer. Safe to call when idle. */
export function stopWeatherEffects() {
    _sig = "";
    _fadeGen++;                          // cancel any in-flight transition
    try { canvas?.weather?.clearEffects(); } catch (_) {}
    const c = canvas?.weather?.weatherEffects;
    if (c) c.alpha = 1;
}

/** Force the next sync to rebuild (e.g. after the particle-budget setting changes). */
export function invalidateWeatherEffects() {
    _sig = "";
}

/* ── transition fade ──────────────────────────────────────────────────────────
 * initializeEffects is a hard teardown/rebuild — an instant pop. To smooth it we
 * fade the persistent weatherEffects container out, swap configs, then fade in.
 * A generation token cancels a fade that a newer weather change has superseded so
 * rapid changes don't stack. */
let _fadeGen = 0;

function tweenAlpha(target, from, to, ms, gen) {
    return new Promise((resolve) => {
        if (!target) return resolve();
        const start = performance.now();
        target.alpha = from;
        const step = (now) => {
            if (gen !== _fadeGen || !target.parent) { return resolve(); }   // superseded / gone
            const k = Math.min(1, (now - start) / ms);
            target.alpha = from + (to - from) * k;
            if (k < 1) requestAnimationFrame(step);
            else resolve();
        };
        requestAnimationFrame(step);
    });
}

async function applyConfig(config) {
    const layer = canvas?.weather;
    if (!layer) return;
    const gen = ++_fadeGen;

    // Fade out whatever is currently showing.
    const cur = layer.weatherEffects;
    if (cur && layer.effects.size) await tweenAlpha(cur, cur.alpha ?? 1, 0, 500, gen);
    if (gen !== _fadeGen) return;        // a newer change took over mid fade-out

    layer.initializeEffects(config);
    coverFullCanvas();

    // Fade the new weather in (or leave the cleared container at full for next time).
    const next = layer.weatherEffects;
    if (next) {
        if (config) { next.alpha = 0; tweenAlpha(next, 0, 1, 900, gen); }
        else next.alpha = 1;
    }
}

/**
 * Reconcile the native weather layer with current weather + toggles. Cheap when
 * nothing changed; cross-fades when it does.
 */
export function syncWeatherEffects() {
    const on = settingOn("weatherEnabled") && settingOn("autoWeatherFx") && !!canvas?.ready && !!canvas?.weather
        && !suppressWeatherVisuals();   // indoor / off scenes draw no particles
    if (!on) { stopWeatherEffects(); return; }

    const tags = getActiveWeather().tags ?? {};
    const sig = tagSignature(tags);
    if (sig === _sig) return;
    _sig = sig;

    try { applyConfig(buildWeatherConfig(tags)); }
    catch (err) { console.warn("[wdm-weather] initializeEffects failed", err); }
}
