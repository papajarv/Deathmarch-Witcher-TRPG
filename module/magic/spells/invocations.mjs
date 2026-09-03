/**
 * Core rulebook — DRUID and PREACHER invocations, all tiers.
 *
 * Priests and druids "technically wield the power required to cast spells.
 * However, they do not train to the level of precision required." Mechanically
 * that means their element is always inherited rather than declared — an
 * invocation resolves Mixed from its caster — and their opposition is
 * frequently a creature's raw statistic rather than a roll.
 *
 * This family is where the book's oddest defence line lives: `Creature's
 * WILLx3`. The beast does not roll. It simply is that hard to sway.
 */

/* ── BOILING BLOOD ────────────────────────────────────────────────────────
 * `Defense: Creature's WILLx3`. A derived stat of the target, fixed and known,
 * and it varies per target — which is why it is a defence type rather than a
 * frame-level DC. */
export const BOILING_BLOOD = {
    name: "Boiling Blood", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "direct", count: 1 }, range: 8,
        defence: { type: "stat", stat: "will", multiplier: 3, ties: "defender" },
        element: "inherit", duration: { kind: "rounds", value: "1d10" }
    },
    on: { hit: [
        { b: "core:ifTargetHas", a: { trait: "beast" }, body: [
            { b: "core:applyStatus", a: { status: "enraged", until: "rounds", value: "1d10" } },
            { b: "core:narrate", a: { what: "The creature will try to attack the chosen target until the duration ends.", scale: "notable" } }
        ]}
    ]}
};

/* ── CURSED ILLNESS ───────────────────────────────────────────────────────
 * BANDED cost: the tier bought IS the effect, chosen at cost time, which is
 * why it cannot be a post-roll choice. 2 staggers, 4 stuns, 6 poisons — and
 * the caster's roll becomes the target's escape DC. */
export const CURSED_ILLNESS = {
    name: "Cursed Illness", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation",
        cost: { mode: "banded", bands: { 2: "staggered", 4: "stunned", 6: "poisoned" } },
        targeting: { mode: "direct", count: 1 }, range: 8,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "saveEnds" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "{band}", until: "saveEnds" } },
        { b: "core:saveEnds",    a: { skill: "endurance", dcSource: "castRoll", cadence: "round" } }
    ]}
};

/* ── FRIEND TO WILD KIND ──────────────────────────────────────────────────
 * `Range: Self or 5m`, and the "or" is the whole entry: "Friend to Wild Kind
 * grants the caster a +3 to Wilderness Survival for handling animals.
 * Alternately it can calm one animal if the Spell Casting roll exceeds the
 * animal's WILLx3."
 *
 * A SCOPED modifier — "+3 to Wilderness Survival FOR HANDLING ANIMALS" is not
 * an unconditional bonus, and `scope` is the difference.
 *
 * The frame used to carry the printed `Defense: Creature's WILLx3` while
 * targeting SELF, which is two failures wearing one line. `defence: "stat"`
 * opposes the cast with the TARGET's statistic, and with self-targeting the
 * target is the caster — so a druid rolled against their own WILL×3. Worse, a
 * defended cast resolves to `hit` or `miss` and never to `success`, so the
 * `on.success` tree holding the +3 — the half of the spell that always happens
 * — was unreachable. Cast it and nothing occurred at all.
 *
 * The +3 is unconditional, so the frame opposes nothing and the bonus lands on
 * the caster. The WILL×3 belongs to the ALTERNATE use, against the animal, and
 * that half is a sentence: only the frame's `defence: { type: "stat" }` can
 * compare a cast roll against a raw stat multiple, a frame has exactly one
 * defence, and spending it here would put the check back in front of the +3.
 * `core:contest` cannot stand in — it makes the defender ROLL (1d10 + skill),
 * and WILL×3 is a fixed number the beast does not roll for. */
export const FRIEND_TO_WILD_KIND = {
    name: "Friend to Wild Kind", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 1 },
        targeting: { mode: "self" }, range: 5,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "hours", value: "1d6" }
    },
    on: { success: [
        { b: "core:grantModifier", a: { stat: "wilderness", delta: "3",
              scope: "handlingAnimals", until: "hours", value: "1d6" } },
        { b: "core:narrate", a: { what: "Alternately, aimed at one animal within 5m: if this Spell Casting roll exceeds the animal's WILLx3 the beast is calmed for the duration.", scale: "notable" } }
    ]}
};

