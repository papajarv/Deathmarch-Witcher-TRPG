/**
 * Food & drink mechanic — port of witcher-food-and-drink.
 *
 * Two subsystems:
 *   - Charges:  per-item portion tracking on `valuable.system.charges`.
 *               Weight + cost scale with `current/max` ratio at derive time.
 *   - Drunk:    alcohol items (`valuable.system.drunk.isAlcohol`) trigger
 *               an Endurance check on consume; failure raises the actor's
 *               drunk level via the 8 status effects in `drunkStatuses.mjs`.
 *
 * Homebrew (ADR 0003): gates on `isHomebrewEnabled("foodAndDrink")`.
 *
 * Phase 10: API + status effect registration + consume hook integration.
 * GM configuration dialogs (the "cog" buttons) land in chrome port.
 */

import { isHomebrewEnabled } from "../api/homebrew.mjs";
import { DRUNK_STATUSES }    from "../setup/drunkStatuses.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const DRUNK_FLAG = "isDrunkEffect";   // marker on ActiveEffects we own

/* ─────────── Charges ────────────────────────────────────────────────────── */

export function isCharged(item) {
    const c = item?.system?.charges;
    return Number.isFinite(c?.max) && c.max > 0;
}

export function getCharges(item) {
    const c = item?.system?.charges;
    if (!isCharged(item)) return null;
    return { current: c.current ?? 0, max: c.max };
}

export function getChargeRatio(item) {
    const c = getCharges(item);
    if (!c) return 1;
    return Math.max(0, Math.min(1, c.current / c.max));
}

/**
 * Decrement one charge. When charges hit zero:
 *   - If quantity > 1: drop quantity by 1, reset charges to max
 *   - Else:            delete the item
 */
export async function consumeOneCharge(item) {
    if (!isCharged(item)) return;
    const c = getCharges(item);
    const next = c.current - 1;
    if (next > 0) {
        return item.update({ "system.charges.current": next });
    }
    const qty = item.system.quantity ?? 1;
    if (qty <= 1) return item.delete();
    return item.update({
        "system.quantity": qty - 1,
        "system.charges.current": c.max
    });
}

/* ─────────── Drunk ──────────────────────────────────────────────────────── */

export function isAlcohol(item) {
    if (item?.type !== "valuable") return false;
    if (item.system?.type !== "food-drink") return false;
    return item.system?.drunk?.isAlcohol === true;
}

export function getDrunkConfig(item) {
    const d = item?.system?.drunk ?? {};
    return {
        isAlcohol:           !!d.isAlcohol,
        dc:                  Number.isFinite(d.dc) ? d.dc : 10,
        levelJump:           Number.isFinite(d.levelJump) ? d.levelJump : 1,
        bypassWitcherResist: !!d.bypassWitcherResist,
        flavorVerb:          d.flavorVerb || "drinks",
        effectIcon:          d.effectIcon || ""
    };
}

/** Read the actor's current drunk level (highest of any drunk effect). */
export function getDrunkLevel(actor) {
    if (!actor?.effects) return 0;
    let max = 0;
    for (const e of actor.effects) {
        const lvl = e.getFlag(SYSTEM_ID, "drunkLevel");
        if (Number.isFinite(lvl) && lvl > max) max = lvl;
    }
    return max;
}

/**
 * Apply (or replace) a drunk level on the actor. Level 0 clears all
 * drunk effects.
 */
export async function applyDrunkLevel(actor, level, iconOverride = "") {
    if (!actor) return;
    if (!actor.isOwner && !game.user.isGM) return;

    // Clear existing drunk effects
    const existing = actor.effects.filter(e => e.getFlag(SYSTEM_ID, DRUNK_FLAG));
    if (existing.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(e => e.id));
    }
    if (level <= 0) return;

    const def = DRUNK_STATUSES[Math.min(level, DRUNK_STATUSES.length) - 1];
    if (!def) return;

    return actor.createEmbeddedDocuments("ActiveEffect", [{
        name: def.name,
        img:  iconOverride || def.img,
        description: def.summary,
        disabled: false,
        statuses: [def.id],
        changes: def.changes,
        flags: { [SYSTEM_ID]: { [DRUNK_FLAG]: true, drunkLevel: level } }
    }]);
}

