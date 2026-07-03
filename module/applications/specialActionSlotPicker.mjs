/**
 * Combat Extended — Special-action slot picker.
 *
 * Shared by guard config + raise shield. Asks the player which of their
 * three action-economy slots (movement / action / extra) to spend on a
 * Special Action. Per rules1: "Spend move action or your action. Can be
 * extra action but with the STA cost."
 *
 * Behavior:
 *   - Out of combat → returns "free" (no prompt, no spend)
 *   - 0 slots available → returns null (caller refuses)
 *   - 1 slot available → returns it directly (no prompt — there's
 *     nothing to choose between)
 *   - 2-3 slots available → prompts with one button per available slot;
 *     extra-action button labels its 3-STA + -3 to-hit surcharge
 *
 * Returns: "movement" | "action" | "extra" | "free" | null
 *   (null when the player cancels OR nothing is spendable)
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/* Compute which slots are spendable on the current turn. Mirrors the
 * same checks spendSpecialActionSlot uses, so the buttons we offer here
 * will all succeed when called. */
function availableSlots(actor) {
    const r = actor?.system?.combatRound ?? {};
    return {
        movement: !r.movementUsed && !((Number(r.movementMeters) || 0) > 0),
        action:   !r.actionUsed,
        extra:    !r.extraUsed
    };
}

export async function pickSpecialActionSlot(actor, label = "Special Action") {
    if (!actor) return null;
    /* Out of combat → free, no prompt. */
    if (!actor._inActiveCombat) return "free";

    const avail = availableSlots(actor);
    const keys = Object.keys(avail).filter(k => avail[k]);
    if (keys.length === 0) return null;
    if (keys.length === 1) return keys[0];   // nothing to choose between

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) {
        /* No dialog API → auto-pick by priority. */
        return keys[0];
    }

    /* Compute STA cost of the extra-action surcharge (combatMods can
     * reduce it). Reads the same field recordExtraAction uses, so the
     * number we show matches what'll actually be charged. */
    const extraStaCost = Math.max(0, 3 - (Number(actor.system?.combatMods?.extraActionStaReduction) || 0));

    const SLOT_BUTTON = {
        movement: {
            label: "Use Movement",
            icon:  "fa-solid fa-arrows-up-down-left-right",
            hint:  "Spend your turn's move action (no actual movement is taken). Won't cost STA."
        },
        action: {
            label: "Use Action",
            icon:  "fa-solid fa-bolt",
            hint:  "Spend your single action this turn. Won't cost STA."
        },
        extra: {
            /* Special Actions don't have a to-hit roll, so the standard
             * EXTRA_ACTION.toHit (−3) is moot here — only the STA cost
             * applies. Per user spec: "spending extra is me 'giving up'
             * my extra action" — works even before the normal action is
             * used (recordExtraAction's requirePriorAction gate is
             * bypassed for Special Actions). */
            label: `Use Extra Action (${extraStaCost} STA)`,
            icon:  "fa-solid fa-bolt-lightning",
            hint:  `Spend (give up) your extra action — costs ${extraStaCost} STA. Available even before you've used your normal action.`
        }
    };

    const buttons = keys.map(k => {
        const meta = SLOT_BUTTON[k];
        return {
            action:  k,
            label:   meta.label,
            icon:    meta.icon,
            default: k === keys[0],
            callback: () => k
        };
    });
    buttons.push({ action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" });

    const hintsHtml = keys.map(k =>
        `<div style="font-size:0.6875rem;opacity:0.75;margin:2px 0;">
            <strong style="color:#c8a878;">${esc(SLOT_BUTTON[k].label.replace(/\s*\([^)]*\)\s*$/, ""))}:</strong>
            ${esc(SLOT_BUTTON[k].hint)}
        </div>`).join("");

    const result = await DialogV2.wait({
        window: { title: `${label} — pick a slot`, icon: "fa-solid fa-bolt" },
        modal: true,
        content: `<div style="padding:6px 2px;display:flex;flex-direction:column;gap:6px;">
            <div>Which resource do you want to spend for <strong>${esc(label)}</strong>?</div>
            ${hintsHtml}
        </div>`,
        buttons,
        rejectClose: false
    }).catch(() => null);

    if (!result || result === "cancel") return null;
    return result;
}
