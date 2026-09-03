/**
 * RAW armor layering (Core p.154–155).
 *
 * "Layering armor may seem like a good idea … Unfortunately it doesn't work
 * like that." The rulebook models stacked armor with three mechanics, all
 * implemented here as PURE functions (no Foundry globals) so they can be
 * unit-tested and shared by every surface that resolves armor:
 *
 *   1. SP does NOT sum. Any layer lighter than your heaviest layer acts as a
 *      buffer. Combined SP = stronger + min(weaker, bonus(stronger − weaker)),
 *      where bonus() reads the p.155 table. Three layers fold in pairs,
 *      strongest-first ("compare the augmented strength to the third set").
 *
 *   2. EV is cumulative: combine each layer's EV, then add +1 per layer of
 *      medium armor and +2 per layer of heavy armor. We apply that surcharge
 *      ONLY to pieces that are actually layered (share a covered body zone
 *      with another worn piece) — a lone piece keeps its base EV.
 *
 *   3. Stacking limits: at most three layers on a body zone, and at most one
 *      layer of heavy AND one layer of medium per zone.
 *
 * Resistances and special effects "carry over but do not stack" — that clause
 * is enforced at the call sites (deduped resistance Set / DR list), not here.
 *
 * These helpers are RAW-only; the Equipment-Overhaul armor model keeps its
 * own max-of-layers behavior and does not call in here.
 */

/* Difference in the two layers' SP → the cap on how much of the WEAKER
 * layer's SP is added to the stronger (Core p.155):
 *     0–4 → +5,  5–8 → +4,  9–14 → +3,  15–20 → +2.
 * The printed table stops at 20; past that the lighter layer is a negligible
 * buffer, so we extrapolate the descending step to +1 (GM-tunable if desired). */
export function layerSpBonus(diff) {
    const d = Math.abs(Number(diff) || 0);
    if (d <= 4)  return 5;
    if (d <= 8)  return 4;
    if (d <= 14) return 3;
    if (d <= 20) return 2;
    return 1;
}

/** Combine two layers at one location: the stronger SP plus as much of the
 *  weaker layer's SP as the table allows (never more than the weaker layer
 *  actually has). A non-positive weaker layer adds nothing. */
export function combineTwoLayers(a, b) {
    const strong = Math.max(Number(a) || 0, Number(b) || 0);
    const weak   = Math.min(Number(a) || 0, Number(b) || 0);
    if (weak <= 0) return strong;
    return strong + Math.min(weak, layerSpBonus(strong - weak));
}

/** Combine an arbitrary set of layer SP values covering ONE location. RAW
 *  (Core p.155) folds the layers in pairs from WEAKEST to strongest: "compare
 *  your first and second layers … then compare that augmented strength to the
 *  third set" — the first layer being the weakest (innermost) and the third the
 *  strongest (outermost). So: augment the two weakest layers, then fold that
 *  augmented SP against the next-strongest, and so on. The per-pair math is
 *  order-agnostic (combineTwoLayers picks stronger/weaker itself); only the
 *  fold order matters, so we sort ASCENDING first. Returns 0 for no layers and
 *  the lone value for one. */
export function combineLayeredSP(spValues) {
    const vals = (spValues ?? [])
        .map(v => Number(v) || 0)
        .filter(v => v > 0)
        .sort((a, b) => a - b);
    if (!vals.length) return 0;
    return vals.reduce((acc, v) => combineTwoLayers(acc, v));
}

/* ── Combat Extended layering model ───────────────────────────────────────
 * With the Equipment-Overhaul / Combat Extended armor model on (isCESubsystem
 * Enabled("eoArmorModel")), layered SP combines differently from RAW: the
 * stronger layer's SP plus a QUARTER (floored) of the weaker layer's SP. Three
 * layers fold WEAKEST-FIRST in pairs, exactly like the RAW structure — the
 * augmented value carries forward (so 6/16/24 → 28, not the flat-sum 29).
 * Under this model the RAW EV surcharge and stacking limits do NOT apply
 * (Equipment Overhaul has its own encumbrance rules); ablation still chips
 * every layer equally. */
export function combineTwoLayersCE(a, b) {
    const strong = Math.max(Number(a) || 0, Number(b) || 0);
    const weak   = Math.min(Number(a) || 0, Number(b) || 0);
    if (weak <= 0) return strong;
    return strong + Math.floor(weak / 4);
}

