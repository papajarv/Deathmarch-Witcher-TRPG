/**
 * Hold-family contextual roll modifiers (CE only).
 *
 * The CE flavor of Grapple/Pin gives the HOLDER their own penalty:
 *   Grappling → −2 to all physical actions, EXCEPT vs the grappled target
 *   Pinning   → −3 to all physical actions, EXCEPT vs the pinned target
 *                (stacks with the −2 grapple penalty on top)
 *
 * The "except vs partner" carve-out can't be expressed in a static
 * status clause because the roll's TARGET is only known at roll time,
 * not at status apply time. This module computes the mod at roll time
 * by reading the hold registry.
 *
 * Design:
 *   - contextualPhysicalMod(actor, targetActor) is the single entry
 *     point. Returns the sum of grappler + pinner penalties, honoring
 *     the carve-out. Returns 0 when CE is off, when the actor is not
 *     a holder of any grappling/pinning pair, or when the target IS
 *     the actor's held partner.
 *   - Called by weaponAttackMixin (attack rolls), defenseMixin
 *     (defense rolls), brawlMixin (brawl action rolls), and
 *     skillMixin (physical skill checks). Each caller passes the
 *     actor and the current target if one exists.
 *
 * Why here (not in statusEngine): statusEngine is a pure interpreter
 * over the static clause table. Adding registry reads there would
 * couple it to hold state and force it to be async in every call
 * site. Keeping this module separate lets statusEngine stay sync.
 */

import { getHoldsSync }        from "./holdRegistry.mjs";
import { normalizedActorUuid } from "./holdLink.mjs";
import { isHomebrewEnabled }   from "../api/homebrew.mjs";

/** Compute the CE contextual physical penalty for `actor` rolling
 *  against `targetActor`. Returns a non-positive number.
 *
 *   - 0 when CE is off.
 *   - 0 when the actor isn't a holder of any qualifying pair.
 *   - 0 when the roll's target IS the actor's held partner
 *     (the whole point of the carve-out: you get the penalty
 *     EXCEPT when acting on the one you hold).
 *   - -2 if the actor is holder of a `grappled` pair with someone
 *     other than the target.
 *   - -3 if the actor is holder of a `pinned` pair with someone
 *     other than the target. Stacks with the grapple penalty when
 *     both apply (Pin is a grapple upgrade — the pinner is still
 *     grappling too), so the max total is -5.
 *
 *  Chokehold is not penalized — the choker only holds a hand on
 *  a throat, they aren't constrained the way a grappler is (per
 *  the CE spec: choke does not add its own physical penalty). */
export function contextualPhysicalMod(actor, targetActor = null) {
    if (!actor) return 0;
    try { if (isHomebrewEnabled("extendedCombat") !== true) return 0; }
    catch (_) { return 0; }
    const actorUuid = normalizedActorUuid(actor);
    if (!actorUuid) return 0;
    const targetUuid = targetActor ? normalizedActorUuid(targetActor) : null;
    const pairs = getHoldsSync(actorUuid);
    if (pairs.length === 0) return 0;

    /* Is the actor holder of a pair of this kind whose target is
     * NOT the current roll target? If yes, the penalty applies. If
     * every matching pair's target IS the roll target, it's carved
     * out. */
    const holderPenaltyApplies = (kind) => pairs.some(p =>
        p.holderUuid === actorUuid &&
        p.kind       === kind &&
        (!targetUuid || p.targetUuid !== targetUuid));

    let mod = 0;
    if (holderPenaltyApplies("grappled")) mod -= 2;
    if (holderPenaltyApplies("pinned"))   mod -= 3;
    return mod;
}

/** Compute the effective per-turn suffocation damage for `actor` from
 *  any active CE chokehold pairs the actor is TARGET of. Returns null
 *  when the actor isn't currently choked or when CE is off — the caller
 *  should fall back to the clause's static `dot.amount` in that case.
 *
 *  CE spec (2026-07-03): "If you succeed, they take suffocation damage
 *  equal to 3 + your melee damage modifier (if positive). They take
 *  the suffocation damage again each turn that you maintain the choke
 *  hold."
 *
 *  Multi-choker edge case (rare but possible via multi-clinch): apply
 *  the STRONGEST choker's damage. Summing across multiple chokers is
 *  not what "your melee damage modifier" says — each choker's damage
 *  is a per-actor number, but the suffocation is one status. Max is a
 *  defensible rule ("the deepest grip decides"). */
export function ceChokeholdDoTAmount(actor) {
    if (!actor) return null;
    try { if (isHomebrewEnabled("extendedCombat") !== true) return null; }
    catch (_) { return null; }
    const actorUuid = normalizedActorUuid(actor);
    if (!actorUuid) return null;
    const pairs = getHoldsSync(actorUuid);
    const chokeholders = [];
    for (const p of pairs) {
        if (p.kind !== "chokeheld") continue;
        if (p.targetUuid !== actorUuid) continue;
        /* Look up the holder actor synchronously. fromUuid is async,
         * so we fall back to a game.actors world scan by uuid — the
         * registry stores world uuids after normalization, so a bare
         * game.actors.get on the id portion is sufficient. */
        const id = String(p.holderUuid ?? "").split(".").pop();
        const holder = id ? game?.actors?.get?.(id) : null;
        if (holder) chokeholders.push(holder);
    }
    if (chokeholders.length === 0) return null;
    const maxBonus = Math.max(0, ...chokeholders.map(c =>
        Number(c?.system?.derivedStats?.meleeBonus) || 0));
    return 3 + maxBonus;
}

/** Rendered label + value pair for the attack/defense card breakdown
 *  chips. Returns null when the mod is 0 so callers can conditionally
 *  render (`chips.push(chip); if (!chip) skip`).
 *
 *  Consumed by weaponAttackMixin / defenseMixin when they compose the
 *  status-mod chip strip on the chat card so the player + GM see
 *  exactly WHY the roll took a hit. */
export function contextualPhysicalChip(actor, targetActor = null) {
    const mod = contextualPhysicalMod(actor, targetActor);
    if (!mod) return null;
    /* Prefer the more specific label when only one component is
     * present. If both apply (mod = -5), name the stacking. */
    const label = mod === -2 ? "Grappling"
                : mod === -3 ? "Pinning"
                : "Grappling + Pinning";
    return { label, value: (mod > 0 ? `+${mod}` : `${mod}`) };
}
