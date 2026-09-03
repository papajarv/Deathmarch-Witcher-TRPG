/**
 * Core rulebook — Novice and Journeyman/Master MIXED ELEMENT spells.
 *
 * Authored verbatim against the post-errata printing. Where the printed text
 * and the errata disagree the errata wins and the divergence is noted, because
 * a future reader holding the book will otherwise "fix" it back.
 *
 * The uncomfortable finding of this batch: a real fraction of the core list
 * has no combat mechanics whatsoever. Those entries use `core:narrate` and
 * `core:revealInfo`, which is not the same as leaving them empty — an empty
 * tree is a spell nobody finished, and these are finished.
 */

/* ── AFAN'S MIRROR ────────────────────────────────────────────────────────
 * 1d10 intangible copies, maintained at 2 STA a round. The upkeep is frame
 * law, not a block: a maintained spell also LOCKS THE CASTER out of casting
 * anything else, and no author should be able to forget that half.
 *
 * The `1d10` here is a COUNT and not a duration — the copies last exactly as
 * long as the caster pays for them, which is `upkeepUnpaid` and not a number.
 * Worth saying because the two read alike in a tree and only one of them is
 * rolled by the clock layer. */
export const AFANS_MIRROR = {
    name: "Afan's Mirror", tier: "novice", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "self" }, range: 10,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "active", upkeep: 2 }
    },
    on: { success: [
        { b: "core:summonCopies", a: { count: "1d10", what: "illusoryCopy",
              tangible: "no", controlled: "caster", until: "upkeepUnpaid" } },
        { b: "core:narrate", a: { what: "The copies cannot leave the spell's range.", scale: "trivial" } }
    ]}
};

/* ── BLINDING DUST ────────────────────────────────────────────────────────
 * The simplest possible authored spell, and useful as the control case. */
export const BLINDING_DUST = {
    name: "Blinding Dust", tier: "novice", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "direct", count: 1 }, range: 4,
        defence: { type: "blockOrDodge", ties: "defender" },
        element: "mixed", duration: { kind: "rounds", value: "1d10" }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "blinded", until: "rounds", value: "1d10" } }
    ]}
};

/* ── DISPEL ───────────────────────────────────────────────────────────────
 * Two lives, one entry. Cast on your turn it ends something standing; offered
 * as a reaction it is a CONTRIBUTED DEFENCE, registered in contributors.mjs
 * and available against magic whose own defence is `None`.
 *
 * Both halves price themselves off the ORIGINAL caster's spend and must beat
 * the ORIGINAL caster's roll — which is the whole reason the cast record is
 * public and persists for as long as the effect it created.
 *
 * THE DERIVED PRICE IS REACHABLE ONLY WHEN NOBODY IS ASKED. `price()` takes an
 * early exit the moment the declaration carries a finite `staSpend`, and the
 * system's cast dialog always carries one — it offers a plain number box that
 * defaults to 0. So in play the branch below runs for the test harness and for
 * an adapter with no dialog, and a player casting Dispel from their sheet pays
 * whatever they typed, clamped to the frame's band and never compared against
 * "half as many Stamina points as the caster spent to cast the magic".
 *
 * Left declared rather than deleted, because it is the truest statement of the
 * rule available here and the fix belongs one layer down: the dialog would
 * have to be told the derived number, or `price` would have to prefer a
 * derived cost over a typed one. The half-cost is also printed on the card by
 * the narration below, so the table can hold the player to it in the meantime.
 * What the engine DOES enforce unaided is the harder half — the roll must beat
 * the original, with a tie leaving the effect standing. */
export const DISPEL = {
    name: "Dispel", tier: "novice", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "derived", resolve: ctx => ctx.dispelTarget
            ? Math.ceil((ctx.dispelTarget.record?.staSpent ?? 0) / 2) : 1 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        /* Its own defence is Spell Casting, which is what lets a dispel be
         * dispelled — the recursion the interception bus is depth-capped for. */
        defence: { type: "spellCasting", ties: "defender" },
        element: "mixed", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:endMagic", a: { scope: "one" } },
        { b: "core:narrate", a: { what: "Cancelling a magical effect costs half as many Stamina points as its caster spent on it.", scale: "trivial" } }
    ], success: [
        { b: "core:endMagic", a: { scope: "one" } },
        { b: "core:narrate", a: { what: "Cancelling a magical effect costs half as many Stamina points as its caster spent on it.", scale: "trivial" } }
    ]}
};

