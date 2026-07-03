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
    /* Charging — armed by the dock's Full Round → Charge action.
     * Grants SPD×3 movement (via combatRoundMixin runUsed flag set
     * alongside this) and forces the actor's next weapon or brawl
     * attack to Strong Strike only. The attack dialog / brawl dialog
     * filter their pickers to the single Strong option while this is
     * set. Cleared when the next attack commits. Purely a UX / gate
     * status — no rolls, no penalties. */
    charging: {
        description: "Charging — next attack is locked to Strong Strike (RAW: -3 to hit, ×2 damage). If the attack is blocked, roll Physique vs the defender's Physique to knock them prone."
    },
    prone: {
        description: "Knocked down: −2 to attack and defense until you spend an action to stand.",
        mods: { roll: { attack: -2, defense: -2 } },
        selfClear: { label: "Stand", actionCost: 1, icon: "fa-person-walking" },
        /* Tangible — comes from physical impact (knockdown, sweep, push).
         * A cast shield (Quen, Active Shield) absorbs the impact so the
         * knock never lands. */
        tangible: true
    },
    stunned: {
        description: "You can take no actions and cannot defend; attacks land on a roll of 10+. At the start of your turn make a Stun save to end it — being struck while stunned also snaps you out.",
        restrict: { act: true, defend: true },
        incomingDC: 10,
        endCheck: { kind: "stunSave" },
        clearOnHit: true,
        tangible: true
    },
    staggered: {
        description: "−2 to attack and defense; recovers automatically at the start of your next turn.",
        mods: { roll: { attack: -2, defense: -2 } },
        clearsAt: "ownTurnStart",
        tangible: true
    },
    blinded: {
        description: "−3 to all attack and defense, −5 to sight-based Awareness. Spend an action to clear your eyes.",
        mods: { roll: { attack: -3, defense: -3, awareness: -5 } }
    },
    restrictedVision: {
        description: "Vision restricted (visor down or shield covering your head): −2 to Block, Parry, and Dodge until your next turn or the obstruction is removed.",
        mods: { roll: { defense: -2 } },
        clearsAt: "ownTurnStart"
    },
    grappled: {
        /* RAW Core p.161 "Grapple": while grappled, target cannot move
         * away from the grappler and takes −2 to ALL physical actions
         * (not just attack + defense — the grappled body is a whole-
         * combat penalty). Escape is a dedicated action: Dodge/Escape
         * opposed vs the grappler's Brawling. Movement no longer
         * auto-breaks the pair. */
        description: "Held in a grapple: −2 to all physical actions and you can't move away. Use the Escape action (Dodge/Escape vs the grappler's Brawling) to slip free. If not also pinned or choked, you may Reverse Grapple (opposed Brawling) to swap dominance.",
        mods: { roll: { all: -2 } },
        restrict: { move: true },
        tangible: true
    },
    /* "You are the grappler" indicator — stamped on the holder side of
     * any active `grappled` pair.
     *
     * MOVEMENT: universal in RAW and CE. Core p.161 says the grappler can
     * only move if they drag the grappled target with them (which our
     * engine models by refusing independent movement); if they release
     * to move freely, the grapple ends. Enforced via restrict.move here.
     *
     * DAMAGE: the −2-to-physical-except-vs-partner penalty is a Combat
     * Extended addition applied at roll time by
     * mechanics/holdModifiers.contextualPhysicalMod, gated on the CE
     * setting inside that helper. RAW gets the move-lock without the
     * penalty; CE gets both. */
    isGrappling: {
        description: "Grappling someone: you cannot move away without releasing the grapple. Under Combat Extended, you also take −2 to all physical actions except against the actor(s) you hold.",
        restrict: { move: true },
        tangible: true
    },
    pinned: {
        /* RAW Core "Brawling & Wrestling": a pinned target is helpless —
         * any attack against them lands on a roll of 10+ (same rule
         * paralyzed uses via incomingDC). The dedicated Escape action
         * bypasses the act-restriction (see cannotEscape in the status
         * engine + escapeAttempt flag on recordAction); every other
         * action is refused. */
        description: "Pinned after a successful grapple: immobilized — you cannot move or act. Attacks against you land on a roll of 10+. Escape with a Dodge/Escape roll opposed by the grappler's Brawling.",
        restrict: { act: true, move: true },
        incomingDC: 10,
        tangible: true
    },
    /* CE Combat Extended: pinner-side status.
     *   - `restrict.move` — pinning locks the pinner to the target's
     *     space (RAW's "you also occupy the same space and can not move
     *     away without releasing the pin").
     *   - No roll mods here; the −3 penalty (except vs pinned foe)
     *     comes from the runtime carve-out, same shape as isGrappling.
     * Stamped by holdLink when a `pinned` pair is created under CE.
     * Cleared when the pair is removed. */
    isPinning: {
        description: "Pinning someone: −3 to all physical actions except against the pinned foe; you cannot move away until you release the pin. (CE only.)",
        restrict: { move: true },
        tangible: true
    },
    /* CE Combat Extended: chokehold indicator on the choker.
     * Visible only. Damage math for the target's suffocation DoT lives
     * in the suffocation clause + holdLink chokehold branch. */
    isChoking: {
        description: "Applying a chokehold: the target takes 3 + your melee damage bonus in suffocation damage each turn you maintain it. (CE only.)",
        tangible: true
    },
    /* CE Combat Extended: rider-side status.
     *   - `restrict.move` — the rider cannot initiate their own
     *     movement while mounted; a movement policy hook slaves the
     *     rider's token position to the mount's on each mount move.
     * Stamped by holdLink when a `mounted` pair is created under CE. */
    isMounted: {
        description: "Riding a larger enemy: you cannot move independently — you move wherever they move. You are in their blind spot; they must spend a Move + Brawling check vs your Ride to attack you. (CE only.)",
        restrict: { move: true },
        tangible: true
    },
    /* CE Combat Extended: mount-side status.
     * Visible only. The mount's own actions are gated at attack time
     * (they must beat the rider's Ride with a Brawling check before
     * they can swing a tail/forelimb at the rider). */
    mounted: {
        description: "A rider clings to your back — they're in your blind spot. To attack them, you must spend a Move and beat their Ride check with Brawling. (CE only.)",
        tangible: true
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
        description: "Movement is blocked. Break free with an Athletics or Brawling check.",
        tangible: true
    },
    entangled: {
        description: "Wrapped up: −5 SPD and −2 to all physical actions. On your turn, a DC 18 Dodge/Escape or Contortionist check breaks free; an ally may spend an action to remove it.",
        mods: { stats: { spd: -5 }, roll: { attack: -2, defense: -2 } },
        endCheck: { kind: "skill", skill: "dodgeescape", dc: 18 },
        tangible: true
    },
    unconscious: {
        description: "Out cold: treated as stunned — no actions, no defense, auto-hit. Wakes at 20+ STA with a passed Stun save.",
        restrict: { act: true, defend: true, hard: true },
        incomingDC: 10,
        tangible: true
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
        endCheck: { kind: "skill", skill: "physique", dc: 16, actionCost: 1 },
        /* Tangible — a physical status that a cast shield (Quen, Active
         * Shield) blocks. Intangible statuses (poisoned, suffocation,
         * nausea, exhausted, diseased, overdosed) still land through
         * a shield since they're internal/environmental, not something
         * the barrier stops. */
        tangible: true
    },
    bleed: {
        description: "2 damage at the start of each turn — armor does NOT soak it. A Healing spell or a DC 15 First Aid check (1 action) stops it.",
        dot: { amount: 2, bypassArmor: true },
        endCheck: { kind: "skill", skill: "firstaid", dc: 15, actionCost: 1 },
        tangible: true
    },
    burning: {
        description: "5 damage to every body location each turn (armor soaks the hit) and the flames eat 1 SP off the armor covering each location. Spend an action to put it out (pour water / stop-drop-roll).",
        dot: { amount: 5, scope: "all-locations", ablateArmor: 1 },
        selfClear: { label: "Put Out Fire", actionCost: 1, icon: "fa-droplet" },
        tangible: true
    },
    acid: {
        description: "4 damage at the start of each turn — eats through armor (ignores SP). Spend an action to wash it off, or escape the source.",
        dot: { amount: 4, bypassArmor: true },
        selfClear: { label: "Wash Off Acid", actionCost: 1, icon: "fa-shower" },
        tangible: true
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
        description: "You snap-drew a weapon and MUST make an attack with it this turn (RAW Core p.165). Roll into initiative at +3 and take −3 on that attack. If the turn ends without attacking, the snap-draw is wasted and Fast Draw clears with a chat warning. Cleared automatically when the attack lands."
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
        description: "Hangover — paying for last night. Your head's pounding, your stomach's a knot, and every REC roll feels like climbing out of a well. Sleep it off over the next few days.",
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
        description: "Gorged — overfull. −1 REF, −1 DEX (sluggish). The full belly powers daily recovery — counts as +2 REC for healing purposes (your displayed REC stat is unchanged).",
        stressNote: " The heavy meal clears 2 STRESS on apply.",
        mods: { stats: { ref: -1, dex: -1 } },
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
    },

    /* Alchemy Reborn toxicity tiers (per alch2.png "Witcher Potion Toxicity"
     * + the user's tier ladder). Four tiers gated on % over your toxicity
     * threshold (consume-item.js: syncAlchemyRebornToxicityTier):
     *   Mild     0–25% over    (>1.00× to ≤1.25×)  →  1 Poison / turn
     *   Strong  26–51% over    (≥1.26× to ≤1.51×)  →  2 Poison / turn
     *   Severe  52–99% over    (≥1.52× to <2.00×)  →  3 Poison / turn
     *   Deadly  ≥100% over     (≥2.00×, "twice")   →  Death State (HP→0)
     * All bypass armor. There is no per-turn toxicity decay engine —
     * toxicity drops naturally as the underlying potion AEs expire on
     * their own durations. The Deadly tier's Death State (HP→0 on tier
     * entry) is wired in consume-item.js, not through the dot clause. */
    "toxicity-mild": {
        description: "Toxicity Mild (0–25% over your toxicity threshold) — armor does NOT soak it. 1 Poison damage every turn until your toxicity drops back to or below your threshold.",
        dot: { amount: 1, cadence: 1, bypassArmor: true }
    },
    "toxicity-strong": {
        description: "Toxicity Strong (26–51% over your toxicity threshold) — armor does NOT soak it. 2 Poison damage every turn until your toxicity drops back below 1.26× your threshold.",
        dot: { amount: 2, cadence: 1, bypassArmor: true }
    },
    "toxicity-severe": {
        description: "Toxicity Severe (52–99% over your toxicity threshold) — armor does NOT soak it. 3 Poison damage every turn until your toxicity drops back below 1.52× your threshold.",
        dot: { amount: 3, cadence: 1, bypassArmor: true }
    },
    "toxicity-deadly": {
        description: "Toxicity Deadly (at or above twice your toxicity threshold). You are thrown into Death State (HP→0) until your toxicity drops back below 2× your threshold.",
        // No DoT — Death State (HP→0) is wired in consume-item.js, not
        // through this engine. amount: 0 keeps the per-turn HP tick silent.
        dot: { amount: 0, cadence: 1, bypassArmor: true }
    },

    /* Food sickness — failed Endurance vs DC 14 after eating spoiled food.
     * Lighter than Famished: a one-day, no-stress queasy hit. The native AE
     * duration (24h, set at create-time by applySpoiledHazard) handles
     * auto-clear — no clause-side ticking required. */
    "food-sickness": {
        description: "Food Sickness — queasy from spoiled food. Max STA reduced by one-fifth, −1 to every roll. Clears after a day's rest.",
        mods: { derived: { staMaxFraction: -0.2 }, roll: { all: -1 } }
    },

    /* ── Homebrew: stress mental breaks (gated registration in
     *      statusEffects.mjs). Mental breaks stack and persist until either
     *      stress drops to 0 (clearBreakdownEffects strips them) or all 8
     *      breaks are owned (character control passes to the GM). The flag
     *      `flags.<systemId>.stressBreakdown` marks them so the stress system
     *      can find / clear them. Breaks WITHOUT mechanical effects (Indulgent,
     *      Paranoid, Impulsive, Selfish) live as marker AEs — no clause needed.
     *      Breaks WITH effects (Scared, Depressive, Violent) get clauses here
     *      so the modifier pipeline picks them up. Self-Harming applies its
     *      1d6 damage on-create (in mechanics/stress.mjs#applyBreakdownEffect)
     *      and persists as a marker. ─────────────────────────────────────── */
    "break-scared": {
        description: "Scared — gripped by uncertainty. −1 to every roll.",
        mods: { roll: { all: -1 } }
    },
    "break-depressive": {
        description: "Depressive — what's the point. −2 WILL.",
        mods: { stats: { will: -2 } }
    },
    "break-violent": {
        description: "Violent — only one answer. +1 REF for the immediate combat.",
        mods: { stats: { ref: 1 } }
    },

    /* ── Homebrew: stress boons (nat-1 on the WILL save). Every boon now
     *      registers a status — the three "lasting" ones below carry mods,
     *      the instant clears / absorb buffers / reroll marker carry no mods
     *      but exist as registered statuses so they appear in the Status
     *      Effects editor and the token HUD's status panel for manual
     *      application. Mechanical behavior of the absorb / reroll / clear
     *      boons is wired imperatively in mechanics/stress.mjs. ── */
    "boon-focused": {
        description: "Focused — +1 to attack rolls for the rest of the day.",
        mods: { roll: { attack: 1 } }
    },
    "boon-determined-grit": {
        description: "Determined Grit — ignore wound penalties for 3 turns.",
        mods: { }
    },
    "boon-smile-at-death": {
        description: "Smile at Death — accepting the end made you sharper: +2 REF, ignore wound penalties, +2d6 temp HP/STA. When combat ends you're thrown back into the Death state.",
        mods: { stats: { ref: 2 } }
    },
    /* Marker-only boons — registered so the GM can apply them via the token
     * HUD (e.g. to manually trigger a Stoic buffer outside the WILL-save
     * flow). The actual mechanical effect — the absorb buffer (Stoic /
     * Hopeful), the reroll flag (Defiant), the instant clears (Optimistic /
     * Stalwart / Unbreakable) — is set up by applyBoonEffect when the boon
     * is rolled; manually applying these via the HUD is a presentation/marker
     * action only, and won't itself top up the buffer. */
    "boon-stoic": {
        description: "Stoic — ignores the next 1d6 points of STRESS. Buffer persists until depleted.",
        mods: { },
        // Declarative absorb buffer: when this status lands on a character,
        // statusEngine.onApply rolls the dice and writes the result into the
        // AE's stressAbsorbPoints flag. preUpdateActor reads it on each
        // stress raise. `kind` is "points" (per-point) or "sources" (per-event).
        stressShield: { kind: "points", dice: "1d6" }
    },
    "boon-optimistic": {
        description: "Optimistic — cleared 1 STRESS.",
        mods: { }
    },
    "boon-hopeful": {
        description: "Hopeful — ignores the next 2d6 SOURCES of STRESS. Persists until depleted.",
        mods: { },
        stressShield: { kind: "sources", dice: "2d6" }
    },
    "boon-defiant": {
        description: "Defiant — rolls twice and takes the best on the next mental break.",
        mods: { }
    },
    "boon-stalwart": {
        description: "Stalwart — cleared 2 STRESS.",
        mods: { }
    },
    "boon-unbreakable": {
        description: "Unbreakable — cleared all STRESS. While active (3 turns): ignores wound-threshold and death-state penalties, and auto-passes the next 3 death saves taken in combat.",
        mods: { }
    },
    /* Marker clauses for the 5 flavor-only mental breaks. Their mechanical
     * effect is roleplay, not a stat mod — they exist as registered statuses
     * so the GM can apply them manually via the HUD and the Status Effects
     * editor lets the GM tune their presentation per the homebrew pattern. */
    "break-indulgent": {
        description: "Indulgent — This is too much. You need your vice. You need comfort. Eat food until you are gorged.",
        mods: { }
    },
    "break-paranoid": {
        description: "Paranoid — Can you really trust anyone but yourself? Are you being watched? Something is out to get you. Isolate.",
        mods: { }
    },
    "break-impulsive": {
        description: "Impulsive — Just do something. Anything. Not the time to think about it.",
        mods: { }
    },
    "break-self-harming": {
        description: "Self-Harming — Stupid, stupid, stupid. This is all your fault. You did this. Take 1d6 damage on a random body part.",
        mods: { }
    },
    "break-selfish": {
        description: "Selfish — This is not the time to think of others. You need to look out for yourself.",
        mods: { }
    },
    /* Yrden — persistent zone status applied by the Yrden sign
     * (errata p.14 formula: −1 base + 1 per every 2 extra STA
     * over 1, cap −4).
     *
     * The clause carries a NOMINAL magnitude (−1) so that a
     * manually-applied Yrden effect (via the token HUD) still
     * imposes a real penalty. The zone engine (mechanics/
     * zoneEffects.mjs) uses `zoneScaleKeys` to know that REF and
     * DEX should be OVERRIDDEN with the rider's resolved staScale
     * magnitude at AE-create time, not the -1 default.
     *
     * `mods.stats` targets `system.stats.ref.current` /
     * `system.stats.dex.current` — the CURRENT-vs-base pattern
     * used elsewhere in the codebase so buffs and debuffs stack
     * arithmetically without touching the character's base sheet. */
    yrden: {
        /* RAW errata p.5: Yrden's trap-circle penalty hits REF and
         * SPD (movement + reflexes), NOT REF and DEX as some older
         * printings implied. The trap is a slow-and-hobble effect. */
        description: "Trapped in Yrden's circle — REF and SPD penalties scale with the STA the caster poured into the sign (errata: -1 at 1 STA, -2 at 3 STA, -3 at 5 STA, -4 at 7 STA).",
        mods: {
            stats: { ref: -1, spd: -1 }
        },
        /* Zone-engine scale marker — the zone rider's resolved
         * magnitude overrides these stat values when the AE is
         * created. Any stat/roll key marked TRUE here is scaled;
         * anything not listed keeps the static value above. */
        zoneScaleKeys: {
            stats: { ref: true, spd: true }
        },
        tangible: false
    }
};

