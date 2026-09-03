/**
 * Defensive blocks — the interception side.
 *
 * These run inside a subscription's tree rather than a cast's, so their
 * context carries `ctx.incoming` (the mutable payload passing through) and
 * `ctx.state` (the subscribing effect's own data — a shield's pool, a ward's
 * charges) instead of a target list.
 *
 * Quen is the reason this file exists and the reason it looks awkward. Its
 * filter is not over damage type, element, or source actor: it works against
 * "any spell which can be Blocked", a predicate over the INCOMING ITEM'S OWN
 * DEFENCE ENTRY. That is a data dependency running backwards through the
 * pipeline — from the attacker's rules text into the defender's damage step —
 * and it is only expressible because the cast record is public and persisted.
 */

import { defineBlock, SHAPE } from "../registry.mjs";
import { evaluate } from "../expression.mjs";
import { fireCondition, ENDS } from "../lifetimes.mjs";

export function registerDefensiveBlocks() {

    /* ── ifIncomingDefenceAllows ──────────────────────────────────────────
     * Quen absorbs only what could have been Blocked. With 52 of 103 entries
     * declaring `Defense: None`, this single predicate decides whether Quen
     * does anything at all against half the magic in the game. */
    defineBlock({
        id: "core:ifIncomingDefenceAllows",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if the incoming attack allows [defence]",
        inputs: { defence: { type: "enum", options: "@defences", default: "block" } },
        requires: ["incoming"],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const set = ctx.incoming?.record?.defenceSet ?? [];
            /* "blockOrDodge" satisfies a "block" query — the defender may
             * choose either, so block IS available against it. */
            const allows = set.some(d =>
                d === a.defence ||
                (a.defence === "block" && d === "blockOrDodge") ||
                (a.defence === "dodge" && d === "blockOrDodge"));
            if (allows) await runBody(body);
        }
    });

    /* ── ifDamageChannelNotIn ─────────────────────────────────────────────
     * Quen's exclusion list — poison, disease, suffocation — is not about
     * damage TYPE. Those are ongoing conditions rather than attacks, so the
     * axis is damage PROVENANCE, orthogonal to both element and defence set. */
    defineBlock({
        id: "core:ifDamageChannelNotIn",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if the damage is not [channels]",
        inputs: { channels: { type: "list", of: "@damageChannels", default: [] } },
        requires: ["incoming"],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const channel = ctx.incoming?.record?.damageChannel ?? "attack";
            if (!(a.channels ?? []).includes(channel)) await runBody(body);
        }
    });

    /* ── absorbDamage ─────────────────────────────────────────────────────
     * Intercepts AHEAD of armour: damage hits the pool first, and only the
     * overflow goes on to armour and resistances "just like any other
     * attack". Lethal and non-lethal deplete the pool equally — the book says
     * so explicitly, which is unusual enough to be worth a parameter.
     *
     * When the pool empties the subscription tears itself down, which is what
     * makes Quen's `alsoEndsOn: poolEmpty` duration real rather than
     * decorative. */
    defineBlock({
        id: "core:absorbDamage",
        shape: SHAPE.STACK,
        category: "effect",
        label: "absorb the damage, [parity]",
        inputs: {
            parity: { type: "enum", options: ["lethalAndNonLethal", "lethalOnly"], default: "lethalAndNonLethal" }
        },
        requires: ["incoming"],
        emits: ["absorbed"],
        async run(ctx, a) {
            const inc = ctx.incoming;
            /* ONE POOL, and it is the actor's, not this subscription's.
             *
             * The pool used to live only in `ctx.state.pool` — an in-memory
             * number on a bus subscription, invisible to the damage
             * calculator and gone on page reload. Now `createShield` writes
             * `system.derivedStats.shield`, which the calculator drains for
             * everything that does NOT come through this engine (swords,
             * bolts, bombs, claws). Reading it here keeps the two halves
             * honest: the ward absorbs on the way in, writes the remainder
             * back, and the calculator then sees what is actually left
             * instead of soaking the same points a second time. */
            const live = ctx.adapter?.shieldPool?.(ctx.owner);
            const pool = Number.isFinite(live) ? live : (ctx.state?.pool ?? 0);
            if (pool <= 0 || inc.amount <= 0) return;

            /* Quen's rule is that lethal and non-lethal deplete the pool
             * EQUALLY — the book says so explicitly, which is unusual enough
             * to be worth a setting. But the setting was never read: a ward
             * declaring `lethalOnly` absorbed non-lethal damage anyway, so the
             * option was a dropdown entry that changed nothing. */
            if (a.parity === "lethalOnly" && inc.nonLethal) return;

            const absorbed = Math.min(pool, inc.amount);
            const left = pool - absorbed;
            if (ctx.state) ctx.state.pool = left;
            await ctx.adapter?.setShieldPool?.(ctx.owner, left);
            inc.amount -= absorbed;
            inc.absorbed = (inc.absorbed ?? 0) + absorbed;

            /* Absorption ALWAYS happens before armour: this runs on the way
             * in, and armour is applied downstream in the GM's damage handler
             * where the engine cannot reach. `order` offered "afterArmour" as
             * if it were a choice, wrote `inc.absorbedBefore` which nothing
             * read, and behaved identically either way. Removed rather than
             * faked — honouring it needs a return path from the damage
             * handler that does not exist yet. */
            ctx.adapter?.onAbsorb?.(ctx.owner, { absorbed, remaining: left });

            if (left <= 0) {
                inc.shieldBroke = true;
                /* `alsoEndsOn: poolEmpty` is a real end condition, so it goes
                 * through the lifetime rather than being special-cased here. */
                fireCondition(ctx.state?.life, ENDS.POOL_EMPTY);
                ctx.expire?.();
            }
        }
    });

    /* ── negateMagic ──────────────────────────────────────────────────────
     * Cancels an in-flight cast BEFORE it resolves, which is a different
     * operation from dispelling a standing effect. Heliotrope and Dispel
     * both end here; so does Demetia's Crest Surge, which negates without
     * any roll at all until its charges run out. */
    defineBlock({
        id: "core:negateMagic",
        shape: SHAPE.STACK,
        category: "effect",
        label: "negate the incoming magic",
        inputs: {},
        requires: ["incoming"],
        emits: [],
        async run(ctx) {
            ctx.incoming.vetoed = true;
            ctx.adapter?.onNegate?.(ctx.owner, { source: ctx.incoming.record });
        }
    });

    /* ── consumeCharge ────────────────────────────────────────────────────
     * The third shield archetype. Demetia's Crest Surge blocks a COUNT of
     * water spells — 2 × Spell Casting skill value — not a pool of hit
     * points, which the old `createShield(hpPerSta)` signature could not
     * express at all. Note it scales off skill, not stamina. */
    defineBlock({
        id: "core:consumeCharge",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if a charge remains, spend [n]",
        inputs: { n: { type: "expression", numeric: true, default: "1" } },
        requires: ["incoming"],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            const need = evaluate(a.n, ctx.vars);
            /* THE BADGE IS THE COUNT, the same way `derivedStats.shield` is the
             * pool for `absorbDamage`.
             *
             * This read and wrote `ctx.state.charges` alone — a number on a bus
             * subscription, which nothing outside this engine could see and
             * which did not survive a reload. The caster had a ward running
             * with no indication it existed and no way to tell how many blocks
             * were left. `createShield` now writes an ActiveEffect carrying the
             * count, so read that when it is there and write the remainder
             * back; `state` stays in step for the in-memory subscription. */
            const wardItemId = ctx.source?.id ?? null;
            const live = ctx.adapter?.wardCharges?.(ctx.owner, wardItemId);
            const have = Number.isFinite(live) && live > 0 ? live : (ctx.state?.charges ?? 0);
            if (have < need) return;

            const left = have - need;
            if (ctx.state) ctx.state.charges = left;
            await ctx.adapter?.setWardCharges?.(ctx.owner, left, { itemId: wardItemId });

            await runBody(body);

            if (left <= 0) {
                /* Through the lifetime, not around it — "until its charges run
                 * out" is an end CONDITION, and firing it is what lets an
                 * `onExpire` tree run and what makes `alsoEndsOn: poolEmpty`
                 * mean something on a ward counted in blocks. `absorbDamage`
                 * ends the same way when its pool empties; this used to call
                 * `ctx.expire()` alone, so the subscription vanished and the
                 * lifetime it belonged to stayed in the live list forever. */
                fireCondition(ctx.state?.life, ENDS.POOL_EMPTY);
                ctx.expire?.();
            }
        }
    });
}
