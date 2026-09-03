/**
 * Overencumbered status — mirrors the carried-weight penalty as a (token-hidden)
 * status so the player can SEE why REF/DEX/SPD dropped and by how much.
 *
 * The actual −1 REF/DEX/SPD-per-5kg penalty is applied in
 * CharacterData#prepareDerivedData (exposed as `derivedStats.encPenalty`). This
 * policy only reflects that derived state: it toggles the `overencumbered`
 * status on/off and keeps the effect's NAME showing the live "N kg over (−P)"
 * figures. The status clause carries NO `changes`, so it never double-penalizes.
 * `overencumbered` is registered with `showOnToken:false`, so it never paints a
 * token icon — it lives only in the effects/status list.
 *
 * Only ONE client writes (the active GM, else the actor's owner), mirroring the
 * combat-round-reset / wound-status reconcilers.
 */

import { tFormat } from "../chrome/lib/i18n.js";

const STATUS_ID = "overencumbered";

function iShouldWrite(actor) {
    const gm = game.users?.activeGM;
    if (gm) return gm.isSelf;
    return !!actor?.isOwner;
}

async function reconcile(actor) {
    if (!actor || actor.type !== "character") return;
    if (!iShouldWrite(actor)) return;

    const pen      = Number(actor.system?.derivedStats?.encPenalty) || 0;
    const existing = actor.effects?.find?.(e => e.statuses?.has?.(STATUS_ID)) ?? null;

    if (pen > 0) {
        const carried = (typeof actor.getTotalWeight === "function") ? (Number(actor.getTotalWeight()) || 0) : 0;
        const encMax  = Number(actor.system?.derivedStats?.enc) || 0;
        const over    = Math.max(0, Math.round((carried - encMax) * 100) / 100);
        const name    = tFormat(
            "WITCHER.Status.OverencumberedNamed",
            { over, pen },
            `Overencumbered — ${over} kg over (−${pen} REF/DEX/SPD)`
        );
        if (!existing) {
            try { await actor.toggleStatusEffect?.(STATUS_ID, { active: true }); } catch (_) {}
            const eff = actor.effects?.find?.(e => e.statuses?.has?.(STATUS_ID));
            if (eff && eff.name !== name) { try { await eff.update({ name }); } catch (_) {} }
        } else if (existing.name !== name) {
            try { await existing.update({ name }); } catch (_) {}
        }
    } else if (existing) {
        try { await actor.toggleStatusEffect?.(STATUS_ID, { active: false }); } catch (_) {}
    }
}

/* Debounce per-actor: equipping / stowing / currency edits burst several
 * item+actor writes. Collapse into ONE reconcile per actor per frame. */
const _pending = new Set();
function flush() {
    for (const id of [..._pending]) {
        _pending.delete(id);
        const a = game.actors?.get?.(id);
        if (a) reconcile(a);
    }
}
function schedule(actor) {
    if (!actor?.id) return;
    const wasEmpty = _pending.size === 0;
    _pending.add(actor.id);
    if (wasEmpty) requestAnimationFrame(flush);
}

export function registerEncumbranceStatus() {
    // Capacity = BODY×10 (actor stat); carried weight = item weights/qty/equip/
    // stored + currency (actor.system.currency). Watch both actor and item CRUD.
    Hooks.on("updateActor", (actor) => { if (actor?.type === "character") schedule(actor); });
    Hooks.on("createItem",  (it) => { if (it?.parent instanceof Actor && it.parent.type === "character") schedule(it.parent); });
    Hooks.on("deleteItem",  (it) => { if (it?.parent instanceof Actor && it.parent.type === "character") schedule(it.parent); });
    Hooks.on("updateItem",  (it) => { if (it?.parent instanceof Actor && it.parent.type === "character") schedule(it.parent); });

    // Initial sweep for characters already loaded when the world opens.
    Hooks.once("ready", () => {
        for (const a of (game.actors ?? [])) {
            if (a?.type === "character") schedule(a);
        }
    });
}
