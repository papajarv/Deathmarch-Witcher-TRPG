/**
 * The cast frame — the law layer.
 *
 * Vigor, stamina cost and targeting are NOT blocks an author assembles. They
 * are enforced here, before a single authored block runs, because if an author
 * can omit the Vigor check they can author a spell that ignores Vigor.
 * Composability must not extend to the rules of magic itself.
 *
 * Evidence for where that line falls: three independent decompositions of the
 * 103 core entries each factored the same blocks out of every tree and called
 * it a "prelude". A block appearing in 103 of 103 trees with identical
 * arguments is not a block — it is the law.
 *
 * ── Why every stage is its own exported function ──────────────────────────
 * The spec calls for each law stage to become an interceptable *service* —
 * Empower rewrites another spell's fumble band, a Soul Beacon alters the
 * fumble die, runewords inject damage into spells they never authored. That
 * machinery is NOT built yet. What is built is the seam: eight small named
 * functions rather than one 1300-line procedure (which is what castSpell
 * became). Adding interception later means wrapping these; it does not mean
 * unpicking them. That distinction is the whole reason this file looks the
 * way it does.
 *
 * ── The adapter ───────────────────────────────────────────────────────────
 * Nothing here calls Foundry directly. Every world interaction goes through
 * `ctx.adapter`, which keeps the entire frame exercisable in a plain node
 * test. The live adapter is the only place that knows about documents,
 * sockets and chat.
 *
 * CONSTRAINT the live adapter must honour: applying a status to an actor the
 * caster does not own MUST route through the GM socket, or the write is
 * silently dropped by Foundry's permission layer. See socketHook's
 * emitApplyStatus / handleApplyStatus and its authorisation model.
 */

import { lifetimeFrom, ENDS } from "./lifetimes.mjs";
import { resolveText, evaluate } from "./expression.mjs";
import { SYSTEM_ID } from "./systemId.mjs";
import { OUTCOME, abort, sealRecord, deriveContext } from "./context.mjs";
import { getBlock, SHAPE } from "./registry.mjs";
import { contributorsFor, contributorById } from "./contributors.mjs";
import { applyService, SERVICE } from "./services.mjs";

/* ── VALIDATE ─────────────────────────────────────────────────────────────
 * Eligibility, range, recast locks. Failures here spend NOTHING, which is the
 * whole point — so this runs before PRICE and after TARGETS.
 *
 * It used to run before targets were acquired, which meant the range check
 * looped over an empty list and passed everything. Range was declared on the
 * frame, shown in the panel, and enforced by nothing. Moving it after the aim
 * is what makes it real; keeping it before the spend is what makes it fair. */
export async function validate(ctx) {
    const { adapter, actor, item, frame } = ctx;

    if (frame.targeting.mode !== "self" && frame.range != null) {
        for (const t of ctx.targets) {
            const d = await adapter.distanceBetween(actor, t.actor);
            if (d != null && d > frame.range) {
                return abort(ctx, `${item.name} reaches ${frame.range}m; that target is ${d}m away.`);
            }
        }
    }
    /* `hasActiveInstance` matches on the effect's `magicKind` FLAG — a string
     * like "sign" or "spell" — and this handed it the Item document, so the
     * comparison was `"sign" === Item` and Quen's "you cannot cast it again
     * until the current shield is exhausted" never once triggered. */
    if (frame.recastLock && await adapter.hasActiveInstance(actor, frame.kind ?? item?.type)) {
        return abort(ctx, `${item.name} is already active.`);
    }
    return ctx;
}

/* ── L2 · PRICE ───────────────────────────────────────────────────────────
 * All ledgers, not just stamina. Publishes {sta} into the expression scope —
 * so a formula may only reference it after this stage has run. */
/**
 * The caster's declaration — foci, glyphs, adrenaline, and how much to spend.
 *
 * This is the system's own cast dialog, not a stamina prompt of the engine's
 * own. Building one meant a spell on this engine silently lost the Focus
 * discount, the Greater Focus roll bonus, glyph elements, adrenaline dice and
 * the extra-action penalty — every one a rule somebody had already written,
 * bypassed because the new path asked a simpler question.
 *
 * An adapter that cannot declare falls back to the frame's own prompts, so the
 * engine still runs in a test harness.
 */
export async function declare(ctx) {
    if (ctx.control.aborted) return ctx;
    if (!ctx.adapter.declareCast) return ctx;

    /* Whether the dialog may offer a called shot at all.
     *
     * Answerable only because the template has already landed — the aim comes
     * before the declaration precisely so this question has an answer. A spell
     * that caught nobody, or caught somebody across the room, gets no aiming
     * control rather than one that silently does nothing.
     */
    const { dialogFactsFor } = await import("./dialogFacts.mjs");
    const facts = dialogFactsFor(ctx.item?.system ?? {});
    let reach = null;
    for (const t of ctx.targets) {
        const d = await ctx.adapter.distanceBetween?.(ctx.actor, t.actor);
        if (d == null) continue;
        reach = reach == null ? d : Math.min(reach, d);
    }
    /* The reach is the BLOCK's, not a constant here — a spell that says it can
     * be aimed from further away is taken at its word. */
    ctx.control.aimable = facts.aims && reach != null && reach <= facts.aimWithin;

    const decl = await ctx.adapter.declareCast(ctx.actor, ctx.frame,
                                               { aimable: ctx.control.aimable, reach, facts });
    if (decl === null) return abort(ctx, "Cancelled.");
    ctx.declaration = decl ?? null;

    /* A random location is NOT rolled here. It is rolled by the block that
     * needs one, per victim (`blocks/core.mjs aimedLocation`), because the
     * answer differs per victim and per block: "torso" fixes it, "aimed" takes
     * the called shot below, "random" rolls one place per target and keeps it,
     * and "perAttack" rolls fresh on every hit. Rolling one location here for
     * the whole cast would have made a cone burn five people in the same
     * shoulder. */
    return ctx;
}

