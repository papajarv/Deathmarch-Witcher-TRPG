/**
 * Chrome orchestrator — Phase 4b bulk port.
 *
 * Mirrors the reference module's `scripts/main.js` init/ready bodies as
 * two functions called from `module/main.mjs`. This file is the
 * orchestration layer; the underlying `.js` files under `module/chrome/`
 * are still in the reference module's idiom and will be rewritten into
 * ours (mixins / ApplicationV2 / system-fields) one at a time in
 * subsequent turns.
 *
 * Known broken until iterative cleanup:
 *  - `game.modules.get("witcher-ttrpg-death-march")?.api?.openContainer`
 *    style calls (reference treated itself as a module; we're a system).
 *    Container hotbar macros will silently no-op.
 *  - `game.modules.get("witcher-alchemy-craft")` / `witcher-stress-mechanic`
 *    checks — bundled mechanics are no longer separate modules; those
 *    panel sections will hide until the checks are rewritten to look at
 *    `isHomebrewEnabled(...)`.
 *  - `WOU.*` i18n keys — `lang/en.json` has system-namespaced keys; chrome
 *    text will fall back to the raw key string until WOU.* keys are added
 *    or the chrome is migrated to WITCHER.*.
 *
 * The legacy migration (v2) copies actor/item/etc flag bags from
 * `witcher-overhaul-ui` to `witcher-ttrpg-death-march`, so chrome reads
 * see continuity from existing worlds.
 */

/* ── Side-effect imports: render-hook registrants ─────────────────────── */

import "./sheets/valuable-map.js";
import "./sheets/valuable-study.js";
import "./sheets/inventory-qol.js";
import "./sheets/monster-mount.js";
import "./sheets/monster-bestiary-variant.js";
import "./sheets/weapon-shield.js";
import "./sheets/container-equip.js";
import "./sheets/character-mount.js";
import "./integrations/portrait-toxicity.js";

/* ── Init-time installers ─────────────────────────────────────────────── */

import { registerSettings, getSetting, applyFeatureClasses, MODULE_ID } from "./setup/settings.js";
import { registerEncounterHooks } from "./chrome/encounter.js";
import { registerBestiaryEncounterHooks } from "./chrome/bestiary-encounters.js";
import { installJournalQuota } from "./policy/journal-quota.js";
import { installCritWoundAutoheal } from "./policy/crit-wound-autoheal.js";
import { installTickEffects } from "./policy/tick-effects.js";
import { installConsumableConfigFix } from "./policy/consumable-config-fix.js";
import { installConsumeFeature } from "./policy/consume-item.js";
import { installFoodConsumeFeature } from "./policy/food-consume.js";
import { registerActorContextMenu } from "./chrome/context-menu-actor.js";
import { registerItemContextMenu } from "./chrome/context-menu-item.js";
import { registerMonsterRemainsHooks } from "./chrome/monster-remains.js";

/* ── Ready-time injectors ─────────────────────────────────────────────── */

import { migrateBestiarySchemaIfNeeded } from "./lib/bestiary.js";
import { VIEWER_OVERRIDE_HOOK, getAssignedActor } from "./lib/actor.js";
import { installGlobalListeners } from "./chrome/collapsibles.js";
import { injectTopBar } from "./chrome/topbar.js";
import { injectInventoryOverlay, openContainer, openContainerFloating, sweepExpiredOilCoatings } from "./chrome/inventory.js";
import { injectJournalPanel } from "./chrome/journal.js";
import { injectCraftingPanel } from "./chrome/crafting.js";
import { injectCharacterPanel } from "./chrome/character.js";
import { injectMapPanel } from "./chrome/map.js";
import { injectBestiaryPanel } from "./chrome/bestiary.js";
import { wireSideEdges } from "./chrome/sideedges.js";
import { wireLeftBar } from "./chrome/leftbar.js";
import { injectDock, scheduleRebindDock } from "./chrome/dock.js";
import { installNotificationsAboveDock } from "./chrome/notifications.js";
import { installChatPreviews } from "./chrome/chat-preview.js";
import { bindHotkeys, installItemCleanup } from "./chrome/hotbar.js";
import { setupChatEnhancements } from "./chrome/sidebar-chat.js";
import { wireSidebarClamp } from "./chrome/sidebar-clamp.js";
import { setupSkillsPanel } from "./chrome/skills-panel.js";
import { setupGMPanel } from "./chrome/gm-panel.js";
import { wireWeather } from "./chrome/weather.js";
import { installParchments } from "./chrome/parchments.js";

/* ── Public surface (re-exported so main.mjs can expose to system.api) ── */
export { openContainer, openContainerFloating };

/**
 * Called from main.mjs `init`. Mirrors reference main.js `init` body.
 * Order matches the reference so register-time semantics line up.
 */
