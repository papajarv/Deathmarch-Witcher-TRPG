/**
 * WitcherCalendar — the system's in-world calendar.
 *
 * Foundry v14's native `foundry.data.CalendarData` already models months,
 * days, weekdays, seasons and leap years (and powers `game.time.calendar`'s
 * `timeToComponents` / `componentsToTime`). It does NOT model time-of-day
 * sun positions or moon phases, so we subclass it to add a `sun` block
 * (per-season dawn/dusk) and a `moons` block (cycle + phases), with
 * `getSunTimes()` / `getMoonPhase()` helpers.
 *
 * Registered via `CONFIG.time.worldCalendarClass` + `worldCalendarConfig`
 * in the `init` hook (before `game.time.initializeCalendar()` runs). This
 * is what makes the calendar inbuilt — no external calendar module.
 *
 * `componentsToTime` only reads {year, day, hour, minute, second} — the
 * absolute day-of-year `day`, NOT month/dayOfMonth — so the moon anchor
 * (`firstNewMoon`) is expressed as {year, day}.
 */

const CalendarData = foundry.data.CalendarData;
const SYSTEM_ID = "witcher-ttrpg-death-march";

/**
 * Day-of-year midpoint of each season, in `seasons.values` order. Pure calendar
 * geometry (month lengths + each season's month-span), so seasonal quantities
 * (sun times here, temperature in the weather engine) can be interpolated as a
 * continuous annual curve instead of stepping at season boundaries. Works on any
 * CalendarData-shaped object, so the weather engine can reuse it.
 * @param {object} cal  A calendar with `.months.values`, `.seasons.values`, `.days`.
 * @returns {{ yearLength:number, centers:Array<{index:number, center:number}> }|null}
 */
export function seasonMidpoints(cal) {
    const months = cal?.months?.values;
    const seasonDefs = cal?.seasons?.values;
    if (!Array.isArray(months) || !months.length) return null;
    if (!Array.isArray(seasonDefs) || !seasonDefs.length) return null;
    const yearLength = cal.days?.daysPerYear || months.reduce((a, m) => a + (m.days || 0), 0);
    if (!(yearLength > 0)) return null;

    const prefix = [];                       // day-of-year each month begins
    let acc = 0;
    for (const m of months) { prefix.push(acc); acc += (m.days || 0); }
    const idxByOrdinal = new Map(months.map((m, i) => [m.ordinal, i]));

    const centers = [];
    for (let si = 0; si < seasonDefs.length; si++) {
        const sv = seasonDefs[si];
        const startIdx = idxByOrdinal.get(sv.monthStart);
        const endIdx = idxByOrdinal.get(sv.monthEnd);
        if (startIdx == null || endIdx == null) continue;
        let len = 0, k = startIdx;               // total days start→end, wrapping the year
        for (let g = 0; g <= months.length; g++) {
            len += months[k].days || 0;
            if (k === endIdx) break;
            k = (k + 1) % months.length;
        }
        const center = ((prefix[startIdx] + len / 2) % yearLength + yearLength) % yearLength;
        centers.push({ index: si, center });
    }
    if (centers.length < 2) return null;
    return { yearLength, centers };
}

export class WitcherCalendar extends CalendarData {

    static defineSchema() {
        const fields = foundry.data.fields;
        const base = super.defineSchema();
        return {
            ...base,
            // Per-season dawn/dusk (hour-of-day). Aligned by index to
            // `seasons.values`; `getSunTimes` keys off the season index that
            // `timeToComponents` returns.
            sun: new fields.SchemaField({
                values: new fields.ArrayField(new fields.SchemaField({
                    dawn: new fields.NumberField({ required: true, nullable: false, initial: 6 }),
                    dusk: new fields.NumberField({ required: true, nullable: false, initial: 18 })
                }))
            }, { required: false, nullable: true, initial: null }),
            // One or more moons. Phase `length` values are in days and should
            // sum to (roughly) `cycleLength`. `firstNewMoon` anchors the cycle.
            moons: new fields.SchemaField({
                values: new fields.ArrayField(new fields.SchemaField({
                    name: new fields.StringField({ required: true, blank: false }),
                    cycleLength: new fields.NumberField({ required: true, nullable: false, positive: true }),
                    firstNewMoon: new fields.SchemaField({
                        year: new fields.NumberField({ integer: true, initial: 0 }),
                        day: new fields.NumberField({ integer: true, initial: 0 })
                    }, { required: false, nullable: true, initial: null }),
                    phases: new fields.ArrayField(new fields.SchemaField({
                        name: new fields.StringField({ required: true, blank: false }),
                        abbreviation: new fields.StringField(),
                        length: new fields.NumberField({ required: true, nullable: false, min: 0 }),
                        icon: new fields.StringField()
                    }))
                }))
            }, { required: false, nullable: true, initial: null })
        };
    }

