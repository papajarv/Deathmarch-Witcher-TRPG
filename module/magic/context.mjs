/**
 * CastContext — the typed envelope threaded through a cast.
 *
 * Replaces the old `castContext` object literal, which was built inline in
 * castSpellMixin, stamped into a chat flag, patched twice more, read by four
 * separate consumers, and had no schema — over half its fields had no reader
 * at all. Everything here has exactly one owner and one documented purpose.
 *
 * The `record` sub-object is the load-bearing part. It is PUBLIC: any actor
 * may read it, and it is stamped onto every effect the cast leaves behind for
 * as long as that effect persists. Three independent rules demand it —
 * Heliotrope and Dispel price themselves at half the caster's spend and must
 * beat the caster's roll; Holy Fortification re-rolls against the ORIGINAL
 * caster roll of every effect on a target; Puppet re-contests it each round.
 * It is not optional and it is not a block.
 */

/** Frame parameters every castable declares. Law — not authorable as blocks. */
export const FRAME_DEFAULTS = Object.freeze({
    kind:      "spell",                     // spell | invocation | sign | hex | ritual
    cost:      { mode: "fixed", amount: 0 },
    targeting: { mode: "self" },
    range:     null,
    roll:      { source: "casterSkill" },   // casterSkill | flat(n) | none
    defence:   { type: "none", ties: "attacker" },
    element:   "inherit",
    tradition: "standard",
    tier:      "novice",
    duration:  { kind: "instant" }
});

/** Outcomes the frame can reach. `dispatch` maps these to authored trees. */
export const OUTCOME = Object.freeze({
    HIT:     "hit",
    MISS:    "miss",
    SUCCESS: "success",   // no opposed step: rolled and did not fumble
    FUMBLE:  "fumble",
    ABORTED: "aborted"
});

/**
 * Build a fresh context. Nothing here touches Foundry — every world
 * interaction goes through the injected `adapter`, which is what lets the
 * whole frame be exercised in a plain node test.
 */
/* Unique within a session, which is all that is needed: the id only has to
 * distinguish two casts that are simultaneously standing. Deliberately not
 * Foundry's randomID — this module knows nothing about Foundry so that the
 * whole engine stays testable outside a browser. */
let _castSeq = 0;
const _castRun = Math.random().toString(36).slice(2, 8);
function nextCastId() { return `${_castRun}-${++_castSeq}`; }

export function makeContext({ actor, item, frame, adapter, targets = [], trees = {} }) {
    return {
        actor,
        item,
        adapter,
        /* Every entry tree the item declares. A block that creates a
         * persistent effect subscribes its SIBLING trees — which is how one
         * item ends up with both a cast entry and an interception entry. */
        trees,
        frame: Object.freeze({ ...FRAME_DEFAULTS, ...frame }),

        /* PUBLIC RECORD — see the header. Written during the frame's run,
         * frozen at dispatch, then stamped onto everything the cast creates. */
        record: {
            /* A name for THIS cast, so what it leaves behind can be found
             * again. Without one, removing "the effects this spell applied"
             * could only match on the effect's NAME — which collides the
             * moment two casts of the same spell are standing at once, and
             * cannot be done at all across a permission boundary. */
            castId:        nextCastId(),
            kind:          null,
            casterRoll:    null,
            staSpent:      0,
            element:       null,
            defenceSet:    [],
            damageChannel: "attack",
            tags:          []
        },

        targets: targets.map(t => ({ actor: t, defenceTotal: null, hit: null, margin: null })),

        /* Expression scope. Each stage publishes into this as it resolves, so
         * a formula can only reference a variable that already exists — which
         * is what lets the validator reject `{margin}` on a spell whose
         * defence is `none`. */
        vars: { sta: 0, margin: 0, skill: 0, index: 0, vigor: 0 },

        /* The same idea for arguments that are NAMES rather than numbers —
         * which band of a banded cost was bought, which element resolved.
         * Kept separate from `vars` so a numeric slot can never accidentally
         * be handed a word and coerce it to NaN. */
        text: { band: null, element: null },

        control: { aborted: false, abortReason: null, fumbleBand: null, outcome: null },

        /* Effects created during the run, so the caller can inspect what a
         * cast actually did without re-reading world state. */
        created: []
    };
}

/** Abort the cast. Stages check this and unwind without spending further. */
export function abort(ctx, reason) {
    ctx.control.aborted = true;
    ctx.control.abortReason = reason;
    ctx.control.outcome = OUTCOME.ABORTED;
    return ctx;
}

/** Freeze the record at dispatch so nothing downstream can rewrite history. */
export function sealRecord(ctx) {
    ctx.record.defenceSet = Object.freeze([...ctx.record.defenceSet]);
    ctx.record.tags = Object.freeze([...ctx.record.tags]);
    Object.freeze(ctx.record);
    return ctx;
}

/**
 * Derive a context for a DEFERRED body — a tree captured at cast time and run
 * later, in a context the capturing block defines rather than the caster's.
 *
 * Yrden is why this exists. Its body belongs to whoever WALKS INTO the circle,
 * possibly rounds after the cast, possibly several people, possibly nobody.
 * Handing it the caster's live context would be wrong three ways: `targets` is
 * the wrong list, `created` would keep accreting onto a cast that has already
 * returned, and an abort inside one entrant's body would poison the next.
 *
 * What it DOES share is the record. That is the point of sealing it — the
 * penalty a zone applies in round nine still carries the roll and the spend
 * that created it, which is what Dispel and Holy Fortification contest.
 */
export function deriveContext(ctx, { targets = [], vars = {}, zone = null, linger = null } = {}) {
    return {
        ...ctx,
        targets: targets.map(t => ({ actor: t, defenceTotal: null, hit: true, margin: null })),
        vars: { ...ctx.vars, ...vars },
        control: { aborted: false, abortReason: null, fumbleBand: null, outcome: ctx.control.outcome },
        created: [],
        /* A body running because somebody WALKED INTO a zone carries the zone's
         * identity, so everything it creates can be tagged as belonging to that
         * zone — which is what lets the zone layer take it off again when they
         * walk out. Without it `untilExitZone` had no way to fire: the effect
         * and the zone had nothing in common to match on. */
        record: zone ? Object.freeze({ ...ctx.record, zoneTemplate: zone, zoneLinger: linger }) : ctx.record
    };
}