/* ── GLAMOUR ──────────────────────────────────────────────────────────────
 * Three flat bonuses on one caster. Nothing exotic — it is here because it is
 * the shape most non-combat buffs take, and proves `grantModifier` does not
 * need a bespoke block per skill.
 *
 * ONE SPELL, THREE ROLLS OF THE SAME DIE. Dice durations expire now, which is
 * the fix that made this visible: `rollDuration` runs inside each block, so the
 * three `1d6` hours below are rolled independently and the Seduction bonus can
 * outlive the Charisma one by five hours. The book gives the SPELL a duration,
 * not each bonus.
 *
 * Nothing in the library can roll a duration once and share it — a rolled value
 * has nowhere to live between blocks, since `ctx.vars` is published by the
 * frame's stages and no block writes to it. The alternative available today is
 * a flat number, which would be inventing one the book does not print. So three
 * rolls it is, and the divergence is stated here rather than discovered at a
 * table when two of the three quietly lapse mid-conversation. */
export const GLAMOUR = {
    name: "Glamour", tier: "novice", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "hours", value: "1d6" }
    },
    on: { success: [
        { b: "core:grantModifier", a: { stat: "seduction",  delta: "3", until: "hours", value: "1d6" } },
        { b: "core:grantModifier", a: { stat: "charisma",   delta: "3", until: "hours", value: "1d6" } },
        { b: "core:grantModifier", a: { stat: "leadership", delta: "3", until: "hours", value: "1d6" } }
    ]}
};

/* ── MAGIC COMPASS ────────────────────────────────────────────────────────
 * Pure information. No roll to beat, no target, nothing to compute. */
export const MAGIC_COMPASS = {
    name: "Magic Compass", tier: "novice", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "hours", value: "1d6" }
    },
    on: { success: [
        { b: "core:revealInfo", a: { about: "direction", to: "caster",
              detail: "The way to a place you have been before, or else north." } }
    ]}
};

/* ── MIND MANIPULATION ────────────────────────────────────────────────────
 * A cast-time choice among four options that all cost the same. Cursed Illness
 * makes its choice by PRICE, so the band carries it; here the price is flat and
 * the choice needed somewhere else to live. Both bind into the same text scope,
 * which is the argument for having one rather than two.
 *
 * "for the duration of the spell" is the frame's `1d10` rounds, and the status
 * carries the same expression so the emotion ends with the spell. It is ROLLED
 * ONCE, when the effect starts, which is also what the table expects — a dice
 * duration used to arrive at the clock as the string "1d10", tick into NaN and
 * never end, so a forced love lasted the rest of the campaign. */
export const MIND_MANIPULATION = {
    name: "Mind Manipulation", tier: "novice", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 3 },
        targeting: { mode: "direct", count: 1 }, range: 5,
        defence: { type: "resistMagic", ties: "defender" },
        element: "mixed", duration: { kind: "rounds", value: "1d10" }
    },
    on: { hit: [
        { b: "core:chooseOption", a: { choices: ["hatred", "love", "depression", "euphoria"], bind: "choice" },
          body: [
            { b: "core:applyStatus", a: { status: "{choice}", until: "rounds", value: "1d10" } }
        ]}
    ]}
};

/* ── SUMMON STAFF ─────────────────────────────────────────────────────────
 * Moves a stick. Authored anyway, so that "does nothing mechanical" is a
 * statement the runtime makes rather than an absence someone has to infer. */
export const SUMMON_STAFF = {
    name: "Summon Staff", tier: "novice", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "instant" }
    },
    on: { success: [
        { b: "core:narrate", a: { what: "Your staff dematerialises to a place you have been within the last day, or returns to your hand.", scale: "trivial" } }
    ]}
};

/* ── TELEPATHY ────────────────────────────────────────────────────────────
 * Maintained at 1 STA. The sidebar's Telepathic Spying variant is a separate
 * concern — it gives the TARGET a per-round Magic Training roll against the
 * caster's original Telepathy roll, which is `saveEnds` with the roles
 * reversed, and is authored as such.
 *
 * The link is marked on the SUBJECT and ends when the upkeep lapses, which is
 * the book's own duration and not a dice roll. One caveat, and it belongs to
 * the engine rather than to this entry: the upkeep sweep ends lifetimes whose
 * OWNER is the caster (`endWhere(e => e.owner === actor …)`), and this one is
 * owned by the person on the other end of the link — so the marker outlives the
 * spell until a GM lifts it. Matching on the cast's `castId` instead would
 * close it for every maintained spell that touches somebody else. */
export const TELEPATHY = {
    name: "Telepathy", tier: "novice", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 2 },
        targeting: { mode: "direct", count: 1 }, range: 10,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "active", upkeep: 1 }
    },
    on: { success: [
        { b: "core:applyStatus", a: { status: "telepathicLink", until: "upkeepUnpaid" } },
        { b: "core:narrate", a: { what: "Telepathy crosses language barriers. Used to spy, a witcher's medallion vibrates and a mage with Magic Training may roll each round to notice.", scale: "notable" } }
    ]}
};

