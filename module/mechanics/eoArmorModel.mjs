/**
 * Equipment Overhaul armor model.
 *
 * Toggleable via the `eoArmorModel` Combat Extended subsystem. When ON:
 *
 *   1. Armor EV no longer subtracts from REF/DEX. Instead the total EV:
 *        - reduces max Stamina by `totalEv`
 *        - reduces RUN by `totalEv`, floor at 2×SPD
 *        - applies `floor(totalEv/2)` as a penalty to: Dodge, Athletics,
 *          Stealth, Sleight, Endurance, Hexweave, Ritcraft, Spellcast
 *
 *   2. Equipping armor flagged `difficult` requires a worn arming-jack-
 *      class item (a piece whose `armingJackKind` OR
 *      `armoredArmingJackUpgrade` is "jack" or "superiorSuit").
 *
 *   3. A worn Superior Arming Suit reduces each worn Difficult piece's
 *      contributed EV by 1 (minimum 0). The reduction is at most 1 per
 *      Difficult piece even with multiple superior suits worn (each
 *      Difficult piece is reduced ONCE — EO p.4 phrasing).
 *
 *   4. Per-location AE slots + a separate En (glyph) slot pool are read
 *      from `system.aeSlots` and `system.enhancementSlots` in lieu of the
 *      single RAW `armorEnhancement` bucket.
 */

import { isCESubsystemEnabled } from "../api/homebrew.mjs";

/* Skills that take the half-EV penalty per EO p.4. The character data
 * model reads this set and folds the penalty into each skill's modifier
 * during prepareDerivedData (same place the RAW magic-EV penalty is
 * applied today). */
export const EO_HALF_EV_SKILLS = new Set([
    "dodge", "athletics", "stealth", "sleight",
    "endurance", "hexweave", "ritcraft", "spellcast"
]);

/** True when the CE master toggle is on AND the per-subsystem
 *  eoArmorModel toggle is on. Safe in node test envs. */
export function isEoArmorModelOn() {
    try { return isCESubsystemEnabled("eoArmorModel"); }
    catch (_) { return false; }
}

/** True when this armor piece is an arming jack — either a dedicated
 *  jack/superior suit item OR an Aketon-style piece that paid the EO
 *  p.4 +100c/+750c upgrade. Both cases share the same flag:
 *  `armingJackKind` set to "jack" or "superiorSuit".
 *  (Legacy `armoredArmingJackUpgrade` still honored for backward
 *  compatibility with items authored before the field was retired.) */
export function isArmingJack(armor) {
    const kind = String(armor?.system?.armingJackKind ?? "none");
    if (kind === "jack" || kind === "superiorSuit") return true;
    const legacy = String(armor?.system?.armoredArmingJackUpgrade ?? "none");
    return legacy === "jack" || legacy === "superiorSuit";
}

/** True when this armor piece functions as a Superior Arming Suit.
 *  `armingJackKind === "superiorSuit"` on any piece fires unconditionally
 *  — covers both the dedicated "Superior Arming Suit" item and any
 *  Aketon-upgraded piece flagged as a superior suit.
 *
 *  Legacy `armoredArmingJackUpgrade === "superiorSuit"` is still honored
 *  for items authored before the field was retired, with the original
 *  paired-piece check intact: the upgrade only activates the superior-
 *  suit function when at least one OTHER piece in `wornSet` also has
 *  the same upgrade (per EO p.4: "this only functions when they are
 *  worn together"). New content should just use `armingJackKind`
 *  directly. */
export function isSuperiorArmingSuit(armor, wornSet = null) {
    const kind = String(armor?.system?.armingJackKind ?? "none");
    if (kind === "superiorSuit") return true;
    const upgrade = String(armor?.system?.armoredArmingJackUpgrade ?? "none");
    if (upgrade !== "superiorSuit") return false;
    if (!Array.isArray(wornSet)) return true;
    return wornSet.some(p => p !== armor
        && String(p?.system?.armoredArmingJackUpgrade ?? "none") === "superiorSuit");
}

/** True when this armor piece carries the Difficult property. The
 *  canonical home is `system.difficult` (boolean), but the catalog
 *  also defines a `difficult` ARMOR_QUALITIES chip — so an item with
 *  the chip checked but the legacy boolean unset still counts. Either
 *  signal is sufficient. */
export function isDifficultArmor(armor) {
    if (armor?.system?.difficult) return true;
    const qs = armor?.system?.effective?.qualities ?? armor?.system?.qualities ?? [];
    return Array.isArray(qs) && qs.includes("difficult");
}

/** Given a list of equipped armor pieces (excluding shields), return the
 *  effective EV contribution per piece, honoring the Superior Arming Suit
 *  reduction: any worn superior suit reduces each Difficult piece's EV
 *  by 1 (min 0). The reduction caps at 1 per Difficult piece regardless
 *  of how many superior suits are worn. Returns an array of
 *  `{ piece, ev }`. Non-armor / shields are not filtered here — the
 *  caller passes the pre-filtered list.
 *
 *  `opts.evOf(piece)` — optional accessor for the per-piece EV. Defaults
 *  to `piece.system.encumbranceValue`. Callers that have a derived
 *  effective EV (post-socketed-enhancement Gnomish `evMod`) should pass
 *  `evOf: a => a.system.effective?.encumbranceValue ?? a.system.encumbranceValue`. */
