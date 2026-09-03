/**
 * What a spell's BLOCKS say the cast dialog should offer.
 *
 * The dialog is shared with the original engine and asks its questions from the
 * item's own fields — `system.damageFormula`, `system.range`. An authored spell
 * keeps all of that in its tree instead, so every question the dialog wanted to
 * ask had to be answered by poking at `magic.on` from wherever happened to need
 * it. That started as one inline walk for "does this spell have a magnitude"
 * and was on its way to being four.
 *
 * One reader, here. A block declares what it needs the dialog to ask, and this
 * is the only thing that walks a tree to find out — so adding a block that
 * wants a control means describing it in FACTS_BY_BLOCK and nothing else.
 */

/**
 * Per block: what its presence means for the dialog.
 *
 *   magnitude — the spell has an amount a glyph's +1d6 can be spent on
 *   aims      — the spell puts something somewhere, so a called shot is
 *               meaningful, subject to the reach below. A damage block only
 *               counts when it says `location: "aimed"`: that is the word that
 *               means "the caster picks". A block that says torso means torso
 *               (Alzur's Thunder), and one that rolls (Carys' Gale, "each roll
 *               counts as its own separate attack when determining location")
 *               is not the caster's to choose either. Offering the control on
 *               a spell whose location is already decided is a dialog that
 *               asks a question and throws the answer away.
 */
const FACTS_BY_BLOCK = Object.freeze({
    "core:dealDamage":    { magnitude: true, aims: (n) => String(n?.a?.location ?? "torso") === "aimed" },
    "core:healHealth":    { magnitude: true },
    "core:createShield":  { magnitude: true },
    "core:drainResource": { magnitude: true }
});

/**
 * How close you must be to call a shot, when the block does not say.
 *
 * Point-blank. Igni is a 2m cone and you only choose WHERE on somebody it
 * burns if you are right on top of them; a block that means otherwise says so
 * with its own `aimWithin`.
 */
export const DEFAULT_AIM_WITHIN = 1;

/** Walk every entry of a tree, bodies included. */
function walk(on, visit) {
    const step = (body) => {
        for (const node of body ?? []) {
            if (node?.b) visit(node);
            if (node?.body) step(node.body);
        }
    };
    for (const body of Object.values(on ?? {})) step(body);
}

/**
 * Read a spell's tree and report what the dialog should show.
 *
 * Returns `{ hasBlocks, hasMagnitude, aims, aimWithin }`. `aims` is false for a
 * spell that places nothing, and `aimWithin` is the FURTHEST any of its aiming
 * blocks allows — if one part of a spell can be aimed from three metres, the
 * caster is offered the shot.
 */
export function dialogFactsFor(system) {
    const on = system?.magic?.on ?? {};
    const facts = { hasBlocks: false, hasMagnitude: false, aims: false,
                    aimWithin: DEFAULT_AIM_WITHIN };
    let sawReach = false;

    /* A spell with NO blocks is on the original engine, which keeps its damage
     * in `system.damageFormula`. It should not lose the called shot just for
     * not being authored — the two engines answer the same question about the
     * same spell and should answer it alike. */
    if (!Object.keys(on).length) {
        const legacyDamage = String(system?.damageFormula ?? "").trim();
        if (legacyDamage) {
            facts.hasMagnitude = true;
            facts.aims = true;
        } else if (String(system?.damageType ?? "") === "shieldHp") {
            facts.hasMagnitude = true;
        }
        return facts;
    }

    walk(on, (node) => {
        facts.hasBlocks = true;
        const f = FACTS_BY_BLOCK[node.b];
        if (!f) return;
        if (f.magnitude) facts.hasMagnitude = true;
        const aims = typeof f.aims === "function" ? f.aims(node) : !!f.aims;
        if (!aims) return;
        facts.aims = true;
        /* The block's own word on how close is close enough. */
        const within = Number(node.a?.aimWithin);
        if (Number.isFinite(within)) {
            facts.aimWithin = sawReach ? Math.max(facts.aimWithin, within) : within;
            sawReach = true;
        }
    });
    return facts;
}