export async function price(ctx) {
    if (ctx.control.aborted) return ctx;
    const { adapter, actor, frame } = ctx;

    /* The dialog already asked, and it asked better — it knows the sign cap,
     * the Focus discount and what adrenaline costs on top. */
    const declared = ctx.declaration;

    /* A DERIVED cost is not the dialog's to decide.
     *
     * Dispel costs "half as many Stamina points as the caster spent" — a
     * number that depends on the effect being dispelled and cannot be typed
     * into a box before the target is known. The dialog offers a plain number
     * anyway, and this function returned early the moment it saw one, so the
     * `derived` branch below was unreachable in a live cast: Dispel charged
     * whatever the sheet's flat cost happened to be. Live, it charged 3 where
     * the derived answer was 1.
     *
     * The derived price wins, and the caster is told why. */
    if (frame.cost?.mode === "derived") {
        const half = (n) => Math.ceil(Math.max(0, Number(n) || 0) / 2);
        /* The record of the effect being undone carries what its caster paid. */
        const spent = ctx.dispelTarget?.record?.staSpent
                   ?? ctx.dispelTarget?.record?.sta
                   ?? null;
        const derived = spent != null ? half(spent)
                      /* Nothing to read it off (a hand-made effect, an older
                       * cast): fall back to what the caster offered rather
                       * than refusing a legal cast. */
                      : Number(declared?.staSpend) || 0;
        if (declared && Number(declared.staSpend) !== derived && spent != null) {
            globalThis.ui?.notifications?.info?.(game.i18n.format("WITCHER.Magic.CostDerived",
                { item: ctx.item?.name ?? "", spent, cost: derived }));
        }
        const have = adapter.currentStamina?.(actor) ?? 0;
        if (have < derived) return abort(ctx, game.i18n.format("WITCHER.Magic.NotEnoughSta",
            { item: ctx.item?.name ?? "", cost: derived }));
        await adapter.spendStamina(actor, derived);
        ctx.vars.sta = derived;
        ctx.vars.skill = adapter.skillValue(actor, "spellcast");
        ctx.vars.rank = adapter.skillRank?.(actor, "spellcast") ?? ctx.vars.skill;
        ctx.vars.vigor = adapter.vigorThreshold?.(actor) ?? 0;
        ctx.record.staSpent = derived;
        return ctx;
    }

    if (declared && Number.isFinite(Number(declared.staSpend))) {
        /* The declared spend is CLAMPED to the frame's band.
         *
         * The cast dialog is shared with the original engine and offers a bare
         * number input — `min="0"`, no max — so a variable-cost spell could be
         * cast for nothing, and a sign for more than the 7 the book caps it at.
         * Both are law rather than preference (Core p.115), and law lives here:
         * the frame layer exists precisely so an author cannot opt out of it,
         * and neither should a dialog.
         *
         * Clamped rather than refused: the number came from a person who has
         * already decided to cast, and bouncing them back to re-type it is
         * worse than charging them the legal amount and saying so. */
        const band = frame.cost;
        let spend = Number(declared.staSpend);
        /* A BANDED cost has a floor too — the cheapest rung. The dialog cannot
         * draw a ladder, so it offers a plain number that defaults to 0, and 0
         * buys no band at all: `{band}` never resolves and the status is
         * dropped as an unknown id. Cursed Illness spent nothing and did
         * nothing. Clamped to the rungs, same as a variable cost. */
        const rungs = band?.mode === "banded"
            ? Object.keys(band.bands ?? {}).map(Number).filter(Number.isFinite)
            : [];
        if (band?.mode === "variable" || rungs.length) {
            const min = rungs.length ? Math.min(...rungs) : Math.max(0, Number(band.min) || 0);
            const max = rungs.length ? Math.max(...rungs)
                      : (Number.isFinite(Number(band.max)) ? Number(band.max) : Infinity);
            let held = Math.min(Math.max(spend, min), max);
            /* And a BAND is a ladder, not a range: the book prints 2 / 4 / 6,
             * so paying 3 buys the 2-rung effect. It used to charge the 3 and
             * hand back the 2 — a point burned in silence every time. Snapped
             * down to the rung it actually buys. */
            if (rungs.length) {
                const rung = rungs.filter(r => r <= held).sort((a, b) => b - a)[0];
                if (Number.isFinite(rung)) held = rung;
            }
            if (held !== spend) {
                globalThis.ui?.notifications?.info?.(game.i18n.format("WITCHER.Magic.CostClamped",
                    { asked: spend, spent: held, min, max: max === Infinity ? "—" : max }));
                spend = held;
            }
        }

        const total = spend + (Number(declared.adrenalineStaCost) || 0);
        const available = adapter.currentStamina(actor);
        if (total > available) return abort(ctx, `Not enough Stamina — needs ${total}, has ${available}.`);

        ctx.vars.sta = spend;
        ctx.vars.skill = adapter.skillValue(actor, "spellcast");
        /* The rank alone — see `skillRank`. A spell that scales off "points of
         * Spell Casting" means this one, not the roll total. */
        ctx.vars.rank = adapter.skillRank?.(actor, "spellcast") ?? ctx.vars.skill;
        ctx.vars.vigor = adapter.vigorThreshold(actor);
        ctx.record.staSpent = total;
        /* A glyph can change what element a cast resolves as, which is why the
         * declaration is read here and not only for its number.
         *
         * "none" IS NOT A CHOICE. The cast dialog defaults this field to the
         * string "none" when the item carries no `system.damageElement`
         * (castDialog.mjs: `String(sys.damageElement ?? "none")`), and `||`
         * treats that string as a real answer — so the declaration clobbered
         * the spell's own element and EVERY spell cast through the dialog
         * resolved as element "none".
         *
         * Nothing downstream could then match on element: Demetia's Crest
         * Surge, whose whole rule is "blocks water spells", was handed "none"
         * for a Carys' Hail and let it through. Found by casting one at the
         * other in a live world — the frame said `water`, the record said
         * `none`. */
        const declaredElement = (declared.damageElement && declared.damageElement !== "none")
            ? declared.damageElement : null;
        ctx.record.element = declaredElement
            ?? (frame.element === "inherit" ? adapter.casterElement(actor) : frame.element);
        ctx.record.kind = frame.kind;
        /* A BANDED cost is not only a price — the tier bought IS the effect,
         * and the body names it as `{band}`. The dialog knows the number but
         * nothing told the context which band that number buys, so every
         * banded spell cast through the dialog (which is all of them) applied
         * the literal string "{band}" and had it dropped as an unknown status.
         * Cursed Illness spent the stamina and did nothing at all. */
        if (frame.cost.mode === "banded") {
            ctx.text.band = bandFor(frame.cost.bands, spend);
        }
        return ctx;
    }

    let cost;
    switch (frame.cost.mode) {
        case "fixed":    cost = frame.cost.amount; break;
        case "variable": cost = await adapter.promptStamina(actor, frame.cost); break;
        case "banded":
            cost = await adapter.promptBand(actor, frame.cost.bands);
            /* The band is not just a price. For Cursed Illness and its kin the
             * tier bought IS the effect, so the label has to survive into the
             * body where a status argument can name it as `{band}`. */
            /* The band bought is the HIGHEST one the spend reaches, not an
             * exact key match. Paying 5 into {2,4,6} buys the 4 band; an exact
             * lookup returned null there, `{band}` never resolved, and the
             * literal string "{band}" reached applyStatus — where an
             * unrecognised id is dropped without a word. Cursed Illness spent
             * the stamina and applied nothing. */
            if (cost != null) ctx.text.band = bandFor(frame.cost.bands, cost);
            break;
        case "derived":  cost = frame.cost.resolve(ctx); break;
        default:         cost = 0;
    }
    if (cost == null) return abort(ctx, "Cancelled.");

    /* Focus discount is law, applied automatically where legal — floor of 1,
     * in hand, one at a time, never witchers. The adapter owns legality
     * because it is the thing that can see the caster's gear. */
    cost = await adapter.applyFocusDiscount(actor, cost);

    /* PRICE service — an enchanted amulet forcing its own focus, a Soul
     * Beacon's -3 to necromancy costs, a runeword discount. */
    cost = applyService(SERVICE.PRICE, actor, { cost, frame }, ctx).cost;

    const available = adapter.currentStamina(actor);
    if (cost > available) return abort(ctx, `Not enough Stamina — needs ${cost}, has ${available}.`);

    ctx.vars.sta = cost;
    ctx.vars.skill = adapter.skillValue(actor, "spellcast");
    ctx.vars.rank = adapter.skillRank?.(actor, "spellcast") ?? ctx.vars.skill;
    ctx.vars.vigor = adapter.vigorThreshold(actor);
    ctx.record.staSpent = cost;
    ctx.record.element = frame.element === "inherit" ? adapter.casterElement(actor) : frame.element;
    ctx.text.element = ctx.record.element;
    ctx.record.kind = frame.kind;
    return ctx;
}

