/**
 * Consumable items — "use it, it's spent, its effects land on the holder."
 *
 * A per-item `system.consumable` toggle (surfaced on alchemical potions,
 * decoctions and substances; see WitcherAlchemicalSheet) turns an item into a
 * one-shot. Using it (hotbar slot or the right-click "Use" entry) spends a
 * single dose — decrement quantity, delete at 0 — and applies the item's own
 * ActiveEffects to the holding actor:
 *
 *   - effects WITH a duration are COPIED onto the actor as independent effects
 *     (transfer:false, no link back to the now-spent item) so they linger and
 *     expire on their own via the tick engine's sweepExpiredEffects;
 *   - effects WITHOUT a duration are treated as instant: their heal/damage
 *     pulses fire once and nothing is left behind. (A pure buff therefore needs
 *     a duration to do anything — there's no meaning to a one-shot stat buff.)
 *
 * Potions and decoctions also add their Toxicity to the holder's pool on use
 * (Core p.84) — the schema field exists for exactly this moment.
 *
 * GM-or-owner runs the updates; Foundry's permission layer gates the rest.
 */

import { MODULE_ID } from "../setup/settings.js";
import { applyInstantEffectActions } from "./tick-effects.js";
import { registerItemAction } from "../chrome/context-menu-item.js";
import { isActorInActiveCombat } from "../lib/actor.js";
import { getRail } from "../lib/container.js";

/* In combat you can only reach gear stowed in a container EQUIPPED on your
 * rail — true if `item` sits in one of `actor`'s railed containers. */
function inEquippedContainer(actor, item) {
  const railed = new Set(getRail(actor).assignments.filter(Boolean));
  for (const c of actor.items) {
    if (c.type !== "container" || !railed.has(c.id)) continue;
    const content = c.system?.content ?? [];
    if (content.includes(item.uuid) || content.includes(item.id)) return true;
  }
  return false;
}

const CONSUMABLE_ALCHEMY_TYPES = new Set(["potion", "decoction", "item"]);

/* True if this item is a flagged-consumable of a supported type. */
export function isConsumable(item) {
  if (!item || item.type !== "alchemical") return false;
  if (!CONSUMABLE_ALCHEMY_TYPES.has(item.system?.type)) return false;
  return !!item.system?.consumable;
}

/* Oils coat a weapon, not the wielder — their ActiveEffects describe what the
 * coated blade does to a target, so they must never auto-apply to the actor
 * merely carrying the oil. (The applied-oil framework copies them onto the
 * weapon instead; see the oil notes in docs/roadmap.md.) */
export function isOil(item) {
  return item?.type === "alchemical" && item.system?.type === "oil";
}

/* Effects on these items stay dormant on the carrier: consumables apply on
 * use, oils apply to a weapon. Everything else transfers as Foundry defaults. */
function effectsStayDormant(item) {
  return isConsumable(item) || isOil(item);
}

/* The dice/number formula an effect rolls for its duration each consume, or "". */
function durationFormulaOf(effect) {
  const f = effect?.getFlag?.(MODULE_ID, "durationFormula") ?? effect?.flags?.[MODULE_ID]?.durationFormula;
  return f != null ? String(f).trim() : "";
}

/* An effect lingers (vs. fires once) when it carries a real Foundry duration.
 * v14 stores duration as {value, units} — the old {seconds, rounds, turns}
 * keys are deprecation shims that only exist on SOURCE data, not on a prepared
 * live effect (where they read undefined/null), so we must read value/units. A
 * dice-code duration (durationFormula flag) also lingers — its value is rolled
 * fresh at consume. */
function effectHasDuration(effect) {
  if (Number(effect?.duration?.value) > 0) return true;
  return durationFormulaOf(effect) !== "";
}

/* Roll a dice-code duration to a concrete count. Round DOWN, floor at 1, so a
 * "1d6/2" never yields a zero-length (do-nothing) duration. Null on a bad
 * formula. */
async function rollDurationValue(formula) {
  const f = String(formula ?? "").trim();
  if (!f) return null;
  try {
    const r = await new Roll(f).evaluate();
    return Math.max(1, Math.floor(Number(r.total) || 0));
  } catch (err) {
    console.warn(`${MODULE_ID} | bad duration formula "${f}"`, err);
    return null;
  }
}

/**
 * Use one dose of a consumable. Returns true if it handled the item, false if
 * the item wasn't a consumable (so callers can fall through to other routing).
 */
