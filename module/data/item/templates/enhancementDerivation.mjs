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
 *  data. Returns an array of `{ name, img, system }` for those that resolve. */
export function resolveEnhancements(applied) {
    const out = [];
    if (!Array.isArray(applied) || typeof fromUuidSync !== "function") return out;
    for (const ref of applied) {
        if (!ref?.uuid) continue;
        let item = null;
        try { item = fromUuidSync(ref.uuid); } catch (_) { item = null; }
        if (!item || item.type !== "enhancement") continue;
        out.push({ name: item.name, img: item.img, uuid: ref.uuid, system: item.system });
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
    const qualityValues = foundry.utils.deepClone(sys.qualityValues ?? {});

    for (const e of enh) {
        const s = e.system;
        accuracy       += Number(s.accuracyBonus) || 0;
        reliabilityMax += Number(s.reliabilityBonus) || 0;
        damage = foldDamage(damage, s.damageBonus);
        for (const t of (s.addedDamageTypes ?? [])) damageTypes.add(t);
        for (const q of (s.grantedQualities ?? [])) qualities.add(q);
        for (const [k, v] of Object.entries(s.qualityValues ?? {})) {
            if (qualityValues[k] == null || qualityValues[k] === "") qualityValues[k] = v;
        }
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

/** Compute armor's effective stats from base + socketed enhancements. */
export function deriveArmorEffective(sys) {
    const enh = resolveEnhancements(sys.appliedEnhancements);

    let bonusSP = 0;
    let evMod   = 0;
    let slashing    = !!sys.slashing;
    let piercing    = !!sys.piercing;
    let bludgeoning = !!sys.bludgeoning;
    const qualities = new Set(sys.qualities ?? []);
    const qualityValues = foundry.utils.deepClone(sys.qualityValues ?? {});

    for (const e of enh) {
        const s = e.system;
        bonusSP += Number(s.stopping) || 0;
        evMod   += Number(s.encumbranceMod) || 0;
        slashing    = slashing    || !!s.slashing;
        piercing    = piercing    || !!s.piercing;
        bludgeoning = bludgeoning || !!s.bludgeoning;
        for (const q of (s.grantedQualities ?? [])) qualities.add(q);
        for (const [k, v] of Object.entries(s.qualityValues ?? {})) {
            if (qualityValues[k] == null || qualityValues[k] === "") qualityValues[k] = v;
        }
    }

    /* Per-location SP, GATED by the `location` enum. Each piece carries
     * its own value per slot (so a hauberk can be 10 torso / 5 arms),
     * but only the locations the enum says are covered actually
     * contribute. Uncovered slots are forced to 0 even if the document
     * still has a non-zero {loc}Stopping from a past "Full" config the
     * GM later switched. Coverage map is the shared
     * `ARMOR_LOCATION_COVERAGE` from config.mjs. */
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

    return {
        bonusSP,
        stopping,
        encumbranceValue: Math.max(0, (Number(sys.encumbranceValue) || 0) + evMod),
        slashing,
        piercing,
        bludgeoning,
        qualities:     [...qualities],
        qualityValues,
        enhancementCount: enh.length,
        modified: enh.length > 0
    };
}
