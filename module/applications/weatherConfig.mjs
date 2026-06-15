/**
 * WeatherConfigApp — the GM-friendly "Weather & Calendar" configuration panel.
 *
 * One tabbed window where a non-technical GM can edit everything the inbuilt
 * weather/calendar engine reads, with plain labelled form rows instead of raw
 * JSON. Four tabs:
 *
 *   Climate & Seasons — biome profiles (mean temp, swing, wet/wind/cloud bias)
 *                       and the four seasonal shifts. Writes `climateConfig`.
 *   Terrain           — landsite types for the (planned) paintable weather map
 *                       and the engine's local biases. Writes `terrainConfig`.
 *   Modifiers         — per-condition mechanical penalties, one row each, no
 *                       JSON. Writes `weatherModifiersOverride`.
 *   Calendar          — daylight (dawn/dusk per season) and the moon cycle.
 *                       Writes `calendarConfig` (a patch over the seed).
 *
 * Storage uses the same override-with-seed-fallback pattern as the rest of the
 * weather subsystem: an empty override means "use the hardcoded seed". Each tab
 * has a per-tab Reset that clears just its override.
 *
 * Edits are held in `#working` (seeded from the live catalogs on construct,
 * re-synced from the DOM before any add/remove so typed-but-unsaved values
 * survive a re-render) and persisted on Save.
 */

import { CLIMATES, SEASONS, getActiveClimates, getRegionBaseline, REGION_PRESETS } from "../mechanics/weather.mjs";
import { SEED_TERRAIN, getActiveTerrain, TERRAIN_NUM_FIELDS } from "../mechanics/terrain.mjs";
import { WEATHER_MODIFIER_RULES, getActiveModifierRules } from "../mechanics/weather-modifiers.mjs";
import { WITCHER_CALENDAR_CONFIG } from "../setup/calendar.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { expandObject, deepClone } = foundry.utils;

const localize = (k) => (k ? game.i18n.localize(k) : "");
/* Localize, but fall back to "" (not the raw key) when a key is absent — used
 * for optional helper hints. */
const locOpt = (k) => (k && game.i18n.has?.(k) ? game.i18n.localize(k) : "");

/* Field groups per card. The "temp" group holds plain numbers + the variation
 * sliders; the "cond" group holds the weather-tendency word sliders. The full
 * lists (used by the form parser) are the concatenation. */
const CLIMATE_TEMP = ["tempBase", "tempSwing", "dailySwing", "seasonMult"];
const CLIMATE_COND = ["wetBias", "windBias", "cloudBias"];
const CLIMATE_FIELDS = [...CLIMATE_TEMP, ...CLIMATE_COND];

const SEASON_TEMP = ["temp"];
const SEASON_COND = ["wetBias", "windBias", "cloudBias"];
const SEASON_FIELDS = [...SEASON_TEMP, ...SEASON_COND];

const TERRAIN_TEMP = ["tempOffset", "elevation", "swingMult"];
const TERRAIN_COND = ["wetBias", "windBias", "cloudBias", "fogBias"];

/* How each field is presented: a plain number (with unit) or a labelled
 * "scale" slider whose live readout is a word, not a number. */
const FIELD_META = {
    tempBase:   { type: "number", step: 1,    unit: "°C" },
    temp:       { type: "number", step: 1,    unit: "°C" },
    tempOffset: { type: "number", step: 1,    unit: "°C" },
    elevation:  { type: "number", step: 50,   unit: "m"  },
    tempSwing:  { type: "scale",  kind: "tempSwing",  min: 2,    max: 14,  step: 1    },
    dailySwing: { type: "scale",  kind: "dailySwing", min: 0.4,  max: 2,   step: 0.1  },
    seasonMult: { type: "scale",  kind: "seasonMult", min: 0.3,  max: 1.3, step: 0.05 },
    swingMult:  { type: "scale",  kind: "swingMult",  min: 0.5,  max: 1.6, step: 0.05 },
    wetBias:    { type: "scale",  kind: "wetBias",    min: -0.3, max: 0.3, step: 0.01 },
    windBias:   { type: "scale",  kind: "windBias",   min: -0.3, max: 0.3, step: 0.01 },
    cloudBias:  { type: "scale",  kind: "cloudBias",  min: -0.3, max: 0.3, step: 0.01 },
    fogBias:    { type: "scale",  kind: "fogBias",    min: -0.3, max: 0.3, step: 0.01 }
};