export async function consumeItem(item, actor = null) {
  if (!isConsumable(item)) return false;
  actor = actor ?? (item.parent instanceof Actor ? item.parent : null);
  if (!actor) {
    ui.notifications?.warn(`${item.name} must be carried by a character to be used.`);
    return true;
  }

  /* In combat (Core p.151) you can only reach a consumable that's stowed in one
   * of your EQUIPPED (railed) containers, and drinking it spends an action.
   * Out of combat there's no restriction and no cost. */
  if (isActorInActiveCombat(actor)) {
    if (!inEquippedContainer(actor, item)) {
      ui.notifications?.warn(`In combat, ${actor.name} can only use a consumable stowed in an equipped container — put ${item.name} in a bag on the rail first.`);
      return true;
    }
    if (actor.system?.combatRound) {                       // characters track the budget
      const slot = await actor.spendActionSlot?.(`Drink: ${item.name}`);
      if (!slot) return true;                              // no action left (spendActionSlot warns)
    }
  }

  /* Split the item's effects: duration → copy onto the actor; no duration →
   * fire its instant pulses once. Skip disabled effects either way. */
  const lingering = [];
  for (const effect of item.effects) {
    if (effect.disabled) continue;
    if (effectHasDuration(effect)) {
      const data = effect.toObject();
      delete data._id;
      data.transfer = false;
      data.disabled = false;
      data.origin   = actor.uuid;
      // Roll a dice-code duration fresh (e.g. "1d6/2") so the applied copy gets
      // a concrete, random length each consume; keep the authored units.
      const formula = durationFormulaOf(effect);
      if (formula) {
        const rolled = await rollDurationValue(formula);
        if (rolled != null) data.duration = { ...(data.duration ?? {}), value: rolled };
      }
      lingering.push(data);
    } else {
      await applyInstantEffectActions(actor, effect);
    }
  }
  /* Toxicity contribution (potions / decoctions, Core p.84). Stamp the amount
   * on the lingering effect; the pool is then RECOMPUTED from the set of active
   * toxic effects (recomputeConsumedToxicity), so the toxicity tracks that
   * effect's life and clears the instant it ends. An instant potion (no
   * lingering effect) carries no lasting toxicity — there's nothing for it to
   * be tied to (matches RAW: toxicity lasts as long as the potion does). */
  const tox = Number(item.system?.toxicity) || 0;
  if (tox > 0 && lingering.length) {
    foundry.utils.setProperty(lingering[0], `flags.${MODULE_ID}.consumedToxicity`, tox);
  }

  if (lingering.length) {
    await actor.createEmbeddedDocuments("ActiveEffect", lingering);
  }

  /* Spend the dose: decrement, delete the stack at 0. */
  const qty = Number(item.system?.quantity) || 0;
  if (qty > 1) await item.update({ "system.quantity": qty - 1 });
  else         await item.delete();

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    style:   CONST.CHAT_MESSAGE_STYLES.OTHER,
    content: `<div style="border-left:3px solid #6a8;padding:4px 8px;margin:2px 0">
        <b>${actor.name}</b> uses <b>${item.name}</b>${tox > 0 ? ` <small style="opacity:0.7">(+${tox} toxicity)</small>` : ""}.
      </div>`
  });
  return true;
}

/* Right-click "Consume" entry as a unified item action — appears on the actor
 * sheet and the chrome inventory overlay (where the item is an owned dose to
 * spend). Excluded from the Foundry Items sidebar: a world template has no
 * dose to spend, so consuming there doesn't make sense. */
function registerConsumeAction() {
  registerItemAction({
    name: "Consume",
    icon: '<i class="fa-solid fa-flask"></i>',
    /* Owned-dose action: only on the actor sheet and inventory overlay, never
     * the world Items sidebar — consuming spends a held dose. */
    surfaces: { sidebar: false },
    condition: (item) => isConsumable(item),
    callback:  (item, actor) => {
      if (!actor) {
        ui.notifications?.warn(`Assign a character (in your User Configuration) to consume ${item.name}.`);
        return;
      }
      consumeItem(item, actor);
    }
  });
}

/* No-chrome fallback only: the system's base actor sheet (base.mjs) builds its
 * own minimal context menu when the chrome layer isn't replacing it. */
export function buildConsumeEntry(owner) {
  const ctx = owner ?? this;
  return {
    name: "Consume",
    icon: '<i class="fa-solid fa-flask"></i>',
    condition: (itemHtml) => isConsumable(ctx?.actor?.items?.get(itemHtml?.dataset?.itemId)),
    callback:  (itemHtml) => {
      const item = ctx?.actor?.items?.get(itemHtml?.dataset?.itemId);
      if (item) consumeItem(item, ctx?.actor);
    }
  };
}

/* A consumable's effects must stay dormant while the item is merely carried —
 * they apply only when a dose is used (consumeItem copies them onto the actor,
 * where they linger and expire on their own duration). Foundry item effects
 * default to transfer:true (auto-apply to the carrier), which is exactly what
 * we DON'T want here. So we hold the invariant "consumable ⟹ every effect is
 * transfer:false", and restore transfer:true if the item stops being one. */
