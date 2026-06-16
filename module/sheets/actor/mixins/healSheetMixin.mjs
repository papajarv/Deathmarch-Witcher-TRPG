/**
 * healSheetMixin — adds `_onHeal()` (and supporting helpers) to a
 * character sheet class. The chrome dock binds its Rest button to
 * `actor.sheet._onHeal()` (see chrome/dock.js:953-957), so the method
 * lives on the sheet for that call shape.
 *
 * Flow:
 *   1. Open a DialogV2 with checkboxes for Resting / Sterilized /
 *      Healing Hand / Healing Tent.
 *   2. Live-update the running total HP recovered as boxes flip. The
 *      stress mechanic's penalty (stress − WILL, clamped to 0) is
 *      subtracted from the recovery — that's the Phase 6 REC penalty.
 *   3. On confirm, apply HP and refill STA (per RAW rest fully restores
 *      it). Critical wounds are NOT advanced here — they heal on the world
 *      clock (treated wounds clear once enough in-game days pass since
 *      treatment; see CriticalWoundData + the autoheal sweep).
 *
 * No reliance on the chrome — the dialog stands on its own. Compose via
 * `healSheetMixin(WitcherActorSheet)`.
 */

import { getStress, getWill, getStressPenalty } from "../../../mechanics/stress.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/**
 * Walk active ActiveEffects for healing-only REC bonuses. Hangover applies a
 * FLAT REC penalty directly to the displayed stat (via an AE change on
 * `system.derivedStats.rec`), so it shows up in `actor.system.derivedStats.rec`
 * already — no flag lookup needed. Gorged on the other hand contributes a
 * heal-only bonus the displayed stat doesn't reflect; that flag is
 * `flags.<systemId>.healingRecBonus` and gets summed here.
 *
 * `healingRecPenalty` is intentionally NOT subtracted anymore — hangover used
 * to set it back when the penalty was healing-only, but the rule was reverted
 * to a flat REC penalty, so subtracting it again would double-count.
 */
function getHealingRecMod(actor) {
    if (!actor?.appliedEffects) return 0;
    let mod = 0;
    for (const e of actor.appliedEffects) {
        if (e.disabled || e.system?.isSuppressed) continue;
        mod += Number(e.flags?.[SYSTEM_ID]?.healingRecBonus) || 0;
    }
    return mod;
}

function computeTotalRec(actor, opts) {
    const baseRec = Number(actor?.system?.derivedStats?.rec) || 0;
    const penalty = getStressPenalty(actor);
    let total = opts.resting ? baseRec : Math.floor(baseRec / 2);
    total = Math.max(0, total - penalty);
    // Healing-only modifiers from active effects (Gorged +2, Hangover −N).
    // Applied AFTER the half/full split so they're flat — same pattern as
    // Sterilized / Healing Hand / Healing Tent below. Previously these
    // landed on the REC base and got halved during active rest, which made
    // Gorged's +2 read as a +1 to healing — not what the spec wanted.
    const healMod = getHealingRecMod(actor);
    total = Math.max(0, total + healMod);
    if (opts.sterilized)   total += 2;
    if (opts.healingHand)  total += 3;
    if (opts.healingTent)  total += 2;
    return total;
}

export const healSheetMixin = (Base) => class extends Base {

    /**
     * Open the heal/rest dialog. Called by the chrome dock's Rest button
     * via `actor.sheet._onHeal()`, and by any in-sheet heal button we
     * wire up later (none yet — chrome panel is the canonical UI).
     */
    async _onHeal() {
        const actor = this.actor;
        if (!actor) return;

        const opts = { resting: false, sterilized: false, healingHand: false, healingTent: false };
        const initialRec = computeTotalRec(actor, opts);

        const dialogData = {
            totalRec: initialRec,
            stress: getStress(actor),
            will: getWill(actor),
            stressPenalty: getStressPenalty(actor),
            daysHealed: 1
        };

        const content = await foundry.applications.handlebars.renderTemplate(
            `systems/${SYSTEM_ID}/templates/dialog/heal-rest.hbs`,
            dialogData
        );

        const dialog = new foundry.applications.api.DialogV2({
            window: { title: `Rest — ${actor.name}` },
            content,
            modal: false,
            buttons: [
                {
                    action: "heal",
                    label: "Recover",
                    default: true,
                    callback: () => this._applyHealing(actor, opts)
                },
                {
                    action: "cancel",
                    label: "Cancel",
                    callback: () => {}
                }
            ]
        });

        await dialog.render({ force: true });
        this._wireHealDialogListeners(actor, opts);
    }

    /**
     * Bind change listeners on the dialog checkboxes so the running
     * total updates live. Idempotent — re-wires every dialog open.
     */
    _wireHealDialogListeners(actor, opts) {
        const root = document;
        const restingEl    = root.querySelector("#resting");
        const sterilizedEl = root.querySelector("#sterilized");
        const handEl       = root.querySelector("#healing-hand");
        const tentEl       = root.querySelector("#healing-tent");
        const readoutEl    = root.querySelector("#extra-info");
        const sterilizedInfoEl = root.querySelector("#sterilized-info");

        if (!restingEl || !readoutEl) return;

        const sync = () => {
            opts.resting     = restingEl.checked;
            opts.sterilized  = sterilizedEl?.checked ?? false;
            opts.healingHand = handEl?.checked ?? false;
            opts.healingTent = tentEl?.checked ?? false;
            const total = computeTotalRec(actor, opts);
            readoutEl.textContent = `Total recover + ${total}`;
            if (sterilizedInfoEl) {
                sterilizedInfoEl.classList.toggle("invisible", !opts.sterilized);
            }
        };

        [restingEl, sterilizedEl, handEl, tentEl].forEach(el => {
            el?.addEventListener("change", sync);
        });
    }

    /**
     * Apply the recovered HP, refill STA + VIGOR, and tick wound healing.
     * Pulled the latest `opts` so the value at confirm-time wins (not
     * whatever was captured when the dialog opened).
     */
    async _applyHealing(actor, opts) {
        const totalRec = computeTotalRec(actor, opts);

        const hp = actor.system.derivedStats.hp;
        const sta = actor.system.derivedStats.sta;
        // Vigor is now a static counter (player-set, no max). Heal/Rest
        // doesn't refill it — there's nothing to refill TO. Casters
        // recover Vigor between scenes per profession (Core p.113); the
        // GM handles that by hand or via a scene event.
        await actor.update({
            "system.derivedStats.hp.value":  Math.min((hp.value || 0) + totalRec, hp.max || 0),
            "system.derivedStats.sta.value": sta.max || 0
        });

        // Crit wounds heal on the world clock now, not per rest — a treated
        // wound clears once enough in-game days pass since it was treated
        // (CriticalWoundData + the autoheal sweep). Resting only restores HP.

        const stressPenalty = getStressPenalty(actor);
        const restType = opts.resting ? "full rest" : "active rest";
        const aids = [opts.sterilized && "sterilized", opts.healingHand && "healing hand", opts.healingTent && "healing tent"]
            .filter(Boolean).join(", ");
        const aidLine = aids ? ` (${aids})` : "";
        const penaltyLine = stressPenalty > 0
            ? `<div>Stress penalty applied: −${stressPenalty} HP.</div>`
            : "";

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div><strong>${actor.name}</strong> recovers ${totalRec} HP from ${restType}${aidLine}.</div>${penaltyLine}`
        });
    }
};
