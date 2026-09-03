/**
 * registerSettings — registers world/client settings during `init`.
 *
 * Homebrew toggles (ADR 0003): one boolean world setting per entry in
 * `WITCHER.HOMEBREW`. Iterated automatically so adding a homebrew feature
 * just requires adding it to the enum in config.mjs.
 *
 * Setting key convention: `homebrew.<featureKey>` so the GM-facing
 * "Configure Settings" panel groups them together by name.
 */

import { HOMEBREW } from "./config.mjs";
import { QualitiesEditor } from "../applications/qualitiesEditor.mjs";
import { StatusEffectsEditor } from "../applications/statusEffectsEditor.mjs";
import { HomebrewContentEditor } from "../applications/homebrewContentEditor.mjs";
import { WeatherConfigApp } from "../applications/weatherConfig.mjs";
import { StealthConfigApp } from "../applications/stealthConfig.mjs";
import { STEALTH_CONFIG_DEFAULTS, STEALTH_CONFIG_KEY } from "../mechanics/stealth-config.mjs";
import { CAROUSEL_CONFIG_DEFAULTS, CAROUSEL_CONFIG_KEY } from "../mechanics/carousel-initiative-config.mjs";
import { HouseRulesConfigApp } from "../applications/houseRulesConfig.mjs";
import { CarouselInitiativeConfigApp } from "../applications/carouselInitiativeConfig.mjs";
import { HOUSE_RULES_CONFIG_DEFAULTS, HOUSE_RULES_CONFIG_KEY } from "../mechanics/house-rules-config.mjs";
import { UiCustomizerConfigApp } from "../applications/uiCustomizerConfig.mjs";
import { UI_CUSTOMIZER_WORLD_KEY, UI_CUSTOMIZER_CLIENT_KEY, UI_CUSTOMIZER_DEFAULTS, applyUiCustomizer } from "../mechanics/ui-customizer.mjs";
import { RARITY_COLORS_KEY, applyRarityColors } from "../mechanics/rarity-colors.mjs";
import { SceneDefaultsLauncher } from "../applications/sceneDefaultsConfig.mjs";
import { FoodAndDrinkConfigApp, FOOD_AND_DRINK_CONFIG_DEFAULTS } from "../applications/foodAndDrinkConfig.mjs";
import { StressConfigApp } from "../applications/stressConfig.mjs";
import { STRESS_CONFIG_DEFAULTS } from "../mechanics/stress.mjs";
import { BookConfigApp, BOOK_SYSTEM_CONFIG_DEFAULTS } from "../applications/bookConfig.mjs";
import { STATUS_OVERRIDE_SETTING, invalidateStatusClauseCache } from "../mechanics/statusOverrides.mjs";
import { CombatActionsEditor } from "../applications/combatActionsEditor.mjs";
import { registerWelcomeSetting } from "./welcomeDialog.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";

