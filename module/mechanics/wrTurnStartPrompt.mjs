/**
 * WR turn-start prompt — Bear · Unrelenting fires at the start of the
 * actor's turn when they're wounded or dying and have the AE + STA to
 * spend one point. The prompt asks "spend 1 adrenaline to ignore
 * penalties this round?"; yes stamps flags the perk-side machinery reads:
 *   - wounded  → `wr.unrelentingThisRound`   (character.prepareDerivedData
 *                suppresses the wound-state stat halving while set)
 *   - dying    → `wr.unrelentingDeathAutoPass` (saveMixin.rollDeathSave
 *                consumes it on the next roll)
 *
 * combatRoundMixin.resetCombatRound clears the wounded flag; the death
 * flag is one-shot inside rollDeathSave.
 */

import { wrHeroic } from "../api/witcherReborn.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDie } from "../api/adrenaline.mjs";
import { applyWoundSuppress } from "./wrHeroic.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Which heroics get the turn-start prompt. Only Bear · Unrelenting for
 * now — the Manticore heroic (Stand Aside) is an attack-redirect rider,
 * not a wound-state prompt. */
const TURN_START_HEROICS = new Set(["unrelenting"]);

function iShouldPrompt(actor) {
    if (!actor) return false;
    const owner = game.users?.players?.find(u => u.active && actor.testUserPermission(u, "OWNER"));
    if (owner) return owner.isSelf;
    return !!game.users?.activeGM?.isSelf;
}

async function offerTurnStart(actor) {
    const heroic = wrHeroic(actor);
    if (!TURN_START_HEROICS.has(heroic)) return;
    if (!isAdrenalineEnabled()) return;
    const hs = actor.system?.healthState;
    const dying   = !!hs?.dying;
    const wounded = !!hs?.wounded;
    if (!dying && !wounded) return;
    const ae  = Number(actor.system?.adrenaline?.value)      || 0;
    const sta = Number(actor.system?.derivedStats?.sta?.value) || 0;
    const staCost = adrenalineStaPerDie();
    if (ae < 1 || sta < staCost) return;

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return;
    const label = "Unrelenting";
    const state = dying ? "Death State" : "Wounded";
    const effect = dying
        ? "auto-pass this round's death save"
        : "ignore wound-state penalties this round";
    let yes = false;
    try {
        yes = await DialogV2.confirm({
            window: { title: `${label} — turn-start prompt` },
            content:
                `<div style="padding:8px 0; font-size:0.8125rem;">` +
                    `<div><strong>${actor.name}</strong> is <strong>${state}</strong>.</div>` +
                    `<div style="margin-top:6px;">Spend <strong>1 adrenaline</strong> (+ ${staCost} STA) to ${effect}?</div>` +
                `</div>`,
            yes: { label: `Spend 1 adrenaline — ${label}`, default: false },
            no:  { label: "Skip" },
            modal: true,
            rejectClose: false
        });
    } catch (_) { yes = false; }
    if (!yes) return;

    try {
        await actor.update({ "system.adrenaline.value": ae - 1 });
        if (typeof actor.spendStamina === "function") {
            await actor.spendStamina(staCost, { reason: `wr${label}` });
        } else {
            await actor.update({ "system.derivedStats.sta.value": sta - staCost });
        }
        /* Transient AE with suppress-wound + suppress-death DSL actions
         * + a 1-round Foundry duration. character.prepareDerivedData
         * reads both suppress actions and skips the corresponding stat
         * penalty pass. Applied for BOTH wounded and dying branches so
         * a dying actor also drops the wound-state penalty (they hit
         * the wound threshold on the way to dying — that penalty stacks
         * on top of Death State's ×⅓ otherwise). */
        await applyWoundSuppress(actor, label);
        if (dying) {
            /* Additionally stamp the death-save auto-pass flag so the
             * next rollDeathSave consumes it. */
            await actor.setFlag(SYSTEM_ID, "wr.unrelentingDeathAutoPass", true);
        }
        const line = dying
            ? `${actor.name} ignores Death State penalties this round + banks a death-save auto-pass (spent 1 adrenaline + ${staCost} STA).`
            : `${actor.name} ignores Wound State penalties this round (spent 1 adrenaline + ${staCost} STA).`;
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div class="wdm-attack-rider wdm-wr-heroic"><i class="fa-solid fa-hand-fist"></i> <strong>${label}</strong> — ${line}</div>`,
            flags: { [SYSTEM_ID]: { category: "combat" } }
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | ${label} turn-start apply failed`, err);
    }
}

export function installWRTurnStartPrompt() {
    Hooks.on("combatTurnChange", async (combat) => {
        const actor = combat?.combatant?.actor;
        if (!actor || !iShouldPrompt(actor)) return;
        await offerTurnStart(actor);
    });

    /* Also fire when the actor's health state transitions into wounded
     * or dying mid-turn — a Bear who takes damage in combat and drops
     * below their wound threshold should see the Unrelenting prompt
     * immediately, without waiting for their next turn. The offerTurnStart
     * function already checks eligibility (heroic + AE + STA); we just
     * gate on "this update actually caused a state transition."
     *
     * Uses preUpdate to snapshot the pre-update healthState (Foundry
     * doesn't preserve it into the update hook), then compares in
     * updateActor. Only fires on transitions INTO wounded/dying, so
     * re-taking damage while already wounded doesn't re-prompt. */
    Hooks.on("preUpdateActor", (actor, changes) => {
        const hpChange = changes?.system?.derivedStats?.hp;
        if (hpChange?.value === undefined && hpChange?.temp === undefined) return;
        actor._wrPreUpdateHealthState = {
            wounded: !!actor.system?.healthState?.wounded,
            dying:   !!actor.system?.healthState?.dying
        };
    });

    Hooks.on("updateActor", async (actor, changes) => {
        const prev = actor._wrPreUpdateHealthState;
        delete actor._wrPreUpdateHealthState;
        if (!prev) return;
        if (!iShouldPrompt(actor)) return;
        const now = actor.system?.healthState ?? {};
        const droppedIntoWounded = !prev.wounded && !prev.dying && !!now.wounded;
        const droppedIntoDying   = !prev.dying && !!now.dying;
        if (!droppedIntoWounded && !droppedIntoDying) return;
        await offerTurnStart(actor);
    });
}
