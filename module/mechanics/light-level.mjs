/**
 * Per-token light level — the positional half of the environment penalties
 * (Foundry v14).
 *
 * The weather engine tags a day's CONDITIONS (fog / rain / snow …); this module
 * answers a different, purely SPATIAL question: how much light is actually
 * falling on a given tile right now? That is read straight off Foundry's live
 * lighting — ambient global illumination, scene `AmbientLight` objects, and any
 * token-emitted light — NOT off the weather exposure model. A character standing
 * in a torch's bright ring is in Bright Light even in a storm; a character in an
 * unlit corner of a moonless night is in Pitch Black even indoors.
 *
 * Five tiers, brightest → darkest:
 *   BRIGHT   — inside a light source's BRIGHT radius (scene or token light), or a
 *              lightning flash. Purely "lit = spottable"; carries NO self-penalty
 *              (glare/snow-blindness is a separate WEATHER-track effect).
 *   DAYLIGHT — globally lit at a low darkness level. No penalty.
 *   DIM      — inside a light source's DIM ring, or ambiently lit at a mid
 *              darkness level (moonlight). −2 Awareness.
 *   DARKNESS — globally lit but at maximum darkness (a dark night you can still
 *              make out): −4 Awareness, −2 Attack/Defense. This is the
 *              `sceneAmbientlyLit()`-true case at high darkness.
 *   PITCH    — NOT ambiently lit (global illumination off) and no local light:
 *              sight-based checks are impossible (blinded) unless the viewer has
 *              Dark Vision (a Foundry sight range) or stands in a light.
 *
 * DARKNESS vs PITCH is the same darkness value (≈1); what differs is whether
 * global illumination is still active — exactly the split `sceneAmbientlyLit()`
 * already encodes, so this module reuses it rather than re-deriving.
 *
 * Consumers (wired in later phases): the weather modifier readout, active
 * Awareness/Attack/Defense rolls (penalty from the roller's own tile), and
 * stealth detection (penalty from the SNEAKER's tile, negated by the SPOTTER's
 * vision — see stealth-hooks). Vision toggles that waive a tier (Dim Light
 * Vision → DIM; Dark Vision → DARKNESS/PITCH) live on the race item and are
 * resolved by the actor helper, not here — this module reports the RAW tier.
 */

import { sceneAmbientlyLit } from "./stealth-hooks.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
/* Per-scene GM light-tier pin (theater-of-the-mind). Flag value is a LIGHT_TIERS
 * key, or "" / unset for Auto. Must match the flag the scene-config picker writes
 * (scene-weather-mode.mjs). */
const LIGHT_OVERRIDE_FLAG = "lightOverride";

export const LIGHT_TIERS = Object.freeze({
    BRIGHT:   "bright",
    DAYLIGHT: "daylight",
    DIM1:     "dim1",       // Dim Light −1  (3/4 circle) — a light's dim ring / faint gloom
    DIM2:     "dim2",       // Dim Light −2  (2/4 circle) — moonlit
    DIM3:     "dim3",       // Dim Light −3  (1/4 circle) — deep gloom
    DARKNESS: "darkness",   // (empty circle)
    PITCH:    "pitch"       // (empty circle + cross) — global illumination off
});

/* Brightness ordering, so when several light contributions overlap a tile the
 * BRIGHTEST wins (a torch's bright/dim ring beats the darker ambient around it). */
export const LIGHT_TIER_RANK = Object.freeze({
    bright: 6, daylight: 5, dim1: 4, dim2: 3, dim3: 2, darkness: 1, pitch: 0
});

/* Ambient darkness thresholds (only when `sceneAmbientlyLit()`), graded into the
 * dim ladder: < DAY daylight, then Dim −1 / −2 / −3 as it darkens, then Darkness.
 * Tuned so a full-moon night (~0.70) lands at Dim −2 and a new-moon night (~1.0)
 * at Darkness. PITCH is not a threshold — it's global illumination being OFF. */
const AMBIENT_DAY_AT  = 0.30;
const AMBIENT_DIM1_AT = 0.50;
const AMBIENT_DIM2_AT = 0.75;
const AMBIENT_DIM3_AT = 0.90;

