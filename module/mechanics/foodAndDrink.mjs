/**
 * Food & drink mechanic — homebrew subsystem (ADR 0003), gated on the single
 * `foodAndDrink` toggle. Disabled = nothing here runs, no statuses register,
 * no ticks fire, no AE alterations are made.
 *
 * Three pieces:
 *   - CHARGES: per-item portion tracking on `food.system.charges` (and the
 *              legacy valuable-typed shape, read-only — new content authors
 *              against the food item type).
 *   - DRUNK:   alcohol items trigger an Endurance check on consume; failure
 *              raises the actor's drunk level via the eight `drunk-N` statuses
 *              registered (when the toggle is on) in setup/statusEffects.mjs.
 *              Tier mechanics live in setup/statusClauses.mjs — engine reads.
 *   - SATIETY: hourly drain on characters (1 + ⌈BODY/4⌉ per in-game hour) and
 *              0.5 per STA spent in combat. Hunger tier is recomputed and the
 *              matching status (gorged / full / fed / peckish / hungry /
 *              famished) applied through the engine. Crossing UP into a tier
 *              fires `onApply.stress` from its clause (statusEngine); descending
 *              from a higher tier suppresses that via `wdmSkipOnApply`.
 *
 * Public API is exposed at `game.system.api.mechanics.foodAndDrink` in main.mjs.
 */

import { isHomebrewEnabled } from "../api/homebrew.mjs";
import { clauseFor, descriptionFor } from "./statusEngine.mjs";
import { grantStress }       from "./stress.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Per-binge peak drunk level. Lives in actor flags so it survives reloads and
 * stays per-actor. Cleared when the hangover is applied. */
const PEAK_FLAG = "peakDrunkLevel";
/* Hangover marker — the day-tick handler scans for this flag on AEs and
 * decrements daysRemaining each in-game date crossing. */
const HANGOVER_FLAG = "hangover";

/* Bottom satiety value at which the actor is considered FAMISHED. Satiety
 * doesn't go below this — keeps the math honest and avoids runaway negatives. */
const SATIETY_FLOOR = -100;
const SATIETY_CEIL  = 125;

/* The hunger ladder, top-down. The first entry whose `min` ≤ satiety wins.
 *
 *   effective    if false this tier is part of the "sated" baseline —
 *                tierForSatiety still returns its name for the sheet label,
 *                but the reconciler never creates an ActiveEffect for it.
 *   approachFrom which DIRECTION of satiety change fires the tier's
 *                onApply.stress (the relief / cost on entry). Top-of-ladder
 *                Gorged is approached by RISING satiety (eating up into it);
 *                the bottom tiers Hungry / Famished are approached by
 *                FALLING satiety (draining down into them). Stress only fires
 *                when the player CROSSES IN from the canonical side — eating
 *                up across Hungry on the way to Fed doesn't repay the +1
 *                stress cost, and draining down through Gorged into Full
 *                doesn't re-relieve. */
const HUNGER_TIERS = Object.freeze([
    { id: "gorged",   min: 101, effective: true,  approachFrom: "below" },
    { id: "full",     min:  76, effective: false },
    { id: "fed",      min:  51, effective: false },
    { id: "peckish",  min:  26, effective: false },
    { id: "hungry",   min:   1, effective: true,  approachFrom: "above" },
    { id: "famished", min: -Infinity, effective: true, approachFrom: "above" }
]);
const HUNGER_IDS = new Set(HUNGER_TIERS.map(t => t.id));
const EFFECTIVE_HUNGER_IDS = new Set(HUNGER_TIERS.filter(t => t.effective).map(t => t.id));
const TIER_BY_ID = new Map(HUNGER_TIERS.map(t => [t.id, t]));

/* The drunk ladder ids (drunk-1 .. drunk-8). */
const DRUNK_IDS = new Set([1,2,3,4,5,6,7,8].map(n => `drunk-${n}`));

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

/* Both schema shapes participate: the new `food` item type (canonical) and the
 * legacy `valuable` of subtype food-drink (read-only — pre-existing items).
 * For the food type, alcohol metadata is honored ONLY when kind === "drink"
 * — switching the kind away from drink suppresses the endurance roll even if
 * `drunk.isAlcohol` is still true on the persisted data, so a re-author or
 * accidental kind flip doesn't keep firing drunkenness. Restoring kind to
 * "drink" restores the behavior. */