/**
 * Roll Endurance vs DC after consuming alcohol. Witchers (actor has a
 * profession item with 'witcher' in its name) roll 2× and take the best
 * unless `bypassWitcherResist` is true.
 *
 * On failure, raises drunk level by `levelJump`.
 */
export async function handleEnduranceRoll(actor, cfg, itemName = "drink") {
    if (!actor) return;
    if (!isHomebrewEnabled("foodAndDrink")) return;

    const isWitcher = actor.items.some(
        i => i.type === "profession" && /witcher/i.test(i.name)
    );
    const rollOnce = async () => {
        // Use system rollSkill if present; fall back to a raw d10 roll.
        const v = actor._readSkillValues?.("endurance");
        const formula = v ? `1d10 + ${v.total}` : "1d10";
        const r = await new Roll(formula).evaluate();
        return r.total;
    };
    const a = await rollOnce();
    const b = (isWitcher && !cfg.bypassWitcherResist) ? await rollOnce() : null;
    const best = b !== null ? Math.max(a, b) : a;
    const pass = best > cfg.dc;

    const flavor = `<b>${actor.name}</b> ${cfg.flavorVerb} ${itemName}.<br>`;
    let body;
    if (pass) {
        body = `Endurance ${best}${b !== null ? ` (rolled ${a}/${b}, best)` : ""} vs DC ${cfg.dc} — <b style="color:#4a7c59">holds it.</b>`;
    } else {
        const cur = getDrunkLevel(actor);
        const next = Math.min(cur + cfg.levelJump, 8);
        await applyDrunkLevel(actor, next, cfg.effectIcon);
        body = `Endurance ${best}${b !== null ? ` (rolled ${a}/${b}, best)` : ""} vs DC ${cfg.dc} — <b style="color:#8b0000">fails.</b><br>
                Drunk level → <b>${roman(next)}</b>.`;
    }

    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div style="border-left:3px solid #8b6f3a;padding:4px 8px">${flavor}${body}</div>`
    });
}

/** Sober-up roll: 1d10 < BODY to drop one drunk level. */
export async function soberUp(actor) {
    if (!actor) return;
    const cur = getDrunkLevel(actor);
    if (cur <= 0) {
        return ui.notifications?.info(`${actor.name} is already sober.`);
    }
    const body = actor.system?.stats?.body?.value ?? 0;
    const roll = await new Roll("1d10").evaluate();
    const pass = roll.total < body;
    if (pass) await applyDrunkLevel(actor, cur - 1);

    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div style="border-left:3px solid #6f8b3a;padding:4px 8px">
            <b>${actor.name}</b> sobers up.<br>
            Rolled <b>${roll.total}</b> vs BODY <b>${body}</b> — ${pass
                ? `<b style="color:#4a7c59">drops to ${roman(cur - 1)}</b>`
                : `<b style="color:#8b0000">still ${roman(cur)}</b>`}.
        </div>`
    });
}

function roman(n) {
    return ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"][n] ?? String(n);
}

/* ─────────── Consume hook ───────────────────────────────────────────────── */

/**
 * Called from consumeMixin after the base quantity decrement.
 * Returns true if this mechanic handled the consume (so consumeMixin
 * skips its default decrement); false otherwise.
 *
 * Order:
 *   1. If charged: tick the charge counter (and skip default qty decrement)
 *   2. If alcohol: fire the endurance check (additive — runs regardless)
 */
export async function onConsume(item) {
    if (!isHomebrewEnabled("foodAndDrink")) return false;
    let handled = false;

    if (isCharged(item)) {
        await consumeOneCharge(item);
        handled = true;
    }
    if (isAlcohol(item)) {
        const cfg = getDrunkConfig(item);
        await handleEnduranceRoll(item.actor, cfg, item.name);
        // Endurance roll doesn't claim handling — the qty/charge step
        // already covers consumption.
    }
    return handled;
}

/* ─────────── Public API ─────────────────────────────────────────────────── */

export const foodAndDrinkApi = Object.freeze({
    isCharged, getCharges, getChargeRatio, consumeOneCharge,
    isAlcohol, getDrunkConfig, getDrunkLevel,
    applyDrunkLevel, handleEnduranceRoll, soberUp,
    onConsume,
    DRUNK_STATUSES
});
