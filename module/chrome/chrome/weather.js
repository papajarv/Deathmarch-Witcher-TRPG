/**
 * Time / date strip + GM time controls — top-bar widget.
 *
 * Reads the INBUILT calendar (`game.time.calendar`, a WitcherCalendar — see
 * module/setup/calendar.mjs) for date, season sun times, and moon phase.
 * No external calendar dependency.
 *
 * Renders under the scene name in the top bar:
 *   [circle 18px] [4th of Belleteyn, 1272] [12° condition]
 *
 * The circle image is TIME-of-day driven (not weather):
 *   dawn  → dawn.jpg   day → noon.jpg   dusk → dusk.jpg
 *   night → full/waning/crescent.jpg  (by moon phase)
 *
 * Weather (temp + condition icon/label) comes from the inbuilt deterministic
 * engine in module/mechanics/weather.mjs — a pure function of the calendar
 * day, so it needs no stored state and the GM panel can show a multi-day
 * forecast directly.
 *
 * GM-only: clicking the glyph opens a control panel — current date/time,
 * advance/rewind shortcuts, jump-to dawn/noon/dusk/midnight, a climate
 * selector, and a short forecast.
 */

import { getActiveWeatherModifiers, groupWeatherModifiers, getActiveWeatherNotes }
    from "../../mechanics/weather-modifiers.mjs";
import { getActiveWeather } from "../../mechanics/manual-weather.mjs";
import {
    availableWeatherConditions, grabWeatherCondition, hasWeatherCondition, WEATHER_CONDITIONS
} from "../../mechanics/weather-conditions.mjs";
import { WeatherControlApp } from "../../applications/weatherControl.mjs";

const ASSET_BASE = "systems/witcher-ttrpg-death-march/assets/weather";

const TIME_IMAGE = {
    dawn: "dawn.jpg",
    day:  "noon.jpg",
    dusk: "dusk.jpg"
    // night → procedural moon SVG (moonSvgDataUri) keyed to the real phase
};

// Moonless night sky — the original full.jpg with its baked-in moon painted
// out (per-row sky gradient) and the treeline kept. The procedural moon below
// is layered on top of this, positioned over the old moon's spot so it blends.
const SKY_NIGHT = `${ASSET_BASE}/sky-night.png`;

/* Build a TRANSPARENT moon-phase overlay SVG (as a data URI) for a phase
 * fraction p ∈ [0,1): 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last
 * quarter. Drawn procedurally so it shows the *exact* phase the calendar
 * reports rather than snapping to three coarse images, then composited over
 * SKY_NIGHT by the caller.
 *
 * Geometry: the lit region is bounded by the bright limb (a semicircle, on the
 * right while waxing, left while waning) and the terminator (a semi-ellipse
 * whose horizontal radius shrinks to 0 at the quarters and grows to the moon
 * radius at new/full). Illuminated fraction f = (1−cos2πp)/2; the terminator
 * bulging toward the limb yields a crescent, away yields a gibbous. Only the
 * lit shape (plus a soft halo) is painted, so the unlit limb melts into the
 * sky exactly as in the reference art. The moon sits in the upper-centre, over
 * where the erased jpg moon used to be. */
