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
import { t } from "../chrome/lib/i18n.js";

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
/** Internal: compute the hold penalty for `actor` rolling against `targetActor`,
 *  returning both the total mod and which components fired (for the chip label).
 *
 *  Components (grapplee side has NO carve-out; holder side is waived vs the
 *  held foe). Grapple and Pin are LAYERED, so a pinned grapplee carries BOTH
 *  and the penalties STACK:
 *   - "grappled" : the GRAPPLEE's -2 (RAW Core p.161 — RAW AND CE, always).
 *   - "pinned"   : the GRAPPLEE's extra -3 (on top of grappled -2 → -5 total).
 *   - "grappling": the GRAPPLER's -2 (CE only), except vs the foe they hold.
 *   - "pinning"  : the PINNER's extra -3 (CE only), except vs the foe they hold.
 *                  Stacks with "grappling" (a pinner is still grappling → -5).
 *
 *  The grapplee penalties live HERE (not in a static status clause) so they sit
 *  in the same roll-time computation as the holder carve-out. */
function _holdDetail(actor, targetActor = null) {
    const out = { mod: 0, parts: [] };
    if (!actor) return out;
    const actorUuid = normalizedActorUuid(actor);
    if (!actorUuid) return out;
    /* `targetActor` may be an Actor OR a (normalized) uuid string — the defense
     * path passes the attacker's uuid to avoid a fragile fromUuidSync. */
    let targetUuid = null;
    if (targetActor) {
        if (typeof targetActor === "string") {
            try {
                const resolved = fromUuidSync?.(targetActor);
                targetUuid = resolved ? normalizedActorUuid(resolved) : targetActor;
            } catch (_) { targetUuid = targetActor; }
        } else {
            targetUuid = normalizedActorUuid(targetActor);
        }
    }
    const pairs = getHoldsSync(actorUuid);
    if (pairs.length === 0) return out;

    /* GRAPPLEE penalties (RAW Core p.161): while held you take -2 to ALL
     * physical actions — ALWAYS, with NO carve-out (being held hinders you
     * against everyone, including your own grappler). A PIN layers on top for
     * an extra -3, and the two STACK: a pinned+grappled target is at -5.
     * Applies in RAW and CE alike. */
    if (pairs.some(p => p.kind === "grappled" && p.targetUuid === actorUuid)) {
        out.mod -= 2; out.parts.push("grappled");
    }
    if (pairs.some(p => p.kind === "pinned" && p.targetUuid === actorUuid)) {
        out.mod -= 3; out.parts.push("pinned");
    }

    /* GRAPPLER / PINNER penalties (CE only), each WAIVED against the foe they
     * hold — you are NOT hindered against the person you're wrestling, only
     * against everyone else. This is the ONLY carve-out. */
    let ceOn = false;
    try { ceOn = isHomebrewEnabled("extendedCombat") === true; }
    catch (_) { ceOn = false; }
    if (ceOn) {
        const holderPenaltyApplies = (kind) => pairs.some(p =>
            p.holderUuid === actorUuid && p.kind === kind &&
            (!targetUuid || p.targetUuid !== targetUuid));
        if (holderPenaltyApplies("grappled")) { out.mod -= 2; out.parts.push("grappling"); }
        if (holderPenaltyApplies("pinned"))   { out.mod -= 3; out.parts.push("pinning"); }
    }
    return out;
}

export function contextualPhysicalMod(actor, targetActor = null) {
    return _holdDetail(actor, targetActor).mod;
}

/** GRAPPLEE-only penalty, for roll sites that should carry the grappled -2 but
 *  NOT the grappler/pinner penalties (generic skill checks — the holder's own
 *  penalty has never applied to those). Honors the same CE carve-out vs the
 *  grappler. */
export function grappleePhysicalMod(actor, targetActor = null) {
    const parts = _holdDetail(actor, targetActor).parts;
    let mod = 0;
    if (parts.includes("grappled")) mod -= 2;   // held: -2
    if (parts.includes("pinned"))   mod -= 3;   // pinned layers +(-3) → -5 total
    return mod;
}

/** Target-restriction check for a holder acting on someone.
 *
 *  Returns a reason string when `actor` is NOT allowed to act on `targetActor`
 *  because of a hold `actor` maintains, else null (allowed):
 *   - PINNER: while pinning someone you are committed to them — you can act
 *     ONLY against the foe(s) you pin. Any other target is refused.
 *
 *  (A plain GRAPPLER is NOT locked this way — they can still make normal
 *  attacks on others; their GRAPPLING actions are separately gated to the
 *  grapplee in the dialogs.) CE-only; returns null under RAW. */
