/**
 * Core rulebook — EARTH spells, all three tiers.
 *
 * "For the purposes of magic, earth is used as a catch-all term for both the
 * mineral form of earth and also natural and living things such as plants and
 * animals." Which is why healing lives here rather than under a light element
 * the game does not have.
 */

/* ── CENLLY GRAIG ─────────────────────────────────────────────────────────
 * ERRATA. The printing reads "For every point you roll above your opponent's
 * defense (maximum 10) you deal 1d6 damage. EACH ROLL COUNTS AS ITS OWN
 * ATTACK." The errata DELETES that last sentence.
 *
 * The deletion is the whole point. It turns Cenlly Graig from a multi-attack
 * into a single attack whose margin scales one damage pool — which changes
 * armour from being subtracted ten times to being subtracted once, and that is
 * the difference between unusable and merely strong. A text diff never
 * surfaces a deleted sentence, so this is the errata line most likely to be
 * silently reverted by someone reading the book. */
export const CENLLY_GRAIG = {
    name: "Cenlly Graig", tier: "novice", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "direct", count: 1 }, range: 5,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "earth", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:dealDamage", a: { formula: "min(10,{margin})d6", damageType: "bludgeoning" } }
    ]}
};

/* ── CODI BYWYD ───────────────────────────────────────────────────────────
 * Grows a herb. The mechanical consequence is entirely in the alchemy
 * subsystem, which is a hook this engine does not own yet. */
export const CODI_BYWYD = {
    name: "Codi Bywyd", tier: "novice", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "self" }, range: 4,
        defence: { type: "none" },
        element: "earth", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:narrate", a: { what: "A small plant grows from seed to maturity in one turn — herbs and alchemical plants, but nothing so large as a tree.", scale: "notable" } }
    ]}
};

/* ── DIAGNOSTIC SPELL ─────────────────────────────────────────────────────
 * Reads exact HP, critical wounds, and disease/poison state. Whispered, not
 * posted: a diagnostic that prints a monster's exact remaining HP to the whole
 * table hands everyone information one character paid five Stamina for. */
export const DIAGNOSTIC_SPELL = {
    name: "Diagnostic Spell", tier: "novice", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "direct", count: 1 }, range: 5,
        defence: { type: "none" },
        element: "earth", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:revealInfo", a: { about: "health", to: "caster",
              detail: "Health Points, critical wounds, and whether they are sick or poisoned." } }
    ]}
};

/* ── EARTHEN SPIKE ────────────────────────────────────────────────────────
 * The axis that broke the previous engine's model: an INSTANT cast that leaves
 * a persistent object behind. The old schema tied every created thing's
 * lifetime to the spell's duration, so a spike from an Immediate spell either
 * vanished at once or the whole spell had to be mis-declared as lasting.
 * Effects carry their own end conditions here, so `Duration: Immediate` and a
 * spike that stands until someone does 20 damage to it are both true.
 *
 * The 20 is the book's own number — "It can be destroyed by doing 20 points of
 * damage to it" — and it is kept even though there is no token behind the
 * spike. `adapter.createObject` posts it as a card the GM places, with the 20
 * printed on it and the placement asked for out loud. That is the honest half
 * of an unautomated rule; dropping the number because nothing tracks it would
 * take the rule away from the table as well as from the engine. */
export const EARTHEN_SPIKE = {
    name: "Earthen Spike", tier: "novice", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "direct", count: 1 }, range: 6,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "earth", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:dealDamage",  a: { formula: "5d6", damageType: "piercing" } },
        { b: "core:createObject", a: { what: "stalagmite", hp: "20", until: "untilDestroyed" } }
    ]}
};

/* ── KORATH'S BREATH ──────────────────────────────────────────────────────
 * A cone that blinds rather than damages. "Opponents in that area that fail
 * their defense are blinded" — the per-target hit filter again, so nothing
 * special is needed to spare the ones who dodged. */
export const KORATHS_BREATH = {
    name: "Korath's Breath", tier: "novice", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "area", shape: "cone", size: 3 }, range: 3,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "earth", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "blinded", until: "rounds", value: "1d6" } }
    ]}
};

/* ── LUTHIEN'S QUILL ──────────────────────────────────────────────────────*/
export const LUTHIENS_QUILL = {
    name: "Luthien's Quill", tier: "novice", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "self" }, range: 1,
        defence: { type: "none" },
        element: "earth", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:narrate", a: { what: "Writing or drawing is etched into any solid surface. It cannot be used on living creatures.", scale: "trivial" } }
    ]}
};

