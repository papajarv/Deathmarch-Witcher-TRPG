/**
 * Core rulebook — AIR spells, all three tiers.
 *
 * Two shapes recur here and nowhere else in the book: DISPLACEMENT (throw a
 * body some distance and see what it hits) and DEFLECTION (a threshold that
 * turns projectiles aside without ever depleting). Neither is damage, and
 * treating them as damage is how both ended up unusable before.
 */

/* ── ADENYDD ──────────────────────────────────────────────────────────────
 * "If you make it to the ground within the duration of the spell you take no
 * damage." That waiver is narration and has to stay narration: the only block
 * that can stop damage is `core:absorbDamage`, it needs an `incoming` payload,
 * and the only thing that ever publishes one is `core:dealDamage` by way of
 * `applyDamageWithInterception`. A fall is resolved by the GM and never enters
 * the magic bus at all, so a ward authored for it would sit there unfired
 * while the character hit the ground. The `gliding` status is what the table
 * adjudicates the waiver from, and it lasts exactly as long as the spell. */
export const ADENYDD = {
    name: "Adenydd", tier: "novice", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 4 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "air", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:applyStatus", a: { status: "gliding", until: "upkeepUnpaid" } },
        { b: "core:narrate", a: { what: "For each 2m you fall you travel 2m sideways. Reach the ground within the duration and you take no falling damage.", scale: "notable" } }
    ]}
};

/* ── AIR POCKET ───────────────────────────────────────────────────────────*/
export const AIR_POCKET = {
    name: "Air Pocket", tier: "novice", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "point" }, range: 12,
        defence: { type: "none" },
        element: "air", duration: { kind: "rounds", value: "2d10" }
    },
    on: { success: [
        { b: "core:createZone", a: { shape: "radius", size: "1", anchor: "free",
              until: "rounds", value: "2d10" },
          body: [
            { b: "core:applyStatus", a: { status: "breathing", until: "untilExitZone" } }
        ]}
    ]}
};

/* ── BRONWYN'S GUST ───────────────────────────────────────────────────────
 * Displacement scaled by margin, with a consequence that depends on the map:
 * "knock a target back a number of meters equal to the number of points you
 * rolled over the opponent's defense... if your opponent strikes something they
 * take ramming damage."
 *
 * Whether there is a wall behind them is not something a tree can know, which
 * is why the impact goes through the adapter rather than being narrated. */
export const BRONWYNS_GUST = {
    name: "Bronwyn's Gust", tier: "novice", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "direct", count: 1 }, range: 2,
        defence: { type: "dodge", ties: "defender" },
        element: "air", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:dealDamage", a: { formula: "1d6", damageType: "bludgeoning" } },
        { b: "core:knockback",  a: { distance: "{margin}", onImpact: "ramming" } }
    ]}
};

/* ── FRESHEN AIR ──────────────────────────────────────────────────────────*/
export const FRESHEN_AIR = {
    name: "Freshen Air", tier: "novice", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 4 }, range: 4,
        defence: { type: "none" },
        element: "air", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:createZone", a: { anchor: "caster", until: "upkeepUnpaid" },
          body: [
            { b: "core:applyStatus", a: { status: "cleanAir", until: "untilExitZone" } }
        ]}
    ]}
};

/* ── URIEN'S SHELTER ──────────────────────────────────────────────────────*/
export const URIENS_SHELTER = {
    name: "Urien's Shelter", tier: "novice", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 8 }, range: 8,
        defence: { type: "none" },
        element: "air", duration: { kind: "hours", value: "1d6" }
    },
    on: { success: [
        { b: "core:createZone", a: { anchor: "caster", until: "hours", value: "1d6" },
          body: [
            { b: "core:applyStatus", a: { status: "shelteredFromWeather", until: "untilExitZone" } }
        ]}
    ]}
};

/* ── STATIC STORM ─────────────────────────────────────────────────────────
 * Per-round area damage with a predicate over each victim's GEAR: "anyone
 * within this area (excluding you) who is wearing metal armor or carrying
 * metal weapons takes 2 points of damage per round."
 *
 * The sidebar is worth heeding — "it would be a shame to cast Static Storm in
 * a desperate situation and accidentally wound your whole party" — so the
 * exclusion of the caster is part of the spell, not a courtesy. */
