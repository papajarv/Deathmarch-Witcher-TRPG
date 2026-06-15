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

    return {
        accuracy,
        reliabilityMax,
        damage,
        damageTypes:   [...damageTypes],
        qualities:     [...qualities],
        qualityValues,
        enhancementCount: enh.length,
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

    // Bonus SP applies to every covered location (max > 0). Stays
    // non-destructive: base {loc}Stopping is untouched.
    const stopping = {};
    for (const loc of ARMOR_LOCATIONS) {
        const baseVal = Number(sys[`${loc}Stopping`]) || 0;
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