/** Combine layer SP at one location under the CE model. Folds weakest-first
 *  (sorted ascending) so the augmented value carries into the next pair, per
 *  the "solve in pairs" rule. Returns 0 for no layers, the lone value for one. */
export function combineLayeredSPCE(spValues) {
    const vals = (spValues ?? [])
        .map(v => Number(v) || 0)
        .filter(v => v > 0)
        .sort((a, b) => a - b);
    if (!vals.length) return 0;
    return vals.reduce((acc, v) => combineTwoLayersCE(acc, v));
}

/** Model-aware SP combine: CE (`ceModel` truthy) → quarter-of-weaker fold;
 *  otherwise the RAW buffer table. Single seam so every SP site branches the
 *  same way. */
export function combineLayeredSPFor(spValues, ceModel) {
    return ceModel ? combineLayeredSPCE(spValues) : combineLayeredSP(spValues);
}

/* Which body zones a piece's `location` enum covers. The SP fields are per
 * fine slot (leftArm/rightArm/…), but the coarse `location` value is the
 * authoritative coverage declaration used for EV-overlap + stacking limits. */
const ZONES_OF_LOCATION = {
    head:  ["head"],
    torso: ["torso"],
    arms:  ["arms"],
    legs:  ["legs"],
    full:  ["head", "torso", "arms", "legs"]
};

export function zonesCovered(location) {
    return ZONES_OF_LOCATION[String(location ?? "").toLowerCase()] ?? [];
}

/* Fine SP slots that make up each zone (an "arms"/"legs" zone spans both
 * limbs; a piece's SP for the zone is the stronger of its two slots). */
const ZONE_SLOTS = {
    head:  ["head"],
    torso: ["torso"],
    arms:  ["leftArm", "rightArm"],
    legs:  ["leftLeg", "rightLeg"]
};

/* Default per-slot CURRENT SP reader (post-enhancement effective wins over
 * base). Drives the SP COMBINATION math — an ablated layer at 0 current SP
 * provides no buffer. */
const _defaultSpAt = (p, slot) =>
    Number(p?.system?.effective?.stopping?.[slot]?.value ?? p?.system?.[`${slot}Stopping`]) || 0;

/* Default per-slot MAX SP reader. Drives LAYER MEMBERSHIP — a piece with any
 * max stopping is a physical layer even after its current SP is ablated to 0,
 * so counting uses max, not current. */
const _defaultMaxSpAt = (p, slot) =>
    Number(p?.system?.effective?.stopping?.[slot]?.max ?? p?.system?.[`${slot}MaxStopping`]) || 0;

/** Zones where a piece COUNTS AS A LAYER. RAW: armor must have at least 1 SP to
 *  layer — but that's MAX SP, so armor ablated to 0 current SP is still a layer.
 *  A piece only layers at a zone it actually protects (max SP > 0 there); 0-max
 *  clothes and unprotected zones don't consume a layer. This (not the coarse
 *  `location` enum) drives every layer count: EV surcharge, stacking limits,
 *  and the inventory readout. Layers are per-zone, so pieces that never overlap
 *  a zone never layer with each other. */
export function layeredZonesOf(piece, maxSpAt = _defaultMaxSpAt) {
    const out = [];
    for (const [zone, slots] of Object.entries(ZONE_SLOTS)) {
        if (slots.some(s => (Number(maxSpAt(piece, s)) || 0) > 0)) out.push(zone);
    }
    return out;
}

const SURCHARGE_BY_TYPE = { medium: 1, heavy: 2 };

/** RAW EV surcharge for a set of worn armor pieces: +1 per layered medium
 *  piece, +2 per layered heavy piece. "Layered" = shares a covered body zone
 *  with at least one other worn piece, so a single/non-overlapping piece
 *  contributes nothing (keeps its base EV — no change to unlayered loadouts).
 *
 *  Only pieces with MAX SP > 0 count as layers (see layeredZonesOf).
 *
 *  @param pieces      array of worn armor items (shields pre-filtered)
 *  @param armorTypeOf (piece) → "light"|"medium"|"heavy"  (default reads system)
 *  @param maxSpAt     (piece, slot) → MAX SP number       (default reads system) */