/* ── NATURE'S GIFT ────────────────────────────────────────────────────────
 * Variable cost where the spend IS the yield: enough food "to sustain a number
 * of people equal to the number of STA points spent for 1 day." */
export const NATURES_GIFT = {
    name: "Nature's Gift", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "point" }, range: 2,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:narrate", a: { what: "A cluster of edible plants grows in soil of any kind — enough to sustain {sta} people for one day.", scale: "notable" } }
    ]}
};

/* ── NATURE'S SIGHT ───────────────────────────────────────────────────────*/
export const NATURES_SIGHT = {
    name: "Nature's Sight", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "active", upkeep: 1 }
    },
    on: { success: [
        { b: "core:revealInfo", a: { about: "monsters", to: "caster",
              detail: "Creatures not natural to this realm, within 50m and through obstacles, glowing." } }
    ]}
};

/* ── SIGIL OF THE HIDDEN ──────────────────────────────────────────────────
 * THREE end conditions on one effect: dispelled, re-cast to uncover yourself,
 * or 10 points of damage cut through the brush. None is a duration, and a
 * single `setDuration` could express none of them. */
export const SIGIL_OF_THE_HIDDEN = {
    name: "Sigil of the Hidden", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "self" }, range: 3,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "untilDispelled" }
    },
    on: { success: [
        { b: "core:createObject", a: { what: "brush", hp: "10",
              until: ["untilDestroyed", "untilDispelled", "untilRecast"] } },
        { b: "core:grantModifier", a: { stat: "stealth", delta: "5", until: "untilDispelled" } },
        { b: "core:applyStatus",   a: { status: "immobilised", until: "untilDispelled" } }
    ]}
};

/* ── BLESSING OF HEALING ──────────────────────────────────────────────────*/
export const BLESSING_OF_HEALING = {
    name: "Blessing of Healing", tier: "journeyman", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "direct", count: 1 }, range: 2,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "active", upkeep: 3 }
    },
    on: { success: [
        { b: "core:repeatEachRound", body: [
            { b: "core:healHealth", a: { formula: "3" } }
        ]},
        { b: "core:narrate", a: { what: "Used repeatedly, this blessing can instead heal a critical wound.", scale: "notable" } }
    ]}
};

/* ── PRIMAL RESERVOIR ─────────────────────────────────────────────────────
 * A buff and a debuff from one cast, on the same target. */
export const PRIMAL_RESERVOIR = {
    name: "Primal Reservoir", tier: "journeyman", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 6 },
        targeting: { mode: "direct", count: 1 }, range: 5,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "rounds", value: "2d6" }
    },
    on: { hit: [
        { b: "core:grantModifier", a: { stat: "meleeBonus", delta: "2",  until: "rounds", value: "2d6" } },
        { b: "core:grantModifier", a: { stat: "int",         delta: "-2", until: "rounds", value: "2d6" } }
    ]}
};

/* ── THREADS OF LIFE ──────────────────────────────────────────────────────*/
export const THREADS_OF_LIFE = {
    name: "Threads of Life", tier: "journeyman", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 4 },
        targeting: { mode: "area", shape: "radius", size: 10 }, range: 10,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:revealInfo", a: { about: "health", to: "caster",
              detail: "Current Health Points and any critical wounds, for every target in the radius." } }
    ]}
};

/* ── SHAPE NATURE ─────────────────────────────────────────────────────────
 * A summon that is TANGIBLE and acts — the opposite end of `summonCopies`
 * from Afan's Mirror's intangible, inert duplicates. */
export const SHAPE_NATURE = {
    name: "Shape Nature", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 12 },
        targeting: { mode: "point" }, range: 10,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "rounds", value: "1d10" }
    },
    on: { success: [
        { b: "core:summonCopies", a: { count: "1", what: "treeGolem", tangible: "yes",
              controlled: "caster", until: "rounds", value: "1d10" } },
        { b: "core:narrate", a: { what: "It turns back into a tree when the duration ends. Killed, it yields only 2d10 units of timber; in all other ways it acts as a normal golem.", scale: "major" } }
    ]}
};