/* Self-penalty each tier applies to the token IN it. BRIGHT/DAYLIGHT are free.
 * The three dim steps grade −1/−2/−3; DARKNESS −4 (+ combat); PITCH is a step
 * worse still (effectively blind) and is labelled "Pitch Black". */
export const LIGHT_TIER_PENALTY = Object.freeze({
    bright:   {},
    daylight: {},
    dim1:     { awareness: -1 },
    dim2:     { awareness: -2 },
    dim3:     { awareness: -3 },
    darkness: { awareness: -4, attack: -2, defense: -2 },
    pitch:    { awareness: -6, attack: -3, defense: -3 }
});

/* i18n label keys per tier. The three dim steps share the "Dim Light" name — the
 * penalty (and the badge fullness) distinguishes them. */
export const LIGHT_TIER_LABEL = Object.freeze({
    bright:   "WITCHER.Light.Tier.Bright",
    daylight: "WITCHER.Light.Tier.Daylight",
    dim1:     "WITCHER.Light.Tier.Dim",
    dim2:     "WITCHER.Light.Tier.Dim",
    dim3:     "WITCHER.Light.Tier.Dim",
    darkness: "WITCHER.Light.Tier.Darkness",
    pitch:    "WITCHER.Light.Tier.Pitch"
});

/* Font Awesome (free) glyph per tier, for the weather-menu indicator. */
export const LIGHT_TIER_ICON = Object.freeze({
    bright:   "fa-sun",
    daylight: "fa-sun",
    dim1:     "fa-cloud-moon",
    dim2:     "fa-cloud-moon",
    dim3:     "fa-cloud-moon",
    darkness: "fa-moon",
    pitch:    "fa-eye-slash"
});

/* Circle "fullness" for the on-token badge: 4 = full (bright), 3/2/1 = the three
 * dim steps, 0 = empty (darkness), -1 = empty-with-cross (pitch black). */
export const LIGHT_TIER_FULLNESS = Object.freeze({
    bright: 4, daylight: 4, dim1: 3, dim2: 2, dim3: 1, darkness: 0, pitch: -1
});

/**
 * A GM-pinned scene light tier (theater-of-the-mind), or null for Auto. When set
 * it OVERRIDES all canvas / time / weather / local-light sampling — the whole
 * scene reads as this tier, ABSOLUTELY (no token torches punch through; those
 * scenes have no light objects anyway). Vision waivers still apply downstream
 * (a Dark-Vision token waives a pinned Darkness), and weather penalties stay
 * gated separately by Indoors / suppress-weather regions.
 * @returns {string|null}  a LIGHT_TIERS value, or null when Auto.
 */
export function sceneLightOverride() {
    let t = null;
    try { t = canvas?.scene?.getFlag?.(SYSTEM_ID, LIGHT_OVERRIDE_FLAG); } catch (_) { return null; }
    return (t && LIGHT_TIER_PENALTY[t]) ? t : null;
}

/* Scene px per distance unit (metre), for converting a light's grid-unit
 * bright/dim radii to the pixel distances tokens live in. */
function pxPerUnit() {
    const dim = canvas?.dimensions;
    if (!dim) return null;
    return (dim.size || 100) / (dim.distance || 1);
}

/* A token's centre as a Foundry ElevatedPoint {x,y,elevation}, from the
 * COMMITTED document position (not the mid-animation visual position — matches
 * how the stealth math samples). Null when uncomputable. */
function tokenPoint(token) {
    const d = token?.document ?? token;   // accept a placeable Token or a TokenDocument
    if (!d || !Number.isFinite(Number(d.x))) return null;
    const gs = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
    const w = Number(d.width)  || 1;
    const h = Number(d.height) || 1;
    const x = Number(d.x), y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: x + (w * gs) / 2, y: y + (h * gs) / 2, elevation: Number(d.elevation) || 0 };
}

/* Brightness shaping (all tunable). Every light's contribution scales with its
 * LUMINOSITY (Foundry's per-light strength): 0 = no emission (Foundry's neutral
 * point — below it a light turns into darkness), the 0.5 default = full, saturating
 * at 1. So a luminosity-0 light adds NOTHING (the scene stays as dark as it was), a
 * half-strength light reads dimmer, and a normal light is full. DIM_CAP holds even
 * the best dim below the bright threshold so a dim ring never reads as bright. */
