/**
 * Core rulebook — FIRE spells, all three tiers.
 *
 * Fire is where the book's ignition percentages live, and they are rolled
 * SEPARATELY from the attack every time: Aenye 75%, Wave of Fire 50%, Tanio
 * Ilchar 100%, Cadfan's Grasp 50%, Alzur's Thunder 75%. Folding ignition into
 * the hit check would be simpler and wrong — Lightning Storm and Melgar's Fire
 * each roll two percentiles in one resolution, so they cannot collapse.
 */

/* ── AENYE ────────────────────────────────────────────────────────────────*/
export const AENYE = {
    name: "Aenye", tier: "novice", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "direct", count: 1 }, range: 12,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "fire", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:dealDamage", a: { formula: "4d6", damageType: "fire" } },
        { b: "core:ifPercentile", a: { chance: 75 }, body: [
            { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
        ]}
    ]}
};

/* ── AINE VERSEOS ─────────────────────────────────────────────────────────
 * "Creates an area of bright light in a 4m radius centred on you" — and
 * NOTHING IN THE LIBRARY EMITS LIGHT. `createZone` places a region through the
 * aiming overlay, `brightlyLit` is a status with an icon; neither touches a
 * token's light source or drops an AmbientLight, so the map stays exactly as
 * dark as it was.
 *
 * Left standing rather than faked, because what the zone and the status DO say
 * is true and useful: who is inside the lit area, that it follows the caster,
 * and that it lifts the moment you step out of it. What is missing is a block
 * that writes illumination — a bright radius on the caster's token, removed
 * with the zone — which is an adapter capability, not an authoring one. Until
 * one exists the GM turns the lamp on by hand. */
export const AINE_VERSEOS = {
    name: "Aine Verseos", tier: "novice", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 1 },
        targeting: { mode: "area", anchor: "caster", shape: "radius", size: 4 }, range: 4,
        defence: { type: "none" },
        element: "fire", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:createZone", a: { anchor: "caster", until: "upkeepUnpaid" },
          body: [
            { b: "core:applyStatus", a: { status: "brightlyLit", until: "untilExitZone" } }
        ]},
        /* SAID OUT LOUD, because the marker is all there is.
         *
         * Anyone inside is flagged as lit, and the scene's actual illumination
         * is untouched — nothing in the engine emits light. Without this line a
         * player reads "a 4m radius holds", sees the icon, and reasonably
         * assumes the darkness has lifted. A spell whose entire product is
         * light has to admit when it has not produced any. */
        { b: "core:narrate", a: { what: "Everyone within 4m is lit as though by torchlight. The scene's own lighting is unchanged — if the dark matters here, set it on the scene.", scale: "notable" } }
    ]}
};

/* ── BRAND OF FIRE ────────────────────────────────────────────────────────
 * A permanent mark rather than a wound. The sidebar gives it its own removal
 * rule — "only a surgeon can obliterate words burned into skin... a doctor can
 * remove a scar by rolling a DC:15 Healing Hands check" — so the scar is a
 * lasting effect with its own end condition, not narration. */
export const BRAND_OF_FIRE = {
    name: "Brand of Fire", tier: "novice", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 4 },
        targeting: { mode: "direct", count: 1 }, range: 8,
        defence: { type: "none" },
        element: "fire", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:dealDamage",  a: { formula: "1d6", damageType: "fire" } },
        { b: "core:applyStatus", a: { status: "branded", until: "permanent" } },
        { b: "core:narrate", a: { what: "A large permanent scar. A doctor may remove the scar with a DC:15 Healing Hands check; after treatment the brand no longer spells anything out.", scale: "notable" } }
    ]}
};

