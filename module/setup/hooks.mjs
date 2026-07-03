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
import { registerEoCompendiumFolder } from "./eoCompendiumFolder.mjs";
import { registerHideTargetPips } from "../policy/canvas-hide-target-pips.mjs";
import { registerCanvasAutoSelectTurn } from "../policy/canvas-auto-select-turn.mjs";
import { registerBrokenWeaponIndicator } from "../policy/broken-weapon-indicator.mjs";
import { registerCombatTrackerTakeControl } from "../policy/combat-tracker-take-control.mjs";
import { registerHealthStateVisuals } from "../policy/health-state-visuals.mjs";
import { registerCombatTrackerTargets } from "../policy/combat-tracker-targets.mjs";
import { registerCanvasTokenMiddleClick } from "../policy/canvas-token-middle-click.mjs";
import { registerCombatTrackerGuards } from "../policy/combat-tracker-guards.mjs";
import { installAttackChatHandlers } from "../documents/mixins/weaponAttackMixin.mjs";
import { installCastRiderHandler }   from "../mechanics/castRiders.mjs";
import { installCastDamageHandler }  from "../mechanics/castDamage.mjs";
import { installZoneHooks }          from "../mechanics/zoneEffects.mjs";
import { installDefenseChatHandlers } from "../documents/mixins/defenseMixin.mjs";
import { registerHoldLinkHooks } from "../mechanics/holdLink.mjs";
import { installAutoFumble } from "../mechanics/autoFumble.mjs";
import { installWRTurnStartPrompt } from "../mechanics/wrTurnStartPrompt.mjs";
import { ARMOR_LOCATION_COVERAGE, ARMOR_SLOTS } from "./config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

// NOTE: tickEffects + critWoundAutoheal are now wired by chrome's policy
// installers (module/chrome/policy/{tick-effects,crit-wound-autoheal}.js)
// during wireChromeInit(). Our own policy/*.mjs stubs are kept for
// reference but their hooks are NOT registered here — chrome's
// functional implementations take over. Revisit when those policies are
// rewritten into our idiom.

/* Clear uncovered per-location SP fields whenever an armor's `location`
 * enum changes. Without this, switching a Brigandine from "Full" to
 * "Torso" leaves the previously-authored leg numbers sitting in the
 * document — invisible to combat (deriveArmorEffective gates by enum)
 * but resurrected if the GM later flips back to "Full". Mutating the
 * change object here folds the zero-writes into the same update so the
 * authoring round-trip is one atomic write. Coverage map is the shared
 * `ARMOR_LOCATION_COVERAGE` from config.mjs — single source of truth. */
function clearUncoveredArmorSP(item, change, _options, userId) {
    if (userId !== game.user?.id) return;
    if (item?.type !== "armor") return;
    const nextLoc = change?.system?.location;
    if (typeof nextLoc !== "string") return;     // location not in this update
    const covered = new Set(ARMOR_LOCATION_COVERAGE[nextLoc] ?? []);
    change.system ??= {};
    for (const loc of ARMOR_SLOTS) {
        if (covered.has(loc)) continue;
        const spField  = `${loc}Stopping`;
        const maxField = `${loc}MaxStopping`;
        /* Don't clobber a field the caller explicitly set in the SAME
         * update — only zero out fields that aren't already being
         * written. Catches the macro / API case of changing location
         * AND a per-location SP in one call. */
        if (!(spField  in change.system)) change.system[spField]  = 0;
        if (!(maxField in change.system)) change.system[maxField] = 0;
    }
}