export function isAlcohol(item) {
    if (!item) return false;
    if (item.type === "food") {
        if (item.system?.kind !== "drink") return false;
        return !!item.system?.drunk?.isAlcohol;
    }
    if (item.type === "valuable" && item.system?.type === "food-drink") {
        return !!item.system?.drunk?.isAlcohol;
    }
    return false;
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

/** Read the actor's current drunk level from their active statuses. */
export function getDrunkLevel(actor) {
    if (!actor?.statuses) return 0;
    let max = 0;
    for (const id of actor.statuses) {
        const m = /^drunk-(\d+)$/.exec(id);
        if (!m) continue;
        const n = Number(m[1]);
        if (n > max) max = n;
    }
    return max;
}

/** Peak drunk level reached this binge (max(prev, current); flag-tracked). */
export function getPeakDrunkLevel(actor) {
    return Math.max(
        getDrunkLevel(actor),
        Number(actor?.getFlag?.(SYSTEM_ID, PEAK_FLAG)) || 0
    );
}

/**
 * Apply (or replace) a drunk level on the actor. `level === 0` clears all
 * drunk effects and — when descending from a real binge — triggers the
 * hangover.
 *
 * When SOBERING (newLevel < current), the AE create suppresses `onApply.stress`
 * via the `wdmSkipOnApply` flag so descending back through a relief tier
 * doesn't pay the relief twice.
 */
export async function applyDrunkLevel(actor, level, iconOverride = "") {
    if (!actor) return;
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (!actor.isOwner && !game.user.isGM) return;

    level = Math.max(0, Math.min(8, Math.floor(Number(level) || 0)));
    const prev = getDrunkLevel(actor);
    if (prev === level) return;

    const descending = level < prev;
    // Track peak so soberUp can stamp the right hangover when we reach 0.
    if (!descending) {
        const peak = Math.max(getPeakDrunkLevel(actor), level);
        if (peak !== (Number(actor.getFlag(SYSTEM_ID, PEAK_FLAG)) || 0)) {
            await actor.setFlag(SYSTEM_ID, PEAK_FLAG, peak);
        }
    }

    // Remove any current drunk-N effects.
    const owned = actor.effects.filter(e => {
        for (const id of (e.statuses ?? [])) if (DRUNK_IDS.has(id)) return true;
        return false;
    });
    if (owned.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", owned.map(e => e.id));
    }

    if (level <= 0) {
        // Fell to sober — apply the hangover if the binge peaked at ≥ 3, then
        // clear the peak flag for the next round.
        const peak = getPeakDrunkLevel(actor);
        if (peak >= 3) await applyHangover(actor, peak);
        await actor.unsetFlag(SYSTEM_ID, PEAK_FLAG);
        return;
    }

    const id = `drunk-${level}`;
    const def = (CONFIG.statusEffects ?? []).find(s => s.id === id);
    if (!def) {
        console.warn(`${SYSTEM_ID} | drunk status ${id} is not registered — is the foodAndDrink toggle on?`);
        return;
    }
    // The engine has already pre-baked `changes` from the clause; we just hand
    // the entry over to Foundry's AE create with statuses set so engine hooks
    // see it. wdmSkipOnApply suppresses onApply.stress on descent.
    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:        def.name,
        img:         iconOverride || def.img,
        // Read the description LIVE so the stress toggle reflects current
        // state — the baked def.description is captured at init time, which
        // may pre-date the GM enabling stress without a reload.
        description: descriptionFor(id) || def.description,
        disabled:    false,
        statuses:    [id],
        changes:     def.changes ?? [],
        flags:       { [SYSTEM_ID]: { drunkLevel: level } }
    }], { wdmSkipOnApply: descending });
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

/**
 * Sober-up roll: 1d10 < BODY to drop one drunk level. On reaching 0 the
 * hangover lands (applyDrunkLevel handles it).
 */