export function effectiveEvContributions(armorPieces, opts = {}) {
    const evOf = typeof opts.evOf === "function"
        ? opts.evOf
        : (p) => Number(p?.system?.encumbranceValue) || 0;
    const hasSuperior = armorPieces.some(p => isSuperiorArmingSuit(p, armorPieces));
    return armorPieces.map(p => {
        const baseEv = Number(evOf(p)) || 0;
        const reduce = (hasSuperior && isDifficultArmor(p)) ? 1 : 0;
        return { piece: p, ev: Math.max(0, baseEv - reduce) };
    });
}

/** Sum of effective EV across the given pieces (after Superior Arming
 *  Suit reductions). Accepts the same `opts.evOf` as
 *  `effectiveEvContributions`. */
export function totalEffectiveEv(armorPieces, opts = {}) {
    return effectiveEvContributions(armorPieces, opts).reduce((s, c) => s + c.ev, 0);
}

/** Equip-gate check: when CE+eoArmorModel is on, a Difficult armor piece
 *  may only be equipped if the actor already has (or will simultaneously
 *  equip) a worn arming-jack-class piece. Returns true if the gate
 *  passes, false to refuse. RAW (toggle off) always returns true. */
export function canEquipUnderEoModel(candidate, alreadyEquippedArmor) {
    if (!isEoArmorModelOn()) return true;
    if (!isDifficultArmor(candidate)) return true;
    return (alreadyEquippedArmor ?? []).some(p => isArmingJack(p));
}

/* ── Slot accounting (EO p.4) ─────────────────────────────────────────
 *
 * Two separate pools per armor piece:
 *   - aeSlots[location] — physical AE, per body location
 *   - enhancementSlots  — total glyph (En.) pool, location-agnostic
 *
 * Glyph enhancements (`type === "glyph"`) consume from the glyph pool.
 * Armor-mod enhancements (`type === "armor"`) consume from a specific
 * location's AE pool, tracked via `appliedEnhancements[i].location`.
 *
 * Rune (`type === "rune"`) and craftsman-weapon-mod (`type === "weapon"`)
 * are weapon-side and don't touch armor accounting. */

const LOCATIONS = Object.freeze(["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"]);

/** True when an enhancement consumes from the per-location AE pool
 *  (i.e. it's a physical armor mod, NOT a glyph). */
export function isPerLocationAe(enhancement) {
    return enhancement?.system?.type === "armor"
        || enhancement?.type === "armor";
}

/** True when an enhancement consumes from the total glyph (En.) pool. */
export function isGlyph(enhancement) {
    return enhancement?.system?.type === "glyph"
        || enhancement?.type === "glyph";
}

/** AE-slot capacity for a single location on this armor piece. Returns 0
 *  for an unknown location or a missing aeSlots map. */
export function aeSlotCap(armor, location) {
    const map = armor?.system?.aeSlots ?? {};
    return Number(map[location]) || 0;
}

/** Total AE-slot capacity across all locations on this armor piece. */
export function aeSlotCapTotal(armor) {
    const map = armor?.system?.aeSlots ?? {};
    let sum = 0;
    for (const loc of LOCATIONS) sum += Number(map[loc]) || 0;
    return sum;
}

/** Glyph (En.) slot capacity on this armor piece. */
export function glyphSlotCap(armor) {
    return Number(armor?.system?.enhancementSlots) || 0;
}

/** Count AE slots used at the given location (or all locations if
 *  `location` is null). Inspects `appliedEnhancements` entries — only
 *  rows whose `.location` matches AND whose resolved enhancement is a
 *  per-location AE count. When the resolver isn't available
 *  (uuid unresolvable), the `.location` tag alone counts as "in use" —
 *  this lets accounting stay consistent even when the source item is
 *  off-realm. */
export function aeSlotsUsed(armor, location = null) {
    const applied = armor?.system?.appliedEnhancements ?? [];
    let n = 0;
    for (const ref of applied) {
        if (!ref?.location) continue;
        if (location !== null && ref.location !== location) continue;
        n++;
    }
    return n;
}

/** Count glyph slots used — entries with NO location tag. (Under EO,
 *  glyphs are recorded without a location; under RAW, all entries lack
 *  a location, so this returns the full count — RAW callers should
 *  rely on the legacy single-bucket logic instead.) */
export function glyphSlotsUsed(armor) {
    const applied = armor?.system?.appliedEnhancements ?? [];
    return applied.filter(r => !r?.location).length;
}

/** List of locations covered by this armor piece that still have free
 *  AE slots. Used by the per-location attach picker. */
export function locationsWithFreeAeSlots(armor) {
    const out = [];
    for (const loc of LOCATIONS) {
        const cap = aeSlotCap(armor, loc);
        if (cap <= 0) continue;
        const used = aeSlotsUsed(armor, loc);
        if (used < cap) out.push({ key: loc, used, cap });
    }
    return out;
}