function moonOverlayDataUri(p) {
    const mx = 11.5, my = 7.5, mr = 5;        // moon centre / radius (24-unit box)
    const cosv = Math.cos(2 * Math.PI * p);
    const f = (1 - cosv) / 2;                 // illuminated fraction 0..1
    const LIT = "#eef1ff";

    let moon = "";
    if (f > 0.015) {
        moon += `<circle cx="${mx}" cy="${my}" r="${(mr + 2).toFixed(2)}" fill="${LIT}" opacity="0.13"/>`;
        if (f >= 0.985) {
            moon += `<circle cx="${mx}" cy="${my}" r="${mr}" fill="${LIT}"/>`;
        } else {
            const a = (mr * Math.abs(cosv)).toFixed(3);   // terminator x-radius
            const waxing = p < 0.5;
            const gibbous = cosv < 0;
            const limbSweep = waxing ? 1 : 0;
            const termSweep = (waxing === gibbous) ? 1 : 0;
            const top = `${mx},${(my - mr).toFixed(2)}`, bot = `${mx},${(my + mr).toFixed(2)}`;
            moon +=
                `<path d="M ${top} A ${mr} ${mr} 0 0 ${limbSweep} ${bot} ` +
                `A ${a} ${mr} 0 0 ${termSweep} ${top} Z" fill="${LIT}"/>`;
        }
    }

    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${moon}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function ordinal(n) {
    const s = n % 10, t = n % 100;
    if (t >= 11 && t <= 13) return `${n}th`;
    if (s === 1) return `${n}st`;
    if (s === 2) return `${n}nd`;
    if (s === 3) return `${n}rd`;
    return `${n}th`;
}

// Dawn = first hour of light, dusk = first hour of dark; one-hour transition
// bands give us the four time-of-day classes.
function computeTimeClass(currentHour, sunTimes) {
    const dawn = sunTimes?.dawn ?? 6;
    const dusk = sunTimes?.dusk ?? 18;
    if (currentHour >= dawn && currentHour < dawn + 1) return "dawn";
    if (currentHour >= dawn + 1 && currentHour < dusk) return "day";
    if (currentHour >= dusk && currentHour < dusk + 1) return "dusk";
    return "night";
}

function localize(key) {
    return key ? game.i18n.localize(key) : "";
}

function readState() {
    const cal = game.time?.calendar;
    if (!cal?.timeToComponents) return null;
    const ts = game.time.worldTime ?? 0;
    const comps = cal.timeToComponents(ts);
    if (!comps) return null;

    const monthName = localize(cal.months?.values?.[comps.month]?.name);
    // Calendar dayOfMonth is 0-based; +1 for display.
    const humanDay = (comps.dayOfMonth ?? 0) + 1;
    const dateStr = monthName
        ? `${ordinal(humanDay)} of ${monthName}, ${comps.year}`
        : `${ordinal(humanDay)}, ${comps.year}`;

    const sunTimes = cal.getSunTimes?.(comps) ?? { dawn: 6, dusk: 18 };
    const currentHour = comps.hour + comps.minute / 60;
    const timeClass = computeTimeClass(currentHour, sunTimes);

    const phase = cal.getMoonPhase?.(ts) ?? null;
    const moonName = phase ? localize(phase.name) : "";

    let bgImage, moonTip = "";
    if (timeClass === "night") {
        const p = (phase && phase.cycleLength)
            ? (phase.dayInCycle / phase.cycleLength)
            : 0.5;
        // Moon overlay on top, moonless sky behind.
        bgImage = `url("${moonOverlayDataUri(p)}"), url("${SKY_NIGHT}")`;
        moonTip = moonName;
    } else {
        bgImage = `url("${ASSET_BASE}/${TIME_IMAGE[timeClass]}")`;
    }

    // Active weather — GM manual override if on, else the deterministic engine.
    const weather = getActiveWeather(ts);
    const condition = localize(weather.label) || "—";
    const tempStr = `${weather.temp}°`;
    const weatherLabel = `${tempStr} · ${condition}`;
    const faIcon = weather.icon || "fas fa-cloud";

    return { dateStr, weatherLabel, condition, tempStr, faIcon, bgImage, timeClass, moonTip };
}

function ensureMount() {
    const topbar = document.getElementById("wou-top-bar");
    if (!topbar) return null;
    let strip = topbar.querySelector("#wou-weather");
    if (strip) return strip;
    const brandText = topbar.querySelector(".brand .brand-text");
    if (!brandText) return null;
    strip = document.createElement("div");
    strip.id = "wou-weather";
    strip.className = "wou-weather is-empty";
    strip.innerHTML = `
        <span class="wou-weather-circle" aria-hidden="true"></span>
        <span class="wou-weather-date" data-bind="weather-date">—</span>
        <span class="wou-weather-temp" data-bind="weather-temp"></span>
        <i class="wou-weather-fa fas fa-cloud-moon" data-bind="weather-fa" data-tooltip=""></i>
    `;
    brandText.appendChild(strip);

    /* Clicking the glyph pops a panel: GMs get the full time-control panel,
     * players get a read-only view (current time + weather + the stacked
     * effects readout). */
    const fa = strip.querySelector('[data-bind="weather-fa"]');
    if (fa) {
        fa.classList.add("is-clickable");
        fa.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            toggleMenu(fa);
        });
    }
    return strip;
}