/* ── SONG OF THE SKY ──────────────────────────────────────────────────────
 * Five weathers, one of them explicitly "equivalent to the Lightning Storm
 * spell". Authored as its own choice rather than by invoking that entry — the
 * book's cross-reference is shorthand for a reader, not a dependency. */
export const SONG_OF_THE_SKY = {
    name: "Song of the Sky", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 10 },
        targeting: { mode: "area", shape: "radius", size: 50 }, range: 50,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "active", upkeep: 5 }
    },
    on: { success: [
        { b: "core:chooseOption", a: {
            choices: ["clearSky", "cloudy", "rainstorm", "windStorm", "lightningStorm"], bind: "weather" },
          body: [
            { b: "core:narrate", a: { what: "The weather turns to {weather} for 50m around you. The consequences are the GM's to apply — rain puts out fires, wind is -2 DEX to ranged attacks, and a lightning storm carries a 35% chance of a strike each round. Nothing here changes the scene or rolls that chance for you.", scale: "major" } }
        ]}
    ]}
};

/* ── BLESSING OF FORTUNE ──────────────────────────────────────────────────
 * A static DC whose MARGIN is the reward: "LUCK points equal to half the value
 * you rolled over DC:12 (max 5)."
 *
 * The printed `Defense` line is None and the DC:12 lives in the effect text,
 * which is the same mechanism arriving from the other column — nobody opposes
 * this, the caster simply has a bar to clear. `Duration: Until Expended`
 * matches: the blessing lasts until the last point is spent, not for a span.
 *
 * A pool, not a modifier — spent a point at a time until it runs out, rather
 * than applying to everything until it lapses. */
export const BLESSING_OF_FORTUNE = {
    name: "Blessing of Fortune", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 1 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "dc", dc: 12 },
        element: "inherit", duration: { kind: "untilExpended" }
    },
    on: { success: [
        { b: "core:grantPool", a: { resource: "luck", size: "min(5,floor({margin}/2))",
              scope: "targets", until: "untilExpended" } }
    ]}
};

/* ── BLESSING OF LOVE ─────────────────────────────────────────────────────
 * Note the target: the entry says the blessing "gives THE CASTER a +3 to
 * Charisma and Seduction", despite a 5m range. Authored as printed. */
export const BLESSING_OF_LOVE = {
    name: "Blessing of Love", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "self" }, range: 5,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "rounds", value: "1d10" }
    },
    on: { success: [
        { b: "core:grantModifier", a: { stat: "charisma",  delta: "3", until: "rounds", value: "1d10" } },
        { b: "core:grantModifier", a: { stat: "seduction", delta: "3", until: "rounds", value: "1d10" } }
    ]}
};

/* ── HOLY LIGHT ───────────────────────────────────────────────────────────*/
export const HOLY_LIGHT = {
    name: "Holy Light", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 1 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "rounds", value: "3d10" }
    },
    on: { success: [
        { b: "core:applyStatus", a: { status: "brightlyLit", until: "rounds", value: "3d10" } },
        { b: "core:narrate", a: { what: "The light gives off no heat and cannot ignite anything.", scale: "trivial" } }
    ]}
};

/* ── VAULTS OF KNOWLEDGE ──────────────────────────────────────────────────*/
export const VAULTS_OF_KNOWLEDGE = {
    name: "Vaults of Knowledge", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:revealInfo", a: { about: "memory", to: "caster",
              detail: "Any knowledge or memory you have ever known, as if experiencing it now." } }
    ]}
};

/* ── WATERS OF CLEARANCE ──────────────────────────────────────────────────
 * Uncontested removal, and it is not Dispel: no roll, no comparison against
 * the original caster, no half-cost. A 1-STA sobering must not be able to
 * out-roll a master's working.
 *
 * The standing suppression that used to sit behind it is GONE rather than
 * re-timed. `core:counteract` is a WARD — it holds an element off for as long
 * as it lasts — and `Duration: Immediate` gives this spell no "as long as" to
 * spend: it sobers you now, and the next drink works normally. Authored with
 * `until: "immediate"` the ward expired in the tick that created it, so
 * enforcing counteraction changed nothing here; the book has no duration to
 * give it. Downpour's version is a rain that keeps falling, which is what the
 * block is for.
 *
 * "Alcohol and alchemical solutions that cause intoxication" names WHAT it
 * clears, not a lasting aura, and it is narrated because the engine has one
 * `intoxicated` status and no way to tell a drunk from someone deep in an
 * alchemical haze. */
