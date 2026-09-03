/**
 * Combat Extended — guard-stance mechanics.
 *
 * Defines the four guard stances from rules1.png:
 *   balanced — no bonus, no penalty (default / out-of-combat / post-reset)
 *   warding  — per-weapon picked location: +2 parry/block there, −1
 *              parry/block any unwarded location
 *   closed   — +2 parry/block ALL locations, −2 to ALL attacks
 *   fools    — +2 to ALL attacks, −2 to ALL defenses
 *
 * Public API (consumed by attackDialog, defenseMixin, dock indicator):
 *   GUARDS                      — display metadata per guard
 *   guardOf(actor)              — read actor's current guard (safe default)
 *   guardAttackMod(actor)       — flat attack mod from current guard
 *   guardDefenseMod(actor,
 *                   weapon,
 *                   locationKey) — defense mod folding warded location
 *
 * Hit-location adjacency table used by Raise Shield (L4) lives here too
 * since guard-system + shield-system share the same anatomy. Kept tight
 * (head ↔ torso; torso ↔ all; limbs only adjacent to torso) per the
 * design pass.
 *
 * Engine integration: callers add the returned mod to their existing
 * combatMods aggregation. When Combat Extended is OFF, every helper
 * returns 0 / "balanced" — call sites can stay unconditional.
 */

import { isCESubsystemEnabled } from "../../api/homebrew.mjs";

/* Defensive wrapper — the API helper reads game.settings, which throws
 * in a node test env (no `game` global). All guard helpers funnel through
 * here so the test surface doesn't have to stub Foundry. Gated on the
 * per-subsystem `guards` toggle so a GM can disable guard stances alone
 * without giving up the rest of CE. */
function ceOn() {
    try { return isCESubsystemEnabled("guards"); }
    catch (_) { return false; }
}

export const GUARD_KEYS = Object.freeze(["balanced", "warding", "closed", "fools"]);

export const GUARDS = Object.freeze({
    balanced: Object.freeze({
        key:        "balanced",
        labelKey:   "WITCHER.CombatExtended.Guard.Balanced",
        icon:       "fa-solid fa-shield",
        attackMod:  0, defenseMod: 0
    }),
    warding: Object.freeze({
        key:        "warding",
        labelKey:   "WITCHER.CombatExtended.Guard.Warding",
        icon:       "fa-solid fa-bullseye",
        attackMod:  0, defenseMod: 0,
        wardedBonus:   2,    // parry/block bonus at the warded location
        unwardedPenalty: -1  // parry/block penalty everywhere else
    }),
    closed: Object.freeze({
        key:        "closed",
        labelKey:   "WITCHER.CombatExtended.Guard.Closed",
        icon:       "fa-solid fa-shield-halved",
        attackMod:  -2, defenseMod: 2
    }),
    fools: Object.freeze({
        key:        "fools",
        labelKey:   "WITCHER.CombatExtended.Guard.Fools",
        icon:       "fa-solid fa-skull",
        attackMod:  2, defenseMod: -2
    })
});

/* Hit-location adjacency. Used by Raise Shield (L4) to constrain the
 * coverage picker to a contiguous subset of CV size; declared here so
 * guard-warded interactions (e.g. future Warding/Shield combo rules)
 * can read the same anatomy. */
export const HIT_LOCATION_ADJACENCY = Object.freeze({
    head:     Object.freeze(["torso"]),
    torso:    Object.freeze(["head", "leftArm", "rightArm", "leftLeg", "rightLeg"]),
    leftArm:  Object.freeze(["torso"]),
    rightArm: Object.freeze(["torso"]),
    leftLeg:  Object.freeze(["torso"]),
    rightLeg: Object.freeze(["torso"])
});

/* Given a seed location + a target size N, list every contiguous subset
 * of size N that includes the seed. Used by the Raise Shield picker —
 * surfaced here so the same anatomy seeds the test fixtures. */
export function contiguousSets(seed, size) {
    if (!HIT_LOCATION_ADJACENCY[seed]) return [];
    const out = [];
    const visit = (set) => {
        if (set.size === size) { out.push([...set]); return; }
        const frontier = new Set();
        for (const loc of set) for (const adj of HIT_LOCATION_ADJACENCY[loc] ?? []) {
            if (!set.has(adj)) frontier.add(adj);
        }
        for (const next of frontier) {
            const nextSet = new Set(set); nextSet.add(next);
            visit(nextSet);
        }
    };
    visit(new Set([seed]));
    // Dedup (different traversal orders can yield the same set).
    const seen = new Set();
    const uniq = [];
    for (const s of out) {
        const k = [...s].sort().join("|");
        if (seen.has(k)) continue;
        seen.add(k); uniq.push(s);
    }
    return uniq;
}

/* Read an actor's current guard (safe default). Returns the GUARDS entry,
 * NOT the key, so callers can dot-into mods directly. When CE is OFF
 * the result is always Balanced. */
export function guardOf(actor) {
    if (!ceOn()) return GUARDS.balanced;
    const key = String(actor?.system?.guard?.current ?? "balanced");
    return GUARDS[key] ?? GUARDS.balanced;
}

/* Flat to-hit modifier from the current guard. Closed → −2, Fool's → +2,
 * others → 0. Returned as an additive integer that the attack pipeline
 * folds into `chips` next to other situational mods. */
export function guardAttackMod(actor) {
    return Number(guardOf(actor).attackMod) || 0;
}

/* Defense modifier from the current guard, folding the warded-location
 * branch. `weapon` is the wielded weapon/shield (for Warding's per-weapon
 * location pick); `locationKey` is the attack's hit location (so Warding
 * can branch). Closed → +2 everywhere; Fool's → −2 everywhere; Warding →
 * +2 at warded loc, −1 elsewhere; Balanced → 0. */
export function guardDefenseMod(actor, weapon, locationKey) {
    const g = guardOf(actor);
    if (g.key === "closed") return  2;
    if (g.key === "fools")  return -2;
    if (g.key === "warding") {
        const warded = actor?.system?.guard?.wardingLocations?.[weapon?.id];
        if (!warded || !locationKey) return 0;
        return warded === locationKey ? Number(g.wardedBonus) || 0
                                      : Number(g.unwardedPenalty) || 0;
    }
    return 0;
}

/* True if the actor still has any action-economy slot to spend on a
 * Special Action (Change Guards / Raise Shield). Special Actions are
 * multi-use per round, capped by the slots available — when all three
 * (movement / action / extra) are spent, this returns false. Out of
 * combat returns true (Special Actions are free outside a fight). */
export function canSwitchGuardThisRound(actor) {
    if (!ceOn()) return false;
    if (!actor?.system?.guard) return false;
    if (!actor._inActiveCombat) return true;
    const r = actor.system?.combatRound ?? {};
    const movementAvailable = !r.movementUsed && !((Number(r.movementMeters) || 0) > 0);
    return movementAvailable || !r.actionUsed || !r.extraUsed;
}
