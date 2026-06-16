/**
 * statusClauses — the editable, declarative source of truth for what each
 * Witcher TRPG status effect DOES (Core p.161-165). One object per status id;
 * `mechanics/statusEngine.mjs` interprets these clauses and the rest of the
 * system reads conditions THROUGH the engine, never by hard-coding a status
 * id. Retune a condition by editing the numbers here — no other file changes.
 *
 * Strict RAW, flat values: a status does exactly what the rulebook's combat
 * Effect Table says, with no homebrew tier ladder. (The old Bleed I-V /
 * Burning I-VI tier sets are retired — RAW bleed is always 2/round, burning
 * always 5, etc.)
 *
 * Clause vocabulary — every field is optional:
 *
 *   description            player-facing RAW summary (sheet panel + AE tooltip)
 *
 *   mods.stats  {key:n}    flat stat change, emitted as an UNBOUNDED
 *                          `system.stats.<key>.modifier` ActiveEffect change so
 *                          it crosses the 1-10 source clamp (prepareDerivedData
 *                          folds modifier into the prepared value).
 *
 *   mods.skills {statKey:{skillKey:n}}
 *                          flat per-skill modifier, emitted as a
 *                          `system.skills.<stat>.<skill>.modifier` AE change.
 *                          Use this when you want to debuff ONE skill under a
 *                          stat without touching the stat itself (e.g. drunk
 *                          IV-VI debuff Resist Coercion / Magic alone).
 *
 *   mods.derived {staMaxFraction, recBonus}
 *                          aggregates read by CharacterData.prepareDerivedData
 *                          through statusEngine.derivedMods(actor):
 *                            staMaxFraction  multiplicative reduction of sta.max
 *                                            (-0.2 = 20 % cut). Sums across
 *                                            active statuses, clamps the floor
 *                                            so sta.max never goes below 0.
 *                            recBonus        flat REC add (gorged: +2).
 *                          NOT emitted as AE changes — derived numbers are
 *                          recomputed every prepare cycle, so the status engine
 *                          is the single read at derive time.
 *
 *   mods.roll   {...}      flat roll modifiers, summed live at roll time:
 *                            attack     — to-hit rolls
 *                            defense    — defense reactions
 *                            awareness  — Awareness (sight) checks
 *                            all        — every attack / defense / skill roll
 *                            verbal     — Verbal Combat (reserved; not yet wired)
 *
 *   dot {amount, bypassArmor, scope}
 *                          damage-over-time, applied at the bearer's turn start
 *                          through the existing tick engine (armor SP + hit-
 *                          location multipliers honored unless bypassArmor):
 *                            amount       flat HP/round
 *                            bypassArmor  armor does NOT soak it (poison/bleed)
 *                            scope        "all-locations" → every body location
 *
 *   restrict {act, defend, hard}
 *                          lock — cannot take actions / cannot defend. `hard`
 *                          additionally forbids the Recovery full-round action
 *                          (Paralyzed / Unconscious); plain Stunned omits it so
 *                          the STA-recovery house rule still applies.
 *
 *   incomingDC  n          a helpless target is auto-hit on an attack roll ≥ n.
 *
 *   endCheck {kind, skill, dc, actionCost, viaAction, label, icon}
 *                          the check that ENDS the status:
 *                            kind:"stunSave"  → actor.rollStunSave()
 *                            kind:"skill"     → DC `dc` `skill` check
 *                            actionCost   action slots the check consumes IN
 *                                         COMBAT (RAW "1 action" checks = 1;
 *                                         free start-of-turn recoveries omit it)
 *                            onPass       special success behavior instead of
 *                                         clearing the status — "endLastPotion"
 *                                         (Overdosed: purge the last potion and
 *                                         let the toxicity reconciler decide)
 *                            viaAction    when true the check is NOT auto-prompted
 *                                         at turn start; instead it's a player-
 *                                         triggered entry in the dock Action menu
 *                                         (still spends `actionCost`; repeatable,
 *                                         e.g. as an extra action).
 *                                         `label`/`icon` style that menu entry.
 *
 *   selfClear {label, actionCost, icon}
 *                          a no-roll "shake it off" the bearer triggers from the
 *                          combat dock's Action menu: spends `actionCost` action
 *                          slot(s) and clears the status outright (Stand from
 *                          Prone, put out Burning, wash off Acid). The menu greys
 *                          the entry unless the bearer currently has the status.
 *
 *   clearsAt "ownTurnStart"  auto-clears at the bearer's next turn.
 *   clearOnHit  true         being struck while suffering it ends it at once.
 *   periodic {everyRounds, rollUnder}
 *                          recurring save (nausea: every 3 rounds roll under the
 *                          named stat or lose the round to retching).
 *
 *   onApply.stress  n      one-shot stress delta applied to the bearer THE
 *                          MOMENT the ActiveEffect carrying this status is
 *                          created. Positive = gain stress (may trigger the
 *                          WILL save via stress.mjs); negative = relieve. Fires
 *                          only on AE create, not on re-renders or re-applies of
 *                          an already-present status. Used by the homebrew
 *                          food-and-drink statuses (drunk III-VI relieve, hunger
 *                          Hungry/Famished gain, Gorged relieves 2) but is a
 *                          universal primitive — a GM can paste it onto any
 *                          status via the editor.
 *                          GATED: the engine skips this delta entirely if the
 *                          `stress` homebrew toggle is off.
 *
 *   stressNote   string    Player-facing description fragment that only renders
 *                          when the `stress` homebrew is enabled. Appended to
 *                          `description` by descriptionFor(); the base
 *                          description never mentions stress so a pure-stress-
 *                          off world reads clean. Mirrors how the engine
 *                          handler gates onApply.stress — keeps mechanics and
 *                          flavor in sync.
 *
 *   hangover {recPenaltyFrom, daysFrom}
 *                          marks the status as the post-binge hangover. The
 *                          food-and-drink mechanic sets `daysRemaining` and the
 *                          REC penalty when it creates the effect; this clause
 *                          field just identifies the status to the day-tick
 *                          handler.
 *
 *   drunk {unconsciousDC, deathChance, level}
 *                          metadata for the drunk tier ladder read by the food-
 *                          and-drink mechanic's Endurance / blackout handler.
 *                          Lives on the clause so the GM can retune the DC and
 *                          death-chance from the Status Effects editor.
 *
 * Statuses with no mechanical clause (aim, fastDraw — both handled procedurally
 * in the attack/round mixins) carry only a description so the panel can list
 * them.
 */