export async function soberUp(actor) {
    if (!actor) return;
    if (!isHomebrewEnabled("foodAndDrink")) return;
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

/* ─────────── Hangover ───────────────────────────────────────────────────── */

/**
 * Stamp the hangover ActiveEffect on `actor`. REC penalty = ⌊peak/2⌋, lasting
 * ⌈peak/3⌉ in-game days. The clause's description carries the user-facing
 * blurb; the actual `changes` are computed per-actor here (since the penalty
 * depends on peak) so two actors with different binge peaks carry different
 * REC reductions.
 */
export async function applyHangover(actor, peak) {
    if (!actor) return;
    peak = Math.max(0, Math.floor(Number(peak) || 0));
    if (peak < 3) return;

    const recPenalty = Math.floor(peak / 2);
    const days       = Math.ceil(peak / 3);

    // Remove any in-flight hangover before stamping the new one — a fresh
    // binge resets the timer instead of stacking penalties.
    const existing = actor.effects.filter(e => e.getFlag(SYSTEM_ID, HANGOVER_FLAG));
    if (existing.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(e => e.id));
    }

    const def = (CONFIG.statusEffects ?? []).find(s => s.id === "hangover");
    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:        def?.name || "Hangover",
        img:         def?.img  || "icons/svg/sleep.svg",
        description: def?.description || "",
        disabled:    false,
        statuses:    ["hangover"],
        // REC lives in DERIVED_STAT_TARGETS → must land in the "final" phase
        // so it folds ON TOP of the BODY/WILL baseline character.prepareDerived
        // assigns, rather than being overwritten by it.
        changes: [{
            key: "system.derivedStats.rec",
            value: String(-recPenalty),
            type: "add",
            phase: "final",
            priority: 0
        }],
        flags: { [SYSTEM_ID]: {
            [HANGOVER_FLAG]: true,
            peak,
            recPenalty,
            daysRemaining: days
        } }
    }], { wdmSkipOnApply: true });   // hangover is not stress-bearing on apply
}

/**
 * Day-tick handler — every time the calendar crosses an in-game DATE boundary,
 * decrement `daysRemaining` on every hangover effect and delete the effect when
 * it hits zero. Active-GM-only.
 */
async function onWorldTimeDayTick(worldTime, delta) {
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (!game.user?.isActiveGM) return;
    if (!(Number(delta) > 0)) return;

    const dayLen = secondsPerDay();
    const now    = Math.floor(Number(worldTime)        / dayLen);
    const before = Math.floor((Number(worldTime) - Number(delta)) / dayLen);
    const dayDelta = now - before;
    if (dayDelta <= 0) return;

    for (const actor of game.actors) {
        for (const e of actor.effects) {
            if (!e.getFlag(SYSTEM_ID, HANGOVER_FLAG)) continue;
            const remaining = Number(e.getFlag(SYSTEM_ID, "daysRemaining")) || 0;
            const next = remaining - dayDelta;
            if (next <= 0) {
                await actor.deleteEmbeddedDocuments("ActiveEffect", [e.id]);
            } else {
                await e.setFlag(SYSTEM_ID, "daysRemaining", next);
            }
        }
    }
}

function secondsPerDay() {
    return Number(CONFIG.time?.calendar?.secondsPerDay) || 86400;
}

/* ─────────── Satiety ────────────────────────────────────────────────────── */

/** Tier id for a given satiety value. */
export function tierForSatiety(satiety) {
    const v = Math.floor(Number(satiety) || 0);
    for (const t of HUNGER_TIERS) if (v >= t.min) return t.id;
    return "famished";
}

/** Hourly drain per RAW spec: 1 + ⌈BODY/4⌉. */
export function hourlySatietyLoss(actor) {
    const body = Number(actor?.system?.stats?.body?.value) || 0;
    return 1 + Math.ceil(body / 4);
}

/**
 * Adjust `actor.system.satiety` by `delta` (clamped to [-100, 125]), then
 * reconcile the hunger status. `cause` is forwarded only to the reconcile call
 * so the chat message can read sensibly when needed.
 */
export async function adjustSatiety(actor, delta) {
    if (!actor) return;
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (actor.type !== "character") return;
    delta = Number(delta);
    if (!Number.isFinite(delta) || delta === 0) return;

    const cur = Number(actor.system?.satiety) || 0;
    const next = Math.max(SATIETY_FLOOR, Math.min(SATIETY_CEIL, cur + delta));
    if (next === cur) return;

    await actor.update({ "system.satiety": next });
    // The reconcile is best-effort: a stale CONFIG.statusEffects entry, a
    // race with another AE-delete, or any other edge that throws here
    // should not break the larger consume / tick flow that drove the
    // satiety change. Surface it via console.warn so the GM still sees the
    // signal without it surfacing as a UI error.
    try {
        await reconcileHungerStatus(actor, { prev: cur, next });
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | reconcileHungerStatus failed", err);
    }
}

