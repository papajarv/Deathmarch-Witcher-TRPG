import { getActiveWeaponQualities, WEAPON_QUALITIES, ARMOR_LOCATION_COVERAGE, ARMOR_SLOTS } from "../../../setup/config.mjs";

/**
 * Enhancement derivation — shared helpers that fold socketed enhancement
 * contributions into a weapon's / armor's *effective* stats.
 *
 * Non-destructive: these read the live enhancement items referenced by a
 * parent's `appliedEnhancements` and return a fresh `effective` object.
 * The parent's base fields are never mutated, so detaching an enhancement
 * (removing the slot entry) reverts the item to its base stats on the next
 * data-prep cycle.
 *
 * Resolution is synchronous (`fromUuidSync`) because it runs inside
 * `prepareDerivedData`. Enhancements socketed into an item realistically
 * live in the same actor inventory or the world items collection, both of
 * which resolve synchronously. An unresolvable reference contributes
 * nothing (the slot still renders its cached name/img).
 */

/** Resolve the `appliedEnhancements` slot list to live enhancement system
 *  data. Returns an array of `{ name, img, system, baked }` for those that
 *  resolve.
 *
 *  Two paths, snapshot-preferred:
 *    1. Ref carries a `system` snapshot captured at attach time — the source
 *       item may have since been deleted from inventory (attach consumes it).
 *       Use the snapshot directly. This is the primary path for anything
 *       attached after the snapshot schema landed.
 *    2. Legacy worlds without a snapshot — fall back to `fromUuidSync` on
 *       the stored uuid. Compendium and world-still-resident items resolve;
 *       actor-embedded items resolve as long as the source hasn't been
 *       manually deleted.
 *
 *  The `baked` flag on the ref is passed through so downstream code can
 *  decide whether the SP contribution is already in the parent's base
 *  fields (skip the derived add) or still needs the modifier applied
 *  (legacy slots). */
export function resolveEnhancements(applied) {
    const out = [];
    if (!Array.isArray(applied)) return out;
    for (const ref of applied) {
        if (!ref) continue;
        /* Snapshot path — self-contained, no external lookup. Guarded on
         * non-empty system object so a bare `{ system: {} }` initial-value
         * ref doesn't get preferred over a working uuid resolution. */
        const snap = ref.system;
        if (snap && typeof snap === "object" && Object.keys(snap).length > 0) {
            out.push({
                name:     ref.name || "?",
                img:      ref.img  || "icons/svg/upgrade.svg",
                uuid:     ref.uuid || "",
                system:   snap,
                baked:    !!ref.baked,
                /* Zone tag the enhancement was attached to under EO
                 * (head / torso / arms / legs). Required by
                 * deriveArmorEffective's zone-scoped resistance merge:
                 * without it, resistances would fall back to the
                 * piece-wide branch and leak outside the applied zone. */
                location: ref.location ?? ""
            });
            continue;
        }
        /* Legacy uuid path. */
        if (!ref.uuid || typeof fromUuidSync !== "function") continue;
        let item = null;
        try { item = fromUuidSync(ref.uuid); } catch (_) { item = null; }
        if (!item || item.type !== "enhancement") continue;
        out.push({
            name:     item.name,
            img:      item.img,
            uuid:     ref.uuid,
            system:   item.system,
            baked:    false,
            location: ref.location ?? ""
        });
    }
    return out;
}

/** Fold a damage-formula fragment onto an accumulator with an explicit
 *  operator, so "2d6" + "+2" reads as "2d6 + 2" and "2d6" + "-1" as
 *  "2d6 - 1". Empty fragments are ignored. */
function foldDamage(acc, frag) {
    const f = (frag ?? "").toString().trim();
    if (!f) return acc;
    if (!acc) return f;
    if (f.startsWith("-")) return `${acc} - ${f.slice(1).trim()}`;
    if (f.startsWith("+")) return `${acc} + ${f.slice(1).trim()}`;
    return `${acc} + ${f}`;
}

