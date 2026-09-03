/**
 * Block registry — one declaration, three consumers.
 *
 * The executor reads `run`; the canvas reads `shape`, `label` and `inputs`;
 * the validator reads `requires` and `emits`. Keeping them in one object is
 * the point: the previous engine had a `mechanicHandler` dropdown built from
 * a live registry that NO template rendered, because the render metadata and
 * the behaviour lived in different places and drifted.
 *
 * The registry is also the ONLY extension path. The old design had exactly
 * this idea and shipped with zero registered handlers, because the schema
 * kept an escape hatch and authors used it instead. There is no escape hatch
 * here: a spell's behaviour is its block tree or it does not exist.
 */

const BLOCKS = new Map();

/** Shapes. Determines canvas geometry AND executor semantics together. */
export const SHAPE = Object.freeze({
    STACK:    "stack",      // one in, one out
    GATE:     "gate",       // owns a child stack, runs it 0..n times, NOW
    DEFERRED: "deferred",   // owns a child stack, hands it to something else
    REPORTER: "reporter"    // returns a value into an argument slot
});

/** The two shapes that may hold a body. Everything else is a leaf. */
export const HOLDS_BODY = Object.freeze([SHAPE.GATE, SHAPE.DEFERRED]);

/** Slots in the label map to `inputs` keys — the label IS the layout. */
const SLOT_RE = /\[(\w+)\]/g;

export function defineBlock(def) {
    const { id, shape, label, inputs = {}, requires = [], emits = [], provides = [], run } = def;

    if (!id || !/^[a-z0-9-]+:[a-zA-Z0-9]+$/.test(id)) {
        throw new Error(`Block id must be "namespace:name": ${id}`);
    }
    if (!Object.values(SHAPE).includes(shape)) {
        throw new Error(`Unknown shape "${shape}" for ${id}`);
    }
    if (typeof run !== "function") throw new Error(`Block ${id} has no run()`);
    if (BLOCKS.has(id)) throw new Error(`Block ${id} is already registered`);

    /* Every [slot] in the label must name a real input, or the canvas would
     * render a socket with nothing behind it. Cheap check, catches typos at
     * registration rather than at the table. */
    for (const [, key] of label.matchAll(SLOT_RE)) {
        if (!(key in inputs)) throw new Error(`Block ${id}: label slot [${key}] has no matching input`);
    }

    /* A deferred body runs somewhere the author cannot see. If the block does
     * not say what that somewhere hands it, the body can only ever be empty —
     * every effect block needs targets, and lexical scope does not reach. */
    /* `emits` and `provides` are not the same promise, and conflating them is
     * how `targetNearest` — a gate that conjures a target list for its own
     * body and puts the old one back afterwards — ended up claiming to hand
     * targets to its SIBLINGS, which it never does.
     *
     *   emits    — visible to everything AFTER this block, at the same level.
     *   provides — visible only INSIDE this block's body.
     */
    if (shape === SHAPE.DEFERRED && provides.length === 0) {
        throw new Error(`Block ${id} defers a body but declares no provides[]`);
    }

    BLOCKS.set(id, Object.freeze({ ...def, inputs, requires, emits, provides }));
    return BLOCKS.get(id);
}

export function getBlock(id)   { return BLOCKS.get(id) ?? null; }
export function allBlocks()    { return [...BLOCKS.values()]; }
export function blockCount()   { return BLOCKS.size; }

/** Test seam only — the live registry is populated once at init. */
export function _resetRegistry() { BLOCKS.clear(); }

/**
 * Static validation of an authored tree.
 *
 * `requires`/`emits` exist for the executor anyway, so the legality check is
 * free: it is what lets the canvas refuse to snap `dealDamage` above anything
 * that produces targets, and it is what turns an editor from a text box with
 * rounded corners into something that explains why a block will not fit.
 *
 * Returns a list of human-readable problems — empty means valid. Messages
 * name the fix, not just the fault.
 */
