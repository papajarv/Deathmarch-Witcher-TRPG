/**
 * Stealth hooks — passive-DC detection model (BG3-style).
 *
 * GM-authoritative model:
 *   - `updateToken` fires on every client. Handler runs only on GM
 *     (`game.user.isActiveGM`); the GM has authority to write flags
 *     on any stealther, so no socket dance is needed.
 *
 * Detection model:
 *   - Stealther has ONE stored Stealth roll from enterStealth
 *     (`1d10 + DEX + Stealth rank + situational`). Doesn't reroll.
 *   - Each spotter has a Passive Perception DC (no die):
 *     `10 + INT + Awareness rank + Awareness modifier`.
 *   - Compare: `Passive + bandMod + zoneMod + coverageMod ≥ Stealth`
 *     → spotted. Otherwise hidden vs that spotter.
 *
 * Auto-spot conditions (no math regardless of Stealth):
 *   - Point Blank (≤ 1 m) — always
 *   - Close range + Focused zone + Full body exposure — the
 *     "standing naked in front of them" rule
 *
 * Trigger cadence:
 *   - Only re-check when the (band, zone, coverage) tuple for a
 *     given (stealther, spotter) pair CHANGES vs the last check.
 *     Walking within the same band/zone/coverage = no check spam.
 *   - Cache lives in `_pairState`. Cleared on stealth exit.
 *
 * Modifiers on Passive:
 *   - Band: PB=auto, Close +4, Medium +0, Long −2, Extreme −5
 *   - Zone: Focused 0, Near −2, Far −4
 *   - Coverage: Full 0, ¾ −1, ½ −2, ¼ −4 (or less)
 *   - Max sight distance = 20 m + spotter's (INT + Awareness rank).
 *
 * LOS check builds a sweep polygon from the spotter (walls + cone
 * angle + rotation + elevation), so cross-elevation vision works
 * when scene walls have vertical bounds set.
 */

import { getStealthState, isStealthed, writeStealthState, exposureKey } from "./stealth.mjs";
import { isDeadActor, isDeadToken } from "./deadState.mjs";
import { getTokenLevel, canLevelSee, buildSightPolygon,
         buildAngularConePolygon, externalRadiusOf } from "./stealth-los.mjs";
import { getStealthConfig } from "./stealth-config.mjs";
import { paceFromDistance, coneReachMetres, distanceModifier, coneBandFor,
         resolveStealthCheck, stealthCheckModifiers, PACE } from "./stealth-detection.mjs";
import { t, tFormat } from "../chrome/lib/i18n.js";
import { lightLevelAt, lightTierWaivedFor, LIGHT_TIERS,
         LIGHT_TIER_PENALTY, LIGHT_TIER_LABEL, ambientLightLevel,
         darkVisionRange } from "./light-level.mjs";
import { getEnvironmentalModifiersForActor } from "./weather-modifiers.mjs";
import { getActiveWeather } from "./manual-weather.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";


/* Angular zones within a spotter's vision, penalty applied to the
 * Awareness roll based on how close to the cone EDGE the stealther
 * sits (measured inward from the edge, not outward from center):
 *
 *   Focused        (interior, > 20° from edge)     →  0
 *   Near peripheral (10-20° from edge)              → -2
 *   Far peripheral  (outermost 10° at edge)         → -4
 *
 * Zones scale with the spotter's total vision: a 200° cone has an
 * enormous "focused" interior and a thin 20° peripheral rim on each
 * side. A narrow 40° cone is almost entirely peripheral.
 *
 * The switch from center-out to edge-in makes zones behave the same
 * regardless of total vision breadth — bull's-eye stays 0, edges
 * always penalize by the same amounts. Simple, no helmet-exemption
 * gymnastics needed. */
export const VISION_EDGE_DEG      = 10;    /* outermost 10° per side */
export const VISION_NEAR_EDGE_DEG = 20;    /* 10° + 10° per side (outer + near) */
/* Vision-zone modifiers now live in stealth config. These names kept
 * as re-exported getters for external consumers that already imported
 * them; the underlying value is a live read from `getStealthConfig()`. */

/* True vs. Allowed vision angles:
 *
 *   TRUE     = the creature's biological / natural field of view.
 *              Determines where the peripheral bands sit and what
 *              counts as a dead zone (past the true angle).
 *   ALLOWED  = what the creature can ACTUALLY see through
 *              equipment (helmet, blindfold, hood, tunnel-vision
 *              spell). A subset of TRUE — never wider.
 *
 * How it renders and rolls:
 *   - Visible cone = ALLOWED. Anything past allowed is invisible
 *     to the token (helmet blocks it).
 *   - Zone boundaries (focused / near / far) computed off TRUE.
 *     Then clipped to ALLOWED.
 *
 * Effect: a human (true 180°) in a helmet (allowed 90°) — the
 * helmet occludes 90° on each side of what the human could
 * normally see, but everything they CAN see is deep interior of
 * their true vision (no near / far peripheral penalties on it,
 * since the helmet cuts BEFORE the peripheral band starts).
 *
 * Config: `sight.angle` on the token doc = ALLOWED (unchanged
 * Foundry semantics). TRUE lives on a token flag:
 *     token.document.setFlag(SYSTEM_ID, "trueVisionAngle", 180);
 * Falls back to `sight.angle` when the flag is unset, so old
 * tokens behave as before. */
export const TRUE_ANGLE_FLAG    = "trueVisionAngle";
export const ALLOWED_ANGLE_FLAG = "allowedVisionAngle";

/** True (biological) vision angle. Reads `flags.trueVisionAngle`
 *  first; falls back to `sight.angle` when the flag is unset. Acts
 *  as a HARD CAP on rendered FOV — see the preUpdateToken hook in
 *  stealth-vision-config.mjs which computes
 *  `sight.angle = min(True, Allowed)` on every flag write. */
export function getTrueVisionAngle(spotterToken) {
    const doc = spotterToken?.document;
    if (!doc) return 360;

    /* Per-token override always wins — this is the explicit "I mean it" channel,
     * including for a genuine 360° watcher. */
    const flag = Number(doc.getFlag?.(SYSTEM_ID, TRUE_ANGLE_FLAG));
    if (Number.isFinite(flag) && flag > 0) return flag;

    const angle = Number(doc.sight?.angle);
    if (!Number.isFinite(angle) || angle <= 0) return fallbackVisionAngle();

    /* A bare 360 is ambiguous: it is BOTH Foundry's untouched default and a
     * legitimate choice for a creature that sees all round. Treating it as
     * "unset" stops every unconfigured token projecting a circle — which is not
     * a cone at all and floods the map — but it also overrode GMs who genuinely
     * wanted 360.
     *
     * `fullCircleIsUnset` picks which reading applies. Turn it off and a 360°
     * sight angle is honoured literally; leave it on and use the per-token True
     * Angle flag above for the handful of creatures that really do see behind
     * themselves. Any other value (359 included) is always taken literally. */
    if (angle === 360 && getStealthConfig().fullCircleIsUnset !== false) {
        return fallbackVisionAngle();
    }
    return angle;
}

/** Configured stand-in for an unset vision arc. */
function fallbackVisionAngle() {
    const fallback = Number(getStealthConfig().defaultVisionAngleDeg);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 360;
}

/** Allowed (equipment-limited) vision angle. Reads
 *  `flags.allowedVisionAngle`; falls back to True when unset (no
 *  equipment restriction). Also acts as a hard cap on rendered FOV
 *  via the same preUpdateToken hook. */
export function getAllowedVisionAngle(spotterToken) {
    const doc = spotterToken?.document;
    if (!doc) return 360;
    const flag = Number(doc.getFlag?.(SYSTEM_ID, ALLOWED_ANGLE_FLAG));
    if (Number.isFinite(flag) && flag > 0) return flag;
    return getTrueVisionAngle(spotterToken);
}


/* ─────────── helpers ─────────── */

/**
 * Is this token eligible to watch for sneaks at all?
 *
 * THE SINGLE SOURCE OF TRUTH, used by both `potentialSpottersFor` (which rolls
 * the checks) and `spottersForOverlay` (which draws the cones). They used to
 * keep separate copies of this list and had already drifted twice:
 *
 *   - FRIENDLY sat in the overlay's disposition set but not the mechanic's, so
 *     allies drew a cone that could never produce a check.
 *   - The dead filter here was `isDeadActor(t)` — a Token has no `.statuses`,
 *     so it never excluded anyone — against `isDeadActor(t.actor)` in the
 *     overlay, so corpses drew no cone yet still rolled.
 *
 * Both are the same failure: a cone that does not mean what it looks like. This
 * must stay the only place the answer is computed. The overlay may layer
 * PRESENTATION filters on top (currently-controlled, not visible,
 * already-spotted) — those decide what to DRAW, never who can detect.
 *
 * FRIENDLY is included deliberately: party allies do notice someone sneaking.
 */
export function isEligibleSpotterToken(token) {
    if (!token?.actor || token.destroyed) return false;
    /* The dead do not keep watch. `isDeadToken` takes the TOKEN — passing it to
     * `isDeadActor` reads `.statuses` off the placeable, which is undefined, and
     * silently answers "not dead" for everyone. */
    if (isDeadToken(token)) return false;
    /* `globalThis.CONST`, not bare `CONST`: optional chaining does NOT guard an
     * UNDECLARED identifier, so `CONST?.x` still throws ReferenceError outside
     * Foundry. Reading it off globalThis makes the fallbacks below actually
     * reachable — and makes this testable. */
    const D = globalThis.CONST?.TOKEN_DISPOSITIONS ?? {};
    const allowed = [D.HOSTILE ?? -1, D.NEUTRAL ?? 0, D.FRIENDLY ?? 1, D.SECRET ?? -2];
    if (!allowed.includes(Number(token.document?.disposition))) return false;
    /* No INT stat = not a perceiving creature (loot piles, barrels, vehicles). */
    const intVal = Number(token.actor.system?.stats?.int?.value);
    return Number.isFinite(intVal) && intVal > 0;
}

/** All potential spotter tokens for `stealtherToken` — every eligible watcher
 *  on the scene except the sneak themselves. */
function potentialSpottersFor(stealtherToken) {
    const tokens = canvas?.tokens?.placeables ?? [];
    const out = [];
    for (const t of tokens) {
        if (t.id === stealtherToken?.id) continue;
        if (!isEligibleSpotterToken(t)) continue;
        out.push(t);
    }
    return out;
}

