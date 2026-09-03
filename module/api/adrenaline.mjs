/**
 * Adrenaline optional-rule API (Core Rulebook p.175-176).
 *
 * Adrenaline is a Core *optional* rule: you bank a d6 per critical hit (pool
 * capped at BODY), then spend dice for +1d6 damage or +1d6 temp HP, paying
 * Stamina per die. Two world settings drive it (registered in setup/settings.mjs):
 *
 *   adrenalineEnabled    — master toggle. OFF removes adrenaline from the
 *                          actor sheet, chrome UI, combat dock, and weapon
 *                          macros entirely.
 *   adrenalineStaPerDie  — Stamina spent per die. RAW default = 10.
 *
 * Reads are wrapped so a call before settings register (or outside a world)
 * falls back to the RAW defaults rather than throwing.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* RAW: "for every one you spend you lose 10 Stamina" (Core p.176). */
export const ADRENALINE_STA_PER_DIE_DEFAULT = 10;

export function isAdrenalineEnabled() {
    try { return !!game.settings.get(SYSTEM_ID, "adrenalineEnabled"); }
    catch { return true; }
}

export function adrenalineStaPerDie() {
    try {
        const v = Number(game.settings.get(SYSTEM_ID, "adrenalineStaPerDie"));
        return Number.isFinite(v) && v >= 0 ? Math.floor(v) : ADRENALINE_STA_PER_DIE_DEFAULT;
    } catch {
        return ADRENALINE_STA_PER_DIE_DEFAULT;
    }
}

/* Per-actor effective STA cost per adrenaline die. Sums signed deltas from
 * every active AE on the actor that carries an `adrenalineStaCostDelta`
 * marker action, then adds them to the base setting. Floored at 0 so a
 * strong enough negative stack (e.g. base 4 + -5 delta) genuinely makes
 * an adrenaline die free rather than getting stuck at "always costs 1". */
/* Adrenalized(N) rune quality — sum of the extra Adrenaline points the
 * actor's EQUIPPED weapons/shields grant whenever the actor gains Adrenaline.
 * Reads `effective` qualities so a runestone-granted (and stacked) Adrenalized
 * is counted; multiple Adrenalized items sum. */
export function equippedAdrenalizedBonus(actor) {
    let bonus = 0;
    for (const it of (actor?.items ?? [])) {
        if ((it.type !== "weapon" && it.type !== "shield") || !it.system?.equipped) continue;
        const quals = it.system?.effective?.qualities ?? it.system?.qualities ?? [];
        if (!Array.isArray(quals) || !quals.includes("adrenalized")) continue;
        const vals = it.system?.effective?.qualityValues ?? it.system?.qualityValues ?? {};
        bonus += Math.max(0, Math.trunc(Number(vals.adrenalized) || 0));
    }
    return bonus;
}

export function adrenalineStaPerDieFor(actor) {
    const base = adrenalineStaPerDie();
    let delta = 0;
    for (const e of (actor?.appliedEffects ?? actor?.effects ?? [])) {
        if (!e || e.disabled || e.isSuppressed) continue;
        const actions = e.getFlag?.(SYSTEM_ID, "actions");
        if (!Array.isArray(actions)) continue;
        for (const a of actions) {
            if (a?.type !== "adrenalineStaCostDelta") continue;
            const n = Number(a.delta);
            if (Number.isFinite(n)) delta += Math.trunc(n);
        }
    }
    return Math.max(0, base + delta);
}
