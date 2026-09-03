/**
 * The cast entry point — where an item, an actor and the frame meet.
 *
 * Deliberately small. Everything hard already happened: the frame owns the
 * order of operations, the adapter owns Foundry, the blocks own behaviour.
 * This builds the context, runs the frame, and posts the card.
 *
 * It returns the same `{ item, fullRound }` shape `castSpell` has always
 * returned, because four call sites depend on it and none of them should have
 * to know which engine ran.
 */

import { makeContext, OUTCOME } from "./context.mjs";
import { castFrame } from "./frame.mjs";
import { validateSpell } from "./registry.mjs";
import { foundryAdapter } from "./adapter.mjs";
import { frameFor } from "./legacyFrame.mjs";

import { SYSTEM_ID } from "./systemId.mjs";

/**
 * Cast an item that carries authored trees.
 *
 * `forceTarget` comes from the dock's tile-targeting overlay — an explicit
 * single target that bypasses `game.user.targets`, so a ranged spell does not
 * have to leave a target-lock chevron on its victim.
 */
export async function castAuthored(actor, item, { forceTarget = null } = {}) {
    const trees = item.system?.magic?.on ?? {};
    /* Filled by `postShell` below; read by `adapter.applyDamage`. */
    const card = { uuid: null, id: null };

    /* Refuse a broken spell BEFORE spending anything.
     *
     * The canvas will not let an author build one, but an item can arrive from
     * a compendium, a module, or a version of the engine with a block this one
     * does not have. Failing here costs nothing; failing halfway through costs
     * the stamina and leaves half the effects standing. */
    const problems = validateSpell({ name: item.name, on: trees });
    if (problems.length) {
        globalThis.ui?.notifications?.error(game.i18n.format("WITCHER.Magic.Broken",
                                                 { name: item.name, problem: problems[0] }));
        console.warn(`${SYSTEM_ID} | ${item.name} refused to cast`, problems);
        return null;
    }

    const targets = forceTarget ? [forceTarget]
                                : [...(game.user?.targets ?? [])].map(t => t.actor).filter(Boolean);

    const ctx = makeContext({
        actor, item,
        /* Derived from the spell's own fields — cost, range, defence, school,
         * tier and duration have been on this sheet for years and ARE the
         * frame. Anything the author edited in the canvas wins. */
        frame: frameFor(item.system),
        /* The card handle is filled in a few lines below, BEFORE the blocks
         * run, so every `emitApplyDamage` this cast makes can name the message
         * its breakdown belongs in. A mutable holder rather than a value
         * because the adapter is built before the message exists. */
        adapter: foundryAdapter(actor, { item, card }),
        targets,
        trees
    });

    /* "You must cast the spell again to change back."
     *
     * Anything this item left standing on this caster that ends `untilRecast`
     * ends HERE, before the new cast resolves — otherwise casting Polymorphism
     * a second time applied a second polymorph and the first never lifted. */
    const { endOnRecast } = await import("./lifetimes.mjs");
    endOnRecast(actor, item?.uuid ?? null);

    /* Dispel prices itself at half the ORIGINAL caster's spend, so it needs to
     * know what it is aimed at before the cost stage runs. */
    if (ctx.frame.cost?.mode === "derived") ctx.dispelTarget = await pickDispelTarget(targets);

    /* THE CARD IS POSTED FIRST, and finished afterwards.
     *
     * A weapon's damage breakdown folds into its attack card because the card
     * already exists when the damage button is clicked. A spell's did not: the
     * card was posted AFTER the blocks ran, so every hit had nowhere to attach
     * and `handleApplyDamage` took its "no attack message" branch — posting a
     * separate breakdown message, spoken by the victim, for each application.
     * A three-spike spell produced three of them, none of which said what
     * spell they came from, all of them ahead of the cast card in the log.
     *
     * Posting a shell first gives the breakdowns their home; `finishCard`
     * then splices the narrative into the shell WITHOUT touching anything
     * appended to it in the meantime. */
    const shell = await postShell(actor, item, ctx);
    card.uuid = shell?.uuid ?? null;
    card.id = shell?.id ?? null;

    await castFrame(ctx, trees);

    if (ctx.control.aborted) {
        /* Nothing happened, so nothing should be left saying it did. */
        try { await shell?.delete(); } catch (_) {}
        if (ctx.control.abortReason) globalThis.ui?.notifications?.warn(ctx.control.abortReason);
        return null;
    }

    await finishCard(actor, item, ctx, shell);

    return { item, fullRound: (item.system?.castingTime ?? 1) > 1 };
}

