/**
 * Core rulebook — the ten witcher SIGNS, basic and alternate.
 *
 * Signs are the tightest family in the book: every one has a variable cost
 * capped at 7 and bounded by the caster's Vigor Threshold, and every one
 * intensifies with the stamina put into it. That regularity is the point —
 * five pairs of the same sign, and the alternate form is never a new mechanic,
 * only the same one aimed differently.
 *
 * Two errata apply, and both matter:
 *   - Yrden's penalty is min(4, 1+floor((sta-1)/2)), NOT the stamina spent.
 *     The printed text still says "equal to the number of STA you spent".
 *   - That formula is IDENTICAL to Axii's stun-save escalation, Yrden's merely
 *     capped at 4. Invisible while the two are hand-written special cases.
 */

/* ── YRDEN ────────────────────────────────────────────────────────────────
 * "Anything that steps into that circle takes a negative to SPD and REF
 * (equal to the number of STA you spent) until they exit the circle. Any
 * incorporeal creatures that enter the circle become corporeal."
 *
 * Every clause belongs to the CIRCLE rather than to the cast, which is why all
 * three hang off `createZone` and the cast itself does nothing to anybody.
 *
 * The zone layer now runs the body for whoever is ALREADY standing inside when
 * the circle lands — a Yrden dropped on top of an enemy used to sit there doing
 * nothing until they happened to move — and it still skips the caster, which is
 * right twice over: the witcher at the centre did not "step into" anything, and
 * a sign that halved its own caster's SPD and REF would never be cast. */
export const YRDEN = {
    name: "Yrden", tier: "basic", element: "mixed",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        /* SELF, not area — Yrden hits nobody when it is cast.
         *
         * Frame targeting answers "who does this cast land on now", and the
         * answer for Yrden is no one: the circle catches whoever steps in
         * afterwards. Declaring it as an area would make the frame place an
         * aiming template, harvest whoever happened to be standing there, and
         * hand them to blocks that never touch them. */
        targeting: { mode: "self" }, range: 3,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "rounds", value: 5 }
    },
    on: { success: [
        /* The circle's own footprint. Stated here because the cast has no area
         * of its own to inherit — see the note on `createZone`. */
        { b: "core:createZone", a: { shape: "radius", size: "3", anchor: "caster",
              until: "rounds", value: "5" },
          body: [
            /* `untilExitZone`, not the zone's own five rounds: the penalty is
             * membership, and it lifts the moment they step out even if the
             * circle is still burning. Walking in twice does not stack it —
             * the zone layer holds the membership set. */
            { b: "core:grantModifier", a: { stat: "spd", delta: "-min(4,1+floor(({sta}-1)/2))", until: "untilExitZone" } },
            { b: "core:grantModifier", a: { stat: "ref", delta: "-min(4,1+floor(({sta}-1)/2))", until: "untilExitZone" } },
            /* The clause everyone forgets, and the reason a witcher casts it.
             * A REMOVAL, uncontested and one-way: the book says they "become
             * corporeal" and never says they get it back on the way out, so
             * this is `removeStatus` rather than a modifier with a lifetime. */
            { b: "core:removeStatus", a: { status: "incorporeal" } }
        ]}
    ]}
};

/* ── QUEN ─────────────────────────────────────────────────────────────────
 * Two entry points on one item, which is the shape the whole interception
 * design exists to support. The filter is a predicate over the INCOMING
 * item's own defence line — "any spell which can be Blocked" — a dependency
 * running backwards from the attacker's rules text into the defender's damage
 * step, and it only works because the cast record is public. */