    /** Seconds in one calendar day. */
    get secondsPerDay() {
        const { secondsPerMinute, minutesPerHour, hoursPerDay } = this.days;
        return secondsPerMinute * minutesPerHour * hoursPerDay;
    }

    /**
     * Dawn/dusk hours for the given components. Interpolated as a continuous
     * annual curve: each season's configured dawn/dusk is treated as an anchor
     * at that season's calendar midpoint, and the day's value is cosine-eased
     * between the two bracketing anchors (same shape the weather engine uses
     * for temperature). This keeps daylight length from stepping at season
     * boundaries — at a season midpoint the result equals that season's exact
     * configured values, and it eases smoothly in between. Returns FRACTIONAL
     * hours (e.g. 6.5 = 06:30); callers that display or jump to these must
     * format/split minutes accordingly. Falls back to the discrete per-season
     * value when calendar geometry or `components.day` is unavailable.
     * @param {object} components  Output of `timeToComponents` (uses `.day`, `.season`).
     * @returns {{dawn:number, dusk:number}}
     */
    getSunTimes(components) {
        const fallback = { dawn: 6, dusk: 18 };
        const sun = this.sun?.values;
        if (!Array.isArray(sun) || !sun.length) return fallback;

        const discrete = () => {
            const idx = Number.isInteger(components?.season) ? components.season : 0;
            const s = sun[idx] ?? sun[0];
            return { dawn: s?.dawn ?? fallback.dawn, dusk: s?.dusk ?? fallback.dusk };
        };

        const dayOfYear = components?.day;
        if (!Number.isFinite(dayOfYear)) return discrete();
        const geom = seasonMidpoints(this);
        if (!geom) return discrete();
        const { yearLength, centers } = geom;

        // Pair each season midpoint with that season's sun values, sorted by
        // day-of-year so the bracket search walks the year in order.
        const anchors = [];
        for (const c of centers) {
            const s = sun[c.index];
            if (!s) continue;
            anchors.push({ center: c.center, dawn: s.dawn ?? fallback.dawn, dusk: s.dusk ?? fallback.dusk });
        }
        if (anchors.length < 2) return discrete();
        anchors.sort((p, q) => p.center - q.center);

        const n = anchors.length;
        let i = 0;
        while (i < n && dayOfYear >= anchors[i].center) i++;
        const b = anchors[i % n];                       // next anchor (wraps)
        const a = anchors[(i - 1 + n) % n];             // previous anchor (wraps)
        const span = (((b.center - a.center) % yearLength) + yearLength) % yearLength || yearLength;
        const pos = (((dayOfYear - a.center) % yearLength) + yearLength) % yearLength;
        const f = span ? pos / span : 0;
        const e = (1 - Math.cos(Math.PI * (f < 0 ? 0 : f > 1 ? 1 : f))) / 2;
        return {
            dawn: a.dawn + (b.dawn - a.dawn) * e,
            dusk: a.dusk + (b.dusk - a.dusk) * e
        };
    }

