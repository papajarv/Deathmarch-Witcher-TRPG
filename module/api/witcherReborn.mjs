/**
 * Witchers Reborn perk-check API.
 *
 * Single choke point every mixin / mechanic hook reads through. Combines
 * the `witcherReborn` homebrew toggle with the per-perk flags that the
 * race item's ActiveEffect stamps onto its owner (see
 * packs-src/witcher-reborn/ and tools/gen-witcher-reborn.mjs).
 *
 * Behavior when the toggle is off: every accessor returns null / false
 * without touching flags. Call sites can therefore always short-circuit
 * via `if (!hasPerk(actor, "bloodlust")) return;` without a second guard.
 *
 * Perk keys mirror the DSL flag names emitted by gen-witcher-reborn:
 *   Wolf      bladeExpertise, balancedStance, calmMind, stalkThePrey
 *   Cat       bloodlust, precisionStrike, swiftRecovery, lightStance
 *   Bear      juggernaut, forcefulBlow, perserver, heavyStance
 *   Griffin   conduit, combatMeditation, studiedWisdom, elementalControl
 *   Viper     bladeDance, sting, slither, lightStance
 *   Manticore alwaysReady, perfectParry, riposte, shieldMastery
 *
 * Heroic action keys:
 *   pirouette, deadlyFocus, unrelenting, flowAndEbb, lightningFast, standAside
 */

import { isHomebrewEnabled } from "./homebrew.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Cheap gate — hot path in the attack / defense loop. Reads the same
 * setting the sheet toggle drives; no other side-effects. */
export function wrEnabled() {
    return isHomebrewEnabled("witcherReborn");
}

export function hasWRPerk(actor, perkKey) {
    if (!actor || !wrEnabled()) return false;
    return !!actor.getFlag?.(SYSTEM_ID, `wr.${perkKey}`);
}

export function wrSchool(actor) {
    if (!actor || !wrEnabled()) return null;
    return actor.getFlag?.(SYSTEM_ID, "wr.school") ?? null;
}

export function wrHeroic(actor) {
    if (!actor || !wrEnabled()) return null;
    return actor.getFlag?.(SYSTEM_ID, "wr.heroic") ?? null;
}

/* Which perks let this actor spend 5 STA to skip a fumble, and for which
 * roll type. Returned as a Set of fumble contexts the actor is eligible
 * to skip: "meleeAttack" | "armedDefense" | "unarmedDefense" | "magic" | ...
 *
 * Mapping:
 *   Wolf     · Balanced Stance    → every category
 *   Cat      · Light Stance       → meleeAttack, unarmedDefense
 *   Bear     · Heavy Stance       → meleeAttack, armedDefense
 *   Viper    · Light Stance       → meleeAttack, unarmedDefense
 *   Griffin  · Elemental Control  → magic
 *
 * Called by the auto-fumble dialog in Phase 3. */
export function wrFumbleSkipContexts(actor) {
    const set = new Set();
    if (!actor || !wrEnabled()) return set;
    if (hasWRPerk(actor, "balancedStance")) {
        /* Wolf · Balanced Stance covers "a fumble of any kind" —
         * every registered fumble category, including the generic
         * skillCheck fallback for non-combat skill rolls. */
        set.add("meleeAttack");
        set.add("armedDefense");
        set.add("rangedAttack");
        set.add("unarmedAttack");
        set.add("unarmedDefense");
        set.add("magic");
        set.add("skillCheck");
    }
    if (hasWRPerk(actor, "lightStance")) {
        /* Cat · Light Stance: armed attacks + unarmed defenses. */
        set.add("meleeAttack");
        set.add("unarmedDefense");
    }
    if (hasWRPerk(actor, "heavyStance")) {
        /* Bear · Heavy Stance: armed attacks + armed defenses. */
        set.add("meleeAttack");
        set.add("armedDefense");
    }
    if (hasWRPerk(actor, "elementalControl")) {
        /* Griffin · Elemental Control: magical fumbles only. */
        set.add("magic");
    }
    return set;
}
