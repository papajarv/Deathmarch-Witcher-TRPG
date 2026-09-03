/**
 * The second batch of blocks — added because authoring real entries demanded
 * them, not because the library looked incomplete.
 *
 * That ordering matters. The previous engine grew ~20 schema fields nobody
 * ever read (`summon`, `transform`, `illusion`, `heal`) because they were
 * specified ahead of any spell needing them. Everything here has at least one
 * entry that could not be authored without it, named in the comment.
 */

import { defineBlock, SHAPE } from "../registry.mjs";
import { evaluate } from "../expression.mjs";
import { lifetimeFrom, rollDuration } from "../lifetimes.mjs";
import { runExpiryTree } from "../frame.mjs";

/**
 * The caster's variables, plus the victim's own.
 *
 * A formula could only ever see the caster's side of the fight, so "as much
 * damage as they have hit points left" — Blessing of Death's whole rule — was
 * inexpressible, and the spell was authored as a status instead, producing a
 * full-health corpse.
 */
function targetVars(ctx, t) {
    const sys = t?.actor?.system ?? {};
    return {
        ...ctx.vars,
        targetHp:    Number(sys.derivedStats?.hp?.value) || 0,
        targetHpMax: Number(sys.derivedStats?.hp?.max) || 0,
        targetSta:   Number(sys.derivedStats?.sta?.value) || 0
    };
}
import { attackerWins } from "../frame.mjs";
import { SYSTEM_ID } from "../systemId.mjs";

