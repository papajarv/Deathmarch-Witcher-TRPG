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
import { SceneDefaultsLauncher } from "../applications/sceneDefaultsConfig.mjs";
import { STATUS_OVERRIDE_SETTING, invalidateStatusClauseCache } from "../mechanics/statusOverrides.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

export function registerSettings() {
    for (const [key, meta] of Object.entries(HOMEBREW)) {
        game.settings.register(SYSTEM_ID, `homebrew.${key}`, {
            name: `WITCHER.Settings.Homebrew.${key}.Name`,
            hint: `WITCHER.Settings.Homebrew.${key}.Hint`,
            scope: "world",
            // House-rule toggles sit inline in the main settings list; content
            // toggles are config:false and live in the Homebrew Content menu.
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
        name: "Weapon & Armor Qualities",
        label: "Edit Qualities",
        hint: "Edit the catalog of weapon and armor qualities. Defaults seed from the Core Rulebook effect names; you can add, edit, or remove entries.",
        icon: "fa-solid fa-list-check",
        type: QualitiesEditor,
        restricted: true
    });

    /* Settings menu — the Status Effects editor. Friendly, per-status form
     * (no JSON) to retune what each RAW condition DOES, rename/re-icon it,
     * remove it, or add a custom status. Writes statusEffectsOverride. */
    game.settings.registerMenu(SYSTEM_ID, "statusEffectsEditor", {
        name: "Status Effects",
        label: "Edit Status Effects",
        hint: "Customize what each combat status does — damage-over-time, stat and roll penalties, action locks, ending checks — or add and remove statuses. Defaults are strict Core Rulebook RAW.",
        icon: "fa-solid fa-heart-crack",
        type: StatusEffectsEditor,
        restricted: true
    });

    /* Settings menu — the Homebrew Content editor. House-rule toggles
     * (extendedCombat, splitMovement) stay inline in the main list; the
     * added-content toggles (book system, stress, food & drink, the two
     * gambling tables, merchant) are config:false and live here. GM-only. */
    game.settings.registerMenu(SYSTEM_ID, "homebrewContent", {
        name: "Homebrew Content",
        label: "Manage Homebrew Content",
        hint: "Enable or disable the bundled homebrew subsystems — book system, stress, food & drink, the Farkle and Dice Poker tables, and the merchant. House-rule tweaks stay in the main settings list.",
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