export function registerHooks() {
    // Stress mechanic — see mechanics/stress.mjs. Captures prior value
    // on preUpdate (so on update we can detect increase) and runs the
    // WILL save when stress is raised over WILL on a character.
    Hooks.on("preUpdateActor", onPreUpdateActor);
    Hooks.on("updateActor",    onStressUpdateActor);

    // Armor: zero out per-location SP fields the new `location` enum
    // doesn't cover, so stale arm/leg values can't be resurrected by
    // flipping back to "Full" later.
    Hooks.on("preUpdateItem", clearUncoveredArmorSP);

    /* "Immediate" AE: fire-and-forget effects that don't linger as a
     * stat modifier. For each `change` in the AE's changes array, MUTATE
     * the actor's field as a one-time write (instead of leaving the
     * change in place as a derived modifier that would revert when the
     * AE is deleted). Then run on-apply actions and delete the AE.
     *   Gate: only the actor's owner (or GM) processes — multi-client
     *   sessions don't double-fire. */
    Hooks.on("createActiveEffect", (effect) => {
        if (!effect?.getFlag?.(SYSTEM_ID, "immediate")) return;
        const actor = effect.parent;
        if (!actor || actor.documentName !== "Actor") return;
        if (!actor.isOwner && !game.user?.isGM) return;

        /* Microtask defer — let Foundry finish its create chain (so the
         * AE is fully in the embedded collection and any synchronous
         * onApply / status-engine handlers have run) before we mutate
         * and delete. */
        setTimeout(async () => {
            try {
                /* Apply each `change` as a one-time write. For ADD (mode 2,
                 * the common case), read the current value and write
                 * current + delta. For OVERRIDE (mode 5), write the
                 * literal value. MULTIPLY/UPGRADE/DOWNGRADE behave the
                 * same way as Foundry's apply pipeline would, but the
                 * result is persisted directly on the actor instead of
                 * folded into derived data. */
                const updates = {};
                for (const change of (effect.changes ?? [])) {
                    if (!change?.key) continue;
                    const key  = String(change.key);
                    const raw  = change.value;
                    const num  = Number(raw);
                    const mode = Number(change.mode ?? change.type ?? 2);
                    const cur  = Number(foundry.utils.getProperty(actor, key)) || 0;
                    let next = cur;
                    /* Foundry CONST.ACTIVE_EFFECT_MODES:
                     *   0 CUSTOM       — skipped (system-specific)
                     *   1 MULTIPLY     — cur * num
                     *   2 ADD          — cur + num
                     *   3 DOWNGRADE    — min(cur, num)
                     *   4 UPGRADE      — max(cur, num)
                     *   5 OVERRIDE     — num
                     * Strings (e.g. "system.derivedStats.stress.value")
                     * that aren't numeric coerce to NaN; we skip those
                     * because instantaneous writes only make sense for
                     * numeric pools. */
                    if (!Number.isFinite(num)) continue;
                    if      (mode === 1) next = cur * num;
                    else if (mode === 2) next = cur + num;
                    else if (mode === 3) next = Math.min(cur, num);
                    else if (mode === 4) next = Math.max(cur, num);
                    else if (mode === 5) next = num;
                    else continue;       // CUSTOM / unknown — skip
                    updates[key] = next;
                }
                if (Object.keys(updates).length) {
                    try { await actor.update(updates); }
                    catch (err) { console.warn("witcher-ttrpg-death-march | immediate AE actor.update failed", err); }
                }
                /* Delete the AE itself. The mutation above is now persisted
                 * on the actor; the AE's changes won't be re-applied via
                 * prepareDerivedData because the AE is gone. */
                if (actor.effects?.get?.(effect.id)) {
                    await effect.delete();
                }
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | immediate AE handler failed", err);
            }
        }, 0);
    });
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

    // Cast chat cards — inject registered rider buttons on cast messages
    // stamped with a castContext envelope. Combat Meditation, elemental
    // amplifiers, etc. all register through mechanics/castRiders.mjs and
    // this hook fans them out per-viewer via predicate matching.
    installCastRiderHandler();
    // Cast damage — Roll Damage button that reads the envelope's
    // damage.formula (with {sta} / {margin} interpolation), rolls, and
    // applies damage + status riders per stamped target. Owner-gated.
    installCastDamageHandler();

    // Persistent-area zone effects (Yrden, Static Storm, Consecrate,
    // Blaze of Korath, Dormyn's Fog, etc.). Installs updateToken /
    // combatRound / deleteMeasuredTemplate hooks that apply / strip
    // ActiveEffects as tokens cross zone boundaries and delete zones
    // when their duration runs out. GM-only mutation; all clients
    // see the AE writes as broadcasts.
    installZoneHooks();

    // Defense chat cards — wire the Block "spend SP" button on defense cards.
    // (Parry's stagger is auto-applied; no button.)
    installDefenseChatHandlers();

    // Auto-fumble table roll + Witchers Reborn stance-perk skip dialog.
    // Callers of extendedRoll pass `config.fumbleCategory`; the listener
    // resolves the RAW fumble table and, for perk owners, offers a 5 STA
    // skip prompt first. See mechanics/autoFumble.mjs.
    installAutoFumble();

    // Witchers Reborn — Bear · Unrelenting + Manticore · Bulwark: both
    // fire at the start of the actor's turn if they're wounded/dying and
    // have the AE + STA to spend. Shared prompt lives in
    // mechanics/wrTurnStartPrompt.mjs; the wound-flag and death-auto-pass
    // machinery is the same one the Unrelenting macro used.
    installWRTurnStartPrompt();

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
    /* Hold-link bookkeeping: movement break + incapacitation clear for
     * Clinch / Grapple / Pin / Chokehold. The CE attack actions stamp
     * a `clinched` / `grappled` / `pinned` / `chokeheld` status + a
     * mutual `holdLink` flag on apply (see weaponAttackMixin); the
     * hooks registered here drop both sides when geometry or status
     * say the hold can't be maintained. */
    registerHoldLinkHooks();
    /* Token rotation costs movement budget while in combat. The conversion
     * rate is GM-configurable via the `rotationMovementPer90` setting
     * (default 1m per 90°, set to 0 to make rotation free). Stationary
     * facing changes only — drags are handled by canvas-movement.mjs from
     * the x/y delta. */
    registerCanvasRotation();
    /* Targeting another token auto-rotates the user's controlled token
     * to face it (free — no movement charge). Lets the table see facing
     * without manual rotation gymnastics. See policy/canvas-auto-face.mjs. */
    registerCanvasAutoFace();
    /* Group the 5 Equipment Overhaul packs under a "Combat Extended"
     * compendium-sidebar folder when the CE master toggle is on; remove
     * the folder when CE is off. Reacts to live toggle changes. */
    registerEoCompendiumFolder();
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
    /* Canvas token middle-click → target. Mirrors the tracker-side
     * middle-click. See policy/canvas-token-middle-click.mjs.
     * (T-key additive-target keybinding is registered from main.mjs's
     * init hook — Foundry doesn't accept keybinding registrations
     * after init closes.) */
    registerCanvasTokenMiddleClick();
    /* Combat tracker guard-stance indicator — small chip under each
     * combatant's name showing their active guard (Balanced / Warding /
     * Closed / Fool's) plus warded locations per equipped weapon when
     * Warding. Only paints when CE's `guards` subsystem is enabled. See
     * policy/combat-tracker-guards.mjs. */
    registerCombatTrackerGuards();
}