Object.freeze(STATUS_CLAUSES);

/**
 * CE Combat Extended clause overrides (2026-07-03).
 *
 * When the `extendedCombat` homebrew toggle is on, `getActiveClauses()`
 * (in mechanics/statusOverrides.mjs) layers these on top of the RAW
 * defaults and GM overrides. Each entry is a FULL clause replacement —
 * partial merge would leave stale keys (e.g. `restrict.act`) on the
 * RAW side that CE wants to drop.
 *
 * `pinned` — Under RAW, a pinned target is helpless: `restrict.act`
 * forbids everything except Escape, and `incomingDC: 10` auto-hits any
 * attack against them. Under CE (per the user's Combat Extended spec):
 *   - Target is NOT auto-hit (removed incomingDC).
 *   - Target can still attempt actions (removed restrict.act) — but
 *     at −3 to all physical rolls, which STACKS with the −2 grapple
 *     mod that's still on them (they're grappled too), for −5 total.
 *   - Target still can't move (kept restrict.move).
 * The grappler-side / pinner-side −3 penalty on the HOLDER applies
 * via the runtime carve-out in mechanics/holdModifiers, so no clause
 * shape here — the holder's mods stay context-aware to preserve the
 * "except vs the one you hold" exemption.
 */
export const CE_CLAUSE_OVERRIDES = Object.freeze({
    pinned: Object.freeze({
        description: "Pinned in a grapple: −3 to all physical actions (stacks with −2 grapple penalty). You can act at −5 but you cannot move until you Escape (Dodge/Escape vs the pinner's Brawling).",
        mods: Object.freeze({ roll: Object.freeze({ all: -3 }) }),
        restrict: Object.freeze({ move: true }),
        tangible: true
    })
});
