/**
 * Durable rune quality — when a weapon or shield would be ablated (lose
 * Reliability) for ANY reason, roll 1d6; on a 4, 5, or 6 the ablation is
 * negated entirely. There is no single reliability-loss choke-point in the
 * system (DoT ticks, spell reliability damage, bombs, block absorption, and
 * GM sockets all write `system.reliability.value` independently), so each of
 * those paths calls this shared gate right before its write.
 *
 * `durableAblationNegated(item)` rolls — and posts a brief chat note — ONLY
 * when the item actually carries the `durable` quality, so callers can gate
 * unconditionally with near-zero overhead for ordinary gear. Returns true when
 * the caller should SKIP the reliability loss for that item.
 */

import { t, tFormat } from "../chrome/lib/i18n.js";

export async function durableAblationNegated(item, { actor = null } = {}) {
    const quals = item?.system?.effective?.qualities ?? item?.system?.qualities ?? [];
    if (!Array.isArray(quals) || !quals.includes("durable")) return false;

    let roll;
    try { roll = await new Roll("1d6").evaluate(); }
    catch (_) { return false; }               // if the roll can't evaluate, ablate normally
    const total   = Number(roll.total) || 0;
    const negated = total >= 4;

    /* Feedback note only on the interesting outcome (a save). A normal
     * ablation already posts its own message from the calling path. */
    if (negated) {
        try {
            const speaker = actor
                ? ChatMessage.getSpeaker({ actor })
                : ChatMessage.getSpeaker();
            const line = tFormat(
                "WITCHER.Mech.Durable.Saved",
                { item: item?.name ?? "?", roll: total },
                `<b>${item?.name ?? "?"}</b> shrugs off the damage — <i>Durable</i> (1d6 = ${total}).`
            );
            await ChatMessage.create({
                speaker,
                content: `<div class="wdm-durable-save"><i class="fa-solid fa-shield"></i> ${line}</div>`,
                rolls: [roll],
                rollMode: game.settings?.get?.("core", "rollMode")
            });
        } catch (_) { /* chat note is best-effort */ }
    }
    return negated;
}
