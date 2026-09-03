/**
 * Choke damage + per-turn upkeep.
 *
 * A chokehold is applied ONCE (the opposed Choke action). After that the damage
 * is dealt each turn by the turn-start UPKEEP PROMPT here — you can't re-invoke
 * Choke on a foe you already hold (the option is hidden). Each application:
 *
 *   (3 + melee bonus + Strangling flat) × Strangling multiplier
 *
 * damage, applied SUFFOCATION-style: flat (no hit-location multiplier), THROUGH
 * armour AND the magic shield, to STAMINA first and then HP once stamina is
 * gone (staThenHp). Unarmed Brawling chokes have no Strangling bonus.
 */

import { emitApplyDamage } from "../setup/socketHook.mjs";
import { strangleSuffocation } from "./openCategoryBonuses.mjs";
import { getHoldLinks } from "./holdLink.mjs";
import { isCombatExtendedEnabled } from "../api/homebrew.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Per-turn choke (suffocation) damage.
 *   RAW:  a flat 3 — no bonuses.
 *   Combat Extended: (3 + melee bonus + Strangling flat) × Strangling multiplier. */
export function chokeDamageAmount(choker, weapon = null) {
    if (!isCombatExtendedEnabled()) return 3;
    const mb = Number(choker?.system?.derivedStats?.meleeBonus) || 0;
    const { flat, mult } = strangleSuffocation(weapon);
    return Math.max(0, Math.round((3 + mb + flat) * mult));
}

/** Deal one turn of choke damage to `target` and re-stamp the maintenance
 *  round on `choker`. Returns the amount dealt. */
export async function applyChokeDamage(choker, target, weapon = null, { attackMessageUuid = null } = {}) {
    if (!choker || !target) return 0;
    const dmg = chokeDamageAmount(choker, weapon);
    if (dmg > 0) {
        await emitApplyDamage({
            targetUuid:    target.uuid,
            weaponDamage:  dmg,
            silverDamage:  0,
            damageTypes:   [],
            /* Flat (torso ×1, no location mult). throughArmor bypasses worn +
             * natural armour AND the magic shield; staThenHp drains stamina
             * first, then HP. */
            locationKey:   "torso",
            locationLabel: game.i18n?.localize?.("WITCHER.Brawl.ChokeLoc") ?? "Throat",
            throughArmor:  true,
            staThenHp:     true,
            kind:          "weapon",
            sourceLabel:   game.i18n?.localize?.("WITCHER.Brawl.Choke") ?? "Choke",
            attackMessageUuid
        });
    }
    try { await choker.setFlag(SYSTEM_ID, "chokeRound", Number(game?.combat?.round) || 0); } catch (_) {}
    return dmg;
}

/** The targets `choker` currently CHOKES (holder of a chokeheld pair). Returns
 *  an array of resolved target actors. Uses the async getHoldLinks so the
 *  registry cache is warmed at hook time (getHoldsSync can be cold). */
export async function chokeTargetsOf(choker) {
    if (!choker) return [];
    let pairs = [];
    try { pairs = await getHoldLinks(choker); } catch (_) { pairs = []; }
    const out = [];
    for (const p of pairs) {
        if (p.kind !== "chokeheld" || p.role !== "holder") continue;
        try { const a = p.partnerUuid ? await fromUuid(p.partnerUuid) : null; if (a) out.push(a); } catch (_) {}
    }
    return out;
}

/** The choker's equipped (else carried) Strangling weapon, if any — its bonus
 *  rides on the upkeep damage. Unarmed chokes return null. */
export function findStranglingWeapon(actor) {
    const items = actor?.items;
    if (!items?.find) return null;
    const isStr = (i) => i?.type === "weapon"
        && (i.system?.effective?.qualities ?? i.system?.qualities ?? [])
            .some(q => String(q).toLowerCase() === "strangling");
    return items.find(i => isStr(i) && i.system?.equipped) ?? items.find(isStr) ?? null;
}

/* Only the client that OWNS the choker (or the active GM for an NPC) drives the
 * prompt — mirrors wrTurnStartPrompt.iShouldPrompt so it fires exactly once. */
