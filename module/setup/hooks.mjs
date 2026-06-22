/**
 * registerHooks — wires recurring Foundry runtime hooks during `setup`.
 *
 * Each handler lives in its own module under `module/policy/` or
 * `module/mechanics/`. This file is the wiring sheet — keep it thin so
 * adding a new policy is just two lines (import + Hooks.on).
 */

import { onPreUpdateActor, onUpdateActor as onStressUpdateActor, registerStressCombatHooks } from "../mechanics/stress.mjs";
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
import { registerRingPortraitButton } from "../policy/ring-portrait-button.mjs";
import { registerWitcherTokenHUD } from "../policy/witcher-token-hud.mjs";
import { registerWitcherTokenStyle } from "../policy/witcher-token-style.mjs";
import { registerCanvasMovement } from "../policy/canvas-movement.mjs";
import { registerCanvasRotation } from "../policy/canvas-rotation.mjs";
import { registerCanvasAutoFace } from "../policy/canvas-auto-face.mjs";
import { registerHideTargetPips } from "../policy/canvas-hide-target-pips.mjs";
import { registerCanvasAutoSelectTurn } from "../policy/canvas-auto-select-turn.mjs";
import { registerBrokenWeaponIndicator } from "../policy/broken-weapon-indicator.mjs";
import { registerCombatTrackerTakeControl } from "../policy/combat-tracker-take-control.mjs";
import { registerHealthStateVisuals } from "../policy/health-state-visuals.mjs";
import { registerCombatTrackerTargets } from "../policy/combat-tracker-targets.mjs";
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
    // Combat lifecycle for break sub-effects: fire banked combat-scoped
    // breaks on combatStart, tear them down on deleteCombat. The persistent
    // "experienced" markers are untouched by combat lifecycle.
    registerStressCombatHooks();

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

    // Attack chat cards — wire the "Roll Damage" button on attack cards so
    // clicking it rolls the damage formula into a new chat message. See
    // documents/mixins/weaponAttackMixin.mjs#installAttackChatHandlers.
    installAttackChatHandlers();

    // Defense chat cards — wire the Block "spend SP" button on defense cards.
    // (Parry's stagger is auto-applied; no button.)
    installDefenseChatHandlers();

    // Chat sidebar Combat chip is wired by sidebar-chat.js (sb-subnav).
    // Combat-flagged messages get `data-wou-type="combat"`; the chip sets
    // `data-wou-filter="combat"` on #chat and the CSS in sidebar.css does
    // the hiding. No standalone install needed here.

    // Token Configuration → Dynamic Ring → "Crop From Portrait" button.
    // Injects the launcher next to Subject Texture so a GM can drop the
    // actor's portrait into the ring without leaving the dialog. See
    // policy/ring-portrait-button.mjs.
    registerRingPortraitButton();

    // Witcher Token HUD — full custom replacement for Foundry's default
    // token HUD. Activates whenever a token is selected on the canvas.
    // See policy/witcher-token-hud.mjs.
    registerWitcherTokenHUD();

    // Witcher Token Style — chrome-themed canvas overlays for the selection
    // border, target reticle, and combat turn marker. Patches Token proto-
    // type methods so all three overlays render in the dock's amber palette.
    // See policy/witcher-token-style.mjs.
    registerWitcherTokenStyle();

    // Canvas drag → action-economy bridge. In combat, a token's canvas
    // drag charges the actor's movement budget (recordMovement) and is
    // hard-cancelled when the actor is stunned / full-round-locked. Out
    // of combat the drag is free. See policy/canvas-movement.mjs.
    registerCanvasMovement();
    /* Token rotation costs movement budget while in combat — 90° = 1m,
     * accumulating. Stationary-facing changes only; drags are handled
     * by canvas-movement.mjs from the x/y delta. */
    registerCanvasRotation();
    /* Targeting another token auto-rotates the user's controlled token
     * to face it (free — no movement charge). Lets the table see facing
     * without manual rotation gymnastics. See policy/canvas-auto-face.mjs. */
    registerCanvasAutoFace();
    /* Suppress Foundry's cross-user target pips (the small colored dots
     * above tokens showing OTHER users that are targeting / controlling
     * them). The GM running a solo / small-table session wanted these
     * gone — they clutter the canvas with no useful info the tracker
     * doesn't already convey. See policy/canvas-hide-target-pips.mjs. */
    registerHideTargetPips();
    /* On every combat turn change, auto-select the current combatant's
     * token IFF the local user is the sole owner (no other active
     * player owns the actor). Lets the GM jump straight to controlling
     * whichever NPC's turn it is. Skips player tokens so it never
     * pulls selection out from under a connected player. */
    registerCanvasAutoSelectTurn();
    /* Visual indicator for broken weapons / shields (reliability max>0,
     * value=0): adds .wdm-item-broken + data-wdm-broken="1" to every
     * [data-item-id] node referring to a broken item, across all
     * inventory surfaces (sheets, containers, merchant, dock, HUD).
     * Styled in styles/base.css. */
    registerBrokenWeaponIndicator();
    /* Combat tracker GM affordances:
     *   - Right-click "Take Control" entry on each combatant row
     *   - Footer "Take control on turn" toggle (auto-take on turn change)
     * Uses the existing view-as override pipeline so dock + inventory +
     * every view-as-aware surface re-render against the taken actor. */
    registerCombatTrackerTakeControl();
    /* Token visual treatment driven by actor.system.healthState:
     *   Wounded (HP < woundThreshold)  → red ColorMatrix tint, inner-glow
     *                                    blood vignette, blood streaks
     *   Dying   (HP ≤ 0)              → grayscale ColorMatrix, ~20%
     *                                    skull glyph centered on token
     * The portrait is never obscured. See policy/health-state-visuals.mjs. */
    registerHealthStateVisuals();
    /* Combat tracker target indicators — paint a marker on the row of
     * every combatant the current user is targeting (token target or
     * tokenless actor-target flag). See policy/combat-tracker-targets.mjs. */
    registerCombatTrackerTargets();
}
