/**
 * WeatherControlApp — the GM's draggable, tabbed time/weather console.
 *
 * Replaces the old oversized glyph dropdown. Two tabs:
 *   Time    — clock, advance/rewind, jump-to dawn/noon/dusk/midnight, climate,
 *             and a short forecast.
 *   Weather — manual override toggle + the five layered weather pickers
 *             (sky / precipitation / special / wind / fog) and the live
 *             stacked-modifier readout, plus a shortcut to the penalty editor.
 *
 * It is a normal ApplicationV2 window (draggable, resizable, scrollable) so it
 * no longer swallows the screen. While open it live-refreshes on world-time
 * advances and on manual-weather / climate / penalty changes.
 *
 * GM-only — players still get the lightweight read-only info popup in
 * chrome/weather.js.
 */

import {
    getForecast, getDayHeadline, getDaypartsForTime, currentBiome, getActiveClimates,
    regenerateMonth, regenerateDay, resetMonth, resetDay, monthHasSeed, dayHasSeed,
    composeWeatherLabel, weatherTierBadge
} from "../mechanics/weather.mjs";
import { getActiveWeatherModifiers, groupWeatherModifiers, getActiveWeatherNotes }
    from "../mechanics/weather-modifiers.mjs";
import {
    availableWeatherConditions, grabWeatherCondition, hasWeatherCondition, WEATHER_CONDITIONS
} from "../mechanics/weather-conditions.mjs";
import {
    getManualSelection, setManualLayer, setManualEnabled, WEATHER_LAYERS, getActiveWeather
} from "../mechanics/manual-weather.mjs";
import { describeActivePlace, getMapScene } from "../mechanics/weather-map.mjs";
import { sceneWeatherMode, setSceneWeatherMode, WEATHER_MODES, isTimeDarknessDisabled, setSceneTimeDarknessDisabled } from "../mechanics/scene-weather-mode.mjs";
import { WeatherConfigApp } from "./weatherConfig.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const localize = (k) => (k ? game.i18n.localize(k) : "");

/* GM debug toggle: when on, the console shows a numeric tier badge next to each
 * composed weather label. Reads the client setting; "" otherwise. */
const debugOn = () => { try { return !!game.settings.get(SYSTEM_ID, "weatherDebug"); } catch (_) { return false; } };
const tierBadge = (w) => debugOn() ? weatherTierBadge(w) : "";

/* Real-world analogue for an in-world month, keyed off the seed calendar's
   ordinal (1 = Midwinter ≈ January … 12 = Deepfrost ≈ December). Localized so
   each language ships its own abbreviations; empty when the ordinal is out of
   the 1–12 range (e.g. a GM custom calendar with a different month count). */
function monthAnalogue(ordinal) {
    return (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= 12)
        ? localize(`WITCHER.Weather.Analogue.${ordinal}`)
        : "";
}

/* Signed integer for display: +2 / −3 (real minus glyph). 0 → "±0". */
function signed(n) {
    const v = Number(n) || 0;
    if (v > 0) return `+${v}`;
    if (v < 0) return `−${Math.abs(v)}`;
    return "±0";
}

function ordinal(n) {
    const s = n % 10, t = n % 100;
    if (t >= 11 && t <= 13) return `${n}th`;
    if (s === 1) return `${n}st`;
    if (s === 2) return `${n}nd`;
    if (s === 3) return `${n}rd`;
    return `${n}th`;
}

/* Format a (possibly fractional) hour-of-day as "HH:MM". Sun times are now
   interpolated across season boundaries, so dawn/dusk can land on e.g. 6.34h
   → "06:20". Minutes that round up to 60 roll into the next hour; hours wrap
   within the day. */