/* ── L3 · VIGOR ───────────────────────────────────────────────────────────
 * A per-round running budget across ALL casts, not a per-spell cap. Over
 * budget costs 5 HP per excess point AND queues an elemental fumble roll even
 * on an otherwise clean cast. */
export const OVER_EXERT_HP_PER_POINT = 5;

export async function checkVigor(ctx) {
    if (ctx.control.aborted) return ctx;
    const { adapter, actor } = ctx;

    const budget = adapter.vigorThreshold(actor);
    const spent  = adapter.chaosSpentThisRound(actor);
    const over   = Math.max(0, spent + ctx.vars.sta - Math.max(budget, spent));

    if (over > 0) {
        const hp = over * OVER_EXERT_HP_PER_POINT;
        if (adapter.currentHealth(actor) <= hp) {
            return abort(ctx, `Overexerting by ${over} would cost ${hp} HP, which would kill you.`);
        }
        ctx.control.overExertion = { over, hp };
    }
    await adapter.spendStamina(actor, ctx.vars.sta);
    await adapter.commitChaos(actor, ctx.vars.sta);
    if (ctx.control.overExertion) await adapter.spendHealth(actor, ctx.control.overExertion.hp);
    return ctx;
}

/* ── L4 · ACQUIRE TARGETS ─────────────────────────────────────────────────
 * Blocks may RE-target later (Fire Stream switches targets each round); they
 * may not skip acquisition. */
export async function acquireTargets(ctx) {
    if (ctx.control.aborted) return ctx;
    const { adapter, actor, frame } = ctx;

    if (frame.targeting.mode === "self") {
        ctx.targets = [{ actor, defenceTotal: null, hit: null, margin: null }];
        return ctx;
    }
    /* A POINT is ground, not a creature. Ice Slick freezes a patch of floor;
     * nobody rolls to avoid the floor being frozen, and the Dodge on its stat
     * line is for whoever crosses it afterwards. Letting a point-targeted cast
     * carry creature targets makes it resolve as HIT against bystanders and
     * dispatch the wrong tree — Ice Slick did exactly nothing until this. */
    if (frame.targeting.mode === "point") {
        ctx.targets = [];
        return ctx;
    }
    /* An AREA always aims, even if tokens are already targeted.
     *
     * "Manual selection wins" is right for a spell aimed at a person: you
     * clicked them, you meant them. It is wrong for a shape. Aard's cone
     * decides who it catches, not whoever happened to be selected — and the
     * short-circuit meant that having ANY token targeted silently skipped the
     * template, so the cone never appeared and the spell resolved against the
     * selection instead. */
    const mustAim = frame.targeting.mode === "area";

    if (mustAim || ctx.targets.length === 0) {
        const picked = await adapter.pickTargets(actor, frame.targeting);
        if (picked == null) return abort(ctx, "Cancelled.");
        ctx.targets = picked.map(a => ({ actor: a, defenceTotal: null, hit: null, margin: null }));
    }

    /* HOW MANY IT MAY TOUCH.
     *
     * `targeting.count` has been on every frame in the corpus since it was
     * written — "1 opponent", "a number of people equal to your Spell Casting
     * skill" — and NOTHING read it. A single-target spell aimed at four
     * reticled tokens hit all four, and Healing Rest's printed limit was
     * decoration.
     *
     * `null` means the spell sets no limit (an area catches what it catches).
     * A number, or an expression like `{skill}`, is a cap. Extra targets are
     * dropped with a word rather than silently, because a caster who reticled
     * five people and hit one deserves to know which. */
    const cap = frame.targeting.count;
    if (cap != null && ctx.targets.length > 0) {
        const limit = Math.max(0, Math.floor(Number(evaluate(cap, ctx.vars)) || 0));
        if (limit > 0 && ctx.targets.length > limit) {
            const dropped = ctx.targets.length - limit;
            ctx.targets = ctx.targets.slice(0, limit);
            globalThis.ui?.notifications?.info?.(game.i18n.format("WITCHER.Magic.TargetsCapped",
                { item: ctx.item?.name ?? "", limit, dropped }));
        }
    }
    return ctx;
}