/** Max sight distance in scene units (metres) for a spotter.
 *  `baseSightMetres` (GM-configurable, default 20) + spotter's INT +
 *  Awareness rank. Fallback to configured base if the actor has no
 *  int/awareness config. This is the value at which the "long" band
 *  tops out; the "extreme" band extends to `extremeFraction` × this. */
export function computeMaxSightMetres(spotterToken) {
    const base = Number(getStealthConfig().baseSightMetres) || 20;
    const actor = spotterToken?.actor;
    if (!actor) return base;
    const intVal   = Number(actor.system?.stats?.int?.value) || 0;
    const awareRank = Number(actor.system?.skills?.int?.awareness?.value) || 0;
    return base + intVal + awareRank;
}

/* Fallback darkness threshold — only used if the scene exposes no global-light
 * source to read the real activation range from. */
const DARK_THRESHOLD = 0.5;

/** True when the scene is ambiently lit right now — driven off the GM's OWN
 *  global-illumination settings, not a magic threshold: global illumination is
 *  enabled AND the live (weather-aware) darkness sits within its configured
 *  activation range (`globalLightSource.data.darkness = {min,max}`). Mirrors
 *  Foundry's own global-light test; falls back to DARK_THRESHOLD only if no
 *  global-light source is exposed. */
export function sceneAmbientlyLit() {
    const env = canvas?.environment;
    const gls = env?.globalLightSource;
    const dark = Number(env?.darknessLevel) || 0;
    if (!gls) return dark < DARK_THRESHOLD;
    if (!gls.active) return false;
    const range = gls.data?.darkness ?? {};
    const min = Number.isFinite(range.min) ? range.min : 0;
    const max = Number.isFinite(range.max) ? range.max : 0;
    return dark >= min && dark <= max;
}

/** Whether a spotter can perceive at all right now — the SHARED gate used by
 *  BOTH the spot-check dispatch (so a blind spotter never spots) and the vision-
 *  cone overlay (so it never draws a cone for one). Keyed on the token's Foundry
 *  SIGHT RANGE, matching how sight in darkness works: basic/darkvision sight both
 *  see UNLIT within range, so a configured range > 0 = "sees in the dark" (the
 *  darkvision setup) and range 0 = "blind in the dark". Blindness vision mode is
 *  an explicit no. A range-0 spotter still sees where it's LIT — resolved by
 *  Foundry's own `testInsideLight` (ambient global illumination within its
 *  darkness range, OR inside a point light, all on the LIVE weather-aware
 *  darkness). So in pure darkness with no light a range-0 spotter neither spots
 *  nor draws, while a ranged/darkvision spotter still does. Fails OPEN if the
 *  lighting API is unavailable so nothing silently breaks. */
export function spotterCanPerceive(spotter) {
    const sight = spotter?.document?.sight;
    const vm = sight?.visionMode;
    if (vm === "blindness") return false;
    if ((Number(sight?.range) || 0) > 0) return true;   // range-based dark sight
    if (vm && vm !== "basic") return true;              // explicit darkvision-class mode
    if (sceneAmbientlyLit()) return true;
    const c = spotter?.center;
    if (!c) return true;
    const fn = canvas?.effects?.testInsideLight;
    if (typeof fn !== "function") return true;
    try {
        return fn.call(canvas.effects, {
            x: c.x, y: c.y, elevation: Number(spotter.document?.elevation) || 0
        }) === true;
    } catch (_) {
        return true;
    }
}

/** Hard outer limit (in scene units / metres) on how far a token can SEE right
 *  now — the cap applied to both detection range and the drawn cone so neither
 *  exceeds real vision. In an ambiently-lit scene there's no darkness cap
 *  (Infinity — the mechanical range bands govern). In darkness a token sees only
 *  within its Foundry sight (darkvision) range, so that range is the cap; a
 *  token with no darkvision range isn't capped here (it's already gated by
 *  spotterCanPerceive to lit spots only). This is what makes a 30 m-darkvision
 *  spotter's cone reach exactly 30 m in the dark instead of its full mechanical
 *  sight, and clips the sneaker's own view to its darkvision bubble. */
export function visionRangeMetres(token) {
    if (sceneAmbientlyLit()) return Infinity;
    const range = Number(token?.document?.sight?.range) || 0;
    return range > 0 ? range : Infinity;
}

/** Distance between two tokens in scene units (metres), 2D only.
 *  Cross-elevation is intentionally measured on the XY plane —
 *  matches how sight range is typically configured. */
function distanceMetres(a, b, aPositionOverride = null) {
    const gridDim = canvas?.dimensions;
    if (!gridDim) return Infinity;
    const pxPerUnit = (gridDim.size || 100) / (gridDim.distance || 1);
    const ca = _centerFromOverride(a, aPositionOverride) ?? documentCenter(a);
    const cb = documentCenter(b);
    const dx = ca.x - cb.x;
    const dy = ca.y - cb.y;
    return Math.hypot(dx, dy) / pxPerUnit;
}

/**
 * Radius of the token's drawn silhouette, in metres.
 *
 * `distanceMetres` is centre-to-centre, which makes every range test a test on
 * a single point. That is wrong at a cone's edge: a token can be visibly half
 * inside the wash while its centre sits outside `D`, and the tick would skip it
 * and DECAY the exposure it should have been gaining. "Half my token was in the
 * cone and it wasn't firing" is exactly that.
 *
 * 0.9 × the half-minimum dimension matches the silhouette the overlay cuts out
 * of the cone mask, so the shape the player sees overlapping the wash is the
 * shape the mechanic tests. Returns 0 with no canvas, degrading to the old
 * centre-point behaviour rather than throwing.
 */
function tokenRadiusMetres(token) {
    const gridDim = canvas?.dimensions;
    if (!gridDim) return 0;
    const pxPerUnit = (gridDim.size || 100) / (gridDim.distance || 1);
    if (!pxPerUnit) return 0;
    const w = Number(token?.w) || 0;
    const h = Number(token?.h) || 0;
    if (!w || !h) return 0;
    return (Math.min(w, h) / 2 * 0.9) / pxPerUnit;
}

/** Convert a `{x, y}` override (raw document-space top-left coords)
 *  into a token CENTER point. Callers pass the fresh position they
 *  got from `updateToken`'s changes payload; we still need to add
 *  the token's half-width/half-height to reach its center. */
function _centerFromOverride(token, override) {
    if (!override) return null;
    const gs = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
    const d = token?.document;
    const w = Number(d?.width)  || 1;
    const h = Number(d?.height) || 1;
    return {
        x: Number(override.x) + (w * gs) / 2,
        y: Number(override.y) + (h * gs) / 2
    };
}

/** Center point of a token computed from its DOCUMENT position
 *  (not the animated visual position). Spot-check math must use
 *  this — `token.center` reads the placeable's live `token.x`
 *  which is mid-animation, so band / zone / coverage would race
 *  the animation and produce checks against a position the token
 *  visually hasn't reached (or has already left) yet. Document
 *  position is the committed final destination. */
function documentCenter(token) {
    const gs = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
    const d = token?.document;
    if (!d) return { x: 0, y: 0 };
    const w = Number(d.width)  || 1;
    const h = Number(d.height) || 1;
    return {
        x: (Number(d.x) || 0) + (w * gs) / 2,
        y: (Number(d.y) || 0) + (h * gs) / 2
    };
}

/** Given the spotter's TRUE angle (biological) and ALLOWED angle
 *  (equipment-limited), return the effective zone boundaries used
 *  for both zone rendering and target classification.
 *
 *   focusedAngle = min(allowed, true - 40)    — bright interior
 *   nearAngle    = min(allowed, true - 20)    — near-peripheral cap
 *   totalAngle   = allowed                     — full visible cone
 *
 *  The `min(allowed, ...)` clip is what makes helmets sensible:
 *  when `allowed < true - 40`, the focused zone equals the entire
 *  allowed cone — everything visible through the helmet reads as
 *  focused because the helmet cuts off before the peripheral band
 *  even starts.
 *
 *  All clamped ≥ 0. Very narrow vision collapses focused / near to
 *  zero and treats everything as far peripheral. */
export function computeZoneAngles(spotterToken) {
    const trueAngle    = getTrueVisionAngle(spotterToken);
    const allowedAngle = getAllowedVisionAngle(spotterToken);
    const focusedFromTrue = Math.max(0, trueAngle - VISION_NEAR_EDGE_DEG * 2);
    const nearFromTrue    = Math.max(0, trueAngle - VISION_EDGE_DEG      * 2);
    return {
        focusedAngle: Math.min(allowedAngle, focusedFromTrue),
        nearAngle:    Math.min(allowedAngle, nearFromTrue),
        totalAngle:   allowedAngle
    };
}

/** Classify the target's angular position relative to the spotter's
 *  facing. Returns one of "focused" / "near" / "far" with its
 *  Awareness modifier and a chip label key. Never returns null —
 *  every target that passes `isInLOS` sits in exactly one zone.
 *
 *  Tests innermost (focused) first, then near-peripheral, else far
 *  peripheral. Uses `ClockwiseSweepPolygon` at the spotter's own
 *  rotation to leverage Foundry's rotation convention (avoids
 *  bearing-math bugs). */
/**
 * Does this polygon touch ANY part of the token, rather than just its centre?
 *
 * Zone wedges are nested and carry DIFFERENT reach multipliers (focused 1.0,
 * near 0.7, far 0.4), so the drawn cone visibly STEPS at each angular boundary.
 * Classifying from the centre alone put a token straddling that step into the
 * shorter zone while half of it stood inside the longer wedge — visibly inside
 * the cone, mechanically out of range, no check, nothing in the log. That is
 * the same centre-versus-silhouette mistake as the radial gate, on the angular
 * axis.
 *
 * Probes the centre plus 8 points around the silhouette. The token counts as
 * being in a zone if ANY probe lands inside, which makes the mechanic agree
 * with the union of wedges the player is actually looking at.
 */