const DIM_CAP = 0.72;
const lumMul = (lum) => Math.min(1, Math.max(0, (Number(lum ?? 0.5)) * 2));

/* Illumination a single POINT receives from the best covering light source, in
 * [0,1]: luminosity inside a bright radius, DIM_CAP·falloff·luminosity inside a dim
 * radius, 0 outside — so both radii honour the light's luminosity. Covers scene
 * AmbientLights AND token-emitted light (both in `lightSources`); global
 * illumination is the ambient path, so it's skipped. `data.bright`/`data.dim` are
 * PIXELS (config × distancePixels), so distances compare in raw pixels — no grid
 * conversion. */
function pointIllumination(point) {
    const sources = canvas?.effects?.lightSources;
    if (!sources) return 0;
    const Global = foundry?.canvas?.sources?.GlobalLightSource;
    let best = 0;
    for (const src of sources) {
        if (!src?.active || (Global && src instanceof Global)) continue;
        if (src.isDarkness || src.data?.negative) continue;   // darkness emitters darken, not brighten — handled via the ambient darkness at the point
        let inside = false;
        try { inside = !!src.testPoint?.(point); } catch (_) { inside = false; }
        if (!inside) continue;
        const ox = Number(src.x ?? src.data?.x), oy = Number(src.y ?? src.data?.y);
        if (!Number.isFinite(ox) || !Number.isFinite(oy)) continue;
        const brightPx = Number(src.data?.bright) || 0;
        const dimPx = Math.max(Number(src.data?.dim) || 0, brightPx);
        const dist = Math.hypot(point.x - ox, point.y - oy);
        const lum = lumMul(src.data?.luminosity);   // this light's strength, [0,1]
        let I;
        if (dist <= brightPx) I = lum;               // bright radius, scaled by luminosity — a weak light doesn't read as full Bright
        else if (dimPx > brightPx) {
            const falloff = 1 - (dist - brightPx) / (dimPx - brightPx);   // 1 (bright edge) → 0 (dim edge)
            I = DIM_CAP * falloff * lum;
        } else I = 0;
        if (I > best) best = I;
    }
    return best;
}

/* Illumination [0,1] → a tier. Bright only from a bright radius (I≈1). The dim
 * band is graded −1/−2/−3 by illumination; below the floor there's effectively no
 * usable local light (→ fall through to the ambient darkness tier). */
function tierFromIllum(I) {
    if (I >= 0.85) return LIGHT_TIERS.BRIGHT;
    if (I >= 0.50) return LIGHT_TIERS.DIM1;
    if (I >= 0.25) return LIGHT_TIERS.DIM2;
    if (I >= 0.06) return LIGHT_TIERS.DIM3;
    return null;
}

/* The LOCAL light tier over a token's FOOTPRINT: samples the centre + four edge
 * midpoints and averages the illumination (so a token straddling the dim edge —
 * partly in the dark — reads dimmer than one fully bathed = coverage), then maps
 * to a tier. Null when no local light reaches the footprint. */
function footprintLocalTier(token, center) {
    const gs = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
    const d = token?.document ?? token;
    const halfW = ((Number(d?.width)  || 1) * gs) / 2;
    const halfH = ((Number(d?.height) || 1) * gs) / 2;
    const e = center.elevation;
    const s = 0.7;   // sample just inside the edge, not the exact corner
    const pts = [
        center,
        { x: center.x + halfW * s, y: center.y, elevation: e },
        { x: center.x - halfW * s, y: center.y, elevation: e },
        { x: center.x, y: center.y + halfH * s, elevation: e },
        { x: center.x, y: center.y - halfH * s, elevation: e }
    ];
    let sum = 0;
    for (const p of pts) sum += pointIllumination(p);
    return tierFromIllum(sum / pts.length);
}

/* Classify a darkness level [0,1] into an ambient tier, given whether the scene
 * is globally lit (global illumination off → PITCH regardless of the number).
 * This is the TOKEN-VISION classifier: global-off means "can't see the map without
 * your own light", so it's PITCH at any darkness. */