let refreshTimer = null;
function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshNow(); }, 80);
}

function refreshNow() {
    const strip = ensureMount();
    if (!strip) return;
    const state = readState();
    if (!state) {
        strip.classList.add("is-empty");
        return;
    }
    strip.classList.remove("is-empty");
    strip.classList.remove("is-dawn", "is-day", "is-dusk", "is-night");
    strip.classList.add(`is-${state.timeClass}`);

    const circle = strip.querySelector(".wou-weather-circle");
    if (circle) {
        circle.style.backgroundImage = state.bgImage;
        if (state.moonTip) circle.setAttribute("data-tooltip", state.moonTip);
        else circle.removeAttribute("data-tooltip");
    }

    const date = strip.querySelector('[data-bind="weather-date"]');
    if (date) date.textContent = state.dateStr;

    const temp = strip.querySelector('[data-bind="weather-temp"]');
    if (temp) temp.textContent = state.tempStr ?? "";

    const fa = strip.querySelector('[data-bind="weather-fa"]');
    if (fa) {
        fa.className = `wou-weather-fa ${state.faIcon} is-clickable`;
        fa.setAttribute("data-tooltip", state.weatherLabel ?? "");
    }
}

/* =============================================================================
   GM time-control panel — pops from the glyph. Current date/time, advance /
   rewind shortcuts, and jump-to dawn/noon/dusk/midnight.
   ============================================================================= */

let _gmMenuEl = null;
/* Cache of the last grabs/effects HTML so the real-time clock (time-flow fires
 * updateWorldTime several times a second) only rebuilds those DOM sections when
 * their content actually changes — rebuilding every tick made the hovered grab
 * button flicker as its :hover state was destroyed and recreated. */
let _lastGrabsHtml = "";
let _lastFxHtml = "";

function readClock() {
    const cal = game.time?.calendar;
    if (!cal?.timeToComponents) return "—";
    const c = cal.timeToComponents(game.time.worldTime ?? 0);
    if (!c) return "—";
    const hh = String(c.hour ?? 0).padStart(2, "0");
    const mm = String(c.minute ?? 0).padStart(2, "0");
    const ss = String(c.second ?? 0).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
}

/* Signed integer for display: +2 / −3 (real minus glyph). 0 → "±0". */
function signed(n) {
    const v = Number(n) || 0;
    if (v > 0) return `+${v}`;
    if (v < 0) return `−${Math.abs(v)}`;
    return "±0";
}

/* Stacked modifier readout for the CURRENTLY active weather. Groups the typed
 * modifier records by target, shows the net effect per target, and lists the
 * contributing sources beneath. Display-only; the same records feed the future
 * combat overhaul. Returns an empty-state line when the weather is benign. */
function modifiersHtml() {
    const groups = groupWeatherModifiers(getActiveWeatherModifiers());
    const notes = getActiveWeatherNotes();
    if (!groups.length && !notes.length) {
        return `<div class="wou-wm-fx-empty">${localize("WITCHER.Weather.NoEffects") || "No notable effects."}</div>`;
    }
    const rows = groups.map(g => {
        const cls = g.total > 0 ? "is-boon" : g.total < 0 ? "is-bane" : "";
        const parts = g.parts.map(p =>
            `<span class="wou-wm-fx-part">${signed(p.value)} ${localize(p.label)}</span>`
        ).join("");
        return `
            <div class="wou-wm-fx-row ${cls}">
                <span class="wou-wm-fx-target">${localize(g.targetLabel)}</span>
                <span class="wou-wm-fx-total">${signed(g.total)}</span>
                <span class="wou-wm-fx-parts">${parts}</span>
            </div>`;
    }).join("");
    const noteRows = notes.map(n =>
        `<div class="wou-wm-fx-note">${localize(n)}</div>`
    ).join("");
    return rows + noteRows;
}

/* Grab buttons for the environmental conditions the current weather makes
 * available (heat exhaustion / cold tiers). Clicking applies/removes the
 * condition on the user's own character (or selected tokens). Empty string
 * when the weather isn't extreme enough to offer anything. */