async function syncEffectTransfer(item) {
  if (item?.type !== "alchemical" || !item.isOwner) return;
  const desired = !effectsStayDormant(item);   // consumable/oil → must NOT transfer
  const updates = [];
  for (const e of item.effects) {
    if (e.transfer !== desired) updates.push({ _id: e.id, transfer: desired });
  }
  if (updates.length) await item.updateEmbeddedDocuments("ActiveEffect", updates);
}

/* A consumed potion's toxicity is tied to the LIFE of its lingering effect,
 * not just its duration timer: the effect carries its toxicity in
 * flags.<MODULE_ID>.consumedToxicity, and the actor's pool is re-derived from
 * the sum of those flags over all active effects whenever one changes — so the
 * toxicity is present exactly while the effect is, and clears when it ends
 * (expired, deleted, or toggled off). No incremental latch to drift. */
function consumedToxAmount(effect) {
  return Number(effect?.getFlag?.(MODULE_ID, "consumedToxicity")) || 0;
}

/* Single-writer gate: the active GM if one is connected, else the carrying
 * actor's owner — so toxicity still reconciles in a GM-less session. */
function iShouldWriteToxicity(actor) {
  const gm = game.users?.activeGM;
  return gm ? gm.isSelf : !!actor?.isOwner;
}

/* Authoritative recompute: a witcher's toxicity pool equals the summed
 * toxicity of every ACTIVE potion/decoction effect they carry. Setting the
 * pool from this source on each effect change is drift-proof — there's no
 * incremental add/subtract to race or orphan, so the pool can never get
 * "stuck" above 0 after the effects clear. (Replaces the old latch-based
 * apply/reclaim, which raced when several effects ended at once — e.g. White
 * Honey deleting three potions in one batch, or a multi-effect expiry.) */
async function recomputeConsumedToxicity(actor) {
  if (!actor?.system?.stats?.toxicity) return;
  if (!iShouldWriteToxicity(actor)) return;
  let sum = 0;
  for (const e of actor.effects) {
    if (e.disabled) continue;
    sum += consumedToxAmount(e);
  }
  const cur = Number(actor.system.stats.toxicity.value) || 0;
  if (cur !== sum) await actor.update({ "system.stats.toxicity.value": sum });
}

/* Recompute the carrier's pool whenever a toxicity-bearing effect is added,
 * removed, or enabled/disabled. Cheap and idempotent. */
function onToxicityEffectChange(effect) {
  if (consumedToxAmount(effect) <= 0) return;
  const actor = effect.parent instanceof Actor ? effect.parent : null;
  if (actor) recomputeConsumedToxicity(actor);
}

let _installed = false;
export function installConsumeFeature() {
  if (_installed) return;
  _installed = true;

  /* New effects on a consumable/oil item are born dormant. */
  Hooks.on("preCreateActiveEffect", (effect) => {
    const parent = effect.parent;
    if (parent instanceof Item && effectsStayDormant(parent) && effect.transfer !== false) {
      effect.updateSource({ transfer: false });
    }
  });

  /* Flipping the consumable flag — or the alchemical sub-type, which can turn
   * an item into (or out of) an oil — re-reconciles its effects' transfer. Only
   * the user who made the change writes, to avoid every client racing. */
  Hooks.on("updateItem", (item, changes, _options, userId) => {
    if (game.user.id !== userId) return;
    if (!foundry.utils.hasProperty(changes, "system.consumable") &&
        !foundry.utils.hasProperty(changes, "system.type")) return;
    syncEffectTransfer(item);
  });

  /* Keep the toxicity pool in sync with the actor's active toxic effects: any
   * potion/decoction effect landing, expiring, being deleted, or toggled
   * enabled/disabled re-derives the whole pool from what's currently active. */
  Hooks.on("createActiveEffect", onToxicityEffectChange);
  Hooks.on("updateActiveEffect", onToxicityEffectChange);
  Hooks.on("deleteActiveEffect", onToxicityEffectChange);

  /* Consume is a unified item action — one registration lights it up on the
   * actor sheet, the chrome inventory overlay, and the Items sidebar. */
  registerConsumeAction();

  Hooks.once("ready", () => {
    /* One-time reconciliation of existing worlds: fix any consumable item whose
     * effects predate this invariant (GM writes once; no-op thereafter). */
    if (game.user?.isGM) {
      const all = [...(game.items ?? [])];
      for (const actor of game.actors ?? []) all.push(...actor.items);
      for (const item of all) syncEffectTransfer(item).catch(() => {});
    }
  });
}
