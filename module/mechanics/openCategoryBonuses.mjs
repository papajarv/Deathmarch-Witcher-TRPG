/**
 * Open-category weapon-quality bonuses (Equipment Overhaul).
 *
 * Some EO qualities — Throwing, Two-Hand, Close Quarters, Strangling,
 * Foraging, Crafting — give the weapon "the indicated benefits" when used
 * in the relevant context. The actual benefit is per-weapon authored text
 * stored in `system.qualityValues[qualityKey]` (e.g. an Eating Knife says
 * "+1 WA, +1d6 Dmg" for Close Quarters; a Bastard Sword says different
 * text for Two-Hand).
 *
 * This module parses that authored text and surfaces the parsed bonus to
 * the attack pipeline. Two pieces are extracted automatically:
 *
 *   - `+N WA`     → folded into the to-hit total (modifier chip)
 *   - `+Nd6 Dmg`  → appended to the damage formula (flat extra dice,
 *                   added OUTSIDE the strike multiplier so a Strong
 *                   Strike doesn't double the +1d6 from a Close Quarters
 *                   tag — mirrors Adrenaline dice handling)
 *
 * The full `raw` text is always echoed in the chat-card rider so any
 * unparsed clause (range bonus, special status, etc.) is still visible
 * to the table for manual resolution.
 *
 * Detection is context-driven (passed in by the caller):
 *   - closeQuarters: target is in a hold (clinch / grapple / pin /
 *                    chokehold) with the attacker, OR the attack itself
 *                    is the Clinch CE action.
 *   - twoHand:       weapon is being wielded two-handed at attack time
 *                    (system.twoHandMode === true on a one-handed weapon
 *                    that lists Two-Hand, OR a baseline two-handed
 *                    weapon).
 *   - throwing:      the strike is a Throw action (placeholder until a
 *                    dedicated throw flow exists — flag carried on the
 *                    strike meta).
 *   - strangling:    the strike is the Chokehold CE action.
 *
 * Foraging / Crafting are non-combat qualities — they don't surface in
 * the attack pipeline; their `qualityValues` text is displayed in the
 * inventory tooltip via the existing `qualityLabels` machinery (no
 * separate wire needed).
 */

import { WEAPON_QUALITIES } from "../setup/config.mjs";

/** Keys of EO qualities whose benefit is per-weapon authored text. The
 *  attack pipeline checks each one with a context predicate. Order is
 *  the chip display order. */
export const OPEN_CATEGORY_QUALITY_KEYS = Object.freeze([
    "closeQuarters",
    "twoHand",
    "throwing",
    "strangling"
]);

/** Build a label→key index for the active WEAPON_QUALITIES catalog so the
 *  parser can detect "Armor Piercing" / "Improved Armor Piercing" /
 *  "Balanced" etc. in the free-form bonus text and surface them as
 *  granted qualities. Memoized at first call. */
let _labelIndex = null;
function labelIndex(catalog = WEAPON_QUALITIES) {
    if (_labelIndex) return _labelIndex;
    const idx = new Map();
    for (const [key, entry] of Object.entries(catalog)) {
        if (entry?.label) idx.set(entry.label.toLowerCase(), key);
    }
    _labelIndex = idx;
    return idx;
}

/** Parse the GM-authored bonus text on a parameterized open-category
 *  quality. Recognized fragments:
 *    "+N WA"   → wa: N           (also "+N Acc" / "+N Hit")
 *    "+Nd6 Dmg" / "+NdM dmg" / "+NdM damage" → dmgDice: "NdM"
 *    a quality LABEL match (e.g. "Armor Piercing", "Improved Armor
 *      Piercing", "Balanced") → grantedQualities: [<catalog key>, ...]
 *
 *  Multiple fragments may be comma-separated. Unrecognized text is left
 *  in `raw` for manual surfacing. Returns null when text is empty.
 *
 *  Examples this now handles correctly:
 *    "+1 WA, +1d6 Dmg"                            → wa=1, dmgDice=1d6
 *    "+2 WA, +1d6 Dmg, Improved Armor Piercing"   → wa=2, dmgDice=1d6,
 *                                                   grantedQualities=["improvedArmorPiercing"]
 *    "Armor Piercing"                             → grantedQualities=["armorPiercing"]
 *    "+1 WA, Balanced"                            → wa=1, grantedQualities=["balanced"] */