function conditionsHtml() {
    const ids = availableWeatherConditions();
    if (!ids.length) return "";
    let tempStr = "";
    try { tempStr = ` (${getActiveWeather().temp}°)`; } catch (_) { /* not ready */ }
    const own = game?.user?.character ?? null;
    const stun = Math.max(1, Number(own?.system?.derivedStats?.stun) || 1);
    const btns = ids.map(id => {
        const spec = WEATHER_CONDITIONS[id];
        if (!spec) return "";
        const active = own ? hasWeatherCondition(own, id) : false;
        const hours = id === "freezing" ? Math.max(1, Math.floor(stun / 2)) : stun;
        const desc = game.i18n.format(
            `WITCHER.Weather.Condition.${id[0].toUpperCase()}${id.slice(1)}Desc`, { hours });
        return `<button type="button" class="wou-wm-grab ${active ? "is-active" : ""}"
                data-action="grab-condition" data-condition="${id}"
                data-tooltip="${desc}" data-tooltip-direction="UP">
                <i class="${spec.kind === "heat" ? "fas fa-sun" : "fas fa-snowflake"}"></i>
                <span>${localize(spec.name)}</span>
            </button>`;
    }).join("");
    return `<div class="wou-wm-section wou-wm-grabs">
            <div class="wou-wm-head">${localize("WITCHER.Weather.Condition.GrabHead")}${tempStr}</div>
            <div class="wou-wm-grab-row">${btns}</div>
            <div class="wou-wm-grab-hint">${localize("WITCHER.Weather.Condition.GrabHint")}</div>
        </div>`;
}

function closeGmMenu() {
    _gmMenuEl?.remove();
    _gmMenuEl = null;
    document.removeEventListener("pointerdown", onGmMenuOutsideClick, true);
    document.removeEventListener("keydown", onGmMenuKey, true);
}

function onGmMenuOutsideClick(ev) {
    if (!_gmMenuEl) return;
    if (_gmMenuEl.contains(ev.target)) return;
    if (ev.target.closest?.(".wou-weather-fa.is-clickable")) return;
    closeGmMenu();
}

function onGmMenuKey(ev) {
    if (ev.key === "Escape") closeGmMenu();
}

/* Refresh the open read-only player popup in place (date/time/effects). The GM
 * console is a separate ApplicationV2 window that refreshes itself. */
function refreshGmMenuContent() {
    if (!_gmMenuEl) return;
    const state = readState();
    const dateEl = _gmMenuEl.querySelector('[data-bind="wm-date"]');
    const timeEl = _gmMenuEl.querySelector('[data-bind="wm-time"]');
    if (dateEl) dateEl.textContent = state?.dateStr ?? "—";
    if (timeEl) timeEl.textContent = readClock();
    // Only touch these sections when their HTML changed, so a hovered grab
    // button isn't destroyed/recreated on every real-time clock tick.
    const fxEl = _gmMenuEl.querySelector('[data-bind="wm-effects"]');
    if (fxEl) {
        const fx = modifiersHtml();
        if (fx !== _lastFxHtml) { fxEl.innerHTML = fx; _lastFxHtml = fx; }
    }
    const grabs = _gmMenuEl.querySelector(".wou-wm-grabs");
    if (grabs) {
        const gh = conditionsHtml();
        if (gh !== _lastGrabsHtml) { grabs.outerHTML = gh; _lastGrabsHtml = gh; }
    }
}

/* Read-only popup for players: current date/time, weather condition, and the
 * stacked effects readout. No time controls. The GM gets the full
 * WeatherControlApp window instead (see toggleMenu). */
function openInfoMenu(anchor) {
    closeGmMenu();
    const state = readState();
    // Seed the change-detection caches to match the freshly rendered markup.
    _lastFxHtml = modifiersHtml();
    _lastGrabsHtml = conditionsHtml();

    const el = document.createElement("div");
    el.id = "wou-weather-menu";
    el.classList.add("is-readonly");
    el.innerHTML = `
        <div class="wou-wm-section">
            <div class="wou-wm-head">Current time</div>
            <div class="wou-wm-clock">
                <span class="wou-wm-date" data-bind="wm-date">${state?.dateStr ?? "—"}</span>
                <span class="wou-wm-time" data-bind="wm-time">${readClock()}</span>
            </div>
        </div>
        <div class="wou-wm-section">
            <div class="wou-wm-head">${localize("WITCHER.Weather.Conditions") || "Conditions"}</div>
            <div class="wou-wm-clock">
                <i class="${state?.faIcon ?? "fas fa-cloud"}"></i>
                <span class="wou-wm-date">${state?.weatherLabel ?? "—"}</span>
            </div>
        </div>
        <div class="wou-wm-section">
            <div class="wou-wm-head">${localize("WITCHER.Weather.Effects") || "Weather effects"}</div>
            <div class="wou-wm-fx" data-bind="wm-effects">${_lastFxHtml}</div>
        </div>
        ${_lastGrabsHtml}
    `;
    mountMenu(el, anchor);
}