/* Word labels (i18n suffixes) each slider snaps through, low → high. */
const SCALE_WORDS = {
    wetBias:    ["VeryDry", "Dry", "Average", "Wet", "VeryWet"],
    windBias:   ["VeryCalm", "Calm", "Average", "Windy", "VeryWindy"],
    cloudBias:  ["VeryClear", "Clear", "Average", "Cloudy", "Overcast"],
    fogBias:    ["NoFog", "RareFog", "SomeFog", "FoggyOften", "VeryFoggy"],
    tempSwing:  ["Mild", "Moderate", "Extreme"],
    dailySwing: ["SmallSwing", "AverageSwing", "LargeSwing"],
    seasonMult: ["Maritime", "Balanced", "Continental"],
    swingMult:  ["Calmer", "Average", "Harsher"]
};

/* Map a raw value to its word-bucket index for the given kind. */
function scaleIndex(kind, value) {
    const v = Number(value) || 0;
    if (kind === "tempSwing")  return v < 6 ? 0 : v <= 10 ? 1 : 2;
    if (kind === "dailySwing") return v < 0.85 ? 0 : v <= 1.3 ? 1 : 2;
    if (kind === "seasonMult") return v < 0.75 ? 0 : v <= 1.0 ? 1 : 2;
    if (kind === "swingMult")  return v < 0.9 ? 0 : v <= 1.12 ? 1 : 2;
    // Bias axes share a symmetric -0.3..0.3, five-point scale.
    return v < -0.18 ? 0 : v < -0.06 ? 1 : v <= 0.06 ? 2 : v <= 0.18 ? 3 : 4;
}

/* Localized word for a slider's current value. */
function scaleWord(kind, value) {
    const words = SCALE_WORDS[kind] ?? [];
    const w = words[scaleIndex(kind, value)] ?? "";
    return w ? game.i18n.localize(`WITCHER.Weather.Config.Scale.${w}`) : "";
}

/* Modifier targets the combat layer understands (drop-down in the Modifiers
 * tab). Mirrors weather-modifiers.mjs TARGET_ORDER + a couple of extras. */
const MOD_TARGETS = ["awareness", "ranged", "tracking", "stealth", "movement", "endurance"];
/* Condition tags that carry mechanical weight, in display order. */
const MOD_TAGS = ["fog", "wind", "precip", "snow", "storm", "heat", "hail", "dust"];