export function parseOpenCategoryBonus(text, catalog = WEAPON_QUALITIES) {
    const raw = String(text ?? "").trim();
    if (!raw) return null;
    let wa = 0;
    let dmgDice = "";
    let dmgFlat = 0;
    const grantedQualities = [];
    const grantedQualityValues = {};
    /* +N WA — capture an optional sign and a number followed by WA / Acc / Hit. */
    const waMatch = raw.match(/([+-]?\d+)\s*(?:WA|Acc|Hit|to-hit)\b/i);
    if (waMatch) {
        const n = Number(waMatch[1]);
        if (Number.isFinite(n)) wa = n;
    }
    /* +Nd6 Dmg / +NdM dmg / +NdM damage — capture the dice expression. */
    const dmgMatch = raw.match(/\+\s*(\d+\s*d\s*\d+)\s*(?:Dmg|damage|dmg)?\b/i);
    if (dmgMatch) {
        dmgDice = dmgMatch[1].replace(/\s+/g, "").toLowerCase();
    }
    /* +N Dmg (flat, no dice) — for weapons that grant a static bonus like
     * Doryo's "+2 Dmg" on twoHand. Require the trailing Dmg/damage keyword
     * so this doesn't collide with the WA capture above. Skip if a dice
     * expression already captured a leading `NdM` on the same line
     * (dmgDice takes precedence — they don't stack from the same clause). */
    if (!dmgDice) {
        const flatMatch = raw.match(/\+\s*(\d+)\s*(?:Dmg|damage|dmg)\b/i);
        if (flatMatch) {
            const n = Number(flatMatch[1]);
            if (Number.isFinite(n)) dmgFlat = n;
        }
    }
    /* Quality-label detection. Walk catalog labels longest-first so the
     * matcher captures "Improved Armor Piercing" before "Armor Piercing"
     * (the substring would otherwise hit the shorter label too). Case-
     * insensitive whole-word match against the free-form text.
     *
     * Parameterized granted qualities accept an inline value in parens
     * — e.g. "Bleeding(25%)", "Stun(-2)", "Silver(2d6)". The parser
     * captures the parens-payload into `grantedQualityValues[key]`
     * (suffix stripped to match the inline-value convention). Round-
     * tripping with the dialog formatter preserves the value. */
    const idx = labelIndex(catalog);
    const labels = [...idx.keys()].sort((a, b) => b.length - a.length);
    let scratch = raw;
    for (const label of labels) {
        /* Skip generic single-word tokens that overlap with the WA/dmg
         * grammar — these aren't qualities the GM would write here. */
        if (label === "wa" || label === "acc" || label === "hit") continue;
        /* Skip OPEN-CATEGORY quality labels so they can never be granted
         * from within another OC's bonus text. Without this gate, a GM
         * (or a pack import mistake) authoring `throwing: "+2 WA, Close
         * Quarters"` would have the chip row show "Close Quarters" as
         * granted, which is misleading — the CQ bonus itself would NOT
         * apply (that's gated separately on `qs.includes("closeQuarters")`
         * and the CQ context predicate), but the chip alone is enough
         * user confusion. The structured OC config dialog already skips
         * these keys via SKIP_KEYS; the parser is the raw-text path. */
        const grantedKey = idx.get(label);
        if (grantedKey && OPEN_CATEGORY_QUALITY_KEYS.includes(grantedKey)) continue;
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        /* Label optionally followed by a (value) clause. The label
         * matches whole-word; the parens group is optional. */
        const re = new RegExp(`\\b${escaped}\\b\\s*(?:\\(\\s*([^)]+?)\\s*\\))?`, "i");
        const m = scratch.match(re);
        if (m) {
            const key = idx.get(label);
            if (key && !grantedQualities.includes(key)) grantedQualities.push(key);
            if (key && m[1] != null) {
                const v = String(m[1]).trim();
                if (v) grantedQualityValues[key] = v;
            }
            /* Consume the matched text from scratch so a longer-label
             * match doesn't double-count its sub-tokens. Use the full
             * match (label + optional parens) so the value text isn't
             * picked up by a separate sub-label match. */
            scratch = scratch.replace(m[0], " ");
        }
    }
    return { wa, dmgDice, dmgFlat, grantedQualities, grantedQualityValues, raw };
}

