/**
 * The third batch — added while authoring the Novice list.
 *
 * This one is uncomfortable and worth being honest about: a large tail of the
 * core book has NO combat mechanics at all. Magic Compass tells you which way
 * is north. Codi Bywyd grows a herb. Luthien's Quill scratches writing into a
 * wall. Summon Staff moves a stick.
 *
 * The previous engine's answer was to give these spells an empty handler and
 * let the chat card print the rules text — which meant a third of the book was
 * "implemented" by doing nothing, and nobody could tell those apart from the
 * ones that were broken. These blocks exist so the difference is visible: a
 * spell that reveals information SAYS it reveals information, and the runtime
 * can be asked what it did.
 */

import { defineBlock, SHAPE } from "../registry.mjs";
import { evaluate, resolveText } from "../expression.mjs";
import { lifetimeFrom, rollDuration } from "../lifetimes.mjs";
import { runExpiryTree } from "../frame.mjs";

export function registerKnowledgeBlocks() {

    /* ── revealInfo ──────────────────────────────────────────────────────
     * Diagnostic Spell reads HP, critical wounds, and disease/poison state.
     * Vaults of Knowledge, Nature's Sight, Magic Compass and Divine Wisdom
     * are the same shape with a different `about`.
     *
     * `to` matters: this is private knowledge, whispered to the caster. A
     * diagnostic that posts the target's exact HP publicly hands the whole
     * table information one character bought. */
    defineBlock({
        id: "core:revealInfo",
        shape: SHAPE.STACK,
        category: "knowledge",
        label: "reveal [about] to [to]",
        inputs: {
            about: { type: "enum", options: "@infoKinds", default: "health" },
            to:    { type: "enum", options: ["caster", "target", "table"], default: "caster" },
            detail:{ type: "string", default: null }
        },
        requires: [],
        emits: ["revealed"],
        async run(ctx, a) {
            const subjects = ctx.targets.filter(t => t.hit !== false).map(t => t.actor);
            const info = await ctx.adapter.revealInfo?.(ctx.actor, {
                about: a.about, to: a.to, detail: a.detail,
                subjects: subjects.length ? subjects : [ctx.actor], record: ctx.record
            });
            ctx.created.push({ kind: "revealed", about: a.about, to: a.to, info });
        }
    });

    /* ── narrate ─────────────────────────────────────────────────────────
     * The honest floor. Codi Bywyd, Summon Staff, Luthien's Quill, Freshen
     * Air, Part Water: the spell succeeded and the world changed in a way the
     * table adjudicates.
     *
     * It is deliberately NOT the same as an empty tree. An empty tree is a
     * spell nobody finished; this one asserts there is nothing to compute. */
    defineBlock({
        id: "core:narrate",
        shape: SHAPE.STACK,
        category: "knowledge",
        label: "narrate [what]",
        inputs: {
            what:  { type: "string", long: true },
            scale: { type: "enum", options: ["trivial", "notable", "major"], default: "notable" },
            /* Named arithmetic for the sentence. Telekinesis lifts "up to 5
             * ENC per 1 point of Spell Casting" — a number the player needs,
             * that only the engine can work out, inside a slot that by design
             * does not do arithmetic. `values: { cap: "5*{skill}" }` evaluates
             * here and interpolates as `{cap}`, keeping the two jobs apart. */
            values: { type: "map", default: null }
        },
        requires: [],
        emits: [],
        async run(ctx, a) {
            let what = a.what;
            if (a.values) {
                const computed = {};
                for (const [k, expr] of Object.entries(a.values)) computed[k] = evaluate(expr, ctx.vars);
                what = resolveText(what, computed);
            }
            await ctx.adapter.narrate?.(ctx.actor, { what, scale: a.scale, record: ctx.record });
            ctx.created.push({ kind: "narrated", what });
        }
    });

    /* ── chooseOption ────────────────────────────────────────────────────
     * Mind Manipulation forces "hatred, love, depression, or euphoria"; Shape
     * Nature and Polymorphism pick from a list too. Unlike a BANDED cost the
     * options here all cost the same, so the choice cannot ride on price.
     *
     * The pick binds into the TEXT scope, so the body reads it as `{choice}` —
     * the same mechanism `{band}` uses, which is the point of having one. */
    defineBlock({
        id: "core:chooseOption",
        shape: SHAPE.GATE,
        category: "gate",
        label: "with [choices] chosen as [bind]",
        inputs: {
            choices: { type: "list", default: [] },
            bind:    { type: "string", default: "choice" },
            who:     { type: "enum", options: ["caster", "target"], default: "caster" }
        },
        requires: [],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const asker = a.who === "target" ? (ctx.targets[0]?.actor ?? ctx.actor) : ctx.actor;
            const picked = await ctx.adapter.chooseOption?.(asker, {
                choices: a.choices, record: ctx.record, item: ctx.item
            });
            if (picked == null) return;                 // declining is not a failure
            /* The BOUND value is what a card prints, so it is the readable
             * label — "Lightning storm", not `lightningStorm`. The raw id
             * stays available to `core:ifChoice`, which branches on identity
             * and must not depend on how a word is spelled for a reader. */
            ctx.text[a.bind] = ctx.adapter.choiceLabel?.(picked) ?? picked;
            ctx.control.choices = { ...(ctx.control.choices ?? {}), [a.bind]: picked };
            /* The choice is BOUND, not branched on — this body runs whatever
             * was picked, and `{choice}` reads back in any string slot inside
             * it. To do different things per answer, put `core:ifChoice`
             * blocks in the body: one per branch. Cadfan's Grasp is why —
             * "hold on" costs you 2d6 to the hand and "drop it" does not, and
             * a single body made the two answers mechanically identical. */
            await runBody(body);
        }
    });

    /* ── ifChoice ────────────────────────────────────────────────────────
     * The branch half of `core:chooseOption`. Kept separate rather than
     * folded into it because a choice with three answers needs three bodies,
     * and a block that holds one body cannot express that — while three
     * gates in a row can, and read in the order they resolve.
     */
    defineBlock({
        id: "core:ifChoice",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if [bind] is [is]",
        inputs: {
            bind:   { type: "string", default: "choice" },
            is:     { type: "string", default: "" },
            negate: { type: "boolean", default: false }
        },
        requires: [],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            /* The ID, not the label. `chooseOption` binds a readable label for
             * cards to print; branching on that would break the moment a
             * translation existed. */
            const picked = String(ctx.control?.choices?.[a.bind] ?? ctx.text?.[a.bind] ?? "");
            const wanted = String(a.is ?? "");
            const match = picked !== "" && picked === wanted;
            if (match !== !!a.negate) await runBody(body);
        }
    });

    /* ── ifTargetFumbled ─────────────────────────────────────────────────
     * Eilhart's Technique: "If the target FUMBLES THEIR DEFENSE, their INT is
     * reduced by 1 permanently."
     *
     * The frame already tracks the caster's fumble and routes it to `on.fumble`.
     * This is the mirror, and it had no expression at all — the defender's
     * botch was information the pipeline collected and then discarded. */
    defineBlock({
        id: "core:ifTargetFumbled",
        shape: SHAPE.GATE,
        category: "gate",
        label: "for each target who fumbled their defence",
        inputs: {},
        requires: ["targets"],
        emits: [],
        async run(ctx, _a, { body, runBody }) {
            const all = ctx.targets;
            const botched = all.filter(t => t.defenceFumbled);
            if (!botched.length) return;
            ctx.targets = botched;
            try { await runBody(body); } finally { ctx.targets = all; }
        }
    });

    /* ── endMagic ────────────────────────────────────────────────────────
     * Dispel's own body. "To cancel a magical effect you must spend half as
     * many Stamina points as the caster spent to cast the magic and make a
     * Spell Casting roll that beats their casting roll."
     *
     * Dispel is already registered as a CONTRIBUTED DEFENCE — that path covers
     * using it reactively. This is the other half: casting it on your turn at
     * something already standing. Both read the same public record, which is
     * why the record is not optional.
     *
     * Note the tie direction. Dispel must BEAT the original roll, so a tie
     * favours the standing effect — the opposite of the book's usual
     * convention, and the single genuine exception to it. */
    defineBlock({
        id: "core:endMagic",
        shape: SHAPE.STACK,
        category: "knowledge",
        label: "end magic on the target, [scope]",
        inputs: {
            scope: { type: "enum", options: ["one", "allFromOneCaster", "all"], default: "one" },
            kinds: { type: "list", default: ["spell", "invocation", "hex", "ritual", "sign"] }
        },
        requires: ["targets"],
        emits: ["dispelled"],
        async run(ctx, a) {
            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                const standing = await ctx.adapter.magicOn?.(t.actor, { kinds: a.kinds }) ?? [];
                /* Strictly greater: a tie leaves the effect standing. */
                const beatable = standing.filter(e => ctx.record.casterRoll > (e.record?.casterRoll ?? 0));
                const chosen = a.scope === "all" ? beatable
                             : a.scope === "allFromOneCaster"
                               ? beatable.filter(e => e.record?.caster === beatable[0]?.record?.caster)
                               : beatable.slice(0, 1);
                for (const e of chosen) await ctx.adapter.endMagic?.(t.actor, e);
                ctx.created.push({ kind: "dispelled", target: t.actor, count: chosen.length,
                                   refused: standing.length - beatable.length });
            }
        }
    });

    /* ── removeStatus ────────────────────────────────────────────────────
     * Nothing in the library could take a status OFF anything, which held for
     * fourteen block definitions without being noticed — every entry authored
     * so far only ever added.
     *
     * Downpour is what surfaced it: "creates a 10m radius area of rain that
     * puts out any fire it hits. This spell counteracts fire effects." That is
     * uncontested removal, and it is emphatically NOT Dispel — no roll, no
     * comparison against the original caster, no half-cost. Routing it through
     * `endMagic` would let a 2-STA rain shower out-roll a master's working. */
    defineBlock({
        id: "core:removeStatus",
        shape: SHAPE.STACK,
        category: "effect",
        label: "remove [status] from the target",
        inputs: {
            status: { type: "enum", options: "@statuses" },
            /* "area" was a third option that behaved exactly like "targets":
             * an area spell's `ctx.targets` ALREADY is everyone the area
             * caught, so there was no second meaning for it to carry. Downpour
             * and White Flame both asked for it and both got the same code
             * path. A dropdown entry that cannot differ is worse than one less
             * choice, so it is gone. */
            from:   { type: "enum", options: ["targets", "caster"], default: "targets" }
        },
        requires: [],
        emits: [],
        async run(ctx, a) {
            const who = a.from === "caster" ? [ctx.actor]
                      : ctx.targets.filter(t => t.hit !== false).map(t => t.actor);
            for (const actor of who) {
                await ctx.adapter.removeStatus?.(actor, a.status, { record: ctx.record });
                ctx.created.push({ kind: "statusRemoved", target: actor, status: a.status });
            }
        }
    });

    /* ── counteract ──────────────────────────────────────────────────────
     * The standing half of the same idea. Downpour does not just extinguish
     * what is already burning — while it lasts it "counteracts fire effects",
     * so nothing new catches inside it either. A one-shot removal cannot say
     * that; a standing suppression can. */
    defineBlock({
        id: "core:counteract",
        shape: SHAPE.STACK,
        category: "effect",
        label: "suppress [tag] effects here",
        inputs: {
            tag:   { type: "string", of: "@counterTags" },
            /* White Flame "dispels water-based spells in the area. Water-based
             * spells can only be cast in the area of the spell if the caster's
             * Spell Casting check BEATS that of the Priest of the Great Sun."
             * A suppression that can be pushed through, rather than an absolute
             * one — Downpour's is absolute, and the two must not be conflated. */
            threshold: { type: "enum", options: ["absolute", "castRoll"], default: "absolute" },
            until: { type: "lifetime", default: "rounds" },
            value: { type: "expression", numeric: true, default: null }
        },
        requires: [],
        emits: [],
        async run(ctx, a) {
            /* ON WHOEVER IT PROTECTS.
             *
             * The ward was always written onto the CASTER while the check that
             * reads it asks the actor an effect is landing on — so an enforced
             * suppression only ever bit the caster themselves, and Downpour's
             * fire ban reached nobody it was cast over. A spell that caught
             * people wards those people; a spell that caught nobody (Downpour
             * on yourself, Puro Dwr on a barrel) wards its caster. */
            const who = (ctx.targets ?? []).filter(t => t.hit !== false).map(t => t.actor);
            const wards = who.length ? who : [ctx.actor];
            let ref = null;
            for (const target of wards) {
                ref = await ctx.adapter.counteract?.(target, {
                    tag: a.tag, record: ctx.record,
                    beatenBy: a.threshold === "castRoll" ? ctx.record.casterRoll : null
                }) ?? ref;
            }
            const life = lifetimeFrom(
                { endsOn: a.until, value: await rollDuration(a.value, ctx) },
                { owner: ctx.actor, kind: `counteract:${a.tag}`, record: ctx.record, source: ctx.item,
                  onExpire: () => ctx.adapter.removeCounteract?.(ref) }
            );
            ctx.created.push({ kind: "counteract", tag: a.tag, life });
        }
    });

    /* ── rerollAgainstStanding ───────────────────────────────────────────
     * Holy Fortification "bolsters a target's willpower and allows the target
     * to make a new check against the effects of ANY SPELL that is currently
     * affecting them."
     *
     * Every one of those effects has to be re-contested against the roll the
     * ORIGINAL caster made, which may have been an hour and three casters ago.
     * This is the third independent rule in the core book demanding that the
     * cast record persist for as long as the effect it created — Dispel and
     * Puppet are the other two, and between them they are why the record is
     * public rather than private to the cast that made it. */
    defineBlock({
        id: "core:rerollAgainstStanding",
        shape: SHAPE.STACK,
        category: "knowledge",
        label: "re-check [skill] against everything affecting them",
        inputs: {
            skill: { type: "string", of: "@skills", default: "resistmagic" },
            kinds: { type: "list", default: ["spell", "invocation", "hex", "sign"] },
            bonus: { type: "expression", numeric: true, default: "0" }
        },
        requires: ["targets"],
        emits: [],
        async run(ctx, a) {
            const bonus = evaluate(a.bonus, ctx.vars);
            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                const standing = await ctx.adapter.magicOn?.(t.actor, { kinds: a.kinds }) ?? [];
                for (const e of standing) {
                    const roll = (await ctx.adapter.rollDefenceSkill?.(t.actor, a.skill) ?? 0) + bonus;
                    /* Against the roll that CREATED it, not against this cast. */
                    if (roll > (e.record?.casterRoll ?? 0)) {
                        await ctx.adapter.endMagic?.(t.actor, e);
                        ctx.created.push({ kind: "shakenOff", target: t.actor, effect: e, roll });
                    }
                }
            }
        }
    });

    /* ── grantPool ───────────────────────────────────────────────────────
     * Luck of the Father hands the caster "a number of LUCK points equal to
     * your Spell Casting skill value times 3", spendable over an hour on their
     * own rolls OR on anyone else's within 10m. Blessing of Fortune gives a
     * smaller pool to someone else.
     *
     * A pool is not a modifier: a modifier applies to everything it covers
     * until it lapses, while a pool is spent a point at a time and runs out. */
    defineBlock({
        id: "core:grantPool",
        shape: SHAPE.STACK,
        category: "effect",
        label: "grant [size] [resource] points, spendable [scope]",
        inputs: {
            resource: { type: "string", of: "@resources", default: "luck" },
            size:     { type: "expression", numeric: true, default: "1" },
            /* "nearby" took the same branch as "targets" and no spell in the
             * book ever asked for it. Offering a third word for the second
             * behaviour is how an author learns to distrust the dropdown. */
            scope:    { type: "enum", options: ["self", "targets"], default: "targets" },
            until:    { type: "lifetime", default: "untilExpended" },
            value:    { type: "expression", numeric: true, default: null }
        },
        requires: [],
        emits: ["pool"],
        async run(ctx, a) {
            const size = evaluate(a.size, ctx.vars);
            if (size <= 0) return;
            const who = a.scope === "self" ? [ctx.actor]
                      : ctx.targets.filter(t => t.hit !== false).map(t => t.actor);
            for (const actor of who) {
                const ref = await ctx.adapter.grantPool?.(actor, {
                    resource: a.resource, size, scope: a.scope, record: ctx.record
                });
                const life = lifetimeFrom(
                    { endsOn: a.until, value: await rollDuration(a.value, ctx) },
                    { owner: actor, kind: `pool:${a.resource}`, record: ctx.record, source: ctx.item,
                      onExpire: (_e, why) => { ctx.adapter.removePool?.(ref);
                                               return runExpiryTree(ctx, why); } }
                );
                ctx.created.push({ kind: "pool", target: actor, resource: a.resource, size, life });
            }
        }
    });

    /* ── summonCopies ────────────────────────────────────────────────────
     * Afan's Mirror makes 1d10 intangible duplicates of the caster; Illusion
     * and Interactive Illusion make one of something else. All three are the
     * same block: a thing that exists, can be disbelieved, and cannot act. */
    defineBlock({
        id: "core:summonCopies",
        shape: SHAPE.STACK,
        category: "effect",
        label: "summon [count] [what] lasting [until]",
        inputs: {
            count:     { type: "expression", numeric: true, default: "1" },
            what:      { type: "string", default: "copy" },
            tangible:  { type: "enum", options: ["no", "yes"], default: "no" },
            controlled:{ type: "enum", options: ["caster", "none"], default: "caster" },
            until:     { type: "lifetime", default: "rounds" },
            value:     { type: "expression", numeric: true, default: null }
        },
        requires: [],
        emits: ["summoned"],
        async run(ctx, a) {
            const count = Math.max(0, Math.round(await ctx.adapter.rollFormula(evaluate(a.count, ctx.vars))));
            const ref = await ctx.adapter.summonCopies?.(ctx.actor, {
                count, what: a.what, tangible: a.tangible === "yes",
                controlled: a.controlled, record: ctx.record
            });
            const life = lifetimeFrom(
                { endsOn: a.until, value: await rollDuration(a.value, ctx) },
                { owner: ctx.actor, kind: `summon:${a.what}`, record: ctx.record, source: ctx.item,
                  onExpire: (_e, why) => { ctx.adapter.removeSummon?.(ref);
                                           return runExpiryTree(ctx, why); } }
            );
            ctx.created.push({ kind: "summoned", what: a.what, count, life, ref });
        }
    });
}