export const WATERS_OF_CLEARANCE = {
    name: "Waters of Clearance", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 1 },
        targeting: { mode: "direct", count: 1 }, range: 5,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:removeStatus", a: { status: "intoxicated" } },
        { b: "core:narrate", a: { what: "Alcohol and alchemical solutions that cause intoxication are cleared alike. The sobering is immediate and wards against nothing afterwards.", scale: "notable" } }
    ]}
};

/* ── WEB OF LIES ──────────────────────────────────────────────────────────
 * `Duration: INT roll ends`, and the escape is against the target's OWN
 * statistic rather than the caster's roll: "once per round, on their turn, the
 * target can roll 1d10. If they roll under their INT the effect ends."
 *
 * A BARE d10 under a raw stat — not the book's usual "1d10 + skill against a
 * DC" — which is what `mode: "rollUnder"` exists for. Authored as a roll-over
 * this asked for `dcSource: "targetStat"` and named no stat, so it fell back to
 * WILL×3: DC 24 against a maximum roll of 1d10+INT. Arithmetically impossible,
 * so the stun this applies was permanent on every target who ever took it.
 *
 * `dcSource: "fixed"` with no `dc` because a roll-under HAS no DC. The number
 * to beat is the stat itself, and the save reads it off `skill`. */
export const WEB_OF_LIES = {
    name: "Web of Lies", tier: "novice", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "direct", count: 1 }, range: 8,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "saveEnds" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "stunned", until: "saveEnds" } },
        { b: "core:saveEnds",    a: { skill: "int", mode: "rollUnder",
                                      dcSource: "fixed", cadence: "round" } }
    ]}
};

/* ── CLEANSING FIRE ───────────────────────────────────────────────────────*/
export const CLEANSING_FIRE = {
    name: "Cleansing Fire", tier: "journeyman", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 6 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "untilPutOut" }
    },
    on: { hit: [
        { b: "core:dealDamage",  a: { formula: "3d6", damageType: "fire" } },
        { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
    ]}
};

/* ── HOLY FORTIFICATION ───────────────────────────────────────────────────
 * The third independent rule in the core book demanding that a cast record
 * outlive its cast: a new check "against the effects of ANY SPELL that is
 * currently affecting them", each one contested against the roll its own
 * caster made, possibly hours and three casters ago.
 *
 * `kinds` is stated rather than left to default because the default omits
 * `ritual`, and "the effects of ANY SPELL that is currently affecting them"
 * does not. A ritual is the longest-lived magic in the book and the likeliest
 * thing still standing on someone when this is cast; silently skipping it made
 * the one case the invocation is for the one case it could not touch. */
export const HOLY_FORTIFICATION = {
    name: "Holy Fortification", tier: "journeyman", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:rerollAgainstStanding", a: { skill: "resistmagic",
              kinds: ["spell", "invocation", "hex", "ritual", "sign"] } }
    ]}
};

/* ── LIGHT OF TRUTH ───────────────────────────────────────────────────────*/
export const LIGHT_OF_TRUTH = {
    name: "Light of Truth", tier: "journeyman", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 4 },
        targeting: { mode: "direct", count: 1 }, range: 5,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "active", upkeep: 2 }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "compelledToTruth", until: "upkeepUnpaid" } },
        { b: "core:saveEnds",    a: { skill: "resistmagic", dcSource: "castRoll", cadence: "round" } }
    ]}
};

/* ── DIVINE PORTAL ────────────────────────────────────────────────────────*/
export const DIVINE_PORTAL = {
    name: "Divine Portal", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 12 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "rounds", value: 1 }
    },
    on: { success: [
        { b: "core:createObject", a: { what: "portal", hp: "1", until: "rounds", value: "1",
              blocksMovement: false } },
        { b: "core:narrate", a: { what: "For one round it transports you or others anywhere you can recall.", scale: "major" } }
    ]}
};

/* ── DIVINE WISDOM ────────────────────────────────────────────────────────
 * The second `DC set by the GM` in the book: "the GM sets your DC based on the
 * secrecy of the information." Same mechanism as Control Water. */