/* ── MAGIC HEALING ────────────────────────────────────────────────────────
 * ERRATA: 3 points a round, not 5. Also the only entry that says a spell "can
 * be used repeatedly to heal a critical wound" — a hook into the critical
 * wound subsystem rather than into damage.
 *
 * "THIS LASTS FOR THE DURATION OF THE SPELL", and the repeat has to say so
 * itself. `core:repeatEachRound` with no `rounds` registers a clock with
 * `rounds: null`, and `advanceMagicClocks` never spends one of those — so a
 * Magic Healing cast in the first fight of an evening went on giving its
 * target 3 a round for the rest of the session. Nothing else stopped it
 * either: this is not a maintained spell, so there is no upkeep to lapse and
 * call `cancelClocks`, and a frame duration of `rounds` opens no lifetime at
 * all. The bound below is the frame's own duration, restated where the clock
 * can read it.
 *
 * It is not yet enough on its own, and the gap is one line deep: the block
 * `evaluate`s `rounds` instead of rolling it, so "1d10" arrives at the clock as
 * a string and `elapsed >= "1d10"` is never true. It wants `rollDuration`, the
 * way `applyStatus` and `createZone` already treat their `value`. Authored to
 * the book so the fix lands in the engine rather than in eleven entries. */
export const MAGIC_HEALING = {
    name: "Magic Healing", tier: "novice", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "direct", count: 1 }, range: 2,
        defence: { type: "none" },
        element: "earth", duration: { kind: "rounds", value: "1d10" }
    },
    on: { success: [
        { b: "core:repeatEachRound", a: { rounds: "1d10" }, body: [
            { b: "core:healHealth", a: { formula: "3" } }
        ]},
        { b: "core:narrate", a: { what: "Cast repeatedly, this spell can instead heal a critical wound.", scale: "notable" } }
    ]}
};

/* ── TALFRYN'S PRISON ─────────────────────────────────────────────────────
 * TWO independent escapes from one effect, which is the shape worth noting:
 * 15 damage to the roots breaks them, OR a Dodge/Escape check at a DC equal to
 * the ORIGINAL Spell Casting roll. Either ends it, and neither is the spell's
 * duration — `Until Destroyed` is the third.
 *
 * The 15 is the book's ("The roots take 15 points of damage to break") and is
 * kept for the same reason Earthen Spike keeps its 20: `createObject` prints it
 * on a card the GM places rather than tracking it on a token, and a number the
 * table has to act on is worse omitted than unautomated. */
export const TALFRYNS_PRISON = {
    name: "Talfryn's Prison", tier: "novice", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "dodge", ties: "defender" },
        element: "earth", duration: { kind: "untilDestroyed" }
    },
    on: { hit: [
        { b: "core:applyStatus",  a: { status: "entangled", until: "untilDestroyed" } },
        { b: "core:createObject", a: { what: "roots", hp: "15", until: "untilDestroyed" } },
        { b: "core:saveEnds",     a: { skill: "dodge", dcSource: "castRoll", cadence: "round" } }
    ]}
};

/* ── ELGAN'S THEORY ───────────────────────────────────────────────────────
 * Magnetises metal. The mechanical bite is a load penalty — "all metal that
 * sticks to someone's weapons or armor counts against their ENC" — plus a
 * DC:18 Physique check to pry anything off.
 *
 * ANCHORED FREE, NOT TO THE OBJECT. `anchor: "object"` is the one value
 * `adapter.createZone` skips its aiming step for, and nothing else ever
 * supplies a position — so `createZoneTemplate` received a spec with no x and
 * no y, `Number(placement.x) || 0` resolved both to zero, and the 2m circle
 * was drawn at scene coordinate (0,0): off in a corner, catching nobody, for
 * every cast of this spell. "Free" is what the aiming overlay actually has,
 * and it is the right shape here: the caster clicks the thing they just
 * magnetised and the circle is drawn around it.
 *
 * What is genuinely lost is that the circle does not FOLLOW the object if
 * somebody picks it up and walks off — that needs a placement bound to a
 * document, which the overlay cannot express. A circle in the right place for
 * 2d10 rounds beats a circle in the corner of the map for the same 2d10. */
export const ELGANS_THEORY = {
    name: "Elgan's Theory", tier: "journeyman", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 10 },
        targeting: { mode: "direct", count: 1 }, range: 8,
        defence: { type: "none" },
        element: "earth", duration: { kind: "rounds", value: "2d10" }
    },
    on: { success: [
        { b: "core:createZone", a: { shape: "radius", size: "2", anchor: "free",
              until: "rounds", value: "2d10" },
          body: [
            { b: "core:applyStatus", a: { status: "stuckToMagnet", until: "untilExitZone" } }
        ]},
        { b: "core:narrate", a: { what: "DC:18 Physique to pry an object off. Metal stuck to a creature's gear counts against their ENC.", scale: "notable" } }
    ]}
};

