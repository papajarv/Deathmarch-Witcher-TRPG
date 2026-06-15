/**
 * Critical-wound status effects.
 *
 * A critical wound declares the status ids it inflicts (`system.statuses`,
 * e.g. "bleed"). This policy keeps those statuses on the bearer in sync with
 * the wound's state and the bearer's immunities:
 *
 *   • applied while the wound is UNSTABILIZED (the active-harm state);
 *   • cleared once the wound is stabilized / treated (First Aid stops the bleed);
 *   • suppressed while the bearer is immune (e.g. a potion granting bleed
 *     immunity, via statusEngine's immunity set) — and RESUMED automatically
 *     the moment that immunity lapses, as long as the wound is still untreated.
 *
 * The wound-sourced status effects are dedicated ActiveEffects flagged
 * `woundStatus` so the reconciler owns only its own effects and never touches
 * statuses applied by other sources (combat bleed, etc.). GM-gated so only one
 * client writes. The existing policy/status-immunity.mjs already strips/cures
 * immune statuses on grant; this policy adds the resume-on-lapse half.
 */

import { isImmuneToStatus } from "../mechanics/statusEngine.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const FLAG = "woundStatus";

/* Only one client writes: the active GM, else the owner if no GM is online. */
function iShouldWrite(actor) {
    const gm = game.users?.activeGM;
    return gm ? gm.isSelf : !!actor?.isOwner;
}

/* Resolve the bearing Actor for an embedded document (effect or item). */
function actorOf(doc) {
    const p = doc?.parent;
    if (p instanceof Actor) return p;
    if (p?.parent instanceof Actor) return p.parent;
    return null;
}

/* The (wound, status) pairs the actor's UNSTABILIZED wounds should currently
 * inflict, minus any it is immune to. One pair per wound per status, so two
 * bleeding wounds yield two distinct bleed instances (they stack — see
 * applyStatusDots, which ticks per instance). */
function wantedPairs(actor) {
    const pairs = [];
    for (const it of actor.items ?? []) {
        if (it.type !== "criticalWound") continue;
        if (it.system?.state !== "unstabilized") continue;
        for (const s of it.system?.statuses ?? []) {
            if (s && !isImmuneToStatus(actor, String(s))) pairs.push({ woundId: it.id, woundName: it.name, status: String(s) });
        }
    }
    return pairs;
}

const keyOf = (woundId, status) => `${woundId}|${status}`;

/* Reentrancy guard — reconcile creates/deletes effects, which fire the same
 * effect hooks that call us. Per-actor lock keeps that from storming (the work
 * itself is idempotent, but the lock avoids redundant passes mid-operation). */
const _busy = new Set();

/* Bring the bearer's wound-sourced status effects in line with wantedPairs —
 * one ActiveEffect per (wound, status). Idempotent: a no-op when in sync. If
 * something else strips a wound status while the wound is still untreated and
 * the bearer isn't immune, this re-asserts it (so a First-Aid end-check pass on
 * an independent bleed can't accidentally end the wound's bleed). */
export async function reconcileWoundStatuses(actor) {
    if (!(actor instanceof Actor) || !iShouldWrite(actor)) return;
    if (_busy.has(actor.id)) return;
    _busy.add(actor.id);
    try {
        const want     = wantedPairs(actor);
        const wantKeys = new Set(want.map((p) => keyOf(p.woundId, p.status)));
        const mine     = (actor.effects ?? []).filter((e) => e.getFlag?.(SYSTEM_ID, FLAG));
        const haveKeys = new Map(mine.map((e) => [keyOf(e.getFlag(SYSTEM_ID, "woundId"), e.getFlag(SYSTEM_ID, FLAG)), e]));

        const toDelete = [...haveKeys].filter(([k]) => !wantKeys.has(k)).map(([, e]) => e.id);
        const toCreate = want.filter((p) => !haveKeys.has(keyOf(p.woundId, p.status))).map((p) => {
            const def  = (CONFIG.statusEffects ?? []).find((x) => x.id === p.status) ?? {};
            const base = game.i18n?.localize?.(def.name) ?? def.name ?? p.status;
            return {
                // Name + description flag the source so it reads as wound-borne
                // and not a stray status (and so it's clearly not First-Aid-able).
                name:        `${base} — ${p.woundName}`,
                img:         def.img ?? "icons/svg/aura.svg",
                description: `From the critical wound “${p.woundName}.” Lifts only when the wound is stabilized/treated — not by an end-check.`,
                statuses:    [p.status],
                flags:       { [SYSTEM_ID]: { [FLAG]: p.status, woundId: p.woundId } }
            };
        });

        if (toDelete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete);
        if (toCreate.length) await actor.createEmbeddedDocuments("ActiveEffect", toCreate);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | wound-status reconcile failed for "${actor.name}"`, err);
    } finally {
        _busy.delete(actor.id);
    }
}

export function registerWoundStatuses() {
    // Wound added / removed / state changed (stabilize → clears).
    Hooks.on("createItem", (it) => {
        if (it.type === "criticalWound" && it.parent instanceof Actor) reconcileWoundStatuses(it.parent);
    });
    Hooks.on("deleteItem", (it) => {
        if (it.type === "criticalWound" && it.parent instanceof Actor) reconcileWoundStatuses(it.parent);
    });
    Hooks.on("updateItem", (it, ch) => {
        if (it.type === "criticalWound" && it.parent instanceof Actor
            && foundry.utils.hasProperty(ch, "system.state")) reconcileWoundStatuses(it.parent);
    });

    // Any effect change can shift the immunity set (a potion granting/losing
    // bleed immunity, an immunity AE enabled/disabled/expired) or strip a wound
    // status (an end-check pass on an independent bleed) — so re-evaluate to
    // suppress, resume, or re-assert. The _busy lock guards against recursion.
    const onEffect = (e) => reconcileWoundStatuses(actorOf(e));
    Hooks.on("createActiveEffect", onEffect);
    Hooks.on("deleteActiveEffect", onEffect);
    Hooks.on("updateActiveEffect", onEffect);

    // A monster's GM-set statusImmunities[] is an actor update.
    Hooks.on("updateActor", (actor, ch) => {
        if (foundry.utils.hasProperty(ch, "system.combat.statusImmunities")) reconcileWoundStatuses(actor);
    });

    // Initial sweep for actors already carrying wounds when the world loads.
    Hooks.once("ready", () => {
        for (const a of game.actors ?? []) {
            if ((a.items ?? []).some((i) => i.type === "criticalWound")) reconcileWoundStatuses(a);
        }
    });
}
