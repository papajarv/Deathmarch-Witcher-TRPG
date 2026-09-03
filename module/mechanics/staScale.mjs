/**
 * Shared stamina-scaling primitive for status riders.
 *
 * A `scale = { offset, divisor, cap, baseSta, maxSta }` block encodes
 * "how does this value grow with the stamina the caster spends?" — one
 * formula, one place. Consumers:
 *
 *   sheets/item/statusRiders.buildStaScaleLadder   — UI live preview
 *   mechanics/spellHandlers.resolveSchemaRiderFlags — onHit apply routing
 *   mechanics/zoneEffects (resolveStaScale)         — zone-enter routing
 *
 * Semantics (see spell.mjs schema comment for authorial docs):
 *   sta_effective = clamp(sta, baseSta, maxSta || Infinity)
 *   steps         = 1 + floor((sta_effective - baseSta) / divisor)
 *   value         = offset * steps
 *   value         = clamp(value, cap)   // cap<0 clamps from above, cap>0 from below
 *
 * Returns `null` for sta below baseSta (rider doesn't scale below its
 * activation threshold) or when the scale is at its all-default state
 * (no scaling authored).
 */

/** Preview ceiling for the ladder builder when maxSta isn't set. */
export const MAX_STA_SAMPLE = 10;

/** True when the scale carries any authored value that changes behavior
 *  from the schema's all-defaults state. */
export function scaleHasValue(scale) {
    if (!scale) return false;
    const offset  = Number(scale.offset)  || 0;
    const divisor = Number(scale.divisor) || 1;
    const cap     = Number(scale.cap)     || 0;
    const baseSta = Number(scale.baseSta) || 1;
    const maxSta  = Number(scale.maxSta)  || 0;
    return offset !== 0 || divisor !== 1 || cap !== 0 || baseSta !== 1 || maxSta !== 0;
}

/** Resolve the scale at a specific stamina level. Returns `null` when the
 *  scale is default-off OR the stamina is below the activation threshold. */
export function resolveScaleAt(scale, sta) {
    if (!scaleHasValue(scale)) return null;
    const offset  = Number(scale.offset)  || 0;
    const divisor = Math.max(1, Number(scale.divisor) || 1);
    const cap     = Number(scale.cap)     || 0;
    const baseSta = Math.max(1, Number(scale.baseSta) || 1);
    const maxSta  = Math.max(0, Number(scale.maxSta)  || 0);
    const staN    = Math.max(0, Number(sta) || 0);
    if (staN < baseSta) return null;   // below activation → no scaling
    const effSta  = maxSta > 0 ? Math.min(staN, maxSta) : staN;
    const steps   = 1 + Math.floor((effSta - baseSta) / divisor);
    let value = offset * steps;
    if (cap < 0) value = Math.max(value, cap);
    else if (cap > 0) value = Math.min(value, cap);
    return value;
}

/** Effective chance % for a rider at a given cast stamina. When the
 *  rider's staScaleTarget is "chance", the scaled value is ADDED to
 *  the base chance (clamped 0–100); otherwise the base chance is
 *  returned unchanged. Semantics: the rider's chance % is the "floor
 *  at minimum stamina" and scaling adds a bonus as more stamina is
 *  poured in — bigger casts more reliably land the effect. Used by
 *  castSpellMixin's rider dispatch so both onHit routes (defense-
 *  fanout + auto-hit fallback) produce the same chance value. */
export function resolveRiderChance(rider, sta) {
    // Distinguish an EXPLICIT 0 ("never") from an empty/absent field. A cleared
    // field must fall back to the schema default (100), not silently become 0%
    // — `Number(rider?.chance) || 0` used to turn a blank into a rider that
    // never fires. An explicit 0 is preserved as 0.
    const _rawChance = rider?.chance;
    const _n = (_rawChance === "" || _rawChance == null) ? 100 : Number(_rawChance);
    const base = Math.max(0, Math.min(100, Number.isFinite(_n) ? _n : 100));
    if (rider?.staScaleTarget !== "chance") return base;
    const bonus = resolveScaleAt(rider?.staScale, sta);
    if (bonus === null) return base;
    return Math.max(0, Math.min(100, base + bonus));
}

/** Build the live-preview ladder for the config sheet. Samples every
 *  stamina from baseSta upward, pushes a rung only when the value
 *  changes from the previous rung, stops once the cap is reached
 *  (marks the last rung `atCap:true`) or the maxSta / MAX_STA_SAMPLE
 *  ceiling is hit. Returns [] for the default no-scaling state so the
 *  template hides the preview.
 *
 *  opts.combine(raw) → transforms the raw scaled value BEFORE the
 *      dedup check (so a chance ladder that saturates at 100% shows
 *      one rung, not five). Defaults to identity.
 *  opts.format(combined) → stringifies the (possibly-combined) value
 *      for display. Defaults to signed integer ("+3" / "-1" / "0"). */
export function buildLadder(scale, opts = {}) {
    if (!scaleHasValue(scale)) return [];
    const combine = typeof opts.combine === "function" ? opts.combine : (v) => v;
    const format  = typeof opts.format  === "function" ? opts.format  : (v) => v > 0 ? `+${v}` : String(v);
    const cap     = Number(scale.cap)     || 0;
    const baseSta = Math.max(1, Number(scale.baseSta) || 1);
    const maxSta  = Math.max(0, Number(scale.maxSta)  || 0);
    const upper   = maxSta > 0 ? Math.min(maxSta, MAX_STA_SAMPLE * 2) : MAX_STA_SAMPLE;
    const rungs = [];
    let lastCombined = null;
    for (let sta = baseSta; sta <= upper; sta++) {
        const raw = resolveScaleAt(scale, sta);
        if (raw === null) continue;
        const combined = combine(raw);
        if (combined === lastCombined) continue;   // dedup on DISPLAYED value
        lastCombined = combined;
        let atCap = false;
        if (cap < 0 && raw <= cap) atCap = true;
        else if (cap > 0 && raw >= cap) atCap = true;
        else if (maxSta > 0 && sta === maxSta) atCap = true;   // hit stamina ceiling
        rungs.push({ sta, value: format(combined), atCap });
        if (atCap) break;
    }
    return rungs;
}