export const DIVINE_WISDOM = {
    name: "Divine Wisdom", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 10 },
        targeting: { mode: "self" }, range: 50,
        defence: { type: "dc", dc: "gm" },
        element: "inherit", duration: { kind: "active", upkeep: 5 }
    },
    on: {
        success: [
            { b: "core:revealInfo", a: { about: "augury", to: "caster",
                  detail: "The answer to one question. It cannot predict the future." } }
        ],
        miss: [
            { b: "core:narrate", a: { what: "The augury returns nothing.", scale: "notable" } }
        ]
    }
};

/* ── BLESSING OF DEATH ────────────────────────────────────────────────────
 * "The target must roll Resist Magic or be thrust into DEATH STATE as if by
 * taking normal damage. However if they are treated with a successful First
 * Aid or Healing Hands roll at a DC of 16, they immediately recover their
 * previous number of Health Points."
 *
 * NOT the `dead` status, which is what this used to apply. `dead` is the
 * TERMINAL state the system stamps on after a FAILED death save: it produced a
 * corpse that was still standing at full health, still able to act, and it
 * skipped the death-save clock entirely — the opposite of the clause.
 *
 * Death State is not a flag in this system, it is DERIVED. `data/actor/
 * character.mjs` computes `dying = hpMax > 0 && hpEff <= 0` and applies the
 * x1/3 penalties itself, so the honest way to say "thrust into Death State as
 * if by taking normal damage" is to put their Health Points on zero and let
 * the death saves, the state penalties and the wound clock follow from the
 * system's own rules exactly as they would from a sword.
 *
 * `op: "set"` rather than damage because of the SECOND half. An override
 * leaves the stored value untouched beneath it, so "they immediately recover
 * their previous number of Health Points" is simply what happens when the
 * effect lifts — where damage would have destroyed the very number the clause
 * promises back. Nothing else in the engine can record a previous HP total.
 *
 * `untilTaskDone`: the rescue is a roll made by somebody else, on their own
 * turn, at a DC the treating character has to beat. The GM ends it from the
 * cast card's own control when the First Aid or Healing Hands roll lands, and
 * the previous total returns with it. The frame's `Duration: Immediate` is the
 * CAST's duration and does not govern what the cast leaves behind — the same
 * split Earthen Spike and Magic Screen are printed with. */
export const BLESSING_OF_DEATH = {
    name: "Blessing of Death", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 16 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:grantModifier", a: { stat: "hp", delta: "0", op: "set",
              until: "untilTaskDone" } },
        { b: "core:narrate", a: { what: "Their Health Points are cut to nothing and they enter Death State as if by taking normal damage — death saves and all. Treated with a successful First Aid or Healing Hands roll at DC:16, end this from the card: their previous Health Points return untouched.", scale: "major" } }
    ]}
};

/* ── ETERNAL JUDGEMENT ────────────────────────────────────────────────────
 * A fire that is not the ordinary fire status: double damage, and it cannot be
 * put out except by magic or three full rounds submerged. Given its own status
 * rather than a parameter on `onFire`, because everything that reads "is this
 * thing on fire" — Downpour, Quen's exclusions, the burn clock — would
 * otherwise have to learn about a magnitude it has no use for. `whiteFire`
 * carries the doubling and the refusal to be stamped out; the entry only has
 * to say what catches and what ends it.
 *
 * `untilDispelled` alongside the printed `Until Put Out` is the "except by
 * magic" half of the clause. `endOnDispel` only ends lifetimes that list the
 * condition, so without it here Dispel walked straight past this fire and the
 * one thing the book says CAN end it could not. */
export const ETERNAL_JUDGEMENT = {
    name: "Eternal Judgement", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 16 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "untilPutOut" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "whiteFire",
              until: ["untilPutOut", "untilDispelled"] } },
        { b: "core:narrate", a: { what: "Nothing extinguishes it but magic or full submersion for three rounds. Anything that touches the white fire ignites with ordinary fire, which can be put out in one full round.", scale: "major" } }
    ]}
};