/* ── L5 · ROLL ────────────────────────────────────────────────────────────
 * Optional, and its source is declarable. Lesser Magical Gifts "don't even
 * have to roll a Spell Casting check"; a Power Stone rolls "at a base 10"
 * with no actor behind it at all. */
export async function roll(ctx) {
    if (ctx.control.aborted) return ctx;
    const { adapter, actor, frame } = ctx;

    if (frame.roll.source === "none") { ctx.record.casterRoll = null; return ctx; }

    if (frame.roll.source === "flat") {
        ctx.record.casterRoll = frame.roll.value;
        return ctx;
    }
    const r = await adapter.rollCast(actor, {
        /* Greater Focus, glyph bonuses, the extra-action penalty and whatever
         * else the dialog totalled — all of it already added up. */
        /* null, NOT 0 — the adapter has to tell "the dialog declared a total of
         * zero" from "nobody declared anything", because in the second case it
         * must supply the caster's skill itself. */
        modifier: ctx.declaration ? Number(ctx.declaration.grandMod) || 0 : null,
        adrenalineDice: ctx.declaration?.adrenalineDice ?? 0,
        chips: ctx.declaration?.chips ?? []
    });

    /* ROLL service — Empower's +2, a Place of Power's +2, glyph bonuses. */
    const p = applyService(SERVICE.ROLL, actor,
        { total: r.total, natural: r.natural, fumbleBy: r.fumbleBy ?? 0 }, ctx);

    ctx.record.casterRoll = p.total;
    ctx.control.natural = p.natural;
    ctx.control.fumbleBy = p.fumbleBy;
    return ctx;
}

/**
 * A spell whose element is being suppressed does not land.
 *
 * "Water-based spells can only be cast in the area if the caster's Spell
 * Casting check beats that of the Priest" — a suppression that can be pushed
 * through — and Downpour's fire ban, which cannot. Checked after the roll,
 * because whether it can be pushed through depends on it.
 */
async function suppressed(ctx) {
    const tag = ctx.frame?.element ?? null;
    if (!tag || !ctx.adapter.suppressing) return ctx;
    for (const t of ctx.targets ?? []) {
        const stop = ctx.adapter.suppressing(t.actor, tag, ctx.record?.casterRoll ?? null);
        if (stop) return abort(ctx, game.i18n.format("WITCHER.Magic.SuppressedCast",
            { item: ctx.item?.name ?? "", tag }));
    }
    /* And on the caster themselves — Downpour is cast on yourself and stops
     * the fire spells you would otherwise throw. */
    const own = ctx.adapter.suppressing(ctx.actor, tag, ctx.record?.casterRoll ?? null);
    if (own) return abort(ctx, game.i18n.format("WITCHER.Magic.SuppressedCast",
        { item: ctx.item?.name ?? "", tag }));
    return ctx;
}

/* ── L6 · FUMBLE ──────────────────────────────────────────────────────────
 * CONDITIONAL ON L5 — no roll means no fumble. That ordering matters: with a
 * mandatory L6, a Lesser Gift the book says cannot be rolled could still
 * fumble.
 *
 * Band 1-6 is the one people get wrong: the caster takes damage AND THE SPELL
 * STILL GOES OFF. Only 7-9 fails it.
 *
 * `tradition` selects the table. Necromancy substitutes Restless Spirits for
 * the elemental table wholesale — and so do hexes, in the CORE book (p.168:
 * "This replaces the standard elemental effects and damage from fumbling a
 * form of magic"). This is not a supplement special case. */
export async function resolveFumble(ctx) {
    if (ctx.control.aborted) return ctx;
    if (ctx.record.casterRoll == null) return ctx;          // no roll → no fumble

    /* FUMBLE service — this is the stage the supplement proved cannot be
     * hard-coded. `table` lets a tradition substitute the whole thing
     * (necromancy's Restless Spirits, and hexes in the CORE book); `die`
     * lets an object modify the roll (Soul Beacon's 1d10-2); `by`/`band`
     * let Empower force a result outright. */
    const f = applyService(SERVICE.FUMBLE, ctx.actor, {
        by: ctx.control.fumbleBy ?? 0,
        natural: ctx.control.natural,
        band: null,
        die: "1d10",
        table: ctx.frame.tradition,
        tier: ctx.frame.tier
    }, ctx);

    const by = f.by;
    if (by <= 0 && !ctx.control.overExertion) return ctx;

    if (by > 0) {
        ctx.control.fumbleBand = f.band ?? (by <= 6 ? "1-6" : by <= 9 ? "7-9" : ">9");
        await ctx.adapter.applyFumble(ctx.actor, {
            band: ctx.control.fumbleBand,
            by,
            tradition: f.table,
            tier: f.tier,
            die: f.die,
            element: ctx.record.element
        });
        /* 7-9 and >9 fail the cast. 1-6 does not — it resolves anyway. */
        if (ctx.control.fumbleBand !== "1-6") {
            ctx.control.outcome = OUTCOME.FUMBLE;
            return ctx;
        }
    } else if (ctx.control.overExertion) {
        /* Overexerting forces an elemental effect even without a fumble. */
        await ctx.adapter.applyFumble(ctx.actor, {
            band: "overexert", by: 0,
            tradition: ctx.frame.tradition, tier: ctx.frame.tier, element: ctx.record.element
        });
    }
    return ctx;
}

