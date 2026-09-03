/**
 * Per-effect lifetimes.
 *
 * The frame declares ONE duration, and that duration governs the CAST — how
 * long it is maintained, what it costs to sustain. It does not govern what
 * the cast leaves behind, and the books routinely separate the two:
 *
 *   Earthen Spike   Duration: Immediate ... "remains until destroyed"
 *   Earthen Pillar  Duration: Immediate ... 10 SP of cover, until destroyed
 *   Cryfhau         Duration: Immediate ... "permanently increase the density"
 *   Magic Screen    Duration: Immediate ... "remains until dispelled"
 *   Druidic Totem   Duration: Immediate ... a standing totem, 1-mile aura
 *   Conspiracy of the Mother  Duration: Immediate ... "the effects on the
 *                                                     crow are permanent"
 *
 * Read as a single duration those look like errata. Read as cast-duration
 * plus effect-lifetime they are correct data, and ten entries stop being
 * special cases. This is the highest yield per unit of change in the spec.
 *
 * Nothing here knows about Foundry. The adapter drives the clock; this only
 * decides what has ended.
 */

export const ENDS = Object.freeze({
    IMMEDIATE:      "immediate",
    ROUNDS:         "rounds",
    MINUTES:        "minutes",
    HOURS:          "hours",
    DAYS:           "days",
    UNTIL_DESTROYED:"untilDestroyed",
    UNTIL_TASK_DONE:"untilTaskDone",
    UNTIL_RECAST:   "untilRecast",
    UNTIL_DISPELLED:"untilDispelled",
    UNTIL_PUT_OUT:  "untilPutOut",
    SAVE_ENDS:      "saveEnds",
    POOL_EMPTY:     "poolEmpty",
    UPKEEP_UNPAID:  "upkeepUnpaid",   // `Active (n STA)` — see openUpkeep()
    CASTER_STRUCK:  "casterStruck",   // Suffocate: ends if the caster is hit
    UNTIL_EXPENDED: "untilExpended",  // a granted pool, spent a point at a time
    /* Yrden's circle and eleven others: the effect rides MEMBERSHIP of a zone
     * and lifts the moment you step out. This was authored by 13 sites across
     * 6 files and was never a member of ENDS at all — it existed only in a
     * comment. `track()` accepts any string, so those effects were created
     * with no scale, no remaining, and nothing that could ever fire them: the
     * penalty for standing in a Yrden circle followed you out of it forever. */
    UNTIL_EXIT_ZONE:"untilExitZone",
    WORLD_EVENT:    "untilWorldEvent",   // "until the next Sunrise"
    PERMANENT:      "permanent"
});

/* Which clock scale advances which end condition. */
const SCALE_OF = {
    [ENDS.ROUNDS]: "round", [ENDS.MINUTES]: "minute",
    [ENDS.HOURS]: "hour",   [ENDS.DAYS]:    "day"
};

let LIVE = [];
let _nextId = 1;
/* Which clock scale, if any, is CURRENTLY firing its bodies.
 *
 * `combatRound` runs the clocks first and ticks the lifetimes second, so an
 * effect applied by a clock body was created a few microseconds before the
 * tick that then aged it. "After one round, blind them for two rounds"
 * produced a blindness that lasted one; a one-round rider applied this way
 * expired the instant it existed. Everything a clock applies was affected —
 * `repeatEachRound`'s riders, `saveEnds` re-applications, a zone body's
 * statuses.
 *
 * Marking birth-inside-the-tick, rather than reordering the hook, keeps the
 * existing order intact: a repeating effect still gets its final firing on the
 * round it runs out. */
let FIRING = null;

/**
 * Track a persistent effect with its OWN end condition, independent of the
 * cast that produced it.
 *
 * `endsOn` may be a single condition or several — Sigil of the Hidden ends on
 * any of dispelled, re-cast, or 10 damage to the brush, and `setDuration`
 * taking one kind is exactly why that needed a bespoke block before.
 */
export function track({ owner, kind, endsOn, remaining = null, onExpire = null, record = null, source = null, state = {} }) {
    const conditions = Array.isArray(endsOn) ? endsOn : [endsOn];
    const entry = {
        id: _nextId++, owner, kind, conditions,
        remaining: remaining ?? defaultRemaining(conditions),
        /* Set when a clock body created this — see FIRING above. */
        bornInTick: FIRING,
        onExpire, record, source, state, ended: false
    };
    /* A duration that is not a number cannot count down. This is the guard the
     * dice-duration bug needed: `remaining` was the string "2d6", every tick
     * subtracted into NaN, and nothing ever ended — silently, for as long as
     * the world lived. Say it out loud instead. */
    if (entry.remaining != null && typeof entry.remaining !== "number") {
        console.warn(`magic | lifetime for ${kind} was given a duration of ${
            JSON.stringify(entry.remaining)}, which is not a number — it cannot count down. ` +
            `Durations must be rolled before they get here (see rollDuration).`);
        entry.remaining = defaultRemaining(conditions);
    }
    if (conditions.includes(ENDS.IMMEDIATE)) { expire(entry, ENDS.IMMEDIATE); return entry; }
    LIVE.push(entry);
    return entry;
}

function defaultRemaining(conditions) {
    return conditions.some(c => SCALE_OF[c]) ? Infinity : null;
}

function expire(entry, why) {
    if (entry.ended) return entry;
    entry.ended = true;
    entry.endedBy = why;
    LIVE = LIVE.filter(e => e !== entry);
    try { entry.onExpire?.(entry, why); } catch (err) { console.warn("magic | onExpire failed", err); }
    return entry;
}

