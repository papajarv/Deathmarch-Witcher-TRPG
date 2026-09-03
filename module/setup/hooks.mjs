/**
 * registerHooks — wires recurring Foundry runtime hooks during `setup`.
 *
 * Each handler lives in its own module under `module/policy/` or
 * `module/mechanics/`. This file is the wiring sheet — keep it thin so
 * adding a new policy is just two lines (import + Hooks.on).
 */

import { onPreUpdateActor, onUpdateActor as onStressUpdateActor, registerStressCombatHooks } from "../mechanics/stress.mjs";
import { onUpdateActorStun, onPreUpdateActorStun } from "../mechanics/stun.mjs";
import { onUpdateContainerEquip } from "../mechanics/container-rail-sync.mjs";
import { onCreateActiveEffectStatus } from "../mechanics/statusEngine.mjs";
import { registerFoodAndDrink } from "../mechanics/foodAndDrink.mjs";
import { applyDefaultSceneSettings } from "../policy/scene-defaults.mjs";
import { registerCombatRoundReset } from "../policy/combat-round-reset.mjs";
import { registerStaminaRegen } from "../policy/stamina-regen.mjs";
import { registerStatusImmunity } from "../policy/status-immunity.mjs";
import { registerWoundStatuses } from "../policy/wound-statuses.mjs";
import { registerEncumbranceStatus } from "../policy/encumbrance-status.mjs";
import { registerToxicity } from "../policy/toxicity.mjs";
import { registerProfessionSkills } from "../policy/profession-skills.mjs";
import { registerRingPortraitButton } from "../policy/ring-portrait-button.mjs";
import { registerWitcherTokenHUD } from "../policy/witcher-token-hud.mjs";
import { registerWitcherTokenStyle } from "../policy/witcher-token-style.mjs";
import { registerCanvasMovement } from "../policy/canvas-movement.mjs";
import { registerCanvasRotation } from "../policy/canvas-rotation.mjs";
import { registerCanvasAutoFace } from "../policy/canvas-auto-face.mjs";
import { registerImmersiveTokenCamera } from "../policy/immersive-token-camera.mjs";
import { registerGmFovTokenHide } from "../policy/gm-fov-token-hide.mjs";
import { registerGmOffTurnMove } from "../policy/gm-offturn-move.mjs";
import { registerRollTokenInit } from "../policy/roll-token-init.mjs";
import { registerHideTargetPips } from "../policy/canvas-hide-target-pips.mjs";
import { registerCanvasAutoSelectTurn } from "../policy/canvas-auto-select-turn.mjs";
import { registerBrokenWeaponIndicator } from "../policy/broken-weapon-indicator.mjs";
import { registerCombatTrackerTakeControl } from "../policy/combat-tracker-take-control.mjs";
import { registerCombatTrackerTakeTurn } from "../policy/combat-tracker-take-turn.mjs";
import { registerHealthStateVisuals } from "../policy/health-state-visuals.mjs";
import { registerDeadTokenZOrder } from "../policy/dead-token-zorder.mjs";
import { registerStealthTokenVisual } from "../policy/stealth-token-visual.mjs";
import { registerLightTokenIndicator } from "../policy/light-token-indicator.mjs";
import { registerLightCache } from "../mechanics/light-level.mjs";
import { registerDarkvisionSight } from "../policy/darkvision-sight.mjs";
import { registerTokenDispositionVisual } from "../policy/token-disposition-visual.mjs";
import { registerStealthHooks } from "../mechanics/stealth-hooks.mjs";
import { registerStealthPaceIndicator } from "../policy/stealth-pace-indicator.mjs";
import { registerStealthSpotterVision } from "../policy/stealth-spotter-vision.mjs";
import { registerStealthVisionConfig } from "../policy/stealth-vision-config.mjs";
import { registerHelmetVisionRestriction } from "../policy/helmet-vision-restriction.mjs";
import { registerTokenAppearanceConfig } from "../policy/token-appearance-config.mjs";
import { registerStealthTokenVisibility } from "../policy/stealth-token-visibility.mjs";
import { registerCombatTrackerTargets } from "../policy/combat-tracker-targets.mjs";
import { registerCanvasTokenMiddleClick } from "../policy/canvas-token-middle-click.mjs";
import { registerCanvasFacingLock } from "../policy/canvas-facing-lock.mjs";
import { registerCombatTrackerGuards } from "../policy/combat-tracker-guards.mjs";
import { installAttackChatHandlers } from "../documents/mixins/weaponAttackMixin.mjs";
import { installCastRiderHandler }   from "../mechanics/castRiders.mjs";
import { installCastDamageHandler }  from "../mechanics/castDamage.mjs";
import { installZoneHooks }          from "../mechanics/zoneEffects.mjs";
import { installDefenseChatHandlers } from "../documents/mixins/defenseMixin.mjs";
import { installUnmovingHandler } from "./socketHook.mjs";
import { registerHoldLinkHooks } from "../mechanics/holdLink.mjs";
import { installAutoFumble } from "../mechanics/autoFumble.mjs";
import { installWRTurnStartPrompt } from "../mechanics/wrTurnStartPrompt.mjs";
import { installDeathState } from "../mechanics/deathStatePrompt.mjs";
import { installChokeUpkeepPrompt } from "../mechanics/choke.mjs";
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

    /* Actor duplication: containers store their contents as full UUIDs
     * (Actor.<id>.Item.<id>). When Foundry duplicates an actor, embedded
     * items get NEW ids under a NEW parent — but each container's
     * `system.content` array is copied verbatim, so it still points at
     * the SOURCE actor's items. Result: the duplicate's container panels
     * render empty even though the actor carries the (correctly
     * duplicated) items with `isStored: true`.
     *
     * Fix: on createActor, walk each container's content, resolve every
     * ref, and if the ref resolves to an item on a DIFFERENT actor,
     * find the matching item on THIS actor (by name + type + isStored)
     * and rewrite the ref. Refs that already point to this actor pass
     * through untouched; unresolvable refs are dropped so the array
     * doesn't accumulate garbage. GM-only to avoid multi-client races. */
    Hooks.on("createActor", async (actor) => {
        if (!game.user?.isActiveGM) return;
        if (actor.parent) return;                // token-actor / synthetic — skip
        const containers = actor.items?.contents?.filter?.(i => i.type === "container") ?? [];
        if (!containers.length) return;
        for (const container of containers) {
            const content = container.system?.content ?? [];
            if (!content.length) continue;
            const claimed = new Set();       // items already routed by an earlier ref
            const nextContent = [];
            for (const ref of content) {
                let source = null;
                try { source = fromUuidSync(ref); } catch (_) { source = null; }
                /* Ref already resolves on this actor — keep it. */
                if (source && source.parent?.id === actor.id) {
                    nextContent.push(ref);
                    claimed.add(source.id);
                    continue;
                }
                /* Ref points to another actor (usually the duplication
                 * source). Find a matching sibling on this actor by
                 * name + type. `isStored: true` is a strong hint that
                 * the item was originally inside a container, but not
                 * strictly required since some duplicated data may not
                 * carry it. Skip anything another ref already claimed. */
                const match = source ? actor.items?.contents?.find?.(i =>
                    !claimed.has(i.id)
                    && i.type === source.type
                    && i.name === source.name
                ) : null;
                if (match) {
                    nextContent.push(match.uuid);
                    claimed.add(match.id);
                } else {
                    /* Unresolvable ref (source deleted, or no matching
                     * item on this actor) — drop it. */
                }
            }
            const changed = nextContent.length !== content.length
                || nextContent.some((ref, i) => ref !== content[i]);
            if (changed) {
                try { await container.update({ "system.content": nextContent }); }
                catch (err) { console.warn(`${SYSTEM_ID} | container ref remap on actor duplicate failed`, err); }
            }
        }
    });

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
    // (stunned) ONCE on the transition to 0 stamina, and clear it once STA
    // recovers. One-shot, so a cleared stun stays cleared while still winded.
    // See mechanics/stun.mjs. preUpdate snapshots the pre-write STA so the
    // apply fires only on the transition, not on every write at 0 STA.
    Hooks.on("preUpdateActor", onPreUpdateActorStun);
    Hooks.on("updateActor",    onUpdateActorStun);

    // Container rail ⇄ equipped — manually toggling a container's equipped
    // flag puts it on / pulls it off the inventory rail. The rail→equipped
    // direction is handled in chrome/lib/container.js#setRailAssignment.
    Hooks.on("updateItem",     onUpdateContainerEquip);

    /* Pristine weapon reliability top-up — a weapon whose effective (meteorite /
     * rune-boosted) reliability max exceeds its authored base, while still at
     * full base durability, is undamaged and should read the boosted max. Fill
     * it to the effective max. GM-side only, and NOT triggered by plain
     * reliability.value edits, so damaging a weapon down to its base max can't
     * "re-heal" it. See fillPristineWeaponReliability. */
    Hooks.on("createItem", (item) => {
        if (game.users.activeGM?.id !== game.user?.id) return;
        fillPristineWeaponReliability(item);
    });
    Hooks.on("updateItem", (item, changes) => {
        if (game.users.activeGM?.id !== game.user?.id) return;
        const s = changes?.system;
        // Only when a MAX-affecting field changed (qualities / socketed runes),
        // never on a bare value edit — that's what prevents the re-heal.
        if (!s || (s.qualities === undefined && s.appliedEnhancements === undefined && s.qualityValues === undefined)) return;
        fillPristineWeaponReliability(item);
    });
    Hooks.once("ready", () => {
        if (game.users.activeGM?.id !== game.user?.id) return;
        const all = [
            ...(game.items?.contents ?? []),
            ...(game.actors?.contents ?? []).flatMap(a => a.items?.contents ?? [])
        ];
        for (const it of all) fillPristineWeaponReliability(it);
    });

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
    registerEncumbranceStatus();

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

    /* Cast-shield cleanup: when a Quen / Active Shield badge AE is
     * removed for any reason (drained to 0, duration expired, hand-
     * dismissed), zero the actor's derivedStats.shield. The pool and
     * the badge are logically the same thing — without this, a Quen
     * that expires on the clock leaves 3 HP of "phantom shield" the
     * damage calculator would still drain from. Guarded on active-GM
     * so only one client does the write; owner-side would also work
     * but the socket already funnels damage-apply through the GM. */
    Hooks.on("deleteActiveEffect", async (effect) => {
        if (!game.user?.isActiveGM) return;
        if (!effect?.flags?.[SYSTEM_ID]?.castShield) return;
        const actor = effect.parent;
        if (!actor || actor.documentName !== "Actor") return;
        const cur = Number(actor.system?.derivedStats?.shield) || 0;
        if (cur > 0) {
            try { await actor.update({ "system.derivedStats.shield": 0 }); }
            catch (err) { console.warn(`${SYSTEM_ID} | cast-shield stat zero failed`, err); }
        }
    });

    /* Cast-shield break on manual zero: when derivedStats.shield reaches
     * 0 for any reason OTHER than damage (sheet edit, macro, GM setting
     * it to 0), delete the castShield badge AE so the fiction holds —
     * "the shield broke". The damage path already deletes the badge
     * inline (see the badge-sync block in socketHook.mjs), so this only
     * catches the non-damage paths. Loop-safe: the deleteActiveEffect
     * hook above guards on `cur > 0` before writing, so the AE delete
     * won't try to re-zero an already-zero shield. */
    Hooks.on("updateActor", async (actor, changes) => {
        if (!game.user?.isActiveGM) return;
        if (!actor || actor.documentName !== "Actor") return;
        /* Only react when this update actually touched the shield field. */
        const newShield = foundry.utils.getProperty(changes, "system.derivedStats.shield");
        if (newShield === undefined) return;
        if (Number(newShield) > 0) return;
        const badges = (actor.effects?.contents ?? [])
            .filter(e => !!e.flags?.[SYSTEM_ID]?.castShield);
        if (!badges.length) return;
        /* Table-visible feedback that the magic shield just broke. Posted
         * ONCE per break event, before badge deletion so the badge name
         * is still available for the message. Only fires when there was
         * an active badge to delete — a manual set of shield=0 with no
         * badge in play is a no-op and doesn't need a chat card. */
        try {
            const shieldName = badges[0]?.name || game.i18n.localize("WITCHER.Chat.MagicShield.Fallback");
            await ChatMessage.create({
                speaker: ChatMessage.implementation.getSpeaker({ actor }),
                content: `<div class="wdm-shield-broken-card"><i class="fa-solid fa-shield-halved" style="color:#8b5a2b;"></i> `
                    + game.i18n.format("WITCHER.Chat.MagicShield.Broken",
                        { actor: actor.name, shield: shieldName })
                    + `</div>`
            });
        } catch (err) { console.warn(`${SYSTEM_ID} | shield-break chat post failed`, err); }
        for (const ae of badges) {
            /* RE-CHECK, then swallow the benign race.
             *
             * `badges` was collected a few lines above; the very write that
             * brought us here may already have deleted them — `setShieldPool`
             * deletes the badge when the pool empties, and a ward's `onExpire`
             * now zeroes the pool on its way out. Both deletes then run against
             * one effect and Foundry throws "does not exist" at the loser,
             * which surfaced as four warnings per ward run in the live matrix.
             * A live existence check catches the common case; the catch handles
             * the delete that lands between the check and the await. */
            if (!actor.effects?.get?.(ae.id)) continue;
            try { await ae.delete(); }
            catch (err) {
                if (/does not exist/i.test(String(err?.message ?? ""))) continue;
                console.warn(`${SYSTEM_ID} | cast-shield break-on-zero failed`, err);
            }
        }
    });

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
    // Unmoving (armor): reactive "spend 5 STA to Stagger the attacker" button.
    installUnmovingHandler();

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

    // Death State — at the start of a dying actor's turn, prompt a death save;
    // wipe the cumulative penalty when they recover out of death state; and pull
    // dead actors off every initiative track. mechanics/deathStatePrompt.mjs.
    installDeathState();

    // Choke upkeep — at the start of the choker's turn, ask whether to keep up
    // each chokehold (spend an action + deal suffocation) or release it.
    installChokeUpkeepPrompt();

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
    /* Auto-face (token rotation-lock to always face the opponent) is
     * DISABLED by design — the table asked for manual facing only, no
     * automatic snap-to-target. Left unregistered rather than deleted so
     * it can be restored in one line. See policy/canvas-auto-face.mjs. */
    // registerCanvasAutoFace();
    /* Immersive Token Camera — opt-in client setting that locks the view
     * to the local user's controlled token: always centered, facing
     * always up, zoom preserved, pan disabled. See policy/immersive-
     * token-camera.mjs. */
    registerImmersiveTokenCamera();
    /* FOV Token Hide — standalone GM view toggle (its own combat-tracker
     * button). Lets a GM switch off Foundry's native FOV token culling to
     * see all tokens regardless of the selected token's field of view.
     * Independent of immersive mode. See policy/gm-fov-token-hide.mjs. */
    registerGmFovTokenHide();
    /* GM-only combat-tracker toggle: when on, the GM may drag any combatant's
     * token regardless of whose turn it is (no budget spent). Relaxes only the
     * movement turn-gate. See policy/gm-offturn-move.mjs. */
    registerGmOffTurnMove();
    /* GM-only combat-tracker button: roll initiative for every selected token
     * at once. Greyed out when no token is selected. See policy/roll-token-init. */
    registerRollTokenInit();
    /* (Removed) The Combat-Extended compendium show/hide + folder-grouping
     * gate used to hide the Equipment-Overhaul packs from the sidebar when
     * the CE toggle was off. Compendium content is being decoupled into its
     * own module, so per-toggle pack visibility is no longer needed. */
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
    /* Right-click "Take Turn" entry on each combatant row — jumps the active
     * turn pointer to that combatant (combat.update({ turn })), GM-only. */
    registerCombatTrackerTakeTurn();
    /* Token visual treatment driven by actor.system.healthState:
     *   Wounded (HP < woundThreshold)  → red ColorMatrix tint, inner-glow
     *                                    blood vignette, blood streaks
     *   Dying   (HP ≤ 0)              → grayscale ColorMatrix, ~20%
     *                                    skull glyph centered on token
     * The portrait is never obscured. See policy/health-state-visuals.mjs. */
    registerHealthStateVisuals();
    /* Defeated tokens always sink beneath living ones in the token stack
     * (overrides mesh.sort; never touches elevation). See
     * policy/dead-token-zorder.mjs. */
    registerDeadTokenZOrder();
    /* Stealth token overlay — dashed silver ring + subtle darken for
     * any token whose actor has `flags[SYSTEM_ID].stealth.active`.
     * See policy/stealth-token-visual.mjs. */
    registerStealthTokenVisual();
    /* Light-level token badge — small corner disk showing each token's current
     * light tier (Bright/Dim/Darkness/Pitch; none in Daylight). See
     * policy/light-token-indicator.mjs. */
    registerLightTokenIndicator();
    /* Per-token light-tier cache invalidation (bumps an epoch on lighting/darkness/
     * scene changes) so lightLevelAt skips re-sampling stationary tokens every
     * dirty frame. See mechanics/light-level.mjs. */
    registerLightCache();
    /* Dark Vision race toggle → Foundry "lightAmplification" vision mode on the
     * actor's token, so darkvision characters actually SEE in pitch dark. See
     * policy/darkvision-sight.mjs. */
    registerDarkvisionSight();
    /* Stealth spot-check engine — GM-authoritative movement-triggered
     * opposed Awareness vs Stealth rolls, updates spottedBy list, GM-
     * whispered chat card per check. See mechanics/stealth-hooks.mjs. */
    registerStealthHooks();
    /* Movement-pace chevrons, parented to the token so they move with the
     * mesh instead of teleporting to its destination. See
     * policy/stealth-pace-indicator.mjs. */
    registerStealthPaceIndicator();
    /* Spotter-vision red overlay — draws every potential enemy's
     * sight polygon in translucent red for the client owning a
     * currently-stealthed actor (or GM). See policy/stealth-spotter-
     * vision.mjs. */
    registerStealthSpotterVision();
    /* Token config UI patch — relabels "Vision Angle" to "True
     * Vision Angle" and injects a sibling "Allowed Vision Angle"
     * input bound to a flag. See policy/stealth-vision-config.mjs. */
    registerStealthVisionConfig();
    /* CE: a worn Restricted/Poor Vision helm clamps the wearer's token vision
     * angle to 90° (via the allowedVisionAngle flag); raising a Visor or
     * removing the helm restores it. See policy/helmet-vision-restriction.mjs. */
    registerHelmetVisionRestriction();
    /* Token config UI patch — adds "Token Image Rotation" (core texture.rotation)
     * and a "Facing Arrow" on/off toggle to the Appearance tab. See
     * policy/token-appearance-config.mjs. */
    registerTokenAppearanceConfig();
    /* Per-user stealth token render gate — hides stealthed tokens
     * from clients whose owned actors aren't in the stealther's
     * spottedBy list. See policy/stealth-token-visibility.mjs. */
    registerStealthTokenVisibility();
    /* Disposition halo + SECRET gate — colored glow filter on the token
     * mesh (green FRIENDLY / red HOSTILE, no glow for NEUTRAL). SECRET
     * disposition hides the whole token from non-GMs (visible/mesh/alpha
     * all off, selection + target released) and strips the facing arrow
     * for the GM's view so nothing about the token telegraphs "I'm a
     * token." MUST register AFTER registerWitcherTokenStyle (facing
     * arrow refresh) and registerStealthTokenVisibility so its hides
     * land last on refreshToken. See policy/token-disposition-visual.mjs. */
    registerTokenDispositionVisual();
    /* Combat tracker target indicators — paint a marker on the row of
     * every combatant the current user is targeting (token target or
     * tokenless actor-target flag). See policy/combat-tracker-targets.mjs. */
    registerCombatTrackerTargets();
    /* Canvas token middle-click → TARGET is disabled (targeting is driven by
     * the weapon → tile flow; manual target-lock survives only in theatre-of-
     * the-mind). See policy/canvas-token-middle-click.mjs. */
    // registerCanvasTokenMiddleClick();
    /* Canvas token middle-click → FACING LOCK. Independent of targeting: lock
     * your facing onto a token (no chevron); you keep facing it as either of
     * you moves, and the lock breaks the moment a wall cuts your line of sight.
     * See policy/canvas-facing-lock.mjs. */
    registerCanvasFacingLock();
    /* Combat tracker guard-stance indicator — small chip under each
     * combatant's name showing their active guard (Balanced / Warding /
     * Closed / Fool's) plus warded locations per equipped weapon when
     * Warding. Only paints when CE's `guards` subsystem is enabled. See
     * policy/combat-tracker-guards.mjs. */
    registerCombatTrackerGuards();
}