/* ── CADFAN'S GRASP ───────────────────────────────────────────────────────
 * "Super-heat a metal item, making the holder drop the item or take 2d6
 * damage to the limb holding it. Alternatively, the spell can heat weapons to
 * give +2d6 damage and a 50% chance to ignite a target."
 *
 * Two modes, and each has real mechanics — which the tree used to lack
 * entirely: it asked both questions, narrated the answers, and applied
 * nothing. The branch is `core:ifChoice`, one gate per answer, because a
 * choice with two outcomes needs two bodies and `chooseOption` holds one.
 *
 * The alternative mode is the interesting one — a spell that modifies a
 * WEAPON rather than a creature, which is why `grantModifier` takes a
 * `scope`. */
export const CADFANS_GRASP = {
    name: "Cadfan's Grasp", tier: "novice", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 4 },
        /* "a metal item" — the book gives no range for the heating itself and
         * the item must be one you can pick out; touch is the classification
         * the system's own table gives it. */
        targeting: { mode: "direct", count: 1 }, range: 2,
        defence: { type: "none" },
        element: "fire", duration: { kind: "rounds", value: "1d6" }
    },
    on: { success: [
        { b: "core:chooseOption", a: { choices: ["searTheHolder", "heatTheWeapon"], bind: "mode" }, body: [

            /* MODE 1 — the holder chooses, and the choice costs them. */
            { b: "core:ifChoice", a: { bind: "mode", is: "searTheHolder" }, body: [
                { b: "core:chooseOption", a: { choices: ["dropIt", "holdOn"], bind: "response",
                                               who: "target" }, body: [
                    { b: "core:ifChoice", a: { bind: "response", is: "holdOn" }, body: [
                        /* "take 2d6 damage to the limb holding it" — a called
                         * shot the spell makes for you, at the hand. */
                        { b: "core:dealDamage", a: { formula: "2d6", damageType: "fire",
                                                     location: "rightArm" } }
                    ]},
                    { b: "core:ifChoice", a: { bind: "response", is: "dropIt" }, body: [
                        { b: "core:narrate", a: { what: "The metal sears their palm and they let it fall.",
                                                  scale: "trivial" } }
                    ]}
                ]}
            ]},

            /* MODE 2 — the weapon itself is the target of the buff. */
            { b: "core:ifChoice", a: { bind: "mode", is: "heatTheWeapon" }, body: [
                { b: "core:grantModifier", a: { stat: "damageBonus", delta: "2d6", op: "add",
                                                scope: "weapon", until: "rounds", value: "1d6" } },
                { b: "core:ifPercentile", a: { chance: "50" }, body: [
                    { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
                ]}
            ]}
        ]}
    ]}
};

/* ── MAGIC FLARE ──────────────────────────────────────────────────────────*/
export const MAGIC_FLARE = {
    name: "Magic Flare", tier: "novice", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "area", shape: "radius", size: 8 }, range: 8,
        defence: { type: "resistMagic", ties: "defender" },
        element: "fire", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "blinded", until: "rounds", value: "1d6" } },
        { b: "core:narrate", a: { what: "The flare can be seen for ten kilometres.", scale: "notable" } }
    ]}
};

/* ── RAISE FLAME ──────────────────────────────────────────────────────────
 * Three modes, all the same price, all operating on a fire that already
 * exists. Two of them adjust that fire's damage by 1 in opposite directions,
 * and all three stay NARRATED — which is a decision, not an unfinished entry.
 *
 * "Lowering the fire damage by 1" is the clause that looks mechanical. It is
 * not reachable from here. The number it moves is `burning`'s five-a-location
 * DoT in `setup/statusClauses.mjs`, a system-wide table, and
 * `core:grantModifier` writes an ActiveEffect onto an ACTOR field — `statPath`
 * resolves stats, skills, pools and derived stats, and has no path to a status
 * clause's damage. Worse, this spell targets a POINT, and `acquireTargets`
 * hands a point-targeted cast an EMPTY target list, so every effect block here
 * would loop over nobody: a `grantModifier` on this entry would change
 * nothing, warn about nothing, and still read as implemented.
 *
 * What is missing is a modifier scoped to a STATUS rather than to an actor.
 * Until that exists the GM moves the burn by one, which is what they were
 * doing before this engine existed. */