/** Combine multiple param-value contributions for ONE quality key into a
 *  single stored value. Runes stack (house rule): when every contribution is
 *  numeric — percent chances ("30"), stun penalties ("-1"), focus values —
 *  they SUM, preserving an integer result (3× Fire 30 → "90", 3× Stun -1 →
 *  "-3"). Non-summable formulas (e.g. a "2d6" param) keep the first value.
 *  A single-element list passes through unchanged, so an un-stacked weapon is
 *  byte-identical to the pre-stacking behavior. */
function combineQualityValues(list) {
    if (!Array.isArray(list) || list.length === 0) return "";
    if (list.length === 1) return list[0];
    /* Only sum values that are PURE numbers (optional sign / decimal / a
     * trailing % suffix) — "30", "-1", "25%". Anything with letters (a dice
     * formula like "2d6") is NOT summable: fall back to the first so we never
     * corrupt "2d6" + "2d6" into "4". */
    const nums = list.map(v => {
        const s = String(v).trim();
        return /^-?\d+(?:\.\d+)?%?$/.test(s) ? Number(s.replace("%", "")) : null;
    });
    if (nums.every(n => n != null)) {
        return String(nums.reduce((a, b) => a + b, 0));
    }
    return list[0];
}

/** Compute a weapon's effective stats from its base system data + socketed
 *  enhancements. Returns the `effective` object to assign in
 *  prepareDerivedData. */
export function deriveWeaponEffective(sys) {
    const enh = resolveEnhancements(sys.appliedEnhancements);

    let accuracy       = Number(sys.accuracy) || 0;
    let reliabilityMax = Number(sys.reliability?.max) || 0;
    let damage         = (sys.damage ?? "").toString().trim();
    const damageTypes  = new Set(sys.damageTypes ?? []);
    const qualities    = new Set(sys.qualities ?? []);
    /* Quality parameter values STACK across socketed runes (house rule): we
     * collect every contribution — the weapon's own base value first, then
     * each rune's — and fold them in a second pass (see combineQualityValues).
     * Boolean qualities (Armor Piercing, Silver, …) carry no value so they
     * never stack: a stack of AP runes stays plain Armor Piercing and is NEVER
     * promoted to Improved Armor Piercing. Elemental bonus-damage DICE already
     * stack separately through the `damageBonus` fold above. */
    const valueContribs = {};
    const pushVal = (k, v) => {
        if (v == null || v === "") return;
        (valueContribs[k] ??= []).push(v);
    };
    for (const [k, v] of Object.entries(sys.qualityValues ?? {})) pushVal(k, v);

    for (const e of enh) {
        const s = e.system;
        accuracy       += Number(s.accuracyBonus) || 0;
        reliabilityMax += Number(s.reliabilityBonus) || 0;
        damage = foldDamage(damage, s.damageBonus);
        for (const t of (s.addedDamageTypes ?? [])) damageTypes.add(t);
        for (const q of (s.grantedQualities ?? [])) qualities.add(q);
        for (const [k, v] of Object.entries(s.qualityValues ?? {})) pushVal(k, v);
    }

    /* Fold each quality's collected contributions into one stored value. */
    const qualityValues = {};
    for (const [k, list] of Object.entries(valueContribs)) {
        qualityValues[k] = combineQualityValues(list);
    }

    /* Quality-driven reliability bonus (Meteorite = +5; GM-authored qualities
     * with `reliabilityBonus` ride the same fold). Read AFTER the qualities
     * set is finalized so a granted-by-enhancement Meteorite still adds its
     * +5. Catalog read is sync; the helper falls back to the built-in
     * defaults during init before settings are registered. */
    const cat = getActiveWeaponQualities?.() ?? WEAPON_QUALITIES;
    for (const q of qualities) {
        reliabilityMax += Number(cat[q]?.reliabilityBonus) || 0;
    }

    /* Quality-driven bonus enhancement slots (Meteorite EO p.7: "if you
     * don't use the alternate optional rules for monster susceptibilities,
     * this quality instead grants the weapon an extra enchantment slot
     * for runes, up to 3 total"). One extra slot when the active set
     * includes any quality flagged `meteoriteExtraEnchantSlot`. */
    let bonusSlots = 0;
    for (const q of qualities) {
        if (cat[q]?.meteoriteExtraEnchantSlot) bonusSlots += 1;
    }
    /* Cap at the difference between the weapon's authored slot count
     * and the EO ceiling of 3 — never grant a 4th. */
    const baseSlots = Number(sys.weaponEnhancement) || 0;
    const bonusSlotsClamped = Math.max(0, Math.min(bonusSlots, 3 - baseSlots));

    return {
        accuracy,
        reliabilityMax,
        damage,
        damageTypes:   [...damageTypes],
        qualities:     [...qualities],
        qualityValues,
        enhancementCount: enh.length,
        bonusSlots:    bonusSlotsClamped,
        modified: enh.length > 0
    };
}

