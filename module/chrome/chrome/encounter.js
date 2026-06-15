/**
 * Encounter mode toggler.
 *
 * The dock's `body.in-encounter` ("war mode") flag is ON whenever EITHER:
 *   • the assigned actor is a combatant in an active started Combat, OR
 *   • the bound actor has any weapon currently equipped.
 *
 * The combat half is scoped to the ASSIGNED ACTOR's participation — the
 * same `isActorInActiveCombat` predicate the action-economy uses — NOT a
 * blanket "any world Combat is started" check.  A stray started Combat the
 * actor isn't part of (a Fast Draw remnant, a GM's combat in another scene)
 * must NOT pin war mode on; otherwise the dock gets stuck in "infinite war
 * mode" with nothing in the player's own tracker.
 *
 * That means drawing a weapon puts the dock into war mode even with no
 * encounter running, and sheathing all weapons returns it to peace —
 * UNLESS the actor is in an active encounter, in which case it stays in war
 * mode until that encounter ends.  Both conditions must clear before we
 * fall back to peace.
 *
 * Leaving war mode is COORDINATED: we add a transient `wou-combat-leaving`
 * class to body for ~350ms before removing `.in-encounter`.  CSS uses that
 * window to fade every combat-mode element to opacity 0; after the timer
 * fires, the actual `in-encounter` class drops and the elements go
 * `display: none` cleanly with no snap.
 */

import { getAssignedActor, isActorInActiveCombat, VIEWER_OVERRIDE_HOOK } from "../lib/actor.js";

const FADE_MS = 350;
let _fadeTimer = null;

function assignedActorInCombat() {
  return isActorInActiveCombat(getAssignedActor());
}

function assignedActorHasEquippedWeapon() {
  const actor = getAssignedActor();
  if (!actor) return false;
  return actor.items?.some?.(i => i.type === "weapon" && i.system?.equipped) ?? false;
}

export function refreshEncounterState() {
  const shouldBeOn = assignedActorInCombat() || assignedActorHasEquippedWeapon();
  const body = document.body;
  const wasIn = body.classList.contains("in-encounter");

  if (shouldBeOn && !wasIn) {
    if (_fadeTimer) { clearTimeout(_fadeTimer); _fadeTimer = null; }
    body.classList.remove("wou-combat-leaving");
    body.classList.add("in-encounter");
  } else if (!shouldBeOn && wasIn) {
    body.classList.add("wou-combat-leaving");
    if (_fadeTimer) clearTimeout(_fadeTimer);
    _fadeTimer = setTimeout(() => {
      body.classList.remove("in-encounter");
      body.classList.remove("wou-combat-leaving");
      _fadeTimer = null;
    }, FADE_MS);
  } else if (shouldBeOn && wasIn && _fadeTimer) {
    // Re-entered (e.g. drew a weapon mid-fade) — cancel the pending drop.
    clearTimeout(_fadeTimer);
    _fadeTimer = null;
    body.classList.remove("wou-combat-leaving");
  }
}

export function registerEncounterHooks() {
  Hooks.on("createCombat",     refreshEncounterState);
  Hooks.on("deleteCombat",     refreshEncounterState);
  Hooks.on("updateCombat",     refreshEncounterState);
  Hooks.on("combatStart",      refreshEncounterState);
  Hooks.on("combatTurn",       refreshEncounterState);
  Hooks.on("combatRound",      refreshEncounterState);
  Hooks.on("ready",            refreshEncounterState);

  // War mode now keys off the assigned actor's combatant membership, so the
  // actor joining/leaving an existing started combat must re-evaluate it.
  const combatantIsAssigned = (cb) => {
    const aid = getAssignedActor()?.id;
    return !!aid && ((cb?.actorId ?? cb?.actor?.id) === aid);
  };
  Hooks.on("createCombatant", (cb) => { if (combatantIsAssigned(cb)) refreshEncounterState(); });
  Hooks.on("deleteCombatant", (cb) => { if (combatantIsAssigned(cb)) refreshEncounterState(); });

  // Equip/unequip and assigned-actor swaps also drive war mode.
  const ownsItem = (item) => {
    const aid = getAssignedActor()?.id;
    return !!aid && item?.parent?.id === aid;
  };
  Hooks.on("createItem",       (item) => { if (ownsItem(item) && item.type === "weapon") refreshEncounterState(); });
  Hooks.on("updateItem",       (item) => { if (ownsItem(item) && item.type === "weapon") refreshEncounterState(); });
  Hooks.on("deleteItem",       (item) => { if (ownsItem(item) && item.type === "weapon") refreshEncounterState(); });
  Hooks.on("updateUser",       (user) => { if (user.id === game.user.id) refreshEncounterState(); });
  Hooks.on(VIEWER_OVERRIDE_HOOK, refreshEncounterState);
}