export function layeringEvSurcharge(pieces, { armorTypeOf, maxSpAt = _defaultMaxSpAt } = {}) {
    const list = Array.isArray(pieces) ? pieces : [];
    const typeOf = armorTypeOf ?? (p => p?.system?.armorType);

    const zoneCount = {};
    const perPieceZones = list.map(p => {
        const zs = layeredZonesOf(p, maxSpAt);
        for (const z of zs) zoneCount[z] = (zoneCount[z] || 0) + 1;
        return zs;
    });

    let surcharge = 0;
    list.forEach((p, i) => {
        const layered = perPieceZones[i].some(z => zoneCount[z] >= 2);
        if (!layered) return;
        surcharge += SURCHARGE_BY_TYPE[String(typeOf(p) ?? "").toLowerCase()] ?? 0;
    });
    return surcharge;
}

/* Read an armor piece's active quality keys (post-enhancement effective wins). */
const _defaultQualitiesOf = (p) => {
    const q = p?.system?.effective?.qualities ?? p?.system?.qualities ?? [];
    return Array.isArray(q) ? q : [];
};
const _isStifling = (p, qOf) => qOf(p).includes("stifling");

/** Stacking-limit check for equipping `candidate` on top of the already-worn
 *  `others`. Returns an array of `{ kind, zone }` violations; empty = legal.
 *  Kinds:
 *   - "twoStifling"  — a stifling piece can't layer with another stifling
 *                      piece (Stifling quality, config.mjs). UNIVERSAL: fires
 *                      under both the RAW and CE models.
 *   - "maxLayers" / "secondHeavy" / "secondMedium" — RAW-only count/type caps
 *                      (3 layers, 1 heavy + 1 medium per zone); suppressed when
 *                      `ceModel` is set (CE has no such limits).
 *  Pure — the caller localizes and decides warn-vs-block. */
export function layeringLimitViolations(candidate, others, { armorTypeOf, maxSpAt = _defaultMaxSpAt, qualitiesOf, ceModel = false } = {}) {
    const typeOf = armorTypeOf ?? (p => p?.system?.armorType);
    const qOf    = qualitiesOf ?? _defaultQualitiesOf;
    const worn   = Array.isArray(others) ? others : [];

    const candZones    = layeredZonesOf(candidate, maxSpAt);
    const candType     = String(typeOf(candidate) ?? "").toLowerCase();
    const candStifling = _isStifling(candidate, qOf);
    const out = [];
    for (const z of candZones) {
        const here = worn.filter(o => layeredZonesOf(o, maxSpAt).includes(z));
        // Stifling — universal (both models).
        if (candStifling && here.some(o => _isStifling(o, qOf)))
            out.push({ kind: "twoStifling", zone: z });
        // RAW count / type caps — RAW model only.
        if (!ceModel) {
            if (here.length + 1 > 3) out.push({ kind: "maxLayers", zone: z });
            if (candType === "heavy"  && here.some(o => String(typeOf(o)).toLowerCase() === "heavy"))
                out.push({ kind: "secondHeavy", zone: z });
            if (candType === "medium" && here.some(o => String(typeOf(o)).toLowerCase() === "medium"))
                out.push({ kind: "secondMedium", zone: z });
        }
    }
    return out;
}

/** Per-zone layering readout for the inventory panel. Reports only zones that
 *  are actually layered (2+ SP-bearing pieces — see layeredZonesOf): the layer
 *  count, the RAW cap (3), the combined SP and how much of it is the LAYERING
 *  BONUS (combined − the strongest single layer), and whether the RAW type
 *  limits (1 heavy + 1 medium) are exceeded. Also returns the total EV
 *  surcharge. Pure — accessors default to reading the item's system data
 *  (effective SP wins over base).
 *
 *  @returns { zones: [{ zone, count, max, combinedSP, bonusSP, overCap,
 *                       secondHeavy, secondMedium }], evSurcharge } */