function hhmm(hourFloat) {
    const h = Number(hourFloat);
    if (!Number.isFinite(h)) return "--:--";
    let hr = Math.floor(h);
    let min = Math.round((h - hr) * 60);
    if (min >= 60) { min -= 60; hr += 1; }
    hr = ((hr % 24) + 24) % 24;
    return `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export class WeatherControlApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-weather-control",
        classes: ["witcher-ttrpg-death-march", "wdm-weather-control"],
        tag: "div",
        window: {
            title: "WITCHER.Weather.ControlTitle",
            icon: "fa-solid fa-cloud-sun-rain",
            resizable: true
        },
        position: { width: 520, height: "auto" },
        actions: {
            adjust:        WeatherControlApp.#onAdjust,
            jump:          WeatherControlApp.#onJump,
            setManual:     WeatherControlApp.#onSetManual,
            editPenalties: WeatherControlApp.#onEditPenalties,
            calPrev:       WeatherControlApp.#onCalPrev,
            calNext:       WeatherControlApp.#onCalNext,
            calToday:      WeatherControlApp.#onCalToday,
            calSelect:     WeatherControlApp.#onCalSelect,
            calGoto:       WeatherControlApp.#onCalGoto,
            calRegenMonth: WeatherControlApp.#onCalRegenMonth,
            calResetMonth: WeatherControlApp.#onCalResetMonth,
            calRegenDay:   WeatherControlApp.#onCalRegenDay,
            calResetDay:   WeatherControlApp.#onCalResetDay,
            setSceneMode:  WeatherControlApp.#onSetSceneMode,
            setTimeDarkness: WeatherControlApp.#onSetTimeDarkness,
            grabCondition: WeatherControlApp.#onGrabCondition
        }
    };

    static PARTS = {
        tabs:     { template: "templates/generic/tab-navigation.hbs" },
        time:     { template: "systems/witcher-ttrpg-death-march/templates/applications/weather-control-time.hbs", scrollable: [""] },
        weather:  { template: "systems/witcher-ttrpg-death-march/templates/applications/weather-control-weather.hbs", scrollable: [""] },
        calendar: { template: "systems/witcher-ttrpg-death-march/templates/applications/weather-control-calendar.hbs", scrollable: [""] }
    };

    static TABS = {
        primary: {
            tabs: [
                { id: "time",     icon: "fa-solid fa-clock" },
                { id: "weather",  icon: "fa-solid fa-cloud-sun-rain" },
                { id: "calendar", icon: "fa-solid fa-calendar-days" }
            ],
            initial: "time",
            labelPrefix: "WITCHER.Weather.Tab"
        }
    };

    /* Hook ids registered while the window is open (cleaned up on close). */
    #hookIds = [];

    /* Calendar-tab view state: which month is on screen and which day is
     * selected for the detail panel. null = not yet initialised (snap to the
     * current world date on first render). */
    #calYear = null;
    #calMonth = null;
    #calSelDay = null;

    /* ─────────── calendar reads ─────────── */

    #components() {
        const cal = game.time?.calendar;
        if (!cal?.timeToComponents) return null;
        return cal.timeToComponents(game.time?.worldTime ?? 0);
    }

    #dateStr() {
        const cal = game.time?.calendar;
        const c = this.#components();
        if (!c) return "—";
        const monthName = localize(cal.months?.values?.[c.month]?.name);
        const humanDay = (c.dayOfMonth ?? 0) + 1;
        return monthName
            ? `${ordinal(humanDay)} of ${monthName}, ${c.year}`
            : `${ordinal(humanDay)}, ${c.year}`;
    }

    #clock() {
        const c = this.#components();
        if (!c) return "—";
        return `${String(c.hour ?? 0).padStart(2, "0")}:${String(c.minute ?? 0).padStart(2, "0")}:${String(c.second ?? 0).padStart(2, "0")}`;
    }

    #shortDate(worldTime) {
        const cal = game.time?.calendar;
        if (!cal?.timeToComponents) return "—";
        const c = cal.timeToComponents(worldTime);
        const month = localize(cal.months?.values?.[c.month]?.name) || "";
        return `${month} ${(c.dayOfMonth ?? 0) + 1}`;
    }

    /* ─────────── context ─────────── */

    async _preparePartContext(partId, context) {
        const ctx = await super._preparePartContext(partId, context);
        if (ctx.tabs && partId in ctx.tabs) ctx.tab = ctx.tabs[partId];
        if (partId === "time")     this.#prepareTime(ctx);
        if (partId === "weather")  this.#prepareWeather(ctx);
        if (partId === "calendar") this.#prepareCalendar(ctx);
        return ctx;
    }

    #prepareTime(ctx) {
        ctx.dateStr = this.#dateStr();
        ctx.clock = this.#clock();

        const cur = currentBiome();
        ctx.climateOptions = Object.keys(getActiveClimates()).map(key => ({
            value: key,
            label: localize(`WITCHER.Weather.Climate.${key}`) || key,
            selected: key === cur
        }));

        const now = game.time?.worldTime ?? 0;
        const spd = game.time?.calendar?.secondsPerDay || 86400;
        ctx.forecast = getForecast(now, 6).map((entry, i) => {
            const w = entry.weather;
            return {
                day: i === 0 ? "Today" : this.#shortDate(now + i * spd),
                icon: w.icon,
                cond: composeWeatherLabel(w, localize) || "—",
                badge: tierBadge(w),
                temp: `${w.temp}°`
            };
        });

        ctx.place = this.#activePlaceContext(now);
    }

    /* Describe where the displayed weather is being read from (the spatial-map
     * resolution), so the forecast above isn't an unlabelled "somewhere". The
     * weather numbers already reflect this place — the engine resolves it
     * internally; this is the human-readable "for: …" caption. */
    #activePlaceContext(now) {
        const p = describeActivePlace(now);
        const headline = {
            markerToken: localize("WITCHER.Weather.Map.ActiveMarkerToken"),
            markerCell:  localize("WITCHER.Weather.Map.ActiveMarkerCell"),
            sceneBiome:  localize("WITCHER.Weather.Map.ActiveSceneBiome"),
            global: p.sceneName
                ? game.i18n.format("WITCHER.Weather.Map.ActiveGlobalNoMarker", { scene: p.sceneName })
                : localize("WITCHER.Weather.Map.ActiveGlobal")
        }[p.source];
        const terrainLabel = p.terrain
            ? (localize(p.terrain.label) || localize(`WITCHER.Weather.Terrain.${p.terrainKey}`) || p.terrainKey)
            : "";
        const icon = {
            markerToken: "fa-solid fa-location-dot",
            markerCell:  "fa-solid fa-map-pin",
            sceneBiome:  "fa-solid fa-cloud",
            global:      "fa-solid fa-earth-europe"
        }[p.source];
        return {
            headline,
            icon,
            follow: p.source === "markerToken",
            isGlobal: p.source === "global",
            sceneName: p.sceneName,
            cell: p.cell ? `${p.cell.i}, ${p.cell.j}` : "",
            terrainLabel,
            terrainIcon: p.terrain?.icon || "",
            terrainColor: p.terrain?.color || "",
            biomeLabel: p.biome ? (localize(`WITCHER.Weather.Climate.${p.biome}`) || p.biome) : ""
        };
    }

    #prepareWeather(ctx) {
        const sel = getManualSelection();
        ctx.manualOn = !!sel.enabled;
        ctx.layers = WEATHER_LAYERS.map(layer => {
            const curId = sel[layer.key] ?? "";
            return {
                key: layer.key,
                title: localize(layer.title),
                noneActive: curId === "",
                states: layer.states.map(st => ({
                    id: st.id,
                    label: localize(st.label),
                    icon: st.icon,
                    active: curId === st.id
                }))
            };
        });

        ctx.sceneWeather = this.#sceneModeContext();

        const groups = groupWeatherModifiers(getActiveWeatherModifiers());
        ctx.noEffects = !groups.length;
        ctx.effects = groups.map(g => ({
            targetLabel: localize(g.targetLabel),
            total: signed(g.total),
            cls: g.total > 0 ? "is-boon" : g.total < 0 ? "is-bane" : "",
            parts: g.parts.map(p => ({ value: signed(p.value), label: localize(p.label) }))
        }));
        ctx.notes = getActiveWeatherNotes().map(localize);

        const own = game.user?.character ?? null;
        const stun = Math.max(1, Number(own?.system?.derivedStats?.stun) || 1);
        let condTemp = null;
        try { condTemp = getActiveWeather()?.temp; } catch (_) { /* not ready */ }
        ctx.conditionsTemp = condTemp == null ? "" : `${condTemp}°`;
        ctx.conditions = availableWeatherConditions().map(id => {
            const spec = WEATHER_CONDITIONS[id];
            const hours = id === "freezing" ? Math.max(1, Math.floor(stun / 2)) : stun;
            return {
                id,
                label: localize(spec.name),
                icon: spec.kind === "heat" ? "fa-sun" : "fa-snowflake",
                desc: game.i18n.format(
                    `WITCHER.Weather.Condition.${id[0].toUpperCase()}${id.slice(1)}Desc`, { hours }),
                active: own ? hasWeatherCondition(own, id) : false
            };
        });
    }

    /* The 3 scene-weather quick buttons, acting on the locally VIEWED scene
     * (canvas.scene) — the same per-scene flag the Scene-config buttons write, so
     * a presentation choice made here persists on the scene document. */
    #sceneModeContext() {
        const scene = canvas?.scene ?? null;
        const mode = sceneWeatherMode(scene);
        const defs = [
            { mode: WEATHER_MODES.OUTDOOR, icon: "fa-cloud-sun",   label: localize("WITCHER.Weather.SceneMode.Outdoors") },
            { mode: WEATHER_MODES.INDOOR,  icon: "fa-house",       label: localize("WITCHER.Weather.SceneMode.Indoors") },
            { mode: WEATHER_MODES.OFF,     icon: "fa-cloud-slash", label: localize("WITCHER.Weather.SceneMode.Disable") }
        ];
        return {
            hasScene: !!scene,
            legend: scene
                ? game.i18n.format("WITCHER.Weather.SceneMode.PanelLegend", { scene: scene.name })
                : localize("WITCHER.Weather.SceneMode.PanelNoScene"),
            modes: defs.map(d => ({ ...d, active: d.mode === mode })),
            noTimeDarkness: isTimeDarknessDisabled(scene)
        };
    }

    /* ─────────── calendar tab ─────────── */

    /* Resolve the on-screen month into the pieces every cell needs: the day-of-
     * year offset of day 1, that month's length (leap-aware) and seconds-per-day,
     * plus the world time of day 1 at noon. Returns null if the calendar is not
     * a full month-bearing calendar. */
    #monthMeta() {
        const cal = game.time?.calendar;
        const months = cal?.months?.values;
        if (!cal?.componentsToTime || !Array.isArray(months) || !months.length) return null;

        const now = game.time?.worldTime ?? 0;
        const nowC = cal.timeToComponents(now);
        if (this.#calYear == null || this.#calMonth == null) {
            this.#calYear = nowC.year;
            this.#calMonth = nowC.month;
        }
        const year = this.#calYear;
        const month = Math.max(0, Math.min(this.#calMonth, months.length - 1));
        const leap = cal.isLeapYear?.(year) ?? false;
        const monthLen = (leap ? (months[month].leapDays ?? months[month].days) : months[month].days) || 0;

        let doy = 0;
        for (let i = 0; i < month; i++) doy += (leap ? (months[i].leapDays ?? months[i].days) : months[i].days) || 0;

        const spd = cal.secondsPerDay || 86400;
        const firstWT = cal.componentsToTime({ year, day: doy, hour: 12 });
        return { cal, months, year, month, monthLen, doy, spd, firstWT, nowC };
    }

    #prepareCalendar(ctx) {
        const meta = this.#monthMeta();
        if (!meta) { ctx.calUnavailable = true; return; }
        const { cal, months, year, month, monthLen, spd, firstWT, nowC } = meta;

        ctx.calMonthName = localize(months[month].name) || `Month ${month + 1}`;
        ctx.calMonthAnalogue = monthAnalogue(months[month].ordinal);
        ctx.calMonthHasSeed = monthHasSeed(year, month);
        ctx.calYear = year;
        ctx.calBiome = localize(`WITCHER.Weather.Climate.${currentBiome()}`) || currentBiome();

        // Weekday headers (abbreviated to keep the grid narrow).
        const weekdays = cal.days?.values ?? [];
        ctx.calWeekdays = weekdays.map(d => {
            const full = localize(d.name) || "";
            return { full, abbr: localize(d.abbreviation) || full.slice(0, 3) };
        });

        // Leading blanks so day 1 lands under its weekday column.
        const firstComp = cal.timeToComponents(firstWT);
        const lead = Number.isInteger(firstComp.dayOfWeek) ? firstComp.dayOfWeek : 0;
        ctx.calLead = Array.from({ length: lead }, (_, i) => i);

        ctx.calDays = [];
        for (let d = 0; d < monthLen; d++) {
            const wt = firstWT + d * spd;
            const w = getDayHeadline(wt);
            const moon = cal.getMoonPhase?.(wt) ?? null;
            ctx.calDays.push({
                idx: d,
                day: d + 1,
                weatherIcon: w.icon,
                cond: composeWeatherLabel(w, localize) || "",
                badge: tierBadge(w),
                temp: `${w.temps.noon}°`,
                moonIcon: moon?.icon || "",
                moonName: moon ? (localize(moon.name) || "") : "",
                isToday: year === nowC.year && month === nowC.month && d === nowC.dayOfMonth,
                selected: this.#calSelDay === d
            });
        }

        // Detail panel for the selected day: the full Dawn→Night breakdown.
        if (this.#calSelDay != null && this.#calSelDay < monthLen) {
            const wt = firstWT + this.#calSelDay * spd;
            const comp = cal.timeToComponents(wt);
            const moon = cal.getMoonPhase?.(wt) ?? null;
            const sun = cal.getSunTimes?.(comp) ?? { dawn: 6, dusk: 18 };
            const head = getDayHeadline(wt);
            const tags = Object.keys(head.tags ?? {})
                .map(t => localize(`WITCHER.Weather.Tag.${t}`))
                .filter(Boolean);
            ctx.calDetail = {
                title: `${ordinal(this.#calSelDay + 1)} of ${ctx.calMonthName}, ${year}`,
                hasSeed: dayHasSeed(Math.floor(wt / spd)),
                weekday: localize(weekdays[comp.dayOfWeek]?.name) || "",
                season: localize(cal.seasons?.values?.[comp.season]?.name) || "",
                moonIcon: moon?.icon || "",
                moonName: moon ? (localize(moon.name) || "") : "",
                dawn: hhmm(sun.dawn),
                dusk: hhmm(sun.dusk),
                tags,
                dayparts: getDaypartsForTime(wt).map(p => ({
                    label: localize(`WITCHER.Weather.Daypart.${p.key}`) || p.key,
                    icon: p.icon,
                    cond: composeWeatherLabel(p, localize) || "",
                    badge: tierBadge(p),
                    temp: `${p.temp}°`
                }))
            };
        }
    }

    /* ─────────── live refresh ─────────── */

    async _onRender(context, options) {
        await super._onRender(context, options);

        // Climate <select> and the manual master toggle use change events
        // (actions are click-only), so wire them here.
        const climate = this.element.querySelector('[data-bind="climate"]');
        if (climate) climate.addEventListener("change", async (ev) => {
            const biome = ev.target.value;
            if (getActiveClimates()[biome]) await game.settings.set(SYSTEM_ID, "weatherBiome", biome);
        });
        const toggle = this.element.querySelector('[data-bind="manual-toggle"]');
        if (toggle) toggle.addEventListener("change", async (ev) => {
            await setManualEnabled(ev.target.checked);
        });
        // Calendar year jump: editable year in the month header. Commits on
        // change/Enter (not per keystroke) so partial values don't re-render.
        const yearBox = this.element.querySelector('[data-bind="cal-year"]');
        if (yearBox) {
            yearBox.addEventListener("change", (ev) => {
                const y = parseInt(ev.target.value, 10);
                if (!Number.isFinite(y)) { ev.target.value = this.#calYear ?? 0; return; }
                this.#calYear = y;
                this.#calSelDay = null;
                this.render();
            });
            yearBox.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
            });
        }

        if (this.#hookIds.length) return;  // register live-refresh hooks once
        const rerender = () => { if (this.rendered) this.render(); };
        const onSetting = (setting) => {
            const k = setting?.key ?? "";
            if (k === `${SYSTEM_ID}.weatherBiome`
                || k === `${SYSTEM_ID}.manualWeather`
                || k === `${SYSTEM_ID}.weatherSeeds`
                || k === `${SYSTEM_ID}.weatherModifiersOverride`
                || k === `${SYSTEM_ID}.weatherMapScene`
                || k === `${SYSTEM_ID}.latitudeSpan`
                || k === `${SYSTEM_ID}.frontSweepDays`) rerender();
        };
        // Moving (or flagging) the party-marker token changes the active place.
        const onToken = (doc) => { if (doc?.getFlag?.(SYSTEM_ID, "weatherMarker")) rerender(); };
        // Setting the marker CELL (or painting terrain) writes the map scene's
        // weatherMap flag via scene.setFlag → updateScene — not a setting/token —
        // so the panel must watch the designated scene's flags to refresh live.
        // Refresh on a flag change to the spatial-map scene OR the locally viewed
        // scene (the latter drives the scene-weather quick buttons).
        const onScene = (scene, changes) => {
            const flagged = changes?.flags?.[SYSTEM_ID] !== undefined;
            if (flagged && (scene?.id === getMapScene()?.id || scene?.id === canvas?.scene?.id)) rerender();
        };
        this.#hookIds.push(["updateWorldTime", Hooks.on("updateWorldTime", rerender)]);
        this.#hookIds.push(["updateSetting", Hooks.on("updateSetting", onSetting)]);
        this.#hookIds.push(["updateToken", Hooks.on("updateToken", onToken)]);
        this.#hookIds.push(["updateScene", Hooks.on("updateScene", onScene)]);
        // Switching the viewed scene changes which scene the quick buttons target.
        this.#hookIds.push(["canvasReady", Hooks.on("canvasReady", rerender)]);
        this.#hookIds.push(["wdm:weatherModifiersChanged", Hooks.on("wdm:weatherModifiersChanged", rerender)]);
    }

    _onClose(options) {
        for (const [hook, id] of this.#hookIds) Hooks.off(hook, id);
        this.#hookIds = [];
        super._onClose(options);
    }

    /* ─────────── actions ─────────── */

    static async #onAdjust(event, target) {
        const s = Number(target.dataset.adjust);
        if (!Number.isFinite(s) || s === 0) return;
        if (typeof game.time?.advance === "function") await game.time.advance(s);
        else if (typeof game.time?.set === "function") await game.time.set((Number(game.time.worldTime) || 0) + s);
        this.render();
    }

    static async #onJump(event, target) {
        const which = target.dataset.jump;
        const cal = game.time?.calendar;
        if (!cal?.timeToComponents || typeof game.time?.set !== "function") return;
        const c = cal.timeToComponents(game.time.worldTime ?? 0);
        const sun = cal.getSunTimes?.(c) ?? { dawn: 6, dusk: 18 };
        const target_h = which === "dawn" ? sun.dawn
            : which === "noon" ? 12
            : which === "dusk" ? sun.dusk
            : 0;
        // Sun times are fractional now (e.g. 6.34h), so split into hour+minute.
        // Mirror hhmm()'s rounding exactly (incl. the 60→roll-over and 24h wrap)
        // so the jumped-to time matches what the panel displayed.
        let hour = Math.floor(target_h);
        let minute = Math.round((target_h - hour) * 60);
        if (minute >= 60) { minute -= 60; hour += 1; }
        hour = ((hour % 24) + 24) % 24;
        await game.time.set({ year: c.year, day: c.day, hour, minute, second: 0 });
        this.render();
    }

    static async #onSetManual(event, target) {
        await setManualLayer(target.dataset.layer, target.dataset.state ?? "");
        this.render();
    }

    /* Set the viewed scene's weather presentation mode (Outdoors/Indoors/Disable).
     * Writes the same scene flag as the Scene-config buttons, so it persists. */
    static async #onSetSceneMode(event, target) {
        const scene = canvas?.scene;
        if (!scene) return;
        await setSceneWeatherMode(scene, target.dataset.mode);
        this.render();
    }

    /* Toggle the viewed scene's "disable time darkness" pin — an INDEPENDENT
     * per-scene flag (not a weather mode), so torch-lit maps keep their authored
     * lighting at any in-world hour. Persists on the scene doc; syncs via the
     * updateScene hook. */
    static async #onSetTimeDarkness() {
        const scene = canvas?.scene;
        if (!scene) return;
        await setSceneTimeDarknessDisabled(scene, !isTimeDarknessDisabled(scene));
        this.render();
    }

    /* Grab/release an environmental condition (heat exhaustion / cold) onto the
     * selected token actors, or the GM's own assigned character if none. */
    static async #onGrabCondition(event, target) {
        await grabWeatherCondition(target.dataset.condition);
        this.render();
    }

    static async #onEditPenalties() {
        const app = new WeatherConfigApp();
        await app.render(true);
        app.changeTab("modifiers", "primary");
    }

    /* Step the viewed month back/forward, wrapping the year. Clears the day
     * selection so the detail panel doesn't point at a stale day. */
    static #onCalStep(app, delta) {
        const months = game.time?.calendar?.months?.values?.length || 12;
        const meta = app.#monthMeta();
        if (!meta) return;
        let m = meta.month + delta;
        let y = meta.year;
        if (m < 0) { m = months - 1; y--; }
        else if (m >= months) { m = 0; y++; }
        app.#calYear = y;
        app.#calMonth = m;
        app.#calSelDay = null;
        app.render();
    }

    static async #onCalPrev() { WeatherControlApp.#onCalStep(this, -1); }
    static async #onCalNext() { WeatherControlApp.#onCalStep(this, 1); }

    static async #onCalToday() {
        const cal = game.time?.calendar;
        if (!cal?.timeToComponents) return;
        const c = cal.timeToComponents(game.time?.worldTime ?? 0);
        this.#calYear = c.year;
        this.#calMonth = c.month;
        this.#calSelDay = c.dayOfMonth;
        this.render();
    }

    static async #onCalSelect(event, target) {
        const idx = Number(target.dataset.day);
        if (!Number.isInteger(idx)) return;
        this.#calSelDay = this.#calSelDay === idx ? null : idx;
        this.render();
    }

    /* Travel the world clock to the selected day, preserving the current
     * time-of-day. Explicit (button in the detail panel), never on plain
     * day-click, so the GM can browse without moving game time. */
    static async #onCalGoto() {
        const meta = this.#monthMeta();
        if (!meta || this.#calSelDay == null || typeof game.time?.set !== "function") return;
        const c = meta.cal.timeToComponents(game.time?.worldTime ?? 0);
        await game.time.set({
            year: meta.year,
            day: meta.doy + this.#calSelDay,
            hour: c.hour, minute: c.minute, second: c.second
        });
        this.render();
    }

    /* Reroll the whole on-screen month: a fresh seed reshuffles its weather
     * (a small seam appears at the month edges). */
    static async #onCalRegenMonth() {
        const meta = this.#monthMeta();
        if (!meta) return;
        await regenerateMonth(meta.year, meta.month);
        this.render();
    }

    /* Clear the month's reroll — back to the canonical default weather. */
    static async #onCalResetMonth() {
        const meta = this.#monthMeta();
        if (!meta) return;
        await resetMonth(meta.year, meta.month);
        this.render();
    }

    /* Reroll just the selected day (seams on both sides). */
    static async #onCalRegenDay() {
        const meta = this.#monthMeta();
        if (!meta || this.#calSelDay == null) return;
        await regenerateDay(Math.floor((meta.firstWT + this.#calSelDay * meta.spd) / meta.spd));
        this.render();
    }

    /* Clear the selected day's reroll. */
    static async #onCalResetDay() {
        const meta = this.#monthMeta();
        if (!meta || this.#calSelDay == null) return;
        await resetDay(Math.floor((meta.firstWT + this.#calSelDay * meta.spd) / meta.spd));
        this.render();
    }
}