export const RAISE_FLAME = {
    name: "Raise Flame", tier: "novice", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "point" }, range: 10,
        defence: { type: "none" },
        element: "fire", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:chooseOption", a: { choices: ["spread", "dull", "intensify"], bind: "mode" }, body: [
            { b: "core:narrate", a: { what: "You {mode} an existing fire — spreading it 2m per round, dulling its damage by 1, or raising it by 1.", scale: "notable" } }
        ]}
    ]}
};

/* ── TANIO ILCHAR ─────────────────────────────────────────────────────────
 * The only 100% ignition in the book, and it is UNOPPOSED: "Tanio Ilchar
 * creates a burst of fire in a 2m by 2m area. This has a 100% chance of
 * lighting a target in the area on fire." There is no defence anywhere in the
 * entry — the Dodge on the frame was invented here, and it turned the one
 * certainty in the book into a coin flip, because a target who beat the cast
 * never reached the percentile at all.
 *
 * The percentile itself stays rather than collapsing into an unconditional
 * status: it is what the entry says, and it is the hook a modifier bites on —
 * Empower forces 100%, and anything that lowers ignition chances has a number
 * to lower. */
export const TANIO_ILCHAR = {
    name: "Tanio Ilchar", tier: "novice", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "area", shape: "cube", size: 2 }, range: 8,
        defence: { type: "none" },
        element: "fire", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:ifPercentile", a: { chance: 100 }, body: [
            { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
        ]}
    ]}
};

/* ── WAVE OF FIRE ─────────────────────────────────────────────────────────
 * ONE check, and it is the frame's: "2d6 damage to anyone who isn't able to
 * dodge or block, and a 50% chance of igniting a target." The ignition is a
 * separate percentile rather than a second defence, which is why this entry
 * never grew the inner contest Flaming Vortex and Melgar's Fire had to shed —
 * a cone of fire is defended against once, as it arrives. */
export const WAVE_OF_FIRE = {
    name: "Wave of Fire", tier: "novice", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 4 },
        targeting: { mode: "area", shape: "cone", size: 3 }, range: 3,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "fire", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:dealDamage", a: { formula: "2d6", damageType: "fire" } },
        { b: "core:ifPercentile", a: { chance: 50 }, body: [
            { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
        ]}
    ]}
};

/* ── DEMETIA'S CREST SURGE ────────────────────────────────────────────────
 * A charge-counted ward filtered by the ATTACKER'S ELEMENT: "blocks a number
 * of water spells equal to 2 times your Spell Casting skill value."
 *
 * The element is in the public cast record precisely so a defender can read
 * it. Nothing else about the incoming spell matters — not its defence set, not
 * its damage channel — which is a different filter from every other ward in
 * the book and the reason `ifIncomingElement` is its own block. */
export const DEMETIAS_CREST_SURGE = {
    name: "Demetia's Crest Surge", tier: "journeyman", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 12 },
        targeting: { mode: "self" }, range: 10,
        defence: { type: "none" },
        element: "fire", duration: { kind: "active", upkeep: 4 }
    },
    on: {
        success: [
            { b: "core:createShield", a: { pool: "0", absorbs: "none", charges: "2*{rank}" } },
            { b: "core:narrate", a: { what: "It turns aside {charges} water spells — that part is automatic. Projectiles entering the shield are destroyed and living creatures cannot enter it: nothing stops them for you, so call those at the table.", values: { charges: "2*{rank}" }, scale: "notable" } }
        ],
        incomingMagic: [
            { b: "core:ifIncomingElement", a: { elements: ["water"] }, body: [
                { b: "core:consumeCharge", a: { n: "1" }, body: [
                    { b: "core:negateMagic" }
                ]}
            ]}
        ]
    }
};