/* ── L7 · OPPOSE ──────────────────────────────────────────────────────────
 * Per target, per declared defence and tie direction. Publishes {margin}.
 *
 * Tie direction is a real parameter, not a detail: Heliotrope succeeds on
 * "equals or beats" (ties to the DEFENDER) while Dispel requires "beats"
 * (ties to the attacker). One word apart in the book, ten percent of
 * outcomes apart at the table.
 *
 * NOT YET BUILT: contributed defences. The gate is currently assembled only
 * from what the attack declares, so a defence the DEFENDER owns — Heliotrope,
 * Dispel-as-reaction — cannot appear. That matters most for `defence: none`,
 * which the rules define as "cannot be defended against UNLESS Dispel or
 * Heliotrope is used", and which covers 52 of 103 core entries. The seam is
 * here: `gatherDefenceOptions` is where contribution will hook in. */
export function gatherDefenceOptions(ctx, defender) {
    /* You do not defend against your own spell.
     *
     * A self-targeted cast puts the CASTER in the target list, and contributed
     * defences are offered to whoever is being cast at — so the moment a
     * caster happened to know Dispel, Quen and Yrden started asking them
     * whether they wanted to counter themselves. Answering (which any
     * unattended client does) set a defence total, which made the cast
     * "opposed", which resolved it as a HIT instead of a SUCCESS — and every
     * self-buff in the book authors its body under `success`. Yrden left no
     * circle at all.
     *
     * This was invisible until contributed defences started working: while
     * `isWitcher`/`knowsSpell` were missing from the adapter the list was
     * always empty, so the bug had nothing to stand on. */
    if (defender === ctx.actor) return { declared: [], contributed: [], all: [] };

    const declared = ctx.frame.defence.type === "none" ? [] : [ctx.frame.defence.type];
    const contributed = contributorsFor(defender, ctx.record, ctx.adapter);
    return { declared, contributed, all: [...declared, ...contributed.map(c => c.id)] };
}

/**
 * Does the attacker beat this defence total?
 *
 * `ties` names WHO WINS A TIE, and getting it backwards costs ten percent of
 * outcomes. Ordinary attacks and Heliotrope both give ties to the defender
 * (the attacker must roll strictly higher — errata p.164, "not equal to or
 * higher"). Dispel is the exception: the dispeller must "beat" the casting
 * roll, so a tie leaves the original cast standing.
 */
export function attackerWins(attackerRoll, defenceTotal, ties = "defender") {
    return ties === "attacker" ? attackerRoll >= defenceTotal : attackerRoll > defenceTotal;
}

/** Run a contributed defence's tree — it may veto the cast for this target. */
async function runContributorTree(contributor, ctx, defender) {
    const payload = { record: ctx.record, target: defender, vetoed: false };
    const sub = {
        owner: defender, adapter: ctx.adapter, state: {}, record: ctx.record,
        incoming: payload, targets: [{ actor: defender, hit: true }],
        vars: { ...ctx.vars }, control: { aborted: false }, created: [],
        expire: () => {}
    };
    await runBody(contributor.tree, sub);
    return payload;
}

/**
 * Resolve `defence.targetBonusWhen` / `targetBonus` for one defender.
 *
 * Returns 0 unless the frame declares a conditional bonus AND the adjudicator
 * confirms the condition holds. An adapter that does not implement the prompt
 * declines it — silently granting a bonus nobody agreed to would be worse than
 * not offering it.
 */
export async function defenceBonusFor(ctx, defender) {
    const { targetBonusWhen, targetBonus } = ctx.frame.defence;
    if (!targetBonusWhen || !targetBonus) return 0;
    const holds = await ctx.adapter.confirmCondition?.(defender, {
        condition: targetBonusWhen, bonus: targetBonus, record: ctx.record, item: ctx.item
    });
    return holds ? targetBonus : 0;
}