function ambientTierForDarkness(dark) {
    if (!sceneAmbientlyLit()) return LIGHT_TIERS.PITCH;
    if (dark < AMBIENT_DAY_AT)  return LIGHT_TIERS.DAYLIGHT;
    if (dark < AMBIENT_DIM1_AT) return LIGHT_TIERS.DIM1;
    if (dark < AMBIENT_DIM2_AT) return LIGHT_TIERS.DIM2;
    if (dark < AMBIENT_DIM3_AT) return LIGHT_TIERS.DIM3;
    return LIGHT_TIERS.DARKNESS;
}

/* The scene-BRIGHTNESS floor from the darkness level alone — how bright the
 * ENVIRONMENT is, which the scene's own darkness setting dictates directly. Unlike
 * ambientTierForDarkness (token vision), a low darkness reads bright even with
 * global illumination off: a darkness-0 map lit only by placed light objects is a
 * BRIGHT scene, not pitch. Global-off only bites at the darkest end (a moonless,
 * unlit night → PITCH). Used as the floor for the scene-wide measured readout. */
function sceneBrightnessFloor(dark) {
    if (dark < AMBIENT_DAY_AT)  return LIGHT_TIERS.DAYLIGHT;
    if (dark < AMBIENT_DIM1_AT) return LIGHT_TIERS.DIM1;
    if (dark < AMBIENT_DIM2_AT) return LIGHT_TIERS.DIM2;
    if (dark < AMBIENT_DIM3_AT) return LIGHT_TIERS.DIM3;
    return sceneAmbientlyLit() ? LIGHT_TIERS.DARKNESS : LIGHT_TIERS.PITCH;
}

/* The ambient (global-illumination) tier at a point, or PITCH when global
 * illumination is off there. Only meaningful when the scene is globally lit;
 * graded by the LOCAL (region-aware) darkness level. */
function ambientTierAt(point) {
    let dark = canvas?.environment?.darknessLevel ?? 0;
    try {
        const local = canvas?.effects?.getDarknessLevel?.(point);
        if (Number.isFinite(local)) dark = local;
    } catch (_) { /* fall back to scene-global darkness */ }
    return ambientTierForDarkness(dark);
}

/* Placed-light COVERAGE of the play area, brightness-WEIGHTED: the mean
 * illumination [0,1] over a grid sampling the non-padding scene rect, where each
 * sample is 1 in a bright radius, its graded value inside a dim ring (see
 * pointIllumination), and 0 unlit. So a map painted with BRIGHT light scores far
 * higher than the same map painted with DIM light, and unlit gaps drag the mean
 * down — bright vs dim genuinely counts, not just "lit or not". Ambient global
 * illumination is NOT counted here (it's the darkness baseline in
 * ambientLightLevel) — this measures only what the placed lights paint. Sampled
 * on a bounded grid (≤ ~400 points). Null before the canvas is ready. Only ever
 * called when the scene has no tokens, so the sampling cost never lands in a
 * per-frame / per-roll path. */
export function sceneLightCoverage() {
    const rect = canvas?.dimensions?.sceneRect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const COLS = 20;
    const cols = COLS;
    const rows = Math.max(1, Math.min(COLS, Math.round(COLS * rect.height / rect.width)));
    let sum = 0, total = 0;
    for (let r = 0; r < rows; r++) {
        const y = rect.y + (rect.height * (r + 0.5)) / rows;
        for (let c = 0; c < cols; c++) {
            const x = rect.x + (rect.width * (c + 0.5)) / cols;
            total++;
            sum += pointIllumination({ x, y, elevation: 0 });   // 1 bright · graded dim · 0 unlit
        }
    }
    return total ? sum / total : 0;
}

/* Map a LIGHT_TIER_RANK value (0..5) back to a tier key. The scene readout never
 * resolves to the per-token BRIGHT tier (rank 6) — being inside a bright radius is
 * a tile fact, not a whole-scene descriptor — so it tops out at Daylight. */
const RANK_TO_TIER = Object.freeze(["pitch", "darkness", "dim3", "dim2", "dim1", "daylight"]);

/* Cheap invalidation signature for the measured tier: scene id, global darkness,
 * and each active light's position / radii / luminosity / darkness flag. Folding
 * the lights is O(N) — no sampling, no testPoint — so it's cheap to check on every
 * request, and the ~600-sample scan below only re-runs when this string actually
 * changes. Light movement, darkness/time drift, add/remove, a luminosity tweak —
 * all change it; a bare frame refresh does not. */
