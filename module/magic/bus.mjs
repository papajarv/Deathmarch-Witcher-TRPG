/**
 * The interception bus.
 *
 * Where defensive magic lives. Without it the engine is a linear pipeline and
 * half the spell list becomes special cases — 52 of 103 core entries declare
 * `Defense: None`, which the rules define not as undefendable but as
 * "cannot be defended against UNLESS the Dispel spell or Heliotrope sign is
 * used". Those two, plus Quen, plus the three auras, are all subscriptions
 * rather than casts.
 *
 * An effect subscribes when it is created and unsubscribes when it expires.
 * The frame publishes at defined points; subscribers may read, modify, or
 * veto what is passing through.
 *
 * ── The depth cap ─────────────────────────────────────────────────────────
 * Two rules make unbounded recursion reachable from the printed text. Mirror
 * Effect turns a successful parry into a fresh attack in a random direction,
 * which can meet a second reflective surface. Dispel's own defence is
 * `spellCasting`, so a dispel can be dispelled, recursively. This is decided
 * here as a design point rather than discovered as a hang mid-session.
 */

export const ENTRY = Object.freeze({
    INCOMING_MAGIC:  "incomingMagic",
    INCOMING_ATTACK: "incomingAttack",
    BEFORE_DEFENCE:  "beforeDefence",
    TAKE_DAMAGE:     "takeDamage",
    AFTER_APPLY:     "afterApply"
});

export const MAX_DEPTH = 4;

let _subs = [];
let _nextId = 1;
let _depth = 0;

/**
 * Register an interception. `owner` is the actor the subscription protects;
 * `state` is the effect's own mutable data (a shield's remaining pool, a
 * ward's remaining charges) and is handed to the tree as `ctx.state`.
 */
export function subscribe({ owner, entry, tree, state = {}, record = null, source = null }) {
    /* IDENTITY, so the same ward cannot be registered twice.
     *
     * Subscriptions are now rebuilt from the ward badges on the actors (see
     * `magic/wardRegistry.mjs`) as well as created inline by `core:createShield`
     * at cast time. Without a key those two paths double-subscribe whenever the
     * caster IS the active GM — one Quen absorbing every hit twice, one Crest
     * spending two charges per spell — which is worse than the bug the rebuild
     * exists to fix.
     *
     * The key is (protected actor, entry, source item): one item cannot hold
     * two different wards at the same entry on the same person, and re-casting
     * replaces rather than stacks, which is what the take-higher pool already
     * does on the badge. A subscription with no identifiable source (a test, or
     * a ward built by hand) keeps the old append behaviour. */
    const key = subKey(owner, entry, source);
    if (key) {
        const existing = _subs.find(s => s.key === key);
        if (existing) {
            /* Refresh in place: same handle identity, current tree and state.
             * `state` is deliberately REPLACED, not merged — a re-cast ward
             * starts from its new pool, and a rebuild from the badge is the
             * authority on what is left. */
            existing.tree   = tree;
            existing.state  = state;
            existing.record = record ?? existing.record;
            return existing;
        }
    }
    const handle = { id: _nextId++, key, owner, entry, tree, state, record, source };
    _subs.push(handle);
    return handle;
}

/** Stable identity for a subscription, or null when it has no source item. */
function subKey(owner, entry, source) {
    const o = owner?.uuid ?? owner?.id ?? null;
    const s = source?.uuid ?? source?.id ?? null;
    return (o && s) ? `${o}|${entry}|${s}` : null;
}

/** Drop every subscription protecting `owner` — used before a rebuild so a
 *  ward that has been dispelled or expired does not linger. */
export function unsubscribeOwner(owner) {
    if (!owner) return 0;
    const before = _subs.length;
    _subs = _subs.filter(s => s.owner !== owner);
    return before - _subs.length;
}

/** Every live subscription, for the rebuild to diff against. */
export function allSubscriptions() { return _subs.slice(); }

export function unsubscribe(handle) {
    _subs = _subs.filter(s => s !== handle && s.id !== handle?.id);
}

/** Every live subscription protecting an actor at a given entry. */
export function subscriptionsFor(owner, entry) {
    return _subs.filter(s => s.entry === entry && s.owner === owner);
}

export function _resetBus() { _subs = []; _nextId = 1; _depth = 0; }
export function subscriptionCount() { return _subs.length; }

/**
 * Publish to every subscription protecting `owner`.
 *
 * `payload` is MUTABLE — that is the point. A `takeDamage` subscriber reduces
 * `payload.amount`; an `incomingMagic` subscriber sets `payload.vetoed`. The
 * caller inspects the payload afterwards to see what survived.
 *
 * `runTree` is injected rather than imported so the bus does not depend on
 * the executor, and so a test can watch exactly which trees fired.
 */
export async function publish(entry, { owner, payload, runTree }) {
    const subs = subscriptionsFor(owner, entry);
    if (!subs.length) return payload;

    if (_depth >= MAX_DEPTH) {
        console.warn(`magic | interception depth cap (${MAX_DEPTH}) reached at "${entry}" — stopping`);
        payload.depthCapped = true;
        return payload;
    }

    _depth++;
    try {
        for (const sub of subs) {
            if (payload.vetoed || payload.consumed) break;
            await runTree(sub, payload);
        }
    } finally {
        _depth--;
    }
    return payload;
}

/** Current recursion depth — exposed so tests can assert the cap engages. */
export function currentDepth() { return _depth; }