export function holdTargetBlockReason(actor, targetActor = null) {
    if (!actor) return null;
    try { if (isHomebrewEnabled("extendedCombat") !== true) return null; }
    catch (_) { return null; }
    const actorUuid = normalizedActorUuid(actor);
    if (!actorUuid) return null;
    const pairs = getHoldsSync(actorUuid);
    const pinnedVictims = pairs
        .filter(p => p.kind === "pinned" && p.holderUuid === actorUuid)
        .map(p => p.targetUuid);
    if (pinnedVictims.length === 0) return null;   // not pinning anyone
    const tUuid = targetActor ? normalizedActorUuid(targetActor) : null;
    if (tUuid && pinnedVictims.includes(tUuid)) return null;   // acting on the pinned foe — fine
    return "pinning";   // locked to the pinned foe
}

/** Registry-based (representation-proof) check: is `actor` currently PINNED
 *  (the target of a pinned pair)? Reads the hold registry rather than
 *  `actor.statuses`, so it's reliable even when the pinned status lives on an
 *  unlinked token's synthetic actor. */
export function isPinned(actor) {
    const u = actor ? normalizedActorUuid(actor) : null;
    if (!u) return false;
    return getHoldsSync(u).some(p => p.kind === "pinned" && p.targetUuid === u);
}

/** Registry-based: is `pinner` the PINNER (holder of a `pinned` pair) of
 *  `target`? Gate for Choke — you can only choke a foe you have pinned. */
export function pinsTarget(pinner, target) {
    const pu = pinner ? normalizedActorUuid(pinner) : null;
    const tu = target ? normalizedActorUuid(target) : null;
    if (!pu || !tu) return false;
    return getHoldsSync(pu).some(p =>
        p.kind === "pinned" && p.holderUuid === pu && p.targetUuid === tu);
}

/** Registry-based: is `actor` in ANY grapple-family hold — as holder OR target
 *  (grappled / pinned / chokeheld)? Both the grappler and the grapplee are
 *  movement-locked by the hold, so neither can Relocate as a defense. Clinch is
 *  excluded (it's the softer CE variant with its own movement rules). */
export function isInGrappleFamily(actor) {
    const u = actor ? normalizedActorUuid(actor) : null;
    if (!u) return false;
    return getHoldsSync(u).some(p =>
        ["grappled", "pinned", "chokeheld"].includes(p.kind)
        && (p.holderUuid === u || p.targetUuid === u));
}

/** Registry-based: is `actor` in a PIN — as the pinner (holder) OR the pinned
 *  (target)? Both parties in a pin are locked down and may only BLOCK on
 *  defense (shield / arm) — no parry, dodge, or relocate. */
export function isInPin(actor) {
    const u = actor ? normalizedActorUuid(actor) : null;
    if (!u) return false;
    return getHoldsSync(u).some(p => p.kind === "pinned"
        && (p.holderUuid === u || p.targetUuid === u));
}

/** Registry-based: is `foe` a HOLDER of a grapple/pin/choke on `actor`? Used to
 *  let a held actor act only against the foe holding them (Escape / Reverse). */
export function isHeldByFoe(actor, foe) {
    const u = actor ? normalizedActorUuid(actor) : null;
    const f = foe ? normalizedActorUuid(foe) : null;
    if (!u || !f) return false;
    return getHoldsSync(u).some(p =>
        ["grappled", "pinned", "chokeheld"].includes(p.kind)
        && p.targetUuid === u && p.holderUuid === f);
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
    const d = _holdDetail(actor, targetActor);
    if (!d.mod) return null;
    /* Label from the components that actually fired, so the chip names WHY the
     * roll took the hit (Grappled = you're held; Grappling / Pinning = you're
     * the one holding). */
    const NAME = {
        grappled:  t("WITCHER.Mech.HoldModifiers.Text.Grappled",  "Grappled"),
        pinned:    t("WITCHER.Mech.HoldModifiers.Text.Pinned",    "Pinned"),
        grappling: t("WITCHER.Mech.HoldModifiers.Text.Grappling", "Grappling"),
        pinning:   t("WITCHER.Mech.HoldModifiers.Text.Pinning",   "Pinning")
    };
    const label = d.parts.map(p => NAME[p] ?? p).join(" + ");
    return { label, value: `${d.mod}` };
}
