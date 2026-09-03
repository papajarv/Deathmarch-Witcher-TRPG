/**
 * Core rulebook — WATER spells, all three tiers.
 *
 * Water carries the book's two odd escapes: things that drag you somewhere
 * and hold you there until you swim out, and ice that has to be physically
 * broken off. Both are effects with their OWN end conditions, unrelated to
 * how long the spell that made them lasts.
 */

/* ── CARYS' HAIL ──────────────────────────────────────────────────────────
 * ERRATA, and the same deletion as Cenlly Graig. The printing ends "Each roll
 * counts as its own separate attack when determining location and dealing
 * damage." The errata removes it, leaving one attack whose margin scales a
 * single pool — so armour is subtracted once, not five times.
 *
 * Post-errata this is Cenlly Graig with a lower cap and a freeze rider, which
 * is a much better argument that the deletion was intentional than anything a
 * diff could show.
 *
 * The freeze ends the way the STATUS says it does — see Waves of the Naglfar
 * below, which had the same `untilDestroyed` and the same problem. */
export const CARYS_HAIL = {
    name: "Carys' Hail", tier: "novice", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "direct", count: 1 }, range: 5,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "water", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:dealDamage", a: { formula: "min(5,{margin})d6", damageType: "cold" } },
        { b: "core:ifPercentile", a: { chance: 25 }, body: [
            { b: "core:applyStatus", a: { status: "frozen", until: "saveEnds" } },
            { b: "core:saveEnds",    a: { skill: "physique", dcSource: "fixed", dc: "16",
                                          cadence: "round" } }
        ]}
    ]}
};

/* ── CONTROL WATER ────────────────────────────────────────────────────────
 * `Defense: DC set by the GM`, printed verbatim. Not a shrug — the difficulty
 * of turning a river depends on the river. Teleportation's literal DC:15 and
 * this are the same mechanism with the number arriving from a different place,
 * and the frame now has both. */
export const CONTROL_WATER = {
    name: "Control Water", tier: "novice", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "point" }, range: 10,
        defence: { type: "dc", dc: "gm" },
        element: "water", duration: { kind: "active", upkeep: 2 }
    },
    on: {
        success: [
            { b: "core:narrate", a: { what: "You set the speed and direction of a body of water — halving a swimmer's speed, adding half again to a ship's, or slowing a current to a halt.", scale: "major" } }
        ],
        miss: [
            { b: "core:narrate", a: { what: "The water does not answer.", scale: "notable" } }
        ]
    }
};

/* ── CURSE OF SEDNA ───────────────────────────────────────────────────────
 * A whirlpool that keeps hold of you: "anyone within 5m must make a Swimming
 * check equal to your Spell Casting check or be dragged underwater. They must
 * make a check each round or remain underwater, where they will start
 * suffocating."
 *
 * Two nested end conditions — the drag ends on a save, and the suffocation
 * that follows is its own damage channel, which is exactly the channel Quen
 * cannot touch.
 *
 * ONE check, and it is the Swimming one. The frame used to declare a Dodge as
 * well, so a victim rolled twice: once to avoid a whirlpool the entry never
 * lets you dodge, and again to swim out of it — and anyone who beat the cast
 * was never handed to the zone at all, which is the half of the spell that
 * does everything. The whirlpool is 4m across and drags from 5m, which is the
 * book's own pair of numbers, not a rounding: the frame draws the vortex, the
 * zone is its pull. */
export const CURSE_OF_SEDNA = {
    name: "Curse of Sedna", tier: "novice", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "area", shape: "radius", size: 4 }, range: 12,
        defence: { type: "none" },
        element: "water", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:createZone", a: { shape: "radius", size: "5", anchor: "free", until: "upkeepUnpaid" },
          body: [
            { b: "core:contest", a: { against: "swimming", use: "castRoll" }, body: [
                { b: "core:applyStatus", a: { status: "underwater",  until: "saveEnds" } },
                { b: "core:applyStatus", a: { status: "suffocating", until: "saveEnds" } },
                { b: "core:saveEnds",    a: { skill: "swimming", dcSource: "castRoll", cadence: "round" } }
            ]}
        ]}
    ]}
};