/** Advance a clock. Returns everything that ended on this tick. */
export function tick(scale, n = 1) {
    const ended = [];
    for (const e of [...LIVE]) {
        const uses = e.conditions.find(c => SCALE_OF[c] === scale);
        if (!uses) continue;
        /* Born inside the very tick that is now resolving: its first round is
         * the one about to begin, not the one just ending. Skipped once, then
         * it ages like anything else. */
        if (e.bornInTick === scale) { e.bornInTick = null; continue; }
        e.remaining -= n;
        if (e.remaining <= 0) ended.push(expire(e, uses));
    }
    return ended;
}

/** End everything matching a predicate — dispels, re-casts, world events. */
export function endWhere(predicate, why = "external") {
    const ended = [];
    for (const e of [...LIVE]) if (predicate(e)) ended.push(expire(e, why));
    return ended;
}

/**
 * "It is cast again."
 *
 * Polymorphism says "you must cast the spell again to change back", and
 * `untilRecast` was in the dropdown with nothing anywhere producing it — so a
 * second cast applied a SECOND polymorph and the first never lifted. Called by
 * the cast entry point before a spell resolves: the item that is being cast
 * ends anything of its own still standing.
 */
export function endOnRecast(owner, sourceUuid) {
    if (!sourceUuid) return [];
    return endWhere(e => e.owner === owner
                      && e.conditions.includes(ENDS.UNTIL_RECAST)
                      && (e.source?.uuid ?? null) === sourceUuid, ENDS.UNTIL_RECAST);
}

/**
 * "Until it is dispelled." Fired by Dispel and by anything else that ends a
 * standing effect deliberately, so an `onExpire` tree can tell being dispelled
 * from simply running out.
 */
export function endOnDispel(owner, castId = null) {
    return endWhere(e => e.owner === owner
                      && e.conditions.includes(ENDS.UNTIL_DISPELLED)
                      && (castId == null || e.record?.castId === castId), ENDS.UNTIL_DISPELLED);
}

/**
 * "Until the object is destroyed", "until the task is done", "until the next
 * sunrise" — the three the world cannot decide on its own.
 *
 * A GM ends these from the cast card's own control (see `magic/standing.mjs`);
 * a calendar module can call `endWorldEvent` directly.
 */
export function endDestroyed(owner, castId = null) {
    return endWhere(e => (owner == null || e.owner === owner)
                      && e.conditions.includes(ENDS.UNTIL_DESTROYED)
                      && (castId == null || e.record?.castId === castId), ENDS.UNTIL_DESTROYED);
}
export function endTaskDone(owner, castId = null) {
    return endWhere(e => (owner == null || e.owner === owner)
                      && e.conditions.includes(ENDS.UNTIL_TASK_DONE)
                      && (castId == null || e.record?.castId === castId), ENDS.UNTIL_TASK_DONE);
}
export function endWorldEvent(which = "sunrise") {
    return endWhere(e => e.conditions.includes(ENDS.WORLD_EVENT), which);
}

/** A named condition fired for one effect — a pool emptied, a fire put out. */
export function fireCondition(entry, condition) {
    if (!entry || entry.ended) return null;
    return entry.conditions.includes(condition) ? expire(entry, condition) : null;
}

/**
 * Run a clock scale's bodies, with anything they create marked as born inside
 * this tick. The caller ticks that scale immediately afterwards.
 */
export async function duringTick(scale, fn) {
    const prev = FIRING;
    FIRING = scale;
    try { return await fn(); } finally { FIRING = prev; }
}

/** Test seam: the firing flag is module state. */
export function _resetTicks() { FIRING = null; }

export function activeLifetimes(owner = null) {
    return owner ? LIVE.filter(e => e.owner === owner) : [...LIVE];
}
export function lifetimeCount() { return LIVE.length; }
export function _resetLifetimes() { LIVE = []; _nextId = 1; }

/**
 * Parse an authored lifetime into a tracked entry.
 *
 * Blocks call this rather than building entries by hand, so "until destroyed"
 * means the same thing everywhere it is authored.
 */
/**
 * Turn an authored duration into a NUMBER of clock ticks.
 *
 * "2d6 rounds" is the commonest duration in the book, and every one of them
 * was permanent. `evaluate` deliberately returns a dice expression unrolled —
 * that is its contract, the roll belongs to the adapter — so `"2d6"` arrived
 * here as a string, became `remaining`, and `remaining -= 1` produced `NaN`.
 * `NaN <= 0` is false, so the effect never expired: blindness "for the
 * duration of the spell" lasted the rest of the campaign.
 *
 * Rolled ONCE, here, when the effect starts — which is also what the table
 * expects: you roll the duration when you cast it, not every round.
 */
export async function rollDuration(raw, ctx) {
    if (raw == null) return null;
    const { evaluate } = await import("./expression.mjs");
    const v = evaluate(raw, ctx?.vars ?? {});
    if (typeof v === "number") return v;
    /* A dice expression. The adapter owns dice. */
    const rolled = await ctx?.adapter?.rollFormula?.(v);
    const n = Number(rolled);
    return Number.isFinite(n) ? n : null;
}

export function lifetimeFrom(spec, base) {
    if (!spec || spec === ENDS.IMMEDIATE) return null;
    if (typeof spec === "string") return track({ ...base, endsOn: spec });
    return track({
        ...base,
        endsOn: spec.endsOn ?? spec.kind,
        remaining: spec.value ?? null,
        state: spec.state ?? {}
    });
}
