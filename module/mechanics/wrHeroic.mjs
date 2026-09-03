/**
 * Witchers Reborn heroic actions — the six per-school heroics implemented
 * as invokeable functions.
 *
 * Two are dock-shape actions (proactive) meant to be bound to a hotbar
 * macro:
 *   flowAndEbb    — Griffin: spend N adrenaline (+ STA cost) → +N vigor
 *   lightningFast — Viper: spend N adrenaline (+ STA cost) → +Nd6 m move
 *
 * The other four are chat-card riders (Pirouette / Deadly Focus /
 * Unrelenting / Bulwark / Shield Mastery) and live with the flow they
 * modify (see chrome/chrome/critical-roll.js for Deadly Focus, etc.).
 *
 * All heroics gate on `wrHeroic(actor) === "<key>"` — an actor can only
 * own one heroic action at a time (their school's).
 */

import { wrHeroic } from "../api/witcherReborn.mjs";
import { adrenalineStaPerDieFor, isAdrenalineEnabled } from "../api/adrenaline.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Debit N adrenaline dice + their STA cost from the actor. Returns true
 *  when the debit went through, false when the actor lacks either budget
 *  (with a ui.notifications warn). Kept private so both heroics share
 *  the same "pay the pool" semantics.
 *
 *  STA is routed through spendStamina so downstream hooks (food satiety
 *  drain, 0-STA stun) see the spend. Adrenaline has no wrapper method
 *  in this codebase — direct write is the idiomatic pattern (see e.g.
 *  weaponAttackMixin adrenaline spend). */
async function debitAdrenaline(actor, dice) {
    if (!actor || dice <= 0) return false;
    if (!isAdrenalineEnabled()) {
        ui.notifications?.warn(game.i18n.localize("WITCHER.WR.Adrenaline.Disabled"));
        return false;
    }
    const ae  = Number(actor.system?.adrenaline?.value)      || 0;
    const sta = Number(actor.system?.derivedStats?.sta?.value) || 0;
    const staCost = dice * adrenalineStaPerDieFor(actor);
    if (ae < dice) {
        ui.notifications?.warn(game.i18n.format("WITCHER.WR.Adrenaline.NeedAE", { name: actor.name, dice, ae }));
        return false;
    }
    if (sta < staCost) {
        ui.notifications?.warn(game.i18n.format("WITCHER.WR.Adrenaline.NeedSTA", { name: actor.name, sta: staCost, have: sta }));
        return false;
    }
    await actor.update({ "system.adrenaline.value": ae - dice });
    if (staCost > 0) {
        if (typeof actor.spendStamina === "function") {
            await actor.spendStamina(staCost, { reason: "wrHeroic" });
        } else {
            await actor.update({ "system.derivedStats.sta.value": sta - staCost });
        }
    }
    return true;
}

/** Griffin · Flow and Ebb. Spend N adrenaline dice (and their STA cost)
 *  to regenerate N points of vigor SPENT this round — i.e. refund vigor
 *  poured into spells earlier in the round. Clamped so you can't refund
 *  more vigor than you've spent.
 *
 *  Vigor itself is a scalar cap (system.derivedStats.vigor); per-round
 *  usage is tracked as `chaosRound.spent` (STA poured past the cap
 *  triggers over-exertion). "Regenerate 1 vigor" here means: reduce
 *  chaosRound.spent by 1, freeing 1 point of budget for the rest of
 *  the round without changing the character's underlying vigor cap. */