/* Append a popup to the body, position it under the anchor clamped to the
 * viewport, and wire the deferred outside-click / Escape listeners. Shared by
 * the GM and player panels. */
function mountMenu(el, anchor) {
    document.body.appendChild(el);
    _gmMenuEl = el;

    /* Grab/release a weather condition onto the user's own actor, then refresh
     * the button's active state in place. */
    el.addEventListener("click", async (ev) => {
        const btn = ev.target.closest?.('[data-action="grab-condition"]');
        if (!btn || !el.contains(btn)) return;
        ev.preventDefault();
        ev.stopPropagation();
        await grabWeatherCondition(btn.dataset.condition);
        const grabs = el.querySelector(".wou-wm-grabs");
        if (grabs) { _lastGrabsHtml = conditionsHtml(); grabs.outerHTML = _lastGrabsHtml; }
    });

    const r = anchor.getBoundingClientRect();
    const mr = el.getBoundingClientRect();
    const left = Math.min(
        Math.max(8, Math.round(r.left + r.width / 2 - mr.width / 2)),
        Math.max(8, window.innerWidth - mr.width - 8)
    );
    const top = Math.min(
        Math.round(r.bottom + 8),
        Math.max(8, window.innerHeight - mr.height - 8)
    );
    el.style.position = "fixed";
    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
    el.style.zIndex = "10000";

    /* Defer the outside-click listener so the opening click doesn't close it. */
    setTimeout(() => {
        document.addEventListener("pointerdown", onGmMenuOutsideClick, true);
        document.addEventListener("keydown", onGmMenuKey, true);
    }, 0);
}

/* GM time/weather console — a single reusable window instance. */
let _gmApp = null;

function toggleMenu(anchor) {
    if (game?.user?.isGM) {
        // GM: toggle the tabbed console window, anchored UNDER the glyph (like
        // the old dropdown) instead of floating in the middle of the screen.
        if (!_gmApp) _gmApp = new WeatherControlApp();
        if (_gmApp.rendered) { _gmApp.close(); return; }
        const r = anchor.getBoundingClientRect();
        const width = 480;
        let left = Math.round(r.left + r.width / 2 - width / 2);
        left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8));
        const top = Math.round(r.bottom + 8);
        _gmApp.render({ force: true, position: { left, top, width } });
        return;
    }
    // Player: toggle the lightweight read-only popup.
    if (_gmMenuEl) { closeGmMenu(); return; }
    openInfoMenu(anchor);
}

export function wireWeather() {
    // Master switch — when off, a GM is running an external calendar/weather
    // widget. Suppress our strip entirely (remove any leftover) and skip hook
    // wiring; worldTime-driven timers elsewhere are unaffected.
    let enabled = true;
    try { enabled = game.settings.get("witcher-ttrpg-death-march", "weatherEnabled"); } catch (_) { /* unregistered */ }
    if (!enabled) {
        document.getElementById("wou-weather")?.remove();
        return;
    }

    Hooks.on("updateWorldTime", () => { scheduleRefresh(); refreshGmMenuContent(); });
    Hooks.on("updateScene",     () => { scheduleRefresh(); });
    Hooks.on("canvasReady",     () => { scheduleRefresh(); });
    // Climate change (Configure Settings or the GM panel) re-derives weather.
    Hooks.on("updateSetting", (setting) => {
        const k = setting?.key ?? "";
        if (k === "witcher-ttrpg-death-march.weatherBiome"
            || k === "witcher-ttrpg-death-march.manualWeather") {
            scheduleRefresh();
            refreshGmMenuContent();
        }
    });
    // Penalty table edited — refresh the open panel's effects readout.
    Hooks.on("wdm:weatherModifiersChanged", () => { refreshGmMenuContent(); });
    refreshNow();
}