/* ── Pristine weapon reliability top-up ─────────────────────────────────
 * A weapon whose effective reliability max (base + Meteorite/rune bonuses) is
 * higher than its authored base, while its stored value still equals that base
 * (undamaged), should read the boosted max. Return the update that tops the
 * current value up to the effective max, or null when nothing's needed. Reads
 * `_source` for the authored base/value (NOT the prepared, already-boosted max)
 * and `system.effective.reliabilityMax` for the boosted max. */
function reliabilityFillUpdate(item) {
    if (item?.type !== "weapon") return null;
    const rel = item._source?.system?.reliability;
    if (!rel) return null;
    const baseMax = Number(rel.max) || 0;
    const value   = Number(rel.value) || 0;
    const effMax  = Number(item.system?.effective?.reliabilityMax) || 0;
    // Pristine top-up: an undamaged weapon (value at base max) reads the boosted max.
    if (effMax > baseMax && value === baseMax && value !== effMax) {
        return { "system.reliability.value": effMax };
    }
    // Clamp-down: a REMOVED bonus (e.g. meteorite taken off) left the stored
    // current above the now-lower max — bring it back to the max.
    if (value > effMax) {
        return { "system.reliability.value": effMax };
    }
    return null;
}

async function fillPristineWeaponReliability(item) {
    const upd = reliabilityFillUpdate(item);
    if (!upd) return;
    try { await item.update(upd); }
    catch (err) { console.warn("witcher-ttrpg-death-march | pristine reliability fill failed", err); }
}
