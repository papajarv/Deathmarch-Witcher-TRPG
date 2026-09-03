/**
 * Carousel Initiative — configuration payload.
 *
 * Stored as a single world-scope Object under `carouselInitiativeConfig`.
 * Consumers read live via `getCarouselConfig()` so GM edits take effect
 * on the next carousel render — no world reload needed for anything
 * except the master `enabled` toggle (which gates hook registration at
 * load time).
 *
 * Sections mirror the CarouselInitiativeConfigApp form:
 *   • General — master enable + when to show (token combat / theater of
 *     the mind), which audiences see the carousel (GM / players).
 *   • Layout — card size, active-card scale, container width, gap.
 *   • Motion — transition duration, snap-on-wrap.
 *   • Disposition colors — border color per disposition + active glow.
 *   • Filtering — SECRET / stealth privacy rules.
 */

const SETTING_KEY = "carouselInitiativeConfig";
const SYSTEM_ID   = "witcher-ttrpg-death-march";

export const CAROUSEL_CONFIG_KEY = SETTING_KEY;

export const CAROUSEL_CONFIG_DEFAULTS = Object.freeze({
    /* ── General ─────────────────────────────────────────────────── */
    enabled:               true,
    showForTokenCombat:    true,
    showForTheaterOfMind:  true,
    showForGM:             true,
    showForPlayers:        true,

    /* ── Layout ──────────────────────────────────────────────────── */
    cardWidth:             4.25,   /* rem */
    cardHeight:            5.5,    /* rem */
    portraitHeight:        3.75,   /* rem */
    activeScale:           1.4,    /* multiplier — 1.0 disables scale-up */
    containerMaxWidth:     56,     /* rem */
    cardGap:               0.5,    /* rem — space between cards */

    /* ── Motion ──────────────────────────────────────────────────── */
    transitionMs:          320,    /* ms — 0 disables the slide animation */
    snapOnRoundWrap:       true,   /* jump back to first-centered on new round */

    /* ── Disposition colors (CSS color strings) ──────────────────── */
    hostileColor:          "#e04040",
    friendlyColor:         "#3ec25a",
    secretColor:           "#7a4a9a",  /* only GM sees these frames */
    neutralShowFrame:      false,      /* if true, uses neutralColor */
    neutralColor:          "#d4a844",
    activeGlowColor:       "#e0b060",

    /* ── Filtering (privacy) ─────────────────────────────────────── */
    hideStealthFromPlayers:      true,
    hideSecretFromPlayers:       true,
    respectSpotterVisibility:    true   /* owners of a spotter still see the stealther */
});

/** Read the current merged carousel config (defaults + world overrides).
 *  Safe to call before settings register (returns defaults). Callers
 *  should invoke on every render to see live GM edits — the read is
 *  cheap (one settings.get + one mergeObject on a small object). */
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const COLOR_KEYS = ["hostileColor", "friendlyColor", "secretColor", "neutralColor", "activeGlowColor"];

/* Prior versions of the config app rendered color pickers as a
 * duplicate-name pair (color + hex text). Foundry's FormDataExtended
 * returned that as an array, which was then String()-joined to
 * "#xxxxxx,#xxxxxx" — a value that failed native pattern validation
 * and silently blocked the next form submit. Sanitize on read so
 * worlds that already saved the corrupt shape recover automatically. */
function healColor(v, dflt) {
    if (Array.isArray(v)) v = v[0];
    if (typeof v !== "string") return dflt;
    const first = v.split(",")[0]?.trim();
    return HEX6.test(first) ? first : dflt;
}

export function getCarouselConfig() {
    let stored = {};
    try { stored = game.settings.get(SYSTEM_ID, SETTING_KEY) ?? {}; }
    catch (_) { stored = {}; }
    const merged = foundry.utils.mergeObject(
        foundry.utils.deepClone(CAROUSEL_CONFIG_DEFAULTS),
        stored,
        { inplace: true, overwrite: true }
    );
    for (const k of COLOR_KEYS) merged[k] = healColor(merged[k], CAROUSEL_CONFIG_DEFAULTS[k]);
    return merged;
}

/** Write a partial config patch back to the world setting. Merges over
 *  the stored object rather than replacing — callers only need to
 *  supply changed keys. GM-only in practice; Foundry's settings API
 *  enforces the world-scope write permission. */
export async function setCarouselConfig(patch) {
    const current = getCarouselConfig();
    const merged  = foundry.utils.mergeObject(current, patch, { inplace: false, overwrite: true });
    await game.settings.set(SYSTEM_ID, SETTING_KEY, merged);
    /* Fire a hook so consumers (the carousel module itself) can react
     * without polling the setting. */
    Hooks.callAll("wdm:carouselConfigChanged", merged);
    return merged;
}