/* ── DORMYN'S FOG ─────────────────────────────────────────────────────────*/
export const DORMYNS_FOG = {
    name: "Dormyn's Fog", tier: "novice", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 10 }, range: 10,
        defence: { type: "none" },
        element: "water", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:createZone", a: { anchor: "caster", until: "upkeepUnpaid" },
          body: [
            { b: "core:grantModifier", a: { stat: "awareness", delta: "-3", until: "untilExitZone" } },
            { b: "core:applyStatus",   a: { status: "visionLimited4m", until: "untilExitZone" } }
        ]},
        /* The -3 lands; the sight range does not.
         *
         * `visionLimited4m` is a marker — nothing reads it, because a token's
         * sight range is written by the vision policy and no spell can reach
         * it. The Awareness penalty is real and automatic, so the card would
         * otherwise imply the rest of the fog is too. */
        { b: "core:narrate", a: { what: "The fog is thick enough to blind: -3 Awareness inside it, applied. Sight range is not capped for you — anyone in the fog sees no further than 4m, and that is the GM's to enforce.", scale: "notable" } }
    ]}
};

/* ── DOWNPOUR ─────────────────────────────────────────────────────────────
 * The entry that proved nothing in the library could REMOVE anything. Fourteen
 * blocks in, every one of them only ever added.
 *
 * It does two separate things and they need separate blocks: it puts out fires
 * that are already burning, and while it lasts it counteracts fire effects, so
 * nothing new catches inside it either. A one-shot removal cannot say the
 * second. And neither is Dispel — there is no roll and no comparison against
 * the original caster, or a 2-STA rain shower could out-roll a master. */
export const DOWNPOUR = {
    name: "Downpour", tier: "novice", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "area", shape: "radius", size: 10 }, range: 8,
        defence: { type: "none" },
        element: "water", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:removeStatus", a: { status: "onFire", from: "targets" } },
        { b: "core:counteract",   a: { tag: "fire", until: "upkeepUnpaid" } }
    ]}
};

/* ── ICE SLICK ────────────────────────────────────────────────────────────
 * A zone whose contest fires on ENTRY rather than each round — "anyone who
 * crosses that area must make an Athletics check". Yrden's membership
 * machinery with a roll attached to the crossing. */
export const ICE_SLICK = {
    name: "Ice Slick", tier: "novice", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "point" }, range: 10,
        defence: { type: "dodge", ties: "defender" },
        element: "water", duration: { kind: "rounds", value: "2d10" }
    },
    on: { success: [
        { b: "core:createZone", a: { shape: "cube", size: "2", anchor: "free",
              until: "rounds", value: "2d10" },
          body: [
            { b: "core:contest", a: { against: "athletics", use: "castRoll" }, body: [
                { b: "core:applyStatus", a: { status: "prone", until: "rounds", value: "1" } }
            ]}
        ]}
    ]}
};

/* ── PURO DWR ─────────────────────────────────────────────────────────────*/
export const PURO_DWR = {
    name: "Puro Dwr", tier: "novice", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "point" }, range: 4,
        defence: { type: "none" },
        element: "water", duration: { kind: "rounds", value: "1d10" }
    },
    on: { success: [
        { b: "core:counteract", a: { tag: "poison",  until: "rounds", value: "1d10" } },
        { b: "core:counteract", a: { tag: "disease", until: "rounds", value: "1d10" } },
        { b: "core:narrate", a: { what: "One cubic metre of water is purified. It will not force living creatures out of it, and a small part of a larger polluted body begins to pollute again once the spell ends.", scale: "notable" } }
    ]}
};

/* ── RHEWI ────────────────────────────────────────────────────────────────*/
export const RHEWI = {
    name: "Rhewi", tier: "novice", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "direct", count: 1 }, range: 8,
        defence: { type: "dodge", ties: "defender" },
        element: "water", duration: { kind: "rounds", value: "1d10" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "frozen", until: "rounds", value: "1d10" } },
        { b: "core:narrate", a: { what: "Cast on a non-living target, it can neither be manipulated nor moved.", scale: "trivial" } }
    ]}
};