export function wireChromeInit() {
    registerSettings();
    registerEncounterHooks();
    registerBestiaryEncounterHooks();
    installJournalQuota();
    installCritWoundAutoheal();
    installTickEffects();
    installConsumableConfigFix();
    installConsumeFeature();
    installFoodConsumeFeature();
    registerActorContextMenu();
    registerItemContextMenu();
    registerMonsterRemainsHooks();

    /* hotbarDrop interceptor — for container items, emit a macro that
     * pops the container into the inventory rail (instead of Foundry's
     * default item-sheet macro near the hotbar). */
    Hooks.on("hotbarDrop", (bar, data, slot) => {
        if (data?.type !== "Item" || !data?.uuid) return;
        const item = fromUuidSync?.(data.uuid);
        if (!item) return;

        let command = null;
        if (item.type === "container") {
            command =
                `const api = game.system?.api?.containers;\n` +
                `if (api?.openContainer) await api.openContainer("${item.id}");\n` +
                `else (await fromUuid("${item.uuid}"))?.sheet?.render(true);`;
        }
        if (!command) return;

        (async () => {
            let macro = game.macros.find(m => m.name === item.name && m.command === command);
            if (!macro) {
                macro = await Macro.create({
                    name: item.name,
                    type: "script",
                    img:  item.img,
                    command
                }, { displaySheet: false });
            }
            await game.user.assignHotbarMacro(macro, slot);
        })();
        return false;
    });
}

/**
 * Called from main.mjs `ready` AFTER legacy migration. Mirrors reference
 * main.js `ready` body. Honors the master `enabled` setting.
 */
export function wireChromeReady() {
    if (!getSetting("enabled")) {
        console.log(`${MODULE_ID} | chrome disabled via settings`);
        return;
    }

    document.body.classList.add("witcher-ttrpg-death-march");
    applyFeatureClasses();
    installGlobalListeners();
    migrateBestiarySchemaIfNeeded();

    if (getSetting("feature.topChrome")) {
        injectTopBar();
        wireWeather();
        injectInventoryOverlay();
        injectJournalPanel();
        injectCraftingPanel();
        injectCharacterPanel();
        injectMapPanel();
        injectBestiaryPanel();
    }
    if (getSetting("feature.hotbar")) {
        injectDock();
        installNotificationsAboveDock();
        installChatPreviews();
    }
    if (getSetting("feature.sceneControls") || getSetting("feature.sidebar")) {
        wireSideEdges();
        wireLeftBar();
    }

    /* Hotbar keybinds + cross-actor item/macro cleanup. Both are
     * idempotent and re-check the feature flag at runtime. */
    bindHotkeys();
    installItemCleanup();

    /* Native notice-board parchments: drop a note on a scene to post it. */
    installParchments();

    if (getSetting("feature.sidebar")) setupChatEnhancements();
    if (getSetting("feature.sidebar")) wireSidebarClamp();
    if (getSetting("feature.hotbar"))  { setupSkillsPanel(); setupGMPanel(); }

    /* Rebind the dock when the assigned actor's data changes. Filters
     * resolve the actor LIVE so "view as" target switches flow through. */
    const ownsItem = (item) => {
        const aid = getAssignedActor()?.id;
        return !!aid && item?.parent?.id === aid;
    };
    const ownsEffect = (ae) => {
        const aid = getAssignedActor()?.id;
        if (!aid) return false;
        const p = ae?.parent;
        return p?.id === aid || p?.parent?.id === aid;
    };
    Hooks.on("updateUser",  (user)  => { if (user.id  === game.user.id)           scheduleRebindDock(); });
    Hooks.on("updateActor", (actor) => { if (actor.id === getAssignedActor()?.id) scheduleRebindDock(); });
    Hooks.on("createItem",  (item)  => { if (ownsItem(item))                      scheduleRebindDock(); });
    Hooks.on("updateItem",  (item)  => { if (ownsItem(item))                      scheduleRebindDock(); });
    Hooks.on("deleteItem",  (item)  => { if (ownsItem(item))                      scheduleRebindDock(); });
    Hooks.on("createActiveEffect", (ae) => { if (ownsEffect(ae))                  scheduleRebindDock(); });
    Hooks.on("updateActiveEffect", (ae) => { if (ownsEffect(ae))                  scheduleRebindDock(); });
    Hooks.on("deleteActiveEffect", (ae) => { if (ownsEffect(ae))                  scheduleRebindDock(); });
    Hooks.on("updateMacro", scheduleRebindDock);
    // World time advancing expires oil coatings (Core p.248: a blade oil lasts
    // 30 game-minutes). They live on the weapon as effects and expire on world
    // time, not combat rounds, so the GM-side sweep deletes any that have run
    // out; refreshing the dock then ticks the surviving bars down.
    Hooks.on("updateWorldTime", () => { sweepExpiredOilCoatings(); scheduleRebindDock(); });
    // Entering/leaving combat (and each round/turn) flips how durations read —
    // wall-clock out of combat, rounds in combat (describeDuration keys off
    // game.combat.started). The weapon oil bar must re-render on those edges,
    // exactly like the dock status badges already do, so the two stay uniform.
    Hooks.on("createCombat", scheduleRebindDock);
    Hooks.on("deleteCombat", scheduleRebindDock);
    Hooks.on("updateCombat", scheduleRebindDock);
    Hooks.on("combatStart",  scheduleRebindDock);
    Hooks.on("combatTurn",   scheduleRebindDock);
    // Fires AFTER the turn update applies — so combat.combatant is the new
    // combatant and our off-turn paint can flip correctly the same frame.
    Hooks.on("combatTurnChange", scheduleRebindDock);
    Hooks.on("combatRound",  scheduleRebindDock);
    // Catch coatings that expired while the world was closed (no worldTime hook fires then).
    sweepExpiredOilCoatings();
    Hooks.on(VIEWER_OVERRIDE_HOOK, scheduleRebindDock);
    // Controlling a token makes the dock follow that token's actor
    // (getAssignedActor), so the economy runs on the document combat tracks.
    Hooks.on("controlToken", scheduleRebindDock);

    console.log(`${MODULE_ID} | chrome ready`);
}