/**
 * Swap the actor's hunger status to match satiety. Ascending into a new tier
 * (e.g. Peckish → Hungry as satiety drops) fires `onApply.stress` from the
 * clause via the standard engine hook. Descending out of a tier (eating to
 * climb back to Fed) suppresses the apply hook so we don't re-pay the gorged
 * stress relief on every meal that incidentally crosses the boundary.
 */
export async function reconcileHungerStatus(actor, { prev, next } = {}) {
    if (!actor) return;
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (!actor.isOwner && !game.user.isGM) return;

    const v = Number.isFinite(next) ? next : (Number(actor.system?.satiety) || 0);
    const targetId = tierForSatiety(v);
    // "Sated" tiers (full / fed / peckish) are the normal baseline — they get
    // a tier LABEL on the sheet but never an ActiveEffect. Only the impactful
    // tiers (gorged / hungry / famished) carry status effects.
    const targetIsEffective = EFFECTIVE_HUNGER_IDS.has(targetId);

    const ownedTier = actor.effects.filter(e => {
        for (const id of (e.statuses ?? [])) if (HUNGER_IDS.has(id)) return true;
        return false;
    });

    if (!targetIsEffective) {
        // Sated baseline — strip any leftover hunger AE and bail. No new AE.
        if (ownedTier.length) {
            await actor.deleteEmbeddedDocuments("ActiveEffect", ownedTier.map(e => e.id));
        }
        return;
    }

    const alreadyOnTarget = ownedTier.some(e => e.statuses?.has?.(targetId));
    if (alreadyOnTarget && ownedTier.length === 1) return;

    // Per-tier directional gate. Gorged fires its -2 stress relief only when
    // approached from BELOW (rising satiety / just ate). Hungry & Famished
    // fire their +1 stress cost only when approached from ABOVE (falling
    // satiety / drain). Crossings in the wrong direction suppress the hook
    // so the player doesn't pay a cost (or pocket a relief) on the bounce.
    const fireOnApply = (() => {
        const tier = TIER_BY_ID.get(targetId);
        if (!tier?.approachFrom || !Number.isFinite(prev)) return false;
        if (tier.approachFrom === "below") return v > prev;   // satiety rose
        if (tier.approachFrom === "above") return v < prev;   // satiety fell
        return false;
    })();

    if (ownedTier.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", ownedTier.map(e => e.id));
    }

    const def = (CONFIG.statusEffects ?? []).find(s => s.id === targetId);
    if (!def) return;
    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:        def.name,
        img:         def.img,
        // Live description so stress-on text matches the current toggle.
        description: descriptionFor(targetId) || def.description,
        disabled:    false,
        statuses:    [targetId],
        changes:     def.changes ?? [],
        flags:       { [SYSTEM_ID]: { hungerTier: targetId } }
    }], { wdmSkipOnApply: !fireOnApply });
}

/* Hourly satiety tick. Mirrors stamina-regen's absolute-boundary math so a
 * single 7-hour worldTime jump applies seven ticks, not one. */
async function onWorldTimeHourTick(worldTime, delta) {
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (!game.user?.isActiveGM) return;
    if (!(Number(delta) > 0)) return;

    const now    = Math.floor(Number(worldTime)              / 3600);
    const before = Math.floor((Number(worldTime) - Number(delta)) / 3600);
    const hours  = now - before;
    if (hours <= 0) return;

    for (const actor of game.actors) {
        if (actor.type !== "character") continue;
        if (actor.statuses?.has?.("dead")) continue;
        const loss = hourlySatietyLoss(actor) * hours;
        await adjustSatiety(actor, -loss);
    }
}

/* ─────────── Consume hook ───────────────────────────────────────────────── */