function measuredSceneSig() {
    const scene = canvas?.scene?.id ?? "";
    const dark = Math.round((Number(canvas?.environment?.darknessLevel) || 0) * 100);
    const sources = canvas?.effects?.lightSources;
    const Global = foundry?.canvas?.sources?.GlobalLightSource;
    let lp = "";
    if (sources) {
        for (const src of sources) {
            if (!src?.active || (Global && src instanceof Global)) continue;
            const d = src.data ?? {};
            lp += `|${Math.round(src.x ?? d.x ?? 0)},${Math.round(src.y ?? d.y ?? 0)},${Math.round(d.bright || 0)},${Math.round(d.dim || 0)},${d.luminosity ?? ""},${(src.isDarkness || d.negative) ? "d" : ""}`;
        }
    }
    return `${scene}:${dark}${lp}`;
}

let _measuredSig = null;
let _measuredTier = null;

/* Cached front door for the measured scene tier: recomputes the expensive scan
 * ONLY when measuredSceneSig() changes, so repeated calls (widget re-renders on a
 * running clock, etc.) reuse the last result for free. Never sampled per frame. */
function measuredSceneTier() {
    const sig = measuredSceneSig();
    if (sig === _measuredSig) return _measuredTier;
    _measuredSig = sig;
    _measuredTier = computeMeasuredSceneTier();
    return _measuredTier;
}

/* The MEASURED scene light tier (no tokens): a COVERAGE-driven reading combined
 * with the scene's own darkness.
 *
 *  • Ambient FLOOR — the scene darkness sets a floor tier (median across the map,
 *    region-aware). A bright day floors at Daylight; a moonless unlit cave at Pitch.
 *  • Coverage LIFT — how much of the play area the placed lights actually paint
 *    lifts that floor, stepwise: ANY light pulls a pitch cave up to Darkness, ~40%
 *    coverage → Dim −3, over half → Dim −2, a well-lit room → Dim −1. The lift is
 *    CAPPED by the lights' own brightness — dim/torch light tops out at Dim −1 no
 *    matter how complete the coverage, while a mostly-BRIGHT wash can climb to
 *    Daylight.
 *  • Scene tier = the brighter of floor and lift.
 *
 * So a dark cave brightens a step at a time as torches are added but never past
 * Dim −1 on torchlight alone, while a genuinely bright scene stays bright. Null
 * before canvas ready. Runs only when the scene has no tokens, and only when the
 * lighting signature changed (see the cached measuredSceneTier wrapper), so the
 * ~600 samples never touch a per-frame / per-roll path. */
function computeMeasuredSceneTier() {
    const rect = canvas?.dimensions?.sceneRect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const globalDark = Number(canvas?.environment?.darknessLevel) || 0;
    const fx = canvas?.effects;
    const getDark = (typeof fx?.getDarknessLevel === "function") ? fx.getDarknessLevel.bind(fx) : null;
    const COLS = 24;
    const cols = COLS;
    const rows = Math.max(1, Math.min(COLS, Math.round(COLS * rect.height / rect.width)));
    let total = 0, litCount = 0, brightCount = 0, maxI = 0;
    const darks = [];
    for (let r = 0; r < rows; r++) {
        const y = rect.y + (rect.height * (r + 0.5)) / rows;
        for (let c = 0; c < cols; c++) {
            const x = rect.x + (rect.width * (c + 0.5)) / cols;
            const p = { x, y, elevation: 0 };
            total++;
            const I = pointIllumination(p);
            if (I > maxI) maxI = I;            // brightest the lights get anywhere
            if (I >= 0.85) brightCount++;      // inside a bright radius
            if (I >= 0.06) litCount++;         // inside any usable light (bright or dim)
            let d = globalDark;
            if (getDark) { try { const dl = getDark(p); if (Number.isFinite(dl)) d = dl; } catch (_) { /* keep global */ } }
            darks.push(d);
        }
    }
    if (!total) return null;

    // Floor: the scene's own darkness (median → region-aware, majority wins).
    darks.sort((a, b) => a - b);
    const m = darks.length >> 1;
    const medianDark = (darks.length & 1) ? darks[m] : (darks[m - 1] + darks[m]) / 2;
    const floorRank = LIGHT_TIER_RANK[sceneBrightnessFloor(medianDark)] ?? 0;

    // Ceiling: the brightest tier this scene's lights can justify. A mostly-BRIGHT
    // lit area reaches Lit; otherwise it's capped at Dim −1 — and lower still when
    // the lights' PEAK is faint, so a weak / low-luminosity wash tops out at Dim −2
    // or −3 (its peak tier) rather than Dim −1.
    const peakRank = LIGHT_TIER_RANK[tierFromIllum(maxI)] ?? 0;
    const litFrac = litCount / total;
    const ceilingRank = (litFrac > 0 && brightCount >= 0.5 * litCount)
        ? LIGHT_TIER_RANK.daylight
        : Math.min(LIGHT_TIER_RANK.dim1, peakRank);

    // Lift: coverage fraction scaled to the ceiling — ceil() so ANY coverage lifts a
    // pitch cave to at least Darkness, reaching the ceiling only near full coverage.
    const liftRank = litFrac <= 0 ? 0 : Math.min(ceilingRank, Math.ceil(litFrac * ceilingRank));

    return RANK_TO_TIER[Math.max(floorRank, liftRank)];
}