/** Which standing effect this Dispel is aimed at. */
async function pickDispelTarget(targets) {
    const standing = targets.flatMap(t => (t.effects ?? [])
        .filter(e => e.getFlag(SYSTEM_ID, "record"))
        .map(e => ({ id: e.id, effect: e, actor: t, record: e.getFlag(SYSTEM_ID, "record") })));

    if (!standing.length) return null;
    if (standing.length === 1) return standing[0];

    const { DialogV2 } = foundry.applications.api;
    const chosen = await DialogV2.prompt({
        window: { title: game.i18n.localize("WITCHER.Magic.WhichEffect") },
        content: `<select name="e">${standing.map(s =>
            `<option value="${s.id}">${s.effect.name} — ${s.actor.name}</option>`).join("")}</select>`,
        ok: { callback: (_e, b) => b.form.elements.e.value }
    }).catch(() => null);
    return standing.find(s => s.id === chosen) ?? null;
}

/**
 * The cast card — the system's own, not one of the engine's.
 *
 * Everything this system offers around a cast finds its data through
 * `flags[SYSTEM].castContext` and the `category: "combat"` envelope the attack
 * flow shares: the Roll Damage button, the per-target verdict blocks, the zone
 * hooks, the rider handlers, the crit lookups.
 *
 * The engine used to post a tidy card of its own instead, which meant a spell
 * resolved correctly and then offered nothing — no buttons, no linkage, no
 * follow-up. The blocks had done their work and the rest of the system could
 * not see that a cast had happened.
 */
/**
 * The empty card, posted before the blocks run.
 *
 * It exists so damage has a message to fold its breakdown into — see the note
 * at the call site. Deliberately minimal: everything it will say depends on
 * what the cast does, and none of that has happened yet.
 */
async function postShell(actor, item, ctx) {
    const esc = (v) => foundry.utils.escapeHTML?.(String(v ?? "")) ?? String(v ?? "");
    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: item.name,
        content: `<div class="witcher-cast-card" data-cast-shell="${esc(ctx.record?.castId ?? "")}">`
               + `<div class="witcher-cast-outcome">${esc(game.i18n.format("WITCHER.Magic.Casting",
                     { name: item.name }))}</div></div>`,
        flags: { [SYSTEM_ID]: { category: "combat" } }
    }).catch((err) => {
        console.warn(`${SYSTEM_ID} | could not post the cast card`, err);
        return null;
    });
}

/**
 * Fill the shell in, preserving everything appended to it while the cast ran.
 *
 * The damage handler wraps a card in `<details class="wdm-attack-card">` the
 * first time it appends to one, and tracks its summary chips in a data
 * attribute. Overwriting `content` here would throw all of that away — the
 * breakdowns, the SP chips, the "Quen soaked 5" line — so only the shell DIV
 * is replaced, in place, wherever it now sits.
 */