export async function flowAndEbb(actor, dice = 1) {
    if (!actor) return false;
    if (wrHeroic(actor) !== "flowAndEbb") {
        ui.notifications?.warn(game.i18n.format("WITCHER.WR.FlowAndEbb.NotOwner", { name: actor.name }));
        return false;
    }
    if (!game.combat?.started) {
        ui.notifications?.warn(game.i18n.localize("WITCHER.WR.FlowAndEbb.OutOfCombat"));
        return false;
    }
    dice = Math.max(1, Math.round(Number(dice) || 1));
    const combatId = game.combat.id;
    const round    = game.combat.round;
    const roundKey = `${combatId}:${round}`;
    const f        = actor.getFlag?.(SYSTEM_ID, "chaosRound") ?? {};
    const spent    = f?.round === roundKey ? (Number(f.spent) || 0) : 0;
    if (spent <= 0) {
        ui.notifications?.info(game.i18n.format("WITCHER.WR.FlowAndEbb.Nothing", { name: actor.name }));
        return false;
    }
    /* Clamp requested regen to what's actually spent — no point spending
     * adrenaline to "refund" vigor the Griffin hasn't poured out yet. */
    const regen = Math.min(dice, spent);
    if (regen < dice) {
        ui.notifications?.info(tFormat("WITCHER.Mech.WrHeroic.Notify.FlowAndEbbXHasOnly", { actor: actor.name, spent: spent, regen: regen }, "Flow and Ebb: {actor} has only {spent} vigor spent this round — regen limited to {regen}."));
    }
    if (!await debitAdrenaline(actor, regen)) return false;
    await actor.setFlag(SYSTEM_ID, "chaosRound", { round: roundKey, spent: spent - regen });
    const vigorCap = Number(actor.system?.derivedStats?.vigor) || 0;
    const banner = game.i18n.format("WITCHER.WR.FlowAndEbb.Banner",
        { name: actor.name, spent: spent - regen, cap: vigorCap });
    const diceLine = regen > 1 ? tFormat("WITCHER.Mech.WrHeroic.Text.SpentDiceLine", { regen }, ` (spent ${regen} adrenaline for ${regen} vigor)`) : "";
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="wdm-attack-rider wdm-wr-heroic"><i class="fa-solid fa-water"></i> <strong>${t("WITCHER.Mech.WrHeroic.Text.FlowAndEbb", "Flow and Ebb")}</strong> — ${banner}${diceLine}</div>`,
        flags: { [SYSTEM_ID]: { category: "combat" } }
    });
    return true;
}

/** Viper · Lightning Fast. Spend N adrenaline dice (and their STA cost);
 *  roll Nd6 and add the total to this round's movement cap. Requires an
 *  active combat so the round's movement budget can be extended. Dice
 *  Roller shows the roll so the table can audit the meters granted. */
export async function lightningFast(actor, dice = 1) {
    if (!actor) return false;
    if (wrHeroic(actor) !== "lightningFast") {
        ui.notifications?.warn(game.i18n.format("WITCHER.WR.LightningFast.NotOwner", { name: actor.name }));
        return false;
    }
    dice = Math.max(1, Math.round(Number(dice) || 1));
    if (!game.combat?.started) {
        ui.notifications?.warn(game.i18n.localize("WITCHER.WR.LightningFast.OutOfCombat"));
        return false;
    }
    if (!await debitAdrenaline(actor, dice)) return false;
    /* Roll Nd6 and use the total as the bonus meters. canvas-movement reads
     * flags.wr.lightningFastBonus when computing the round's movement max —
     * the bonus stacks on top of the existing cap (walk/run alike).
     * combatRoundMixin.resetCombatRound zeros the flag on turn end so it
     * doesn't carry over. */
    const roll = await new Roll(`${dice}d6`).evaluate();
    const meters = Number(roll.total) || 0;
    const cur = Number(actor.getFlag?.(SYSTEM_ID, "wr.lightningFastBonus")) || 0;
    await actor.setFlag(SYSTEM_ID, "wr.lightningFastBonus", cur + meters);
    const banner = game.i18n.format("WITCHER.WR.LightningFast.Banner",
        { name: actor.name, meters, dice });
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `<div class="wdm-attack-rider wdm-wr-heroic"><i class="fa-solid fa-bolt-lightning"></i> <strong>${t("WITCHER.Mech.WrHeroic.Text.LightningFast", "Lightning Fast")}</strong> — ${banner}</div>`,
        flags: { [SYSTEM_ID]: { category: "combat" } }
    });
    return true;
}

/** Apply the state-suppression AE: creates a transient effect with BOTH
 *  the `suppress: wound` AND `suppress: death` DSL actions + a 1-round
 *  Foundry duration. character.prepareDerivedData reads both suppress
 *  actions and skips the corresponding stat penalty pass, so a dying
 *  actor with this AE ignores the ×⅓ Death State penalties this round
 *  AND a wounded actor ignores the ×½ Wound State penalties. Foundry
 *  auto-removes the AE at round rollover.
 *
 *  Shared by the Unrelenting API entry and the Unrelenting/Bulwark
 *  turn-start prompt. */
export async function applyWoundSuppress(actor, label = "Unrelenting") {
    return actor.createEmbeddedDocuments("ActiveEffect", [{
        name: `${label} — state penalties ignored`,
        img:  "icons/svg/upgrade.svg",
        transfer: false,
        disabled: false,
        duration: { rounds: 1 },
        flags: {
            [SYSTEM_ID]: {
                actions: [
                    { type: "suppress", what: "wound", when: "always" },
                    { type: "suppress", what: "death", when: "always" }
                ]
            }
        }
    }]);
}

/** Bear · Unrelenting. Two flavors keyed off the actor's current state:
 *
 *   Death State (dying) — spend 1 AE (+ STA) to auto-pass this round's
 *   death save. Stamped as `wr.unrelentingDeathAutoPass`; saveMixin's
 *   rollDeathSave consumes it on the next roll.
 *
 *   Below wound threshold (wounded but not dying) — spend 1 AE (+ STA)
 *   to ignore the wound-state stat penalty. Creates a transient AE with
 *   the DSL suppress-wound action + a 1-round Foundry duration;
 *   character.prepareDerivedData already reads suppress actions.
 *
 *   Neither state — perk doesn't fire, warn.
 */
export async function unrelenting(actor) {
    if (!actor) return false;
    if (wrHeroic(actor) !== "unrelenting") {
        ui.notifications?.warn(tFormat("WITCHER.Mech.WrHeroic.Notify.XDoesNotHaveTheUnrelenting", { actor: actor.name }, "{actor} does not have the Unrelenting heroic action."));
        return false;
    }
    if (!game.combat?.started) {
        ui.notifications?.warn(t("WITCHER.Mech.WrHeroic.Notify.UnrelentingOnlyWorksDuringCombat", "Unrelenting only works during combat."));
        return false;
    }
    const hs = actor.system?.healthState;
    const dying   = !!hs?.dying;
    const wounded = !!hs?.wounded;
    if (!dying && !wounded) {
        ui.notifications?.info(tFormat("WITCHER.Mech.WrHeroic.Notify.XIsNeitherWoundedNorDying", { actor: actor.name }, "{actor} is neither wounded nor dying — Unrelenting has no effect right now."));
        return false;
    }
    if (!await debitAdrenaline(actor, 1)) return false;
    /* Apply the transient suppress-wound + suppress-death AE regardless
     * of state — a dying actor still gets the wound-state penalty on top
     * of Death State's ×⅓, so we suppress both flags to fully ignore
     * state penalties this round. */
    await applyWoundSuppress(actor, "Unrelenting");
    if (dying) {
        /* Dying branch also stamps the death-save auto-pass flag so the
         * next rollDeathSave consumes it. Combined effect: no state
         * penalties this round AND a guaranteed pass. */
        await actor.setFlag(SYSTEM_ID, "wr.unrelentingDeathAutoPass", true);
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: tFormat(
                "WITCHER.Mech.WrHeroic.Chat.UnrelentingDeath",
                { name: actor.name, label: t("WITCHER.Mech.WrHeroic.Text.Unrelenting", "Unrelenting") },
                "<div class=\"wdm-attack-rider wdm-wr-heroic\"><i class=\"fa-solid fa-hand-fist\"></i> <strong>{label}</strong> — {name} ignores Death State penalties this round + banks a death-save auto-pass (spent 1 adrenaline).</div>"
            ),
            flags: { [SYSTEM_ID]: { category: "combat" } }
        });
    } else {
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: tFormat(
                "WITCHER.Mech.WrHeroic.Chat.UnrelentingWound",
                { name: actor.name, label: t("WITCHER.Mech.WrHeroic.Text.Unrelenting", "Unrelenting") },
                "<div class=\"wdm-attack-rider wdm-wr-heroic\"><i class=\"fa-solid fa-hand-fist\"></i> <strong>{label}</strong> — {name} ignores Wound State penalties this round (spent 1 adrenaline).</div>"
            ),
            flags: { [SYSTEM_ID]: { category: "combat" } }
        });
    }
    return true;
}

/** Public API surface — attached to game.system.api.wr in main.mjs. */
export const wrHeroicApi = Object.freeze({
    flowAndEbb,
    lightningFast,
    unrelenting
});