/** Detection predicates for each open-category quality given the attack
 *  context. Centralised so the same logic powers the chat-card rider AND
 *  the to-hit/damage application. */
function contextFires(qualityKey, ctx) {
    switch (qualityKey) {
        case "closeQuarters": return !!ctx.isCloseQuartersContext;
        case "twoHand":       return !!ctx.isTwoHandedWield;
        case "throwing":      return !!ctx.isThrown;
        case "strangling":    return !!ctx.isChokehold;
        default:              return false;
    }
}

/** Return the active open-category bonuses for a weapon in the given
 *  context. Each entry is `{ key, label, wa, dmgDice, raw }`. Only
 *  qualities whose context predicate fires AND whose authored text
 *  parses to a non-empty bonus appear in the list. The GM authoring an
 *  empty parameter for a quality is intentional ("the bonus is purely
 *  narrative for this weapon") — no chip, no apply. */
export function getActiveOpenCategoryBonuses(weapon, ctx = {}, catalog = WEAPON_QUALITIES) {
    if (!weapon) return [];
    const qs   = weapon?.system?.effective?.qualities      ?? weapon?.system?.qualities      ?? [];
    const qVal = weapon?.system?.effective?.qualityValues  ?? weapon?.system?.qualityValues  ?? {};
    const out = [];
    for (const key of OPEN_CATEGORY_QUALITY_KEYS) {
        if (!qs.includes(key)) continue;
        if (!contextFires(key, ctx)) continue;
        const parsed = parseOpenCategoryBonus(qVal[key]);
        if (!parsed) continue;
        const label = catalog?.[key]?.label ?? key;
        out.push({ key, label, ...parsed });
    }
    return out;
}

/** Sum the +WA contributions of an active-bonus list (for folding into
 *  the to-hit total). */
export function sumOpenCategoryWa(activeBonuses) {
    let n = 0;
    for (const b of activeBonuses) n += Number(b.wa) || 0;
    return n;
}

/** Concatenate the +NdM dice AND +N flat fragments into a single damage
 *  tail that can be appended OUTSIDE the strike multiplier. Returns "" when
 *  none. Each active bonus can contribute at most one dice fragment and one
 *  flat fragment; both are appended when present. */
export function damageTailFromOpenCategory(activeBonuses) {
    const parts = [];
    for (const b of activeBonuses) {
        if (b?.dmgDice) parts.push(String(b.dmgDice));
        const flat = Number(b?.dmgFlat) || 0;
        if (flat !== 0) parts.push(String(flat));
    }
    return parts.length ? parts.map(p => `+ ${p}`).join(" ") : "";
}

/** Flatten the granted-quality keys across all active open-category
 *  bonuses, deduped. The attack pipeline merges these into the weapon's
 *  effective qualities for the duration of the strike — so an Estoc's
 *  "Close Quarters (Improved Armor Piercing)" actually fires its
 *  Improved Armor Piercing rider when the target is in a hold. */
export function grantedQualitiesFromOpenCategory(activeBonuses) {
    const out = [];
    for (const b of activeBonuses) {
        for (const q of (b.grantedQualities ?? [])) {
            if (!out.includes(q)) out.push(q);
        }
    }
    return out;
}

/** Merge the per-granted-quality values captured by the parser across
 *  all active open-category bonuses. Returns `{ <key>: value, … }` —
 *  e.g. `{ bleeding: "25%" }`. Used by the attack pipeline to populate
 *  `riderPayload.values` so post-hit status riders fire with the
 *  authored magnitude (Bleeding %, Stun TN, Silver dice, …) instead of
 *  defaulting to 0. Later bonuses overwrite earlier ones on conflict
 *  (rare — a single weapon would have to carry two open-category
 *  qualities granting the same downstream quality). */
export function grantedQualityValuesFromOpenCategory(activeBonuses) {
    const out = {};
    for (const b of activeBonuses) {
        const v = b.grantedQualityValues;
        if (!v) continue;
        for (const [k, val] of Object.entries(v)) {
            if (val != null && String(val).trim() !== "") out[k] = val;
        }
    }
    return out;
}
