/**
 * Witcher TTRPG: Death March — system entry point.
 *
 * This file is the only ESM declared in `system.json` esmodules[]. Foundry
 * loads it once on startup; everything else hangs off the imports here.
 *
 * Init sequence:
 *   1. `init`  — attach CONFIG.WITCHER, register document classes, register
 *                TypeDataModels, register sheets, register Handlebars helpers,
 *                register settings.
 *   2. `setup` — wire recurring runtime hooks (combat, sheet render, etc.).
 *   3. `ready` — register socket listeners; expose `game.system.api`.
 *
 * Keep this file thin. Logic belongs in the imported modules.
 */

import { WitcherActor } from "./documents/actor.mjs";
import { WitcherItem } from "./documents/item.mjs";
import { WitcherActiveEffect } from "./documents/activeEffect.mjs";
import { WitcherCombat } from "./documents/combat.mjs";
import { WITCHER } from "./setup/config.mjs";
import { buildStatusEffects } from "./setup/statusEffects.mjs";
import { invalidateStatusClauseCache } from "./mechanics/statusOverrides.mjs";
import { registerDataModels } from "./setup/registerDataModels.mjs";
import { registerSheets } from "./setup/registerSheets.mjs";
import { registerHandlebars } from "./setup/handlebars.mjs";
import { registerSettings, registerCompendiumSettings } from "./setup/settings.mjs";
import { showWelcomeDialogIfEnabled } from "./setup/welcomeDialog.mjs";
import { registerCalendar } from "./setup/calendar.mjs";
import { registerSocket } from "./setup/socketHook.mjs";
import { registerMagicEngine, registerMagicHooks } from "./magic/register.mjs";
import { registerHooks } from "./setup/hooks.mjs";
import { isHomebrewEnabled } from "./api/homebrew.mjs";
import { wrHeroicApi } from "./mechanics/wrHeroic.mjs";
import { runLegacyMigration } from "./migrate/migrateLegacyFlags.mjs";
import { readBook } from "./mechanics/bookSystem.mjs";
import { stressApi }        from "./mechanics/stress.mjs";
import { foodAndDrinkApi }  from "./mechanics/foodAndDrink.mjs";
import { alchemyApi }       from "./mechanics/alchemy.mjs";
import { weatherApi }       from "./mechanics/weather.mjs";
import { weatherModifierApi } from "./mechanics/weather-modifiers.mjs";
import { manualWeatherApi }   from "./mechanics/manual-weather.mjs";
import { weatherConditionApi } from "./mechanics/weather-conditions.mjs";
import { terrainApi }          from "./mechanics/terrain.mjs";
import { weatherMapApi }        from "./mechanics/weather-map.mjs";
import { wireSceneFx, sceneFxApi } from "./mechanics/scene-fx.mjs";
import { wireTimeFlow } from "./mechanics/time-flow.mjs";
import { registerTerrainPaintLayer } from "./canvas/terrainPaintLayer.mjs";
import { registerSceneWeatherMode } from "./mechanics/scene-weather-mode.mjs";
import { registerSceneWeatherAudio } from "./mechanics/scene-weather-audio.mjs";
import WeatherAudioRegionBehaviorType, { WEATHER_AUDIO_BEHAVIOR } from "./data/region-behaviors/weather-audio.mjs";
import {
    wireChromeInit,
    wireChromeReady,
    openContainer,
    openContainerFloating
} from "./chrome/index.mjs";
import { openFarkle } from "./minigames/farkle/app.mjs";
import { registerFarkleNet, invitePlayer } from "./minigames/farkle/net.mjs";
import { registerFarkleLobby, openFarkleTable } from "./minigames/farkle/lobby.mjs";
import { registerDicePokerNet } from "./minigames/dicepoker/net.mjs";
import { registerDicePokerLobby } from "./minigames/dicepoker/lobby.mjs";
import { registerGamesControl } from "./minigames/games.mjs";
import { registerMerchantNet } from "./merchant/net.mjs";
import { registerMerchantCards } from "./canvas/merchantCards.mjs";
import { registerAdditiveTargeting } from "./policy/canvas-additive-targeting.mjs";
import { registerImmersiveKeybindings } from "./policy/immersive-token-camera.mjs";
import { installCompendiumSearchStrict } from "./policy/compendium-search-strict.mjs";
import { applyUiCustomizer } from "./mechanics/ui-customizer.mjs";
import { applyRarityColors } from "./mechanics/rarity-colors.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const log = (...args) => console.log(`${SYSTEM_ID} |`, ...args);

