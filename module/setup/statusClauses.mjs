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
    }
};

Object.freeze(STATUS_CLAUSES);