function polyTouchesToken(poly, token, centre) {
    if (!poly?.contains) return false;
    if (poly.contains(centre.x, centre.y)) return true;
    const gridDim = canvas?.dimensions;
    if (!gridDim) return false;
    const w = Number(token?.w) || 0;
    const h = Number(token?.h) || 0;
    if (!w || !h) return false;
    const r = Math.min(w, h) / 2 * 0.9;      /* the drawn silhouette, as elsewhere */
    for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8;
        if (poly.contains(centre.x + Math.cos(a) * r, centre.y + Math.sin(a) * r)) return true;
    }
    return false;
}

export function classifyVisionZone(stealtherToken, spotterToken) {
    /* Zone mods pulled from the LIVE config so the GM's edits in the
     * Vision Zone Modifiers panel actually reach detection. Previous
     * code used the module-level `VISION_*_MOD` constants which were
     * frozen at load time — the settings panel had no effect at all. */
    /* Only `key` survives. These carried a `mod` (an additive per-zone penalty
     * read from `focusedMod`/`nearMod`/`farMod`) and a `labelKey`, both from the
     * retired model. The config keys had already gone, so the mods were a
     * constant 0, and BOTH call sites take `?.key` and nothing else — so the
     * whole thing was three config reads per watcher per tick to build fields
     * no one consumed. Zone now affects reach through `zoneMults`, not an
     * additive modifier. */
    const focused = { key: "focused" };
    const near    = { key: "near"    };
    const far     = { key: "far"     };

    const doc = spotterToken?.document;
    if (!doc) return far;
    const { focusedAngle, nearAngle, totalAngle } = computeZoneAngles(spotterToken);
    if (totalAngle <= 0) return far;

    const gridDim = canvas?.dimensions;
    if (!gridDim) return far;
    const pxPerUnit = (gridDim.size || 100) / (gridDim.distance || 1);
    /* Radius for the zone wedges. Classification is PURELY ANGULAR (see below),
     * so this must be large enough never to be the deciding factor. It used to
     * be `computeMaxSightMetres * 2` ≈ 60 m: a sneak further out than that fell
     * outside every wedge and was silently classified `far`, which multiplies
     * the reach by 0.4 and could put them outside their own cone. Scene diagonal
     * removes the radius from the decision entirely. */
    const extremePx = Number(gridDim.maxR)
                   || Math.hypot(Number(gridDim.sceneWidth) || 0, Number(gridDim.sceneHeight) || 0)
                   || (computeMaxSightMetres(spotterToken) * 4 * pxPerUnit);

    const origin = documentCenter(spotterToken);
    const target = documentCenter(stealtherToken);
    const rotation = Number(doc.rotation) || 0;
    /* Zone classification only cares about angular position
     * relative to the spotter's facing. LOS + level filtering is
     * handled by `computeCoverageFraction`'s sight polygon at the
     * coverage stage; here we just need to know which cone slice
     * the target sits in. */

    try {
        /* Zone classification is PURELY angular — we only care where
         * the target sits within the cone's angular width (focused
         * interior, near peripheral, or outer edge). LOS gating is
         * `computeCoverageFraction`'s job at the coverage stage; if
         * we got here, LOS is already confirmed clear.
         *
         * Use `buildAngularConePolygon` (Foundry's LimitedAngle
         * primitive — pure geometric cone, no wall filtering) rather
         * than a full sweep. This avoids the "wrong-level walls
         * misclassify the target's angular zone" bug that hits both
         * same-level (canvas.level != spotter.level → wrong-level
         * walls) and cross-level (spotter-level walls clip a target
         * on another floor) cases in one shot. */
        const spotterOrigin = { x: origin.x, y: origin.y };

        /* Focused zone check — only meaningful when interior exists
         * (total > 40°). */
        if (focusedAngle > 0) {
            const focusedPoly = buildAngularConePolygon(spotterOrigin,
                { angle: focusedAngle, rotation, radius: extremePx });
            if (polyTouchesToken(focusedPoly, stealtherToken, target)) return focused;
        }

        /* Near-peripheral check — only meaningful when total > 20°. */
        if (nearAngle > 0) {
            const nearPoly = buildAngularConePolygon(spotterOrigin,
                { angle: nearAngle, rotation, radius: extremePx });
            if (polyTouchesToken(nearPoly, stealtherToken, target)) return near;
        }

        /* Fell through both interior checks → target sits in the
         * outermost 10°. */
        return far;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | zone classification failed`, err);
        return far;
    }
}

/** Coverage-based visibility: what fraction of the stealther's body
 *  is inside the spotter's sweep polygon? Returns 0.0 – 1.0.
 *
 *   0    — nothing visible (behind wall, past extreme range, or
 *          fully outside cone)
 *   1/9  – 8/9 — partial coverage (only some of the token is in
 *                LOS; peeking around a wall corner, or clipping
 *                the cone edge)
 *   1    — fully visible
 *
 *  Sampling: 3×3 grid over the token's bounding box (9 points).
 *  Choose 9 (not 4 corners) because a token's mid-edges can be
 *  behind a wall corner while the corners themselves are visible,
 *  or vice versa. 9 gives a coarse but stable coverage estimate
 *  cheap enough to run per movement dispatch.
 *
 *  Uses ONE ClockwiseSweepPolygon built at the spotter's own scene
 *  Level — Foundry's own sight primitive. The level scoping means
 *  walls filter correctly per-floor: only walls on the spotter's
 *  level (plus universal walls with an empty `wall.levels` set) can
 *  block. Cross-level pairs are gated by `level.visibility.levels`
 *  before we even build the polygon — if the spotter's level can't
 *  see the stealther's level, coverage is 0 regardless of geometry. */
/**
 * The part of a token's own silhouette that is not cut off from its centre by a
 * wall — a tiny wall-aware sweep from the token's middle, out to its own bbox
 * diagonal.
 *
 * Coverage probes the sneak's silhouette across 29 points. When a wall runs
 * THROUGH the sneak's square — standing in a doorway, or hard against a wall
 * that bisects the tile — roughly half those probes land on the far side of it.
 * Those points really are inside the watcher's sight polygon, so coverage came
 * back non-zero and the watcher "saw" the half of the sneak that was through a
 * CLOSED DOOR.
 *
 * Filtering probes through this polygon keeps only the ones on the sneak's own
 * side of the wall. Built once per sneak per tick and reused across every
 * watcher, since it depends only on the sneak's position.
 *
 * Returns null when it cannot be built, in which case callers skip the filter
 * (fail open — better a slightly generous probe set than no detection at all).
 */
export function bodyPolygonFor(token) {
    const level = getTokenLevel(token);
    if (!level || !token?.center) return null;
    const halfW = (Number(token.w) || 0) / 2;
    const halfH = (Number(token.h) || 0) / 2;
    if (!halfW || !halfH) return null;
    /* bbox DIAGONAL, not the inscribed radius: probes sit out at the ellipse
     * boundary, and clipping them by radius here would silently shrink coverage
     * for every token. Walls do the cutting; this radius must not. */
    const radius = Math.hypot(halfW, halfH) + 2;
    return buildSightPolygon(
        { x: token.center.x, y: token.center.y,
          elevation: Number(token.document?.elevation) || 0 },
        level,
        { angle: 360, rotation: 0, radius, externalRadius: 0 });
}

/* 7 evenly-spaced offsets in [-1, +1], endpoints INCLUDED so the grid touches
 * the inscribed ellipse at the four cardinal axes. Module scope because both
 * `bodyProbesFor` and `computeCoverageFraction` sample with it. */
const SAMPLE_OFFSETS = [-1, -2/3, -1/3, 0, 1/3, 2/3, 1];

/**
 * The sneak's coverage probe points, already filtered to their own side of any
 * wall crossing their tile.
 *
 * Both the ellipse sampling and the body-polygon filter depend ONLY on the
 * sneak, so recomputing them per watcher was pure duplication — 29 polygon
 * containment tests repeated for every watcher on the scene, each time
 * producing the identical answer. Computed once per sneak per tick and reused.
 *
 * The returned length IS the denominator: probes the sneak's own body cannot
 * reach are never in the list, so coverage reads as "how much of ME is visible"
 * rather than "how much of my bounding ellipse".
 */
export function bodyProbesFor(token, positionOverride = null) {
    const centre = _centerFromOverride(token, positionOverride) ?? documentCenter(token);
    if (!centre) return [];
    const halfW = Math.max(1, (Number(token?.w) || 0) / 2);
    const halfH = Math.max(1, (Number(token?.h) || 0) / 2);
    const bodyPoly = bodyPolygonFor(token);
    const out = [];
    for (const ox of SAMPLE_OFFSETS) {
        for (const oy of SAMPLE_OFFSETS) {
            if (ox * ox + oy * oy > 1.0000001) continue;
            const x = centre.x + ox * halfW;
            const y = centre.y + oy * halfH;
            if (bodyPoly && !bodyPoly.contains(x, y)) continue;
            out.push({ x, y });
        }
    }
    return out;
}

export function computeCoverageFraction(stealtherToken, spotterToken, stealtherPositionOverride = null,
                                        { maxRangePx = Infinity, zones = null,
                                          probes = null } = {}) {
    const doc = spotterToken?.document;
    if (!doc) return 0;

    const gridDim = canvas?.dimensions;
    if (!gridDim) return 0;
    const pxPerUnit = (gridDim.size || 100) / (gridDim.distance || 1);
    /* Radius for the sight sweep — deliberately the scene diagonal, not any
     * sight-range figure.
     *
     * `coverFraction` answers ONE question: how much of the sneak sits inside
     * the watcher's arc and clear of walls. RANGE is decided separately, by
     * `dEdge <= D` against `coneReachMetres`. When this function imposed its own
     * cap (`computeMaxSightMetres * 2`, i.e. base 20 + INT + Awareness, doubled)
     * the two disagreed — that figure has nothing to do with the cone reach. A
     * sneak past roughly 60 m could sit inside the drawn cone, pass the distance
     * gate, and still come back with coverFraction 0 and no check. A silent
     * second range cap reads exactly like "detection is broken", with nothing
     * in the console to say so. */
    const sweepRadiusPx = Number(gridDim.maxR)
                       || Math.hypot(Number(gridDim.sceneWidth) || 0,
                                     Number(gridDim.sceneHeight) || 0)
                       || (computeMaxSightMetres(spotterToken) * 4 * pxPerUnit);

    const origin = documentCenter(spotterToken);
    /* Use the caller-supplied stealther position when provided (the
     * fresh committed destination from the updateToken hook's
     * `changes` payload). Falls back to reading the live document,
     * which in Foundry V14 movement can lag one tick behind the
     * commit — making the fallback path test against the position
     * the token JUST LEFT rather than where they went. Explicit
     * override eliminates that timing window. */
    /* Cross-level visibility gate. If the spotter's level cannot
     * see the stealther's level (per Foundry's `level.visibility.
     * levels` config), no LOS is possible regardless of geometry.
     * Same-level pairs pass trivially. Also gate on the GM's
     * `crossLevelDetection` config toggle — when off, all
     * cross-level pairs report zero coverage regardless of Foundry's
     * cross-level visibility. Useful when the GM wants strict per-
     * floor detection without touching wall/level assignments. */
    const cfg = getStealthConfig();
    const spotterLevel   = getTokenLevel(spotterToken);
    const stealtherLevel = getTokenLevel(stealtherToken);
    if (spotterLevel && stealtherLevel && spotterLevel.id !== stealtherLevel.id) {
        if (!cfg.crossLevelDetection) return 0;
    }
    if (!canLevelSee(spotterLevel, stealtherLevel)) return 0;

    /* Choice of sight polygon depends on same-level vs cross-level:
     *
     *  SAME-LEVEL — full wall-aware sweep at the spotter's level.
     *    Walls at that level physically clip the spotter's LOS to
     *    the target. Windows / doors / LIMITED walls / PROXIMITY
     *    thresholds all resolved by Foundry's ClockwiseSweepPolygon.
     *
     *  CROSS-LEVEL — pure angular cone, NO wall filtering.
     *    Foundry walls are 2D infinite-height barriers. A ground-
     *    floor wall between the spotter's XY and a roof-target's
     *    XY would clip a spotter-level sweep even though the
     *    spotter can physically look over the wall to see the
     *    target above. Cross-level visibility is already gated by
     *    `canLevelSee` above (Foundry's `level.visibility.levels`);
     *    once granted, the target level is treated as fully exposed
     *    and only the angular cone + range apply. Same semantic as
     *    Foundry's "reveal-raised-areas" region behavior. */
    const coneAngle    = getAllowedVisionAngle(spotterToken);
    const facingRotDeg = Number(doc.rotation) || 0;
    /* WALLS APPLY CROSS-LEVEL TOO.
     *
     * This used to drop wall filtering entirely for cross-level pairs, on the
     * reasoning that a ground-floor wall should not clip a spotter looking up at
     * a roof target. But Foundry's sweep is already level-aware: it queries only
     * the edges registered to the SPOTTER's level plus universal walls. Those
     * are the walls standing around the spotter at their own eye level, and they
     * block the view outward whether the target is above, below, or alongside.
     *
     * Skipping them produced a watcher on a second floor who saw straight
     * THROUGH the exterior wall across their whole arc, instead of only through
     * the window they were standing at. The overlay meanwhile draws the cone
     * with exactly this wall-aware sweep, so the wash was correct and the
     * detection was not — a sneak well outside the visible cone still got rolled
     * against.
     *
     * Using the same sweep for both removes the divergence: what is drawn is
     * what is tested. The residual limitation is Foundry's own — walls are 2D
     * and infinite-height, so a low parapet a spotter could physically see over
     * still blocks. That is a map-authoring concern (a wall with no level
     * assignment, or a lower sight-blocking setting), not something detection
     * can infer. `crossLevelDetection` still gates the pairing itself. */
    const sightPoly = buildSightPolygon(
        { x: origin.x, y: origin.y, elevation: Number(doc.elevation) || 0 },
        spotterLevel,
        { angle: coneAngle, rotation: facingRotDeg, radius: sweepRadiusPx,
          externalRadius: externalRadiusOf(spotterToken) });
    if (!sightPoly) return 0;

    /* Per-zone reach wedges — the REAL shape of the detection volume.
     *
     * The cone is not one wedge at one radius. It is three nested wedges whose
     * reaches differ by `zoneMults` (focused 1.0, near 0.7, far 0.4), so the
     * boundary STEPS inward as you move off the watcher's centre line. Measuring
     * coverage against a single wedge at the focused reach meant a sneak sitting
     * across that step — half inside the long focused wedge, half in peripheral
     * space the cone does not actually reach — came back fully covered and drew
     * no cover penalty at all. That is why the edge of the OUTER arc behaved
     * correctly (there the boundary really is a plain radial arc, which one
     * wedge models fine) while the focused↔peripheral transition did not.
     *
     * A probe now counts only if it is clear of walls AND inside at least one
     * zone wedge at that zone's own reach — the same union the overlay draws. */
    let zonePolys = null;
    if (Array.isArray(zones) && zones.length) {
        zonePolys = [];
        for (const z of zones) {
            const zAngle  = Number(z?.angleDeg);
            const zRadius = Number(z?.radiusPx);
            if (!(zAngle > 0) || !(zRadius > 0)) continue;
            const zp = buildAngularConePolygon({ x: origin.x, y: origin.y },
                { angle: zAngle, rotation: facingRotDeg, radius: zRadius });
            if (zp?.contains) zonePolys.push(zp);
        }
        if (!zonePolys.length) zonePolys = null;
    }

    /* 7×7 grid CLIPPED TO THE INSCRIBED ELLIPSE — 29 sample points
     * in the token's actual visible shape.
     *
     * A Foundry token's bounding box is a square (or rectangle for
     * multi-square tokens), but the visible token silhouette is an
     * ellipse/circle inscribed inside that bbox. If we sample the
     * full bbox including its corners, a cone that grazes the
     * bbox corner (nowhere near the actual token graphic) still
     * lands hits and inflates coverage — that's the bug where a
     * token visually a QUARTER-exposed comes back as HALF because
     * the bbox corner samples land inside the cone.
     *
     * Filter: keep only sample points where (dx/halfW)² +
     * (dy/halfH)² ≤ 1 — i.e., inside the ellipse inscribed in the
     * bbox. Square tokens → circle filter. Non-square (2×1, 1×2)
     * tokens → correctly-proportioned ellipse. Center point always
     * survives (0 ≤ 1), so single-square tokens with tiny grid
     * dimensions still get at least one probe. The denominator
     * counts only surviving samples, so quarter/half/etc. fractions
     * remain calibrated against the visible token area, not the
     * bbox area. */
    /* Probe set: precomputed by the caller when available (it depends only on
     * the sneak, so the tick builds it ONCE and shares it across every watcher
     * instead of repeating 29 body-polygon containment tests per pair). The
     * inline path is the fallback for callers that have no memo. */
    const pts = probes ?? bodyProbesFor(stealtherToken, stealtherPositionOverride);
    let hits = 0;
    const denom = pts.length;
    for (let i = 0; i < denom; i++) {
        const px = pts[i].x;
        const py = pts[i].y;
        if (!sightPoly.contains(px, py)) continue;      /* walls / arc */
        if (zonePolys) {
            /* inside ANY zone wedge, at that zone's own reach */
            let inAny = false;
            for (const zp of zonePolys) {
                if (zp.contains(px, py)) { inAny = true; break; }
            }
            if (!inAny) continue;
        } else if (Math.hypot(px - origin.x, py - origin.y) > maxRangePx) {
            continue;
        }
        hits++;
    }
    if (denom === 0) return 0;
    return hits / denom;
}

/** GM user id list — recipients for whispered spot-check chat. */
function gmUserIds() {
    return (game.users?.filter?.(u => u.isGM)?.map(u => u.id)) ?? [];
}

/** User IDs that OWN the given actor at OWNER permission. Used as
 *  additional whisper recipients on spot events so the stealther's
 *  player is told when they've been seen, without leaking spot-check
 *  chat to unrelated players. */
function actorOwnerUserIds(actor) {
    if (!actor) return [];
    const out = [];
    for (const user of (game.users?.values?.() ?? [])) {
        if (user?.isGM) continue;    /* GMs already covered by gmUserIds() */
        if (actor.testUserPermission?.(user, "OWNER")) out.push(user.id);
    }
    return out;
}

/** Passive Perception DC for a spotter. `10 + INT + Awareness rank
 *  + Awareness modifier`. Reads the actor's prepared skill total
 *  when available (folds in status penalties like Blinded); falls
 *  back to raw stat + rank when the skill entry hasn't been
 *  prepared yet. */
export function computePassivePerception(spotterToken) {
    const actor = spotterToken?.actor;
    if (!actor) return 10;
    const skill = actor.system?.skills?.int?.awareness ?? {};
    const stat  = Number(actor.system?.stats?.int?.value) || 0;
    const rank  = Number(skill.value)    || 0;
    const mod   = Number(skill.modifier) || 0;
    const total = Number.isFinite(Number(skill.total))
        ? Number(skill.total)
        : stat + rank + mod;
    return 10 + total;
}

/* Per-(stealther, spotter) state cache. Key = stealther tokenId,
 * value = Map<spotter actor uuid, { band, zone, coverage }>.
 * Purpose: only re-evaluate a pair when its situational tuple
 * CHANGED vs the last check. Walking around inside the same band /
 * zone / coverage = no re-check spam.
 *
 * Cleared entirely for a stealther on stealth exit; individual
 * spotter entries cleared when the spotter enters spottedBy (no
 * further checks needed against them). */
const _pairState = new Map();


/* Stealth reroll removed — stored roll from enterStealth is
 * authoritative for the whole session. Passive model uses this
 * single value against every spotter's Passive Perception DC.
 * Running penalty is deferred to entry-time or scene narration
 * (a running character can choose to re-enter stealth with a
 * situational −5, or the GM adjudicates). */

/* ─────────── spot check ─────────── */

/* ═══════════════════════════════════════════════════════════════════════
 * EXPOSURE MODEL  (detectionModel: "exposure")
 *
 * Detection distance per pair, exposure accrued per tick. See
 * stealth-detection.mjs for the model itself; this section only gathers the
 * facts it needs from the canvas and applies the results.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Hard ceiling on D. Infinity in daylight; at night the spotter's own
 *  configured sight range, or the configured night ceiling when the token
 *  leaves it at 0 (the common case). Without this a sneak standing in bright
 *  torchlight at night is detectable from the full base distance, and the
 *  model contradicts Foundry's own vision range. */
export function sightCeilingFor(spotterToken) {
    if (sceneAmbientlyLit()) return Infinity;
    const range = Number(spotterToken?.document?.sight?.range) || 0;
    if (range > 0) return range;
    return Number(getStealthConfig().nightCeilingMetres) || 40;
}

/** Metres between two pixel-space points. */
function metresBetweenPx(a, b) {
    if (!a || !b) return 0;
    const dim = canvas?.dimensions;
    if (!dim) return 0;
    const pxPerUnit = (dim.size || 100) / (dim.distance || 1);
    return Math.hypot((a.x - b.x), (a.y - b.y)) / (pxPerUnit || 1);
}

/* NOTE: `rankToTier()` lived here, inverting LIGHT_TIER_RANK so a waived tier
 * could be stepped ONE rank brighter. That approach is gone — night vision
 * waives a tier outright rather than softening it — and the helper had no other
 * caller. It was also the source of a temporal-dead-zone crash when first
 * written at module scope (see gotchas in the spec). */


/**
 * Resolve the light at a tile into the awareness penalty the detection model
 * wants, applying the watcher's night vision.
 *
 * `lightTierWaivedFor` already encodes the ladder the system defines
 * (`visionRank`: 0 none · 1 Night Vision · 2 Improved Night Vision · 3 Dark
 * Vision), and WAIVED means exactly that — the tier costs this watcher nothing:
 *
 *   Night Vision           → normal reach through all three Dim tiers
 *   Improved Night Vision  → normal reach through Dim AND Darkness
 *   Dark Vision            → the above, plus sight in pitch black
 *
 * This used to step the tier ONE RANK brighter instead of waiving it, so a
 * character with Night Vision still had their reach multiplied down in dim
 * light — the ability did a fraction of what it says on the sheet.
 *
 * PITCH is the exception and stays unwaived here on purpose. Sight in true
 * darkness is limited by `darkVisionRange`, and `coneReachMetres` applies that
 * as a floor; zeroing the penalty instead would grant FULL daylight reach in
 * pitch black, which no range value could then rein back in.
 */
export function resolveLightPenalty(tier, spotterActor) {
    if (!tier) return { penalty: 0, pitch: false };
    if (tier === LIGHT_TIERS.PITCH) return { penalty: 0, pitch: true };
    if (spotterActor && lightTierWaivedFor(tier, spotterActor)) {
        return { penalty: 0, pitch: false };
    }
    return { penalty: Math.abs(Number(LIGHT_TIER_PENALTY[tier]?.awareness) || 0), pitch: false };
}

/** The SPOTTER's weather awareness penalty as a positive magnitude. Excludes
 *  the "light" source, which the sneak-tile light term already accounts for —
 *  same split `spotEnvModifier` uses, so the two models agree. */
/* Measured at 2.03 ms per call in a live world — roughly the ENTIRE per-pair
 * tick cost, and ~70x everything else in `gatherDetectionFacts` combined. The
 * work is `getActiveWeatherModifiers`, which rebuilds the modifier table, plus
 * a shelter/region containment test.
 *
 * The answer cannot change between watchers within one tick and rarely changes
 * between ticks, so it is cached per ACTOR (shelter and region membership are
 * per-actor, so the cache cannot be scene-wide) behind a TTL longer than the
 * 3 s tick. Explicitly cleared on the hooks that can change the answer, so the
 * TTL is only a backstop, not the correctness mechanism. */
const _weatherPenaltyCache = new Map();
const WEATHER_CACHE_TTL_MS = 4000;

export function invalidateWeatherPenaltyCache() { _weatherPenaltyCache.clear(); }

export function weatherPenaltyFor(spotterToken) {
    const key = spotterToken?.actor?.id;
    if (key) {
        const hit = _weatherPenaltyCache.get(key);
        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        if (hit && (now - hit.at) < WEATHER_CACHE_TTL_MS) return hit.value;
    }
    const value = _computeWeatherPenaltyFor(spotterToken);
    if (key) {
        _weatherPenaltyCache.set(key, {
            value, at: (typeof performance !== "undefined" ? performance.now() : Date.now())
        });
    }
    return value;
}

function _computeWeatherPenaltyFor(spotterToken) {
    try {
        const total = getEnvironmentalModifiersForActor(spotterToken?.actor, "awareness")
            .filter(r => r.source !== "light")
            .reduce((sum, r) => sum + (Number(r.value) || 0), 0);
        return Math.abs(Math.min(0, total));   /* penalties are negative; bonuses ignored */
    } catch (_) {
        return 0;   /* weather engine not ready */
    }
}

/** Raw skill base — `stat + skill`, the guaranteed floor of a Witcher roll.
 *  NOT the D&D-style `10 + …` passive: that convention is only used for DCs. */
export function skillBase(actor, statKey, skillKey) {
    const skill = actor?.system?.skills?.[statKey]?.[skillKey] ?? {};
    const stat  = Number(actor?.system?.stats?.[statKey]?.value) || 0;
    const rank  = Number(skill.value)    || 0;
    const mod   = Number(skill.modifier) || 0;
    const total = Number.isFinite(Number(skill.total)) ? Number(skill.total) : stat + rank + mod;
    return total;
}

export const awarenessBaseOf = (actor) => skillBase(actor, "int", "awareness");
export const stealthBaseOf   = (actor) => skillBase(actor, "dex", "stealth");

/**
 * How far this watcher can see when there is no ambient light to help — the
 * floor `coneReachMetres` uses in darkness and pitch black.
 *
 * Takes the BEST of three independent sources, because a GM can grant dark
 * sight through any of them and the model must agree with `spotterCanPerceive`,
 * which already accepts all three:
 *
 *   1. Race items and vision effects (`darkVisionRange`) — the system's own way.
 *   2. The token's Foundry sight range, when its vision mode isn't blindness.
 *      This is how most GMs actually configure darkvision, and it was being
 *      ignored entirely: such a watcher passed the perceive gate, then computed
 *      a reach of ZERO in pitch black and drew no cone at all.
 *   3. The token's own emitted light. Someone carrying a torch can obviously
 *      see within it, however dark the room.
 *
 * The gate and the reach disagreeing is the specific failure this fixes: the
 * cone vanished for watchers the rest of the system considered perfectly able
 * to see.
 */
export function darkSightMetres(spotterToken) {
    let best = Number(darkVisionRange(spotterToken?.actor)) || 0;

    const sight = spotterToken?.document?.sight;
    const range = Number(sight?.range) || 0;
    if (range > 0 && sight?.visionMode !== "blindness") best = Math.max(best, range);

    const light = spotterToken?.document?.light;
    const lit = Math.max(Number(light?.bright) || 0, Number(light?.dim) || 0);
    if (lit > 0) best = Math.max(best, lit);

    return best;
}

/** Everything stealth-detection needs about one (spotter, sneak) pair. */
export function gatherDetectionFacts(spotterToken, stealtherToken, positionOverride = null,
                                     { skipCoverage = false } = {}) {
    const state = getStealthState(stealtherToken.actor);
    let tier = null;
    try { tier = lightLevelAt(stealtherToken); } catch (_) { tier = null; }
    const light = resolveLightPenalty(tier, spotterToken.actor);
    return {
        lightTier:     tier,          /* kept for chat / overlay labelling */
        lightPenalty:  light.penalty,
        lightPitch:    light.pitch,
        weatherPenalty: weatherPenaltyFor(spotterToken),
        spotterActor:  spotterToken.actor,
        /* `computeCoverageFraction` sweeps polygons — by far the most expensive
         * term here. The overlay overrides it with 1 anyway (it draws the
         * envelope, not the sneak's current cover), so it can skip the work
         * entirely rather than compute a value it discards. */
        coverFraction: skipCoverage ? 1 : computeCoverageFraction(stealtherToken, spotterToken, positionOverride),
        pace:          state.lastPace,
        prone:         !!stealtherToken.actor?.statuses?.has?.("prone"),
        zoneKey:       classifyVisionZone(stealtherToken, spotterToken)?.key,
        perception:    computePassivePerception(spotterToken),
        entryModifier: Number(state.modifiers) || 0,
        /* BASE numbers (stat + skill, no d10) — these size the cone, and they
         * never change during a sneak, so the shape holds still. */
        awarenessBase: awarenessBaseOf(spotterToken?.actor),
        stealthBase:   stealthBaseOf(stealtherToken?.actor),
        darkvisionRange: darkSightMetres(spotterToken),
        sightCeiling:  sightCeilingFor(spotterToken)
    };
}

/* NOTE: `watcherReachMetres` lived here and has been removed. It computed a
 * watcher-only cone reach and was superseded by `coneReachFor()`, which is
 * per-PAIR (it needs the base gap) and routes through `coneReachMetres` so the
 * drawn cone and the rolled check cannot diverge. Two functions answering
 * "how far does this cone go" is exactly how they diverge. */

/**
 * CHEAP cone-only reach for the overlay.
 *
 * The full `evaluatePair` gathers everything the tick needs, including
 * `computeCoverageFraction` — a polygon sweep, and by far the most expensive
 * term in the facts. The cone's size does not use coverage at all (it is
 * light, weather, zone and the base gap), so drawing it through the full path
 * burned that sweep once per spotter × sneak on every refresh for a value that
 * was discarded.
 *
 * `memo` is an optional per-refresh cache: `{ light: Map, weather: Map }`.
 * Light depends only on the sneak's tile and weather only on the watcher, so
 * both are constant across the pair loop and worth hoisting.
 */
export function coneReachFor(spotterToken, stealtherToken, memo = null, { skipZone = false } = {}) {
    /* Per-spotter values, memoised across the sneaks in one refresh. All three
     * depend only on the WATCHER, so recomputing them per (watcher × sneak)
     * pair was pure duplication — and `spotterCanPerceive` was additionally
     * being called once here and once in the overlay's own loop for the same
     * watcher on the same frame. */
    const spId = spotterToken?.id;
    let perceive = memo?.perceive?.get(spId);
    if (perceive === undefined) {
        perceive = spotterCanPerceive(spotterToken);
        memo?.perceive?.set(spId, perceive);
    }
    if (!perceive) return { D: 0, zoneKey: "focused", facts: null };

    let ceiling = memo?.ceiling?.get(spId);
    if (ceiling === undefined) {
        ceiling = sightCeilingFor(spotterToken);
        memo?.ceiling?.set(spId, ceiling);
    }
    let darkSight = memo?.darkSight?.get(spId);
    if (darkSight === undefined) {
        darkSight = darkSightMetres(spotterToken);
        memo?.darkSight?.set(spId, darkSight);
    }

    const stId = stealtherToken?.id;
    let tier = memo?.light?.get(stId);
    if (tier === undefined) {
        try { tier = lightLevelAt(stealtherToken); } catch (_) { tier = null; }
        memo?.light?.set(stId, tier);
    }
    const light = resolveLightPenalty(tier, spotterToken?.actor);

    let weather = memo?.weather?.get(spId);
    if (weather === undefined) {
        weather = weatherPenaltyFor(spotterToken);
        memo?.weather?.set(spId, weather);
    }

    /* `classifyVisionZone` runs an angular/polygon test. A caller drawing ALL
     * THREE zones overrides `zoneKey` for each one anyway, so computing the
     * sneak's own zone first is pure waste — and it was running per pair, per
     * refresh, ten times a second. */
    const zoneKey = skipZone ? undefined : classifyVisionZone(stealtherToken, spotterToken)?.key;
    const facts = {
        lightPenalty:  light.penalty,
        lightPitch:    light.pitch,
        weatherPenalty: weather,
        zoneKey,
        stealthBase:   stealthBaseOf(stealtherToken?.actor),
        awarenessBase: awarenessBaseOf(spotterToken?.actor),
        darkvisionRange: darkSight,
        sightCeiling:  ceiling
    };
    /* `facts` is returned so a caller drawing all three zones can recompute each
     * one PROPERLY — `coneReachMetres({...facts, zoneKey: zk})` — instead of
     * scaling this single result by a ratio of zone multipliers.
     *
     * That scaling was wrong, and visibly so: the night ceiling and darkvision
     * floor are applied inside `coneReachMetres` AFTER the zone multiplier, so
     * dividing the multiplier back out un-did the clamp. A sneak standing in a
     * watcher's periphery produced a small D that slipped under the ceiling,
     * and un-scaling it recovered an UNCAPPED reach — so the drawn cone grew
     * whenever the player stepped to the side. */
    return { D: coneReachMetres(facts), zoneKey, facts };
}

/** Everything one (spotter, sneak) pair resolves to this tick. Shared by the
 *  overlay and the diagnostic so neither can drift from the mechanics. */
/** The three zone wedges as {angleDeg, radiusPx}, each at its OWN reach.
 *  This is the shape the overlay draws, so measuring coverage against it keeps
 *  the wash and the mechanic describing the same volume. */
function zoneWedgesFor(spotterToken, facts, pxPerUnit) {
    const za = computeZoneAngles(spotterToken);
    return [
        { angleDeg: za.focusedAngle, radiusPx: coneReachMetres({ ...facts, zoneKey: "focused" }) * pxPerUnit },
        { angleDeg: za.nearAngle,    radiusPx: coneReachMetres({ ...facts, zoneKey: "near"    }) * pxPerUnit },
        { angleDeg: za.totalAngle,   radiusPx: coneReachMetres({ ...facts, zoneKey: "far"     }) * pxPerUnit }
    ];
}

export function evaluatePair(spotterToken, stealtherToken, positionOverride = null) {
    const facts = gatherDetectionFacts(spotterToken, stealtherToken, positionOverride,
                                       { skipCoverage: true });
    const cfg   = getStealthConfig();
    const D     = spotterCanPerceive(spotterToken) ? coneReachMetres(facts) : 0;
    /* Same order as the tick: reach first, then coverage measured against it. */
    const _gd = canvas?.dimensions;
    const _ppu = (_gd?.size || 100) / (_gd?.distance || 1);
    facts.coverFraction = D > 0
        ? computeCoverageFraction(stealtherToken, spotterToken, positionOverride,
                                  { zones: zoneWedgesFor(spotterToken, facts, _ppu),
                                    probes: bodyProbesFor(stealtherToken, positionOverride) })
        : 0;
    const d     = distanceMetres(stealtherToken, spotterToken, positionOverride);
    /* Same silhouette entry test / centre severity split as the tick — a
     * diagnostic that disagrees with the mechanic is worse than none. */
    const dEdge = Math.max(0, d - tokenRadiusMetres(stealtherToken));
    const inCone = D > 0 && dEdge <= D;
    const dTier = Math.min(d, D);

    facts.distanceMod = inCone ? distanceModifier(dTier, D) : 0;
    const dc = computePassivePerception(spotterToken);
    const modifiers = inCone ? stealthCheckModifiers(facts) : { parts: [], total: 0 };

    /* Average margin, not a die result — the diagnostic must not consume
     * randomness or it would report a different answer than the tick rolls.
     * No base term: see the note in resolveStealthCheck. */
    const avgTotal = 5.5 + (Number(facts.stealthBase) || 0) + modifiers.total;
    return {
        facts, D, d, inCone, dc, modifiers,
        band: inCone ? coneBandFor(dTier, D) : null,
        avgMiss: inCone ? Math.max(0, dc - avgTotal) : 0
    };
}

/**
 * Per-tick check card: what was rolled, against whom, and exactly which
 * modifiers applied.
 *
 * One card per tick rather than per watcher — three guards on a 3 s tick would
 * otherwise post twenty cards a minute. The breakdown is the point: "why did I
 * get seen there" should be answerable from the log without opening the console.
 */
async function postRollCard(stealther, checks) {
    if (!checks.length) return;
    /* Deliberately NO watcher name. The card shows the roll, the DC it went
     * against, and the modifiers that applied — which is everything the player
     * needs to understand the result. Naming the guard would hand over
     * information the character has not earned: which specific sentry is
     * looking, and how alert he is. The DC alone conveys "this one is sharp"
     * without pointing at him on the map. */
    const rows = checks.map(c => {
        const mods = c.res.modifiers.parts
            .map(p => `<span style="opacity:.85">${p.label} ${p.value > 0 ? "+" : ""}${p.value}</span>`)
            .join(" · ") || "<span style='opacity:.6'>no modifiers</span>";
        const ok = c.res.miss <= 0;
        const modTotal = c.res.modifiers.total;
        return `<div style="margin:.25rem 0;padding-left:.4rem;border-left:2px solid ${ok ? "#6fa287" : "#c4574b"};">
            <span style="font-variant-numeric:tabular-nums;">
              d10 <b>${c.res.roll}</b> + ${c.base} ${modTotal >= 0 ? "+" : "−"} ${Math.abs(modTotal)}
              = <b>${c.res.total}</b> vs DC <b>${c.res.dc}</b>
            </span>
            ${ok ? "<span style='color:#9fbf9f'> — held</span>"
                 : `<span style='color:#e08080'> — failed by ${c.res.miss}, +${c.res.miss} exposure</span>`}
            <div style="font-size:.85em;margin-top:.1rem">${mods}</div>
        </div>`;
    }).join("");
    try {
        await ChatMessage.create({
            speaker: { alias: t("WITCHER.Mech.Stealth.Chat.Alias", "Stealth") },
            whisper: [...gmUserIds(), ...actorOwnerUserIds(stealther)],
            content: `<div style="padding:.35rem .5rem;background:#0f0d09;border-left:3px solid #6b5b2e;">
                <div style="font-weight:bold;color:#d8c48a;">${stealther.name} — stealth checks</div>${rows}</div>`
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | stealth roll card failed`, err);
    }
}

