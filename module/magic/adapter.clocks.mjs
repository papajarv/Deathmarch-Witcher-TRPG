/**
 * The round clock.
 *
 * Foundry-free on purpose, and split out of the adapter for one reason: it is
 * the only part of the adapter that has real logic rather than translation,
 * and logic that cannot be tested is logic that is wrong.
 *
 * `lifetimes.mjs` tracks how long things last; this tracks things that HAPPEN
 * on a schedule. The two are separate because a spell can have one without the
 * other — Magic Healing heals every round for a fixed duration, Magic Trap
 * waits one round and then attacks for as long as it stands, and Earthen Spike
 * has a duration and no schedule at all.
 */

const CLOCKS = [];
let _nextId = 1;

/**
 * Register something to run on the round clock.
 *
 * `every` fires each tick until `rounds` are used up; `once` waits `rounds`
 * and fires a single time. Magic Trap needs the second — "takes one round to
 * prepare" — and nothing else in the core book does, which is exactly why it
 * had to be sayable rather than assumed.
 */
export function registerClock({ actor, item, rounds = null, run, record = null, once = false }) {
    const entry = { id: _nextId++, actor, item, rounds, run, record, once, elapsed: 0 };
    CLOCKS.push(entry);
    return entry;
}

/** Stop one clock early — a dispelled zone, a dropped concentration. */
export function cancelClock(entry) {
    const i = CLOCKS.indexOf(entry);
    if (i >= 0) CLOCKS.splice(i, 1);
    return i >= 0;
}

/** Stop every clock belonging to one actor. */
export function cancelClocksFor(actor) {
    let n = 0;
    for (const c of [...CLOCKS]) if (c.actor === actor) { cancelClock(c); n++; }
    return n;
}

/**
 * Advance one round. Called from the system's combat-round hook.
 *
 * A clock that throws is removed rather than left to throw again every round
 * for the rest of the session — one broken spell must not make the round
 * button useless.
 */
export async function advanceMagicClocks() {
    const fired = [];
    for (const clock of [...CLOCKS]) {
        clock.elapsed++;
        if (clock.once && clock.elapsed < clock.rounds) continue;

        try {
            await clock.run();
            fired.push(clock);
        } catch (err) {
            console.warn("magic | clock failed, removing it", err);
            cancelClock(clock);
            continue;
        }

        const spent = clock.once || (clock.rounds != null && clock.elapsed >= clock.rounds);
        if (spent) cancelClock(clock);
    }
    return fired;
}

export function activeClocks() { return [...CLOCKS]; }
export function _clockCount() { return CLOCKS.length; }
export function _resetClocks() { CLOCKS.length = 0; _nextId = 1; }