export class WeatherConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-weather-config",
        classes: ["witcher-ttrpg-death-march", "wdm-weather-config"],
        tag: "form",
        window: {
            title: "WITCHER.Weather.Config.Title",
            icon: "fa-solid fa-sliders",
            resizable: true
        },
        position: { width: 720, height: 720 },
        form: {
            handler: WeatherConfigApp.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            addBiome:     WeatherConfigApp.#onAddBiome,
            removeBiome:  WeatherConfigApp.#onRemoveBiome,
            addTerrain:   WeatherConfigApp.#onAddTerrain,
            removeTerrain: WeatherConfigApp.#onRemoveTerrain,
            addMod:       WeatherConfigApp.#onAddMod,
            removeMod:    WeatherConfigApp.#onRemoveMod,
            resetTab:     WeatherConfigApp.#onResetTab
        }
    };

    static PARTS = {
        tabs:      { template: "templates/generic/tab-navigation.hbs" },
        general:   { template: "systems/witcher-ttrpg-death-march/templates/applications/weather-config-general.hbs", scrollable: [""] },
        climate:   { template: "systems/witcher-ttrpg-death-march/templates/applications/weather-config-climate.hbs", scrollable: [""] },
        terrain:   { template: "systems/witcher-ttrpg-death-march/templates/applications/weather-config-terrain.hbs", scrollable: [""] },
        modifiers: { template: "systems/witcher-ttrpg-death-march/templates/applications/weather-config-modifiers.hbs", scrollable: [""] },
        calendar:  { template: "systems/witcher-ttrpg-death-march/templates/applications/weather-config-calendar.hbs", scrollable: [""] },
        footer:    { template: "templates/generic/form-footer.hbs" }
    };

    static TABS = {
        primary: {
            tabs: [
                { id: "general",   icon: "fa-solid fa-sliders" },
                { id: "climate",   icon: "fa-solid fa-temperature-half" },
                { id: "terrain",   icon: "fa-solid fa-mountain-sun" },
                { id: "modifiers", icon: "fa-solid fa-dice-d20" },
                { id: "calendar",  icon: "fa-solid fa-calendar-days" }
            ],
            initial: "general",
            labelPrefix: "WITCHER.Weather.Config.Tab"
        }
    };

    /* The four config tabs after General edit world-scoped engine data, so they
     * are GM-only. Players get just the General tab (their per-client display
     * knobs). Filter both the rendered parts and the tab nav. */
    static #GM_ONLY_TABS = ["climate", "terrain", "modifiers", "calendar"];

    _configureRenderParts(options) {
        const parts = super._configureRenderParts(options);
        if (!game.user.isGM) for (const id of WeatherConfigApp.#GM_ONLY_TABS) delete parts[id];
        return parts;
    }

    _prepareTabs(group) {
        const tabs = super._prepareTabs(group);
        if (!game.user.isGM) for (const id of WeatherConfigApp.#GM_ONLY_TABS) delete tabs[id];
        return tabs;
    }

    /* Live working copy, mutated by add/remove and read on submit. */
    #working = null;

    constructor(options = {}) {
        super(options);
        this.#working = this.#seedWorking();
    }

    /* Build the working state from the live (override-merged) catalogs. */
    #seedWorking() {
        return {
            general:  this.#liveGeneral(),
            climates: deepClone(getActiveClimates()),
            seasons:  deepClone(this.#liveSeasons()),
            region:   getRegionBaseline(),
            terrain:  deepClone(getActiveTerrain()),
            modifiers: deepClone(this.#liveModifiers()),
            calendar:  this.#liveCalendarBits(),
            map:       this.#liveMapSettings()
        };
    }

    /* The simple weather/time toggles & knobs, read straight from their plain
     * world/client settings (no seed/override split). World keys are GM-writable
     * only; the two client keys (thunder, particle budget) are per-player. */
    #liveGeneral() {
        const get = (k, d) => { try { const v = game.settings.get(SYSTEM_ID, k); return v ?? d; } catch (_) { return d; } };
        return {
            weatherEnabled:      !!get("weatherEnabled", true),
            autoSceneDarkness:   !!get("autoSceneDarkness", true),
            autoWeatherFx:       !!get("autoWeatherFx", true),
            weatherSound:        !!get("weatherSound", true),
            weatherBiome:        String(get("weatherBiome", "temperate")),
            timeFlowRate:        Number(get("timeFlowRate", 1)),
            weatherThunder:      !!get("weatherThunder", true),
            weatherMaxParticles: Number(get("weatherMaxParticles", 2000)),
            weatherDebug:        !!get("weatherDebug", false)
        };
    }

    /* World-map spatial settings: the scene whose painted terrain + party marker
     * drive multi-region weather, plus the two spatial-engine knobs. Plain world
     * settings (no seed/override split), so read them straight. */
    #liveMapSettings() {
        const get = (k, d) => { try { const v = game.settings.get(SYSTEM_ID, k); return v ?? d; } catch (_) { return d; } };
        const num = (k, d) => { const v = Number(get(k, d)); return Number.isFinite(v) ? v : d; };
        return {
            scene: String(get("weatherMapScene", "") || ""),
            latitudeSpan: num("latitudeSpan", 12),
            frontSweepDays: num("frontSweepDays", 3)
        };
    }

    #liveSeasons() {
        // Seasons have no override setting yet; they live in calendarConfig-adjacent
        // engine data. Seed from SEASONS (and merge any seasonConfig override later).
        let override = {};
        try {
            const o = game.settings.get(SYSTEM_ID, "seasonConfig");
            if (o && typeof o === "object") override = o;
        } catch (_) { /* not registered */ }
        const out = deepClone(SEASONS);
        for (const [k, v] of Object.entries(override)) out[k] = { ...out[k], ...v };
        return out;
    }

    #liveModifiers() {
        const rules = getActiveModifierRules();
        const out = {};
        for (const tag of MOD_TAGS) {
            out[tag] = (rules[tag] ?? []).map(r => ({
                minLevel: Number(r.minLevel) || 1,
                target: r.target,
                value: Number(r.value) || 0,
                perLevel: !!r.perLevel,
                label: r.label ?? ""
            }));
        }
        return out;
    }

    /* The friendly calendar knobs: per-season dawn/dusk + primary moon cycle. */
    #liveCalendarBits() {
        const cal = game.time?.calendar;
        const seed = WITCHER_CALENDAR_CONFIG;
        const sunSeed = cal?.sun?.values ?? seed.sun?.values ?? [];
        const seasonNames = (cal?.seasons?.values ?? seed.seasons.values ?? []);
        const sun = seasonNames.map((s, i) => ({
            name: localize(s.name) || `Season ${i + 1}`,
            dawn: Number(sunSeed[i]?.dawn ?? 6),
            dusk: Number(sunSeed[i]?.dusk ?? 18)
        }));
        const moon = cal?.moons?.values?.[0] ?? seed.moons?.values?.[0] ?? {};
        return {
            sun,
            moonName: localize(moon.name) || "Moon",
            moonCycle: Number(moon.cycleLength) || 28
        };
    }

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        ctx.buttons = [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "WITCHER.Weather.Config.Save" }];
        return ctx;
    }

    async _preparePartContext(partId, context) {
        const ctx = await super._preparePartContext(partId, context);
        if (ctx.tabs && partId in ctx.tabs) ctx.tab = ctx.tabs[partId];
        if (partId === "general")   this.#ctxGeneral(ctx);
        if (partId === "climate")   this.#ctxClimate(ctx);
        if (partId === "terrain")   this.#ctxTerrain(ctx);
        if (partId === "modifiers") this.#ctxModifiers(ctx);
        if (partId === "calendar")  this.#ctxCalendar(ctx);
        return ctx;
    }

    /* One presentable field: a number-with-unit or a word-scale slider. */
    #fieldRow(namePrefix, key, value) {
        const meta = FIELD_META[key] ?? { type: "number", step: 0.5 };
        const v = Number(value) || 0;
        return {
            key,
            name: `${namePrefix}.${key}`,
            label: localize(`WITCHER.Weather.Config.Field.${key}`),
            hint: locOpt(`WITCHER.Weather.Config.Hint.${key}`),
            value: v,
            type: meta.type,
            kind: meta.kind ?? "",
            min: meta.min,
            max: meta.max,
            step: meta.step,
            unit: meta.unit ?? "",
            word: meta.type === "scale" ? scaleWord(meta.kind, v) : ""
        };
    }

    #fieldRows(namePrefix, src, keys) {
        return keys.map(k => this.#fieldRow(namePrefix, k, src[k]));
    }

    #ctxGeneral(ctx) {
        ctx.isGM = game.user.isGM;
        ctx.gen = this.#working.general;
        // Biome options include any custom climates the GM added (climateConfig),
        // not just the four seed biomes.
        ctx.biomeOptions = Object.keys(getActiveClimates()).map(key => ({
            value: key,
            label: localize(`WITCHER.Weather.Climate.${key}`) || key,
            selected: this.#working.general.weatherBiome === key
        }));
    }

    #ctxClimate(ctx) {
        ctx.usingDefaults = !this.#hasOverride("climateConfig");
        ctx.regionBaseline = this.#working.region ?? 0;
        ctx.regionPresets = REGION_PRESETS.map(p => ({
            baseline: p.baseline,
            label: localize(`WITCHER.Weather.Config.RegionOpt.${p.key}`) || p.key,
            selected: Number(p.baseline) === Number(ctx.regionBaseline)
        }));
        ctx.regionCustom = !ctx.regionPresets.some(p => p.selected);
        ctx.biomes = Object.entries(this.#working.climates).map(([key, c]) => ({
            key,
            label: localize(`WITCHER.Weather.Climate.${key}`) || key,
            isSeed: key in CLIMATES,
            tempFields: this.#fieldRows(`climate.${key}`, c, CLIMATE_TEMP),
            condFields: this.#fieldRows(`climate.${key}`, c, CLIMATE_COND)
        }));
        ctx.seasons = Object.entries(this.#working.seasons).map(([key, s]) => ({
            key,
            label: localize(`WITCHER.Calendar.Seasons.${key}`) || key,
            aurora: !!s.aurora,
            tempFields: this.#fieldRows(`season.${key}`, s, SEASON_TEMP),
            condFields: this.#fieldRows(`season.${key}`, s, SEASON_COND)
        }));
    }

    #ctxTerrain(ctx) {
        ctx.usingDefaults = !this.#hasOverride("terrainConfig");
        const m = this.#working.map;
        ctx.map = {
            latitudeSpan: m.latitudeSpan,
            frontSweepHours: Math.round((m.frontSweepDays ?? 3) * 24),
            sceneOptions: [{ id: "", name: localize("WITCHER.Weather.Map.NoScene"), selected: !m.scene }]
                .concat((game.scenes?.contents ?? []).map(s => ({
                    id: s.id, name: s.name, selected: s.id === m.scene
                })))
        };
        ctx.terrain = Object.entries(this.#working.terrain).map(([key, t]) => ({
            key,
            label: localize(t.label) || localize(`WITCHER.Weather.Terrain.${key}`) || key,
            isSeed: key in SEED_TERRAIN,
            color: t.color ?? "#888888",
            icon: t.icon ?? "fa-solid fa-location-dot",
            tempFields: this.#fieldRows(`terrain.${key}`, t, TERRAIN_TEMP),
            condFields: this.#fieldRows(`terrain.${key}`, t, TERRAIN_COND)
        }));
    }

    #ctxModifiers(ctx) {
        ctx.usingDefaults = !this.#hasOverride("weatherModifiersOverride");
        ctx.targetOptions = MOD_TARGETS.map(t => ({
            value: t,
            label: localize(`WITCHER.Weather.Target.${t.charAt(0).toUpperCase()}${t.slice(1)}`) || t
        }));
        ctx.tags = MOD_TAGS.map(tag => ({
            tag,
            label: localize(`WITCHER.Weather.Tag.${tag}`) || tag,
            rows: (this.#working.modifiers[tag] ?? []).map((r, i) => ({
                index: i,
                minLevel: r.minLevel,
                target: r.target,
                value: r.value,
                perLevel: !!r.perLevel,
                label: r.label
            }))
        }));
    }

    #ctxCalendar(ctx) {
        ctx.usingDefaults = !this.#hasOverride("calendarConfig");
        ctx.sun = this.#working.calendar.sun.map((s, i) => ({ index: i, ...s }));
        ctx.moonName = this.#working.calendar.moonName;
        ctx.moonCycle = this.#working.calendar.moonCycle;
    }

    /* Live-update each word-scale slider's readout as it's dragged. */
    async _onRender(context, options) {
        await super._onRender(context, options);
        for (const slider of this.element.querySelectorAll(".wdm-cfg-scale")) {
            slider.addEventListener("input", (ev) => {
                const out = ev.target.parentElement?.querySelector(".wdm-cfg-word");
                if (out) out.textContent = scaleWord(ev.target.dataset.kind, ev.target.value);
            });
        }

        // Region: picking a lore preset fills the °C box; typing a custom value
        // flips the dropdown to "Custom".
        const preset = this.element.querySelector(".wdm-cfg-region-preset");
        const baseline = this.element.querySelector(".wdm-cfg-region-baseline");
        if (preset && baseline) {
            preset.addEventListener("change", (ev) => {
                if (ev.target.value !== "custom") baseline.value = ev.target.value;
            });
            baseline.addEventListener("input", () => {
                const match = [...preset.options].find(o => o.value !== "custom" && Number(o.value) === Number(baseline.value));
                preset.value = match ? match.value : "custom";
            });
        }
    }

    #hasOverride(key) {
        try {
            const o = game.settings.get(SYSTEM_ID, key);
            return !!(o && typeof o === "object" && Object.keys(o).length);
        } catch (_) { return false; }
    }

    /* ─────────── DOM ↔ working sync ─────────── */

    /* Pull every named input into #working so add/remove + tab switches keep
     * unsaved edits. Mirrors the submit parser but tolerates a partial DOM
     * (only the active tab's inputs are present). */
    #syncFromForm() {
        const form = this.element;
        if (!form) return;
        const data = expandObject(new foundry.applications.ux.FormDataExtended(form).object);

        if (data.general) {
            const g = this.#working.general;
            const d = data.general;
            // World keys: only meaningful (and only rendered) for a GM.
            if (game.user.isGM) {
                if (d.weatherEnabled !== undefined)    g.weatherEnabled = !!d.weatherEnabled;
                if (d.autoSceneDarkness !== undefined) g.autoSceneDarkness = !!d.autoSceneDarkness;
                if (d.autoWeatherFx !== undefined)     g.autoWeatherFx = !!d.autoWeatherFx;
                if (d.weatherSound !== undefined)      g.weatherSound = !!d.weatherSound;
                if (d.weatherBiome !== undefined)      g.weatherBiome = String(d.weatherBiome || "temperate");
                if (d.timeFlowRate !== undefined)      g.timeFlowRate = Math.max(0, Number(d.timeFlowRate) || 0);
                if (d.weatherDebug !== undefined)      g.weatherDebug = !!d.weatherDebug;
            }
            // Per-client knobs: everyone.
            if (d.weatherThunder !== undefined)      g.weatherThunder = !!d.weatherThunder;
            if (d.weatherMaxParticles !== undefined) g.weatherMaxParticles = Math.max(0, Number(d.weatherMaxParticles) || 0);
        }
        if (data.regionBaseline !== undefined) this.#working.region = Number(data.regionBaseline) || 0;
        if (data.climate) {
            for (const [key, vals] of Object.entries(data.climate)) {
                if (!this.#working.climates[key]) this.#working.climates[key] = {};
                for (const f of CLIMATE_FIELDS) {
                    if (vals[f] !== undefined) this.#working.climates[key][f] = Number(vals[f]) || 0;
                }
            }
        }
        if (data.season) {
            for (const [key, vals] of Object.entries(data.season)) {
                if (!this.#working.seasons[key]) this.#working.seasons[key] = {};
                for (const f of SEASON_FIELDS) {
                    if (vals[f] !== undefined) this.#working.seasons[key][f] = Number(vals[f]) || 0;
                }
                if (vals.aurora !== undefined) this.#working.seasons[key].aurora = !!vals.aurora;
            }
        }
        if (data.terrain) {
            for (const [key, vals] of Object.entries(data.terrain)) {
                if (!this.#working.terrain[key]) this.#working.terrain[key] = {};
                for (const f of TERRAIN_NUM_FIELDS) {
                    if (vals[f] !== undefined) this.#working.terrain[key][f] = Number(vals[f]) || 0;
                }
                if (vals.color !== undefined) this.#working.terrain[key].color = vals.color;
                if (vals.icon !== undefined) this.#working.terrain[key].icon = vals.icon;
                if (vals.label !== undefined && vals.label) this.#working.terrain[key].label = vals.label;
            }
        }
        if (data.map) {
            if (data.map.scene !== undefined) this.#working.map.scene = String(data.map.scene || "");
            if (data.map.latitudeSpan !== undefined) this.#working.map.latitudeSpan = Math.max(0, Number(data.map.latitudeSpan) || 0);
            if (data.map.frontSweepHours !== undefined) {
                const h = Math.min(336, Math.max(1, Number(data.map.frontSweepHours) || 72));
                this.#working.map.frontSweepDays = h / 24;   // engine stores days; UI edits hours
            }
        }
        if (data.mod) {
            for (const [tag, rows] of Object.entries(data.mod)) {
                const arr = [];
                // rows is an index-keyed object from the form.
                for (const idx of Object.keys(rows).sort((a, b) => Number(a) - Number(b))) {
                    const r = rows[idx];
                    arr.push({
                        minLevel: Math.max(1, Number(r.minLevel) || 1),
                        target: r.target,
                        value: Number(r.value) || 0,
                        perLevel: !!r.perLevel,
                        label: r.label ?? ""
                    });
                }
                this.#working.modifiers[tag] = arr;
            }
        }
        if (data.calendar) {
            if (Array.isArray(this.#working.calendar.sun) && data.calendar.sun) {
                for (const idx of Object.keys(data.calendar.sun)) {
                    const i = Number(idx);
                    if (!this.#working.calendar.sun[i]) continue;
                    const s = data.calendar.sun[idx];
                    if (s.dawn !== undefined) this.#working.calendar.sun[i].dawn = Number(s.dawn) || 0;
                    if (s.dusk !== undefined) this.#working.calendar.sun[i].dusk = Number(s.dusk) || 0;
                }
            }
            if (data.calendar.moonCycle !== undefined) {
                this.#working.calendar.moonCycle = Math.max(1, Number(data.calendar.moonCycle) || 28);
            }
        }
    }

    /* ─────────── add / remove actions ─────────── */

    static async #onAddBiome() {
        this.#syncFromForm();
        const key = this.#uniqueKey(this.#working.climates, "biome");
        this.#working.climates[key] = { tempBase: 11, tempSwing: 7, wetBias: 0, windBias: 0, cloudBias: 0, dailySwing: 1, seasonMult: 1 };
        this.render();
    }

    static async #onRemoveBiome(event, target) {
        this.#syncFromForm();
        delete this.#working.climates[target.dataset.key];
        this.render();
    }

    static async #onAddTerrain() {
        this.#syncFromForm();
        const key = this.#uniqueKey(this.#working.terrain, "landsite");
        this.#working.terrain[key] = {
            label: key, icon: "fa-solid fa-location-dot", color: "#888888",
            elevation: 0, tempOffset: 0, wetBias: 0, windBias: 0, cloudBias: 0, fogBias: 0, swingMult: 1
        };
        this.render();
    }

    static async #onRemoveTerrain(event, target) {
        this.#syncFromForm();
        delete this.#working.terrain[target.dataset.key];
        this.render();
    }

    static async #onAddMod(event, target) {
        this.#syncFromForm();
        const tag = target.dataset.tag;
        (this.#working.modifiers[tag] ??= []).push({ minLevel: 1, target: "awareness", value: -1, perLevel: false, label: "" });
        this.render();
    }

    static async #onRemoveMod(event, target) {
        this.#syncFromForm();
        const { tag, index } = target.dataset;
        const arr = this.#working.modifiers[tag];
        if (Array.isArray(arr)) arr.splice(Number(index), 1);
        this.render();
    }

    #uniqueKey(obj, base) {
        let i = 1;
        let key = `${base}${i}`;
        while (obj[key]) key = `${base}${++i}`;
        return key;
    }

    /* ─────────── reset ─────────── */

    static async #onResetTab(event, target) {
        const tab = target.dataset.tab;
        const settingKey = {
            climate: "climateConfig",
            terrain: "terrainConfig",
            modifiers: "weatherModifiersOverride",
            calendar: "calendarConfig"
        }[tab];
        const confirm = await foundry.applications.api.DialogV2.confirm({
            window: { title: "WITCHER.Weather.Config.ResetTitle" },
            content: `<p>${localize("WITCHER.Weather.Config.ResetConfirm")}</p>`
        });
        if (!confirm) return;
        if (settingKey) await game.settings.set(SYSTEM_ID, settingKey, {});
        if (tab === "climate") {
            try { await game.settings.set(SYSTEM_ID, "seasonConfig", {}); } catch (_) { /* not registered */ }
            try { await game.settings.set(SYSTEM_ID, "regionBaseline", 0); } catch (_) { /* not registered */ }
        }
        // Reseed just the affected slice from defaults.
        const fresh = this.#seedWorking();
        if (tab === "climate") { this.#working.climates = fresh.climates; this.#working.seasons = fresh.seasons; this.#working.region = fresh.region; }
        if (tab === "terrain") this.#working.terrain = fresh.terrain;
        if (tab === "modifiers") this.#working.modifiers = fresh.modifiers;
        if (tab === "calendar") this.#working.calendar = fresh.calendar;
        ui.notifications.info(localize("WITCHER.Weather.Config.ResetDone"));
        this.render();
        Hooks.callAll("wdm:weatherModifiersChanged");
    }

    /* ─────────── submit ─────────── */

    static async #onSubmit(event, form, formData) {
        this.#syncFromForm();
        const w = this.#working;
        const isGM = game.user.isGM;

        // Per-client display knobs — writable by every user, GM or not.
        await game.settings.set(SYSTEM_ID, "weatherThunder", !!w.general.weatherThunder);
        await game.settings.set(SYSTEM_ID, "weatherMaxParticles", Math.max(0, Number(w.general.weatherMaxParticles) || 0));

        // A player has no world tabs and may not write world settings — done.
        if (!isGM) {
            ui.notifications.info(localize("WITCHER.Weather.Config.Saved"));
            this.render();
            return;
        }

        // General world settings. weatherEnabled requiresReload, so remember its
        // prior value to decide whether to prompt for a reload after saving.
        const prevEnabled = !!game.settings.get(SYSTEM_ID, "weatherEnabled");
        await game.settings.set(SYSTEM_ID, "weatherEnabled", !!w.general.weatherEnabled);
        await game.settings.set(SYSTEM_ID, "autoSceneDarkness", !!w.general.autoSceneDarkness);
        await game.settings.set(SYSTEM_ID, "autoWeatherFx", !!w.general.autoWeatherFx);
        await game.settings.set(SYSTEM_ID, "weatherSound", !!w.general.weatherSound);
        await game.settings.set(SYSTEM_ID, "weatherBiome", String(w.general.weatherBiome || "temperate"));
        await game.settings.set(SYSTEM_ID, "timeFlowRate", Math.max(0, Number(w.general.timeFlowRate) || 0));
        await game.settings.set(SYSTEM_ID, "weatherDebug", !!w.general.weatherDebug);

        // Climate: store only biomes that differ from the seed (and all custom ones).
        const climateOut = {};
        for (const [key, c] of Object.entries(w.climates)) {
            const seed = CLIMATES[key];
            if (!seed || CLIMATE_FIELDS.some(f => Number(c[f]) !== Number(seed[f]))) {
                climateOut[key] = Object.fromEntries(CLIMATE_FIELDS.map(f => [f, Number(c[f]) || 0]));
            }
        }
        await game.settings.set(SYSTEM_ID, "climateConfig", climateOut);

        // Region latitude warmth offset (a single °C scalar).
        await game.settings.set(SYSTEM_ID, "regionBaseline", Number(w.region) || 0);

        // Seasons: own override setting (registered alongside the others).
        const seasonOut = {};
        for (const [key, s] of Object.entries(w.seasons)) {
            const seed = SEASONS[key];
            const rec = { ...Object.fromEntries(SEASON_FIELDS.map(f => [f, Number(s[f]) || 0])), aurora: !!s.aurora };
            if (!seed || SEASON_FIELDS.some(f => Number(s[f]) !== Number(seed[f])) || !!s.aurora !== !!seed.aurora) {
                seasonOut[key] = rec;
            }
        }
        try { await game.settings.set(SYSTEM_ID, "seasonConfig", seasonOut); } catch (_) { /* not registered */ }

        // Terrain: full custom types kept; seed types stored if any field differs.
        const terrainOut = {};
        for (const [key, t] of Object.entries(w.terrain)) {
            const seed = SEED_TERRAIN[key];
            const rec = {
                ...Object.fromEntries(TERRAIN_NUM_FIELDS.map(f => [f, Number(t[f]) || 0])),
                color: t.color ?? "#888888", icon: t.icon ?? "fa-solid fa-location-dot", label: t.label ?? key
            };
            const differs = !seed
                || TERRAIN_NUM_FIELDS.some(f => Number(t[f]) !== Number(seed[f]))
                || t.color !== seed.color || t.icon !== seed.icon;
            if (differs) terrainOut[key] = rec;
        }
        await game.settings.set(SYSTEM_ID, "terrainConfig", terrainOut);

        // World map: designated scene + spatial-engine knobs (plain world settings).
        await game.settings.set(SYSTEM_ID, "weatherMapScene", String(w.map.scene || ""));
        await game.settings.set(SYSTEM_ID, "latitudeSpan", Math.max(0, Number(w.map.latitudeSpan) || 0));
        await game.settings.set(SYSTEM_ID, "frontSweepDays", Number(w.map.frontSweepDays) > 0 ? Number(w.map.frontSweepDays) : 3);

        // Modifiers: store the whole table when it differs from the seed.
        const modsOut = {};
        let modsDiffer = false;
        for (const tag of MOD_TAGS) {
            const rows = (w.modifiers[tag] ?? []).map(r => ({
                minLevel: Math.max(1, Number(r.minLevel) || 1),
                target: r.target,
                value: Number(r.value) || 0,
                ...(r.perLevel ? { perLevel: true } : {}),
                label: r.label ?? ""
            }));
            modsOut[tag] = rows;
            const seed = WEATHER_MODIFIER_RULES[tag] ?? [];
            if (JSON.stringify(rows) !== JSON.stringify(seed.map(s => ({ ...s })))) modsDiffer = true;
        }
        await game.settings.set(SYSTEM_ID, "weatherModifiersOverride", modsDiffer ? modsOut : {});

        // Calendar: patch sun + moon cycle onto a clone of the live/seed config.
        await this.#saveCalendar(w.calendar);

        ui.notifications.info(localize("WITCHER.Weather.Config.Saved"));
        Hooks.callAll("wdm:weatherModifiersChanged");
        this.render();

        // Toggling the master switch rebinds the calendar class at startup.
        if (prevEnabled !== !!w.general.weatherEnabled) {
            await foundry.applications.settings.SettingsConfig.reloadConfirm({ world: true });
        }
    }

    async #saveCalendar(calBits) {
        const current = this.#hasOverride("calendarConfig")
            ? game.settings.get(SYSTEM_ID, "calendarConfig")
            : WITCHER_CALENDAR_CONFIG;
        const cfg = deepClone(current);
        cfg.sun = cfg.sun ?? { values: [] };
        cfg.sun.values = calBits.sun.map(s => ({ dawn: Number(s.dawn) || 0, dusk: Number(s.dusk) || 0 }));
        if (cfg.moons?.values?.[0]) cfg.moons.values[0].cycleLength = Math.max(1, Number(calBits.moonCycle) || 28);
        // Only persist if it actually diverges from the seed (keeps "defaults" honest).
        const isSeed = JSON.stringify(cfg) === JSON.stringify(WITCHER_CALENDAR_CONFIG);
        await game.settings.set(SYSTEM_ID, "calendarConfig", isSeed ? {} : cfg);
    }
}