/** Terse spotted notice — GM plus the sneak's own player. */
async function postExposureSpotCard(spotter, stealther, caught) {
    const verdict = t("WITCHER.Mech.Stealth.Verdict.Spotted", "Spotted");
    const line = tFormat("WITCHER.Mech.Stealth.Chat.SimpleSpotted",
        { spotter: spotter.name, stealther: stealther.name },
        `${stealther.name} was spotted by ${spotter.name}.`);
    const suffix = caught
        ? t("WITCHER.Mech.Stealth.Chat.TooClose", "Too close to miss.")
        : t("WITCHER.Mech.Stealth.Chat.NoticedAtLast", "Noticed at last.");
    try {
        await ChatMessage.create({
            speaker: { alias: t("WITCHER.Mech.Stealth.Chat.Alias", "Stealth") },
            whisper: [...gmUserIds(), ...actorOwnerUserIds(stealther)],
            content: `<div style="padding:0.35rem 0.5rem;border-left:3px solid #c04040;background:#0f0d09;">
                <div style="font-weight:bold;color:#e08080;">${verdict}</div>
                <div style="font-size:0.85rem;opacity:0.85;margin-top:0.2rem;">${line} ${suffix}</div>
            </div>`
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | exposure spot chat post failed`, err);
    }
}

/**
 * One tick for one stealthed token. Ticks are TIME-based — 3 s of real time
 * out of combat, the sneak's own turn end in combat — never action-based, so
 * standing still in a cone still burns the clock down rather than granting
 * immunity.
 *
 * Order matters: measure pace from the distance travelled SINCE the last tick
 * and store it BEFORE evaluating, so this tick's exposure reflects how the
 * sneak actually moved during it.
 */
async function tickStealther(token) {
    const actor = token?.actor;
    if (!actor || !isStealthed(actor)) return;
    const cfg = getStealthConfig();

    const state   = getStealthState(actor);
    const here    = documentCenter(token);
    const moved   = state.lastTickPos ? metresBetweenPx(here, state.lastTickPos) : 0;
    const spd     = Number(actor.system?.stats?.spd?.value) || 0;

    /* Pace = how much ground was covered DURING this window, measured.
     *
     * `lastTickPos` is stamped at the end of every tick, so `moved` is exactly
     * the distance travelled inside the window that just closed — 3 s out of
     * combat, or the token's own turn in combat (the turn-end tick is the only
     * one that fires there). That is the definition we want: cover 15 m in
     * three seconds and you were running, whatever you told the HUD.
     *
     * Earlier attempts at declared pace and at buffering are recorded in the
     * spec; both lied about what the player had just done. */
    const pace = paceFromDistance(moved, spd);

    const exposure  = { ...state.exposure };
    const spottedBy = state.spottedBy.slice();

    /* `gatherDetectionFacts` reads pace off the STORED state, which is still
     * last tick's value at this point — so the freshly measured pace is patched
     * into each facts object here. Without it, this tick's exposure would be
     * computed from how the sneak was moving during the PREVIOUS tick. */
    /* Coverage is deliberately SKIPPED here and filled in below, once `D` is
     * known: the fraction we want is "how much of me is inside this watcher's
     * cone", which needs the reach. Skipping also means the expensive polygon
     * sweep runs once per pair, not twice. */
    const factsFor = (spotter) => {
        const f = gatherDetectionFacts(spotter, token, null, { skipCoverage: true });
        f.pace = pace;
        return f;
    };
    const _gridDim = canvas?.dimensions;
    const _pxPerUnit = (_gridDim?.size || 100) / (_gridDim?.distance || 1);
    /* Depends only on the sneak's own position, so it is built ONCE per tick
     * and shared across every watcher rather than per pair. */
    const _probes = bodyProbesFor(token);
    /* Hard upper bound on how far ANY cone can reach, from the config alone.
     *
     *   D = dBase · kWeather · kZone · kLight · kBaseSkill , and every factor
     *   except kBaseSkill is <= 1, with kBaseSkill clamped to skillClampMax —
     *   so D can never exceed dBase * skillClampMax. The darkvision floor and
     *   the night ceiling only ever clamp DOWNWARD from there.
     *
     * That makes it a sound cheap pre-gate: a watcher further away than this
     * cannot possibly see the sneak, whatever the light or the angle. */
    const _maxReachM = (Number(cfg.dBaseMetres) || 80) * (Number(cfg.skillClampMax) || 2);

    const threshold = Number(cfg.threshold) || 10;
    const decay     = Number(cfg.exposureDecayPerTick) || 2;
    const newlySpotted = [];
    const checks = [];

    for (const spotter of potentialSpottersFor(token)) {
        const uuid = spotter.actor.uuid;
        const ekey = exposureKey(uuid);
        if (spottedBy.includes(uuid)) continue;
        const current = Number(exposure[ekey]) || 0;

        /* CHEAP GATES FIRST — arithmetic and property reads only.
         *
         * `factsFor` used to run here, at the top, for every watcher on the
         * scene: it classifies the vision zone, which builds up to two angular
         * polygons and runs containment on them, and it reads light, weather
         * and passive Awareness. All of that was paid for watchers hundreds of
         * metres away who could never see anything. On a busy map this is what
         * made the 3-second tick land as a visible hitch.
         *
         * ENTRY uses the nearest point of the sneak's silhouette, so any visible
         * overlap with the cone counts. */
        const d = distanceMetres(token, spotter);
        const dEdge = Math.max(0, d - tokenRadiusMetres(token));
        if (!spotterCanPerceive(spotter) || dEdge > _maxReachM) {
            exposure[ekey] = Math.max(0, current - decay);
            continue;
        }

        /* Only now is the expensive work justified. The cone's size is fixed by
         * base-vs-base and the world — no dice, no per-tick state — so it can be
         * learned and planned around. */
        const facts = factsFor(spotter);
        const D = coneReachMetres(facts);

        /* ANGLE + WALLS. `coverFraction` is 0 whenever the sneak is outside the
         * watcher's vision arc or behind a wall — it is the same test `isInLOS`
         * wraps, and `gatherDetectionFacts` has already paid for it, so reusing
         * it here costs nothing.
         *
         * This gate went missing when the cone moved onto `coneReachMetres`:
         * that function uses light, weather, zone and the base gap, but NOT
         * coverage, so the only remaining condition was radial distance. A
         * sneak standing directly BEHIND a guard, or through a wall, was inside
         * `D` and got rolled against — checks firing well outside anyone's
         * field of view. */
        /* Now that `D` is known, measure how much of the sneak is actually
         * inside this watcher's cone. This is both the in/out gate AND the
         * input to the cover ladder, so a token straddling the edge gets the
         * partial-cover bonus its silhouette earns. */
        facts.coverFraction = D > 0
            ? computeCoverageFraction(token, spotter, null,
                                      { zones: zoneWedgesFor(spotter, facts, _pxPerUnit),
                                        probes: _probes })
            : 0;
        const inView = Number(facts.coverFraction) > 0;

        if (D <= 0 || dEdge > D || !inView) {
            /* Outside his cone entirely: nothing to roll, and suspicion fades. */
            exposure[ekey] = Math.max(0, current - decay);
            continue;
        }

        /* THE SNEAK ROLLS. The guard is a static DC — he never rolls. Distance
         * enters as a modifier on that roll (the cone tier), so the geometry
         * stays fixed while the difficulty inside it varies honestly.
         *
         * Point blank is a savage modifier rather than a bypass, so an
         * extraordinary Stealth base still counts at the range where skill
         * should matter most — and so pitch darkness still beats proximity. */
        const pointBlank = Number(cfg.pointBlankMetres) || 1;
        const atPointBlank = d <= pointBlank;
        /* No `lightPitch` guard here, deliberately.
         *
         * Reaching this line already proves the watcher can see the sneak:
         * `D > 0` and `d <= D` were both checked above, and in pitch black the
         * only thing that produces a non-zero D is the watcher's own dark sight
         * (darkvision or a carried lamp). "Pitch beats proximity" is therefore
         * already enforced upstream — a watcher who genuinely cannot see there
         * has D = 0 and never gets this far.
         *
         * The guard that used to be here double-counted that rule and inverted
         * the outcome: a DARKVISION watcher with someone at point-blank range
         * was denied the auto-spot, which is precisely backwards. Same mistake
         * as the `Infinity` darkness bonus, in a second place — `lightPitch`
         * means "no ambient light", never "nobody can see". */
        if (atPointBlank && cfg.pointBlankAutoSpot) {
            exposure[ekey] = threshold;
            spottedBy.push(uuid);
            newlySpotted.push({ spotter, caught: true });
            continue;
        }
        const dTier = Math.min(d, D);
        facts.distanceMod = atPointBlank
            ? (Number(cfg.pointBlankModifier) || -10)
            : distanceModifier(dTier, D);
        facts.band = atPointBlank ? "point blank" : coneBandFor(dTier, D);
        /* The watcher's passive Awareness is the DC. He never rolls — the sneak
         * rolls their Stealth against him, every tick they remain in his cone. */
        const dc = computePassivePerception(spotter);
        const res = resolveStealthCheck(facts, dc);

        /* Missing by a lot is worse than missing by one — margin is what makes
         * a bad position degrade fast and a good one degrade slowly. */
        checks.push({ res, base: facts.stealthBase });

        /* Missing adds exposure; passing does nothing. Exposure only comes off
         * by leaving the cone (the decay branch above). */
        const gained = Math.max(0, res.miss);
        const next = current + gained;
        exposure[ekey] = Math.min(threshold, next);

        if (next >= threshold) {
            spottedBy.push(uuid);
            newlySpotted.push({ spotter, caught: false });
        }
    }

    _lastTickAt.set(token.id, performance.now());

    await writeStealthState(actor, {
        exposure,
        spottedBy,
        lastPace: pace,
        lastTickPos: { x: here.x, y: here.y }
    });

    if (cfg.rollChatCard) await postRollCard(token, checks);
    if (cfg.spottedChatCard) {
        for (const { spotter, caught } of newlySpotted) {
            await postExposureSpotCard(spotter, token, caught);
        }
    }
}

/** Tick every stealthed token on the canvas. */
async function tickAllStealthers({ onlyTokenId = null, force = false } = {}) {
    if (!game.user?.isActiveGM) return;
    const cfg = getStealthConfig();
    if (!cfg.enabled || cfg.detectionModel !== "exposure") return;
    if (game.paused) return;   /* table break shouldn't burn anyone's cover */

    for (const token of (canvas?.tokens?.placeables ?? [])) {
        if (!token?.actor || !isStealthed(token.actor)) continue;
        if (onlyTokenId && token.id !== onlyTokenId) continue;
        /* Per-token floor: the move-triggered tick and the wall clock can
         * otherwise land back to back and charge the same second twice.
         *
         * `force` bypasses it for the COMBAT turn-end tick, which owns the
         * cadence in combat and must never be dropped. A GM clicking briskly
         * through initiative can pass a whole round in under a second, and the
         * floor would silently swallow that round's exposure — the sneak would
         * simply not be charged for a turn, with nothing to indicate why. */
        if (!force) {
            const last = _lastTickAt.get(token.id) ?? 0;
            if ((performance.now() - last) < MIN_TICK_GAP_MS) continue;
        }
        /* In-combat tokens tick on their own turn end instead, so the wall
         * clock and the initiative order can't both charge for the same round. */
        if (!onlyTokenId && token.combatant?.combat?.started) continue;
        try { await tickStealther(token); }
        catch (err) { console.warn(`${SYSTEM_ID} | stealth tick failed`, err); }
    }
}

/* Per-token time of last tick, so a move can resolve IMMEDIATELY without any
 * token being charged twice in quick succession. */
const _lastTickAt = new Map();
/* Floor between ticks for one token, ms. Stops a flurry of small drags from
 * charging a tick each while still letting a normal move resolve at once. */
const MIN_TICK_GAP_MS = 1000;

let _tickTimer = null;

/** 3-second wall clock for out-of-combat sneaking. Runs on the active GM
 *  only, mirroring the dispatch's authority model. */
function startExposureTicker() {
    if (_tickTimer) return;
    const seconds = Number(CONFIG?.time?.roundTime) || 3;
    _tickTimer = setInterval(() => {
        tickAllStealthers().catch(() => {});
    }, seconds * 1000);
}

function stopExposureTicker() {
    if (!_tickTimer) return;
    clearInterval(_tickTimer);
    _tickTimer = null;
}

/**
 * `wdmStealthWhy()` in the console — the whole detection state for the selected
 * (or first controlled) stealthed token, as one table.
 *
 * Exists because "the eye isn't filling" has half a dozen possible causes that
 * look identical on screen: ticks not running because this client isn't the
 * active GM, the game being paused, exposure accruing but the overlay not
 * refreshing, or the sneak simply being genuinely undetectable and the system
 * being right. This says which.
 */
function registerStealthWhy() {
    globalThis.wdmStealthWhy = () => {
        const cfg = getStealthConfig();
        const tok = (canvas?.tokens?.controlled ?? []).find(t => isStealthed(t.actor))
                 ?? (canvas?.tokens?.placeables ?? []).find(t => t.actor && isStealthed(t.actor));
        if (!tok) { console.warn("wdmStealthWhy: no stealthed token found"); return; }

        const state = getStealthState(tok.actor);
        /* Lit-region clip state. The clip has two failure modes that look
         * identical on the map and need opposite fixes:
         *   - SKIPPED: `sceneAmbientlyLit` is true, so no mask is built at all
         *     and the cone paints everywhere. A scene can read as visually dark
         *     while still having global illumination active for its darkness
         *     level — that is the trap.
         *   - SWALLOWED: the mask exists but each watcher's dark-sight disc is
         *     large enough to cover their whole cone, so nothing gets clipped.
         *     Compare `darkSight_m` against `coneReach_m` per row below. */
        console.log("%c── lit clip ──", "font-weight:bold", {
            ambientlyLit_soClipSkipped: sceneAmbientlyLit(),
            ambientTier: (() => { try { return ambientLightLevel(); } catch (_) { return "?"; } })(),
            activeLights: (canvas?.effects?.lightSources ?? []).filter(l => l?.active).length
        });
        console.log("%c── stealth state ──", "font-weight:bold");
        console.log({
            sneak:            tok.name,
            model:            cfg.detectionModel,
            stealthBase:      stealthBaseOf(tok.actor),
            measuredPace:     state.lastPace,
            prone:            !!tok.actor?.statuses?.has?.("prone"),
            armourEV:         Number(tok.actor?.system?.armorEV) || 0,

            /* The usual culprits when nothing is happening at all: */
            youAreActiveGM:   !!game.user?.isActiveGM,
            tickerRunning:    _tickTimer !== null,
            gamePaused:       !!game.paused,
            inCombat:         !!tok.combatant?.combat?.started
        });

        const rows = [];
        for (const sp of potentialSpottersFor(tok)) {
            const r = evaluatePair(sp, tok);
            const ex = Number(state.exposure?.[exposureKey(sp.actor?.uuid)]) || 0;
            const za = computeZoneAngles(sp);

            /* WHY NO CHECK — the gates the tick applies, in the order it applies
             * them, reported as the FIRST one that fails. Every gate below can
             * independently produce "the cone is drawn but nothing happens", and
             * they are indistinguishable on the map, so guessing between them
             * from a screenshot is hopeless. */
            const dEdge = Math.max(0, r.d - tokenRadiusMetres(tok));
            const cover = Number(r.facts.coverFraction) || 0;
            const already = state.spottedBy.includes(sp.actor?.uuid);
            const blocked =
                  already                      ? "ALREADY SPOTTED — no further checks by this watcher"
                : !spotterCanPerceive(sp)      ? "watcher cannot perceive (dead / blind / no vision)"
                : r.D <= 0                     ? "cone reach is 0 (too dark for them, or no dark sight)"
                : dEdge > r.D                  ? `out of range (nearest edge ${dEdge.toFixed(1)}m > reach ${r.D.toFixed(1)}m)`
                : cover <= 0                   ? "coverage 0 — outside their arc, behind a wall, or level-blocked"
                : "— fires";
            rows.push({
                /* Cone geometry — the angles actually used for DRAWING. If the
                 * wash spills outside a watcher's arc, the answer is here:
                 * `allowed` is what the cone is clipped to, `true` is the
                 * unrestricted arc, and equipment (helmet/hood) is what makes
                 * them differ. A 360 in `allowed` means the arc is being read as
                 * unset — check `fullCircleIsUnset` and the per-token True Angle
                 * flag. */
                trueAngle:  getTrueVisionAngle(sp),
                allowed:    getAllowedVisionAngle(sp),
                focusedDeg: Math.round(za.focusedAngle),
                nearDeg:    Math.round(za.nearAngle),
                farDeg:     Math.round(za.totalAngle),
                facing:     Math.round(Number(sp.document?.rotation) || 0),
                darkSight_m: +darkSightMetres(sp).toFixed(1),
                spotter:     sp.name,
                distance_m:  +r.d.toFixed(1),
                coneReach_m: +r.D.toFixed(1),
                inCone:      r.inCone,
                edge_m:      +dEdge.toFixed(1),
                cover:       +cover.toFixed(2),
                WHY:         blocked,
                band:        r.band ?? "—",
                yourBase:    r.facts.stealthBase,
                modifiers:   r.modifiers.parts.map(p => `${p.label} ${p.value > 0 ? "+" : ""}${p.value}`).join(" ") || "none",
                modTotal:    r.modifiers.total,
                theirDC:     r.dc,
                avgMissPerTick: +r.avgMiss.toFixed(1),
                exposure:    `${ex.toFixed(1)} / ${cfg.threshold}`,
                light:       r.facts.lightTier,
                zone:        r.facts.zoneKey
            });
        }
        if (!rows.length) { console.warn("no potential spotters on this scene"); return; }
        console.table(rows);
        const firing = rows.filter(x => x.WHY === "— fires");
        if (firing.length) {
            console.log(`%c${firing.length} watcher(s) WILL roll against you this tick: `
                + firing.map(x => x.spotter).join(", "), "color:#c4574b;font-weight:bold;");
        } else {
            console.log("%cNo watcher will roll. Reasons, per watcher:", "color:#c8a878;font-weight:bold;");
            for (const x of rows) console.log(`   ${x.spotter}: ${x.WHY}`);
        }
    };
}

/* ─────────── registration ─────────── */

export function registerStealthHooks() {
    /* The two movement-triggered updateToken dispatch hooks are gone with the
     * legacy model. Exposure accrues on TIME ticks, not on movement, so they
     * had nothing left to do — `runSpotDispatch` returned immediately on every
     * call. The overlay still refreshes on movement through its own hooks. */

    /* Anything that can change the weather answer clears the per-actor cache,
     * so its TTL is a backstop rather than the thing keeping it correct. */
    for (const h of ["updateScene", "canvasReady", "updateRegion",
                     "createRegion", "deleteRegion"]) {
        Hooks.on(h, invalidateWeatherPenaltyCache);
    }

    /* Stealth exit → wipe the pair cache for that stealther so
     * re-entering starts with a clean slate. */
    Hooks.on("updateActor", (actor, changes) => {
        if (!game.user?.isActiveGM) return;
        /* Clear the per-pair tuple cache on BOTH stealth entry and
         * stealth exit. Exit is obvious — the state is gone, cache
         * shouldn't linger. Entry ALSO clears because stale cache
         * from a prior session could suppress the "first LOS entry"
         * card in the new session: the tuple check would find a
         * matching entry in cache and skip comparePassive, so the
         * player never sees a card until they move to a new tuple.
         * Fresh session = fresh cache = every in-LOS spotter fires
         * an entry card on the first dispatch. */
        const stealthUnset = changes?.flags?.[`-=${SYSTEM_ID}`] !== undefined
                          || changes?.flags?.[SYSTEM_ID]?.[`-=stealth`] !== undefined;
        const stealthSet = changes?.flags?.[SYSTEM_ID]?.stealth !== undefined
                        && !stealthUnset;
        if (!stealthUnset && !stealthSet) return;
        for (const tok of (actor?.getActiveTokens?.() ?? [])) {
            _pairState.delete(tok.id);
        }
    });

    /* Token population changed — a stealthed token may have been added or
     * removed, so the cached "anyone sneaking?" answer is stale. Cheap null. */

    /* ── exposure ticks ──────────────────────────────────────────────────
     * Time-based, never action-based: 3 s of wall clock out of combat, the
     * sneak's own turn end in combat. One tick per round either way. */
    /* Start attempts are idempotent (`startExposureTicker` no-ops when the
     * timer already exists), so it is safe to try from several triggers. More
     * than one is necessary: `ready` alone means that if the GM reconnects, or
     * a second GM takes over as active, the new active client never starts
     * ticking and out-of-combat stealth silently stops advancing — a failure
     * with no error and no symptom until someone notices nobody is being
     * spotted. `userConnected` covers the handover; `canvasReady` covers a
     * reload or scene change. */
    registerStealthWhy();
    const tryStartTicker = () => {
        if (game.user?.isActiveGM && !game.paused) startExposureTicker();
    };
    Hooks.once("ready", tryStartTicker);
    Hooks.on("userConnected", tryStartTicker);
    Hooks.on("canvasReady", tryStartTicker);

    /* In combat, tick the token whose turn just ENDED — once per round per
     * sneak, matching the out-of-combat cadence. `combat.previous` holds the
     * combatant that was active before this update. */
    /* Resolve a move the moment it lands, rather than whenever the 3 s wall
     * clock next happens to fire.
     *
     * With only the interval, an identical move resolved differently depending
     * on where it fell inside the window — sometimes charged immediately,
     * sometimes up to 3 s later, sometimes merged with the next move. That is
     * the "detection feels inconsistent" complaint: same action, different
     * outcome, for reasons invisible to the player. Ticking on arrival makes
     * movement always resolve at the same point relative to the action, and the
     * per-token floor keeps a burst of small drags from charging several. */
    Hooks.on("updateToken", (tokenDoc, changes) => {
        if (!game.user?.isActiveGM) return;
        if (changes?.x === undefined && changes?.y === undefined
         && changes?.elevation === undefined) return;
        const cfg = getStealthConfig();
        if (!cfg.enabled || cfg.detectionModel !== "exposure") return;
        const tok = canvas?.tokens?.get?.(tokenDoc?.id);
        if (!tok?.actor || !isStealthed(tok.actor)) return;
        /* In combat the turn-end tick owns the cadence — one per round. Letting
         * a move tick as well would charge a moving combatant twice a round. */
        if (tok.combatant?.combat?.started) return;
        tickAllStealthers({ onlyTokenId: tok.id }).catch(() => {});
    });

    Hooks.on("updateCombat", (combat, changed) => {
        if (!game.user?.isActiveGM) return;
        if (changed?.turn === undefined && changed?.round === undefined) return;
        const cfg = getStealthConfig();
        if (!cfg.enabled || cfg.detectionModel !== "exposure") return;
        const prevId = combat?.previous?.tokenId;
        if (!prevId) return;
        /* force: in combat this is the ONLY tick source, so it must always land
         * regardless of how fast the table is moving through initiative. */
        tickAllStealthers({ onlyTokenId: prevId, force: true }).catch(() => {});
    });

    /* Pausing the game pauses stealth — a rules lookup or a coffee break
     * shouldn't cost anyone their cover. */
    Hooks.on("pauseGame", (paused) => {
        if (!game.user?.isActiveGM) return;
        if (paused) stopExposureTicker();
        else startExposureTicker();
    });
}
