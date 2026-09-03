/**
 * The fourth batch — contests, displacement, and predicates over the target.
 *
 * The headline is `core:contest`, and it is a genuine hole rather than a
 * convenience. The frame performs exactly ONE opposed roll, at L7, and that is
 * correct law for the overwhelming majority of the book: you cast, they
 * defend, it resolves.
 *
 * Four entries do not fit that shape. Flaming Vortex rolls Spell Casting
 * against Dodge/Escape EVERY ROUND, for every target the tornado runs over.
 * Lightning Storm rolls a 35% strike chance and THEN an opposed Dodge. Melgar's
 * Fire does the same with 75%. Seirff Haul re-contests each round at a DC that
 * climbs. All four already passed their frame-level roll; the contests inside
 * them are additional and repeated.
 *
 * The previous engine had one `opposed` boolean on the whole spell, so every
 * one of these was authored as "hits automatically, ask the GM" — which is
 * where three of the four ended up unusable.
 */

import { defineBlock, SHAPE } from "../registry.mjs";
import { evaluate } from "../expression.mjs";

export function registerContestBlocks() {

    /* ── contest ─────────────────────────────────────────────────────────
     * A fresh opposed roll INSIDE a tree. The caster's side defaults to a new
     * Spell Casting roll rather than reusing the cast roll, because the book
     * says "make a Spell Casting roll versus their Dodge/Escape roll" — a new
     * roll, every round, for a spell that lasts as long as you pay for it.
     *
     * `use: "castRoll"` covers the other phrasing, where the ORIGINAL roll is
     * the standing DC: Melgar's Fire has victims "defend at a DC equal to your
     * Spell Casting check", which is the roll already made, not a new one.
     * Both phrasings are in the book and they are not the same thing.
     */
    defineBlock({
        id: "core:contest",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if [use] beats their [against], then",
        inputs: {
            against: { type: "enum", options: "@defences", default: "dodge" },
            use:     { type: "enum", options: ["newRoll", "castRoll", "flat"], default: "newRoll" },
            flat:    { type: "expression", numeric: true, default: null },
            /* Ties. The book's convention is that the attacker must roll
             * strictly higher, so the DEFENDER wins a tie — see the errata's
             * clarification on p.164. Dispel is the documented exception and
             * it does not route through here. */
            ties:    { type: "enum", options: ["defender", "attacker"], default: "defender" }
            /* `elseBody` was declared here and never read. A gate with a
             * second branch needs a second body slot, which neither the
             * executor nor the canvas has — so it offered a setting that could
             * not have worked even if something had read it. */
        },
        requires: ["targets"],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const all = ctx.targets;
            const won = [];

            for (const t of all) {
                if (t.hit === false) continue;
                const mine = a.use === "castRoll" ? ctx.record.casterRoll
                           : a.use === "flat"     ? evaluate(a.flat, ctx.vars)
                           : (await ctx.adapter.rollCast?.(ctx.actor))?.total ?? ctx.record.casterRoll;

                const theirs = await ctx.adapter.rollDefenceSkill?.(t.actor, a.against) ?? 0;
                const beats = a.ties === "attacker" ? mine >= theirs : mine > theirs;
                if (beats) won.push({ ...t, contestMargin: mine - theirs });
            }

            if (!won.length) return;
            ctx.targets = won;
            /* The margin of the INNER contest, so a body can scale off it the
             * way the outer one does. Restored afterwards — a per-round
             * contest must not overwrite the cast's own margin permanently. */
            const outerMargin = ctx.vars.margin;
            ctx.vars.margin = Math.max(0, ...won.map(t => t.contestMargin));
            try { await runBody(body); }
            finally { ctx.targets = all; ctx.vars.margin = outerMargin; }
        }
    });

    /* ── knockback ───────────────────────────────────────────────────────
     * Bronwyn's Gust throws a target back "a number of meters equal to the
     * number of points you rolled over the opponent's defense"; Zephyr throws
     * everyone within 2m back a flat 6m. Both add: "if your opponent strikes
     * something they take ramming damage."
     *
     * That last clause is why this is not `narrate`. Whether the target hits a
     * wall depends on the map, so only the adapter can answer it — and the
     * ramming damage that follows is real damage with a real source. */
    defineBlock({
        id: "core:knockback",
        shape: SHAPE.STACK,
        category: "effect",
        label: "knock back [distance]m, [onImpact] on impact",
        inputs: {
            distance: { type: "expression", numeric: true, default: "2" },
            onImpact: { type: "enum", options: ["ramming", "none", "prone"], default: "ramming" }
        },
        requires: ["targets"],
        emits: [],
        async run(ctx, a, { adapter } = ctx) {
            const metres = evaluate(a.distance, ctx.vars);
            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                const out = await ctx.adapter.knockback?.(t.actor, {
                    metres, onImpact: a.onImpact, record: ctx.record
                });
                ctx.created.push({ kind: "knockback", target: t.actor, metres, struck: out?.struck ?? false });
            }
        }
    });

    /* ── ifTargetHas ─────────────────────────────────────────────────────
     * Static Storm damages only those "wearing metal armor or carrying metal
     * weapons". Boiling Blood needs a creature with blood. Friend to Wild Kind
     * needs an animal.
     *
     * A predicate over the target's own state, which the tree cannot see and
     * has no business computing — the adapter owns the answer. */
    defineBlock({
        id: "core:ifTargetHas",
        shape: SHAPE.GATE,
        category: "gate",
        label: "for each target that has [trait]",
        inputs: {
            trait:  { type: "string", of: "@traits" },
            negate: { type: "boolean", default: false }
        },
        requires: ["targets"],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const all = ctx.targets;
            const keep = [];
            for (const t of all) {
                if (t.hit === false) continue;
                const has = !!(await ctx.adapter.targetHas?.(t.actor, a.trait, { record: ctx.record }));
                if (has !== !!a.negate) keep.push(t);
            }
            if (!keep.length) return;
            ctx.targets = keep;
            try { await runBody(body); } finally { ctx.targets = all; }
        }
    });

    /* ── ifEnvironment ───────────────────────────────────────────────────
     * Mirror Effect "uses the rays of the sun and cannot be used where the
     * sun's rays can't penetrate. By the light of the moon or on overcast
     * days, it does half damage."
     *
     * Three states, not two, and the middle one is a scaling rather than a
     * veto — which is why this is a gate over the world rather than a flag on
     * the damage block. */
    defineBlock({
        id: "core:ifEnvironment",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if the surroundings are [condition]",
        inputs: {
            condition: { type: "string", of: "@conditions" },
            negate:    { type: "boolean", default: false }
        },
        requires: [],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const holds = !!(await ctx.adapter.environmentIs?.(ctx.actor, a.condition, { record: ctx.record }));
            if (holds !== !!a.negate) await runBody(body);
        }
    });

    /* ── deflect ─────────────────────────────────────────────────────────
     * Gwynt Troelli: "Any projectile attack must beat your Spell Casting roll.
     * If they fail, the barrier knocks the projectile 8m away in a random
     * direction." Dervish redirects the same way.
     *
     * Not absorption. Quen's shield eats damage and shrinks; this one is a
     * threshold that either turns an attack aside entirely or lets it through
     * untouched, and it never depletes. Conflating the two would give Gwynt
     * Troelli a hit-point pool it does not have. */
    defineBlock({
        id: "core:deflect",
        shape: SHAPE.STACK,
        category: "defence",
        label: "deflect it unless the attacker beats [threshold]",
        inputs: {
            threshold: { type: "enum", options: ["castRoll", "flat"], default: "castRoll" },
            flat:      { type: "expression", numeric: true, default: null },
            scatter:   { type: "expression", numeric: true, default: "0" }
        },
        requires: ["incoming"],
        emits: [],
        async run(ctx, a) {
            const bar = a.threshold === "flat" ? evaluate(a.flat, ctx.vars) : (ctx.state?.castRoll ?? ctx.record.casterRoll);
            const attack = ctx.incoming?.attackRoll ?? ctx.incoming?.record?.casterRoll ?? 0;
            if (attack > bar) return;                    // it got through
            ctx.incoming.deflected = true;
            ctx.incoming.amount = 0;
            await ctx.adapter.onDeflect?.(ctx.owner ?? ctx.actor, {
                scatter: evaluate(a.scatter, ctx.vars), incoming: ctx.incoming
            });
        }
    });

    /* ── ifWithin ────────────────────────────────────────────────────────
     * Igni is the only entry whose HIT LOCATION depends on distance: "Igni
     * always deals damage to the torso unless used at point blank range. When
     * used at point blank range Igni can be aimed at body locations."
     *
     * A range band the tree can branch on. The distance itself is the
     * adapter's to know — it is the thing that can see the map. */
    defineBlock({
        id: "core:ifWithin",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if the target is within [metres]m",
        inputs: {
            metres: { type: "expression", numeric: true, default: "1" },
            negate: { type: "boolean", default: false }
        },
        requires: ["targets"],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const limit = evaluate(a.metres, ctx.vars);
            const all = ctx.targets;
            const keep = [];
            for (const t of all) {
                if (t.hit === false) continue;
                const d = await ctx.adapter.distanceBetween?.(ctx.actor, t.actor) ?? 0;
                if ((d <= limit) !== !!a.negate) keep.push(t);
            }
            if (!keep.length) return;
            ctx.targets = keep;
            try { await runBody(body); } finally { ctx.targets = all; }
        }
    });

    /* ── targetNearest ───────────────────────────────────────────────────
     * Magic Trap "will make one attack against the closest enemy each round".
     * The trap picks its own victim, on its own schedule, long after the cast
     * that placed it — so the body cannot inherit a target list, it has to
     * acquire one.
     *
     * This is the only autonomous attacker in the core book, and it is why a
     * deferred body gets a context rather than a frozen copy of the cast's. */
    defineBlock({
        id: "core:targetNearest",
        shape: SHAPE.GATE,
        category: "gate",
        label: "against the nearest [count] [of]",
        inputs: {
            count: { type: "expression", numeric: true, default: "1" },
            of:    { type: "enum", options: ["enemy", "creature", "ally"], default: "enemy" },
            within:{ type: "expression", numeric: true, default: null }
        },
        requires: [],
        /* The list it finds is its BODY's, not its siblings' — it restores the
         * outer targets on the way out. */
        emits: [],
        provides: ["targets"],
        async run(ctx, a, { body, runBody }) {
            const found = await ctx.adapter.nearestTargets?.(ctx.actor, {
                count: Math.max(1, Math.round(evaluate(a.count, ctx.vars))),
                of: a.of,
                within: a.within == null ? null : evaluate(a.within, ctx.vars),
                record: ctx.record
            }) ?? [];
            if (!found.length) return;
            const all = ctx.targets;
            ctx.targets = found.map(x => ({ actor: x, defenceTotal: null, hit: true, margin: null }));
            try { await runBody(body); } finally { ctx.targets = all; }
        }
    });

    /* ── afterRounds ─────────────────────────────────────────────────────
     * Magic Trap "takes one round to prepare". Nothing else in the core book
     * has a wind-up, which is exactly why it needs to be sayable rather than
     * assumed — a trap that is live the instant it is placed is a different
     * spell from one an enemy can walk past during setup. */
    defineBlock({
        id: "core:afterRounds",
        shape: SHAPE.DEFERRED,
        category: "persistence",
        label: "after [rounds] rounds",
        inputs: { rounds: { type: "expression", numeric: true, default: "1" } },
        requires: [],
        emits: [],
        provides: ["targets"],
        async run(ctx, a, { body, deferBody }) {
            const n = Math.max(0, Math.round(evaluate(a.rounds, ctx.vars)));
            /* The body runs LATER, and it has to run on somebody.
             *
             * This handed it `targets: []`, so every effect block inside it —
             * all of which loop over `ctx.targets` — did nothing at all, while
             * the block's own `provides: ["targets"]` told the validator the
             * opposite. A delayed effect was accepted, saved, scheduled, fired
             * on time, and touched no one.
             *
             * The cast's targets are the right ones to carry: "after two
             * rounds, they catch fire" means the people this spell caught.
             * `core:repeatEachRound` already does exactly this. */
            const targets = ctx.targets.filter(t => t.hit !== false).map(t => t.actor);
            const later = deferBody(body);
            await ctx.adapter.scheduleAfter?.(ctx.actor, {
                rounds: n, record: ctx.record, run: () => later({ targets })
            });
        }
    });

    /* ── ifIncomingElement ───────────────────────────────────────────────
     * Demetia's Crest Surge "blocks a number of water spells equal to 2 times
     * your Spell Casting skill value". A charge-counted shield filtered by the
     * attacker's ELEMENT — which is in the public record precisely so a
     * defender can read it. */
    defineBlock({
        id: "core:ifIncomingElement",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if the incoming magic is [elements]",
        inputs: { elements: { type: "list", of: "@elements", default: [] } },
        requires: ["incoming"],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const el = ctx.incoming?.record?.element ?? null;
            if ((a.elements ?? []).includes(el)) await runBody(body);
        }
    });
}
