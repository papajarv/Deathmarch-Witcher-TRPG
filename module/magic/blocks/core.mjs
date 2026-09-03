/**
 * Core blocks — the behaviour layer.
 *
 * Deliberately six, not sixty. This is the first slice: enough to author
 * Aenye and Quen end to end, which is what actually tests the design. The
 * remaining ~68 blocks in the library are cheap once the shape is proven and
 * expensive to get wrong before it is.
 *
 * Note what is ABSENT and belongs to the frame instead: payStamina,
 * checkVigor, applyFocusDiscount, rollCast, selectTargets, ifHit. Those
 * appeared in 103 of 103 decomposed trees with identical arguments, which is
 * how we know they are law rather than behaviour.
 */

import { defineBlock, SHAPE } from "../registry.mjs";
import { runExpiryTree } from "../frame.mjs";
import { evaluate } from "../expression.mjs";
import { subscribe, unsubscribe, ENTRY } from "../bus.mjs";
import { applyService, SERVICE } from "../services.mjs";
import { lifetimeFrom, fireCondition, ENDS, rollDuration } from "../lifetimes.mjs";
import { applyDamageWithInterception } from "../intercept.mjs";
import { resolveStatus } from "../statuses.mjs";

/**
 * The glyph dice the caster chose, claimed ONCE per cast.
 *
 * A glyph is a single choice made once in the dialog, so it must land on one
 * effect — a tree with three damage blocks in it does not get +1d6 three times.
 * Whichever magnitude block runs first takes it.
 */
/**
 * Where a damage block lands.
 *
 * The dropdown offers four words and, until this was written, two of them did
 * nothing. `aimed` and `perAttack` were passed through to the damage pipeline
 * verbatim; `resolveLocation` knows neither, so both silently became a torso
 * hit at x1 — which is why Igni at point blank ignored the caster's called
 * shot and Tryferi Gaeaf's "each roll counts as its own separate attack when
 * determining location" struck the same chest five times.
 *
 *   <a real key>  the author named the place. It wins outright — Alzur's
 *                 Thunder says torso and means torso.
 *   aimed         the caster's called shot, and the TORSO if they did not call
 *                 one: "Igni always deals damage to the torso unless used at
 *                 point blank range. When used at point blank range Igni can be
 *                 aimed at body locations."
 *   random        rolled on the system's own d10 table, ONCE PER TARGET and
 *                 then kept for the rest of the cast — a spell with two damage
 *                 blocks is one attack on each victim and strikes each of them
 *                 in one place.
 *   perAttack     rolled fresh EVERY time, for the spells whose text says each
 *                 hit is its own attack (Carys' Gale, Tryferi Gaeaf).
 *
 * A called shot outranks anything that rolls: if the caster aimed, they aimed.
 */
async function aimedLocation(ctx, t, authored) {
    /* The default is the TORSO, which is what the legacy engine has always
     * sent for spell damage and what the book implies: Carys' Gale and Tryferi
     * Gaeaf go out of their way to say "each roll counts as its own separate
     * attack when determining location", which is only worth saying if spells
     * do not normally roll one. A spell that should roll says `random`. */
    const want = String(authored ?? "torso");
    if (want !== "random" && want !== "aimed" && want !== "perAttack") return want;

    const called = ctx.declaration?.location;
    if (called?.mode === "specific" && called.key) return called.key;

    if (want === "aimed") return "torso";

    const kind = called?.kind ?? "human";
    const roll = async () => (await ctx.adapter.rollLocation?.(kind)) ?? null;

    if (want === "perAttack") return (await roll())?.key ?? "torso";

    /* `random`: one place per victim, remembered for the rest of the cast.
     * On `ctx.control` — the cast's own scratch space, where the once-per-cast
     * glyph flag already lives. `ctx.state` belongs to a STANDING effect and
     * does not exist on a cast at all. */
    const seen = (ctx.control.rolledLocations ??= new Map());
    const who = t.actor ?? t;
    if (!seen.has(who)) seen.set(who, await roll());
    return seen.get(who)?.key ?? "torso";
}

function takeGlyphDice(ctx) {
    const dice = Math.max(0, Number(ctx.declaration?.glyphMagnitudeDice) || 0);
    if (!dice || ctx.control.glyphSpent) return 0;
    ctx.control.glyphSpent = true;
    return dice;
}