export function registerSettings() {
    registerWelcomeSetting();
    for (const [key, meta] of Object.entries(HOMEBREW)) {
        game.settings.register(SYSTEM_ID, `homebrew.${key}`, {
            name: `WITCHER.Settings.Homebrew.${key}.Name`,
            hint: `WITCHER.Settings.Homebrew.${key}.Hint`,
            scope: "world",
            // "rule"       → inline in the main settings list (config:true)
            // "content"    → hidden from main list; shown in Homebrew Content editor
            // "houseRule"  → hidden from both; surfaced only by HouseRulesConfigApp
            config: meta.kind === "rule",
            type: Boolean,
            default: meta.defaultOn,
            requiresReload: true
        });
    }

    /* Adrenaline optional rule (Core p.175-176). Master toggle: OFF removes
     * adrenaline from the actor sheet, chrome UI, combat dock, and weapon
     * macros. requiresReload because the chrome dock + injected panels read
     * this once at ready to decide whether to render the counter at all. */
    game.settings.register(SYSTEM_ID, "adrenalineEnabled", {
        name: "WITCHER.Settings.AdrenalineEnabled.Name",
        hint: "WITCHER.Settings.AdrenalineEnabled.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        requiresReload: true
    });

    /* Stamina spent per adrenaline die (RAW default 10, Core p.176). Only
     * meaningful while adrenalineEnabled is on. */
    game.settings.register(SYSTEM_ID, "adrenalineStaPerDie", {
        name: "WITCHER.Settings.AdrenalineStaPerDie.Name",
        hint: "WITCHER.Settings.AdrenalineStaPerDie.Hint",
        scope: "world",
        config: true,
        type: Number,
        default: 10
    });

    /* In-world calendar override. Empty object = use the seed Witcher
     * calendar (WITCHER_CALENDAR_CONFIG). A GM-edited calendar is stored
     * here and consumed by registerCalendar() during init. requiresReload
     * because game.time builds its calendar once at startup. */
    game.settings.register(SYSTEM_ID, "calendarConfig", {
        scope: "world",
        config: false,
        type: Object,
        default: {},
        requiresReload: true
    });

    /* Master switch for the inbuilt time/weather widget. OFF lets a GM run an
     * external calendar/weather module instead: the topbar strip and its panel
     * are suppressed and we stop overriding CONFIG.time.worldCalendarClass, so
     * another module (or Foundry's default calendar) owns the calendar. Combat
     * pacing (roundTime/turnTime) and all worldTime-driven duration timers —
     * oils, status effects, potions — keep working regardless, since they read
     * native game.time.worldTime, not our calendar or weather. requiresReload
     * because the calendar class is bound once at startup. */
    game.settings.register(SYSTEM_ID, "weatherEnabled", {
        name: "WITCHER.Settings.WeatherEnabled.Name",
        hint: "WITCHER.Settings.WeatherEnabled.Hint",
        scope: "world",
        config: false,   // surfaced in WeatherConfigApp's General tab
        type: Boolean,
        default: true,
        requiresReload: true
    });

    /* Auto scene darkness — drive the viewed scene's darkness level from the
     * calendar's dawn/dusk (plus weather dimming). GM-only writes. Gated also
     * behind weatherEnabled. No reload: takes effect on the next world-time
     * tick / scene load (see scene-fx.mjs wiring). */
    game.settings.register(SYSTEM_ID, "autoSceneDarkness", {
        name: "WITCHER.Settings.AutoSceneDarkness.Name",
        hint: "WITCHER.Settings.AutoSceneDarkness.Hint",
        scope: "world",
        config: false,   // surfaced in WeatherConfigApp's General tab
        type: Boolean,
        default: true
    });

    /* Auto weather FX — set the viewed scene's particle weather (rain / snow /
     * blizzard / fog) from the inbuilt weather tags. GM-only writes; gated also
     * behind weatherEnabled. */
    game.settings.register(SYSTEM_ID, "autoWeatherFx", {
        name: "WITCHER.Settings.AutoWeatherFx.Name",
        hint: "WITCHER.Settings.AutoWeatherFx.Hint",
        scope: "world",
        config: false,   // surfaced in WeatherConfigApp's General tab
        type: Boolean,
        default: true
    });

    /* Weather ambience automation. When ON, the primary GM drives a "Weather"
     * Playlist (Foundry jukebox, environment channel) whose looping stems track
     * the active weather. World-scoped: it's GM automation, and the synced
     * playlist plays for everyone — players adjust loudness with the built-in
     * environment volume slider, so there's no per-client volume setting. */
    game.settings.register(SYSTEM_ID, "weatherSound", {
        name: "WITCHER.Settings.WeatherSound.Name",
        hint: "WITCHER.Settings.WeatherSound.Hint",
        scope: "world",
        config: false,   // surfaced in WeatherConfigApp's General tab
        type: Boolean,
        default: true
    });

    /* Thunderclaps during a Lightning Storm (CC0 samples, procedural-synth
     * fallback). Client-scoped so each player can mute it locally. */
    game.settings.register(SYSTEM_ID, "weatherThunder", {
        name: "WITCHER.Settings.WeatherThunder.Name",
        hint: "WITCHER.Settings.WeatherThunder.Hint",
        scope: "client",
        config: false,   // surfaced in WeatherConfigApp's General tab (per-client section)
        type: Boolean,
        default: true
    });

    /* GM debug readout: append a numeric tier badge (e.g. "[cloud 2 · snow 1 ·
     * wind 0]") next to each composed weather label in the weather console, so
     * the GM can see WHICH intensity each layer is running at. Client-scoped —
     * it's a GM-side view aid, never shown to players. */
    game.settings.register(SYSTEM_ID, "weatherDebug", {
        name: "WITCHER.Settings.WeatherDebug.Name",
        hint: "WITCHER.Settings.WeatherDebug.Hint",
        scope: "client",
        config: false,   // surfaced in WeatherConfigApp's General tab (GM-only)
        type: Boolean,
        default: false
    });

    /* Particle budget for the canvas weather renderer. Lower it on weak
     * hardware. Client-scoped (a render-cost knob, not a world rule). */
    game.settings.register(SYSTEM_ID, "weatherMaxParticles", {
        name: "WITCHER.Settings.WeatherMaxParticles.Name",
        hint: "WITCHER.Settings.WeatherMaxParticles.Hint",
        scope: "client",
        config: false,   // surfaced in WeatherConfigApp's General tab (per-client section)
        type: Number,
        default: 2000
    });

    /* Weather climate ("biome") driving the inbuilt weather engine. Selects
     * which CLIMATES profile generateWeather uses. World-scoped so all clients
     * see the same deterministic weather. */
    game.settings.register(SYSTEM_ID, "weatherBiome", {
        name: "WITCHER.Settings.WeatherBiome.Name",
        hint: "WITCHER.Settings.WeatherBiome.Hint",
        scope: "world",
        config: false,   // surfaced in WeatherConfigApp's General tab
        type: String,
        choices: {
            temperate: "WITCHER.Weather.Climate.temperate",
            highland: "WITCHER.Weather.Climate.highland",
            coastal: "WITCHER.Weather.Climate.coastal",
            arid: "WITCHER.Weather.Climate.arid"
        },
        default: "temperate"
    });

    /* GM manual weather override. `{ enabled, cloud, precip, special, wind, fog }`
     * — each layer holds a state id (see manual-weather.mjs WEATHER_LAYERS) or "".
     * When `enabled`, getActiveWeather composes these instead of the
     * deterministic engine. Not config-visible; edited from the GM weather panel. */
    game.settings.register(SYSTEM_ID, "manualWeather", {
        scope: "world",
        config: false,
        type: Object,
        default: { enabled: false, cloud: "", precip: "", special: "", wind: "", fog: "" }
    });

    /* Running clock: game-seconds advanced per real second while the game is
     * unpaused. The primary GM drives it and the advance broadcasts to all
     * clients (see mechanics/time-flow.mjs). Default 1 = real time (1 in-world
     * second per real second). Raise it for a faster narrative clock (e.g. 60 =
     * one in-world minute per real second). 0 freezes the clock — worldTime then
     * only moves via combat or the panel's manual buttons. */
    game.settings.register(SYSTEM_ID, "timeFlowRate", {
        name: "WITCHER.Settings.TimeFlowRate.Name",
        hint: "WITCHER.Settings.TimeFlowRate.Hint",
        scope: "world",
        config: false,   // surfaced in WeatherConfigApp's General tab
        type: Number,
        default: 1
    });

    /* GM-toggled freeze on the running clock. Independent of Foundry's global
     * `game.paused` so pausing the clock doesn't also pause sounds/animations.
     * Read by mechanics/time-flow.mjs's shouldFlow(); toggled from the
     * WeatherControlApp Time tab and displayed on the topbar weather strip. */
    game.settings.register(SYSTEM_ID, "clockPaused", {
        scope: "world",
        config: false,
        type: Boolean,
        default: false
    });

    /* Per-daypart forecast pins, keyed
     *   weatherPins[absDay][daypartKey] = { cloud, precip, special, wind, fog }
     * See mechanics/weather-pins.mjs for reads/writes and applyDaypartPins()
     * which the engine calls to substitute pinned dayparts. Only stores
     * explicitly pinned entries; missing keys fall through to the engine. */
    game.settings.register(SYSTEM_ID, "weatherPins", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    /* Scene units per SPD point — how many canvas/scene-grid distance units
     * equal one point of SPD when charging the movement budget from a token
     * drag. Default 1 (Witcher RAW: 1 SPD = 1m, scene grid in meters).
     *
     * Examples:
     *   - Scene uses meters, 1 SPD = 1 m   → set 1  (RAW)
     *   - Scene uses feet,   1 SPD ≈ 3 ft  → set 3
     *   - Scene uses feet,   1 SPD = 5 ft  → set 5  (hex-board convention)
     *
     * canvas-movement.mjs reads this when converting a token drag's measured
     * grid distance into SPD-equivalent meters: `meters = sceneDist / unitsPerSpd`.
     */
    game.settings.register(SYSTEM_ID, "spdUnitsPerPoint", {
        name: "WITCHER.Setup.Settings.Text.SceneUnitsPerSPDPoint",
        hint: "WITCHER.Setup.Settings.Hint.SpdUnitsPerPoint",
        scope: "world",
        config: true,
        type: Number,
        default: 1
    });

    /* World-scope camera lock. GM-only toggle that applies globally:
     * flipping it ON puts every client into the immersive camera on
     * their OWN controlled token (each player sees their own PC
     * centered; the GM sees whichever token they've selected). Kept
     * as scope:"world" so Foundry blocks non-GM writes automatically,
     * and the GM's combat-tracker button broadcasts the change to all
     * clients through the standard settings-change socket. */
    game.settings.register(SYSTEM_ID, "immersiveTokenCamera", {
        name: "WITCHER.Setup.Settings.Text.ImmersiveTokenCamera",
        hint: "WITCHER.Setup.Settings.Hint.ImmersiveTokenCamera",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: () => {
            import("../policy/immersive-token-camera.mjs")
                .then(m => m.refreshImmersiveTokenCamera?.())
                .catch(() => {});
        }
    });

    /* FOV Token Hide — standalone GM view toggle (not tied to immersive
     * mode), driven by the combat-tracker button (config:false so it stays
     * out of the settings panel). Default true keeps Foundry's native FOV
     * culling; OFF lets a GM see tokens outside the selected token's field
     * of view. See policy/gm-fov-token-hide.mjs. */
    game.settings.register(SYSTEM_ID, "fovTokenHide", {
        scope: "client",
        config: false,
        type: Boolean,
        default: true,
        onChange: () => {
            import("../policy/gm-fov-token-hide.mjs")
                .then(m => m.refreshFovTokenHide?.())
                .catch(() => {});
        }
    });

    /* GM Off-Turn Move override (client scope; combat-tracker button, so
     * config:false keeps it out of the settings panel). Default false keeps
     * normal turn-gating — off-turn combatant tokens are locked. ON lets a GM
     * drag any combatant's token regardless of whose turn it is, spending no
     * budget. See policy/gm-offturn-move.mjs. */
    game.settings.register(SYSTEM_ID, "gmOffTurnMove", {
        scope: "client",
        config: false,
        type: Boolean,
        default: false
    });

    /* GM-local Immersive Token Camera UNLOCK (client scope; driven by the
     * combat-tracker button, config:false). This is NOT the global enable —
     * that's the world-scope `immersiveTokenCamera` above. This is a per-GM,
     * per-client temporary override: ON = this GM steps out of the immersive
     * clamps (free camera to run the battle) while players stay immersive per
     * the world setting. Default false = GM stays immersive. Read by
     * immersive-token-camera.mjs `isEnabled()`. */
    game.settings.register(SYSTEM_ID, "immersiveGmUnlock", {
        scope: "client",
        config: false,
        type: Boolean,
        default: false,
        onChange: () => {
            import("../policy/immersive-token-camera.mjs")
                .then(m => m.refreshImmersiveTokenCamera?.())
                .catch(() => {});
        }
    });

    /* Sub-toggle for the bottom-of-screen control-hint tooltip that
     * lists the two immersive-camera keybindings (Esc / Shift+A/D).
     * Independent of the base immersive setting: a GM who wants
     * immersive on but the hint hidden can turn just this off. Default
     * true to match the tooltip's out-of-the-box behavior. `client`
     * scope because a player's aesthetic preference shouldn't force
     * everyone else at the table. */
    game.settings.register(SYSTEM_ID, "immersiveTokenCameraShowHint", {
        name: "WITCHER.Setup.Settings.Text.ImmersiveTokenCameraShowHint",
        hint: "WITCHER.Setup.Settings.Hint.ImmersiveTokenCameraShowHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: () => {
            import("../policy/immersive-token-camera.mjs")
                .then(m => m.refreshImmersiveTokenCamera?.())
                .catch(() => {});
        }
    });

    /* Farkle table — the live, shared gambling-table state (lobby + match
     * descriptor). `null` = no table open. The GM is the sole writer; players
     * request seat/config changes through the GM socket proxy (lobby.mjs), and
     * every client reacts to the `updateSetting` hook to render/refresh the
     * lobby. Homebrew-gated on `farkleTable`. */
    game.settings.register(SYSTEM_ID, "farkleTable", {
        scope: "world",
        config: false,
        type: Object,
        default: null
    });

    /* Dice poker table — the live, shared dice-poker-table state (lobby + match
     * descriptor), the analogue of `farkleTable`. `null` = no table open. Same
     * GM-authoritative socket-proxy model. Homebrew-gated on `dicePokerTable`. */
    game.settings.register(SYSTEM_ID, "dicePokerTable", {
        scope: "world",
        config: false,
        type: Object,
        default: null
    });

    /* Last stake currency picked at each gambling table, so a fresh table opens
     * on the denomination the GM used last instead of always resetting to crown.
     * World-scoped (the table is GM-authoritative; the GM owns the choice) and
     * persists across table close/reopen, which wipe the *Table settings above. */
    game.settings.register(SYSTEM_ID, "farkleLastDenom", {
        scope: "world",
        config: false,
        type: String,
        default: "crown"
    });
    game.settings.register(SYSTEM_ID, "dicePokerLastDenom", {
        scope: "world",
        config: false,
        type: String,
        default: "crown"
    });

    // Internal: legacy migration version. Not user-visible.
    game.settings.register(SYSTEM_ID, "migrationVersion", {
        scope: "world",
        config: false,
        type: Number,
        default: 0
    });

    /* Weapon / armor quality catalogs — the live catalog the system uses
     * at runtime. Stored as plain object maps (same shape as the seed
     * defaults). An empty object means "use the seed catalog from
     * config.mjs". Edited through the QualitiesEditor menu (below). */
    game.settings.register(SYSTEM_ID, "weaponQualitiesOverride", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });
    game.settings.register(SYSTEM_ID, "armorQualitiesOverride", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    /* Status-effect overrides — the GM's edits to the RAW status catalog
     * (renames, re-icons, retuned clauses, removals, and custom statuses),
     * merged over the defaults by mechanics/statusOverrides.mjs. An empty
     * object means "pure RAW defaults". Edited through the StatusEffectsEditor
     * menu (below). requiresReload so CONFIG.statusEffects + the token-HUD list
     * rebuild cleanly from init after a save. */
    game.settings.register(SYSTEM_ID, STATUS_OVERRIDE_SETTING, {
        scope: "world",
        config: false,
        type: Object,
        default: {},
        requiresReload: true,
        onChange: () => invalidateStatusClauseCache()
    });

    /* GM override for the per-tag weather modifier table (penalties applied by
     * fog/wind/precip/snow/storm/heat/aurora). Empty object = use the seed
     * table (WEATHER_MODIFIER_RULES). Edited through the Weather & Calendar
     * config panel's Penalties tab. */
    game.settings.register(SYSTEM_ID, "weatherModifiersOverride", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    /* GM override for the per-tier LIGHT-level penalties (Dim/Darkness/Pitch →
     * Awareness/Attack/Defense). Empty object = use the LIGHT_TIER_PENALTY seed in
     * mechanics/light-level.mjs. Edited through the Weather & Calendar config panel
     * (Light tab). */
    game.settings.register(SYSTEM_ID, "lightPenaltiesOverride", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    /* GM override for the climate ("biome") profiles. Empty object = use the
     * seed CLIMATES from weather.mjs. Patches per-biome fields and may add new
     * biomes. Edited through the Weather & Calendar config panel. */
    game.settings.register(SYSTEM_ID, "climateConfig", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    /* GM-defined terrain types (landsites) used by the weather engine and the
     * paintable weather map. Empty object = use the seed catalog in terrain.mjs.
     * Edited through the Weather & Calendar config panel. */
    game.settings.register(SYSTEM_ID, "terrainConfig", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    /* GM override for the per-season shifts (temp + wet/wind/cloud bias + aurora)
     * the weather engine applies. Empty object = use the seed SEASONS table in
     * weather.mjs. Edited through the Weather & Calendar config panel. */
    game.settings.register(SYSTEM_ID, "seasonConfig", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    /* World latitude warmth offset (°C) added to every biome mean — the campaign
     * region on the Continent's north→south gradient (Kovir ↔ Ofir). 0 = the
     * Northern Kingdoms heartland the biomes are tuned for. Edited through the
     * Weather & Calendar config panel. Will become per-location on the painted
     * world map. */
    game.settings.register(SYSTEM_ID, "regionBaseline", {
        scope: "world",
        config: false,
        type: Number,
        default: 0
    });

    /* Spatial weather: the GM-designated world-map scene whose painted terrain and
     * party marker drive multi-region weather. Empty = no spatial map (the engine
     * uses the single global biome + center latitude, i.e. the prior behaviour).
     * Edited from the Weather & Calendar config panel. */
    game.settings.register(SYSTEM_ID, "weatherMapScene", {
        scope: "world",
        config: false,
        type: String,
        default: ""
    });

    /* Edge-to-edge latitude temperature spread (°C) across the world map's N–S
     * extent (north colder, south warmer). 0 disables the latitude gradient.
     * Default mirrors the engine's LAT_SPAN. Edited from the config panel. */
    game.settings.register(SYSTEM_ID, "latitudeSpan", {
        scope: "world",
        config: false,
        type: Number,
        default: 12
    });

    /* Days a weather front takes to cross the map west→east. Larger = slower,
     * broader fronts. Default mirrors the engine's SWEEP_DAYS. Edited from the
     * config panel. */
    game.settings.register(SYSTEM_ID, "frontSweepDays", {
        scope: "world",
        config: false,
        type: Number,
        default: 3
    });

    /* Per-month / per-day weather reroll seeds. The engine is a pure function of
     * the day index, so "regenerate" means mixing a seed into the noise: a seeded
     * month/day samples a different deterministic draw while everything else is
     * untouched. Shape: { months: { "<year>-<month0>": seed }, days: { <absDay>: seed } }.
     * Empty object = the canonical (unseeded) weather everywhere. GM-only, set
     * from the weather console's Calendar tab. */
    game.settings.register(SYSTEM_ID, "weatherSeeds", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    /* Settings menu — appears in the GM's Configure Settings panel
     * under the system section. Opens the QualitiesEditor app where
     * the GM can edit, add, or remove weapon and armor qualities. */
    game.settings.registerMenu(SYSTEM_ID, "qualitiesEditor", {
        name: "WITCHER.Setup.Settings.Text.WeaponArmorQualities",
        label: "WITCHER.Setup.Settings.Dialog.Button.EditQualities",
        hint: "WITCHER.Setup.Settings.Hint.QualitiesEditor",
        icon: "fa-solid fa-list-check",
        type: QualitiesEditor,
        restricted: true
    });

    /* Settings menu — the Status Effects editor. Friendly, per-status form
     * (no JSON) to retune what each RAW condition DOES, rename/re-icon it,
     * remove it, or add a custom status. Writes statusEffectsOverride. */
    game.settings.registerMenu(SYSTEM_ID, "statusEffectsEditor", {
        name: "WITCHER.Setup.Settings.Text.StatusEffects",
        label: "WITCHER.Setup.Settings.Dialog.Button.EditStatusEffects",
        hint: "WITCHER.Setup.Settings.Hint.StatusEffectsEditor",
        icon: "fa-solid fa-heart-crack",
        type: StatusEffectsEditor,
        restricted: true
    });

    /* Settings menu — the Homebrew Content editor. Only "rule"-kind toggles
     * (extendedCombat) stay inline in the main list; the added-content
     * toggles (book system, stress, food & drink, the two gambling tables,
     * merchant) are config:false and live here. The "houseRule"-kind toggles
     * (splitMovement, rawToxicity) are surfaced in the House Rules config
     * menu — see HouseRulesConfigApp. GM-only. */
    /* Food & Drink config — the numeric knobs (decay rate, hunger tier
     * thresholds, drunk-tier metadata). Stored as one Object setting and
     * edited through FoodAndDrinkConfigApp. The setting itself is always
     * registered so values survive a toggle flip; the MENU is only added to
     * the Configure Settings panel when foodAndDrink is currently on, which
     * means a pure-RAW world doesn't see the entry. requiresReload because
     * the satiety tick / drunk roll code reads the config at load time. */
    game.settings.register(SYSTEM_ID, "foodAndDrinkConfig", {
        scope: "world",
        config: false,
        type: Object,
        default: FOOD_AND_DRINK_CONFIG_DEFAULTS,
        requiresReload: true
    });
    if (game.settings.get(SYSTEM_ID, "homebrew.foodAndDrink")) {
        game.settings.registerMenu(SYSTEM_ID, "foodAndDrinkConfig", {
            name: "WITCHER.Setup.Settings.Text.FoodDrinkConfiguration",
            label: "WITCHER.Setup.Settings.Dialog.Button.ConfigureFoodDrink",
            hint: "WITCHER.Setup.Settings.Hint.FoodAndDrinkConfig",
            icon: "fa-solid fa-utensils",
            type: FoodAndDrinkConfigApp,
            restricted: true
        });
    }

    /* Stress config — numeric tunables + system-wide toggles for the stress
     * homebrew. Same pattern as Food & Drink: setting is always registered
     * so values survive a toggle flip; the menu only appears when stress
     * is currently on. requiresReload because consumers read the config
     * during init paths (runStressCheck, healSheetMixin, wound-stress hook). */
    game.settings.register(SYSTEM_ID, "stressConfig", {
        scope: "world",
        config: false,
        type: Object,
        default: STRESS_CONFIG_DEFAULTS,
        requiresReload: true
    });
    if (game.settings.get(SYSTEM_ID, "homebrew.stress")) {
        game.settings.registerMenu(SYSTEM_ID, "stressConfig", {
            name: "WITCHER.Setup.Settings.Text.StressConfiguration",
            label: "WITCHER.Setup.Settings.Dialog.Button.ConfigureStress",
            hint: "WITCHER.Setup.Settings.Hint.StressConfig",
            icon: "fa-solid fa-brain",
            type: StressConfigApp,
            restricted: true
        });
    }

    /* Book system config — reading-cooldown tunables for the book homebrew.
     * Same pattern as stress: setting always registered so values survive a
     * toggle flip; the menu only appears when the book system is currently on.
     * requiresReload because the book chrome caches these on its next read
     * path and a live-changed cooldown shouldn't apply mid-session. */
    game.settings.register(SYSTEM_ID, "bookSystemConfig", {
        scope: "world",
        config: false,
        type: Object,
        default: BOOK_SYSTEM_CONFIG_DEFAULTS,
        requiresReload: true
    });
    if (game.settings.get(SYSTEM_ID, "homebrew.bookSystem")) {
        game.settings.registerMenu(SYSTEM_ID, "bookSystemConfig", {
            name: "WITCHER.Setup.Settings.Text.BookConfiguration",
            label: "WITCHER.Setup.Settings.Dialog.Button.ConfigureBooks",
            hint: "WITCHER.Setup.Settings.Hint.BookConfig",
            icon: "fa-solid fa-book",
            type: BookConfigApp,
            restricted: true
        });
    }

    /* Combat Extended — combat-actions override map. Always registered so
     * GM edits survive a toggle flip; the editor menu is only attached to
     * the Configure Settings panel when extendedCombat is currently on.
     * No requiresReload — getActiveCombatActions() reads the live setting
     * on every call so changes propagate to the next attack/defense roll. */
    game.settings.register(SYSTEM_ID, "combatActionsOverride", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });
    /* Combat Extended — per-subsystem toggle map. GM can switch off any
     * single subsystem (guards / raiseShield / actionCosts / defenseCosts)
     * without disabling the whole CE suite. Missing keys default to true
     * (see isCESubsystemEnabled). Edited through the Combat Actions
     * editor's Subsystems section. */
    game.settings.register(SYSTEM_ID, "combatExtendedSubsystems", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });
    /* Combat Extended — secondary tuneable knobs (defense recurrence on/off,
     * raise-shield auto-balance, head-cover Restricted Vision, etc.).
     * Missing keys fall back to CE_TUNEABLE_DEFAULTS. Persisted as an
     * Object so the editor can round-trip the diff. */
    game.settings.register(SYSTEM_ID, "combatExtendedTuneables", {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });
    if (game.settings.get(SYSTEM_ID, "homebrew.extendedCombat")) {
        game.settings.registerMenu(SYSTEM_ID, "combatActionsEditor", {
            name:  "WITCHER.CombatExtended.ActionsEditor.Name",
            label: "WITCHER.CombatExtended.ActionsEditor.Title",
            hint:  "WITCHER.CombatExtended.ActionsEditor.Hint",
            icon:  "fa-solid fa-burst",
            type:  CombatActionsEditor,
            restricted: true
        });
    }

    game.settings.registerMenu(SYSTEM_ID, "homebrewContent", {
        name: "WITCHER.Setup.Settings.Text.HomebrewContent",
        label: "WITCHER.Setup.Settings.Dialog.Button.ManageHomebrewContent",
        hint: "WITCHER.Setup.Settings.Hint.HomebrewContent",
        icon: "fa-solid fa-flask-vial",
        type: HomebrewContentEditor,
        restricted: true
    });

    /* Settings menu — the single home for ALL weather/time configuration.
     * General tab: the simple toggles & knobs (enabled, automation, climate,
     * clock speed, per-client display) that used to clutter the System tab.
     * Further tabs let the GM tune biomes, seasons, terrain, penalties, and the
     * calendar's daylight/moon through friendly forms (no JSON). Also reachable
     * from the GM weather panel's "Configure" button.
     *
     * NOT restricted: players need it to reach their per-client display knobs
     * (thunder, particle budget). The GM-only tabs are hidden from non-GMs and
     * world settings are written only when the editor is the GM. */
    /* Settings menu — "Default Scene Settings". Opens the hidden template scene
     * in the native SceneConfig; its settings seed every new blank scene (see
     * policy/scene-defaults.mjs). A DEFAULT, not a global override. */
    game.settings.registerMenu(SYSTEM_ID, "sceneDefaults", {
        name: "WITCHER.Settings.SceneDefaults.MenuName",
        label: "WITCHER.Settings.SceneDefaults.MenuLabel",
        hint: "WITCHER.Settings.SceneDefaults.MenuHint",
        icon: "fa-solid fa-map",
        type: SceneDefaultsLauncher,
        restricted: true
    });

    game.settings.registerMenu(SYSTEM_ID, "weatherConfig", {
        name: "WITCHER.Weather.Config.MenuName",
        label: "WITCHER.Weather.Config.MenuLabel",
        hint: "WITCHER.Weather.Config.MenuHint",
        icon: "fa-solid fa-sliders",
        type: WeatherConfigApp,
        restricted: false
    });

    /* Token Stealth — one Object payload covering the entire stealth
     * subsystem's tunables (range bands, sight distance, cross-level
     * toggle, debug output, cone rendering options, master enable).
     * Consumers read via `getStealthConfig()` on every check so GM
     * edits take effect without a reload for most fields; the master
     * `enabled` toggle also flips cleanly at runtime by gating each
     * consumer's entry point on the current value. */
    game.settings.register(SYSTEM_ID, STEALTH_CONFIG_KEY, {
        scope: "world",
        config: false,
        type: Object,
        default: foundry.utils.deepClone(STEALTH_CONFIG_DEFAULTS)
    });
    game.settings.registerMenu(SYSTEM_ID, "stealthConfig", {
        name:  "WITCHER.Settings.StealthConfig.MenuName",
        label: "WITCHER.Settings.StealthConfig.MenuLabel",
        hint:  "WITCHER.Settings.StealthConfig.MenuHint",
        icon:  "fa-solid fa-user-ninja",
        type:  StealthConfigApp,
        restricted: true
    });

    /* House Rules — one Object payload covering global combat-mechanic
     * tunables (strike restrictions, crit-wound SP downgrade, action-
     * economy costs, strong-strike + off-hand penalties). Per-actor
     * Active Effect overrides still layer on top; this sets the
     * WORLD-WIDE baseline. Consumers read via the `hr*` getters in
     * mechanics/house-rules-config.mjs so live edits take effect on
     * the next check without a reload. */
    game.settings.register(SYSTEM_ID, HOUSE_RULES_CONFIG_KEY, {
        scope: "world",
        config: false,
        type: Object,
        default: foundry.utils.deepClone(HOUSE_RULES_CONFIG_DEFAULTS)
    });
    game.settings.registerMenu(SYSTEM_ID, "houseRulesConfig", {
        name:  "WITCHER.Settings.HouseRulesConfig.MenuName",
        label: "WITCHER.Settings.HouseRulesConfig.MenuLabel",
        hint:  "WITCHER.Settings.HouseRulesConfig.MenuHint",
        icon:  "fa-solid fa-scale-balanced",
        type:  HouseRulesConfigApp,
        restricted: true
    });

    /* UI Customizer — two theme payloads. The world theme is the GM's base
     * (everyone inherits it); the client theme is each player's personal
     * per-key override layered on top. Both onChange-reapply the injected
     * `<style>` live, so GM world edits propagate to every client and a
     * player's own tweak lands without a reload. The menu is unrestricted so
     * players can open it to edit their PERSONAL theme; the app itself gates
     * the world scope to the GM. See mechanics/ui-customizer.mjs. */
    game.settings.register(SYSTEM_ID, UI_CUSTOMIZER_WORLD_KEY, {
        scope: "world",
        config: false,
        type: Object,
        default: foundry.utils.deepClone(UI_CUSTOMIZER_DEFAULTS),
        onChange: () => applyUiCustomizer()
    });
    game.settings.register(SYSTEM_ID, UI_CUSTOMIZER_CLIENT_KEY, {
        scope: "client",
        config: false,
        type: Object,
        default: foundry.utils.deepClone(UI_CUSTOMIZER_DEFAULTS),
        onChange: () => applyUiCustomizer()
    });
    game.settings.registerMenu(SYSTEM_ID, "uiCustomizer", {
        name:  "WITCHER.Settings.UiCustomizer.MenuName",
        label: "WITCHER.Settings.UiCustomizer.MenuLabel",
        hint:  "WITCHER.Settings.UiCustomizer.MenuHint",
        icon:  "fa-solid fa-palette",
        type:  UiCustomizerConfigApp,
        restricted: false
    });

    /* World-global rarity flair palette — GM-owned override of the
     * --wdm-rarity-* tier colours, edited in the UI Customizer's
     * "Inventory & Items" tab. See mechanics/rarity-colors.mjs. Defaults to an
     * empty map so the shipped tokens.css colours stand until the GM changes
     * them. */
    game.settings.register(SYSTEM_ID, RARITY_COLORS_KEY, {
        scope: "world",
        config: false,
        type: Object,
        default: {},
        onChange: () => applyRarityColors()
    });

    /* Canvas tile-targeting for token combat is now MANDATORY (no setting):
     * clicking a weapon in the combat dock always paints its range on the canvas
     * to pick a target tile, and canvas middle-click token targeting stays off.
     * See isTileTargetingEnabled() in policy/weapon-target-overlay.mjs. */

    /* Carousel Initiative — one Object payload covering the tracker's
     * enable/audience/context gates, layout dimensions, motion timing,
     * disposition colors, and privacy filters. Consumers read via
     * getCarouselConfig() on every carousel render so GM edits take
     * effect immediately; only the master `enabled` toggle needs a
     * reload (it gates hook registration at load time). */
    game.settings.register(SYSTEM_ID, CAROUSEL_CONFIG_KEY, {
        scope: "world",
        config: false,
        type: Object,
        default: foundry.utils.deepClone(CAROUSEL_CONFIG_DEFAULTS)
    });
    game.settings.registerMenu(SYSTEM_ID, "carouselInitiativeConfig", {
        name:  "WITCHER.Settings.CarouselInitiativeConfig.MenuName",
        label: "WITCHER.Settings.CarouselInitiativeConfig.MenuLabel",
        hint:  "WITCHER.Settings.CarouselInitiativeConfig.MenuHint",
        icon:  "fa-solid fa-people-arrows",
        type:  CarouselInitiativeConfigApp,
        restricted: true
    });
}

/**
 * registerCompendiumSettings — settings whose choices are the available
 * compendiums. Deferred to `setup` (not `init`) because `game.packs` is not
 * populated until then. Currently just the Critical Wounds source pack: the
 * crit-roll resolver (chrome/critical-roll.js) pulls wounds from whichever
 * Item compendium the GM assigns here, matched by location + severity +
 * lesser/greater — so a homebrew wound pack drops in without code changes.
 */
export function registerCompendiumSettings() {
    const itemPacks = game.packs
        .filter(p => p.documentName === "Item")
        .reduce((acc, p) => {
            acc[p.collection] = `${p.metadata.label} (${p.collection})`;
            return acc;
        }, {});

    game.settings.register(SYSTEM_ID, "criticalWoundsPack", {
        name: "WITCHER.Settings.CriticalWoundsPack.Name",
        hint: "WITCHER.Settings.CriticalWoundsPack.Hint",
        scope: "world",
        config: true,
        type: String,
        choices: { "": game.i18n.localize("WITCHER.Settings.CriticalWoundsPack.None"), ...itemPacks },
        default: `${SYSTEM_ID}.criticalWounds`
    });
}