export const STATUS_CLAUSES = {
    prone: {
        description: "Knocked down: −2 to attack and defense until you spend an action to stand.",
        mods: { roll: { attack: -2, defense: -2 } },
        selfClear: { label: "Stand", actionCost: 1, icon: "fa-person-walking" }
    },
    stunned: {
        description: "You can take no actions and cannot defend; attacks land on a roll of 10+. At the start of your turn make a Stun save to end it — being struck while stunned also snaps you out.",
        restrict: { act: true, defend: true },
        incomingDC: 10,
        endCheck: { kind: "stunSave" },
        clearOnHit: true
    },
    staggered: {
        description: "−2 to attack and defense; recovers automatically at the start of your next turn.",
        mods: { roll: { attack: -2, defense: -2 } },
        clearsAt: "ownTurnStart"
    },
    blinded: {
        description: "−3 to all attack and defense, −5 to sight-based Awareness. Spend an action to clear your eyes.",
        mods: { roll: { attack: -3, defense: -3, awareness: -5 } }
    },
    grappled: {
        description: "Held: −2 to physical actions and you can't move off. Beat the grappler's Brawling with Dodge/Escape to slip free.",
        mods: { roll: { attack: -2, defense: -2 } }
    },
    pinned: {
        description: "Pinned after a successful grapple: immobilized — you cannot move or act. Escape with a Dodge/Escape roll opposed by the grappler's Brawling.",
        restrict: { act: true }
    },
    intoxicated: {
        description: "−2 REF / DEX / INT and −3 Verbal Combat; 25% chance you won't remember what you did.",
        mods: { stats: { ref: -2, dex: -2, int: -2 }, roll: { verbal: -3 } }
    },
    hallucinating: {
        description: "GM-controlled false sensory images. A DC 15 Deduction check recognizes each illusion for what it is.",
        endCheck: { kind: "skill", skill: "deduction", dc: 15 }
    },
    paralyzed: {
        description: "Cannot act or defend; a helpless target is hit on a roll of 10+.",
        restrict: { act: true, defend: true, hard: true },
        incomingDC: 10
    },
    restrained: {
        description: "Movement is blocked. Break free with an Athletics or Brawling check."
    },
    unconscious: {
        description: "Out cold: treated as stunned — no actions, no defense, auto-hit. Wakes at 20+ STA with a passed Stun save.",
        restrict: { act: true, defend: true, hard: true },
        incomingDC: 10
    },
    dead: {
        description: "Slain."
    },
    poisoned: {
        description: "3 damage at the start of each turn — armor does NOT soak it. A DC 15 Endurance check (1 action) ends it.",
        dot: { amount: 3, bypassArmor: true },
        endCheck: { kind: "skill", skill: "endurance", dc: 15, actionCost: 1 }
    },
    overdosed: {
        description: "Toxicity over your limit (Core p.248): 3 damage at the start of each turn — armor does NOT soak it. It lifts the moment your toxicity falls back to your cap. You may also use the Action menu (1 action) to make a DC 18 Endurance check that purges the last potion you drank.",
        dot: { amount: 3, bypassArmor: true },
        endCheck: { kind: "skill", skill: "endurance", dc: 18, actionCost: 1, onPass: "endLastPotion",
                    viaAction: true, label: "Purge Overdose", icon: "fa-hand-holding-droplet" }
    },
    diseased: {
        description: "−2 to every action and maximum Stamina cut by a quarter while ill. Periodic Endurance checks stave off nausea. Only a Doctor's treatment (a Healing Hands check) plus a full night's rest clears it.",
        mods: { roll: { all: -2 } }
    },
    exhausted: {
        description: "−1 to every roll until you rest.",
        mods: { roll: { all: -1 } }
    },
    freeze: {
        description: "−3 SPD and −1 REF. A DC 16 Physique check (1 action) breaks the ice.",
        mods: { stats: { spd: -3, ref: -1 } },
        endCheck: { kind: "skill", skill: "physique", dc: 16, actionCost: 1 }
    },
    bleed: {
        description: "2 damage at the start of each turn — armor does NOT soak it. A Healing spell or a DC 15 First Aid check (1 action) stops it.",
        dot: { amount: 2, bypassArmor: true },
        endCheck: { kind: "skill", skill: "firstaid", dc: 15, actionCost: 1 }
    },
    burning: {
        description: "5 damage to every body location each turn (armor soaks the hit) and the flames eat 1 SP off the armor covering each location. Spend an action to put it out (pour water / stop-drop-roll).",
        dot: { amount: 5, scope: "all-locations", ablateArmor: 1 },
        selfClear: { label: "Put Out Fire", actionCost: 1, icon: "fa-droplet" }
    },
    acid: {
        description: "4 damage at the start of each turn — eats through armor (ignores SP). Spend an action to wash it off, or escape the source.",
        dot: { amount: 4, bypassArmor: true },
        selfClear: { label: "Wash Off Acid", actionCost: 1, icon: "fa-shower" }
    },
    suffocation: {
        description: "3 damage at the start of each turn — armor does NOT soak it. Ends the moment air is restored (surfacing, escaping a chokehold).",
        dot: { amount: 3, bypassArmor: true }
    },
    nausea: {
        description: "Every 3 rounds, roll under BODY or spend the round vomiting and dry-heaving.",
        periodic: { everyRounds: 3, rollUnder: "body" }
    },

    // Markers handled procedurally elsewhere — description only.
    fastDraw: {
        description: "You snap-drew a weapon and must attack the same turn: roll into initiative at +3, but take −3 on that attack. Clears at the start of your next turn."
    },
    aim: {
        description: "Aim N: a full-round action grants +1 to your next ranged attack, stacking to +3 over consecutive rounds. Applied automatically and cleared when you fire."
    },

    /* ── Homebrew: food & drink (gated registration in statusEffects.mjs) ──
     *
     * Drunk tiers I-VIII. Stat penalties target `.modifier` (uncapped) so
     * tier V's -4 INT can take INT below 1. EMP / CRA buffs on tiers I-III
     * propagate to all skills under those stats via stat+rank+modifier.
     * Tiers III-VI relieve 1 stress on entry (`onApply.stress: -1`); VII-VIII
     * are past the relief sweet spot. The save / blackout / death-chance
     * metadata sits on `drunk.*` and is read by mechanics/foodAndDrink.mjs.
     */
    "drunk-1": {
        description: "Drunk I — Tipsy. +1 EMP and CRA (all skills under them rise with the stat), +2 Melee Damage.",
        mods: { stats: { emp: 1, cra: 1 } },
        drunk: { level: 1, meleeBonus: 2 }
    },
    "drunk-2": {
        description: "Drunk II — Buzzed. −1 REF, −1 DEX, +2 EMP, +2 CRA, +2 Melee Damage.",
        mods: { stats: { ref: -1, dex: -1, emp: 2, cra: 2 } },
        drunk: { level: 2, meleeBonus: 2 }
    },
    "drunk-3": {
        description: "Drunk III — Drunk. −2 REF, −2 DEX, −2 INT, +3 EMP.",
        stressNote: " Loosens the chest: clears 1 STRESS on apply.",
        mods: { stats: { ref: -2, dex: -2, int: -2, emp: 3 } },
        onApply: { stress: -1 },
        drunk: { level: 3 }
    },
    "drunk-4": {
        description: "Drunk IV — Hammered. −3 REF, −3 DEX, −3 SPD, −3 INT, −2 Resist Coercion / Magic.",
        stressNote: " Clears 1 STRESS on apply.",
        mods: { stats: { ref: -3, dex: -3, spd: -3, int: -3 },
                skills: { will: { resistcoerc: -2, resistmagic: -2 } } },
        onApply: { stress: -1 },
        drunk: { level: 4 }
    },
    "drunk-5": {
        description: "Drunk V — Wrecked. −4 REF, −4 DEX, −4 SPD, −4 INT, −4 Resist Coercion / Magic.",
        stressNote: " Clears 1 STRESS on apply.",
        mods: { stats: { ref: -4, dex: -4, spd: -4, int: -4 },
                skills: { will: { resistcoerc: -4, resistmagic: -4 } } },
        onApply: { stress: -1 },
        drunk: { level: 5 }
    },
    "drunk-6": {
        description: "Drunk VI — Blackout territory. Same penalties as Drunk V. Endurance DC 20 or unconscious for 2d6 hours.",
        stressNote: " Clears 1 STRESS on apply.",
        mods: { stats: { ref: -4, dex: -4, spd: -4, int: -4 },
                skills: { will: { resistcoerc: -4, resistmagic: -4 } } },
        onApply: { stress: -1 },
        drunk: { level: 6, unconsciousDC: 20 }
    },
    "drunk-7": {
        description: "Drunk VII — Lethal. Same penalties as Drunk V. Endurance DC 24 or unconscious for 2d6 hours; 25% chance to drop into the Death state instead.",
        mods: { stats: { ref: -4, dex: -4, spd: -4, int: -4 },
                skills: { will: { resistcoerc: -4, resistmagic: -4 } } },
        drunk: { level: 7, unconsciousDC: 24, deathChance: 25 }
    },
    "drunk-8": {
        description: "Drunk VIII — Lethal. Same penalties as Drunk V. Endurance DC 30 or unconscious for 2d6 hours; 50% chance to drop into the Death state instead.",
        mods: { stats: { ref: -4, dex: -4, spd: -4, int: -4 },
                skills: { will: { resistcoerc: -4, resistmagic: -4 } } },
        drunk: { level: 8, unconsciousDC: 30, deathChance: 50 }
    },

    /* Hangover (post-binge). Registered status; the actual REC penalty and
     * `daysRemaining` are set per-actor when the effect is CREATED (peak ÷ 2
     * floor, ceil(peak/3) days) by mechanics/foodAndDrink.mjs#onSoberZero —
     * those numbers live on the AE itself so two actors with different peaks
     * carry different penalties. The clause just marks it for the day-tick
     * handler and carries the player-facing description. */
    hangover: {
        description: "Hangover — recovery from a binge. Reduces REC by half your peak drunk level (floor), for a third of your peak drunk level in days (ceil).",
        hangover: { tickPerDay: true }
    },

    /* Hunger tiers. Numbers are SATIETY ranges:
     *   gorged    101-125
     *   full       76-100   (no clause — pure flavor tier)
     *   fed        51- 75   (no clause)
     *   peckish    26- 50   (no clause — warning)
     *   hungry      1- 25
     *   famished    ≤ 0
     * Tier-cross stress is one-shot via `onApply.stress`.
     */
    gorged: {
        description: "Gorged — overfull. −1 REF, −1 DEX (sluggish), +2 REC.",
        stressNote: " The heavy meal clears 2 STRESS on apply.",
        mods: { stats: { ref: -1, dex: -1 }, derived: { recBonus: 2 } },
        onApply: { stress: -2 }
    },
    full: {
        description: "Full — well-fed. No mechanical effect."
    },
    fed: {
        description: "Fed — comfortable. No mechanical effect."
    },
    peckish: {
        description: "Peckish — getting hungry. No mechanical effect yet, but Hungry is one tick away."
    },
    hungry: {
        description: "Hungry — running on fumes. Max STA reduced by one-fifth.",
        stressNote: " You take +1 STRESS on entry.",
        mods: { derived: { staMaxFraction: -0.2 } },
        onApply: { stress: 1 }
    },
    famished: {
        description: "Famished — starving. Max STA reduced by two-fifths, −1 to every roll.",
        stressNote: " +1 STRESS on entry.",
        mods: { derived: { staMaxFraction: -0.4 }, roll: { all: -1 } },
        onApply: { stress: 1 }
    }
};

Object.freeze(STATUS_CLAUSES);