/* ── RHWYSTR GRAIG ────────────────────────────────────────────────────────
 * "A 2m by 3m rock wall with 30 points of SP anywhere within 10m." Objects
 * take SP, not HP — armour points, not health — which is a distinction
 * `createObject` has to keep or a wall becomes trivially destructible.
 *
 * Two of the three printed numbers were wrong here. The range was authored as
 * 20, which is twice what the book allows and the sort of error the range gate
 * enforces faithfully: a wall placed 18m away was refused by nobody. And the
 * wall was given `hp: "60"`, which appears nowhere in the spell — the book
 * gives it SP and only SP. An invented 60-point pool turns a wall you have to
 * out-hit into a wall you can grind down, which is the whole difference
 * between cover and a delay.
 *
 * `hp` is now left off rather than restated, so the entry asserts no number the
 * book does not give. That is as close as the block gets: `core:createObject`
 * has no way to say "no pool at all" — `hp` defaults to 10 and an explicit
 * null evaluates to 0, which the card then hides — so 10 is what the GM sees
 * beside the 30 SP. A genuinely HP-less object needs a nullable `hp`. */
export const RHWYSTR_GRAIG = {
    name: "Rhwystr Graig", tier: "journeyman", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 15 },
        targeting: { mode: "point" }, range: 10,
        defence: { type: "none" },
        element: "earth", duration: { kind: "untilDestroyed" }
    },
    on: { success: [
        { b: "core:createObject", a: { what: "rockWall", sp: "30", size: "2x3",
              until: "untilDestroyed" } }
    ]}
};

/* ── STAMMELFORD'S EARTHQUAKE ─────────────────────────────────────────────
 * The densest entry in the Earth list, and a good stress test: a zone with
 * standing modifiers, a check inside it, a percentile roll against scenery,
 * and terrain that OUTLIVES the spell. Four different lifetimes in one effect,
 * none of them the duration.
 *
 * THE ATHLETICS ROLL RAN BACKWARDS. "Each round, a creature in the spell's
 * area must make an Athletics roll or sink into the crumbling ground, which
 * causes them to suffocate until they make a successful Athletics check to
 * climb out." That is two checks pointing in opposite directions: a FAILURE
 * starts the suffocation, a later SUCCESS ends it. `core:saveEnds` is only ever
 * the second one — it registers a clock that ends everything marked `saveEnds`
 * the moment the roll is made — so a bare `saveEnds` here authored the escape
 * from a state nothing had ever put anybody into. The quake shook a 10m circle
 * and the worst that could befall you was passing a check.
 *
 * `core:contest` is the missing first half: its body runs for exactly those the
 * caster's roll beat, which is the set of people who failed theirs. The book
 * prints no DC for the sinking roll, so it stands against the casting roll —
 * `use: "castRoll"`, the same standing number the escape is already measured
 * against, rather than a fresh roll the ground has no reason to make. The
 * status is `suffocating`, which is the book's own word for what happens next
 * and aliases to the system's registered `suffocation`.
 *
 * The sinking check fires when the ground opens under someone or when they
 * walk into it, not once a round. `core:repeatEachRound` inside a zone body
 * registers a clock with no bound that the zone's own expiry does not cancel
 * — see Magic Healing — so a 1d10-round quake would go on demanding Athletics
 * rolls for the rest of the session. One check on entry plus the per-round
 * escape rolls that follow it is as much of the cadence as the clock can carry
 * honestly. */
export const STAMMELFORDS_EARTHQUAKE = {
    name: "Stammelford's Earthquake", tier: "journeyman", element: "earth",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 12 },
        targeting: { mode: "area", shape: "radius", size: 10 }, range: 30,
        defence: { type: "dodge", ties: "defender" },
        element: "earth", duration: { kind: "rounds", value: "1d10" }
    },
    on: { hit: [
        { b: "core:createZone", a: { anchor: "free", until: "rounds", value: "1d10" },
          body: [
            { b: "core:grantModifier", a: { stat: "ref", delta: "-2", until: "untilExitZone" } },
            { b: "core:grantModifier", a: { stat: "spd", delta: "-3", until: "untilExitZone" } },
            { b: "core:contest", a: { against: "athletics", use: "castRoll" }, body: [
                { b: "core:applyStatus", a: { status: "suffocating", until: "saveEnds" } },
                { b: "core:saveEnds", a: { skill: "athletics", dcSource: "castRoll", cadence: "round" } }
            ]}
        ]},
        { b: "core:ifPercentile", a: { chance: 10 }, body: [
            { b: "core:narrate", a: { what: "A small structure on the shattered ground collapses.", scale: "major" } }
        ]},
        /* Outlives the duration. The ground stops churning; it stays broken. */
        { b: "core:narrate", a: { what: "After the spell ends the ground stops churning, but it remains shattered terrain.", scale: "notable" } }
    ]}
};

export const EARTH = [
    CENLLY_GRAIG, CODI_BYWYD, DIAGNOSTIC_SPELL, EARTHEN_SPIKE, KORATHS_BREATH,
    LUTHIENS_QUILL, MAGIC_HEALING, TALFRYNS_PRISON,
    ELGANS_THEORY, RHWYSTR_GRAIG, STAMMELFORDS_EARTHQUAKE
];