const ARMOR_LOCATIONS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];
/* Binary damage-type resistances an armor/glyph can grant — the physical three
 * plus the elementals. Same shape on ArmorData and EnhancementData, matched
 * generically by the damage calculator (drList intersection). */
const RESIST_TYPES = ["slashing", "piercing", "bludgeoning", "fire", "lightning", "cold", "acid"];
/* EO body-zone → underlying limbs. Kept local to avoid a cross-tree
 * import from mechanics/ into data/item/; matches ZONE_LOCATIONS in
 * mechanics/eoArmorModel.mjs (single source of truth for authoring). */
const ZONE_TO_LOCS = {
    head:  ["head"],
    torso: ["torso"],
    arms:  ["leftArm", "rightArm"],
    legs:  ["leftLeg", "rightLeg"]
};

/** Compute armor's effective stats from base + socketed enhancements. */
export function deriveArmorEffective(sys) {
    const enh = resolveEnhancements(sys.appliedEnhancements);

    /* Only unbaked (legacy) enhancement stopping folds in here as a
     * derived modifier. Baked slots have already written their bonus
     * into `sys.<loc>Stopping` + `sys.<loc>MaxStopping` at attach time
     * (see bakeEnhancementSP in enhancementSlots.mjs) — adding it again
     * would double-count. Baked is the model for anything attached
     * after the current schema landed; unbaked is the safe fallback so
     * legacy world data doesn't silently lose its enhancement SP on
     * upgrade. */
    let bonusSP = 0;
    let evMod   = 0;
    /* Base piece-wide resistances (from the armor's own `sys.slashing`
     * / `piercing` / `bludgeoning` booleans) apply to EVERY covered
     * limb — that's how base armor is authored. Enhancement-added
     * resistances are ZONE-SCOPED under EO p.4: an arms enhancement
     * that resists piercing only helps arm hits, not torso hits.
     * `resistancesByLoc` is the per-location merge; the piece-wide
     * top-level booleans (`slashing/piercing/bludgeoning`) below are
     * kept as "true if ANY location resists" for the actor-sheet
     * summary display and other legacy readers.  */
    const coveredLocs = new Set(ARMOR_LOCATION_COVERAGE[sys.location] ?? []);
    const resistancesByLoc = {};
    for (const loc of ARMOR_LOCATIONS) {
        const covered = coveredLocs.has(loc);
        const r = {};
        for (const rt of RESIST_TYPES) r[rt] = covered ? !!sys[rt] : false;
        resistancesByLoc[loc] = r;
    }
    const qualities = new Set(sys.qualities ?? []);
    /* Quality param-values STACK across the base piece + socketed glyphs, same
     * as weapon runes — e.g. base Resistance to Bleeding 25% + a glyph's 25%
     * reads as 50%. Collect every contribution (base first, then each glyph)
     * and fold them below (see combineQualityValues). */
    const valueContribs = {};
    const pushVal = (k, v) => {
        if (v == null || v === "") return;
        (valueContribs[k] ??= []).push(v);
    };
    for (const [k, v] of Object.entries(sys.qualityValues ?? {})) pushVal(k, v);

    for (const e of enh) {
        const s = e.system;
        if (!e.baked) bonusSP += Number(s.stopping) || 0;
        evMod   += Number(s.encumbranceMod) || 0;
        /* Zone-scoped resistance add. `e.location` carries the zone
         * key the enhancement was attached to under EO. Empty / missing
         * = pre-EO or glyph (location-agnostic) → apply piece-wide. */
        const zone = String(e.location ?? "");
        const applyLocs = zone && ZONE_TO_LOCS[zone]
            ? ZONE_TO_LOCS[zone].filter(l => coveredLocs.has(l))
            : [...coveredLocs];
        for (const loc of applyLocs) {
            for (const rt of RESIST_TYPES) if (s[rt]) resistancesByLoc[loc][rt] = true;
        }
        /* Qualities remain piece-wide for now — zone-scoping them is a
         * separate refactor (touches quality-driven mechanics like
         * silverContact / meteoriteContact hit resolution). */
        for (const q of (s.grantedQualities ?? [])) qualities.add(q);
        for (const [k, v] of Object.entries(s.qualityValues ?? {})) pushVal(k, v);
    }
    /* Fold each quality's collected contributions into one stored value (sums
     * numeric values like Resistance to Bleeding %, keeps non-numeric first). */
    const qualityValues = {};
    for (const [k, list] of Object.entries(valueContribs)) {
        qualityValues[k] = combineQualityValues(list);
    }
    /* CE Visor raised: an open visor exposes the face, so the helm forfeits
     * ALL piercing resistance at the head — base OR enhancement-granted, since
     * we clear the already-merged per-location value AFTER the enhancement loop
     * above — plus 5 SP (applied to `stopping.head` once it's built below).
     * Restored the moment the visor is lowered again. */
    const visorRaised = qualities.has("visor") && !!sys.visorRaised;
    if (visorRaised) resistancesByLoc.head.piercing = false;

    /* Piece-wide top-level booleans — OR-of-all-locations, so any actor
     * sheet reading `effective.slashing` gets "does this piece resist X
     * SOMEWHERE." Callers wanting per-location precision (the damage
     * shape builder in socketHook.buildArmorShape) read
     * `effective.resistancesByLoc[loc].<type>` directly. Computed AFTER the
     * visor clear so `piercing` reflects the exposed head. */
    const topResist = {};
    for (const rt of RESIST_TYPES) topResist[rt] = ARMOR_LOCATIONS.some(l => resistancesByLoc[l][rt]);
    const { slashing, piercing, bludgeoning } = topResist;

    /* Per-location SP, GATED by the `location` enum. Each piece carries
     * its own value per slot (so a hauberk can be 10 torso / 5 arms),
     * but only the locations the enum says are covered actually
     * contribute. Uncovered slots are forced to 0 even if the document
     * still has a non-zero {loc}Stopping from a past "Full" config the
     * GM later switched. Coverage map is the shared
     * `ARMOR_LOCATION_COVERAGE` from config.mjs. `bonusSP` here is
     * the legacy-only add — baked contributions are already in baseVal
     * / baseMax below. */
    const covered = new Set(ARMOR_LOCATION_COVERAGE[sys.location] ?? []);
    const stopping = {};
    for (const loc of ARMOR_LOCATIONS) {
        if (!covered.has(loc)) {
            stopping[loc] = { value: 0, max: 0 };
            continue;
        }
        const baseVal = Number(sys[`${loc}Stopping`])    || 0;
        const baseMax = Number(sys[`${loc}MaxStopping`]) || 0;
        stopping[loc] = {
            value: baseMax > 0 ? baseVal + bonusSP : baseVal,
            max:   baseMax > 0 ? baseMax + bonusSP : baseMax
        };
    }

    /* CE Visor raised: −5 SP at the head (the exposed face), floored at 0, on
     * both current and max so damage, layering and display all see the weaker
     * helm. Paired with the piercing-resistance clear above. */
    if (visorRaised && stopping.head) {
        stopping.head.value = Math.max(0, stopping.head.value - 5);
        stopping.head.max   = Math.max(0, stopping.head.max - 5);
    }

    return {
        bonusSP,
        stopping,
        encumbranceValue: Math.max(0, (Number(sys.encumbranceValue) || 0) + evMod),
        /* Top-level booleans preserved for legacy summary readers (actor
         * sheet resist list, tooltip chips) — physical three kept named for
         * back-compat, all seven (incl. fire/lightning/cold/acid) spread from
         * topResist. Per-location precision lives on `resistancesByLoc`. */
        ...topResist,
        slashing,
        piercing,
        bludgeoning,
        resistancesByLoc,
        qualities:     [...qualities],
        qualityValues,
        enhancementCount: enh.length,
        modified: enh.length > 0
    };
}