Hooks.once("init", () => {
    log("init");

    CONFIG.WITCHER = WITCHER;

    CONFIG.Actor.documentClass = WitcherActor;
    CONFIG.Item.documentClass = WitcherItem;
    CONFIG.ActiveEffect.documentClass = WitcherActiveEffect;
    /* Keeps the active turn on the current combatant when a higher-initiative
     * token joins mid-combat (Foundry's default lets the turn "jump"). */
    CONFIG.Combat.documentClass = WitcherCombat;


    CONFIG.Combat.initiative = { formula: "1d10", decimals: 0 };

    registerDataModels();
    registerSheets();
    registerSettings();

    // Status effects (Witcher-specific). Replaces Foundry's defaults. Built
    // AFTER registerSettings so buildStatusEffects can read the GM's
    // statusEffectsOverride; invalidate first to drop any defaults-only cache
    // populated while settings were still unregistered.
    invalidateStatusClauseCache();
    CONFIG.statusEffects = buildStatusEffects().map(s => ({ ...s }));
    // Calendar must follow settings (reads the GM override) and run before
    // game.time builds its live calendar.
    registerCalendar();
    registerHandlebars();

    // The spell engine's blocks must exist before any item sheet renders.
    registerMagicEngine();

    // Spatial weather: GM terrain paint layer + party marker (CONFIG.Canvas.layers).
    // Must register before the canvas first draws. GM-only controls.
    registerTerrainPaintLayer();

    // Merchant scene cards: GM drops a merchant actor on the canvas to place a
    // shop portrait; players click to browse. Registers its own ready/canvas
    // hooks, so it must run at init (before `ready` fires).
    registerMerchantCards();

    // Per-scene weather mode (indoor/off): injects the Scene-config buttons and
    // wires the local per-client ambience muffle/mute for the weather playlist.
    // Both just attach hook listeners; safe at init.
    registerSceneWeatherMode();
    registerSceneWeatherAudio();

    // Weather-audio region behavior: GM tags a region as indoor / off and
    // any client whose viewer token is inside gets the corresponding local
    // ambience shaping. Register the data model + label + icon on the core
    // RegionBehavior config so the behavior appears in the Region config
    // sheet's "Add Behavior" dropdown.
    CONFIG.RegionBehavior.dataModels[WEATHER_AUDIO_BEHAVIOR] = WeatherAudioRegionBehaviorType;
    CONFIG.RegionBehavior.typeLabels[WEATHER_AUDIO_BEHAVIOR] = "Weather Audio (Death March)";
    CONFIG.RegionBehavior.typeIcons[WEATHER_AUDIO_BEHAVIOR]  = "fa-solid fa-volume-low";

    // Chrome (overhaul-ui port) — register its settings, encounter hooks,
    // policy installers, and context menus during init. See
    // module/chrome/index.mjs for the orchestration contract.
    wireChromeInit();

    // T-key additive-target keybinding. Foundry rejects keybinding
    // registrations after `init` closes, so this MUST run here, not in
    // registerHooks() (which runs during `setup`).
    // See policy/canvas-additive-targeting.mjs.
    registerAdditiveTargeting();
    // WASD immersive-camera movement keybindings — same init constraint.
    // The hook installer for the camera itself still runs at `setup` via
    // registerImmersiveTokenCamera(). See policy/immersive-token-camera.mjs.
    registerImmersiveKeybindings();

    // Compendium search — strict entry-name matching. Foundry v14's default
    // cascades folder-name matches into all child entries, so searching a
    // pack for "sword" returns everything under a "Swords" folder even
    // when the child names don't match. See policy/compendium-search-strict.mjs.
    installCompendiumSearchStrict();

    /* Compendium browser resize handle. Foundry ships the Compendium
     * ApplicationV2 with `window.resizable` unset — inheriting the
     * ApplicationV2 default of `false` — so `_renderFrame` never
     * appends the `.window-resize-handle` grip. Users can't drag-resize
     * the pack browser, which is painful when a large compendium
     * (e.g. Death March's own equipment packs) overflows the default
     * 350×tall window. Flip the static DEFAULT_OPTIONS entry at init so
     * every subsequent Compendium instance picks it up on construction;
     * ApplicationV2 reads DEFAULT_OPTIONS via `mergeObject` at construct
     * time, so we don't need to touch already-open windows. */
    try {
        const Compendium = foundry?.applications?.sidebar?.apps?.Compendium;
        if (Compendium?.DEFAULT_OPTIONS?.window) {
            Compendium.DEFAULT_OPTIONS.window.resizable = true;
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | compendium resizable override failed`, err);
    }

    /* FilePicker resize handle. Same rationale as the Compendium override
     * above: Foundry's FilePicker ships as an ApplicationV2 with a fixed
     * default width (560) and no resize grip, so browsing a folder with
     * long filenames or lots of files overflows without any way to grow
     * the window. Flip `window.resizable` on the static DEFAULT_OPTIONS
     * at init so every subsequent FilePicker instance picks it up on
     * construction. */
    try {
        const FilePicker = foundry?.applications?.apps?.FilePicker?.implementation;
        if (FilePicker?.DEFAULT_OPTIONS?.window) {
            FilePicker.DEFAULT_OPTIONS.window.resizable = true;
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | file picker resizable override failed`, err);
    }
});