export const STATIC_STORM = {
    name: "Static Storm", tier: "novice", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 5, excludeCaster: true }, range: 5,
        defence: { type: "none" },
        element: "air", duration: { kind: "rounds", value: "2d6" }
    },
    on: { success: [
        { b: "core:createZone", a: { anchor: "caster", until: "rounds", value: "2d6" },
          body: [
            { b: "core:repeatEachRound", body: [
                { b: "core:ifTargetHas", a: { trait: "metalGear" }, body: [
                    { b: "core:dealDamage", a: { formula: "2", damageType: "lightning" } }
                ]}
            ]}
        ]}
    ]}
};

/* ── TELEKINESIS ──────────────────────────────────────────────────────────
 * The capacity is arithmetic the player needs and only the engine can do —
 * "up to 5 ENC per 1 point of Spell Casting" — inside a sentence. That is why
 * `narrate` takes `values`: expressions evaluate in an expression slot and
 * interpolate into a string slot, without either job leaking into the other.
 *
 * THE CAP IS TOO HIGH AND NO EXPRESSION FIXES IT. The book says "up to 5 ENC
 * per 1 point of Spell Casting" — the RANK, and `{rank}` is now published
 * beside `{skill}` for exactly this. `{skill}` is `adapter.skillValue`,
 * which is `skillTotal()`: rank plus modifier plus the governing stat. A WILL
 * 8 mage with 4 ranks therefore reads 60 ENC off this card where the book
 * gives 20, and lifts a horse. The expression language publishes five
 * variables and none of them is the bare rank (see VARS in expression.mjs), so
 * the correction cannot be authored here — it needs a `{rank}` the frame
 * publishes beside `{skill}`. Named rather than quietly left wrong: the
 * arithmetic is the entire reason this entry computes anything at all. */
export const TELEKINESIS = {
    name: "Telekinesis", tier: "novice", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "point" }, range: 5,
        defence: { type: "none" },
        element: "air", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:narrate", a: {
            what: "You lift and manipulate an object of up to {cap} ENC. Skill-based tasks use WILL and Spell Casting at -3; complex actions such as picking locks or loading a crossbow take -5. Thrown objects use WILL, not BODY, for range.",
            values: { cap: "5*{rank}" }, scale: "notable" } }
    ]}
};

/* ── ZEPHYR ───────────────────────────────────────────────────────────────
 * Bronwyn's Gust in an area, at a flat distance. Same block, different
 * argument — which is the test of whether `knockback` was the right shape. */
export const ZEPHYR = {
    name: "Zephyr", tier: "novice", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 2, excludeCaster: true }, range: 2,
        defence: { type: "none" },
        element: "air", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:dealDamage", a: { formula: "1d6", damageType: "bludgeoning" } },
        { b: "core:knockback",  a: { distance: "6", onImpact: "ramming" } }
    ]}
};

/* ── GWYNT TROELLI ────────────────────────────────────────────────────────
 * A THRESHOLD, not a pool. "Any projectile attack must beat your Spell Casting
 * roll. If they fail, the barrier knocks the projectile 8m away in a random
 * direction."
 *
 * Quen's shield eats damage and shrinks; this turns an attack aside entirely
 * or lets it through untouched, and never depletes. Authoring it as absorption
 * would hand it a hit-point pool the spell does not have, and the difference
 * shows the first time an archer with a strong roll shoots through it.
 *
 * AND NOTHING CAN DELIVER IT YET — two independent gaps, either enough on its
 * own. `incomingAttack` is in `UNFIRED_ENTRIES`: no call to `publish(ENTRY.
 * INCOMING_ATTACK)` exists anywhere, because the weapon pipeline never reaches
 * the magic bus. And `core:createShield` is the ONLY caller of `subscribe()`,
 * so even a fired entry would find nothing listening on this item. Using
 * `createShield` to get a subscription is not the way out: it writes
 * `system.derivedStats.shield`, which is exactly the hit-point pool the
 * paragraph above says this spell does not have, and an archer would then chip
 * a wall of wind down instead of being turned aside or not.
 *
 * So the tree stays — a tree authored under an unfired entry is deliberately
 * kept valid (see legality.mjs), and this one is right the day the pipeline
 * publishes — and the CARD is what changes. It used to announce a barrier
 * "turning aside ranged attacks" while the world received nothing whatever,
 * which is the failure a player acts on by not dodging. */