/* ── EILHART'S TECHNIQUE ──────────────────────────────────────────────────
 * The DEFENDER's fumble matters here, which nothing else in the book cares
 * about: "If the target fumbles their defense, their INT is reduced by 1
 * permanently." The pipeline was already collecting that botch and throwing
 * it away. */
export const EILHARTS_TECHNIQUE = {
    name: "Eilhart's Technique", tier: "journeyman", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 12 },
        targeting: { mode: "direct", count: 1 }, range: 3,
        defence: { type: "resistMagic", ties: "defender" },
        element: "mixed", duration: { kind: "instant" }
    },
    on: { hit: [
        { b: "core:revealInfo", a: { about: "secret", to: "caster",
              detail: "One piece of information torn from the target's mind." } },
        { b: "core:ifTargetFumbled", body: [
            { b: "core:grantModifier", a: { stat: "int", delta: "-1", until: "permanent" } }
        ]}
    ]}
};

/* ── ILLUSION ─────────────────────────────────────────────────────────────
 * "Anyone who fails the Resist Magic check sees the illusion and believes it."
 *
 * That is the spell's ONLY rule, and it is per person. The frame gives the
 * halves for free — `hit` is tracked per target, so this tree runs for the
 * people who failed and not for the ones who made it — but the tree recorded
 * nothing about them: `core:summonCopies` runs ONCE for the whole cast, so an
 * area spell whose entire mechanic is "who believes it" left no way to tell a
 * believer from someone standing next to them.
 *
 * So the failures are MARKED. `hallucinating` is the system's own condition for
 * exactly this — "GM-controlled false sensory images", with a DC 15 Deduction
 * check to recognise each illusion for what it is — and it carries no stat
 * penalty the book does not give. The image itself is still one summon: there
 * is one illusion, however many people are taken in by it.
 *
 * The marker ends with the upkeep, which is the spell's duration. It is owned
 * by the viewer rather than the caster, so the same sweep caveat as Telepathy
 * applies; here the status has an end check of its own, so a believer is not
 * stranded with it. */
export const ILLUSION = {
    name: "Illusion", tier: "journeyman", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 8 },
        targeting: { mode: "area", shape: "radius", size: 20 }, range: 20,
        defence: { type: "resistMagic", ties: "defender" },
        element: "mixed", duration: { kind: "active", upkeep: 4 }
    },
    on: { hit: [
        { b: "core:applyStatus", a: { status: "hallucinating", until: "upkeepUnpaid" } },
        { b: "core:summonCopies", a: { count: "1", what: "illusion", tangible: "no", until: "upkeepUnpaid" } },
        { b: "core:narrate", a: { what: "The illusion cannot be touched, smelled, or heard.", scale: "notable" } }
    ]}
};

/* ── TELEPORTATION ────────────────────────────────────────────────────────
 * A STATIC DC with a real failure outcome — "Teleporting requires a DC:15
 * Spell Casting roll. If you fail the roll, you wind up in a random location
 * 1d6 miles away."
 *
 * Nothing defends against this and the failure is not a miss with nothing
 * behind it, so it is neither an opposed roll nor an unopposed one. That third
 * case had no expression at all until this entry demanded it, and every DC
 * spell in the book was silently an auto-success. */
export const TELEPORTATION = {
    name: "Teleportation", tier: "journeyman", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 10 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "dc", dc: 15 },
        element: "mixed", duration: { kind: "instant" }
    },
    on: {
        success: [
            { b: "core:narrate", a: { what: "You arrive at the known location, carrying only what is on your person or in your hands.", scale: "major" } }
        ],
        miss: [
            { b: "core:narrate", a: { what: "You wind up in a random location 1d6 miles away.", scale: "major" } }
        ]
    }
};

/* ── STANDING PORTAL ──────────────────────────────────────────────────────
 * The only spell whose ENDING is an attack: "if you end the portal while
 * something is partially through, the portal slices the object (or creature)
 * in two. The person is counted as being dismembered, as per the Critical
 * Wound."
 *
 * Active Shield's parting blast needed the same entry point, and between them
 * they are why `onExpire` exists — by the time either fires, the cast that
 * created it is long finished and has no targets left to inherit.
 *
 * AND IT IS NARRATED, because the engine cannot ask the question the rule turns
 * on. Two things have to be true before anyone is cut in half: something must
 * be IN THE PORTAL, and it must be only partly through. Nothing in the library
 * can ask either. `core:targetNearest` searches outward from the CASTER — the
 * portal stands up to 10m away and the caster is usually not in it — and it has
 * no "is this one halfway through" predicate to filter on, so the tree this
 * replaces dismembered, permanently and unconditionally, whoever happened to be
 * standing within a metre of the mage when the portal closed. Now that expiry
 * trees actually run, that would have gone off at a real table.
 *
 * A critical wound applied to the wrong person by a spell that never touched
 * them is far worse than one the GM applies from a card, so this says what
 * happens and lets them apply it. What is missing, precisely: a way to name the
 * OBJECT a cast created as the origin of a search, and a way to ask who is
 * overlapping it. */