export function validateTree(body, { available = new Set(["caster"]), path = "on" } = {}) {
    const problems = [];
    const have = new Set(available);

    for (const [i, node] of (body ?? []).entries()) {
        const where = `${path}[${i}]`;
        const def = getBlock(node.b);

        if (!def) {
            const ns = String(node.b ?? "").split(":")[0];
            problems.push(ns && ns !== "core"
                ? `${where}: this spell needs "${ns}", which isn't installed.`
                : `${where}: unknown block "${node.b}".`);
            continue;
        }

        for (const need of def.requires) {
            if (!have.has(need)) {
                problems.push(`${where}: "${def.id}" needs ${need}, and nothing above it has produced any.`);
            }
        }

        /* An argument the block does not declare is DROPPED SILENTLY by the
         * executor. That is how `createObject` was authored with `sp: "30"` on
         * a 30-SP rock wall and quietly built a wall with no armour at all.
         * The canvas cannot produce an undeclared argument, but a hand-written
         * file can, and the failure is invisible at the table. */
        for (const key of Object.keys(node.a ?? {})) {
            if (!(key in def.inputs)) {
                problems.push(`${where}: "${def.id}" has no argument "${key}" — it would be ignored.`);
            }
        }

        if (node.body && !HOLDS_BODY.includes(def.shape)) {
            problems.push(`${where}: "${def.id}" can't hold other blocks. Put them after it.`);
        }
        if (node.body) {
            /* A GATE's body is lexical — it runs here, so it sees what the
             * blocks above it produced. A DEFERRED body runs elsewhere and
             * later, so it sees ONLY what the deferring block promises. That
             * asymmetry is the entire reason the two shapes are distinct:
             * without it the validator would greenlight a zone body reading
             * targets that stopped existing the moment the cast returned. */
            const inner = def.shape === SHAPE.DEFERRED
                ? new Set(["caster", ...def.provides])
                : new Set([...have, ...def.provides]);
            problems.push(...validateTree(node.body, { available: inner, path: `${where}.body` }));
        }

        for (const e of def.emits) have.add(e);
    }
    return problems;
}


/**
 * What each ENTRY POINT hands its tree.
 *
 * This was missing, and its absence hid a whole class of authoring error. A
 * cast tree begins with the caster and the targets the frame acquired; an
 * interception tree begins with an INCOMING payload and no targets at all,
 * because nothing was cast — someone else's attack arrived.
 *
 * Until this existed, every caller validated with a hardcoded scope, and the
 * one caller that mattered — Quen's `takeDamage` tree, the whole reason the
 * interception path exists — was never validated at all. Gwynt Troelli is what
 * surfaced it: an identically-shaped tree that the ad-hoc scope rejected.
 */
export const ENTRY_SCOPE = Object.freeze({
    /* Cast outcomes. The frame has resolved and produced a target list. */
    hit:            ["caster", "targets"],
    miss:           ["caster", "targets"],
    success:        ["caster", "targets"],
    fumble:         ["caster"],
    aborted:        ["caster"],

    /* Interception. An attack is in flight; `targets` is the OWNER, supplied
     * by makeInterceptContext so shared effect blocks still work. */
    incomingMagic:  ["caster", "incoming", "targets"],
    incomingAttack: ["caster", "incoming", "targets"],
    beforeDefence:  ["caster", "incoming", "targets"],
    takeDamage:     ["caster", "incoming", "targets"],
    afterApply:     ["caster", "incoming", "targets"],

    /* Lifecycle. Active Shield is why: "when the shield is expended or dropped,
     * anything adjacent to you is pushed back 2m and takes 1d6 damage to the
     * torso. This includes objects, furniture, and allies."
     *
     * That is a real attack, from a spell that has ALREADY ENDED, hurting
     * people the cast never targeted. There was nowhere to put it — every tree
     * hung off an outcome of the cast, and by the time this fires the cast is
     * long over. `targets` here is acquired by the tree itself, not inherited. */
    onExpire:       ["caster"]
});

/** Validate one entry tree with the scope that entry actually provides. */
export function validateEntry(entry, body, name = "spell") {
    const scope = ENTRY_SCOPE[entry];
    if (!scope) return [`${name}.${entry}: no such entry point.`];
    return validateTree(body, { available: new Set(scope), path: `${name}.${entry}` });
}

/** Validate every entry tree an authored spell declares. */
export function validateSpell(spell) {
    const out = [];
    for (const [entry, body] of Object.entries(spell.on ?? {})) {
        out.push(...validateEntry(entry, body, spell.name ?? "spell"));
    }
    return out;
}