export const QUEN = {
    name: "Quen", tier: "basic", element: "earth",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "self" },
        defence: { type: "none" },
        element: "earth",
        /* TWO ENDINGS, AND THE BLOCK HONOURS ONE.
         *
         * "You cannot cast Quen again until your current Quen shield has been
         * exhausted or the duration ends" — so the emptied pool and the printed
         * ten rounds are both real endings. `core:createShield` builds its
         * lifetime as `{ endsOn: duration.alsoEndsOn ?? POOL_EMPTY }`: one
         * condition, no count, and `kind`/`value` are read by nothing.
         *
         * Moving the rounds into `alsoEndsOn` would trade the ending that
         * carries weight for one that cannot fire. `poolEmpty` is what tears
         * the interception subscription down when the shield is spent; and a
         * clock-scaled condition handed no `remaining` gets `Infinity` from
         * `defaultRemaining`, so "10 rounds" would silently become "never".
         *
         * So the pool ending stays wired, the printed duration stays declared
         * where a reader and the cast panel can both see it, and the narration
         * below says the ten rounds out loud — because a card that promises
         * protection until it is exhausted, with no end in sight, is the one
         * thing this engine must not do to a player deciding whether to dodge. */
        duration: { kind: "rounds", value: 10, alsoEndsOn: "poolEmpty" },
        /* The recast lock asks `hasActiveInstance(actor, frame.kind ?? type)`,
         * which matches the `magicKind` FLAG on a standing effect. What it
         * needs from this frame is `kind: "sign"` above — declared, and it is
         * the value the record stamps onto everything a cast leaves behind.
         *
         * Two gaps remain and both are the adapter's, not this file's:
         * `createShield` writes the badge with its own payload (`castShield`,
         * `activeShieldHp`) and no `magicKind`, so the check cannot see Quen's
         * own shield; and it compares a KIND rather than an ITEM, so the moment
         * it can see one sign it refuses all ten. */
        recastLock: true
    },
    on: {
        success: [
            { b: "core:createShield", a: { pool: "5*{sta}", absorbs: "blockable" } },
            { b: "core:narrate", a: { what: "The shield holds for 10 rounds or until it is exhausted, whichever comes first.", scale: "trivial" } }
        ],
        takeDamage: [
            { b: "core:ifIncomingDefenceAllows", a: { defence: "block" }, body: [
                { b: "core:ifDamageChannelNotIn", a: { channels: ["poison", "disease", "suffocation"] }, body: [
                    { b: "core:absorbDamage", a: { parity: "lethalAndNonLethal" } }
                ]}
            ]}
        ]
    }
};

/* ── AARD ─────────────────────────────────────────────────────────────────
 * The prone chance scales linearly with the spend: "a 10% chance of those
 * affected being knocked prone. The percentage rises by 10% for each point of
 * STA spent." At the 7-point cap that is 70%, and the stagger is unconditional
 * either way — the sentence staggers first and only then offers the chance.
 *
 * `ifPercentile` now rolls ONCE PER VICTIM, which is what "those affected"
 * means: a cone catching four people is four rolls and usually a mixed result.
 * One flip used to decide the whole burst, so a 10% chance either knocked
 * everybody down or nobody. */
export const AARD = {
    name: "Aard", tier: "basic", element: "air",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "area", shape: "cone", size: 2 }, range: 2,
        defence: { type: "dodge", ties: "defender" },
        element: "air", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "staggered", until: "rounds", value: "1" } },
        { b: "core:ifPercentile", a: { chance: "10*{sta}" }, body: [
            { b: "core:applyStatus", a: { status: "prone", until: "rounds", value: "1" } }
        ]}
    ]}
};

/* ── IGNI ─────────────────────────────────────────────────────────────────
 * The only entry whose HIT LOCATION depends on distance: "Igni always deals
 * damage to the torso unless used at point blank range. When used at point
 * blank range Igni can be aimed at body locations."
 *
 * Two damage blocks rather than one with a clever argument, because they are
 * genuinely different attacks — one is aimed and one is not.
 *
 * The location vocabulary now says exactly this rule: `torso` is the place,
 * named and fixed, while `aimed` is the caster's called shot FALLING BACK to
 * the torso when they did not call one. Both used to reach the damage pipeline
 * as literals it did not recognise, so every Igni was a torso hit and the
 * point-blank branch existed on paper only.
 *
 * `aimWithin` is left at its default of 1m deliberately: the dialog offers the
 * called-shot control on the same footing the gate below branches on, so a
 * caster is never asked where to aim a burst that is going to hit the chest. */