/* ── ANIALWCH ─────────────────────────────────────────────────────────────
 * Armour-bypassing damage plus a SECOND resource drained. The only core spell
 * that damages stamina, and the reason `drainResource` is not a flag on
 * `dealDamage` — the two go through different pipelines and only one of them
 * can be reduced by armour. */
export const ANIALWCH = {
    name: "Anialwch", tier: "journeyman", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 8 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "resistMagic", ties: "defender" },
        element: "water", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:dealDamage",    a: { formula: "4d6", damageType: "bludgeoning", bypassArmour: true } },
        { b: "core:drainResource", a: { formula: "4d6", resource: "stamina" } }
    ]}
};

/* ── MERIGOLD'S HAILSTORM ─────────────────────────────────────────────────
 * The standing-DC contest, on a clock: "everyone within the storm must make a
 * Dodge/Escape check at a DC equal to your Spell Casting check each round".
 * The roll was made once, at the cast; only the checking repeats.
 *
 * Which is also the ONLY check the entry gives, so the frame declares none.
 * Falling hail is not something you dodge as it is conjured — you dodge it as
 * it falls, every round, which is what the inner contest already says. With a
 * Dodge on the frame as well, round one cost a victim two Dodge/Escape rolls
 * against the same standing DC, and losing the first one kept them out of the
 * storm entirely for as long as it lasted. */
export const MERIGOLDS_HAILSTORM = {
    name: "Merigold's Hailstorm", tier: "journeyman", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 15 },
        targeting: { mode: "area", shape: "radius", size: 30 }, range: 30,
        defence: { type: "none" },
        element: "water", duration: { kind: "active", upkeep: 4 }
    },
    on: { success: [
        { b: "core:repeatEachRound", body: [
            { b: "core:contest", a: { against: "dodge", use: "castRoll" }, body: [
                { b: "core:dealDamage", a: { formula: "2d6", damageType: "cold", location: "random" } }
            ]}
        ]}
    ]}
};

/* ── WAVES OF THE NAGLFAR ─────────────────────────────────────────────────
 * "Anyone who doesn't dodge or block the spell is frozen and takes 4d6
 * damage." One check, at the cast, and the entry says nothing at all about how
 * long the ice holds — which is not an omission, because `freeze` is a printed
 * status and carries its own way out: "−3 SPD and −1 REF. A DC 16 Physique
 * check (1 action) breaks the ice" (`setup/statusClauses.mjs`).
 *
 * So the freeze ends on that check, not on `untilDestroyed`. Nothing here is
 * conjured — no wall, no spike, no token — so there was never anything on the
 * map whose destruction could fire it, and that condition now ends only on a
 * GM's explicit call from the cast card: the ice held until somebody
 * remembered to click it off, which is not a duration, it is an oversight
 * waiting to happen. */
export const WAVES_OF_THE_NAGLFAR = {
    name: "Waves of the Naglfar", tier: "journeyman", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 10 },
        targeting: { mode: "area", shape: "radius", size: 3, excludeCaster: true }, range: 3,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "water", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:dealDamage",  a: { formula: "4d6", damageType: "cold" } },
        { b: "core:applyStatus", a: { status: "frozen", until: "saveEnds" } },
        { b: "core:saveEnds",    a: { skill: "physique", dcSource: "fixed", dc: "16",
                                      cadence: "round" } }
    ]}
};

/* ── MENTAL COMMAND ───────────────────────────────────────────────────────
 * A conditional bonus the DEFENDER gets, declared by the attacking frame: "if
 * the command is something the target would never do, they get a +5 to their
 * Resist Magic check."
 *
 * The frame was accepting both keys and reading neither, so the bonus vanished.
 * The condition is a judgement rather than a computation, so it is asked; the
 * arithmetic stays in the frame, because a defence bonus is law. */