/**
 * The scene-AMBIENT light tier right now — NO single token, NO local tile: the
 * light "out here" for readouts/overviews (the GM weather panel). Null before the
 * canvas is ready.
 *
 * Order: a GM override pins it absolutely. Otherwise, with tokens present, the
 * scene-wide darkness level gives the tier (day / moonlight / darkness / pitch).
 * With NO tokens (theater-of-the-mind / empty map) the tier is MEASURED off the
 * map — overall darkness as the floor everywhere, placed lights lifting it where
 * they paint, averaged across the play area (see measuredSceneTier).
 * @returns {string|null}
 */
export function ambientLightLevel() {
    if (!canvas?.ready) return null;
    const ov = sceneLightOverride();
    if (ov) return ov;                         // pinned scene → that tier is the outside light
    if (!(canvas?.tokens?.placeables?.length)) {
        const t = measuredSceneTier();
        if (t) return t;
    }
    return ambientTierForDarkness(Number(canvas?.environment?.darknessLevel) || 0);
}

/**
 * Which path is producing the scene light reading right now, for display:
 *   "override" — a GM scene light-level pin is set (absolute),
 *   "token"    — tokens are on the scene, so the tier is read off the scene darkness,
 *   "totm"     — no tokens, so the tier is MEASURED off the map (theater of the mind).
 * Null before the canvas is ready. Mirrors the branch order in ambientLightLevel.
 * @returns {"override"|"token"|"totm"|null}
 */
export function ambientLightMode() {
    if (!canvas?.ready) return null;
    if (sceneLightOverride()) return "override";
    return (canvas?.tokens?.placeables?.length) ? "token" : "totm";
}

/* Per-token light-tier memo. lightLevelAt samples 5 points × every light source
 * (a testPoint each) — cheap alone, but the stealth cone-hash calls it once per
 * stealther on every dirty animation frame. A token that hasn't moved under
 * unchanged lighting can't have changed tier, so we cache it, keyed on a lighting
 * EPOCH (bumped by registerLightCache on any lighting/darkness/scene change) plus
 * the token's rounded position. Movement changes the key; a lighting change bumps
 * the epoch — so while ONE token moves, the other stealthers return instantly. */
let _lightEpoch = 0;

/** Wire the light-tier cache invalidation to Foundry's lighting hooks. Call once at
 *  setup. `lightingRefresh` is Foundry's catch-all "lighting changed" signal
 *  (lights moved / toggled / edited, darkness recomputed); the rest cover time and
 *  scene swaps that drive darkness without a light move. */
export function registerLightCache() {
    const bump = () => { _lightEpoch++; };
    Hooks.on("lightingRefresh", bump);
    Hooks.on("updateWorldTime", bump);
    Hooks.on("updateScene",     bump);
    Hooks.on("canvasReady",     bump);
}

/**
 * The RAW light tier at a token's tile (before any vision-toggle waiver).
 * Combines the local point-light tier with the ambient tier, brightest wins.
 * Memoized per token on (light epoch + rounded tile) — see _lightEpoch.
 * @param {Token|TokenDocument} token
 * @returns {string|null}  A LIGHT_TIERS value, or null if uncomputable (no
 *                         canvas / no position) so callers can skip cleanly.
 */