    /**
     * Current phase of a moon at a given world time.
     * @param {number} worldTime   Seconds; defaults to current world time.
     * @param {number} moonIndex   Which moon (default primary).
     * @returns {{name, icon, index, dayInCycle, cycleLength}|null}
     */
    getMoonPhase(worldTime = game.time?.worldTime ?? 0, moonIndex = 0) {
        const moon = this.moons?.values?.[moonIndex];
        if (!moon) return null;
        const spd = this.secondsPerDay;
        if (!spd) return null;
        const phases = moon.phases ?? [];
        if (!phases.length) return null;
        const cycleLength = Number(moon.cycleLength)
            || phases.reduce((s, p) => s + (Number(p.length) || 0), 0);
        if (!(cycleLength > 0)) return null;

        const anchorSecs = moon.firstNewMoon
            ? this.componentsToTime({ year: moon.firstNewMoon.year ?? 0, day: moon.firstNewMoon.day ?? 0 })
            : 0;
        const daysSince = (worldTime - anchorSecs) / spd;
        const dayInCycle = ((daysSince % cycleLength) + cycleLength) % cycleLength;

        let cum = 0;
        for (let i = 0; i < phases.length; i++) {
            cum += Number(phases[i].length) || 0;
            if (dayInCycle < cum) {
                return { name: phases[i].name, icon: phases[i].icon, index: i, dayInCycle, cycleLength };
            }
        }
        const last = phases.length - 1;
        return { name: phases[last].name, icon: phases[last].icon, index: last, dayInCycle, cycleLength };
    }
}

/**
 * Point Foundry's in-world timekeeping at the Witcher calendar. Call in
 * `init` AFTER `registerSettings()` (we read the GM override setting). The
 * GameTime constructor reads `CONFIG.time` when it builds the live calendar;
 * if it was already built (timing), `setup` re-runs `initializeCalendar()`.
 *
 * A non-empty `calendarConfig` world setting (GM-edited) overrides the seed.
 */
export function registerCalendar() {
    // A Witcher combat ROUND is 3 seconds; the round is the unit of time, not
    // the individual combatant turn. Foundry's combat clock (Combat#getTimeDelta)
    // advances worldTime by `rounds * roundTime + turns * turnTime`, so leaving
    // turnTime > 0 would DOUBLE-count: advancing one combatant's turn (which, in
    // a single-combatant fight, wraps to the next round) would tick roundTime +
    // turnTime = 6s = two display-rounds. turnTime = 0 makes each round advance
    // exactly 3s regardless of combatant count, so a "20 round" potion = 60s and
    // a single turn-skip drops the on-dock countdown by exactly one round.
    CONFIG.time.roundTime = 3;
    CONFIG.time.turnTime = 0;

    // Master switch: when the inbuilt time/weather widget is off, don't claim
    // the world calendar — leave it to an external module or Foundry's default.
    // Combat pacing above is still set so worldTime-driven timers keep working.
    let enabled = true;
    try { enabled = game.settings.get(SYSTEM_ID, "weatherEnabled"); } catch (_) { /* unregistered */ }
    if (!enabled) return;

    CONFIG.time.worldCalendarClass = WitcherCalendar;
    let override = null;
    try { override = game.settings.get(SYSTEM_ID, "calendarConfig"); } catch (_) { /* unregistered */ }
    CONFIG.time.worldCalendarConfig = (override && Object.keys(override).length)
        ? override
        : WITCHER_CALENDAR_CONFIG;
}

/**
 * Default seed calendar for the Witcher Continent. Fully GM-editable (a
 * world setting overrides this). Month / season / moon-phase names use
 * `WITCHER.Calendar.*` i18n keys.
 *
 * Twelve months, the canonical seasonal festivals folded in where they
 * fall (Imbaelk, Birke, Belleteyn, Midaëte, Lammas, Velen, Saovine), four
 * seasons, and one moon ("the moon") on a 28-day eight-phase cycle.
 */