function iShouldPrompt(actor) {
    if (!actor) return false;
    const owner = game.users?.players?.find(u => u.active && actor.testUserPermission(u, "OWNER"));
    if (owner) return owner.isSelf;
    return !!game.users?.activeGM?.isSelf;
}

/** Commit a FULL-ROUND action and deal a turn of choke damage to `target`.
 *  Returns true if it happened, false if the turn couldn't be committed (so we
 *  don't maintain for free). Shared by the upkeep prompt and the manual dock
 *  "Maintain" pill. Maintaining a chokehold takes your WHOLE turn — it's not a
 *  casual thing; you can't do anything else this round. */
export async function maintainChokeOnce(choker, target, weapon = null) {
    /* recordFullRound consumes movement + action + extra, and returns false if
     * the turn is already committed / dirtied (you've moved or acted) or it
     * isn't your turn — in which case the choke isn't maintained (the hold
     * persists; the backstop releases it if this keeps happening). */
    let spent = true;
    try { spent = (await choker.recordFullRound?.(game.i18n?.localize?.("WITCHER.Brawl.Choke") ?? "Choke")) ?? true; }
    catch (_) { spent = true; }
    if (spent === false) {
        ui.notifications?.warn(game.i18n?.localize?.("WITCHER.Mech.Choke.NoAction") ?? "Can't maintain the choke — it takes your whole turn, and you've already acted.");
        return false;
    }
    const dealt = await applyChokeDamage(choker, target, weapon);
    try {
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: choker }),
            content: `<div class="wdm-attack-card"><div class="wdm-attack-rider"><i class="fa-solid fa-lungs"></i> <strong>${target.name}</strong> keeps choking — <strong>${dealt}</strong> suffocation (stamina, then HP).</div></div>`
        });
    } catch (_) {}
    return true;
}

/** Turn-start upkeep — for every foe the actor chokes, ask whether to keep it
 *  up (spend an action + deal a turn of suffocation) or release. Closing the
 *  dialog (✕ / Esc) is a NO-OP: the hold persists and you're asked again next
 *  turn — only the explicit Release button drops the choke. */
async function offerChokeUpkeep(choker) {
    const targets = await chokeTargetsOf(choker);
    if (!targets.length) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    const weapon = findStranglingWeapon(choker);
    for (const target of targets) {
        let pick = "keep";
        if (DialogV2) {
            pick = await DialogV2.wait({
                window: { title: game.i18n?.localize?.("WITCHER.Mech.Choke.UpkeepTitle") ?? "Choke — keep it up?" },
                content:
                    `<div style="padding:6px 0;font-size:0.8125rem;">` +
                    (game.i18n?.format?.("WITCHER.Mech.Choke.UpkeepBody", { name: target.name, dmg: chokeDamageAmount(choker, weapon) })
                        ?? `Keep choking <strong>${target.name}</strong>? Spends your action and deals <strong>${chokeDamageAmount(choker, weapon)}</strong> suffocation (stamina, then HP).`) +
                    `</div>`,
                buttons: [
                    { action: "keep",    label: game.i18n?.localize?.("WITCHER.Mech.Choke.UpkeepKeep")    ?? "Keep choking (1 action)", default: true, callback: () => "keep" },
                    { action: "release", label: game.i18n?.localize?.("WITCHER.Mech.Choke.UpkeepRelease") ?? "Release",                                callback: () => "release" }
                ],
                /* Closing without a choice must NOT drop the hold — treat it as a
                 * skip (no damage, no action, ask again next turn). */
                rejectClose: false
            }).catch(() => null);
        }
        if (pick === "release") {
            try {
                const { clearHoldLink } = await import("./holdLink.mjs");
                await clearHoldLink(choker, "choke released", target, "chokeheld");
            } catch (_) {}
        } else if (pick === "keep") {
            await maintainChokeOnce(choker, target, weapon);
        }
        /* pick == null (closed) → no-op: hold stays, no damage/action this turn. */
    }
}

/** Register the choke turn-start upkeep prompt. */
export function installChokeUpkeepPrompt() {
    Hooks.on("combatTurnChange", async (combat) => {
        const actor = combat?.combatant?.actor;
        if (!actor || !iShouldPrompt(actor)) return;
        await offerChokeUpkeep(actor);
    });
}