/**
 * Called from consumeMixin after the base quantity decrement (or BEFORE — see
 * below). Returns true if this mechanic handled the consume (so consumeMixin
 * skips its default decrement); false otherwise.
 *
 * Order on a food item with the toggle ON:
 *   1. Post `taste` to chat (player-facing flavor on consumption).
 *   2. Restore satiety by `satietyRestore` (no-op for non-food / 0).
 *   3. If charged: tick the charge counter (and signal handled=true so the
 *      mixin doesn't ALSO decrement quantity).
 *   4. If alcohol: fire the endurance check (additive — runs alongside).
 */
export async function onConsume(item) {
    if (!isHomebrewEnabled("foodAndDrink")) return false;
    let handled = false;

    if (item?.type === "food") {
        // Taste line — distinct from `description`, which stays the visual
        // layer per spec. Always announced even if there's no satiety/charge
        // side-effect, so the player sees what they're eating.
        const taste = String(item.system?.taste ?? "").trim();
        if (taste) {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: item.actor }),
                content: `<div style="border-left:3px solid #8b6f3a;padding:4px 8px">
                    <b>${item.actor?.name ?? "Someone"}</b> eats <b>${item.name}</b>.<br>
                    <i>${taste}</i>
                </div>`
            });
        }
        const restore = Number(item.system?.satietyRestore) || 0;
        if (restore > 0 && item.actor?.type === "character") {
            await adjustSatiety(item.actor, restore);
        }
        // Copy any authored ActiveEffects onto the consumer. Mirrors the
        // alchemical consumable pattern — effects live dormant on the item
        // (transfer:false from WitcherFoodSheet) and only apply on use.
        // Each copy is independent (no link back) so it lingers on its own
        // duration / persists indefinitely if no duration was authored.
        if (item.actor?.documentName === "Actor" && item.effects?.size) {
            const lingering = [];
            for (const eff of item.effects) {
                if (eff.disabled) continue;
                const data = eff.toObject();
                delete data._id;
                data.transfer = false;
                data.disabled = false;
                data.origin   = item.actor.uuid;
                lingering.push(data);
            }
            if (lingering.length) {
                try {
                    await item.actor.createEmbeddedDocuments("ActiveEffect", lingering);
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | food effect apply failed", err);
                }
            }
        }
    }

    // Alcohol roll BEFORE the charge tick — consumeOneCharge may delete
    // the item entirely (last charge of last unit), after which item.name
    // and item.system.drunk become stale references. Capturing the verb /
    // dc / level-jump here and running the roll first is safer than
    // hoisting state across the destructive update.
    if (isAlcohol(item)) {
        const cfg = getDrunkConfig(item);
        const actor = item.actor;
        const name = item.name;
        if (actor) await handleEnduranceRoll(actor, cfg, name);
    }
    if (isCharged(item)) {
        await consumeOneCharge(item);
        handled = true;
    }
    return handled;
}

/* ─────────── Combat STA → satiety drain ─────────────────────────────────── */

/**
 * Called from combatRoundMixin.spendStamina after the STA write. Drains 0.5
 * satiety per STA spent — only while combat is running and only when the
 * homebrew toggle is on. Centralizing here keeps the rule editable from one
 * place (a GM houseruling 1.0/STA or 0.25/STA edits a single constant).
 */
export async function onCombatStaminaSpend(actor, staSpent) {
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (!actor || actor.type !== "character") return;
    if (!(Number(staSpent) > 0)) return;
    if (!game.combat?.started) return;
    await adjustSatiety(actor, -COMBAT_SATIETY_PER_STA * Number(staSpent));
}

export const COMBAT_SATIETY_PER_STA = 0.5;

/* ─────────── Hook registration ──────────────────────────────────────────── */

/**
 * Sync the description copy of every existing drunk / hunger / hangover
 * ActiveEffect to match the CURRENT stress-toggle state. Descriptions are
 * captured on the AE document at create time, so an already-applied Gorged
 * effect keeps its old text until something rewrites it — toggling stress on
 * or off (which forces a world reload) without this sweep leaves a stale
 * "clears 2 STRESS" line on Gorged AEs from before the toggle change.
 *
 * Active-GM-only writer. Idempotent: skips effects whose description already
 * matches `descriptionFor(id)`.
 */