/* ── FLAMING VORTEX ───────────────────────────────────────────────────────
 * The clearest case for a second contest — and, once that contest exists, the
 * frame must not roll one as well.
 *
 * "Flaming Vortex creates a flaming tornado 2m wide... If it runs over or into
 * a target, make a Spell Casting roll versus their Dodge/Escape roll." Nobody
 * defends against the tornado being CREATED. The only check in the entry is
 * the one the tornado makes when it reaches somebody, and it is a NEW roll,
 * every round, for as long as the caster pays. The frame's `dodge` charged
 * round one a second Dodge that the book never grants and that decided nothing
 * the inner one did not.
 *
 * `use: "newRoll"` is the half that does NOT transfer to Melgar's Fire below —
 * see the note there. The old engine had a single `opposed` flag for the whole
 * spell, so this was authored as "hits automatically, ask the GM". */
export const FLAMING_VORTEX = {
    name: "Flaming Vortex", tier: "journeyman", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 15 },
        targeting: { mode: "area", shape: "radius", size: 2 }, range: 10,
        defence: { type: "none" },
        element: "fire", duration: { kind: "active", upkeep: 4 }
    },
    on: { success: [
        /* The clock carries the people the cast's own area caught, because
         * `repeatEachRound` hands its body the frame's target list and nothing
         * in the library re-acquires whoever the tornado is standing on THIS
         * round. The caster steers it, so the table knows who that is; the
         * narration below is what tells them how far it may go. */
        { b: "core:repeatEachRound", body: [
            { b: "core:contest", a: { against: "dodge", use: "newRoll" }, body: [
                { b: "core:dealDamage", a: { formula: "5d6", damageType: "fire" } },
                { b: "core:ifPercentile", a: { chance: 50 }, body: [
                    { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
                ]}
            ]}
        ]},
        { b: "core:narrate", a: { what: "You may direct the tornado up to {reach}m per turn. It will not travel beyond the spell's range.", values: { reach: "1*{rank}" }, scale: "notable" } }
    ]}
};

/* ── SEIRFF HAUL ──────────────────────────────────────────────────────────
 * An ESCALATING escape DC: "every round that the target fails the Dodge/Escape
 * check, the DC rises by 1 point as the serpents tighten." Grapple and fire at
 * once, both ending on the same check.
 *
 * `escalate` is POSITIVE because the word now means what the sentence means:
 * the adapter adds the step to the DC each failed round. It used to add it to
 * the DEFENDER instead, so the serpents loosened their grip by one every round
 * the victim struggled — the exact inverse of the only rule this spell has.
 *
 * The frame's Dodge SURVIVES here, where Flaming Vortex's and Melgar's Fire's
 * did not, and that is a judgement rather than a quotation: the serpents
 * "swarm over a target", which has to land on somebody before there is
 * anything to escape from, and the Dodge/Escape the entry names is the one you
 * make afterwards, on your own turn. Two checks of a grapple, not the same
 * check charged twice. A table that reads the entry as granting only the
 * escape should delete this line, not the `saveEnds` below. */
export const SEIRFF_HAUL = {
    name: "Seirff Haul", tier: "journeyman", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 10 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "dodge", ties: "defender" },
        element: "fire", duration: { kind: "rounds", value: "2d10" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "grappled", until: "saveEnds" } },
        { b: "core:applyStatus", a: { status: "onFire",   until: "saveEnds" } },
        { b: "core:saveEnds",    a: { skill: "dodge", dcSource: "castRoll",
                                      cadence: "round", escalate: "1" } }
    ]}
};

/* ── MELGAR'S FIRE ────────────────────────────────────────────────────────
 * The other contest phrasing, and it is NOT the same as Flaming Vortex's.
 * Victims "must defend at a DC equal to your Spell Casting check" — the roll
 * already made, standing as a fixed DC for the life of the spell, rather than
 * a fresh roll each round. Both sentences appear in this book and treating
 * them alike would either freeze a rolling contest or re-roll a fixed one.
 *
 * That standing DC is also the ONLY defence the entry gives, which is why the
 * frame declares none: "anyone in the area has a 75% chance of being struck by
 * a ball of fire. If they miss this roll, they must defend at a DC equal to
 * your Spell Casting check." A frame-level Block/Dodge on top of it made every
 * victim defend twice against the same number — once when the sky opened and
 * again when the first ball landed. */
