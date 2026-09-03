/**
 * Death State — per-turn death-save prompt, cumulative-penalty reset on
 * recovery, and removal from the initiative track on death.
 *
 * Three house rules, tied together here:
 *   • At the start of a DYING actor's turn (healthState.dying — HP strictly < 0,
 *     see character/monster data models), prompt their owner (or the GM) to roll
 *     a death save. Failure marks them `dead` and each success stacks the
 *     cumulative −1 penalty — both already handled by saveMixin.rollDeathSave.
 *   • When an actor is knocked OUT of death state (recovers to HP ≥ 0 while still
 *     alive), the cumulative `deathSaves` penalty is wiped — surviving resets it.
 *   • The `dead` status effect appearing on an actor removes their combatant(s)
 *     from every encounter. Driven by the AE's presence, so ANY death source
 *     (death-save failure, GM toggle, starvation) clears them off the track.
 *
 * Prompt/reset gating mirrors wrTurnStartPrompt (the active owner acts, else the
 * active GM — never both). Combatant deletion runs on the active GM alone.
 */

import { isDeadActor } from "./deadState.mjs";
import { t, tFormat } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Only the actor's active owner acts; failing that, the active GM. Never both. */
function iShouldAct(actor) {
    if (!actor) return false;
    const owner = game.users?.players?.find(u => u.active && actor.testUserPermission(u, "OWNER"));
    if (owner) return owner.isSelf;
    return !!game.users?.activeGM?.isSelf;
}

/** Start-of-turn prompt: a dying (not-yet-dead) actor is offered a death save. */
async function offerDeathSave(actor) {
    if (!actor?.system?.healthState?.dying) return;   // HP strictly < 0
    if (isDeadActor(actor)) return;                   // already dead — off the track anyway
    if (typeof actor.rollDeathSave !== "function") return;

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) { try { await actor.rollDeathSave(); } catch (_) { /* best effort */ } return; }

    const successes = Number(actor.system?.deathSaves) || 0;
    let roll = false;
    try {
        roll = await DialogV2.confirm({
            window: { title: t("WITCHER.Mech.DeathState.Dialog.Title", "Death State") },
            content:
                `<div style="padding:8px 0;font-size:0.8125rem;">` +
                    `<div>${tFormat("WITCHER.Mech.DeathState.Text.Prompt", { name: actor.name }, `<strong>${actor.name}</strong> is in <strong>Death State</strong> — roll a death save?`)}</div>` +
                    (successes ? `<div style="margin-top:6px;opacity:0.8;">${tFormat("WITCHER.Mech.DeathState.Text.Penalty", { n: successes }, `Cumulative penalty so far: −${successes} to the save.`)}</div>` : "") +
                `</div>`,
            yes: { label: t("WITCHER.Mech.DeathState.Dialog.Roll", "Roll death save"), default: true },
            no:  { label: t("WITCHER.Mech.DeathState.Dialog.Later", "Later"), default: false },
            modal: false,
            rejectClose: false
        });
    } catch (_) { roll = false; }
    if (roll) {
        try { await actor.rollDeathSave(); }
        catch (err) { console.warn(`${SYSTEM_ID} | death save failed`, err); }
    }
}

/** Delete a dead actor's combatant(s) from every active encounter. GM-only. */
async function removeFromInitiative(actor) {
    if (!actor || !game.user?.isActiveGM) return;
    try {
        for (const combat of game.combats ?? []) {
            const ids = combat.combatants
                .filter(c => (c.actorId ?? c.actor?.id) === actor.id)
                .map(c => c.id);
            if (ids.length) await combat.deleteEmbeddedDocuments("Combatant", ids);
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | dead-actor combatant removal failed`, err);
    }
}

export function installDeathState() {
    /* (req 4) Prompt the dying actor at the start of their own turn. */
    Hooks.on("combatTurnChange", async (combat) => {
        const actor = combat?.combatant?.actor;
        if (!actor || !iShouldAct(actor)) return;
        await offerDeathSave(actor);
    });

    /* (req 5) Snapshot dying-state before an HP write, then wipe the cumulative
     * death-save penalty when the actor climbs back OUT of death state alive. */
    Hooks.on("preUpdateActor", (actor, changes) => {
        const hp = changes?.system?.derivedStats?.hp;
        if (hp?.value === undefined && hp?.temp === undefined) return;
        actor._wdmPreDying = !!actor.system?.healthState?.dying;
    });
    Hooks.on("updateActor", async (actor) => {
        const wasDying = actor._wdmPreDying;
        delete actor._wdmPreDying;
        if (!wasDying) return;                                     // wasn't in death state
        if (!iShouldAct(actor)) return;
        if (actor.system?.healthState?.dying) return;             // still dying
        if (isDeadActor(actor)) return;                           // died rather than recovered
        if ((Number(actor.system?.deathSaves) || 0) === 0) return;
        try {
            await actor.update({ "system.deathSaves": 0 });
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: tFormat("WITCHER.Mech.DeathState.Chat.Recovered", { name: actor.name }, `<em>{name} is knocked out of Death State — cumulative death-save penalty cleared.</em>`),
                flags: { [SYSTEM_ID]: { category: "combat" } }
            });
        } catch (err) {
            console.warn(`${SYSTEM_ID} | death-save penalty reset failed`, err);
        }
    });

    /* (req 7) The `dead` status appearing on an actor pulls their combatant(s)
     * off every initiative track. Keyed to the AE, so any death source fires it. */
    Hooks.on("createActiveEffect", async (effect) => {
        if (!game.user?.isActiveGM) return;
        if (effect?.parent?.documentName !== "Actor") return;
        if (!effect.statuses?.has?.("dead")) return;
        await removeFromInitiative(effect.parent);
    });
}