export function lightLevelAt(token) {
    const ov = sceneLightOverride();
    if (ov) return ov;                                 // pinned scene → absolute, ignore canvas/local lights
    const point = tokenPoint(token);
    if (!point) return null;

    // Memo: unchanged lighting (epoch) + unchanged tile can't change the tier.
    const key = `${_lightEpoch}:${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.elevation || 0)}`;
    const cached = token._wdmLightTier;
    if (cached && cached.key === key) return cached.tier;

    const ambient = ambientTierAt(point);              // never null (PITCH at worst)
    const local   = footprintLocalTier(token, point);   // graded bright/dim1..3, or null
    const tier = !local ? ambient
        : (LIGHT_TIER_RANK[local] >= LIGHT_TIER_RANK[ambient] ? local : ambient);

    token._wdmLightTier = { key, tier };
    return tier;
}

/** True when a token can't make sight-based checks from where it stands (PITCH,
 *  no local light). Callers gate darkvision separately (the actor helper). */
export function isBlindTier(tier) {
    return tier === LIGHT_TIERS.PITCH;
}

/**
 * Modifier records for a light tier, in the same {target,value,label,lightTier}
 * shape the weather modifier layer/readout consumes. Empty for BRIGHT/DAYLIGHT.
 * PITCH carries the steepest penalties and its own "Pitch Black" label. The
 * `lightTier` field carries the tier key so downstream vision-toggle waivers know
 * WHICH capability cancels it.
 * @param {string} tier  A LIGHT_TIERS value.
 * @returns {Array<{target,value,label,source,lightTier}>}
 */
/* GM-editable per-tier penalties: the `lightPenaltiesOverride` world setting when
 * set, else the LIGHT_TIER_PENALTY seed above. Read at call time (settings aren't
 * registered at import); each tier falls back to the seed individually. Edited via
 * the Weather & Calendar config → Light tab. */
export function getActiveLightPenalties() {
    let ov = null;
    try { ov = game.settings?.get?.(SYSTEM_ID, "lightPenaltiesOverride"); } catch (_) { /* not registered */ }
    if (!ov || typeof ov !== "object" || !Object.keys(ov).length) return LIGHT_TIER_PENALTY;
    const out = {};
    for (const tier of Object.keys(LIGHT_TIER_PENALTY)) {
        out[tier] = (ov[tier] && typeof ov[tier] === "object") ? ov[tier] : LIGHT_TIER_PENALTY[tier];
    }
    return out;
}

export function lightTierRecords(tier) {
    const pen = getActiveLightPenalties()[tier];
    if (!pen) return [];
    const label = LIGHT_TIER_LABEL[tier] ?? "";
    const out = [];
    for (const target of ["awareness", "attack", "defense"]) {
        const value = Number(pen[target]) || 0;
        if (value) out.push({ target, value, label, source: "light", lightTier: tier });
    }
    return out;
}

/* ─────────── viewer vision capabilities (race night-vision tier) ────────────
 * A character's night vision is a CUMULATIVE tier (race item `nightVision`):
 * 0 none, 1 Night Vision (Dim), 2 Improved Night Vision (Darkness), 3 Dark
 * Vision (Pitch Black). Each rank waives its light tier and every lighter one.
 * The character takes the BEST tier among owned race items. This is what WAIVES
 * a light penalty — for stealth the waiver is the SPOTTER's vision against the
 * SNEAKER's tier; for a self-roll it's the roller's own. */

const VISION_RANK = Object.freeze({ "": 0, night: 1, improved: 2, dark: 3 });

/* Vision-granting AE `vision` actions currently APPLYING to the actor. Each is
 * {type:"vision", visionType, visionRange?, visionMode?}. Read alongside race items
 * so an effect (potion, mutation, spell) can grant vision too. */
function effectVisionActions(actor) {
    const effects = actor?.appliedEffects ?? actor?.effects ?? null;
    if (!effects) return [];
    const out = [];
    for (const e of effects) {
        if (e?.disabled || e?.isSuppressed) continue;
        const actions = e?.flags?.["witcher-ttrpg-death-march"]?.actions;
        if (!Array.isArray(actions)) continue;
        for (const a of actions) if (a?.type === "vision") out.push(a);
    }
    return out;
}

