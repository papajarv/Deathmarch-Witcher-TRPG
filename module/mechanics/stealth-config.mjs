/**
 * stealth-config — one shared source of truth for every stealth tunable.
 *
 * Everything the GM can adjust from the Token Stealth configuration menu
 * lives here. Consumers pull the LIVE config every time they need it
 * (via `getStealthConfig()`) so GM edits take effect on the next check
 * without a world reload.
 *
 * The world setting stores only fields the GM has changed vs. the
 * defaults — reading is always `deepClone(defaults) → mergeObject(stored)`
 * so freshly added fields pick up their default value automatically.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const SETTING_KEY = "stealthConfig";

/**
 * Every tunable the CURRENT model reads — and nothing else.
 *
 * The legacy passive-vs-roll model's tables are gone: `rangeBandMods`,
 * `rangeBandFractions`, `baseSightMetres`, `focusedMod`/`nearMod`/`farMod`,
 * `coverageMods`, plus `certaintyFraction`, `distanceModSpan`, `coneCheckDC`,
 * `narrationLadder`, `allowRecovery` and the multiplicative `coverMults` /
 * `motionMults` / `postureMults` from earlier designs. A config key with no
 * reader is worse than no key at all — it reads as a working dial to whoever
 * opens this file next, and several of those had been dead for a while.
 *
 * THE MODEL: the cone's SIZE comes from base-vs-base plus the world (no dice,
 * so it holds still and can be learned). Inside it the SNEAK rolls each tick
 * carrying situational modifiers; guards never roll, they are a static DC. How
 * badly the roll misses is the exposure that watcher gains.
 */
export const STEALTH_CONFIG_DEFAULTS = Object.freeze({
    /* Master switch. False = the whole pipeline is inert: no ticks, no overlay,
     * no HUD button. Existing stealth flags are preserved. */
    enabled: true,

    /* Kept as a constant, deliberately NOT exposed in the settings UI. The
     * legacy model's tables were removed, so "legacy" would now misbehave;
     * the guards that read this remain as a cheap safety net. */
    detectionModel: "exposure",

    /* ── CONE SIZE ────────────────────────────────────────────────────────
     * Reach for an average watcher against an average sneak, in daylight,
     * dead ahead. Every other cone factor multiplies this. */
    dBaseMetres: 80,

    /* Reach lost per step of the light ladder, LINEAR: 1 − step × penalty.
     * At 0.2: dim−1 0.8 · dim−2 0.6 · dim−3 0.4 · darkness 0.2 · pitch 0. An
     * even ladder makes each tier deeper worth the same. Weather rides it too. */
    lightStep: 0.2,

    /* Cone size per point of (awareness base − stealth base). The clamp is
     * NARROW on purpose: the sneak's base is also in the in-cone roll, so a
     * wide clamp counts the same advantage twice and makes a high base
     * untouchable. Skill mainly expresses in the roll. */
    skillBase: 1.12,
    skillClampMin: 0.5,
    skillClampMax: 2.0,

    /* The cone narrows toward the edge of the arc. */
    zoneMults: { focused: 1.0, near: 0.7, far: 0.4 },

    /* Nobody sees past this at night, however lit the sneak is — EXCEPT
     * darkvision, which is a purchased ability to see further and overrides it. */
    /* Feeds `computeMaxSightMetres` (base + INT + Awareness), which still sizes
     * the sneak's own view radius and the cross-level reveal discs. It was
     * dropped from the defaults during the legacy cull while live code kept
     * reading it, so it silently fell back to a hard-coded 20. */
    baseSightMetres: 20,

    nightCeilingMetres: 40,

    /* Fallback arc for tokens with no explicit `sight.angle`. Foundry's own
     * default is 360, which is not a cone at all. */
    defaultVisionAngleDeg: 120,

    /* Whether exactly 360° counts as "unset" (true) or is honoured literally
     * (false). The per-token True Angle flag overrides both, and any value
     * other than exactly 360 is always literal. */
    fullCircleIsUnset: true,

    /* Clip the whole overlay to the CONTROLLED token's own field of view, so
     * enemy cones never render in your character's blind spot. Uses the same
     * arc rules as a watcher's cone (see `getAllowedVisionAngle`). Off = the
     * old behaviour, where the overlay showed cones all around you on the
     * reasoning that a sneaker can turn their head. */
    clipOverlayToOwnFov: true,


    /* ── THE IN-CONE CHECK ────────────────────────────────────────────────
     * Exposure needed to be spotted, and how fast suspicion drains once the
     * sneak is out of the cone again. Exposure gains the roll's MISS MARGIN,
     * so a bad position degrades far faster than a marginal one. */
    threshold: 10,
    exposureDecayPerTick: 2,

    /* Modifier on the sneak's roll by how deep into the cone they are. Steep by
     * design: the inner tiers must punish proximity hard enough that a towering
     * Stealth base is not untouchable at close range. */
    tierModifiers: { outer: 0, mid: -5, inner: -10, core: -15 },

    /* Situational bonuses on the sneak's roll. Positive helps the sneak.
     * Additive, and deliberately separate from cone SIZE — the cone can then be
     * learned while these vary with where you stand and what you are doing. */
    coverBonuses:   { exposed: 0, threeQuarter: 1, half: 2, quarter: 4, sliver: 6 },
    postureBonuses: { standing: 0, prone: 2 },
    paceBonuses:    { still: 2, creep: 1, walk: 0, run: -2 },

    /* Point blank. DECIDED: this is an auto-spot — standing directly in front
     * of someone gets you seen no matter how superhuman your Stealth, because
     * proximity is a fact and not a contest. `pointBlankModifier` is consulted
     * only if `pointBlankAutoSpot` is turned off. */
    pointBlankMetres: 1,
    pointBlankAutoSpot: true,
    pointBlankModifier: -10,

    /* ── HEARING (currently OFF) ──────────────────────────────────────────
     * Works mechanically but has no on-screen representation, so a watcher
     * outside every cone would spot someone with nothing to explain why —
     * indistinguishable from a bug. Re-enable only alongside an earshot
     * overlay. See "NEXT UP" in docs/stealth-detection-spec.md. */

    /* ── FEEDBACK ─────────────────────────────────────────────────────────
     * The per-tick card shows the roll, the DC and every modifier, with no
     * watcher named — the DC conveys "this one is sharp" without pointing him
     * out on the map. */
    rollChatCard: true,
    spottedChatCard: true,

    /* ── DISPLAY / DIAGNOSTICS ────────────────────────────────────────────── */
    hideConeWhenSpotted: true,
    crossLevelDetection: true,
    debug: false
});