export const WITCHER_CALENDAR_CONFIG = {
    name: "WITCHER.Calendar.Name",
    description: "WITCHER.Calendar.Description",
    years: {
        yearZero: 0,
        firstWeekday: 0,
        leapYear: { leapStart: 0, leapInterval: 4 }
    },
    months: {
        values: [
            { name: "WITCHER.Calendar.Months.Midwinter", ordinal: 1,  days: 31 },
            { name: "WITCHER.Calendar.Months.Imbaelk",   ordinal: 2,  days: 28, leapDays: 29 },
            { name: "WITCHER.Calendar.Months.Birke",     ordinal: 3,  days: 31 },
            { name: "WITCHER.Calendar.Months.Bloom",     ordinal: 4,  days: 30 },
            { name: "WITCHER.Calendar.Months.Belleteyn", ordinal: 5,  days: 31 },
            { name: "WITCHER.Calendar.Months.Midaete",   ordinal: 6,  days: 30 },
            { name: "WITCHER.Calendar.Months.Highsun",   ordinal: 7,  days: 31 },
            { name: "WITCHER.Calendar.Months.Lammas",    ordinal: 8,  days: 31 },
            { name: "WITCHER.Calendar.Months.Harvest",   ordinal: 9,  days: 30 },
            { name: "WITCHER.Calendar.Months.Velen",     ordinal: 10, days: 31 },
            { name: "WITCHER.Calendar.Months.Saovine",   ordinal: 11, days: 30 },
            { name: "WITCHER.Calendar.Months.Deepfrost", ordinal: 12, days: 31 }
        ]
    },
    days: {
        values: [
            { name: "WITCHER.Calendar.Days.Monday",    ordinal: 1 },
            { name: "WITCHER.Calendar.Days.Tuesday",   ordinal: 2 },
            { name: "WITCHER.Calendar.Days.Wednesday", ordinal: 3 },
            { name: "WITCHER.Calendar.Days.Thursday",  ordinal: 4 },
            { name: "WITCHER.Calendar.Days.Friday",    ordinal: 5 },
            { name: "WITCHER.Calendar.Days.Saturday",  ordinal: 6 },
            { name: "WITCHER.Calendar.Days.Sunday",    ordinal: 7 }
        ],
        daysPerYear: 365,
        hoursPerDay: 24,
        minutesPerHour: 60,
        secondsPerMinute: 60
    },
    // The wrap-around season (Winter, monthStart 12 → monthEnd 2) MUST come
    // last. Foundry's season match (CalendarData#timeToComponents) short-circuits
    // on the first hit and only adjusts a wrap range's bounds when the month sits
    // at the wrap edge (ordinal ≤ monthEnd or ≥ monthStart). For a mid-year month
    // the bounds stay [12, 2], and `between` normalizes them to [2, 12] — so a
    // Winter-first ordering greedily matches EVERY month 2–11 as Winter (which is
    // why Lammas/August once "snowed"). Listing Winter last lets Spring/Summer/
    // Autumn claim their months before the wrap range is ever tested.
    seasons: {
        values: [
            { name: "WITCHER.Calendar.Seasons.Spring", monthStart: 3,  monthEnd: 5 },
            { name: "WITCHER.Calendar.Seasons.Summer", monthStart: 6,  monthEnd: 8 },
            { name: "WITCHER.Calendar.Seasons.Autumn", monthStart: 9,  monthEnd: 11 },
            { name: "WITCHER.Calendar.Seasons.Winter", monthStart: 12, monthEnd: 2 }
        ]
    },
    // Aligned by index to seasons.values (Spring, Summer, Autumn, Winter).
    sun: {
        values: [
            { dawn: 6, dusk: 19 },  // Spring
            { dawn: 5, dusk: 21 },  // Summer — long days
            { dawn: 7, dusk: 18 },  // Autumn
            { dawn: 8, dusk: 16 }   // Winter — short days
        ]
    },
    moons: {
        values: [{
            name: "WITCHER.Calendar.Moon.Name",
            cycleLength: 28,
            firstNewMoon: { year: 0, day: 0 },
            phases: [
                { name: "WITCHER.Calendar.Moon.New",            length: 1, icon: "fa-solid fa-circle" },
                { name: "WITCHER.Calendar.Moon.WaxingCrescent", length: 6, icon: "fa-solid fa-moon" },
                { name: "WITCHER.Calendar.Moon.FirstQuarter",   length: 1, icon: "fa-solid fa-circle-half-stroke" },
                { name: "WITCHER.Calendar.Moon.WaxingGibbous",  length: 6, icon: "fa-solid fa-moon" },
                { name: "WITCHER.Calendar.Moon.Full",           length: 1, icon: "fa-regular fa-circle" },
                { name: "WITCHER.Calendar.Moon.WaningGibbous",  length: 6, icon: "fa-solid fa-moon" },
                { name: "WITCHER.Calendar.Moon.LastQuarter",    length: 1, icon: "fa-solid fa-circle-half-stroke" },
                { name: "WITCHER.Calendar.Moon.WaningCrescent", length: 6, icon: "fa-solid fa-moon" }
            ]
        }]
    }
};
