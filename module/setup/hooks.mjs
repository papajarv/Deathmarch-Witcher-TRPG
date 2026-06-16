/**
 * registerHooks — wires recurring Foundry runtime hooks during `setup`.
 *
 * Each handler lives in its own module under `module/policy/` or
 * `module/mechanics/`. This file is the wiring sheet — keep it thin so
 * adding a new policy is just two lines (import + Hooks.on).
 */

import { onPreUpdateActor, onUpdateActor as onStressUpdateActor } from "../mechanics/stress.mjs";
import { onUpdateActorStun } from "../mechanics/stun.mjs";
import { onUpdateContainerEquip } from "../mechanics/container-rail-sync.mjs";
import { onCreateActiveEffectStatus } from "../mechanics/statusEngine.mjs";
import { registerFoodAndDrink } from "../mechanics/foodAndDrink.mjs";
import { applyDefaultSceneSettings } from "../policy/scene-defaults.mjs";
import { registerCombatRoundReset } from "../policy/combat-round-reset.mjs";
import { registerStaminaRegen } from "../policy/stamina-regen.mjs";
import { registerStatusImmunity } from "../policy/status-immunity.mjs";
import { registerWoundStatuses } from "../policy/wound-statuses.mjs";
import { registerToxicity } from "../policy/toxicity.mjs";
import { registerProfessionSkills } from "../policy/profession-skills.mjs";
import { installAttackChatHandlers } from "../documents/mixins/weaponAttackMixin.mjs";
import { installDefenseChatHandlers } from "../documents/mixins/defenseMixin.mjs";

// NOTE: tickEffects + critWoundAutoheal are now wired by chrome's policy
// installers (module/chrome/policy/{tick-effects,crit-wound-autoheal}.js)
// during wireChromeInit(). Our own policy/*.mjs stubs are kept for
// reference but their hooks are NOT registered here — chrome's
// functional implementations take over. Revisit when those policies are
// rewritten into our idiom.

export function registerHooks() {
    // Stress mechanic — see mechanics/stress.mjs. Captures prior value
    // on preUpdate (so on update we can detect increase) and runs the
    // WILL save when stress is raised over WILL on a character.
    Hooks.on("preUpdateActor", onPreUpdateActor);
    Hooks.on("updateActor",    onStressUpdateActor);

    // Stun / Exhausted at 0 STA — auto-apply the STA-driven condition
    // (stunned, or exhausted under the house rule) whenever stamina hits 0,
    // and clear it once STA recovers. See mechanics/stun.mjs.
    Hooks.on("updateActor",    onUpdateActorStun);

    // Container rail ⇄ equipped — manually toggling a container's equipped
    // flag puts it on / pulls it off the inventory rail. The rail→equipped
    // direction is handled in chrome/lib/container.js#setRailAssignment.
    Hooks.on("updateItem",     onUpdateContainerEquip);

    // Default scene settings — apply the GM's template (token vision, global
    // illumination) to newly created scenes. See policy/scene-defaults.mjs.
    Hooks.on("preCreateScene", applyDefaultSceneSettings);

    // Combat action-economy — reset a character's per-round budget
    // (movement / action / extra) when their turn comes up. See
    // policy/combat-round-reset.mjs.
    registerCombatRoundReset();

    // Out-of-combat stamina regen — actors below max recover their REC in STA
    // per 3s of world time when no combat is running. See policy/stamina-regen.mjs.
    registerStaminaRegen();

    // Profession (P) skill marks — cleared when the profession item is removed
    // from a character. See policy/profession-skills.mjs.
    registerProfessionSkills();

    // Status immunity — a status the actor is immune to (monster
    // statusImmunities[] or an AE `immunity` action like Golden Oriole) never
    // lands, and granting immunity clears a matching active status. See
    // policy/status-immunity.mjs.
    registerStatusImmunity();
    // Critical-wound statuses (e.g. bleed): applied while untreated, suppressed
    // by immunity and resumed when it lapses. See policy/wound-statuses.mjs.
    registerWoundStatuses();

    // RAW toxicity overdose (homebrew rule `rawToxicity`) — drives the
    // Overdosed status off the toxicity pool and the White Honey purge.
    // See policy/toxicity.mjs.
    registerToxicity();

    // Status engine `onApply` lifecycle — when an ActiveEffect carrying a
    // status is CREATED, apply any one-shot deltas the clause declares
    // (currently `onApply.stress`). Universal primitive; the only producers
    // today are the food-and-drink statuses (drunk relief, hunger gain, gorged
    // relief, etc.). Active-GM-only is enforced inside the handler.
    Hooks.on("createActiveEffect", onCreateActiveEffectStatus);

    // Food & Drink homebrew — hourly satiety tick, day-tick hangover decrement,
    // combat-STA → satiety drain. All gated on isHomebrewEnabled('foodAndDrink')
    // INSIDE the registered listeners so a setting flip doesn't require reload
    // for the tick paths (the status registration in setup/statusEffects.mjs
    // does still require reload — Foundry caches CONFIG.statusEffects).
    registerFoodAndDrink();

    // Defense chat cards — wire the Block "spend SP" and Parry "Apply Stagger"
    // buttons on defense cards. See documents/mixins/defenseMixin.mjs.
    installDefenseChatHandlers();
}
