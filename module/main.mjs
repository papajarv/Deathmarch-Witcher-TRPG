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
import { WITCHER } from "./setup/config.mjs";
import { buildStatusEffects } from "./setup/statusEffects.mjs";
import { invalidateStatusClauseCache } from "./mechanics/statusOverrides.mjs";
import { registerDataModels } from "./setup/registerDataModels.mjs";
import { registerSheets } from "./setup/registerSheets.mjs";
import { registerHandlebars } from "./setup/handlebars.mjs";
import { registerSettings, registerCompendiumSettings } from "./setup/settings.mjs";
import { registerCalendar } from "./setup/calendar.mjs";
import { registerSocket } from "./setup/socketHook.mjs";
import { registerHooks } from "./setup/hooks.mjs";
import { isHomebrewEnabled } from "./api/homebrew.mjs";
import { runLegacyMigration } from "./migrate/migrateLegacyFlags.mjs";
import { readBook } from "./mechanics/bookSystem.mjs";
import { stressApi }        from "./mechanics/stress.mjs";
import { foodAndDrinkApi }  from "./mechanics/foodAndDrink.mjs";
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

const SYSTEM_ID = "witcher-ttrpg-death-march";
const log = (...args) => console.log(`${SYSTEM_ID} |`, ...args);

Hooks.once("init", () => {
    log("init");

    CONFIG.WITCHER = WITCHER;

    CONFIG.Actor.documentClass = WitcherActor;
    CONFIG.Item.documentClass = WitcherItem;
    CONFIG.ActiveEffect.documentClass = WitcherActiveEffect;


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

    // Chrome (overhaul-ui port) — register its settings, encounter hooks,
    // policy installers, and context menus during init. See
    // module/chrome/index.mjs for the orchestration contract.
    wireChromeInit();
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

    // Scene environment automation (Phase 4): drive scene darkness + weather
    // particle FX from the calendar/weather engine. No-op when the master
    // weatherEnabled switch is off. GM-only writes (handled internally).
    wireSceneFx();

    // Running clock: advance worldTime in real time while unpaused (primary GM
    // drives it, broadcasts to all clients). Frozen when timeFlowRate is 0.
    wireTimeFlow();
});