export const IGNI = {
    name: "Igni", tier: "basic", element: "fire",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "area", shape: "cone", size: 2 }, range: 2,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "fire", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:ifWithin", a: { metres: "1" }, body: [
            { b: "core:dealDamage", a: { formula: "{sta}d6", damageType: "fire", location: "aimed" } }
        ]},
        { b: "core:ifWithin", a: { metres: "1", negate: true }, body: [
            { b: "core:dealDamage", a: { formula: "{sta}d6", damageType: "fire", location: "torso" } }
        ]},
        /* "a 50% chance of lighting ANYTHING IT HITS on fire" — one roll per
         * victim, which the gate now does on its own. The burning outlives the
         * cast: Igni is Immediate and the fire it starts ends when it is put
         * out, which is a per-effect lifetime rather than the cast's. */
        { b: "core:ifPercentile", a: { chance: 50 }, body: [
            { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
        ]}
    ]}
};

/* ── AXII ─────────────────────────────────────────────────────────────────
 * "Stuns an opponent until they can make a Stun save at -1. For every 2 points
 * of additional STA you spend past 1, the Stun save becomes harder by 1 point."
 *
 * That is Yrden's formula without the cap. Seeing the two side by side is the
 * whole argument for expression-typed arguments — as hand-written special
 * cases they look like unrelated rules.
 *
 * WHERE THE −1 LANDS. The Stun save in this system is the system's own: 1d10
 * strictly UNDER `derivedStats.stun` (Core p.47), prompted every round by the
 * status engine for anything carrying `stunned`. So "the Stun save becomes
 * harder by 1 point" is a modifier on that very number, which is what the
 * `stat: "stun"` line below writes — not a bespoke rider, and not a DC.
 *
 * `core:saveEnds` is kept beside it because it is the ENGINE's only cleanup
 * path: passing the save is what ends this cast's status AND its stun penalty
 * together, by `castId`. It is deliberately NOT given `mode: "rollUnder"`,
 * which is the mode the book's save actually is — that branch compares against
 * `system.stats[skill]`, and Stun lives in `derivedStats`, so asking for the
 * honest mode would read a threshold of 0 and make the save impossible. The
 * roll-over form at least resolves the Stun value (`skillTotal` does look in
 * `derivedStats`); its DC is not a number the book gives, and no number here
 * would be, so it is left alone rather than replaced with an invented one.
 *
 * RECASTING STACKS, and nothing in the library can stop it. There is no
 * `stripPriorSource` on `core:applyStatus` and no adapter call that replaces a
 * spell's own prior effect, so a second Axii on the same victim applies a
 * second stun and a second penalty; both then wait for their own save. Putting
 * `core:removeStatus` in front of it is not the fix — that strips ANY stun,
 * including one another caster or a mace put there, and hands Axii a cleanse
 * the book never gave it. The same is true of Puppet below. */
export const AXII = {
    name: "Axii", tier: "basic", element: "water",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "direct", count: 1 }, range: 8,
        defence: { type: "resistMagic", ties: "defender" },
        element: "water", duration: { kind: "saveEnds" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "stunned", until: "saveEnds" } },
        { b: "core:grantModifier", a: { stat: "stun", delta: "-(1+floor(({sta}-1)/2))", until: "saveEnds" } },
        { b: "core:saveEnds", a: { skill: "stun", dcSource: "targetStat", cadence: "round" } }
    ]}
};

/* ── MAGIC TRAP ───────────────────────────────────────────────────────────
 * The only autonomous attacker in the core book, and it needed two things
 * nothing else did: a WIND-UP ("takes one round to prepare") and a body that
 * picks its own victim ("one attack against the closest enemy each round").
 *
 * A trap that is live the instant it is placed is a different spell from one
 * an enemy can walk past during setup, so the delay has to be sayable rather
 * than assumed. */