/* ── FREYA'S BRAVERY ──────────────────────────────────────────────────────
 * The zone that forced `linger`. Every other zone in the book lifts the moment
 * you step out; this one's effects "last for 1d6 rounds. These rounds renew if
 * the person re-enters the area and leaves again."
 *
 * `linger` is read: `createZone` hands it to the adapter, which stamps
 * `zoneLingerRounds` on every effect the zone body applies, and the zone
 * layer's exit strip waits that many rounds instead of taking it off at the
 * boundary. Re-entry re-arms it for free, because entering re-applies the
 * effect from scratch — which is exactly the book's "these rounds renew".
 *
 * Also selective: it "affects those who don't believe in Freya, but the power
 * can be withheld from anyone the caster chooses." That stays a sentence. A
 * zone catches whoever crosses its boundary; nothing in the library gives the
 * caster a veto over an individual entrant, and inventing one would need an
 * exclusion list that survives on the region for the whole twenty rounds. */
export const FREYAS_BRAVERY = {
    name: "Freya's Bravery", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 16 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 20 }, range: 20,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "rounds", value: 20 }
    },
    on: { success: [
        { b: "core:createZone", a: { anchor: "caster", until: "rounds", value: "20", linger: "1d6" },
          body: [
            { b: "core:applyStatus",   a: { status: "fearless", until: "untilExitZone" } },
            { b: "core:grantModifier", a: { stat: "hp", delta: "25", until: "untilExitZone" } }
        ]},
        { b: "core:narrate", a: { what: "Belief is not required, but the power may be withheld from anyone the caster chooses.", scale: "notable" } }
    ]}
};

/* ── HEALING REST ─────────────────────────────────────────────────────────
 * Target count scaled by skill — "a number of people equal to the value of
 * your Spell Casting skill" — and a heal that resolves at the END of a day
 * rather than per round.
 *
 * "At the end of the rest, targets revive at full health" is the entire point
 * of the invocation and it was a sentence in a `narrate`. It has somewhere to
 * live now: the coma's own lifetime is a day, and a status lifetime runs the
 * item's `onExpire` when it ends.
 *
 * Two honest imperfections, named rather than papered over.
 *
 *   WHO. An expiry tree begins with the caster and nothing else — the cast's
 *   target list is a day gone by the time this fires — so the sleepers are
 *   re-acquired with the spell's OWN count and range — spelled `1*{skill}`
 *   rather than `{skill}` because that is the form the value builder can read
 *   back, and an expression only the raw box can edit is one nobody edits.
 *   Somebody standing nearer
 *   than a sleeper would be swept up with them; no block can ask the world
 *   "who is lying here in a healing coma".
 *
 *   HOW MUCH. `core:healHealth` takes an amount and there is no expression for
 *   "their maximum" — the five variables belong to the cast, not to the
 *   target. The socket handler that applies healing clamps it to `hp.max`
 *   ("the same way the system's own rest does"), so any amount past a person's
 *   maximum IS full health. 500 saturates that clamp. It is a ceiling, not a
 *   number the book gives, and nothing prints it.
 *
 * The treated critical wounds stay narrated: healing a wound is removing an
 * item from the actor, and no block removes items. */
export const HEALING_REST = {
    name: "Healing Rest", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 16 },
        targeting: { mode: "direct", count: "1*{rank}" }, range: 5,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "days", value: 1 }
    },
    on: {
        success: [
            { b: "core:applyStatus", a: { status: "healingComa", until: "days", value: "1" } },
            { b: "core:narrate", a: { what: "They cannot act and are unaware of their surroundings even if touched, moved, or attacked.", scale: "major" } }
        ],
        onExpire: [
            { b: "core:targetNearest", a: { count: "1*{rank}", of: "creature", within: "5" }, body: [
                { b: "core:healHealth", a: { formula: "500" } }
            ]},
            { b: "core:narrate", a: { what: "The rest ends and the sleepers wake at full health. Critical wounds that had been treated are healed with it; permanent penalties from Deadly Critical Wounds remain.", scale: "major" } }
        ]
    }
};

/* ── LUCK OF THE FATHER ───────────────────────────────────────────────────
 * A pool of 3x the caster's skill, spendable over an hour on their own rolls
 * or on anyone's within 10m — including to IMPOSE penalties.
 *
 * `scope: "self"` is right and is not the whole clause. The scope names who
 * HOLDS the points, and the caster holds all of them: `Range: Self//10m` is a
 * reach, not a second recipient, so granting pools to bystanders would hand
 * out the same points several times over. Where those points may be SPENT is
 * the half no block says — nothing in the library scopes a pool's spending to
 * a radius, and a granted pool is decremented by the player on the sheet — so
 * the reach is narrated and the 10m sits on the frame where a GM can see it.
 *
 * The pool itself lands now: `statPath` sends `luck` to `system.stats.luck.value`,
 * the field the sheet actually decrements, rather than the `.modifier` the
 * schema never declared. */