export function registerEffectBlocks() {

    /* ── drainResource ───────────────────────────────────────────────────
     * Anialwch: 4d6 damage that ignores armour AND "lowers the target's
     * current STA by 4d6". The only spell in the core book that damages
     * stamina, which is exactly why it needs its own block rather than a
     * flag on dealDamage. */
    defineBlock({
        id: "core:drainResource",
        shape: SHAPE.STACK,
        category: "effect",
        label: "drain [formula] [resource]",
        inputs: {
            formula:  { type: "expression", numeric: true, default: "1d6" },
            resource: { type: "enum", options: ["stamina", "health", "luck"], default: "stamina" }
        },
        requires: ["targets"],
        emits: ["drained"],
        async run(ctx, a) {
            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                /* THE TARGET'S OWN NUMBERS are in scope for the formula.
                 *
                 * "Thrust into Death state as if by taking normal damage" and
                 * its kin need to say "as much as they have left", and there
                 * was no way to express that: every formula could only see the
                 * caster's variables. `{targetHp}` / `{targetSta}` are read
                 * per victim, which is also the only correct way to write them
                 * for a spell that hits several people at once. */
                const n = await ctx.adapter.rollFormula(evaluate(a.formula, targetVars(ctx, t)));
                await ctx.adapter.drainResource?.(t.actor, a.resource, n, { record: ctx.record });
                ctx.created.push({ kind: "drain", target: t.actor, resource: a.resource, amount: n });
            }
        }
    });

    /* ── grantModifier ───────────────────────────────────────────────────
     * `op` is not decoration: Control Water HALVES a swim speed, where every
     * other modifier in the core book adds. `scope` is why Friend to Wild
     * Kind's "+3 Wilderness Survival FOR HANDLING ANIMALS" is not an
     * unconditional buff.
     *
     * Needed by: Yrden (SPD and REF penalties), Mental Command (+5 to the
     * target's own Resist Magic), Glamour, Dormyn's Fog. */
    defineBlock({
        id: "core:grantModifier",
        shape: SHAPE.STACK,
        category: "effect",
        label: "[op] [delta] to [stat] while [until]",
        inputs: {
            stat:  { type: "string", of: "@stats" },
            delta: { type: "expression", numeric: true, default: "1" },
            op:    { type: "enum", options: ["add", "multiply", "set"], default: "add" },
            scope: { type: "string", default: null },
            until: { type: "lifetime", default: "rounds" },
            value: { type: "expression", numeric: true, default: null }
        },
        requires: ["targets"],
        emits: ["modifier"],
        async run(ctx, a) {
            const delta = evaluate(a.delta, ctx.vars);
            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                const ref = await ctx.adapter.grantModifier?.(t.actor, {
                    stat: a.stat, delta, op: a.op, scope: a.scope, record: ctx.record
                });
                const life = lifetimeFrom(
                    { endsOn: a.until, value: await rollDuration(a.value, ctx) },
                    { owner: t.actor, kind: `mod:${a.stat}`, record: ctx.record, source: ctx.item,
                      onExpire: (_e, why) => { ctx.adapter.removeModifier?.(t.actor, ref);
                                               return runExpiryTree(ctx, why); } }
                );
                ctx.created.push({ kind: "modifier", target: t.actor, stat: a.stat, delta, life });
            }
        }
    });

    /* ── createZone ──────────────────────────────────────────────────────
     * Yrden's circle: entrants take the penalty, and it lifts when they
     * leave. That is enter/exit membership, not a one-shot area roll — which
     * is why the old engine's zone payload for per-round damage was written
     * and never read. */
    defineBlock({
        id: "core:createZone",
        shape: SHAPE.DEFERRED,
        category: "effect",
        label: "leave a zone here, lasting [until]",
        inputs: {
            /* Left blank, these match the area the CAST hit.
             *
             * The two are not the same concept and must not be merged: frame
             * targeting is who the spell lands on now, and this is the
             * footprint of a thing left behind. Aard has the first and no
             * second; Yrden has the second and no first — it hits nobody when
             * cast, and the circle catches whoever walks in later.
             *
             * Where a spell has BOTH and they coincide — Static Storm's 5m
             * radius hits the room and then keeps hurting it — stating the
             * size twice is how the two drift apart. So blank means "the same
             * area the cast used", and a value means "deliberately different".
             *
             * `null`, not `"none"`: absent, not shapeless. */
            shape: { type: "enum", options: ["", "radius", "cone", "cube", "line"], default: null },
            size:  { type: "expression", numeric: true, default: null },
            /* The system's aiming overlay knows two anchors: locked to the
             * caster, or placed freely. The engine had invented `point` and
             * `object`, which the overlay silently read as "caster" — so a
             * zone meant to sit where you clicked appeared on top of you.
             *
             * `object` is kept because it means something the overlay does not
             * handle at all (Elgan's Theory magnetises a specific item and the
             * zone follows it), and the adapter checks for it by name. */
            anchor:{ type: "enum", options: ["caster", "free", "object"], default: "caster" },
            until: { type: "lifetime", default: "rounds" },
            value: { type: "expression", numeric: true, default: null },
            /* Rounds an effect LINGERS after leaving. Freya's Bravery is why:
             * "if they leave the area of the invocation, its effects last for
             * 1d6 rounds. These rounds renew if the person re-enters the area
             * and leaves again."
             *
             * Every other zone in the book lifts the instant you step out, so
             * `untilExitZone` was the only exit rule there was. A trailing
             * grace period is not the same thing, and renewing on re-entry is
             * not something a body can express by itself. */
            linger:{ type: "expression", numeric: true, default: null }
        },
        requires: [],
        emits: ["zone"],
        /* The body belongs to whoever WALKS IN, not to the caster's targets —
         * possibly rounds later, possibly several people, possibly nobody. */
        provides: ["targets"],
        async run(ctx, a, { body, deferBody }) {
            /* The cast's own area, when this block does not name one — and a
             * plain radius when the cast had no area at all, which is the
             * Yrden case. */
            const t = ctx.frame.targeting ?? {};
            const shape = a.shape || t.shape || "radius";
            const size = a.size != null && a.size !== ""
                ? evaluate(a.size, ctx.vars)
                : (Number(t.size) || 3);
            const onEnter = deferBody(body);
            /* Filled in below and read when somebody actually walks in, which
             * is always after this function has returned. */
            let placed = null;
            const zone = await ctx.adapter.createZone?.(ctx.actor, {
                shape, size, anchor: a.anchor, record: ctx.record,
                /* Which token an `object`-anchored zone hangs off: the first
                 * target the cast caught, which is the thing the caster aimed
                 * at. Without it the zone had no position at all. */
                on: ctx.targets?.find(t => t.hit !== false)?.actor ?? null,
                linger: a.linger == null ? null : evaluate(a.linger, ctx.vars),
                /* A callable, not a tree. The adapter drives Foundry's region
                 * events and has no business knowing what a block is. */
                onEnter: (entrant) => onEnter({
                    targets: [entrant],
                    zone: placed?.template?.uuid ?? placed?.uuid ?? null,
                    /* Carried so the effects the body applies know how long
                     * they survive the exit — see `zoneLingerRounds`. */
                    linger: a.linger == null ? null : evaluate(a.linger, ctx.vars)
                })
            });
            placed = zone;
            const life = lifetimeFrom(
                { endsOn: a.until, value: await rollDuration(a.value, ctx) },
                { owner: ctx.actor, kind: `zone:${shape}`, record: ctx.record, source: ctx.item,
                  onExpire: (_e, why) => { ctx.adapter.removeZone?.(zone);
                                           return runExpiryTree(ctx, why); } }
            );
            ctx.created.push({ kind: "zone", shape, size, life, ref: zone });
        }
    });

    /* ── saveEnds ────────────────────────────────────────────────────────
     * "the target makes an Endurance roll at a DC equal to the casting roll".
     * The caster's roll becoming the target's DC is the DEFAULT escape
     * mechanic in this book — eight spells use it — which is why the record
     * has to persist the roll.
     *
     * Needed by: Cursed Illness, Talfryn's Prison, Puppet, Mental Command. */
    defineBlock({
        id: "core:saveEnds",
        shape: SHAPE.STACK,
        category: "persistence",
        label: "[skill] save each [cadence] ends it",
        inputs: {
            skill:    { type: "string", of: "@skills", default: "endurance" },
            dcSource: { type: "enum", options: ["castRoll", "fixed", "targetStat"], default: "castRoll" },
            dc:       { type: "expression", numeric: true, default: null },
            /* Which of the TARGET's stats sets the DC, when `dcSource` says so.
             * Without this the option resolved to `dc = null` and there was
             * nothing to name the stat with — Axii and Web of Lies both asked
             * for `targetStat` and both got no DC at all. */
            dcStat:   { type: "string", of: "@stats", default: "will" },
            dcFactor: { type: "expression", numeric: true, default: "3" },
            cadence:  { type: "enum", options: ["round", "turn", "day"], default: "round" },
            /* Two shapes of check, both printed in the book. `rollOver` is the
             * usual "1d10 + skill vs a DC"; `rollUnder` is the bare d10 under
             * a stat that Web of Lies and its kin use, and which could not be
             * expressed at all — so it was authored as a roll-over against
             * WILL×3 and became a save no one could ever make. */
            mode:     { type: "enum", options: ["rollOver", "rollUnder"], default: "rollOver" },
            escalate: { type: "expression", numeric: true, default: "0" }
        },
        requires: ["targets"],
        emits: ["saveEnds"],
        async run(ctx, a) {
            const fixed = a.dcSource === "castRoll" ? ctx.record.casterRoll
                        : a.dcSource === "fixed"    ? evaluate(a.dc, ctx.vars)
                        : null;
            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                /* Per target, because the stat is theirs. */
                const dc = a.dcSource === "targetStat"
                    ? Math.round((await ctx.adapter.statValue?.(t.actor, a.dcStat) ?? 0)
                                 * (evaluate(a.dcFactor, ctx.vars) || 1))
                    : fixed;
                await ctx.adapter.registerSave?.(t.actor, {
                    skill: a.skill, dc, cadence: a.cadence, mode: a.mode,
                    escalate: evaluate(a.escalate, ctx.vars), record: ctx.record
                });
                ctx.created.push({ kind: "saveEnds", target: t.actor, skill: a.skill, dc,
                                   cadence: a.cadence });
            }
        }
    });

    /* ── repeatEachRound ─────────────────────────────────────────────────
     * Magic Healing heals 3 a round for its duration; Static Storm deals 2 a
     * round to anyone in metal. The body runs on a clock rather than now. */
    defineBlock({
        id: "core:repeatEachRound",
        shape: SHAPE.DEFERRED,
        category: "persistence",
        label: "each round",
        inputs: { rounds: { type: "expression", numeric: true, default: null } },
        requires: ["targets"],
        emits: [],
        /* Deferred, not a gate: the body runs on the combat clock, after the
         * cast has returned. It keeps the cast's targets, which is why it
         * requires them above AND promises them below. */
        provides: ["targets"],
        async run(ctx, a, { body, deferBody }) {
            /* ROLLED, not evaluated. "Lasts 1d10 rounds" reached
             * `registerClock` as the STRING "1d10", and `elapsed >= "1d10"` is
             * NaN-false forever — so a bounded per-round effect ticked for the
             * rest of the session. The same bug the durations had, in the one
             * place that had its own copy of it. */
            const n = await rollDuration(a.rounds, ctx);
            const targets = ctx.targets.filter(t => t.hit !== false).map(t => t.actor);
            const tick = deferBody(body);
            await ctx.adapter.scheduleEachRound?.(ctx.actor, {
                rounds: n, record: ctx.record, run: () => tick({ targets })
            });
        }
    });

    /* ── multiAttack ─────────────────────────────────────────────────────
     * Tryferi Gaeaf fires `floor({skill}/2)` spikes and says "Each attack
     * resolves separately" — its own hit roll, its own location, its own
     * armour application.
     *
     * Post-errata it is the ONLY genuine multi-attack in the core book. The
     * errata DELETES the same sentence from Cenlly Graig and Carys' Hail,
     * making both a single attack whose margin scales one damage pool. A
     * text-diff would never surface a deletion, so the two shapes are easy to
     * conflate — hence a block that has to be asked for explicitly. */
    defineBlock({
        id: "core:multiAttack",
        shape: SHAPE.GATE,
        category: "gate",
        label: "repeat [count] separate attacks",
        inputs: { count: { type: "expression", numeric: true, default: "1" } },
        requires: ["targets"],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const n = Math.max(0, Math.floor(evaluate(a.count, ctx.vars)));
            /* "Each attack resolves separately" — so each one is re-checked
             * against the defence that was already rolled. The fresh roll used
             * to be taken and then thrown away into `ctx.control.attackRoll`,
             * which nothing anywhere read; every spike re-used the frame's one
             * verdict, so all N hit or all N missed together. */
            const verdicts = ctx.targets.map(t => t.hit);
            for (let i = 0; i < n; i++) {
                ctx.vars.index = i;
                const roll = await ctx.adapter.rollCast?.(ctx.actor);
                const total = roll?.total ?? ctx.record.casterRoll;
                ctx.control.attackRoll = total;
                for (const [j, t] of ctx.targets.entries()) {
                    /* A target the frame never engaged stays out of it. */
                    if (verdicts[j] === false && t.defenceTotal == null) continue;
                    t.hit = t.defenceTotal == null
                        ? verdicts[j]
                        : attackerWins(total, t.defenceTotal, ctx.frame.defence?.ties);
                }
                await runBody(body);
            }
            /* Put the frame's own verdict back — later blocks in the same tree
             * must not inherit the last spike's luck. */
            ctx.targets.forEach((t, j) => { t.hit = verdicts[j]; });
            ctx.vars.index = 0;
        }
    });

    /* ── ifPenetratedArmour ──────────────────────────────────────────────
     * Tryferi Gaeaf's freeze fires only "if they do damage through armor" —
     * a rider conditioned on the outcome of the damage step, not on the hit. */
    defineBlock({
        id: "core:ifPenetratedArmour",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if the damage got through armour",
        inputs: {},
        requires: ["damageDealt"],
        emits: [],
        async run(ctx, _a, { body, runBody }) {
            /* THE HIT IMMEDIATELY BEFORE THIS, or nothing.
             *
             * Searching backwards through the whole cast found the last damage
             * record ANYWHERE in it — so inside `core:multiAttack`, a spike
             * that MISSED (and therefore pushed no record) inherited the
             * previous spike's, and its rider fired anyway. Live, Tryferi
             * Gaeaf froze a target off an attack that never landed.
             *
             * A miss must read as a miss: only a damage record that is the
             * most recent thing the tree produced counts. */
            const last = ctx.created[ctx.created.length - 1];
            if (last?.kind !== "damage") return;
            if (last.penetrated === null) {
                /* The damage went out over a socket and nobody reported back.
                 * Silently not firing is what this block did for its whole
                 * life; at least say why. */
                console.warn(`${SYSTEM_ID} | ${ctx.item?.name ?? "a spell"}: cannot tell whether the damage beat armour, so the rider is left to the table`);
                return;
            }
            if (last.penetrated) await runBody(body);
        }
    });
}
