/**
 * autoFumble — auto-roll the fumble table when a d10 explodes DOWN, plus
 * the Witchers Reborn "spend 5 STA to skip" affordance for Wolf, Cat,
 * Bear, and Viper stance perks.
 *
 * Callers of extendedRoll pass `config.fumbleCategory` — one of:
 *   "meleeAttack" | "armedDefense" | "rangedAttack"
 *   "unarmedAttack" | "unarmedDefense" | "magic"
 * When the roll fumbles, extendedRoll fires a Hooks.callAll("witcherFumble",
 * { actor, category, message }) after posting the card. This module listens
 * to that hook.
 *
 * Flow:
 *   1. If the actor owns a stance perk that covers this category AND has
 *      ≥5 STA, show a modal: "Spend 5 STA to skip the fumble?"
 *   2. Yes → debit STA, append a "skipped" note to the roll's chat card.
 *   3. No / no perk / no STA → auto-roll the RAW fumble table and append
 *      the result to the same card.
 *
 * All stance-perk skip logic is behind the witcherReborn homebrew gate
 * (via hasWRPerk); auto-fumble ROLL is unconditional (users can still
 * disable by not passing a fumbleCategory from their callers).
 */

import { hasWRPerk, wrFumbleSkipContexts } from "../api/witcherReborn.mjs";
import { FUMBLE_TABLE, fumbleOutcome } from "./fumbleTable.mjs";
import { t, tFormat } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";

async function autoRollFumbleTable(actor, category, message) {
    const table = FUMBLE_TABLE()[category];
    if (!table) return;
    /* Categories with no rows (e.g. "skillCheck" — non-combat skill
     * fumbles) don't have a RAW auto-roll table. The base fumble banner
     * from extendedRoll's rendering is enough — GM adjudicates the
     * outcome. Skip the append so we don't post an empty result. */
    if (!Array.isArray(table.rows) || table.rows.length === 0) return;
    const roll = await new Roll("1d10").evaluate();
    const total = Number(roll.total) || 0;
    const outcome = fumbleOutcome(category, total);
    const banner =
        `<div class="wdm-roll-fumble wdm-auto-fumble">` +
            `<i class="fa-solid fa-triangle-exclamation"></i> ` +
            `<strong>${escapeHtml(table.label)}</strong> ` +
            `<span style="opacity:0.7;">(1d10 = ${total})</span>` +
            `<div class="wdm-auto-fumble-outcome">${escapeHtml(outcome)}</div>` +
        `</div>`;
    if (message) {
        try {
            await message.update({ content: String(message.content ?? "") + banner });
        } catch (_) {
            /* fall through to a follow-up message */
        }
    }
}

function escapeHtml(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function offerSkipDialog(actor, category) {
    const DialogV2 = foundry.applications.api.DialogV2;
    if (!DialogV2) return false;
    try {
        return await DialogV2.confirm({
            window: { title: game.i18n.localize("WITCHER.WR.Fumble.DialogTitle") },
            content:
                `<div style="padding:8px 0; font-size:0.8125rem;">` +
                    `<div>${tFormat("WITCHER.Mech.AutoFumble.Text.AboutToFumble", { name: escapeHtml(actor.name), category: escapeHtml(FUMBLE_TABLE()[category]?.label ?? category) }, `<strong>${escapeHtml(actor.name)}</strong> is about to fumble <strong>${escapeHtml(FUMBLE_TABLE()[category]?.label ?? category)}</strong>.`)}</div>` +
                    `<div style="margin-top:6px;">${tFormat("WITCHER.Mech.AutoFumble.Text.SpendXStaToIgnore", { sta: 5 }, `${t("WITCHER.Mech.AutoFumble.Text.Spend", "Spend")} <strong>5 STA</strong> to ignore the fumble entirely?`)}</div>` +
                    `<div style="margin-top:6px; opacity:0.7; font-size:0.75rem;">${t("WITCHER.Mech.AutoFumble.Text.CancelTheFumbleTableAutoRolls", "Cancel → the fumble table auto-rolls.")}</div>` +
                `</div>`,
            yes: { label: game.i18n.localize("WITCHER.WR.Fumble.SkipYes"), default: true },
            no:  { label: game.i18n.localize("WITCHER.WR.Fumble.SkipNo") },
            modal: true,
            rejectClose: false
        });
    } catch (_) {
        return false;
    }
}

async function handleFumble({ actor, category, message }) {
    if (!actor || !category) return;
    /* Skip-dialog gate: actor has a stance perk covering this category. */
    const contexts = wrFumbleSkipContexts(actor);
    const canSkip = contexts.has(category);
    const sta = Number(actor.system?.derivedStats?.sta?.value) || 0;
    if (canSkip && sta >= 5) {
        const yes = await offerSkipDialog(actor, category);
        if (yes) {
            try {
                /* Route through spendStamina so downstream hooks (0-STA
                 * stun, food-satiety drain, over-exertion accounting)
                 * see the debit. Fall back to direct write only when the
                 * mixin isn't attached (some actor types skip it). */
                if (typeof actor.spendStamina === "function") {
                    await actor.spendStamina(5, { reason: "wrFumbleSkip" });
                } else {
                    await actor.update({ "system.derivedStats.sta.value": sta - 5 });
                }
                const bannerText = game.i18n.format("WITCHER.WR.Fumble.SkippedBanner", { name: actor.name });
                const banner =
                    `<div class="wdm-roll-fumble wdm-fumble-skipped">` +
                        `<i class="fa-solid fa-shield-halved"></i> ` +
                        `${escapeHtml(bannerText)}` +
                    `</div>`;
                if (message) {
                    await message.update({ content: String(message.content ?? "") + banner });
                }
            } catch (err) {
                console.warn(`${SYSTEM_ID} | fumble skip debit failed`, err);
            }
            return;
        }
    }
    /* Fall-through — auto-roll the fumble table. */
    try {
        await autoRollFumbleTable(actor, category, message);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | auto-fumble roll failed`, err);
    }
}

/* Single-writer election. When multiple clients own an actor (common:
 * GM + a player), we want exactly ONE to drive the prompt + roll. Prefer
 * the active player-owner (their character; they should make the choice);
 * fall back to the active GM. Mirrors iShouldPrompt in
 * policy/combat-round-reset.mjs. */
function iShouldHandleFumble(actor) {
    if (!actor) return false;
    const activeOwner = game.users?.players?.find(u => u.active && actor.testUserPermission(u, "OWNER"));
    if (activeOwner) return activeOwner.isSelf;
    return !!game.users?.activeGM?.isSelf;
}

export function installAutoFumble() {
    Hooks.on("witcherFumble", async (payload) => {
        const actor = payload?.actor;
        if (!actor) return;
        if (!iShouldHandleFumble(actor)) return;
        await handleFumble(payload);
    });
}