export async function oppose(ctx) {
    if (ctx.control.aborted || ctx.control.outcome === OUTCOME.FUMBLE) return ctx;

    ctx.record.defenceSet = ctx.frame.defence.type === "none" ? [] : [ctx.frame.defence.type];

    /* MAGIC INTERCEPTION, before any of the defence branches below.
     *
     * `offerMagicInterception` existed, was documented as "publishes before the
     * opposed step so a subscriber can veto the cast outright", and had no
     * caller anywhere in the system — so `incomingMagic` was a trigger the
     * canvas offered and nothing could ever fire. Demetia's Crest Surge, which
     * negates a whole spell at the magic stage rather than at the damage step,
     * was inert.
     *
     * It runs per target because a ward belongs to a person: one of three
     * people caught by a cone may negate it for themselves alone. */
    const { offerMagicInterception } = await import("./intercept.mjs");
    for (const t of ctx.targets) {
        const verdict = await offerMagicInterception(t.actor, ctx.record, ctx.adapter);
        if (verdict?.vetoed) { t.hit = false; t.negated = true; t.defenceTotal = null; }
    }
    /* Everyone shielded it off — there is nothing left to oppose. */
    if (ctx.targets.length && ctx.targets.every(t => t.negated)) {
        ctx.control.outcome = OUTCOME.MISS;
        return ctx;
    }

    /* A STATIC DC, contested by nobody. Teleportation is the clean case:
     * "Teleporting requires a DC:15 Spell Casting roll. If you fail the roll,
     * you wind up in a random location 1d6 miles away." There is no defender,
     * so this is not a defence — and the failure is not a MISS with nothing
     * behind it, it is a real outcome with its own tree. The old engine had
     * no way to say this and every DC spell was authored as auto-success. */
    /* `Defense: Creature's WILLx3`, printed on Boiling Blood and Friend to
     * Wild Kind. The opposition is a DERIVED STAT of the target, fixed and
     * known — the beast does not roll, it simply is that hard to sway. Modelled
     * as a defence rather than a DC because it varies per target, which a
     * single frame-level DC cannot express. */
    if (ctx.frame.defence.type === "stat") {
        const { stat, multiplier = 1 } = ctx.frame.defence;
        let anyHit = false;
        for (const t of ctx.targets) {
            const value = (await ctx.adapter.statValue?.(t.actor, stat) ?? 0) * multiplier;
            t.defenceTotal = value;
            t.margin = ctx.record.casterRoll - value;
            t.hit = attackerWins(ctx.record.casterRoll, value, ctx.frame.defence.ties ?? "defender");
            if (t.hit) anyHit = true;
        }
        ctx.vars.margin = Math.max(0, ...ctx.targets.map(t => t.margin ?? 0));
        ctx.control.outcome = anyHit ? OUTCOME.HIT : OUTCOME.MISS;
        return ctx;
    }

    if (ctx.frame.defence.type === "dc") {
        /* `Defense: DC set by the GM` is printed verbatim on Control Water,
         * and it is not a shrug — the difficulty of turning a river depends on
         * the river. A literal DC covers Teleportation's 15; this covers the
         * other phrasing, and the two are the same mechanism with the number
         * arriving from a different place. */
        const dc = ctx.frame.defence.dc === "gm"
            ? await ctx.adapter.askDC?.(ctx.actor, { item: ctx.item, record: ctx.record }) ?? 15
            : ctx.frame.defence.dc;
        const beat = ctx.record.casterRoll >= dc;
        for (const t of ctx.targets) { t.hit = beat; t.margin = ctx.record.casterRoll - dc; }
        ctx.vars.margin = Math.max(0, ctx.record.casterRoll - dc);
        ctx.control.outcome = beat ? OUTCOME.SUCCESS : OUTCOME.MISS;
        return ctx;
    }

    let anyHit = false;
    for (const t of ctx.targets) {
        const { declared, contributed, all } = gatherDefenceOptions(ctx, t.actor);

        /* Truly nothing available — not even a contributed option. Only then
         * is the cast unopposed. `Defense: None` alone is NOT enough: the
         * rules define it as defendable by Dispel or Heliotrope, and a
         * witcher standing there has one of those. */
        if (all.length === 0) { t.hit = true; anyHit = true; continue; }

        /* A conditional bonus the DEFENDER gets, declared by the attacking
         * frame. Mental Command: "if the command is something the target would
         * never do, they get a +5 to their Resist Magic check." Authoring that
         * spell is what found this — the frame was accepting the two keys and
         * reading neither, so the bonus vanished.
         *
         * The condition is a judgement ("would never do"), so it is ASKED, not
         * computed. The adapter surfaces it to whoever is adjudicating; the
         * arithmetic stays here, because a defence bonus is law. */
        const bonus = await defenceBonusFor(ctx, t.actor);

        const choice = await ctx.adapter.requestDefence(t.actor, {
            options: all, declared, contributed: contributed.map(c => ({ id: c.id, label: c.label, cost: c.cost(ctx.record) })),
            attackerRoll: ctx.record.casterRoll, record: ctx.record, bonus
        });

        const picked = choice?.option ? contributorById(choice.option) : null;

        if (picked) {
            /* A contributed defence charges its OWN cost — for Heliotrope and
             * Dispel that is half the attacker's spend, which is why the
             * caster's expenditure has to survive into this step. */
            const cost = picked.cost(ctx.record);
            await ctx.adapter.spendStamina(t.actor, cost);
            const rolled = (choice.total ?? await ctx.adapter.rollDefenceSkill?.(t.actor, picked.skill) ?? 0) + bonus;

            t.defenceTotal = rolled;
            t.margin = ctx.record.casterRoll - rolled;
            t.hit = attackerWins(ctx.record.casterRoll, rolled, picked.ties);
            t.defendedWith = picked.id;
            t.defenceFumbled = !!choice?.fumbled;

            if (!t.hit) {
                const out = await runContributorTree(picked, ctx, t.actor);
                t.negated = !!out.vetoed;
            }
        } else {
            t.defenceTotal = (choice?.total ?? 10) + bonus;   // no response → static 10
            /* The DEFENDER's botch. Collected here and previously discarded;
             * Eilhart's Technique is the rule that needs it. */
            t.defenceFumbled = !!choice?.fumbled;
            t.margin = ctx.record.casterRoll - t.defenceTotal;
            t.hit = attackerWins(ctx.record.casterRoll, t.defenceTotal, ctx.frame.defence.ties);
        }
        if (t.hit) anyHit = true;
    }

    ctx.vars.margin = Math.max(0, ...ctx.targets.map(t => t.margin ?? 0));
    /* SUCCESS only when nothing was ever opposed. If a defence was offered and
     * beaten, that is a HIT; if every target turned it aside, a MISS. */
    const opposed = ctx.targets.some(t => t.defenceTotal != null);
    ctx.control.outcome = !opposed ? OUTCOME.SUCCESS : anyHit ? OUTCOME.HIT : OUTCOME.MISS;
    return ctx;
}

/* ── L8 · DISPATCH ────────────────────────────────────────────────────────
 * Hand off to the authored trees. The record is sealed first so nothing
 * downstream can rewrite history a later Dispel or Holy Fortification will
 * need to read. */
/**
 * Who a tree is ABOUT, per outcome.
 *
 * Thirteen effect blocks skip a target whose `hit` is false, which is right for
 * a HIT tree — you do not burn somebody who dodged. It is exactly wrong for a
 * MISS tree, where the targets that missed are the entire point: every block
 * under `miss` skipped every target, so the trigger ran and could never do
 * anything. "When they defend successfully" was decoration.
 *
 * Narrowing here rather than teaching thirteen blocks about outcomes keeps the
 * question where it belongs: the frame decides who a tree concerns, and a block
 * only ever acts on the targets it is handed.
 */
const SCOPE_FOR = Object.freeze({
    [OUTCOME.HIT]:  (t) => t.hit !== false,
    [OUTCOME.MISS]: (t) => t.hit === false
});

