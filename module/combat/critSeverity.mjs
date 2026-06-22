/**
 * critSeverityFromDelta — pure helper for RAW Core p.158 critical-wound
 * severity detection.  Returns the severity key matching an attack-vs-
 * defense delta, or null when no crit was scored.  Tiers (Core p.152
 * sidebar + Critical Wounds table):
 *
 *   delta < 7   → null     (no crit — tie goes to defense per errata)
 *   delta 7-9   → "simple"
 *   delta 10-12 → "complex"
 *   delta 13-14 → "difficult"
 *   delta 15+   → "deadly"
 *
 * The numeric bonus is decided downstream — the socket handler uses a
 * different ladder for elementa / specter targets (Core p.159 sidebar).
 */
export function critSeverityFromDelta(delta) {
    if (!Number.isFinite(delta) || delta < 7) return null;
    if (delta >= 15) return "deadly";
    if (delta >= 13) return "difficult";
    if (delta >= 10) return "complex";
    return "simple";
}
