/**
 * critBonusFor — pure helper for the flat "bonus damage" a critical
 * wound adds on top of the weapon damage roll, per Core p.158.
 *
 * Two RAW ladders:
 *   Normal targets    → simple:3, complex:5,  difficult:8,  deadly:10
 *   Elementa / specter → simple:5, complex:10, difficult:15, deadly:20
 *     (organ-based wound effect doesn't apply to these — the higher
 *      flat bonus replaces it, Core p.159 sidebar)
 *
 * The optional `ladders` argument lets callers pass a house-ruled pair
 * (see hrCritBonusLadders in mechanics/house-rules-config.mjs). The
 * helper stays pure — no config read — so tests remain deterministic
 * and callers control the ladder input.
 *
 * Zero-severity or unknown key → 0 (safe no-op; caller can skip the add).
 */
export const RAW_CRIT_BONUS_NORMAL    = Object.freeze({ simple: 3, complex: 5,  difficult: 8,  deadly: 10 });
export const RAW_CRIT_BONUS_NO_ORGANS = Object.freeze({ simple: 5, complex: 10, difficult: 15, deadly: 20 });

const RAW_LADDERS = Object.freeze({
    normal:   RAW_CRIT_BONUS_NORMAL,
    noOrgans: RAW_CRIT_BONUS_NO_ORGANS
});

export function critBonusFor(severity, immuneToOrganCrits, ladders = RAW_LADDERS) {
    if (!severity) return 0;
    const pair = ladders || RAW_LADDERS;
    const ladder = immuneToOrganCrits
        ? (pair.noOrgans || RAW_CRIT_BONUS_NO_ORGANS)
        : (pair.normal   || RAW_CRIT_BONUS_NORMAL);
    const v = ladder[severity];
    return Number.isFinite(v) ? Number(v) : 0;
}