export function registerCoreBlocks() {

    /* ── dealDamage ──────────────────────────────────────────────────────
     * `damageType` is NOT the same field as the frame's chaos `element`.
     * Cleansing Fire deals FIRE damage from an ELEMENTLESS invocation, and a
     * priest fumbling it resolves as Mixed — conflating the two silently
     * gives priests fire fumbles. */
    defineBlock({
        id: "core:dealDamage",
        shape: SHAPE.STACK,
        category: "effect",
        label: "deal [formula] [damageType] damage to [location]",
        inputs: {
            formula:      { type: "expression", numeric: true, default: "1d6" },
            /* `physical` was the default and is NOT one of the seven types the
             * system registers (slashing / piercing / bludgeoning / fire /
             * lightning / cold / acid). An unregistered type is not rejected —
             * it simply matches no resistance or vulnerability, so a creature
             * that shrugs off cold took full damage from an "ice" spell and a
             * freshly dropped damage block resisted nothing at all. */
            damageType:   { type: "enum", options: "@damageTypes", default: "bludgeoning" },
            nonLethal:    { type: "boolean", default: false },
            /* How close the caster must be for a CALLED SHOT to be offered on
             * this damage. Point-blank by default: Igni is a 2m cone and you
             * only choose where on somebody it burns if you are on top of them.
             * A spell that can be aimed further says so here. */
            aimWithin:    { type: "expression", numeric: true, default: 1 },
            /* Four RULES, then the six places a hit can land.
             *
             * Each of the four means something now — see `aimedLocation`.
             * "chosen" was a fifth, identical in intent to "aimed" and handled
             * nowhere: it reached the damage pipeline as a literal, matched no
             * location, and became a torso hit. A dropdown word that does
             * nothing is how an author learns to distrust the dropdown.
             *
             * The six body keys are offered alongside them because spells DO
             * name a place — Cadfan's Grasp burns "the limb holding it" — and
             * a value the corpus uses that the canvas cannot produce is the
             * same failure from the other end. They are `ATTACK_LOCATIONS`,
             * the table the whole system shares. */
            location:     { type: "enum",
                            options: ["aimed", "random", "perAttack",
                                      "torso", "head", "leftArm", "rightArm", "leftLeg", "rightLeg"],
                            default: "torso" },
            bypassArmour: { type: "boolean", default: false },
            /* PROVENANCE, and it is not the damage TYPE. Quen "is ineffective
             * against damage caused by already being poisoned, having a
             * disease, or suffocation due to a lack of oxygen" — three states
             * rather than three elements, which is why the exclusion list is
             * its own axis.
             *
             * The cast's record carries the channel of the cast; a single
             * block can differ from it. Suffocate is the case: the SPELL is
             * an ordinary Resist Magic attack, and the damage it inflicts
             * every round afterwards is suffocation. */
            channel:      { type: "enum", options: "@damageChannels", default: null },
            /* CRITICAL WOUNDS. A spell that beats a defence by enough wounds
             * the way a sword does — the severity ladder, the wound item, the
             * Stun save — and none of it was reachable: the payload never
             * carried a severity, so `autoApplyCriticalWound` was dead for
             * every spell in the game. "margin" derives it from how far the
             * cast beat the defence, using the system's own brackets. */
            crit:         { type: "enum", options: ["none", "margin"], default: "none" },
            /* WEAPON QUALITIES, on a spell. The damage pipeline already knows
             * how to make acid rust armour and a serrated edge bleed; magic
             * could not ask for any of it. */
            qualities:    { type: "list", of: "@qualities", default: [] },
            /* Armour comes in layers and a spell may pass one and not another:
             * ignore worn plate but not a monster's hide, or ignore both and
             * still be caught by Quen. `bypassArmour` remains the blunt "all
             * three" switch it always was. */
            bypassWorn:    { type: "boolean", default: false },
            bypassNatural: { type: "boolean", default: false },
            bypassShield:  { type: "boolean", default: false }
        },
        requires: ["targets"],
        emits: ["damageDealt"],
        async run(ctx, a) {
            /* DAMAGE service — Empower's +2d6, Runeword Depletion's rider,
             * Mirror Effect's environmental halving.
             *
             * `bonus` is seeded with the glyph dice the caster chose in the
             * dialog. A matching armour glyph may be spent either as +3 to the
             * roll or as +1d6 to the effect, and the second option reached the
             * legacy engine only: nothing under magic/ had ever read
             * `glyphMagnitudeDice`, so a player who picked "+1d6 to the effect"
             * on an authored spell got nothing at all for their glyph. */
            const d = applyService(SERVICE.DAMAGE, ctx.actor, {
                formula: evaluate(a.formula, ctx.vars),
                bonus: takeGlyphDice(ctx), bonusDie: 6, multiplier: 1
            }, ctx);
            const formula = d.bonus ? `${d.formula}+${d.bonus}d${d.bonusDie}` : d.formula;

            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                /* The victim's own numbers are in scope, so a spell can deal
                 * "as much as they have left" — see `targetVars` in
                 * blocks/effects.mjs for why that had to exist. Re-evaluated
                 * per target, which is the only correct reading when a spell
                 * catches several people. */
                const sys = t.actor?.system ?? {};
                const perTarget = evaluate(formula, {
                    ...ctx.vars,
                    targetHp:    Number(sys.derivedStats?.hp?.value) || 0,
                    targetHpMax: Number(sys.derivedStats?.hp?.max) || 0,
                    targetSta:   Number(sys.derivedStats?.sta?.value) || 0
                });
                let amount = await ctx.adapter.rollFormula(perTarget);
                if (d.multiplier !== 1) amount = Math.floor(amount * d.multiplier);
                const channel = a.channel ?? ctx.record.damageChannel ?? "attack";
                /* THROUGH the interception, not around it. This block used to
                 * call `adapter.applyDamage` directly while the comment below
                 * described a defender's interception tree reading the payload
                 * — a tree that never ran, because `intercept.mjs` had no
                 * caller anywhere in the system. Quen stored a shield and then
                 * absorbed nothing: the flag was written, consulted by no one.
                 *
                 * Order is the reason this wrapper exists rather than a hook
                 * inside the adapter: Quen absorbs BEFORE armour, and only the
                 * overflow "must penetrate your armor and damage resistances
                 * just like any other attack". */
                const locKey = await aimedLocation(ctx, t, a.location);
                /* How hard it landed, in the system's own brackets. */
                let critSeverity = null;
                if (a.crit === "margin") {
                    const margin = Number(ctx.record?.casterRoll) - Number(t.defenceTotal);
                    if (Number.isFinite(margin)) {
                        const { critSeverityFromDelta } = await import("../../combat/critSeverity.mjs");
                        critSeverity = critSeverityFromDelta(margin);
                    }
                }
                const result = await applyDamageWithInterception(t.actor, amount, {
                    damageType: a.damageType,
                    /* Reaches the defender's wards. `absorbDamage.parity` has
                     * a `lethalOnly` setting that reads `incoming.nonLethal`,
                     * and nothing anywhere set that field — so the setting was
                     * a dropdown entry that could never be true. Quen's rule
                     * (lethal and non-lethal deplete the pool equally) is the
                     * default; `lethalOnly` is now actually reachable. */
                    nonLethal: !!a.nonLethal,
                    location: locKey,
                    bypassArmour: !!a.bypassArmour,
                    bypassWorn: !!a.bypassWorn,
                    bypassNatural: !!a.bypassNatural,
                    bypassShield: !!a.bypassShield,
                    qualities: Array.isArray(a.qualities) ? a.qualities : [],
                    critSeverity,
                    channel,
                    /* The payload a defender's interception tree reads. The
                     * cast record is frozen and shared; the channel may be
                     * this block's, so it is carried alongside rather than
                     * written back into history. */
                    record: channel === ctx.record.damageChannel
                        ? ctx.record
                        : { ...ctx.record, damageChannel: channel }
                }, ctx.adapter);
                /* The place is recorded with the hit so the cast card can say
                 * where it landed. A card that reports a number without a
                 * location cannot explain why the number tripled. */
                ctx.created.push({ kind: "damage", target: t.actor, channel, location: locKey,
                                   amount: result?.amount ?? amount,
                                   absorbed: result?.absorbed ?? 0,
                                   /* Read by core:ifPenetratedArmour. null means
                                    * nobody could tell us — see adapter.applyDamage. */
                                   penetrated: result?.penetrated ?? null });
            }
        }
    });

    /* ── applyStatus ─────────────────────────────────────────────────────
     * Routes through the adapter, which MUST relay to the GM for actors the
     * caster does not own — a direct write is silently dropped by Foundry's
     * permission layer.
     *
     * `record` rides along so the effect carries its origin: Holy
     * Fortification re-rolls against the ORIGINAL caster roll, and Dispel
     * prices itself at half the original spend. */
    defineBlock({
        id: "core:applyStatus",
        shape: SHAPE.STACK,
        category: "effect",
        label: "apply [status] until [until]",
        inputs: {
            status: { type: "enum", options: "@statuses" },
            until:  { type: "lifetime", default: "rounds" },
            value:  { type: "expression", numeric: true, default: null }
        },
        requires: ["targets"],
        emits: ["statusApplied"],
        async run(ctx, a) {
            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                const applied = await ctx.adapter.applyStatus(t.actor, a.status, {
                    until: a.until, record: ctx.record
                });
                /* A status the world does not register is DROPPED by the GM
                 * handler. Recording it anyway made the card announce something
                 * that never happened, and left a lifetime waiting to remove an
                 * effect that was never there. `false` is a real answer; an
                 * adapter that returns nothing (a test stub) is taken at its
                 * word so existing stubs keep working. */
                if (applied === false) continue;
                /* The status carries its OWN end condition. The cast may be
                 * Immediate while the burning it started lasts until put out. */
                const life = lifetimeFrom(
                    { endsOn: a.until, value: await rollDuration(a.value, ctx) },
                    { owner: t.actor, kind: `status:${a.status}`, record: ctx.record, source: ctx.item,
                      onExpire: (_e, why) => { ctx.adapter.removeStatus?.(t.actor, a.status);
                                               return runExpiryTree(ctx, why); } }
                );
                /* The status the WORLD received, not the word the author
                 * typed. The alias table maps several authored names onto one
                 * registered id, and the card printed the authored one — so
                 * Eternal Judgement announced "Victim A is whiteFire" while
                 * the victim actually caught ordinary `burning`. A card that
                 * names an effect the world never received is worse than no
                 * card. */
                ctx.created.push({ kind: "status", target: t.actor,
                                   status: resolveStatus(a.status), authored: a.status, life });
            }
        }
    });

    /* ── healHealth ──────────────────────────────────────────────────── */
    defineBlock({
        id: "core:healHealth",
        shape: SHAPE.STACK,
        category: "effect",
        label: "heal [formula] health",
        inputs: { formula: { type: "expression", numeric: true, default: "1d6" } },
        requires: ["targets"],
        emits: ["healed"],
        async run(ctx, a) {
            for (const t of ctx.targets) {
                if (t.hit === false) continue;
                /* Healing is a magnitude too, so a glyph spent on the effect
                 * counts here exactly as it does on damage. */
                const glyph = takeGlyphDice(ctx);
                const healFormula = glyph ? `${evaluate(a.formula, ctx.vars)}+${glyph}d6`
                                          : evaluate(a.formula, ctx.vars);
                const amount = await ctx.adapter.rollFormula(healFormula);
                await ctx.adapter.heal(t.actor, amount, { record: ctx.record });
                ctx.created.push({ kind: "heal", target: t.actor, amount });
            }
        }
    });

    /* ── createShield ────────────────────────────────────────────────────
     * Three archetypes exist in the rules and only the pool is built here:
     * a HP pool (Quen 5/STA, Active Shield 10/STA), a forced attacker check
     * (Gwynt Troelli), and a CHARGE COUNT scaling off skill rather than
     * stamina (Demetia's Crest Surge blocks 2 × Spell Casting water spells).
     * The old `createShield(hpPerSta)` signature hard-coded the first and
     * could not express the third at all.
     *
     * `absorbs` is the filter, and Quen's is the awkward one: it works only
     * against magic that CAN BE BLOCKED — a predicate over the incoming
     * item's own defence entry, not over its damage. */
    defineBlock({
        id: "core:createShield",
        shape: SHAPE.STACK,
        category: "effect",
        label: "shield with [pool] hit points and [charges] charges, absorbing [absorbs]",
        inputs: {
            pool:    { type: "expression", numeric: true, default: "5*{sta}" },
            /* A COUNT, not a pool. Demetia's Crest Surge turns aside "a number
             * of water spells equal to 2 times your Spell Casting skill value"
             * — no hit points anywhere in it. `consumeCharge` was written for
             * exactly this and read `state.charges`, which nothing could set;
             * the ward was unbuildable until authoring the spell surfaced it. */
            charges: { type: "expression", numeric: true, default: null },
            absorbs: { type: "enum", options: ["all", "blockable", "tangible", "none"], default: "all" }
        },
        requires: [],
        emits: ["shield"],
        async run(ctx, a) {
            const hp = evaluate(a.pool, ctx.vars);
            const charges = a.charges == null ? null : evaluate(a.charges, ctx.vars);
            await ctx.adapter.createShield(ctx.actor, {
                hp, charges, absorbs: a.absorbs, record: ctx.record
            });

            /* The shield subscribes EVERY interception tree its own item
             * declares, carrying the pool and charge count as subscription
             * state. This is what makes a shield a second entry point on one
             * item rather than a special case in the damage pipeline.
             *
             * Hardcoding `takeDamage` was wrong and Demetia's Crest Surge is
             * why: it intercepts at the MAGIC stage to negate a whole spell,
             * and never sees the damage step at all. A ward that fires at a
             * different stage is not an exception — it is the same mechanism
             * pointed one step earlier. */
            const state = { pool: hp, charges, absorbs: a.absorbs };
            const handles = [];
            for (const entry of Object.values(ENTRY)) {
                const tree = ctx.trees?.[entry];
                if (!tree) continue;
                handles.push(subscribe({
                    owner: ctx.actor, entry, tree, state,
                    record: ctx.record, source: ctx.item
                }));
            }

            /* A shield that ends fires its item's `onExpire` tree, however it
             * ended — expired, dispelled, or emptied. Active Shield's parting
             * blast must not depend on which. */
            /* BOTH ENDINGS, because the book gives two.
             *
             * Quen holds "for 10 rounds or until the shield is exhausted", and
             * this read `alsoEndsOn` alone — so the printed duration was
             * dropped and a shield nobody hit lasted forever. An array of
             * conditions ends on whichever comes first; the countdown needs a
             * `remaining`, or a clock-scaled condition defaults to Infinity
             * and means "never", which is the trap that made one condition
             * look like the only safe choice. */
            const d = ctx.frame.duration ?? {};
            const timed = ["rounds", "minutes", "hours", "days"].includes(d.kind);
            const endsOn = [d.alsoEndsOn ?? ENDS.POOL_EMPTY, ...(timed ? [d.kind] : [])];
            /* A WARD THAT ENDS HAS TO STOP EXISTING.
             *
             * The lifetime's only teardown was the authored `onExpire` tree, so
             * a ward that ran out of TIME (duration elapsed, upkeep unpaid,
             * dispelled) left both halves of itself behind: the bus
             * subscriptions kept intercepting, and the badge kept sitting on
             * the sheet advertising protection that had lapsed. Only the
             * emptied-pool path cleaned up, because `setShieldPool(0)` deletes
             * the badge on its way past — so the bug was invisible for exactly
             * the ending players notice least.
             *
             * Order matters: the authored tree runs FIRST (Active Shield's
             * parting blast reads the pool it is about to lose), then the ward
             * is dismantled. */
            const life = lifetimeFrom(
                { endsOn, value: timed ? await rollDuration(d.value, ctx) : null },
                { owner: ctx.actor, kind: "shield", record: ctx.record, source: ctx.item,
                  onExpire: async (_e, why) => {
                      try { await runExpiryTree(ctx, why); } catch (_) {}
                      for (const h of handles) { try { unsubscribe(h); } catch (_) {} }
                      try {
                          if (charges != null) {
                              await ctx.adapter?.setWardCharges?.(ctx.actor, 0, { itemId: ctx.item?.id ?? null });
                          } else if (hp > 0) {
                              await ctx.adapter?.setShieldPool?.(ctx.actor, 0);
                          }
                      } catch (_) { /* best-effort — the tree already ran */ }
                  } }
            );

            /* The absorbing block ends the shield with `fireCondition(
             * ctx.state.life, POOL_EMPTY)`, and `ctx.state` is the object
             * above — which had no `life` on it, because the lifetime is only
             * created here, afterwards. So `poolEmpty` never fired: the entry
             * leaked in LIVE forever, and `onExpire` never ran. Active Shield's
             * whole parting blast (2m knockback, 1d6 to everything adjacent)
             * was unreachable, and since `poolEmpty` is that spell's ONLY end
             * condition, nothing else could end it either. */
            state.life = life;

            ctx.created.push({ kind: "shield", target: ctx.actor, hp, charges, life,
                               handle: handles[0] ?? null, handles });
        }
    });

    /* ── createObject ────────────────────────────────────────────────────
     * A conjured thing with its own hit points and its own lifetime. Earthen
     * Pillar is the canonical case: the CAST is `Immediate`, and the pillar
     * "remains until destroyed". Under a single frame duration that reads as
     * errata; with per-effect lifetimes it is simply correct. */
    defineBlock({
        id: "core:createObject",
        shape: SHAPE.STACK,
        category: "effect",
        label: "create [what] with [hp] hit points and [sp] SP, lasting [until]",
        inputs: {
            what:  { type: "string", default: "obstacle" },
            /* NULLABLE, because some of these have no hit points at all.
             * Rhwystr Graig is "30 points of SP" and nothing else; a portal is
             * not a thing you break. The default was "10", so every such spell
             * printed an invented pool at the table, and authoring `null` gave
             * 0 — which read as "destroyed the moment it appears". */
            hp:    { type: "expression", numeric: true, default: null },
            /* SP is NOT hit points. Rhwystr Graig is "a 2m by 3m rock wall
             * with 30 points of SP" — armour that subtracts from every blow,
             * not a pool that drains. Conflating the two makes a wall that a
             * dagger chips down, which is not the spell anyone paid 15 STA
             * for. The two coexist: a thing can have both. */
            sp:    { type: "expression", numeric: true, default: null },
            size:  { type: "string", default: null },
            until: { type: "lifetime", default: "untilDestroyed" },
            value: { type: "expression", numeric: true, default: null },
            blocksMovement: { type: "boolean", default: true }
        },
        requires: [],
        emits: ["object"],
        async run(ctx, a) {
            const hp = a.hp == null || a.hp === "" ? null : evaluate(a.hp, ctx.vars);
            const sp = a.sp == null ? null : evaluate(a.sp, ctx.vars);
            const obj = await ctx.adapter.createObject?.(ctx.actor, {
                what: a.what, hp, sp, size: a.size,
                blocksMovement: !!a.blocksMovement, record: ctx.record
            });
            const life = lifetimeFrom(
                { endsOn: a.until, value: await rollDuration(a.value, ctx),
                  state: { hp } },
                { owner: ctx.actor, kind: `object:${a.what}`, record: ctx.record, source: ctx.item,
                  /* An object that ends runs the spell's expiry tree, like a
                   * shield does. Standing Portal's whole dismemberment clause
                   * — "if you end the portal while something is partially
                   * through, it slices the object in two" — hung off this and
                   * was unreachable, because `runExpiryTree` had exactly one
                   * caller in the engine and it was the shield. */
                  onExpire: (_e, why) => { ctx.adapter.removeObject?.(obj);
                                           return runExpiryTree(ctx, why); } }
            );
            ctx.created.push({ kind: "object", what: a.what, hp, sp, life, ref: obj });
        }
    });

    /* ── ifPercentile ────────────────────────────────────────────────────
     * A flat chance rolled SEPARATELY from the attack. Lightning Storm and
     * Melgar's Fire each roll two in one resolution, so this cannot be
     * folded into the hit check. */
    defineBlock({
        id: "core:ifPercentile",
        shape: SHAPE.GATE,
        category: "gate",
        label: "if [chance]% chance",
        inputs: { chance: { type: "expression", numeric: true, default: "50" } },
        requires: [],
        emits: [],
        async run(ctx, a, { body, runBody }) {
            /* PERCENTILE service — Empower forces 100%, Tempest adds 10%,
             * Winds of the Taiga adds 50% to someone else's attacks. None of
             * that is reachable if the chance stays a literal. */
            const p = applyService(SERVICE.PERCENTILE, ctx.actor,
                { chance: evaluate(a.chance, ctx.vars) }, ctx);
            const chance = Math.round(Number(p.chance) || 0);

            /* ONE ROLL PER PERSON.
             *
             * This rolled once and ran the body over everybody, so "anyone in
             * the area has a 75% chance of being struck" was a single coin
             * flip deciding the fate of the whole crowd: either everyone
             * burned or nobody did. Live, Wave of Fire set both victims
             * alight off one percentile.
             *
             * The book always phrases these per person — "anyone", "a target",
             * "everything caught in the burst" — and a spell that hits four
             * people should produce four rolls and, usually, a mixed result.
             */
            const roll = async () => {
                const verdict = await ctx.adapter.rollPercentile(chance);
                /* Older adapters (and test stubs) answer with a bare boolean. */
                return typeof verdict === "object"
                    ? { passed: verdict.passed, roll: verdict.roll ?? null }
                    : { passed: !!verdict, roll: null };
            };

            /* Everything the body creates carries the odds that let it happen,
             * so the card can say WHY the knockdown landed rather than leaving
             * a guaranteed effect and a lucky one looking identical. */
            const runWithOdds = async (odds) => {
                const before = ctx.created.length;
                await runBody(body);
                for (let i = before; i < ctx.created.length; i++) {
                    if (!ctx.created[i].odds) ctx.created[i].odds = odds;
                }
            };

            const roster = (ctx.targets ?? []).filter(t => t.hit !== false);

            /* No targets at all: the gate is guarding something that is not
             * about people — a zone, a narration, an object. One roll is the
             * whole question. */
            if (!roster.length) {
                const { passed, roll: r } = await roll();
                const odds = { chance, roll: r };
                if (!passed) { ctx.created.push({ kind: "chanceMissed", ...odds }); return; }
                await runWithOdds(odds);
                return;
            }

            const all = ctx.targets;
            try {
                for (const t of roster) {
                    const { passed, roll: r } = await roll();
                    const odds = { chance, roll: r };
                    if (!passed) {
                        /* A miss is worth saying, and worth saying about WHOM.
                         * "Nothing happened" and "a 30% chance came up 74 for
                         * Victim B" read very differently at a table. */
                        ctx.created.push({ kind: "chanceMissed", target: t.actor, ...odds });
                        continue;
                    }
                    ctx.targets = [t];
                    await runWithOdds(odds);
                }
            } finally { ctx.targets = all; }
        }
    });

    /* ── forEachTarget ───────────────────────────────────────────────────
     * Publishes {index}, which is how Alzur's Thunder expresses its per-target
     * falloff — (8-{index})d6 — without a bespoke block. */
    defineBlock({
        id: "core:forEachTarget",
        shape: SHAPE.GATE,
        category: "gate",
        label: "for each target",
        inputs: {},
        requires: ["targets"],
        emits: [],
        async run(ctx, _a, { body, runBody }) {
            const all = ctx.targets;
            /* IN THE ORDER THE SPELL REACHES THEM.
             *
             * `{index}` is how Alzur's Thunder expresses its falloff — the bolt
             * "travels in a straight line through targets, and for every
             * target it passes through the damage to the next decreases by
             * 1d6". That is a statement about DISTANCE, and this iterated in
             * whatever order the template harvest happened to return: live, the
             * victim two metres further away took the full 8d6 and the one
             * standing in front of them took 7d6.
             *
             * Sorted by how far each is from the caster, nearest first. A
             * target that dodged is skipped without consuming an index — the
             * bolt did not pass through them, so it does not weaken. */
            const reach = await Promise.all(all.map(async (t) => ({
                t, d: Number(await ctx.adapter.distanceBetween?.(ctx.actor, t.actor)) || 0
            })));
            reach.sort((a, b) => a.d - b.d);

            let index = 0;
            for (const { t } of reach) {
                if (t.hit === false) continue;
                ctx.targets = [t];
                ctx.vars.index = index++;
                await runBody(body);
            }
            ctx.targets = all;
            ctx.vars.index = 0;
        }
    });
}
