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