/** The actor's night-vision rank (0–3), the best across owned race items AND any
 *  active `vision` effect actions. */
export function visionRank(actor) {
    let best = 0;
    for (const it of (actor?.items ?? [])) {
        if (it?.type !== "race") continue;
        const r = VISION_RANK[it.system?.nightVision] ?? 0;
        if (r > best) best = r;
    }
    for (const a of effectVisionActions(actor)) {
        const r = VISION_RANK[a.visionType] ?? 0;
        if (r > best) best = r;
    }
    return best;
}

/** True when the actor has Dark Vision (rank 3) — sees in Pitch Black. Should
 *  pair with a Foundry token sight range (what the stealth vision cones read). */
export function hasDarkVision(actor) {
    return visionRank(actor) >= 3;
}

/** How far (scene distance units) the actor sees in the dark — the largest
 *  `darkVisionRange` among owned race items that grant Dark Vision. 0 = leave the
 *  token's own sight range alone. */
export function darkVisionRange(actor) {
    let best = 0;
    for (const it of (actor?.items ?? [])) {
        if (it?.type !== "race" || it.system?.nightVision !== "dark") continue;
        const r = Number(it.system?.darkVisionRange) || 0;
        if (r > best) best = r;
    }
    for (const a of effectVisionActions(actor)) {
        if (a.visionType !== "dark") continue;
        const r = Number(a.visionRange) || 0;
        if (r > best) best = r;
    }
    return best;
}

/* Foundry vision modes offered for Dark Vision (race sheet + AE editor). All three
 * reveal darkness within sight range; they differ only in the visual filter. */
export const DARK_VISION_MODES = Object.freeze([
    { value: "monochromatic",      labelKey: "WITCHER.Vision.Mode.Monochromatic",      hintKey: "WITCHER.Vision.Mode.MonochromaticHint" },
    { value: "darkvision",         labelKey: "WITCHER.Vision.Mode.Darkvision",         hintKey: "WITCHER.Vision.Mode.DarkvisionHint" },
    { value: "lightAmplification", labelKey: "WITCHER.Vision.Mode.LightAmplification", hintKey: "WITCHER.Vision.Mode.LightAmplificationHint" }
]);
const DARK_VISION_MODE_VALUES = DARK_VISION_MODES.map(m => m.value);

/** The Foundry vision mode a Dark Vision actor's token should use — from the first
 *  owned race item that grants Dark Vision. Falls back to "monochromatic". */
export function darkVisionMode(actor) {
    for (const it of (actor?.items ?? [])) {
        if (it?.type !== "race" || it.system?.nightVision !== "dark") continue;
        const m = it.system?.darkVisionMode;
        if (DARK_VISION_MODE_VALUES.includes(m)) return m;
    }
    for (const a of effectVisionActions(actor)) {
        if (a.visionType === "dark" && DARK_VISION_MODE_VALUES.includes(a.visionMode)) return a.visionMode;
    }
    return "monochromatic";
}

/**
 * Does `actor`'s night vision waive the penalty for a given light tier? Ranks
 * are cumulative — Improved Night Vision (Darkness) also covers Dim; Dark Vision
 * covers everything. BRIGHT/DAYLIGHT have nothing to waive.
 * @param {string} tier   A LIGHT_TIERS value.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function lightTierWaivedFor(tier, actor) {
    const rank = visionRank(actor);
    if (tier === LIGHT_TIERS.DIM1 || tier === LIGHT_TIERS.DIM2 || tier === LIGHT_TIERS.DIM3) return rank >= 1;
    if (tier === LIGHT_TIERS.DARKNESS) return rank >= 2;
    if (tier === LIGHT_TIERS.PITCH)    return rank >= 3;
    return false;
}

export const lightLevelApi = Object.freeze({
    LIGHT_TIERS,
    LIGHT_TIER_RANK,
    LIGHT_TIER_PENALTY,
    getActiveLightPenalties,
    LIGHT_TIER_LABEL,
    lightLevelAt,
    ambientLightLevel,
    ambientLightMode,
    sceneLightCoverage,
    isBlindTier,
    lightTierRecords,
    visionRank,
    hasDarkVision,
    lightTierWaivedFor
});