Hooks.once("setup", () => {
    log("setup");
    // If game.time built its calendar before our init ran, rebuild it now
    // against CONFIG.time (set in registerCalendar). No-op if already ours.
    if (!(game.time?.calendar instanceof CONFIG.time.worldCalendarClass)) {
        game.time?.initializeCalendar?.();
    }
    // Compendium-backed settings — game.packs is populated by now, so the
    // Critical Wounds pack picker can list the available Item compendiums.
    registerCompendiumSettings();
    registerHooks();
});

Hooks.once("ready", async () => {
    log("ready");
    registerSocket();
    registerMagicHooks();
    registerFarkleNet();
    registerFarkleLobby();
    registerDicePokerNet();
    registerDicePokerLobby();
    registerGamesControl();
    registerMerchantNet();

    game.system.api = {
        WITCHER,
        documents: { WitcherActor, WitcherItem, WitcherActiveEffect },
        homebrew: { isEnabled: isHomebrewEnabled },
        /* Witchers Reborn heroic actions — exposed here so a hotbar
         * macro can invoke Flow and Ebb / Lightning Fast with:
         *   game.system.api.wr.flowAndEbb(_token.actor);
         *   game.system.api.wr.lightningFast(_token.actor, 2);
         * The other heroics (Pirouette / Deadly Focus / Unrelenting /
         * Bulwark / Shield Mastery) are chat-card riders that surface
         * in-flow; no macro entry is needed for them. */
        wr: wrHeroicApi,
        // Headless alchemy helpers (Alchemy Reborn) — base reading,
        // ingredient potency/substance resolution, quality-from-potency,
        // craftWith entry point. Exposed at the top level (not under
        // mechanics) so the chrome wheel can delegate to
        // `game.system.api.alchemy.isBaseOfType` etc. without an extra
        // namespace layer. Pre-existing chrome code checks for the
        // function on this path and falls back to a local implementation
        // if absent, so this works the same with or without the wiring.
        alchemy: alchemyApi,
        mechanics: {
            readBook,
            stress: stressApi,
            foodAndDrink: foodAndDrinkApi,
            weather: Object.freeze({ ...weatherApi, ...weatherModifierApi, ...manualWeatherApi, ...weatherMapApi, ...weatherConditionApi }),
            terrain: terrainApi,
            sceneFx: sceneFxApi
        },
        // Chrome public surface. Container hotbar macros emitted by
        // wireChromeInit's hotbarDrop interceptor call into this.
        containers: { openContainer, openContainerFloating },
        minigames: { openFarkle, invitePlayer, openFarkleTable }
    };

    // One-shot legacy migration. Idempotent — sees a world-setting
    // version stamp and bails out if already current. See ADR 0002.
    // Awaited so the v2 flag-bag copy completes before chrome reads.
    try {
        await runLegacyMigration();
    } catch (err) {
        console.error("witcher-ttrpg-death-march | migration error", err);
    }

    // Chrome wire-up. Applies body class, injects topbar/dock/leftbar/etc,
    // wires dock-rebind hooks. Master `enabled` setting (in the chrome's
    // setup/settings.js) gates the entire chrome surface.
    wireChromeReady();

    // UI Customizer: inject the persisted world+personal theme override
    // (<style> in <head>). After wireChromeReady so the body.<system-id>
    // scope class the theme targets is already applied. No-op when neither
    // scope is enabled, so the shipped look is untouched by default.
    applyUiCustomizer();

    // Rarity flair palette: inject the GM's world-global --wdm-rarity-*
    // overrides (<style> in <head>). No-op when the palette is empty, so the
    // shipped tier colours stand by default.
    applyRarityColors();

    // Scene environment automation (Phase 4): drive scene darkness + weather
    // particle FX from the calendar/weather engine. No-op when the master
    // weatherEnabled switch is off. GM-only writes (handled internally).
    wireSceneFx();

    // Running clock: advance worldTime in real time while unpaused (primary GM
    // drives it, broadcasts to all clients). Frozen when timeFlowRate is 0.
    wireTimeFlow();

    // Once-per-client welcome dialog. Client-scope setting; a checkbox on
    // the dialog itself flips the same setting so the two entry points
    // stay in sync. Fire-and-forget — a dialog await here would block
    // any subsequent ready-time work if we added it later.
    showWelcomeDialogIfEnabled().catch(err => {
        console.warn("witcher-ttrpg-death-march | welcome dialog failed", err);
    });
});