/** Live, merged config. Reads directly from the world setting; falls
 *  back to defaults for any field the GM hasn't overridden.
 *
 *  NOT CACHED. Prior implementation cached at module scope with
 *  invalidation via `onChange` + `updateSetting` hook — but Foundry
 *  V14's Object-type settings have inconsistent onChange behavior
 *  and the caching risked serving stale values after a save (the
 *  "debug toggle does nothing" symptom). The uncached version is
 *  cheap enough: mergeObject on ~15 fields (3 nested) is sub-ms per
 *  call, and hot callers (like `applyStealthVisibility` on every
 *  refreshToken) already early-exit before touching the config for
 *  non-stealth-relevant tokens. Correctness > caching. */
/* Short-lived cache. `mergeObject` deep-clones ~30 fields including six nested
 * tables on EVERY call, and this is called from genuinely hot paths — once per
 * token per animation frame from the pace badge, and many times per overlay
 * refresh.
 *
 * A previous attempt at caching keyed off `onChange` + the `updateSetting` hook
 * and was reverted because Foundry V14's Object-type settings fire those
 * inconsistently, which served stale values after a save. A TIME-boxed cache
 * has no such failure mode: it depends on no hook firing, and staleness is
 * bounded at CONFIG_TTL_MS regardless of what Foundry does. A quarter second is
 * imperceptible when editing settings and removes essentially every merge. */
const CONFIG_TTL_MS = 250;
let _cfgCache = null;
let _cfgCacheAt = 0;

/** Drop the cache immediately — used by the config app right after a save so
 *  the GM sees their edit take effect on the very next check, not up to a
 *  quarter second later. */
export function invalidateStealthConfigCache() {
    _cfgCache = null;
    _cfgCacheAt = 0;
}

export function getStealthConfig() {
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (_cfgCache && (now - _cfgCacheAt) < CONFIG_TTL_MS) return _cfgCache;

    let stored = {};
    try { stored = game.settings?.get?.(SYSTEM_ID, SETTING_KEY) ?? {}; }
    catch (_) { stored = {}; }
    _cfgCache = foundry.utils.mergeObject(STEALTH_CONFIG_DEFAULTS, stored, {
        inplace: false,
        overwrite: true
    });
    _cfgCacheAt = now;
    return _cfgCache;
}

/** No-op — kept for backwards compat with setup/settings.mjs which
 *  imported this to wire onChange/updateSetting hooks. Now that the
 *  config isn't cached, there's nothing to invalidate. */
export function _invalidateStealthConfigCache() { /* no-op */ }

/** Console diagnostic — prints the currently live config as read
 *  from settings. */
try {
    window.wdmStealthConfigDump = () => {
        const live = getStealthConfig();
        console.log("%c[WDM] Stealth Config", "color:#c8a878;font-weight:bold;", live);
        return live;
    };
} catch (_) {}

/** Persist an edited config object. Merges over the current stored
 *  state so partial edits (single field via the form) don't wipe
 *  unrelated fields. Notifies consumers via a hook so overlays can
 *  refresh without a reload. Invalidates the local cache
 *  synchronously so the initiating client sees the change on the
 *  very next `getStealthConfig()` call. */
export async function setStealthConfig(patch) {
    const current = game.settings?.get?.(SYSTEM_ID, SETTING_KEY) ?? {};
    const next = foundry.utils.mergeObject(current, patch ?? {}, {
        inplace: false, overwrite: true
    });
    await game.settings.set(SYSTEM_ID, SETTING_KEY, next);
    _invalidateStealthConfigCache();
    Hooks.callAll("wdmStealthConfigChanged", next);
}

export const STEALTH_CONFIG_KEY = SETTING_KEY;