export const MAGIC_TRAP = {
    name: "Magic Trap", tier: "alternate", element: "mixed",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "point" }, range: 3,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "mixed", duration: { kind: "rounds", value: "{sta}" }
    },
    on: { success: [
        { b: "core:afterRounds", a: { rounds: "1" }, body: [
            /* BOUNDED BY THE SIGN'S OWN DURATION.
             *
             * The clock was opened with no `rounds` at all, so once the trap
             * armed it attacked the nearest enemy every round for the rest of
             * the session — and the frame's `{sta}`-round duration was read by
             * nothing, because a frame duration governs the CAST and never the
             * things a cast leaves behind. Only a lifetime can end those, and
             * this is the one that ends the trap.
             *
             * The wind-up round is not deducted: the book says the trap "takes
             * one round to prepare" and gives no rule making that preparation
             * come out of its lifespan, and inventing one here would be a
             * number the book does not have. */
            { b: "core:repeatEachRound", a: { rounds: "{sta}" }, body: [
                { b: "core:targetNearest", a: { count: "1", of: "enemy", within: "3" }, body: [
                    { b: "core:contest", a: { against: "blockOrDodge", use: "newRoll" }, body: [
                        { b: "core:dealDamage", a: { formula: "3d6", damageType: "bludgeoning" } }
                    ]}
                ]}
            ]}
        ]}
    ]}
};

/* ── ACTIVE SHIELD ────────────────────────────────────────────────────────
 * Upkeep equal to the INITIAL cost — the frame already understood that word,
 * because Fire Stream needs "half" and Quen needs neither.
 *
 * The parting blast is the interesting part: "when the shield is expended or
 * dropped, anything adjacent to you is pushed back 2m and takes 1d6 damage to
 * the torso. This includes objects, furniture, and allies."
 *
 * A real attack, from a spell that has already ended, hurting people the cast
 * never targeted — and it must fire whether the shield expired, was dispelled,
 * or was emptied. There was nowhere to put that until `onExpire` existed.
 *
 * Both of this spell's endings now reach it: the pool emptying fires the
 * shield's own lifetime, and a round whose upkeep goes unpaid fires the
 * concentration lifetime. "When the shield is expended OR DROPPED" is one
 * clause with two causes, and the tree must not be able to tell them apart.
 *
 * Which is also the one thing to watch: they are two lifetimes and each runs
 * the tree, so a shield that is emptied on Tuesday and then stops being paid
 * for on Wednesday blasts the room twice. `runExpiryTree` has no once-per-cast
 * guard, and there is nothing an authored tree can do about that — the clause
 * is "one ending, two causes" and the engine currently models "two endings".
 *
 * `upkeep: "initial"` is the word the frame reads for "a number of STA points
 * equal to the initial STA cost", and the round tick now actually charges it —
 * every maintained spell in the game was free after round one. */
export const ACTIVE_SHIELD = {
    name: "Active Shield", tier: "alternate", element: "earth",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "self" },
        defence: { type: "none" },
        element: "earth",
        duration: { kind: "active", upkeep: "initial", alsoEndsOn: "poolEmpty" }
    },
    on: {
        success: [
            { b: "core:createShield", a: { pool: "10*{sta}", absorbs: "tangible" } },
            { b: "core:narrate", a: { what: "Nothing tangible passes in or out without destroying the shield first, and you cannot run while it holds. One other person fits if you are pressed together.", scale: "notable" } }
        ],
        takeDamage: [
            { b: "core:absorbDamage", a: { parity: "lethalAndNonLethal" } }
        ],
        onExpire: [
            /* "ANYTHING adjacent to you ... This includes objects, furniture,
             * and allies." `of: "creature"` is every token but the caster's,
             * friend or foe — the one place in the corpus where hitting your
             * own side is the printed rule rather than a bug.
             *
             * `within: 2` is ADJACENCY, not the 2m push below sharing a number
             * by accident. The scene grid is 1.5m to the tile, so a token in
             * the next square measures 1.5m away and one square further out
             * measures 3m: a 2m search is exactly the ring of squares touching
             * the caster, and `within: 1` would find nobody at all.
             *
             * `onImpact: "none"` because this spell says only "pushed back 2m".
             * Bronwyn's Gust is the one that adds ramming damage, and it says
             * so; borrowing its rider here would invent damage twice over. */
            { b: "core:targetNearest", a: { count: "99", of: "creature", within: "2" }, body: [
                { b: "core:knockback",  a: { distance: "2", onImpact: "none" } },
                { b: "core:dealDamage", a: { formula: "1d6", damageType: "bludgeoning", location: "torso" } }
            ]},
            { b: "core:narrate", a: { what: "Creatures nearby are thrown back and take the damage — that much is applied. Objects and furniture are not: nothing on the map is moved for them, and the rule that anything rooted down or heavier than 226kg holds its ground (while still taking the damage) is yours to call.", scale: "major" } }
        ]
    }
};