export const STANDING_PORTAL = {
    name: "Standing Portal", tier: "journeyman", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 22 },
        targeting: { mode: "point" }, range: 10,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "active", upkeep: 6 }
    },
    on: {
        success: [
            /* NO HIT POINTS, because the book gives it none. "Standing Portal
             * creates a 1m by 2m floating portal" and says nothing about
             * breaking one — it ends when the caster stops paying for it. The
             * `hp: "1"` this carried was invented, and a one-hit-point portal
             * is a 22-STA spell any thrown rock can close. `null` leaves the
             * card with a size and no destructible total; the conjured token
             * still exists, because the GM-side handler floors it at 1. */
            { b: "core:createObject", a: { what: "portal", hp: null, size: "1x2",
                  until: "upkeepUnpaid", blocksMovement: false } },
            { b: "core:narrate", a: { what: "It transports anything that fits through it, anywhere you can recall. A portal to a location you do not know behaves as Teleportation.", scale: "major" } }
        ],
        onExpire: [
            { b: "core:narrate", a: { what: "If anything was partially through the portal as it closed, it is sliced in two: a creature counts as dismembered, as per the Critical Wound.", scale: "major" } }
        ]
    }
};

/* ── POLYMORPHISM ─────────────────────────────────────────────────────────
 * `Until Re-Cast` is a duration that ends by the caster doing the same thing
 * again, and the same condition Quen's recast lock uses from the other side —
 * there it FORBIDS a second cast, here it requires one.
 *
 * "You must cast the spell again to change back to your human form." That now
 * happens: the cast entry point ends anything this ITEM left on this caster
 * carrying `untilRecast` before the new cast resolves, matched on the item's
 * own uuid. The condition was in the dropdown with no producer anywhere, so a
 * second Polymorphism used to stack a second shape on top of the first and the
 * witcher never came back.
 *
 * "While in this form, you have the physical statistics of that animal (See
 * Bestiary, pg.310)." NARRATED, and it has to be. `core:grantModifier` can
 * `set` a stat, but the values are not in the spell — they are four bestiary
 * entries away, they differ per animal and per creature the GM picks, and the
 * book does not even say which stats count as "physical". Writing four sets of
 * numbers here would be inventing a table the spell does not have; the shape
 * the caster chose rides into the sentence as `{shape}` so the GM knows which
 * page to open. `core:ifChoice` is deliberately not used: the four answers
 * differ in narration only, and a branch per shape would imply mechanics the
 * book never printed. */
export const POLYMORPHISM = {
    name: "Polymorphism", tier: "journeyman", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 22 },
        targeting: { mode: "self" }, range: null,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "untilRecast" }
    },
    on: { success: [
        { b: "core:chooseOption", a: { choices: ["serpent", "cat", "bird", "dog"], bind: "shape" }, body: [
            { b: "core:applyStatus", a: { status: "polymorphed", until: "untilRecast" } },
            { b: "core:narrate", a: { what: "You take the shape of {shape}, with that animal's physical statistics. Items on your person transform with you; cast again to return.", scale: "major" } }
        ]}
    ]}
};

/* ── TRANSMUTATION ────────────────────────────────────────────────────────
 * `Duration: Permanent`, with a hard exclusion that is not a balance knob but
 * the setting's central rule about magic: dimeritium, and anything touching
 * it, is untouchable. */
export const TRANSMUTATION = {
    name: "Transmutation", tier: "journeyman", element: "mixed",
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 25 },
        targeting: { mode: "point" }, range: 2,
        defence: { type: "none" },
        element: "mixed", duration: { kind: "permanent" }
    },
    on: { success: [
        { b: "core:narrate", a: { what: "One unit of metal becomes any other metal, or an imperfect gem becomes one suitable for magic. Dimeritium, and anything in contact with it, can be neither created nor changed.", scale: "major" } }
    ]}
};

export const NOVICE_MIXED = [
    AFANS_MIRROR, BLINDING_DUST, DISPEL, GLAMOUR, MAGIC_COMPASS,
    MIND_MANIPULATION, SUMMON_STAFF, TELEPATHY,
    EILHARTS_TECHNIQUE, ILLUSION, TELEPORTATION,
    STANDING_PORTAL, POLYMORPHISM, TRANSMUTATION
];