/**
 * "The cast worked" is one idea with two names, and which one applies is not
 * the author's choice — it is the SPELL'S DEFENCE FIELD.
 *
 * A spell nobody can defend against resolves to `success`; a spell that is
 * opposed resolves to `hit`. An author who files their effects under the other
 * word gets a spell that costs stamina, rolls, announces itself and does
 * nothing, with no error anywhere. I walked into it twice writing test
 * fixtures, which is the clearest possible sign a GM will.
 *
 * So each falls back to the other when the exact tree is absent. A spell that
 * declares BOTH keeps them separate — the exact match always wins, so nothing
 * runs twice.
 *
 * `miss` and `fumble` have no partner: they mean specific things, and a
 * fallback would invent behaviour the author did not write.
 */
const SAME_MEANING = Object.freeze({
    [OUTCOME.HIT]:     OUTCOME.SUCCESS,
    [OUTCOME.SUCCESS]: OUTCOME.HIT
});

export async function dispatch(ctx, trees) {
    if (ctx.control.aborted) return ctx;
    sealRecord(ctx);

    const tree = trees?.[ctx.control.outcome]
              ?? trees?.[SAME_MEANING[ctx.control.outcome]];
    if (tree) {
        const pick = SCOPE_FOR[ctx.control.outcome];
        const all = ctx.targets;
        if (pick) {
            /* `hit: true` on the narrowed copies is not a claim that the spell
             * hit them — it is the blocks' own "act on this one" flag, and
             * inside this tree these are the ones to act on. The roll's real
             * verdict is preserved on `all`, which is restored below. */
            ctx.targets = all.filter(pick).map(t => ({ ...t, hit: true }));
        }
        try { await runBody(tree, ctx); }
        finally { ctx.targets = all; }
    }

    await openUpkeep(ctx);
    return ctx;
}

/**
 * Run an item's `onExpire` tree when one of its effects ends.
 *
 * Kept out of the blocks deliberately: an effect that fires something on its
 * way out must do so whether it ended by expiry, by being dispelled, or by
 * having its pool emptied — and an author choosing which of those to handle
 * would get it wrong. Blocks that create persistent effects pass this as the
 * lifetime's `onExpire`.
 */
export async function runExpiryTree(ctx, why) {
    const tree = ctx.trees?.onExpire;
    if (!tree) return null;
    /* ONCE PER CAST, whatever ends it.
     *
     * "When the shield is expended OR dropped" is one ending with two causes,
     * and a spell can hold several lifetimes that each want to announce it:
     * Active Shield's blast hung off both the shield's `poolEmpty` and the
     * upkeep's `upkeepUnpaid`, so an emptied shield that was later dropped
     * knocked the room back and dealt its 1d6 twice. Standing Portal narrated
     * its dismemberment twice for the same reason.
     *
     * The flag lives on `control`, which is the cast's own scratch space —
     * the same place the once-per-cast glyph spend is remembered. */
    if (ctx.control.expiryRun) return null;
    ctx.control.expiryRun = why || true;
    const spent = deriveContext(ctx, { targets: [] });
    spent.control.endedBy = why;
    await runBody(tree, spent);
    return spent;
}

/**
 * `Duration: Active (2 STA)` — a MAINTAINED spell.
 *
 * Twenty-odd core entries carry this and it is pure law, not behaviour:
 * "every round the mage must spend an amount of STA equal to the value next to
 * active. The mage must focus on maintaining this spell and CANNOT CAST OTHER
 * SPELLS while they are maintaining an active spell."
 *
 * Both halves matter, and the second is the one that gets forgotten — a
 * maintained spell is a standing restriction on its own caster, which is why
 * the lock lives here rather than in any block an author could omit. The
 * lifetime ends the moment the upkeep goes unpaid.
 */
export async function openUpkeep(ctx) {
    const d = ctx.frame.duration;
    if (d?.kind !== "active") return null;

    const per = d.upkeep === "half" ? Math.ceil(ctx.vars.sta / 2)
              : d.upkeep === "initial" ? ctx.vars.sta
              : Number(d.upkeep ?? 0);

    const life = lifetimeFrom(
        { endsOn: ENDS.UPKEEP_UNPAID, state: { perRound: per } },
        { owner: ctx.actor, kind: `upkeep:${ctx.item?.name ?? "spell"}`,
          record: ctx.record, source: ctx.item,
          onExpire: (_e, why) => {
              ctx.adapter.releaseConcentration?.(ctx.actor, ctx.item);
              /* A maintained spell that lapses takes its per-round clocks with
               * it — a dropped Hailstorm kept falling on the same square for
               * the rest of the session — and then runs the spell's own expiry
               * tree, which is where Active Shield's parting blast lives. */
              ctx.adapter.cancelClocks?.(ctx.actor);
              return runExpiryTree(ctx, why);
          } }
    );
    await ctx.adapter.beginConcentration?.(ctx.actor, {
        perRound: per, item: ctx.item, record: ctx.record, lifetime: life
    });
    ctx.created.push({ kind: "upkeep", perRound: per, life });
    return life;
}

/**
 * Interpolate `{name}` into every STRING-typed argument, once, here.
 *
 * The alternative is every block that takes a name remembering to call
 * `resolveText` — which is exactly the shape of bug the old engine shipped:
 * four consumers of one field, three of them substituting and the fourth not.
 * Numeric slots are left alone; `evaluate` owns those, and the two scopes are
 * deliberately separate.
 */
