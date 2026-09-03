import { t, tFormat } from "../chrome/lib/i18n.js";
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
    tackling: {
        description: "Tackling — next melee attack is a Tackle: smash into a foe with opposed Physique. On a win you both go prone; on a loss only you go prone."
    },
    prone: {
        description: "Knocked down: −2 to attack and defense until you spend an action to stand.",
        mods: { roll: { attack: -2, defense: -2 } },
        selfClear: { label: t("WITCHER.Setup.StatusClauses.Dialog.Button.Stand", "Stand"), actionCost: 1, icon: "fa-person-walking" },
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
        /* The −2 is applied at ROLL TIME by mechanics/holdModifiers
         * (grappleePhysicalMod / contextualPhysicalMod), NOT as a static roll
         * mod here. Reason: the penalty is WAIVED against your own grappler
         * (CE), and "except vs the grappler" needs the roll's opponent, which
         * a static clause can't see. Same design as the grappler-side penalty
         * (isGrappling has no static mod either). RAW still gets a flat −2 —
         * the helper applies it in both RAW and CE; only the carve-out is CE. */
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
    /* CE Combat Extended: clinch aggressor-side indicator. Visible only —
     * the clinch itself carries no roll penalty; this just marks that you
     * are IN a clinch (you can't start another; Close Quarters is live).
     * Stamped by holdLink when a `clinched` pair is created; cleared when
     * the actor's last clinch as holder ends. */
    isClinching: {
        description: "In a clinch with a foe: you're locked chest-to-chest — Close Quarters weapons are usable and you can't start another clinch until this one breaks. (CE only.)",
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
                    viaAction: true, label: t("WITCHER.Setup.StatusClauses.Dialog.Button.PurgeOverdose", "Purge Overdose"), icon: "fa-hand-holding-droplet" }
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
        selfClear: { label: t("WITCHER.Setup.StatusClauses.Dialog.Button.PutOutFire", "Put Out Fire"), actionCost: 1, icon: "fa-droplet" },
        tangible: true
    },
    acid: {
        description: "4 damage at the start of each turn — eats through armor (ignores SP). Spend an action to wash it off, or escape the source.",
        dot: { amount: 4, bypassArmor: true },
        selfClear: { label: t("WITCHER.Setup.StatusClauses.Dialog.Button.WashOffAcid", "Wash Off Acid"), actionCost: 1, icon: "fa-shower" },
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

    // Carrying over capacity (BODY×10 kg). The −1/5kg REF/DEX/SPD hit is applied
    // directly to the stat values in CharacterData#prepareDerivedData; this
    // clause is description-only (the status is a heads-up, not a modifier
    // source, so it must NOT also carry `changes` or it would double-penalize).
    overencumbered: {
        description: "Overencumbered — carrying more than your capacity (BODY×10 kg). Subtract 1 from REF, DEX, and SPD for every 5 kg you exceed it (minimum 1). Drop weight to clear it."
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
        description: "Drunk VII — Blackout+. Same penalties as Drunk V. Endurance DC 24 or unconscious for 2d6 hours.",
        mods: { stats: { ref: -4, dex: -4, spd: -4, int: -4 },
                skills: { will: { resistcoerc: -4, resistmagic: -4 } } },
        drunk: { level: 7, unconsciousDC: 24 }
    },
    "drunk-8": {
        description: "Drunk VIII — Lethal. Same penalties as Drunk V. Endurance DC 30 or unconscious for 2d6 hours; on unconsciousness, 5% chance the character dies of alcohol poisoning.",
        mods: { stats: { ref: -4, dex: -4, spd: -4, int: -4 },
                skills: { will: { resistcoerc: -4, resistmagic: -4 } } },
        drunk: { level: 8, unconsciousDC: 30, deathChance: 5 }
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
    /* Hunger tiers — descriptions carry ONLY the always-on mechanic
     * (STA / roll debuffs). Hunger Stress is a stress-homebrew-gated
     * mechanic and lives in stressNote so it doesn't repeat in the
     * baseline description when the stress module is on. */
    hungry: {
        description: "Hungry — no stat debuff yet.",
        stressNote: " +1 Hunger Stress on descent — only cleared by eating back past Peckish.",
        mods: {}
    },
    /* Four depth bands below zero satiety. Each descending depth grants +1
     * Hunger Stress and reduces max STA by an additional 12.5%. All Hunger
     * Stress refunds ONLY by eating back UP through each corresponding
     * satiety threshold. Names by depth: Very Hungry / Weakening / Famished
     * / Starving. */
    "famished-1": {
        description: "Very Hungry — −12.5% max STA.",
        stressNote: " +1 Hunger Stress from this depth — only cleared by eating.",
        mods: { derived: { staMaxFraction: -0.125 } }
    },
    "famished-2": {
        description: "Weakening — −25% max STA.",
        stressNote: " +2 Hunger Stress from this depth — only cleared by eating.",
        mods: { derived: { staMaxFraction: -0.25 } }
    },
    "famished-3": {
        description: "Famished — −37.5% max STA, −1 all rolls.",
        stressNote: " +3 Hunger Stress from this depth — only cleared by eating.",
        mods: { derived: { staMaxFraction: -0.375 }, roll: { all: -1 } }
    },
    "famished-4": {
        description: "Starving — −50% max STA, −2 all rolls. Collapse below −MAX.",
        stressNote: " +4 Hunger Stress from this depth — only cleared by eating.",
        mods: { derived: { staMaxFraction: -0.5 }, roll: { all: -2 } }
    },
    /* Legacy single-tier famished retained so any orphan effects from
     * pre-migration state still resolve cleanly. Uses depth-4 mods. */
    famished: {
        description: "Starving. −50% max STA, −2 to every roll.",
        stressNote: " Hunger Stress is granted by the hunger cascade.",
        mods: { derived: { staMaxFraction: -0.5 }, roll: { all: -2 } }
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
        /* Zone-engine scale DEFAULT — used only when the item's
         * `statusRiders[i].staScale` is unset / all-zeros. Encodes the
         * errata formula precisely: `magnitude = offset × (1 + floor
         * ((sta - 1) / divisor))`, clamped by `cap`. A GM who authors
         * their own Yrden variant with a different scale on the rider
         * still wins — the per-rider value takes precedence — but a
         * "vanilla" Yrden with the rider unconfigured still scales
         * correctly because the clause knows the RAW rule. */
        staScale: { offset: -1, divisor: 2, cap: -4 },
        tangible: false
    },

    /* ── Spell-engine statuses ────────────────────────────────────────────
     *
     * The block-based spell engine registers conditions of its own in
     * module/magic/statuses.mjs. Registration only buys an id and an icon:
     * a status with no entry in THIS file has no description, no modifiers,
     * no restrictions and no DoT, because `clauseFor()` returns null and every
     * consumer shrugs. The ones below were registered and never given a clause,
     * so the token showed a badge and nothing in the system read it — the same
     * class of silent nothing as an unregistered id, one layer further in.
     *
     * Where the book states a rule the vocabulary can express, it is expressed.
     * Where it does not — a rule with no number, or a system that has nothing
     * for the rule to attach to — the entry carries a description (so the RAW
     * text at least reaches the sheet panel and the AE tooltip) plus a note
     * naming exactly what would have to exist. An honest gap you can read beats
     * an invented number or a badge that means nothing.
     */

    /* ETERNAL JUDGEMENT (invocation). "The fire does double the normal fire
     * damage and cannot be extinguished except by magic, or by completely
     * submerging underwater for 3 rounds."
     *
     * Double `burning`: 5 → 10 per location, same all-locations scope. The
     * armour ablation stays at burning's 1 SP — the book doubles the DAMAGE,
     * and doubling the ablation as well would be a number nobody wrote.
     *
     * THE MISSING `selfClear` IS THE RULE. `burning` carries a "Put Out Fire"
     * action; inheriting it (which is what the old `whiteFire → burning` alias
     * did) handed every victim the one escape the book denies them. The two
     * exits it DOES allow are already wired elsewhere: magic, through the
     * `fire` counteract tag in magic/statuses.mjs (Downpour removes it, and
     * Downpour is magic); and dispel/removal, through the `untilPutOut`
     * lifetime in magic/register.mjs, whose /burn|fire|alight/i test this id
     * matches — so the spell's own duration still ends when the effect goes.
     *
     * STILL UNWIRED: "completely submerging underwater for 3 rounds". The
     * vocabulary has a self-clear, an end CHECK and a periodic save, but no way
     * to say "clears after N consecutive rounds while another status
     * (`underwater`) is also present" — that needs a counter stored on the AE
     * and a turn-start reader that increments and resets it. Until that exists
     * the submersion route is GM-adjudicated: strip the status by hand on the
     * third round under. Named here rather than left implied, because a player
     * who reads the spell WILL try it.
     *
     * `tangible` mirrors `burning` deliberately: whether a cast shield turns
     * aside fire is one question, and answering it differently here would mean
     * Quen stops ordinary flame but not the fire that is harder to put out. */
    whiteFire: {
        description: "White fire — 10 damage to every body location each turn (armor soaks the hit) and the flames eat 1 SP off the armor covering each location. It cannot be put out by ordinary means: only magic, or three full rounds completely submerged, ends it.",
        dot: { amount: 10, scope: "all-locations", ablateArmor: 1 },
        tangible: true
    },

    /* HEALING REST (invocation). "They cannot act for the entirety of the rest
     * and are unaware of their surroundings even if touched, moved, or
     * attacked."
     *
     * Expressed with the same three clauses every other incapacitating status
     * uses, so the readers that already understand Paralyzed understand this:
     *   restrict.act/defend  — cannot act, cannot defend.
     *   restrict.hard        — also bars the Recovery full-round action. A
     *                          sleeper cannot "catch their breath"; `stunned`
     *                          omits `hard` precisely because its victim is
     *                          awake, and this one is not.
     *   incomingDC 10        — the system's existing helpless number (RAW Core
     *                          p.161, shared with paralyzed / unconscious /
     *                          pinned), not a figure invented for this spell.
     *
     * NO `clearOnHit`, and that is the whole difference from `stunned`: being
     * struck snaps a stunned fighter out, while the book says the opposite here
     * ("even if... attacked"). Copying stunned's clause wholesale would end a
     * day-long rest on the first arrow.
     *
     * NO `endCheck` — the rest runs out on its own duration (the spell applies
     * it `until: days 1`), not on a save the sleeper could pass.
     *
     * NOT `tangible` — a boon cast on willing allies. Marking it tangible would
     * let an ally's own cast shield absorb their week of healing. */
    healingComa: {
        description: "Deep healing coma — you cannot act, cannot defend, and are unaware of your surroundings even if touched, moved, or attacked. Attacks against you land on a roll of 10+. At the end of the rest you wake at full health, and any critical wounds that had been treated are healed.",
        restrict: { act: true, defend: true, hard: true },
        incomingDC: 10
    },

    /* LIGHT OF TRUTH (invocation). "If they fail, they must answer any question
     * truthfully."
     *
     * Description only, and not for want of looking. The vocabulary can debuff
     * one skill (`mods.skills: { emp: { deceit: -n } }` — Deceit is an EMP
     * skill) or Verbal Combat (`mods.roll.verbal`), but neither says what the
     * book says. RAW is ABSOLUTE — they must answer truthfully — not a penalty,
     * and the book gives no number, so any −n here would be homebrew wearing
     * RAW's clothes. There is no "forbid this skill" clause to reach for; a
     * hard prohibition is a table ruling, and the description is what carries
     * it to the table.
     *
     * NO `endCheck`, deliberately. "Every round the target must make another
     * check" is ALREADY wired by the spell itself — LIGHT_OF_TRUTH in
     * magic/spells/invocations.mjs pairs the status with
     * `core:saveEnds { skill: resistmagic, dcSource: castRoll, cadence: round }`.
     * An endCheck here would roll the same save a second time every round, and
     * two saves a round is half the duration the book wrote. */
    compelledToTruth: {
        description: "Compelled to truth — while the light holds you, you must answer any question put to you truthfully. Each round you may resist again; until you do, you cannot lie.",
        mods: { }
    },

    /* FREYA'S BRAVERY (invocation). "They become immune to fear."
     *
     * Description only, because THERE IS NO FEAR IN THIS SYSTEM to be immune
     * to. Swept setup/ and mechanics/: no `fear` / `terror` / `frightened`
     * status is registered, nothing applies one, and the only adjacent thing is
     * the `intimidation` skill (WILL) answered by Resist Coercion — a Verbal
     * Combat contest, not a condition immunity can bite on.
     *
     * The immunity primitive itself is real and would take this unchanged:
     * `statusEngine.statusImmunities()` unions a monster's
     * `system.combat.statusImmunities[]` with every active effect carrying an
     * `{ type: "immunity", status }` action, and policy/status-immunity.mjs
     * makes it bite (blocks the apply, and clears a matching status already
     * present). It keys on a STATUS ID, though, and there is no id to name.
     *
     * What would have to exist, in order: (1) a `frightened` status with a
     * clause here; (2) whatever causes fear — monster Fear abilities, the
     * intimidation flow — applying it; (3) the Freya effect carrying that
     * immunity action. Note step 3 is an AE-level flag, not a clause field, so
     * even once fear exists the grant is authored on the effect, not here.
     *
     * The spell's other half — "+25 Health Points" — is already granted by the
     * spell (`core:grantModifier hp +25`), so there is nothing owed to it. */
    fearless: {
        description: "Fearless — Modron Freya's presence steadies you: you are immune to fear.",
        mods: { }
    },

    /* HOLY LIGHT / AINE VERSEOS. "Lights up an area as though the caster was
     * carrying a torch" / "an area of bright light in a 4m radius".
     *
     * Description only, and this one is worth being precise about because the
     * system DOES have a real light model — it just cannot be reached from
     * here. mechanics/light-level.mjs answers a purely SPATIAL question:
     * `lightLevelAt(token)` samples Foundry's live lighting through
     * `pointIllumination()` — scene AmbientLights, token-emitted light, ambient
     * darkness — and never looks at the token's actor. No status raises or
     * lowers a tier, and no clause field feeds it.
     *
     * What would make these spells real: the cast has to emit ACTUAL light —
     * set the bearer token's `light` config (Aine Verseos: 4m bright; Holy
     * Light: torch-equivalent), or drop an AmbientLight for the zone — after
     * which `lightLevelAt` reports BRIGHT on its own and everything downstream
     * (stealth detection, the Awareness / attack / defense light penalties)
     * already reads it. Worth knowing before anyone tries to shortcut it with
     * roll mods: `LIGHT_TIER_PENALTY.bright` is EMPTY. Being lit costs the
     * bearer nothing; it matters to whoever is LOOKING for them. So the effect
     * belongs on the canvas, not on this actor's rolls, and a `mods.roll` here
     * would be both invented and pointing the wrong way. */
    brightlyLit: {
        description: "Brightly lit — you are bathed in magical light and are plainly visible to anyone looking. The light gives off no heat and cannot ignite anything.",
        mods: { }
    },

    /* DORMYN'S FOG. "-3 to Awareness and limits vision range to 4m."
     *
     * NO `mods.roll.awareness` HERE. The −3 is already applied by the spell —
     * DORMYNS_FOG in magic/spells/water.mjs pairs this status with
     * `core:grantModifier { stat: awareness, delta: -3 }`. Adding it here as
     * well would double it on every Awareness roll made in the fog, and it
     * would double silently, because both halves look correct in isolation.
     * This is the easiest mistake to make in this file; it is spelled out so
     * the next person to read the book text does not "fix" the omission.
     *
     * The 4m cap has a real counterpart and it is still out of reach:
     * `visionRangeMetres()` (mechanics/stealth-hooks.mjs) caps both detection
     * range and the drawn vision cone — but it reads `token.document.sight.range`
     * and returns Infinity outright whenever `sceneAmbientlyLit()`, so a fog in
     * daylight would cap nothing even if a status could write it. The only
     * writer of `sight.range` is policy/darkvision-sight.mjs, which stashes the
     * previous value on a flag so it can restore it on clear. Wiring this needs
     * the same shape for a fog cap AND `visionRangeMetres` growing a cap that
     * survives a lit scene. Neither is expressible as a clause. */
    visionLimited4m: {
        description: "Vision limited — thick fog closes in; you can see no further than 4m.",
        mods: { }
    },

    /* AIR POCKET. "A pocket of fresh air underwater or in an area where there
     * normally wouldn't be fresh air."
     *
     * Description only, because there is nothing yet for it to negate. The
     * `suffocation` status exists and ticks 3/round, but the only things that
     * APPLY it are a Combat Extended chokehold (mechanics/choke.mjs) and spells
     * that cast it directly. There is no drowning or airless-space rule — being
     * underwater with no air pocket currently costs nothing, so the pocket
     * currently saves nothing.
     *
     * Deliberately NOT wired as a blanket immunity, even though the primitive
     * exists (`{ type: "immunity", status: "suffocation" }` on the effect, via
     * statusEngine.statusImmunities). That keys on the status id alone, so an
     * air pocket would also make you immune to being strangled — which is not
     * what the book grants, and a wrong wire is worse than a visible gap.
     * What is needed: an environmental-suffocation rule (underwater / airless →
     * suffocation) that is distinguishable from a chokehold, either by its own
     * status id or by a source tag the immunity check can match on. */
    breathing: {
        description: "Breathing freely — a pocket of fresh air travels with you; you can breathe underwater or anywhere air would otherwise fail.",
        mods: { }
    },

    /* FRESHEN AIR. "Clear a 4m radius area of any smoke, poison, or any other
     * tainted air."
     *
     * Description only HERE — but unlike the others this one has a wire ready
     * and waiting, in the spell rather than the clause. The system has no
     * tainted-air model at all (swept mechanics/ and setup/: no gas, smoke or
     * fumes zone, nothing that applies `poisoned` from the air), yet the
     * suppression machinery this exact case wants already exists:
     * magic/statuses.mjs tags `poisoned → "poison"` and `intoxicated →
     * "intoxication"` in COUNTER_TAG_OF, and the adapter refuses to land any
     * tagged status inside a counteracting zone — which is how Downpour stops
     * new fires catching. So the fix is one block in magic/spells/air.mjs: a
     * `core:counteract` with tag "poison" in Freshen Air's zone body, exactly
     * as Downpour does for fire. It cannot live here: a clause can modify,
     * restrict, damage and end — it cannot counteract anything. */
    cleanAir: {
        description: "Clean air — the air around you is clear of smoke, poison, and any other taint.",
        mods: { }
    },

    /* URIEN'S SHELTER. "Negate hostile weather effects in an 8m radius...
     * extreme heat, extreme cold, rain, and snow."
     *
     * Description only. The weather model is real and DOES levy per-actor
     * penalties (`getEnvironmentalModifiersForActor` in
     * mechanics/weather-modifiers.mjs), and it already has a shelter concept —
     * but shelter there is POSITIONAL: it is decided entirely by the scene's
     * Indoors mode or by a Foundry-core `suppressWeather` Region containing the
     * token (`tokenInsideSuppressWeather`, mechanics/scene-weather-mode.mjs).
     * That function takes a TokenDocument and never looks at the actor's
     * statuses, so no clause can make it bite.
     *
     * Two ways to close it, both outside this file: have
     * `getEnvironmentalModifiersForActor` OR a status check in beside
     * `tokenInsideSuppressWeather`; or have the spell's 8m zone create a real
     * `suppressWeather` Region rather than only a measured template. The second
     * is the truer one — the shelter is a PLACE, and anyone standing in it is
     * out of the rain whether or not the spell tagged them. */
    shelteredFromWeather: {
        description: "Sheltered from the weather — extreme heat, extreme cold, rain, and snow do not reach you.",
        mods: { }
    }
};

/* Rewrite each clause's `description` into a lazy getter that resolves
 * `WITCHER.Setup.StatusClauses.<id>.Description` at read time. The raw
 * English becomes the fallback so a missing key never blanks the UI.
 * Consumers keep reading `clause.description` and get the localized
 * value in whatever language is loaded. */
for (const [id, clause] of Object.entries(STATUS_CLAUSES)) {
    const raw = clause.description ?? "";
    delete clause.description;
    Object.defineProperty(clause, "description", {
        get()      { return t(`WITCHER.Setup.StatusClauses.${id}.Description`, raw); },
        enumerable: true,
        configurable: false
    });
}
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