export const MENTAL_COMMAND = {
    name: "Mental Command", tier: "journeyman", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 25 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "resistMagic", ties: "defender",
                   targetBonusWhen: "againstNature", targetBonus: 5 },
        element: "mixed", duration: { kind: "untilTaskDone" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "compelled", until: "untilTaskDone" } },
        { b: "core:saveEnds",    a: { skill: "resistmagic", dcSource: "castRoll", cadence: "round" } }
    ]}
};

/* ── PART WATER ───────────────────────────────────────────────────────────*/
export const PART_WATER = {
    name: "Part Water", tier: "master", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 25 },
        targeting: { mode: "area", shape: "cube", size: 10 }, range: 10,
        defence: { type: "none" },
        element: "water", duration: { kind: "active", upkeep: 6 }
    },
    on: { success: [
        { b: "core:narrate", a: { what: "An open corridor up to 10m by 100m by 10m, in any orientation including vertical. Fish, monsters and other creatures are swept back with the water. You pass through the walls as easily as stepping into water; cast from within the water, it pushes you aside too.", scale: "major" } }
    ]}
};

/* ── TRYFERI GAEAF ────────────────────────────────────────────────────────
 * The ONLY genuine multi-attack left after the errata, and the full entry adds
 * what the summary loses: the spikes that freeze a target also "do 2 points of
 * damage each round until they are broken off with a DC:20 Physique check or
 * by doing 20 points of damage to them."
 *
 * TWO independent escapes again, neither of them the spell's duration — and a
 * third path where the spikes simply last it out. Three end conditions on one
 * effect, which is precisely what a single frame-level duration cannot say.
 *
 * The freeze therefore ends on EITHER: `untilDestroyed` is the 20 points of
 * damage (the spike is a real token now, and dropping it fires every
 * `untilDestroyed` lifetime this cast left behind), and `saveEnds` is the
 * DC:20 Physique check below. It used to carry only the first, so the check
 * the entry prints was registered, rolled, passed — and unfroze nothing,
 * because a save fires SAVE_ENDS and nothing on the target answered to it.
 *
 * "AT ANY NUMBER OF TARGETS" IS NOT EXPRESSED. `count: null` lets the caster
 * lock as many victims as they like, but `core:multiAttack` runs its body
 * against the WHOLE list each time, so N spikes at M targets resolve as N×M
 * attacks instead of N spikes shared out among them. What is missing is an
 * allocation step — assign each of the N attacks to a target the caster picks
 * — and neither `core:forEachTarget` (every target, every time) nor
 * `core:targetNearest` (the closest one, every time) is that. Against one
 * target, which is how this is cast in practice, the tree is exact; against
 * several the GM divides the spikes and the spare hits are ignored. */
export const TRYFERI_GAEAF = {
    name: "Tryferi Gaeaf", tier: "master", element: "water",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 22 },
        targeting: { mode: "direct", count: null }, range: 20,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "water", duration: { kind: "rounds", value: "1d10" }
    },
    on: { hit: [
        { b: "core:multiAttack", a: { count: "floor({rank}/2)" }, body: [
            { b: "core:dealDamage", a: { formula: "5d6", damageType: "cold", location: "perAttack" } },
            { b: "core:ifPenetratedArmour", body: [
                { b: "core:applyStatus",  a: { status: "frozen",
                                               until: ["untilDestroyed", "saveEnds"] } },
                { b: "core:createObject", a: { what: "iceSpike", hp: "20", until: "untilDestroyed" } },
                { b: "core:repeatEachRound", body: [
                    { b: "core:dealDamage", a: { formula: "2", damageType: "cold", bypassArmour: true } }
                ]},
                { b: "core:saveEnds", a: { skill: "physique", dcSource: "fixed", dc: "20", cadence: "round" } }
            ]}
        ]}
    ]}
};

export const WATER = [
    CARYS_HAIL, CONTROL_WATER, CURSE_OF_SEDNA, DORMYNS_FOG, DOWNPOUR,
    ICE_SLICK, PURO_DWR, RHEWI,
    ANIALWCH, MERIGOLDS_HAILSTORM, WAVES_OF_THE_NAGLFAR, MENTAL_COMMAND,
    PART_WATER, TRYFERI_GAEAF
];