function resolveArgs(def, a, ctx) {
    let out = null;

    /* THE REGISTRY'S DEFAULTS ARE APPLIED HERE, and until this existed they
     * were applied nowhere: an argument the author left out arrived at `run()`
     * as `undefined`, and every block that did not personally guard threw or
     * did nothing. `core:rerollAgainstStanding` is the one that surfaced it —
     * it hands `a.kinds` to `kinds.includes(...)`, and a spell that did not
     * spell out all four kinds crashed the entire cast.
     *
     * A default declared next to the input, in the same object the canvas
     * renders from, is the only place an author can see it. Applying it only
     * when the canvas happens to write the field means the default is a
     * property of the EDITOR rather than of the block. */
    for (const [key, spec] of Object.entries(def.inputs ?? {})) {
        if (!("default" in spec)) continue;
        if (a[key] === undefined) (out ??= { ...a })[key] = spec.default;
    }
    a = out ?? a;

    for (const [key, spec] of Object.entries(def.inputs ?? {})) {
        if (typeof a[key] !== "string") continue;
        /* String slots, and enums whose vocabulary comes from the world at
         * runtime (`options: "@statuses"`). A FIXED enum is a closed list, so
         * `{band}` in one is an authoring error, not an interpolation. */
        const dynamic = spec.type === "enum" && typeof spec.options === "string";
        if (spec.type !== "string" && !dynamic) continue;
        /* Names first, numbers behind them. A slot naming `{band}` wants the
         * label; one naming `{sta}` wants the number that was actually paid,
         * and there is no reason a sentence should be barred from saying it. */
        const resolved = resolveText(a[key], { ...ctx.vars, ...ctx.text });
        if (resolved !== a[key]) (out ??= { ...a })[key] = resolved;

        /* A placeholder that did not resolve is a FAILURE, not a value. Passed
         * on, `"{band}"` becomes an unknown status id and is dropped in
         * silence three layers down. Say it here, where the block and the key
         * are still known. */
        /* Names the BLOCK will supply itself, later. `core:narrate` carries a
         * `values` map precisely so a sentence can say `{cap}` and have it
         * filled from `5*{skill}` at render time — those are not unresolved,
         * they are deferred, and warning about them cries wolf on ~50 spells. */
        const ownNames = a.values && typeof a.values === "object" ? Object.keys(a.values) : [];
        const stillOpen = [...String(resolved).matchAll(/\{([a-zA-Z][\w.]*)\}/g)]
            .map(m => m[1])
            .filter(n => !ownNames.includes(n));
        if (stillOpen.length) {
            console.warn(`${SYSTEM_ID} | ${def.id}.${key} still reads ${
                JSON.stringify(resolved)} — nothing supplies ${stillOpen.join(", ")}, so this argument does nothing`);
            ctx.control.unresolved = [...(ctx.control.unresolved ?? []), `${def.id}.${key}`];
        }
    }
    return out ?? a;
}


/**
 * Which band a spend buys: the largest threshold it reaches.
 *
 * `{ 2: "staggered", 4: "stunned", 6: "poisoned" }` is a ladder, not a lookup
 * table — the printed rule is "spend 2 for staggered, 4 for stunned, 6 for
 * poisoned", and paying 5 plainly buys stunned.
 */
export function bandFor(bands = {}, spend = 0) {
    let best = null, bestKey = -Infinity;
    for (const [k, label] of Object.entries(bands)) {
        const at = Number(k);
        if (Number.isFinite(at) && at <= spend && at > bestKey) { bestKey = at; best = label; }
    }
    return best;
}

/** Walk an authored body. Gates own their children and decide how often. */
export async function runBody(body, ctx) {
    for (const node of body ?? []) {
        if (ctx.control.aborted) return ctx;
        const def = getBlock(node.b);
        if (!def) { console.warn(`magic | unknown block ${node.b}`); continue; }
        await def.run(ctx, resolveArgs(def, node.a ?? {}, ctx), {
            body: node.body ?? null,
            runBody: (b) => runBody(b, ctx),
            /* Handed to DEFERRED blocks. Turns a captured tree into something
             * the adapter can call later without knowing what a block is —
             * a zone hands this to whoever steps into it, a clock calls it on
             * a tick. The derived context carries the sealed record forward
             * but not the caster's live target list. */
            deferBody: (b) => (over = {}) => runBody(b, deriveContext(ctx, over))
        });
    }
    return ctx;
}

/* ── The runner ───────────────────────────────────────────────────────────
 * The stages in order. Each checks `aborted` itself and unwinds, so a failure
 * anywhere stops the rest without a cascade of guards at the call site. */
export const STAGES = Object.freeze([
    /* AIM FIRST, then declare.
     *
     * You point the spell, and only then does the dialog open to ask how much
     * you are pouring into it. That ordering is not cosmetic: until the
     * template has landed nobody knows who is caught or how far away they are,
     * and the dialog needs both — a called shot is only offered when there is
     * someone close enough to call it on.
     *
     * The dialog still gates everything after it: cancelling there aborts
     * before a single point of Stamina is spent, exactly as before. What
     * changed is that the aim is now a question you answer before committing
     * rather than after.
     *
     * Targets also stay before VALIDATE (which checks range against them) and
     * both stay before PRICE. You aim, you declare, it checks whether that was
     * legal, and only then are you charged. */
    ["L0 targets",   acquireTargets],
    ["L1 declare",   declare],
    ["L2 validate",  validate],
    ["L3 price",     price],
    ["L4 vigor",     checkVigor],
    ["L5 roll",      roll],
    /* Whether a suppression stops this cast depends on the roll it might be
     * pushed through with, so it is asked here and not at validate. */
    ["L5b suppressed", suppressed],
    ["L6 fumble",    resolveFumble],
    ["L7 oppose",    oppose]
]);

export async function castFrame(ctx, trees) {
    ctx.trees = trees ?? ctx.trees ?? {};
    for (const [, stage] of STAGES) {
        await stage(ctx);
        if (ctx.control.aborted) return abortDispatch(ctx, trees);
    }
    return dispatch(ctx, trees);
}

/**
 * A cast that did not happen can still have something to say.
 *
 * `aborted` was offered as a trigger in the canvas and could never fire: both
 * `castFrame` and `dispatch` return on `control.aborted` before any tree is
 * looked up, so an authored `aborted` body was unreachable by construction.
 *
 * The tree runs with the caster and nothing else — there are no targets,
 * because aborting is exactly what happens when there were none, or when the
 * cost could not be paid.
 */
async function abortDispatch(ctx, trees) {
    const tree = trees?.[OUTCOME.ABORTED] ?? ctx.trees?.[OUTCOME.ABORTED];
    if (!tree?.length) return ctx;
    /* Its own control block: the abort must survive the tree, and a block
     * inside it must not be skipped by the very flag that summoned it. */
    const saved = ctx.control.aborted;
    ctx.control.aborted = false;
    try { await runBody(tree, ctx); }
    finally { ctx.control.aborted = saved; }
    return ctx;
}
