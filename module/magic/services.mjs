/**
 * Law services.
 *
 * The central change the supplement forced. In v2 the frame's law stages ran
 * as hard-coded steps; three independent analyses of Tome of Chaos each
 * concluded, under different names, that they must be observable and
 * modifiable instead. In this game magic's most common target is other magic:
 *
 *   Empower            rewrites another spell's percentages to 100%, adds 2d6
 *                      to its damage, and rewrites the fumble band so a
 *                      natural 1 resolves as a 10.
 *   Soul Beacon        makes you roll 1d10-2 on the fumble table.
 *   Runeword Depletion injects a stamina drain into every spell cast through
 *                      the weapon — spells whose authors never heard of it.
 *   Runeword Prolongation  re-rolls dice durations and keeps the highest.
 *   Tempest elixir     adds 10% to any Fire/Freeze/Prone chance.
 *
 * None of that is reachable from a block, because block arguments are
 * literals resolved inside their own tree. A standing effect needs a channel
 * into a stage it did not author. That channel is this file.
 *
 * The core rulebook already required it, incidentally: hexes replace the
 * elemental fumble table wholesale (p.168), which is the same mechanism.
 */

export const SERVICE = Object.freeze({
    PRICE:      "price",        // { cost }        — L2
    ROLL:       "roll",         // { total, natural, fumbleBy } — L5
    FUMBLE:     "fumble",       // { by, band, die, table }     — L6
    PERCENTILE: "percentile",   // { chance }      — block-level
    DAMAGE:     "damage",       // { formula, bonus, multiplier } — block-level
    DURATION:   "duration"      // { value, rerollHighest }      — persistence
});

const MODIFIERS = [];
let _nextId = 1;

/**
 * Register a standing modifier on a law stage.
 *
 * @param {object} m
 * @param {*}        m.owner     whose casts this applies to
 * @param {string}   m.service   one of SERVICE
 * @param {function} [m.matches] (payload, ctx) => boolean
 * @param {function} m.apply     (payload, ctx) => void — MUTATES the payload
 * @param {number}   [m.order]   lower runs first; absolute overrides go last
 */
export function registerModifier(m) {
    const entry = { id: _nextId++, matches: () => true, order: 0, ...m };
    MODIFIERS.push(entry);
    MODIFIERS.sort((a, b) => a.order - b.order);
    return entry;
}

export function unregisterModifier(handle) {
    const i = MODIFIERS.findIndex(m => m === handle || m.id === handle?.id);
    if (i >= 0) MODIFIERS.splice(i, 1);
}

export function _resetServices() { MODIFIERS.length = 0; _nextId = 1; }
export function modifierCount() { return MODIFIERS.length; }

/**
 * Run a law stage through its modifiers.
 *
 * The payload is MUTABLE and returned — a stage calls this and then uses
 * whatever comes back, so a modifier that changes nothing costs nothing.
 */
export function applyService(service, owner, payload, ctx = null) {
    for (const m of MODIFIERS) {
        if (m.service !== service) continue;
        if (m.owner && m.owner !== owner) continue;
        try {
            if (m.matches(payload, ctx)) m.apply(payload, ctx);
        } catch (err) {
            console.warn(`magic | service modifier ${m.id} on "${service}" failed`, err);
        }
    }
    return payload;
}

/* ── Empower, as a proof that the channel is sufficient ────────────────────
 *
 * Empower is the ONE spell in either book that outright broke the v2 model.
 * It is expressed here entirely through service modifiers, with no bespoke
 * engine support — which is the test of whether the boundary was redrawn in
 * the right place.
 *
 *   "the percentage chance of any effects caused by the spell raise to 100%"
 *   "an already damaging spell deals an additional 2d6"
 *   "+2 to the casting roll"
 *   "if you roll a 1 when making the Spell Casting check you automatically
 *    suffer from a Magical Fumble as though you had rolled a 10"
 *
 * The caster picks ONE of the first three; the fumble clause always applies.
 */
export function empower(owner, mode) {
    const handles = [];
    const once = { spent: false };

    /* The drawback rides along regardless of the mode chosen. */
    handles.push(registerModifier({
        owner, service: SERVICE.FUMBLE, order: 100,
        matches: (p) => p.natural === 1,
        apply: (p) => { p.by = 10; p.band = ">9"; p.forcedBy = "empower"; }
    }));

    if (mode === "certainty") {
        handles.push(registerModifier({
            owner, service: SERVICE.PERCENTILE, order: 100,
            apply: (p) => { p.chance = 100; }
        }));
    } else if (mode === "force") {
        handles.push(registerModifier({
            owner, service: SERVICE.DAMAGE,
            apply: (p) => { p.bonus = (p.bonus ?? 0) + 2; p.bonusDie = 6; }
        }));
    } else if (mode === "accuracy") {
        handles.push(registerModifier({
            owner, service: SERVICE.ROLL,
            apply: (p) => { p.total += 2; }
        }));
    }

    /* "the next spell" — one cast, then it lapses. */
    const release = () => { handles.forEach(unregisterModifier); handles.length = 0; };
    handles.push(registerModifier({
        owner, service: SERVICE.ROLL, order: 999,
        apply: () => { if (once.spent) release(); else once.spent = true; }
    }));

    return { release, handles };
}