export const GWYNT_TROELLI = {
    name: "Gwynt Troelli", tier: "journeyman", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 12 },
        targeting: { mode: "self" }, range: 10,
        defence: { type: "none" },
        element: "air", duration: { kind: "active", upkeep: 4 }
    },
    on: {
        success: [
            { b: "core:narrate", a: { what: "A barrier of wind surrounds you. Any projectile attack must beat your Spell Casting roll; one that fails is knocked 8m away in a random direction. Nothing intercepts the shot for you — call it at the table.", scale: "notable" } }
        ],
        /* The second entry point — the same two-tree shape as Quen. */
        incomingAttack: [
            { b: "core:ifDamageChannelNotIn", a: { channels: ["melee", "poison", "disease", "suffocation"] }, body: [
                { b: "core:deflect", a: { threshold: "castRoll", scatter: "8" } }
            ]}
        ]
    }
};

/* ── DERVISH ──────────────────────────────────────────────────────────────
 * Explicitly defined in terms of two other spells: "immediately redirects
 * ranged attacks as per Gwynt Troelli and acts as a Zephyr spell against
 * anyone within 2m of you."
 *
 * Composed from the same blocks rather than cross-referencing another entry.
 * A spell that imported another spell's tree would break the moment either was
 * edited, and the book's own cross-reference is a shorthand for a reader, not
 * a dependency.
 *
 * It inherits Gwynt Troelli's problem along with its blocks: the redirection
 * half hangs off `incomingAttack`, which nothing fires and nothing subscribes
 * (the reasoning is written out there). The tornado half is real — it knocks
 * people down and into walls through the adapter — so the card has to say
 * which of the two the table is holding, or a player reads "Dervish" and
 * assumes arrows are being handled. */
export const DERVISH = {
    name: "Dervish", tier: "journeyman", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 22 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 2, excludeCaster: true }, range: 2,
        defence: { type: "dodge", ties: "defender" },
        element: "air", duration: { kind: "active", upkeep: 6 }
    },
    on: {
        hit: [
            { b: "core:dealDamage", a: { formula: "1d6", damageType: "bludgeoning" } },
            { b: "core:knockback",  a: { distance: "6", onImpact: "ramming" } },
            { b: "core:narrate", a: { what: "You cannot run while inside the tornado, nor attack out of it. Anyone you move within 2m of is thrown as by Zephyr. Ranged attacks are redirected as by Gwynt Troelli — call that at the table; nothing intercepts them for you.", scale: "notable" } }
        ],
        incomingAttack: [
            { b: "core:ifDamageChannelNotIn", a: { channels: ["melee", "poison", "disease", "suffocation"] }, body: [
                { b: "core:deflect", a: { threshold: "castRoll", scatter: "8" } }
            ]}
        ]
    }
};

/* ── SUFFOCATE ────────────────────────────────────────────────────────────
 * Damage on a channel Quen explicitly cannot touch, and an end condition
 * nothing else in the book has: "the suffocation ends if the caster is struck
 * with a weapon or stops focusing on the spell."
 *
 * The second half is upkeep, which the frame owns. The first is a lifetime
 * that watches SOMEONE ELSE'S misfortune — the caster's, not the victim's —
 * and it is the only rule in the core book shaped that way.
 *
 * Which is also why nothing can carry it yet, and why it is NOT moved onto the
 * status. `register.mjs` fires `ENDS.CASTER_STRUCK` against the lifetimes of
 * whichever actor's HP just dropped, so the condition has to sit on a
 * CASTER-owned lifetime. The only caster-owned lifetime this cast makes is the
 * frame's upkeep, and `openUpkeep` hardcodes `ENDS.UPKEEP_UNPAID` — nothing
 * there reads `alsoEndsOn`; `core:createShield` is its one reader, and there is
 * no shield here. Putting it on the status's own `until` would be worse than
 * leaving it: that lifetime belongs to the VICTIM, and this spell takes 1d10
 * off the victim every round, so the suffocation would end on the round it
 * started, every single time. The declaration stays where the rule is true —
 * one line in `openUpkeep` makes it real — and the card says it aloud until
 * then, because a GM who is not told cannot apply it by hand either. */