async function finishCard(actor, item, ctx, shell) {
    const html = await castCardHtml(actor, item, ctx);
    if (!shell) {
        /* No shell (the post failed): the card still gets posted, just without
         * the folded-in breakdowns. */
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
                                   flavor: item.name, ...html });
        return;
    }
    const holder = document.createElement("div");
    holder.innerHTML = String(shell.content ?? "");
    const slot = holder.querySelector(`[data-cast-shell]`);
    if (slot) slot.outerHTML = html.content;
    else holder.insertAdjacentHTML("afterbegin", html.content);
    try {
        await shell.update({ content: holder.innerHTML, flags: html.flags });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | could not finish the cast card`, err);
    }
}

async function castCardHtml(actor, item, ctx) {
    const { buildCastFlags, castVerdict } = await import("./legacyCard.mjs");
    const engagementId = `cast-${item.id ?? "x"}-${foundry.utils.randomID(8)}`;
    const total = ctx.record.casterRoll ?? 0;
    const verdict = castVerdict(ctx);

    const flags = buildCastFlags(ctx, {
        item, actor, total,
        fumble: ctx.control.outcome === OUTCOME.FUMBLE,
        engagementId,
        systemId: SYSTEM_ID
    });
    /* The aggregate the damage button gates on. */
    flags[SYSTEM_ID].castVerdict = verdict;
    flags[SYSTEM_ID].defenseTotal = ctx.targets.find(t => t.defenceTotal != null)?.defenceTotal ?? null;

    const lines = summarise(ctx);
    /* Anything this cast leaves standing that only a person can end gets the
     * control right here, on the card that announced it. */
    const { needsGmEnding, endingButton } = await import("./standing.mjs");
    const endBtn = needsGmEnding(ctx.created) ? endingButton(ctx.record?.castId ?? null) : "";
    const esc = (v) => foundry.utils.escapeHTML?.(String(v ?? "")) ?? String(v ?? "");

    /* HIT LOCATION — the same block, classes and bullseye the weapon card uses
     * (`attackRollFlavor`). A spell that goes for the head and a sword that
     * goes for the head are the same fact, and reading as two different kinds
     * of card is what made spell results feel bolted on.
     *
     * Built from the damage that ACTUALLY LANDED, not from the declaration.
     * The declaration says what the caster asked for — including the word
     * "Random (humanoid)", which is a request, not a result — and a spell that
     * deals no damage at all has no location to report. So a knockback card
     * read "Hit location: Random (humanoid)" under a spell that never struck
     * anybody anywhere. Each victim gets their own line, because `random`
     * rolls once per victim and a cone does not burn five people in the same
     * shoulder. */
    const { ATTACK_LOCATIONS } = await import("../setup/config.mjs");
    const landed = [];
    for (const c of ctx.created) {
        if (c.kind !== "damage" || !c.location) continue;
        const def = ATTACK_LOCATIONS[c.location];
        if (!def) continue;
        const label = game.i18n.localize(def.labelKey ?? c.location);
        const line = { who: c.target?.name ?? "", label, mult: def.mult ?? 1 };
        if (!landed.some(l => l.who === line.who && l.label === line.label)) landed.push(line);
    }
    const locRow = (l, withWho) =>
        `<div class="wdm-attack-hit-loc"><i class="fa-solid fa-bullseye"></i>` +
            `<span class="wdm-attack-hit-loc-k">${esc(withWho ? l.who
                : game.i18n.localize("WITCHER.Attack.Location"))}</span>` +
            `<span class="wdm-attack-hit-loc-v">${esc(l.label)}</span>` +
            (l.mult !== 1 ? `<span class="wdm-attack-hit-loc-mult">× ${esc(l.mult)} dmg</span>` : "") +
        `</div>`;
    const hitLocHtml = landed.length
        ? landed.map(l => locRow(l, landed.length > 1)).join("")
        : "";

    /* WHAT IT WAS ROLLED AGAINST. The weapon card shows the defence it beat;
     * the cast card showed only its own total, so "It lands" carried no sense
     * of by how much. */
    const opposed = ctx.targets.filter(t => t.defenceTotal != null);
    const defenceHtml = opposed.length
        ? `<div class="wdm-attack-note"><i class="fa-solid fa-shield-halved"></i> ${
            opposed.map(t => esc(game.i18n.format("WITCHER.Magic.DefendedWith", {
                target: t.actor?.name ?? "",
                defence: game.i18n.localize(`WITCHER.Defense.${ctx.frame.defence?.type ?? "none"}`),
                total: t.defenceTotal
            }))).join("<br>")}</div>`
        : "";

    /* Returned rather than posted: the shell is already in the log, and
     * `finishCard` splices this into it. */
    return {
        content: `
            <div class="witcher-cast-card" data-outcome="${ctx.control.outcome}">
                <div class="witcher-cast-cost">${game.i18n.format("WITCHER.Magic.Spent", { sta: ctx.vars.sta })}</div>
                ${total ? `<div class="witcher-cast-roll">${game.i18n.localize("WITCHER.Magic.Roll")}: <b>${total}</b></div>` : ""}
                <div class="witcher-cast-outcome">${game.i18n.localize(`WITCHER.Magic.Outcome.${ctx.control.outcome}`)}</div>
                ${hitLocHtml}
                ${defenceHtml}
                ${lines.length ? `<ul class="witcher-cast-did">${lines.map(l => `<li>${l}</li>`).join("")}</ul>` : ""}
                ${endBtn}
            </div>`,
        flags
    };
}

/** What actually happened, one line each. */
function summarise(ctx) {
    const t = (key, data) => game.i18n.format(`WITCHER.Magic.Did.${key}`, data);
    /* What a chance-gated line says about itself. `roll` is null when the odds
     * were 0 or 100 and nothing was rolled — saying "100%" is still worth it,
     * because it tells a reader the effect was certain rather than lucky. */
    const odds = (c) => !c.odds ? ""
        : c.odds.roll == null
            ? t("oddsCertain", { chance: c.odds.chance })
            : t("odds", { chance: c.odds.chance, roll: c.odds.roll });
    const out = [];
    for (const c of ctx.created) {
        const push = (line) => out.push(line + odds(c));
        switch (c.kind) {
            case "damage":    push(t("damage",   { n: c.amount, target: c.target?.name ?? "" })); break;
            case "status":    push(t("status",   { status: c.status, target: c.target?.name ?? "" })); break;
            case "heal":      push(t("heal",     { n: c.amount, target: c.target?.name ?? "" })); break;
            case "drain":     push(t("drain",    { n: c.amount, resource: c.resource, target: c.target?.name ?? "" })); break;
            case "modifier":  push(t("modifier", { delta: c.delta, stat: c.stat, target: c.target?.name ?? "" })); break;
            case "zone":      push(t("zone",     { size: c.size, shape: c.shape })); break;
            case "object":    push(t("object",   { what: c.what, hp: c.hp })); break;
            /* A ward with no pool is not a shield of nothing — Demetia's Crest
             * Surge turns aside spells by the charge and has no hit points at
             * all, and the card announced "A shield of 0". */
            case "shield":
                if (c.hp > 0) push(t("shield", { hp: c.hp }));
                else if (c.charges) push(t("ward", { n: c.charges }));
                break;
            /* Three things the engine did and the card never mentioned. A 14m
             * throw, a per-round escape check and a pool of Luck points are
             * all decisions the table has to make, and all three were resolved
             * in silence. */
            case "knockback": push(t(c.struck ? "knockbackStruck" : "knockback",
                                     { n: c.metres, target: c.target?.name ?? "" })); break;
            case "saveEnds":  push(t("saveEnds", { target: c.target?.name ?? "", skill: c.skill,
                                                   dc: c.dc, cadence: c.cadence ?? "round" })); break;
            case "pool":      push(t("pool",     { n: c.size, resource: c.resource,
                                                   target: c.target?.name ?? "" })); break;
            case "summoned":  push(t("summoned", { count: c.count, what: c.what })); break;
            case "dispelled": out.push(c.count ? t("dispelled", { n: c.count })
                                              : t("dispelRefused", { n: c.refused })); break;
            case "upkeep":    out.push(t("upkeep",   { n: c.perRound })); break;
            /* The gate that did NOT open. Named so a spell that "did nothing"
             * can be told apart from one that rolled badly. */
            case "chanceMissed":
                out.push(c.roll == null ? t("chanceNone", { chance: c.chance })
                                        : t("chanceMissed", { chance: c.chance, roll: c.roll }));
                break;
            /* `narrated` and `revealed` post their own messages — repeating
             * them on the card would say everything twice. */
        }
    }
    return out;
}