/* ── AARD SWEEP ───────────────────────────────────────────────────────────
 * "For each STA point spent, everything caught in the burst has a 10% chance
 * of being knocked to the ground AND staggered."
 *
 * The same 10-per-point ladder as Aard, and the reading that settles Aard's
 * looser phrasing: one point buys 10%, seven buy 70%. But where Aard staggers
 * unconditionally and only rolls for the knockdown, here BOTH ride the roll —
 * the sentence puts them on the same side of the chance, so they are in the
 * same body. The flying clause is inside it for the same reason: the book
 * knocks them out of the air "as well as being knocked down", which is not
 * something that happens to a creature the burst failed to floor. */
export const AARD_SWEEP = {
    name: "Aard Sweep", tier: "alternate", element: "air",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 4, excludeCaster: true }, range: 4,
        defence: { type: "dodge", ties: "defender" },
        element: "air", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:ifPercentile", a: { chance: "10*{sta}" }, body: [
            { b: "core:applyStatus", a: { status: "prone",     until: "rounds", value: "1" } },
            { b: "core:applyStatus", a: { status: "staggered", until: "rounds", value: "1" } },
            { b: "core:narrate", a: { what: "Flying creatures caught in the burst are knocked out of the air as well as knocked down.", scale: "notable" } }
        ]}
    ]}
};

/* ── FIRE STREAM ──────────────────────────────────────────────────────────
 * Upkeep of HALF the initial spend, which is the third upkeep phrasing in the
 * book and the reason `openUpkeep` takes a word rather than a number. "Fire
 * Stream must be maintained every round with a number of STA points equal to
 * 1/2 the number of STA points spent to cast the sign" — `upkeep: "half"`
 * resolves to `ceil(sta/2)` and the round tick charges it.
 *
 * "The stream CAN BE AIMED at body locations", with no distance attached —
 * unlike Igni, which may only be aimed at point blank. `aimWithin` defaults to
 * 1m for everything, so without saying otherwise the called-shot control
 * vanished the moment the caster stood back from the target and every aimed
 * hit fell through to the torso. It is set to the spell's own 3m reach: the
 * range the frame already declares, not a number invented for the dialog. */
export const FIRE_STREAM = {
    name: "Fire Stream", tier: "alternate", element: "fire",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "direct", count: 1 }, range: 3,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "fire", duration: { kind: "active", upkeep: "half" }
    },
    on: { hit: [
        { b: "core:dealDamage", a: { formula: "{sta}d6", damageType: "fire",
              location: "aimed", aimWithin: "3" } },
        /* The burning ends when it is PUT OUT, not when the stream stops: a
         * caster who drops the spell on round two leaves the target alight. */
        { b: "core:ifPercentile", a: { chance: 75 }, body: [
            { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
        ]},
        { b: "core:narrate", a: { what: "You may switch targets on your turn, and the stream can be aimed at body locations.", scale: "trivial" } }
    ]}
};

/* ── PUPPET ───────────────────────────────────────────────────────────────
 * A duration measured in the stamina spent, re-contested every round against
 * the ORIGINAL casting roll — which is the third rule in the book demanding
 * that the cast record persist for as long as its effect does. */
export const PUPPET = {
    name: "Puppet", tier: "alternate", element: "water",
    frame: {
        kind: "sign", cost: { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "direct", count: 1 }, range: 8,
        defence: { type: "resistMagic", ties: "defender" },
        element: "water", duration: { kind: "rounds", value: "{sta}" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "charmed", until: "rounds", value: "{sta}" } },
        { b: "core:saveEnds",    a: { skill: "resistmagic", dcSource: "castRoll", cadence: "round" } }
    ]}
};

export const SIGNS = [
    YRDEN, QUEN, AARD, IGNI, AXII,
    MAGIC_TRAP, ACTIVE_SHIELD, AARD_SWEEP, FIRE_STREAM, PUPPET
];