export const SUFFOCATE = {
    name: "Suffocate", tier: "journeyman", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 14 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "resistMagic", ties: "defender" },
        element: "air", duration: { kind: "active", upkeep: 4, alsoEndsOn: "casterStruck" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "staggered", until: "upkeepUnpaid" } },
        { b: "core:repeatEachRound", body: [
            { b: "core:dealDamage", a: { formula: "1d10", damageType: "bludgeoning",
                  channel: "suffocation", bypassArmour: true } }
        ]},
        { b: "core:narrate", a: { what: "The suffocation ends if the caster is struck with a weapon. Stop it by hand when that happens — dropping the upkeep is the only end the engine applies on its own.", scale: "notable" } }
    ]}
};

/* ── ALZUR'S THUNDER ──────────────────────────────────────────────────────
 * Sequential falloff along a line: "Alzur's Thunder can travel in a straight
 * line through targets. For every target it passes through the damage to the
 * next target decreases by 1d6."
 *
 * Expressed with `{index}` rather than a bespoke block, which is the whole
 * argument for expression-typed arguments — and `max(1,...)` is load-bearing,
 * because a line long enough would otherwise roll negative dice. */
export const ALZURS_THUNDER = {
    name: "Alzur's Thunder", tier: "journeyman", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 15 },
        targeting: { mode: "area", shape: "line", size: 25 }, range: 25,
        defence: { type: "dodge", ties: "defender" },
        element: "air", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:forEachTarget", body: [
            { b: "core:dealDamage", a: { formula: "max(1,8-{index})d6", damageType: "lightning" } },
            { b: "core:ifPercentile", a: { chance: 75 }, body: [
                { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
            ]}
        ]}
    ]}
};

/* ── LIGHTNING STORM ──────────────────────────────────────────────────────
 * Two rolls per round, for the life of the storm, against everyone but the
 * caster: a 35% strike chance, and THEN an opposed Dodge/Escape for whoever it
 * picked out. The frame performs exactly one opposed roll and cannot repeat it
 * on a clock, which is the whole argument for `core:contest` existing.
 *
 * ONE DODGE, NOT TWO. The frame also declared `dodge`, so the cast opened by
 * making everyone inside a 20m circle dodge the storm as it formed, and the
 * survivors then dodged again inside the first round's strike — two checks
 * where the book prints one, and the first of them decided who the storm was
 * even allowed to threaten. There is nothing to dodge as it forms: the storm is
 * weather, not an attack, and the only sentence naming a defence is the one
 * inside the loop ("if they miss this roll, they must make a Dodge/Escape
 * check"). So the frame opposes nobody and the cast simply succeeds. */
export const LIGHTNING_STORM = {
    name: "Lightning Storm", tier: "journeyman", element: "air",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 25 },
        targeting: { mode: "area", shape: "radius", size: 20, excludeCaster: true }, range: 20,
        defence: { type: "none" },
        element: "air", duration: { kind: "active", upkeep: 6 }
    },
    on: { success: [
        { b: "core:repeatEachRound", body: [
            { b: "core:ifPercentile", a: { chance: 35 }, body: [
                { b: "core:contest", a: { against: "dodge", use: "newRoll" }, body: [
                    { b: "core:dealDamage", a: { formula: "8d6", damageType: "lightning", location: "torso" } },
                    { b: "core:ifPercentile", a: { chance: 75 }, body: [
                        { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
                    ]}
                ]}
            ]}
        ]}
    ]}
};

export const AIR = [
    ADENYDD, AIR_POCKET, BRONWYNS_GUST, FRESHEN_AIR, URIENS_SHELTER,
    STATIC_STORM, TELEKINESIS, ZEPHYR,
    SUFFOCATE, ALZURS_THUNDER, GWYNT_TROELLI, DERVISH, LIGHTNING_STORM
];