export const LUCK_OF_THE_FATHER = {
    name: "Luck of the Father", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 16 },
        targeting: { mode: "self" }, range: 10,
        defence: { type: "none" },
        element: "inherit", duration: { kind: "hours", value: 1 }
    },
    on: { success: [
        { b: "core:grantPool", a: { resource: "luck", size: "3*{rank}", scope: "self",
              until: ["untilExpended", "hours"], value: "1" } },
        { b: "core:narrate", a: { what: "Spend these to augment your own rolls, or to impose penalties and grant bonuses to anyone within 10m.", scale: "major" } }
    ]}
};

/* ── WHITE FLAME ──────────────────────────────────────────────────────────
 * A suppression that can be PUSHED THROUGH: "dispels water-based spells in the
 * area. Water-based spells can only be cast in the area of the spell if the
 * caster's Spell Casting check beats that of the Priest of the Great Sun."
 *
 * Downpour's counteraction is absolute; this one is contested. Conflating the
 * two would either make a rain shower unbeatable or a priest's aura trivial.
 *
 * It is also a PLACE, and it had none. Every clause in the entry is about the
 * area — it "lights the surrounding area to the level of bright light", it
 * "thaws anyone in the spell's area", it dispels water magic "in the area" —
 * and the spell created nothing that knows where that area is or who is
 * standing in it. The cast catches whoever is there when it goes up; the zone
 * is what catches the man who walks in on the fortieth minute, and it inherits
 * the frame's radius rather than restating it.
 *
 * The counteraction stays OUTSIDE the zone body on purpose. A zone body runs
 * once per entrant, and `core:counteract` raises one suppression for the whole
 * cast rather than one per person — putting it in the body would raise a fresh
 * identical ward every time somebody stepped over the line. One ward, one
 * hour, stated once, beside the zone that gives it its ground. */
export const WHITE_FLAME = {
    name: "White Flame", tier: "master", element: "inherit",
    frame: {
        kind: "invocation", cost: { mode: "fixed", amount: 16 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 10 }, range: 10,
        defence: { type: "resistMagic", ties: "defender" },
        element: "inherit", duration: { kind: "hours", value: 1 }
    },
    on: { hit: [
        { b: "core:removeStatus", a: { status: "frozen", from: "targets" } },
        { b: "core:counteract",   a: { tag: "water", threshold: "castRoll",
              until: "hours", value: "1" } },
        { b: "core:createZone",   a: { until: "hours", value: "1" }, body: [
            { b: "core:removeStatus", a: { status: "frozen", from: "targets" } },
            { b: "core:applyStatus",  a: { status: "brightlyLit", until: "untilExitZone" } }
        ]},
        { b: "core:narrate", a: { what: "The aura burns no one who touches it. Monsters vulnerable to sunlight take double the normal penalties inside it.", scale: "major" } }
    ]}
};

export const INVOCATIONS = [
    BOILING_BLOOD, CURSED_ILLNESS, FRIEND_TO_WILD_KIND, NATURES_GIFT,
    NATURES_SIGHT, SIGIL_OF_THE_HIDDEN,
    BLESSING_OF_HEALING, PRIMAL_RESERVOIR, THREADS_OF_LIFE,
    SHAPE_NATURE, SONG_OF_THE_SKY,
    BLESSING_OF_FORTUNE, BLESSING_OF_LOVE, HOLY_LIGHT, VAULTS_OF_KNOWLEDGE,
    WATERS_OF_CLEARANCE, WEB_OF_LIES,
    CLEANSING_FIRE, HOLY_FORTIFICATION, LIGHT_OF_TRUTH,
    DIVINE_PORTAL, DIVINE_WISDOM, BLESSING_OF_DEATH, ETERNAL_JUDGEMENT,
    FREYAS_BRAVERY, HEALING_REST, LUCK_OF_THE_FATHER, WHITE_FLAME
];
