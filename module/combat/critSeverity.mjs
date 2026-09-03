/**
 * critSeverityFromDelta — pure helper for critical-wound severity
 * detection. Returns the severity key matching an attack-vs-defense
 * delta, or null when no crit was scored. RAW ladder (Core p.152
 * sidebar + Critical Wounds table):
 *
 *   delta <  simple    → null     (no crit — tie goes to defense per errata)
 *   delta ≥ simple     → "simple"
 *   delta ≥ complex    → "complex"
 *   delta ≥ difficult  → "difficult"
 *   delta ≥ deadly     → "deadly"
 *
 * With RAW brackets: simple=7, complex=10, difficult=13, deadly=15.
 *
 * The optional `brackets` argument lets callers pass a house-ruled
 * ladder (see hrCritBrackets in mechanics/house-rules-config.mjs).
 * The helper stays pure — no config read — so tests remain
 * deterministic and callers control the ladder input.
 *
 * The numeric bonus is decided downstream — the socket handler uses a
 * different ladder for elementa / specter targets (Core p.159 sidebar).
 */
export const RAW_CRIT_BRACKETS = Object.freeze({
    simple: 7, complex: 10, difficult: 13, deadly: 15
});

export function critSeverityFromDelta(delta, brackets = RAW_CRIT_BRACKETS) {
    if (!Number.isFinite(delta)) return null;
    const b = brackets || RAW_CRIT_BRACKETS;
    if (delta < b.simple) return null;
    if (delta >= b.deadly)    return "deadly";
    if (delta >= b.difficult) return "difficult";
    if (delta >= b.complex)   return "complex";
    return "simple";
}