async function syncFoodAndDrinkEffectDescriptions() {
    if (!game.user?.isActiveGM) return;
    if (!isHomebrewEnabled("foodAndDrink")) return;
    for (const actor of game.actors ?? []) {
        const updates = [];
        for (const e of actor.effects ?? []) {
            const ids = e.statuses ?? new Set();
            let id = null;
            for (const sid of ids) {
                if (DRUNK_IDS.has(sid) || HUNGER_IDS.has(sid) || sid === "hangover") {
                    id = sid;
                    break;
                }
            }
            if (!id) continue;
            const want = descriptionFor(id);
            if (!want || want === e.description) continue;
            updates.push({ _id: e.id, description: want });
        }
        if (updates.length) {
            try {
                await actor.updateEmbeddedDocuments("ActiveEffect", updates);
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | syncFoodAndDrinkEffectDescriptions failed", err);
            }
        }
    }
}

/**
 * Wire the recurring food-and-drink hooks. Called from setup/hooks.mjs at
 * setup. All handlers self-check the homebrew toggle so flipping it OFF stops
 * the ticks within one game.settings.set without a reload (the status
 * REGISTRATION still requires reload — Foundry caches CONFIG.statusEffects).
 */
export function registerFoodAndDrink() {
    Hooks.on("updateWorldTime", onWorldTimeHourTick);
    Hooks.on("updateWorldTime", onWorldTimeDayTick);

    // Stress toggle has requiresReload:true → the world reloads on flip, so
    // by the time `ready` fires the new toggle state is live. Sweep every
    // existing drunk / hunger / hangover AE on load and rewrite descriptions
    // so they match the current toggle — otherwise pre-existing effects keep
    // their stale (stress-on or stress-off) text indefinitely.
    Hooks.once("ready", () => {
        // Defer to next tick so other ready handlers (like the api wiring) win
        // the race for actor preparation if they need to.
        Promise.resolve().then(() => syncFoodAndDrinkEffectDescriptions());
    });

    // GM-ONLY edit lock on satiety. Players have actor ownership for the
    // update flow (HP, STA, etc.) — without this gate they could rewrite the
    // satiety pool from the API even if the sheet hides the input. The system
    // mechanics themselves drive satiety through adjustSatiety() which runs on
    // the active GM client, so this only blocks DIRECT player edits.
    //
    // We don't block the tick / consume / combat-spend paths because those
    // already run on the active GM only (see the active-GM gates in
    // onWorldTimeHourTick and adjustSatiety's caller path).
    Hooks.on("preUpdateActor", (actor, changes, options, userId) => {
        if (changes?.system?.satiety === undefined) return;
        const user = game.users?.get(userId);
        if (user?.isGM) return;
        // Silently drop the satiety change rather than failing the whole
        // update — a player edit may legitimately bundle other fields.
        delete changes.system.satiety;
        ui?.notifications?.warn?.("Satiety is GM-edited only.");
    });

    // GM-side reconcile when the GM edits satiety directly on the sheet
    // (otherwise the hunger status doesn't refresh until the next hourly
    // tick). The pre-update gate above ensures only GM writes reach here.
    // We're not in the hourly-loss path so no `prev` is tracked — we just
    // re-apply the matching tier and suppress the onApply stress hook so a
    // manual nudge doesn't fire breakdown saves.
    Hooks.on("updateActor", async (actor, changes) => {
        if (!isHomebrewEnabled("foodAndDrink")) return;
        if (!game.user?.isActiveGM) return;
        if (actor.type !== "character") return;
        if (changes?.system?.satiety === undefined) return;
        await reconcileHungerStatus(actor, { /* no prev → ascending=false → no stress */ });
    });
}

/* ─────────── Public API ─────────────────────────────────────────────────── */

export const foodAndDrinkApi = Object.freeze({
    // Charges
    isCharged, getCharges, getChargeRatio, consumeOneCharge,
    // Drunk
    isAlcohol, getDrunkConfig, getDrunkLevel, getPeakDrunkLevel,
    applyDrunkLevel, handleEnduranceRoll, soberUp,
    // Hangover
    applyHangover,
    // Satiety
    tierForSatiety, hourlySatietyLoss, adjustSatiety, reconcileHungerStatus,
    COMBAT_SATIETY_PER_STA,
    // Hooks
    onConsume, onCombatStaminaSpend,
    // Tier ids (for external readers, e.g. inventory panels)
    HUNGER_TIERS, DRUNK_IDS
});