export const MELGARS_FIRE = {
    name: "Melgar's Fire", tier: "master", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 25 },
        targeting: { mode: "area", shape: "radius", size: 40, excludeCaster: true }, range: 40,
        defence: { type: "none" },
        element: "fire", duration: { kind: "rounds", value: "2d6" }
    },
    on: { success: [
        { b: "core:repeatEachRound", body: [
            { b: "core:ifPercentile", a: { chance: 75 }, body: [
                { b: "core:contest", a: { against: "blockOrDodge", use: "castRoll" }, body: [
                    { b: "core:dealDamage", a: { formula: "4d6", damageType: "fire", location: "random" } },
                    { b: "core:ifPercentile", a: { chance: 75 }, body: [
                        { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
                    ]}
                ]}
            ]}
        ]}
    ]}
};

/* ── MIRROR EFFECT ────────────────────────────────────────────────────────
 * Environmental gating with THREE states, and the middle one scales rather
 * than vetoes: "this spell uses the rays of the sun and cannot be used where
 * the sun's rays can't penetrate. By the light of the moon or on overcast
 * days, it does half damage."
 *
 * It also cannot be displaced by wind, and can only be parried by a reflective
 * surface — which is a contributed defence keyed on the defender's gear rather
 * than on the spell's own defence line. */
export const MIRROR_EFFECT = {
    name: "Mirror Effect", tier: "master", element: "fire",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 25 },
        targeting: { mode: "direct", count: 1 }, range: 20,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "fire", duration: { kind: "rounds", value: "2d6" }
    },
    on: { hit: [
        /* THE VETO, and it goes first: "this spell uses the rays of the sun and
         * cannot be used where the sun's rays can't penetrate."
         *
         * Without it, a cellar simply failed both branches below — 25 Stamina
         * spent, a card posted, and a beam that never existed, which is the
         * most expensive way in the book to do nothing. Nothing a tree runs can
         * un-spend that: every frame stage checks `control.aborted` BEFORE a
         * tree is looked up, so no block can refuse a cast that has already
         * been paid for. Saying the refusal out loud is the honest floor, and
         * it is what lets a GM hand the Stamina back. */
        { b: "core:ifEnvironment", a: { condition: "anyLight", negate: true }, body: [
            { b: "core:narrate", a: { what: "There is no sunlight here to bend, so there is nothing to reflect: the spell cannot be used where the sun's rays can't penetrate.", scale: "major" } }
        ]},
        /* Everything else lives INSIDE "there is light", including the flavour:
         * a beam that was refused has nothing to block, nothing to parry and
         * nowhere to bounce, and a card that describes one anyway is the same
         * lie the missing veto was. */
        { b: "core:ifEnvironment", a: { condition: "anyLight" }, body: [
            { b: "core:ifEnvironment", a: { condition: "directSunlight" }, body: [
                { b: "core:dealDamage", a: { formula: "10d6", damageType: "fire" } }
            ]},
            /* "By the light of the moon or on overcast days, it does half
             * damage" — lit, but not by the sun itself. */
            { b: "core:ifEnvironment", a: { condition: "directSunlight", negate: true }, body: [
                { b: "core:dealDamage", a: { formula: "5d6", damageType: "fire" } }
            ]},
            { b: "core:narrate", a: { what: "Whatever blocks the beam is destroyed; it cannot be displaced by wind, and only a reflective surface can parry it, taking the damage itself and sending the beam off in a random direction. None of that is resolved for you — call it at the table.", scale: "major" } }
        ]}
    ]}
};

export const FIRE = [
    AENYE, AINE_VERSEOS, BRAND_OF_FIRE, CADFANS_GRASP, MAGIC_FLARE,
    RAISE_FLAME, TANIO_ILCHAR, WAVE_OF_FIRE,
    DEMETIAS_CREST_SURGE, FLAMING_VORTEX, SEIRFF_HAUL, MELGARS_FIRE, MIRROR_EFFECT
];