export function layeringReadout(pieces, { armorTypeOf, spAt, maxSpAt, ceModel = false } = {}) {
    const list    = Array.isArray(pieces) ? pieces : [];
    const typeOf  = armorTypeOf ?? (p => String(p?.system?.armorType ?? "").toLowerCase());
    const spOf    = spAt    ?? _defaultSpAt;      // current SP → combined-SP / bonus
    const maxSpOf = maxSpAt ?? _defaultMaxSpAt;   // max SP → layer membership

    const zones = [];
    for (const [zone, slots] of Object.entries(ZONE_SLOTS)) {
        // A piece is a layer here if it has MAX SP > 0 at this zone (an ablated
        // 0-current layer still counts); the combined SP below uses current SP.
        const covering = list.filter(p => layeredZonesOf(p, maxSpOf).includes(zone));
        if (covering.length < 2) continue;   // only report actually-layered zones
        const spList    = covering.map(p => Math.max(0, ...slots.map(s => spOf(p, s))));
        const combined  = combineLayeredSPFor(spList, ceModel);
        const maxSingle = Math.max(0, ...spList);
        zones.push({
            zone,
            count:        covering.length,
            max:          3,
            combinedSP:   combined,
            bonusSP:      Math.max(0, combined - maxSingle),
            // The RAW type limits (over-cap / 2nd heavy / 2nd medium) don't
            // apply under the CE model, so don't flag them there.
            overCap:      !ceModel && covering.length > 3,
            secondHeavy:  !ceModel && covering.filter(p => typeOf(p) === "heavy").length  > 1,
            secondMedium: !ceModel && covering.filter(p => typeOf(p) === "medium").length > 1,
            // Stifling is a universal constraint — flagged under both models.
            twoStifling:  covering.filter(p => _isStifling(p, _defaultQualitiesOf)).length > 1
        });
    }
    return {
        zones,
        // RAW EV surcharge only — the CE model uses its own encumbrance rules.
        evSurcharge: ceModel ? 0 : layeringEvSurcharge(list, { armorTypeOf: typeOf, maxSpAt: maxSpOf }),
        ceModel
    };
}

/** Pre-equip layering GATE. Returns the layering violations that equipping
 *  `item` on `actor` would cause (empty array = allowed). When non-empty it
 *  surfaces ONE "can't equip" notification, so the caller refuses the equip
 *  (`if (layeringEquipBlock(...).length) return;`). Must run BEFORE the equip
 *  write — the candidate need NOT already be equipped; the worn set excludes it
 *  by id. No-op (allowed) for non-armor, shields, or outside a Foundry client.
 *  Pure-ish: reads globals defensively so the unit tests never touch game/ui. */
export function layeringEquipBlock(actor, item, { ceModel = false } = {}) {
    if (!actor || item?.type !== "armor") return [];
    const isShield = (a) => String(a?.system?.armorType).toLowerCase() === "shield"
                         || String(a?.system?.location) === "Shield";
    if (isShield(item)) return [];
    const all  = actor.items?.contents ?? actor.items ?? [];
    const worn = [...all].filter(a =>
        a?.id !== item.id && a?.type === "armor" && a?.system?.equipped && !isShield(a));
    const violations = layeringLimitViolations(item, worn, { ceModel });
    if (!violations.length) return violations;
    const i18n = globalThis.game?.i18n ?? null;
    const L = (key, fb) => (i18n?.localize ? (i18n.localize(key) || fb) : fb);
    /* One reason per violated rule (deduped across zones), joined into a single
     * refusal notification. */
    const kinds = new Set(violations.map(v => v.kind));
    const reasons = [];
    if (kinds.has("twoStifling"))  reasons.push(L("WITCHER.Mech.ArmorLayering.Warn.TwoStifling",  "stifling armor can't layer with other stifling armor"));
    if (kinds.has("maxLayers"))    reasons.push(L("WITCHER.Mech.ArmorLayering.Warn.MaxLayers",    "max 3 layers per location"));
    if (kinds.has("secondHeavy"))  reasons.push(L("WITCHER.Mech.ArmorLayering.Warn.SecondHeavy",  "only one heavy layer per location"));
    if (kinds.has("secondMedium")) reasons.push(L("WITCHER.Mech.ArmorLayering.Warn.SecondMedium", "only one medium layer per location"));
    const msg = i18n?.format
        ? (i18n.format("WITCHER.Mech.ArmorLayering.Warn.EquipBlocked", { item: item.name, reasons: reasons.join("; ") })
            || `Can't equip ${item.name}: ${reasons.join("; ")}.`)
        : `Can't equip ${item.name}: ${reasons.join("; ")}.`;
    globalThis.ui?.notifications?.warn(msg);
    return violations;
}
