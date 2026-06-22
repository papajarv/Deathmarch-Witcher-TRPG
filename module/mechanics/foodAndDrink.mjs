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
import { getFoodAndDrinkConfig } from "../applications/foodAndDrinkConfig.mjs";

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

/* Per-id in-flight delete tracker. Foundry's local actor.effects collection
 * is mutated by `#handleDeleteDocuments` AFTER the server confirms a delete
 * — i.e., the doc stays in actor.effects.get(id) until the socket roundtrip
 * resolves. That window is exactly long enough for a SECOND delete to pass
 * the `actor.effects?.get?.(id)` liveness check, queue another socket request
 * for the same id, and have the server reject it with `ActiveEffect "X" does
 * not exist!` (surfaced as a red toast via SocketInterface#handleError →
 * ui.notifications.error). Coalescing by id closes that window: if a delete
 * for the same id is already in flight, the second caller awaits the same
 * promise instead of sending a duplicate request. Key is `actorId|effectId`
 * so the same id on two different actors isn't conflated. */
const _inFlightDeletes = new Map();

/* Defensive delete helper. Two layers of safety:
 *   1) ID dedup (above) — never send overlapping delete requests for the same
 *      embedded doc, which is the root cause of the "does not exist!" toast.
 *   2) Liveness re-filter + try/catch — covers the case where Foundry's local
 *      collection has been mutated since the caller computed the id list (a
 *      concurrent foreign delete the chrome's hooks observed), so we don't
 *      submit obviously-stale ids and any throw that still slips through just
 *      console.warn's instead of red-toasting. */
async function safeDeleteEffects(actor, ids) {
    if (!actor || !Array.isArray(ids) || !ids.length) return;
    const live = ids.filter(id => actor.effects?.get?.(id));
    if (!live.length) return;

    // Split into ids we own the delete for vs ids that someone else is
    // already deleting. For the latter, await the existing promise instead
    // of sending another request — the duplicate is what causes the server
    // "ActiveEffect ... does not exist!" race.
    const toSend = [];
    const piggyback = [];
    for (const id of live) {
        const key = `${actor.id}|${id}`;
        if (_inFlightDeletes.has(key)) piggyback.push(_inFlightDeletes.get(key));
        else toSend.push(id);
    }

    let myPromise = null;
    if (toSend.length) {
        myPromise = actor.deleteEmbeddedDocuments("ActiveEffect", toSend);
        for (const id of toSend) _inFlightDeletes.set(`${actor.id}|${id}`, myPromise);
        // Clean up tracker entries once the request settles, regardless of
        // outcome. A failed request still mutates server state, so retrying
        // wouldn't help — clear and move on.
        myPromise.finally(() => {
            for (const id of toSend) _inFlightDeletes.delete(`${actor.id}|${id}`);
        });
    }

    try {
        if (myPromise) await myPromise;
        if (piggyback.length) await Promise.allSettled(piggyback);
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | swallowed stale-effect delete", err);
    }
}

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
    // Peckish is a warning tier — no stat changes, no stress on entry, but it
    // DOES land as a visible status on the actor so the player gets a heads-up
    // that Hungry is coming. No `approachFrom` → wdmSkipOnApply will always
    // be true (no spurious stress firings either direction).
    { id: "peckish",  min:  26, effective: true },
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
 * Decrement one charge from a stack.
 *
 *   qty === 1, current > 1   → just decrement charges on the document.
 *   qty === 1, current === 1 → delete the item entirely (last sip gone).
 *   qty  >  1, current > 1   → SPLIT: peel one unit off the stack into a
 *                              separate document with the partial charge,
 *                              leave the remainder at full charges. Without
 *                              this split, drinking from a stack of 3 full
 *                              bottles would visually drop all 3 to 4/5
 *                              because they share one document's state.
 *   qty  >  1, current === 1 → the now-empty top unit is consumed; drop
 *                              quantity by 1 and reset charges to max on the
 *                              remaining stack (the "next" bottle is full).
 */
export async function consumeOneCharge(item) {
    if (!isCharged(item)) return;
    const c   = getCharges(item);
    const max = c.max;
    const qty = Number(item.system?.quantity) || 1;

    if (c.current > 1) {
        const next = c.current - 1;
        if (qty <= 1) {
            return item.update({ "system.charges.current": next });
        }
        // Split: original stack becomes qty-1 with full charges; new
        // qty=1 document carries the partial. The new document is placed
        // on the same parent (actor or world) the original lives on.
        await item.update({ "system.quantity": qty - 1 });
        const data = item.toObject();
        delete data._id;
        data.system = { ...(data.system ?? {}), quantity: 1 };
        data.system.charges = { ...(data.system.charges ?? {}), current: next };
        const parent = item.parent;
        if (parent?.documentName === "Actor") {
            await parent.createEmbeddedDocuments("Item", [data]);
        } else {
            // World-template consume (rare path) — fall back to Item.create.
            await Item.create(data);
        }
        return;
    }

    // c.current === 1 — consuming the last sip of the top unit.
    if (qty <= 1) return item.delete();
    return item.update({
        "system.quantity": qty - 1,
        "system.charges.current": max
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
        isAlcohol:  !!d.isAlcohol,
        dc:         Number.isFinite(d.dc) ? d.dc : 10,
        levelJump:  Number.isFinite(d.levelJump) ? d.levelJump : 1,
        flavorVerb: d.flavorVerb || "drinks",
        effectIcon: d.effectIcon || ""
    };
}

/**
 * True if any active (non-disabled, non-suppressed) ActiveEffect on `actor`
 * carries an action of type "alcoholRollAdvantage" — the data-driven witcher-
 * resistance perk. Hooked to whatever the GM ties it to (Witcher race item, a
 * specific perk, a magical token, etc.) instead of the old hard-coded
 * profession-name regex.
 */
export function hasAlcoholRollAdvantage(actor) {
    const all = actor?.allApplicableEffects?.();
    if (!all) return false;
    for (const e of all) {
        if (e.disabled || e.system?.isSuppressed) continue;
        const actions = e.flags?.[SYSTEM_ID]?.actions;
        if (!Array.isArray(actions)) continue;
        for (const a of actions) {
            if (a?.type === "alcoholRollAdvantage") return true;
        }
    }
    return false;
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
export async function applyDrunkLevel(actor, level, iconOverride = "", opts = {}) {
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
            try { await actor.setFlag(SYSTEM_ID, PEAK_FLAG, peak); }
            catch (err) { console.warn(`${SYSTEM_ID} | peak flag set failed`, err); }
        }
    }

    // Remove any current drunk-N effects.
    const owned = actor.effects.filter(e => {
        for (const id of (e.statuses ?? [])) if (DRUNK_IDS.has(id)) return true;
        return false;
    });
    await safeDeleteEffects(actor, owned.map(e => e.id));

    if (level <= 0) {
        // Fell to sober — apply the hangover if the binge peaked at ≥ 3, then
        // clear the peak flag for the next round. Forward the optional
        // `soberAt` from the caller so the hangover's duration anchors to
        // when sobriety actually happened in-game rather than to the moment
        // applyDrunkLevel runs (which on a big time skip is the END of the
        // skip, hours after the real sober moment).
        const peak = getPeakDrunkLevel(actor);
        if (peak >= 3) {
            try { await applyHangover(actor, peak, { soberAt: opts.soberAt }); }
            catch (err) { console.warn(`${SYSTEM_ID} | applyHangover failed`, err); }
        }
        try { await actor.unsetFlag(SYSTEM_ID, PEAK_FLAG); }
        catch (err) { console.warn(`${SYSTEM_ID} | peak flag unset failed`, err); }
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
    // see it. wdmSkipOnApply suppresses onApply.stress on descent. Wrapped in
    // try/catch — Foundry occasionally surfaces "id does not exist in the
    // EmbeddedCollection" if a concurrent worldTime listener (chrome tick
    // engine, stamina-regen) deletes a doc we just touched. Swallowing keeps
    // the cascade going; the worst case is the outer sweep's backfill catches
    // the next tick.
    try {
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
            // 1 in-game hour. When it expires, the worldTime sweep runs an
            // automatic sober check (1d10 < BODY) — pass drops the level by 1,
            // fail resets the duration for another hour.
            duration:    { seconds: 3600, startTime: game.time?.worldTime ?? 0 },
            flags:       { [SYSTEM_ID]: { drunkLevel: level } }
        }], { wdmSkipOnApply: descending });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | drunk AE create failed`, err);
    }
}

/**
 * Roll Endurance vs DC after consuming alcohol. The bearer rolls TWICE and
 * keeps the best when they carry an ActiveEffect with the
 * `alcoholRollAdvantage` action (data-driven witcher-resistance perk,
 * authored on the Witcher race / a profession perk / a magical token —
 * whatever the GM wires the action onto in the AE editor).
 *
 * On failure, raises drunk level by `levelJump`.
 */
export async function handleEnduranceRoll(actor, cfg, itemName = "drink") {
    if (!actor) return;
    if (!isHomebrewEnabled("foodAndDrink")) return;

    const advantage = hasAlcoholRollAdvantage(actor);
    const rollOnce = async () => {
        const v = actor._readSkillValues?.("endurance");
        const formula = v ? `1d10 + ${v.total}` : "1d10";
        const r = await new Roll(formula).evaluate();
        return r.total;
    };
    const a = await rollOnce();
    const b = advantage ? await rollOnce() : null;
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
 * Stamp the hangover ActiveEffect on `actor`.
 *
 * Threshold + numbers (current ruleset):
 *   - Peak < 3  → no hangover. Two beers in didn't leave a mark.
 *   - Peak 3   → REC penalty = 3, duration half a day (12 hours).
 *   - Peak 4–6 → REC penalty = `peak`, duration 1 day.
 *   - Peak 7–8 → REC penalty = `peak`, duration 2 days.
 *
 * Example: a peak-4 binge gives −4 REC for 1 day; a peak-8 binge gives
 * −8 REC for 2 days. The penalty is severe by design — bottoming out REC
 * means the character can't recover any HP from rest for the duration.
 */
export async function applyHangover(actor, peak, opts = {}) {
    if (!actor) return;
    peak = Math.max(0, Math.floor(Number(peak) || 0));
    if (peak < 3) return;

    const recPenalty = peak;
    // Fractional days are intentional — Foundry duration.seconds is just a
    // number, so 0.5 × 86400 = 12-hour Hangover lands naturally and the
    // sweep deletes it as soon as remaining ≤ 0.
    const days = peak === 3 ? 0.5
               : peak >= 7  ? 2
                            : 1;
    // Anchor — when the auto-sober cascade fires the hangover during a big
    // time skip, the caller passes `soberAt` (the in-game time the actor
    // hit drunk-0 mid-cascade, NOT the end of the skip). Use that so the
    // hangover's countdown reflects elapsed hangover time, not the moment
    // applyHangover happened to run. Fallback: current worldTime.
    const rawSoberAt = Number(opts.soberAt);
    const nowWT      = Number(game.time?.worldTime) || 0;
    const startTime  = Number.isFinite(rawSoberAt) ? rawSoberAt : nowWT;

    // Remove any in-flight hangover before stamping the new one — a fresh
    // binge resets the timer instead of stacking penalties.
    const existing = actor.effects.filter(e => e.getFlag(SYSTEM_ID, HANGOVER_FLAG));
    await safeDeleteEffects(actor, existing.map(e => e.id));

    const def = (CONFIG.statusEffects ?? []).find(s => s.id === "hangover");
    // Compose a per-actor description with PEAK-SCALED flavor + the actual
    // mechanic line. The static clause description is the medium-tier blurb;
    // peak 3 gets something milder, peak 7-8 gets something brutal, so a
    // light hangover doesn't sound like the apocalypse and a Drunk-VIII
    // hangover doesn't sound like a mild headache.
    const flavor = hangoverFlavor(peak);
    const dayLabel = days === 0.5 ? "half a day"
                   : days === 1   ? "1 day"
                                  : `${days} days`;
    const dynamicDesc = `${flavor} <b>−${recPenalty} REC for ${dayLabel}.</b>`;
    // Wrapped in try/catch — same race-with-concurrent-worldTime-listeners
    // concern as the drunk AE create above. If a stale-id throw escapes from
    // somewhere in the validate/preCreate chain, log it instead of red-toasting.
    try { await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:        def?.name || "Hangover",
        img:         def?.img  || "systems/witcher-ttrpg-death-march/assets/icons/statuses/hangover.svg",
        description: dynamicDesc,
        disabled:    false,
        statuses:    ["hangover"],
        // Flat REC penalty applied to the displayed stat. REC lives in
        // DERIVED_STAT_TARGETS → must land in the "final" phase so it folds
        // ON TOP of the BODY/WILL baseline character.prepareDerived assigns
        // (otherwise prepareDerived's write would clobber it).
        changes: [{
            key: "system.derivedStats.rec",
            value: String(-recPenalty),
            type: "add",
            phase: "final",
            priority: 0
        }],
        // Native Foundry duration in in-game seconds. The worldTime sweep
        // deletes the AE once `remaining <= 0`, so the player sees the
        // hangover wear off the morning of recovery automatically. Flags
        // still record the source values for display / debugging.
        //
        // startTime uses the backdated anchor (see opts.soberAt above) when
        // the cascade fires this from an auto-sober that crossed mid-skip,
        // so the hangover's countdown reflects elapsed-since-sober rather
        // than elapsed-since-cascade-finished.
        duration: { seconds: days * secondsPerDay(), startTime },
        flags: { [SYSTEM_ID]: {
            [HANGOVER_FLAG]: true,
            peak,
            // Stored for telemetry / future macros; the actual penalty
            // applies via the `changes` array above (flat AE on displayed REC).
            recPenalty,
            days
        } }
    }], { wdmSkipOnApply: true }); }   // hangover is not stress-bearing on apply
    catch (err) { console.warn(`${SYSTEM_ID} | hangover AE create failed`, err); }
}

/**
 * Sweep expired drunk & hangover AEs on every worldTime advance.
 *
 *   - Hangover AEs auto-delete when their native duration runs out.
 *   - Drunk AEs trigger an AUTOMATIC sober check (1d10 < BODY) when their
 *     1-hour timer expires:
 *       • pass → drop the level by 1 (applyDrunkLevel handles the AE swap,
 *                  which itself starts a fresh 1-hour timer for the lower
 *                  tier, or triggers the hangover when reaching 0).
 *       • fail → reset the duration for another hour and post a brief
 *                 chat note so the table knows.
 *
 * Active-GM-only so multi-client sessions don't double-fire.
 */
async function onWorldTimeFoodDrinkSweep(worldTime, delta) {
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (!game.user?.isActiveGM) return;
    if (!(Number(delta) > 0)) return;

    // The whole sweep is wrapped in try/catch at three nesting levels — top,
    // per-actor, per-effect — so a single bad document never surfaces a red
    // "undefined id does not exist in the EmbeddedCollection collection" toast.
    // Foundry's hook caller doesn't catch promise rejections that escape an
    // async listener, so anything that escapes lands in the unhandled-promise
    // pipeline. We log to console.warn instead and keep iterating.
    try {
        for (const actor of game.actors) {
            try {
                if (actor.type !== "character") continue;
                // Snapshot the earliest drunk AE's startTime BEFORE the
                // per-effect loop touches anything. If the cascade fails
                // mid-way and the backfill block has to land the hangover
                // itself, we use this to compute a reasonable backdated
                // sober anchor (start + level * 3600 — i.e., assume every
                // hour's roll succeeded, which is the optimistic floor and
                // still much better than "now").
                let earliestDrunkStart = null;
                let earliestDrunkLevel = 0;
                for (const e of actor.effects) {
                    for (const sid of (e.statuses ?? [])) {
                        const m = /^drunk-(\d+)$/.exec(sid);
                        if (!m) continue;
                        const start = Number(e.duration?.startTime);
                        if (Number.isFinite(start) && (earliestDrunkStart === null || start < earliestDrunkStart)) {
                            earliestDrunkStart = start;
                            earliestDrunkLevel = Number(m[1]) || 0;
                        }
                    }
                }
                // Copy the iteration so deletes inside the loop don't skip entries.
                for (const e of [...actor.effects]) {
                    try {
                        // The previous iteration may have triggered applyDrunkLevel
                        // / applyHangover (which delete + recreate AEs on the same
                        // actor), OR a concurrent updateWorldTime listener (chrome
                        // tick engine, stamina regen) may have deleted the doc.
                        // Re-verify the live collection before touching anything.
                        if (!actor.effects.get(e.id)) continue;
                        const remaining = Number(e.duration?.remaining);
                        if (!Number.isFinite(remaining) || remaining > 0) continue;

                        // Hangover expiry — just delete (stale-safe).
                        if (e.getFlag(SYSTEM_ID, HANGOVER_FLAG)) {
                            await safeDeleteEffects(actor, [e.id]);
                            continue;
                        }

                        // Drunk expiry — figure out the tier from the status set.
                        let level = null;
                        for (const sid of (e.statuses ?? [])) {
                            const m = /^drunk-(\d+)$/.exec(sid);
                            if (m) { level = Number(m[1]); break; }
                        }
                        if (level == null) continue;

                        await runAutoSoberCheck(actor, e, level);
                    } catch (err) {
                        console.warn("witcher-ttrpg-death-march | sweep per-effect error", err);
                    }
                }

                // After processing each actor, GUARANTEE a hangover if the
                // peak flag is still set and there are no drunk effects left.
                // This catches the cascade case where runAutoSoberCheck's loop
                // dropped the actor all the way to 0 but an internal throw
                // somewhere before applyHangover prevented it from firing.
                try {
                    const peak = Number(actor.getFlag?.(SYSTEM_ID, PEAK_FLAG)) || 0;
                    if (peak >= 3 && getDrunkLevel(actor) === 0) {
                        const hasHangover = actor.effects.some(e => e.getFlag(SYSTEM_ID, HANGOVER_FLAG));
                        if (!hasHangover) {
                            // Use the captured earliest drunk start + the
                            // hours it would have taken to fully sober as
                            // the optimistic sober anchor. Without this,
                            // the hangover would be created with startTime
                            // = current worldTime (the END of a big skip),
                            // even though the actor in-fiction sobered up
                            // hours ago.
                            const backfillSoberAt = (earliestDrunkStart !== null && earliestDrunkLevel > 0)
                                ? earliestDrunkStart + earliestDrunkLevel * 3600
                                : undefined;
                            await applyHangover(actor, peak, backfillSoberAt !== undefined ? { soberAt: backfillSoberAt } : {});
                            await actor.unsetFlag(SYSTEM_ID, PEAK_FLAG);
                        }
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | sweep hangover backfill error", err);
                }
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | sweep per-actor error", err);
            }
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | sweep top-level error", err);
    }
}

/**
 * Auto sober check at duration expiry. Handles BIG worldTime jumps (GM sets
 * the date / advances multiple days) by running one roll per FULL hour past
 * expiry — so skipping a day at level Drunk VIII fires up to 24 rolls and the
 * actor sobers down accordingly.
 *
 *   pass → drop a level (applyDrunkLevel handles the AE swap + sets a fresh
 *          1-hour timer; reaching 0 fires the hangover via the existing path).
 *   fail → stay at the same level; consume an hour from the budget.
 *
 * After the loop, if the actor's still drunk the surviving AE's duration is
 * re-anchored to start fresh from NOW (so the next 1-hour countdown is honest).
 */
async function runAutoSoberCheck(actor, effect, startLevel) {
    // Top-level catch so any unhandled error inside the cascade can't escape
    // and surface as a red Foundry toast. The outer sweep already has a
    // backfill that guarantees a hangover lands when the actor reaches 0
    // drunk level with a high peak flag.
    try {
        return await _runAutoSoberCheckImpl(actor, effect, startLevel);
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | runAutoSoberCheck top-level", err);
    }
}

async function _runAutoSoberCheckImpl(actor, effect, startLevel) {
    // Guard: the effect may have been deleted by a concurrent updateWorldTime
    // listener (chrome tick-effects sweep, another foodAndDrink iteration)
    // between the outer sweep's snapshot read and this call. If it's already
    // gone, there's nothing to update or roll against — bail silently.
    if (!actor.effects?.get?.(effect.id)) return;

    const remaining = Number(effect.duration?.remaining);
    // 1 roll for the just-expired hour, plus one per full additional hour
    // the worldTime advanced past expiry. Clamp upward sanity at 24 (a full
    // day) so a year-long skip can't lock the game in a roll loop.
    const overdue   = Number.isFinite(remaining) ? Math.max(0, -remaining) : 0;
    const hoursToProcess = Math.min(24, 1 + Math.floor(overdue / 3600));

    // Capture the ORIGINAL drunk AE's startTime — used to backdate the
    // hangover when the actor sobers mid-cascade. Each sober roll
    // conceptually consumes the in-game hour FROM that anchor, so a player
    // who got drunk at midnight and sobered after 5 hours of rolls during
    // a 24-hour skip should see their hangover starting at 5am, not at the
    // 24-hour end of the skip.
    const originalStartTime = Number(effect.duration?.startTime) || (game.time?.worldTime ?? 0);

    let level = startLevel;
    const rollLog = [];
    const body = Number(actor.system?.stats?.body?.value) || 0;
    let soberAt = null;

    for (let i = 0; i < hoursToProcess && level > 0; i++) {
        const roll = await new Roll("1d10").evaluate();
        const pass = roll.total < body;
        rollLog.push({ roll: roll.total, pass, levelBefore: level });
        if (pass) {
            // If this pass will cross to drunk-0, pre-compute the sober
            // anchor (in-game time the actor actually hit 0) and pass it
            // down so applyHangover's create-time duration.startTime lands
            // correctly the FIRST time, rather than being patched
            // after-the-fact. Iteration 0 consumes the first hour of the
            // cascade, so after `i+1` hours we're sober.
            const willHitZero = (level - 1) === 0;
            const passOpts = willHitZero
                ? { soberAt: originalStartTime + (i + 1) * 3600 }
                : {};
            if (willHitZero) soberAt = passOpts.soberAt;
            try { await applyDrunkLevel(actor, level - 1, "", passOpts); }
            catch (err) { console.warn("witcher-ttrpg-death-march | auto sober apply failed", err); }
            level -= 1;
        }
        // Failure simply consumes the hour — `level` and the effect stay.
    }

    // Belt-and-braces backdate. The cascade above threads soberAt into
    // applyHangover at create-time, so the hangover SHOULD already be
    // anchored correctly. This block only fixes things up if a throw inside
    // applyDrunkLevel skipped the threaded path AND a hangover still landed
    // through the outer sweep's backfill — in that case it was created with
    // a default startTime (current worldTime) and we patch it down here.
    if (soberAt !== null && soberAt < (game.time?.worldTime ?? 0)) {
        const hangoverAE = actor.effects.find(e => e.getFlag(SYSTEM_ID, HANGOVER_FLAG));
        const currentStart = Number(hangoverAE?.duration?.startTime);
        if (hangoverAE && Number.isFinite(currentStart) && currentStart > soberAt) {
            try {
                if (actor.effects?.get?.(hangoverAE.id)) {
                    await hangoverAE.update({ "duration.startTime": soberAt });
                }
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | hangover backdate failed", err);
            }
        }
    }

    // Still drunk at a level we DIDN'T descend out of → the original AE is
    // still on the actor (in theory). Re-anchor its timer so the next
    // 1-hour countdown starts from now, not from the long-ago original
    // start — but ONLY if the document is actually still alive in the
    // collection. Concurrent worldTime listeners can have wiped it between
    // the loop's last iteration and now, and effect.update() would then
    // throw "<undefined> id [...] does not exist in the EmbeddedCollection
    // collection". The existence check + try/catch make that a silent no-op.
    if (level === startLevel) {
        if (!actor.effects?.get?.(effect.id)) {
            return; // doc gone — nothing to reset, no error to surface
        }
        try {
            await effect.update({
                "duration.startTime": Number(game.time?.worldTime) || 0,
                "duration.seconds":   3600
            });
        } catch (err) { console.warn("witcher-ttrpg-death-march | auto sober reset failed", err); }
    }

    // One consolidated chat note. Bulks multi-hour runs into a single line
    // instead of 24 separate messages on a big jump.
    try {
        const passes = rollLog.filter(r => r.pass).length;
        const fails  = rollLog.length - passes;
        const verdict = level === 0
            ? `<b style="color:#4a7c59">sobers all the way up.</b>`
            : level < startLevel
                ? `<b style="color:#4a7c59">drops to Drunk ${roman(level)}.</b>`
                : `<b style="color:#8b0000">still Drunk ${roman(level)}. Riding it out.</b>`;
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div style="border-left:3px solid #6f8b3a;padding:4px 8px">
                <b>${actor.name}</b> — automatic sober roll${hoursToProcess > 1 ? `s × ${hoursToProcess}` : ""} vs BODY <b>${body}</b>.<br>
                ${passes} pass${passes === 1 ? "" : "es"} / ${fails} fail${fails === 1 ? "" : "s"} — ${verdict}
            </div>`
        });
    } catch (_) { /* chat message is informational only */ }
}

function secondsPerDay() {
    return Number(CONFIG.time?.calendar?.secondsPerDay) || 86400;
}

/**
 * Peak-scaled hangover flavor text. Three tiers so a Drunk-III sleep-in
 * doesn't read like the apocalypse and a Drunk-VIII bender doesn't read like
 * a mild headache. The mechanic line (the −N REC for X days) is appended
 * separately by applyHangover; this just supplies the descriptive blurb.
 */
function hangoverFlavor(peak) {
    if (peak <= 3) {
        return "Hangover — a dull ache behind the eyes and a heavy mouth. You'll be back to yourself before the sun sets.";
    }
    if (peak <= 6) {
        return "Hangover — paying for last night. Your head's pounding, your stomach's in a knot, and every REC roll feels like climbing out of a well. Sleep it off.";
    }
    // peak 7-8 — the lethal-tier binge aftermath
    return "Hangover — existence is suffering. Light is an assault, sound a punishment, and the very thought of food is offensive. Every breath reminds you of the choices that brought you here. You are not getting out of bed unless someone drags you out.";
}

/* ─────────── Satiety ────────────────────────────────────────────────────── */

/** Tier id for a given satiety value. Reads the GM-configurable thresholds
 *  out of the foodAndDrinkConfig setting (defaults match the original spec). */
export function tierForSatiety(satiety) {
    const v = Math.floor(Number(satiety) || 0);
    const cfg = getFoodAndDrinkConfig().hungerTiers;
    if (v >= cfg.gorged)  return "gorged";
    if (v >= cfg.full)    return "full";
    if (v >= cfg.fed)     return "fed";
    if (v >= cfg.peckish) return "peckish";
    if (v >= cfg.hungry)  return "hungry";
    return "famished";
}

/** Hourly drain. Defaults to RAW spec (1 + ⌈BODY/4⌉) but honors the GM's
 *  config tweaks to the base + BODY divisor AND any per-actor
 *  `satietyDrain.{scale,flatPerHour}` modifiers folded in by ActiveEffects.
 *
 *  Formula: `((base + ⌈BODY/divisor⌉) × scale) + flatPerHour`.
 *  Scale defaults to 1.0 (no change); flatPerHour defaults to 0.
 *  Result clamps at 0 — an effect can't make satiety actively RISE through
 *  the drain path, only stop it. */
export function hourlySatietyLoss(actor) {
    const body = Number(actor?.system?.stats?.body?.value) || 0;
    const { base, bodyDivisor } = getFoodAndDrinkConfig().decay;
    const divisor = Math.max(1, Number(bodyDivisor) || 4);
    const baseLoss = Math.max(0, Number(base) || 0) + Math.ceil(body / divisor);
    const scale = Number(actor?.system?.satietyDrain?.scale);
    const flat  = Number(actor?.system?.satietyDrain?.flatPerHour);
    const safeScale = Number.isFinite(scale) ? Math.max(0, scale) : 1;
    const safeFlat  = Number.isFinite(flat)  ? flat                : 0;
    return Math.max(0, baseLoss * safeScale + safeFlat);
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

    // Flag the write as INTERNAL so the updateActor reconcile hook skips it.
    // Without this, the hook races against our own explicit reconcile below
    // and both calls run with empty `ownedTier` snapshots — spawning two
    // hunger-tier AEs (the user-reported "two Famished" bug). The hook is
    // still needed for GM manual edits on the sheet, which carry no flag.
    await actor.update({ "system.satiety": next }, { wdmSatietyInternal: true });
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

/* Famished-depth stress — reversible debt model. Each band INSIDE Famished
 * (band 1: [−25,−1], band 2: [−50,−26], band 3: [−75,−51], band 4: [−100,−76])
 * carries one point of "starvation debt". The actor's CURRENT depth IS the
 * debt:
 *   sat ≥ 0   → depth 0
 *   sat ≥ −25 → depth 1
 *   sat ≥ −50 → depth 2
 *   sat ≥ −75 → depth 3
 *   else      → depth 4
 *
 * Descending one band → +1 stress; ascending one band → −1 stress (relief).
 * Going from sat 0 to sat −100 grants +4 stress; eating back to 0 refunds
 * all 4. We persist the stored debt as a flag so we never double-grant or
 * over-refund across sessions / multiple updates. Stress floors at 0 in
 * setStress, so refunding more than the actor currently carries can't go
 * negative — that's the natural behavior of an actor whose stress already
 * came down from other sources. */
const FAMISHED_DEBT_FLAG = "famishedDepthDebt";

function famishedDepthFor(satiety) {
    if (!Number.isFinite(satiety)) return 0;
    if (satiety >=   0) return 0;
    if (satiety >= -25) return 1;
    if (satiety >= -50) return 2;
    if (satiety >= -75) return 3;
    return 4;
}

async function applyFamishedDepthStress(actor, prev, next) {
    if (!actor || actor.type !== "character") return;
    if (!game.user?.isActiveGM) return;
    if (!isHomebrewEnabled("stress")) return;
    if (!Number.isFinite(prev) || !Number.isFinite(next)) return;

    const prevDepth = famishedDepthFor(prev);
    const nextDepth = famishedDepthFor(next);
    if (prevDepth === nextDepth) return;          // no band change → no stress

    // Stored debt — what the system has put on the actor. Lazy init to the
    // pre-change depth: an actor who enters tracking already deep in Famished
    // is treated as "already owed" — we don't retroactively dump 4 stress on
    // them, but ascending out will still refund the implicit debt.
    const rawFlag = actor.getFlag(SYSTEM_ID, FAMISHED_DEBT_FLAG);
    const storedDebt = Number.isFinite(Number(rawFlag)) ? Number(rawFlag) : prevDepth;
    const delta = nextDepth - storedDebt;

    try {
        if (delta !== 0) {
            const { grantStress } = await import("./stress.mjs");
            await grantStress(actor, delta);
        }
        await actor.setFlag(SYSTEM_ID, FAMISHED_DEBT_FLAG, nextDepth);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | famished-depth stress failed`, err);
        return;
    }
    if (delta === 0) return;                       // synced silently — no chat

    // Chat feedback. Color + verb flip on direction; the breakdown save card
    // (stress.mjs) follows separately if the new total crosses WILL.
    try {
        const ascending = delta < 0;
        const verb  = ascending ? "starvation eases off"        : "starvation gnaws deeper";
        const color = ascending ? "#4a7c59"                     : "#6b3f3f";
        const sign  = ascending ? ""                            : "+";
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div style="border-left:3px solid ${color};padding:4px 8px">
                <b>${actor.name}</b> — ${verb} (satiety now <b>${Math.round(next)}</b>).
                <b>${sign}${delta} stress</b>.
            </div>`
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | famished-depth chat failed`, err);
    }
}

/* Intermediate-tier stress walk. When a single satiety update crosses
 * multiple hunger tier boundaries (e.g., Full → Famished in one jump), the
 * reconciler creates only the FINAL tier's AE and so only fires that tier's
 * onApply.stress hook — Hungry's +1 entry cost gets silently skipped. Walk
 * the tiers strictly BETWEEN prev and next, fire `onApply.stress` for each
 * that has `approachFrom` matching the direction of travel. Target tier
 * (the one whose AE is created) is excluded; sated tiers (no approachFrom)
 * are naturally skipped. */
async function applyIntermediateTierStress(actor, prev, next) {
    if (!actor || actor.type !== "character") return;
    if (!game.user?.isActiveGM) return;
    if (!isHomebrewEnabled("stress")) return;
    if (!Number.isFinite(prev) || !Number.isFinite(next)) return;
    const prevTier = tierForSatiety(prev);
    const nextTier = tierForSatiety(next);
    if (prevTier === nextTier) return;
    const prevIdx = HUNGER_TIERS.findIndex(t => t.id === prevTier);
    const nextIdx = HUNGER_TIERS.findIndex(t => t.id === nextTier);
    if (prevIdx < 0 || nextIdx < 0) return;
    // HUNGER_TIERS is ordered top-down (gorged=0 … famished=5). Descending
    // satiety means moving to a higher index. The direction the *intermediate*
    // tiers are approached from is "above" for descent (we're entering each
    // from a satiety value above it) and "below" for ascent.
    const direction = nextIdx > prevIdx ? "above" : "below";
    const start = Math.min(prevIdx, nextIdx);
    const end   = Math.max(prevIdx, nextIdx);
    let stressDelta = 0;
    const fired = [];
    for (let i = start + 1; i < end; i++) {          // strictly between
        const tier = HUNGER_TIERS[i];
        if (tier.approachFrom !== direction) continue;
        const s = Number(clauseFor(tier.id)?.onApply?.stress);
        if (!Number.isFinite(s) || s === 0) continue;
        stressDelta += s;
        fired.push({ id: tier.id, s });
    }
    if (stressDelta === 0) return;
    try {
        const { grantStress } = await import("./stress.mjs");
        await grantStress(actor, stressDelta);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | intermediate tier stress failed`, err);
        return;
    }
    try {
        const sign  = stressDelta > 0 ? "+" : "";
        const color = stressDelta > 0 ? "#6b3f3f" : "#4a7c59";
        const list = fired.map(f => {
            const cap = f.id.charAt(0).toUpperCase() + f.id.slice(1);
            const fs  = f.s > 0 ? `+${f.s}` : String(f.s);
            return `<b>${cap}</b> (${fs})`;
        }).join(", ");
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div style="border-left:3px solid ${color};padding:4px 8px">
                <b>${actor.name}</b> — passed through ${list}.
                <b>${sign}${stressDelta} stress</b>.
            </div>`
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | intermediate tier chat failed`, err);
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

    // Famished-depth stress: while satiety is below 0, every additional −25
    // crossed on the way down grants +1 stress. Fired BEFORE the tier
    // reconcile so it lands even when the actor stays inside Famished
    // (e.g. −30 → −60 doesn't change tier but still crosses −50). Gated on
    // descent so eating back up out of starvation doesn't refund the cost.
    await applyFamishedDepthStress(actor, prev, next);

    // Intermediate-tier stress: a satiety jump that crosses MULTIPLE hunger
    // tier boundaries in one update only instantiates the final tier's AE,
    // so the per-tier onApply.stress on intermediate tiers (Hungry's +1 on
    // descent, etc.) would otherwise silently disappear. Walk the strictly-
    // between tiers and fire their stress directly here.
    await applyIntermediateTierStress(actor, prev, next);

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
        await safeDeleteEffects(actor, ownedTier.map(e => e.id));
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

    await safeDeleteEffects(actor, ownedTier.map(e => e.id));

    const def = (CONFIG.statusEffects ?? []).find(s => s.id === targetId);
    if (!def) return;
    // Per-tier flag enrichment. Gorged adds a healing-only REC bonus the
    // heal dialog reads (the displayed REC stat is intentionally left alone
    // — the bonus reflects the full belly powering daily recovery, not a
    // general stat shift).
    const tierFlags = { hungerTier: targetId };
    if (targetId === "gorged") tierFlags.healingRecBonus = 2;

    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:        def.name,
        img:         def.img,
        // Live description so stress-on text matches the current toggle.
        description: descriptionFor(targetId) || def.description,
        disabled:    false,
        statuses:    [targetId],
        changes:     def.changes ?? [],
        flags:       { [SYSTEM_ID]: tierFlags }
    }], { wdmSkipOnApply: !fireOnApply });

    // Clamp current STA down to the new max. Hungry / Famished shrink sta.max
    // via the engine's `staMaxFraction` aggregate (read at prepareDerivedData
    // time), so by the time createEmbeddedDocuments resolves the actor's
    // prepared sta.max reflects the new ceiling. If the player was sitting at
    // 45 STA and the new max is 23, they should land at 23/23 — not 45/23,
    // which reads as broken. No-op when max grew (eating back into a sated
    // tier) since the floor here is the unchanged current value.
    try {
        const sta = actor.system?.derivedStats?.sta;
        const curVal = Number(sta?.value);
        const curMax = Number(sta?.max);
        if (Number.isFinite(curVal) && Number.isFinite(curMax) && curVal > curMax) {
            await actor.update({ "system.derivedStats.sta.value": curMax });
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | hunger STA clamp failed", err);
    }
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

/* Spoilage transition detector. Freshness state is derived from worldTime,
 * so a time advance can flip an item from Fresh / Stale → Spoiled without
 * any document update firing. Walk every actor's food items once per advance;
 * for each tracked item, compute what its state WAS at the start of the
 * window vs what it is now. If it just crossed into Spoiled (and the actor
 * is alive), post a chat message so the player isn't surprised the next time
 * they try to eat it. GM-only writer so multi-client sessions don't double-post. */
async function onWorldTimeFreshnessSweep(worldTime, delta) {
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (!game.user?.isActiveGM) return;
    const d = Number(delta);
    if (!(d > 0)) return;
    const now    = Number(worldTime);
    const before = now - d;
    const spd    = secondsPerDay();
    for (const actor of game.actors ?? []) {
        if (actor.type !== "character" && actor.type !== "loot") continue;
        const justSpoiled = [];
        for (const item of (actor.items ?? [])) {
            if (item.type !== "food") continue;
            const days = Number(item.system?.freshness?.shelfLifeDays) || 0;
            if (days <= 0) continue;
            const anchorRaw = item.system?.freshness?.anchorTime;
            if (anchorRaw == null) continue;
            const anchor = Number(anchorRaw);
            if (!Number.isFinite(anchor)) continue;
            const wasRatio = (before - anchor) / spd / days;
            const nowRatio = (now    - anchor) / spd / days;
            // Only fire on the *transition* into spoiled (≥ 1.0). A repeat
            // skip on already-spoiled food shouldn't re-spam the chat.
            if (wasRatio < 1 && nowRatio >= 1) justSpoiled.push(item);
        }
        if (!justSpoiled.length) continue;
        try {
            const lines = justSpoiled.map(it => `<li><b>${it.name}</b></li>`).join("");
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<div style="border-left:3px solid #a83232;padding:4px 8px">
                    <b>${actor.name}</b> — food has spoiled:
                    <ul style="margin:4px 0 0 14px;padding:0;">${lines}</ul>
                </div>`
            });
        } catch (err) {
            console.warn(`${SYSTEM_ID} | spoilage announcement failed`, err);
        }
    }
}

/* ─────────── Freshness / Spoilage ───────────────────────────────────────── */

/* Three-state freshness ladder driven by elapsed in-game time since the
 * acquisition anchor. Thresholds are fractions of the item's shelfLifeDays
 * budget — see getFreshnessState. Untracked items (shelfLifeDays === 0 or
 * sidebar-only) always read FRESH so the consume / inventory paths stay
 * inert for RAW items the GM hasn't authored a shelf life for. */
export const FRESHNESS_STALE_THRESHOLD = 0.75;
/* Hazard the actor rolls against when consuming spoiled food. Fail =
 * Food Sickness status for the duration below. Hardcoded for v1; promote
 * to FoodAndDrinkConfig if GMs want to tune. */
const SPOILED_HAZARD_DC      = 14;
const FOOD_SICKNESS_DAYS     = 1;

/**
 * Read the item's effective freshness state. Pure derivation — no writes.
 *
 *   "untracked"  the GM never authored a shelf life, OR the item lives in
 *                the world template (sidebar) and was never acquired.
 *   "fresh"      acquired and consumed less than 75% of its shelf life.
 *   "stale"      75-100% elapsed. Still edible, full satiety; the chat
 *                line and inventory glyph warn the player it's borderline.
 *   "spoiled"    past its shelf life. Consume gives 0 satiety and rolls
 *                Endurance vs SPOILED_HAZARD_DC; fail = Food Sickness.
 */
export function getFreshnessState(item) {
    if (item?.type !== "food") return "untracked";
    const days = Number(item?.system?.freshness?.shelfLifeDays) || 0;
    if (days <= 0) return "untracked";
    // `Number(null)` is 0 (a finite number), so a null anchor would slip past
    // an isFinite-only check and read as "anchored at worldTime 0" — that
    // makes every un-acquired food item read as massively spoiled. Reject
    // null/undefined explicitly BEFORE coercing.
    const anchorRaw = item?.system?.freshness?.anchorTime;
    if (anchorRaw == null) return "untracked";
    const anchor = Number(anchorRaw);
    if (!Number.isFinite(anchor)) return "untracked";
    const now = Number(game.time?.worldTime) || 0;
    const elapsedDays = (now - anchor) / secondsPerDay();
    if (elapsedDays < 0) return "fresh";              // anchor in the future, treat as fresh
    const ratio = elapsedDays / days;
    if (ratio >= 1)                          return "spoiled";
    if (ratio >= FRESHNESS_STALE_THRESHOLD)  return "stale";
    return "fresh";
}

/**
 * Days remaining before the item crosses into the next worse state. Used by
 * the sheet readout ("Spoils in X days") and the inventory tooltip. Returns
 * `null` for untracked items so the caller can hide the readout entirely.
 */
export function getFreshnessDaysRemaining(item) {
    if (item?.type !== "food") return null;
    const days = Number(item?.system?.freshness?.shelfLifeDays) || 0;
    if (days <= 0) return null;
    // Same null-trap as getFreshnessState — Number(null) is 0, so reject
    // null/undefined explicitly before the isFinite coerce.
    const anchorRaw = item?.system?.freshness?.anchorTime;
    if (anchorRaw == null) return null;
    const anchor = Number(anchorRaw);
    if (!Number.isFinite(anchor)) return null;
    const now = Number(game.time?.worldTime) || 0;
    const elapsedDays = Math.max(0, (now - anchor) / secondsPerDay());
    return Math.max(0, days - elapsedDays);
}

/**
 * Stamp the freshness anchor when food first lands on an actor. Idempotent:
 * if `anchorTime` is already set (transferred between actors, picked back up
 * from sidebar with prior anchor), the existing value is preserved so the
 * food doesn't reset. GM-only writer to keep multi-client sessions from
 * racing on the same stamp.
 */
async function stampFreshnessAnchor(item) {
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (item?.type !== "food") return;
    if (!(item.parent instanceof Actor)) return;
    const days = Number(item.system?.freshness?.shelfLifeDays) || 0;
    if (days <= 0) return;                         // GM hasn't authored a shelf life — skip
    // Same null-trap as getFreshnessState: `Number(null)` is 0 (finite), so
    // an isFinite-only check thinks a null anchor is "already set" and bails
    // before the stamp ever lands. That made every drag-from-sidebar leave
    // the item un-anchored forever. Reject null/undefined explicitly first.
    const existingRaw = item.system?.freshness?.anchorTime;
    if (existingRaw != null && Number.isFinite(Number(existingRaw))) return;
    if (!game.user?.isActiveGM) return;
    try {
        await item.update({ "system.freshness.anchorTime": Number(game.time?.worldTime) || 0 });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | freshness anchor stamp failed`, err);
    }
}

/**
 * Resolve the spoiled-food hazard. Endurance roll vs SPOILED_HAZARD_DC; on
 * failure, apply a 24-hour Food Sickness AE (−2 STA max, mild roll penalty).
 * Posted as a chat message either way so the table sees the outcome.
 */
async function applySpoiledHazard(actor, itemName) {
    if (!actor) return;
    const dc = SPOILED_HAZARD_DC;
    let total;
    try {
        const v = actor._readSkillValues?.("endurance");
        const formula = v ? `1d10 + ${v.total}` : "1d10";
        total = (await new Roll(formula).evaluate()).total;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | spoiled-food endurance roll failed`, err);
        return;
    }
    const pass = total >= dc;
    const flavor = pass
        ? `<b style="color:#4a7c59">stomach holds.</b>`
        : `<b style="color:#8b0000">food sickness sets in.</b>`;
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div style="border-left:3px solid #6b3f3f;padding:4px 8px">
            <b>${actor.name}</b> swallowed spoiled <b>${itemName}</b>.<br>
            Endurance ${total} vs DC ${dc} — ${flavor}
        </div>`
    });
    if (pass) return;

    // Fail: apply Food Sickness AE for FOOD_SICKNESS_DAYS in-game days.
    const def = (CONFIG.statusEffects ?? []).find(s => s.id === "food-sickness");
    const existing = actor.effects.filter(e => e.statuses?.has?.("food-sickness"));
    await safeDeleteEffects(actor, existing.map(e => e.id));
    try {
        await actor.createEmbeddedDocuments("ActiveEffect", [{
            name:        def?.name || "Food Sickness",
            img:         def?.img  || "systems/witcher-ttrpg-death-march/assets/icons/statuses/food-sickness.svg",
            description: descriptionFor("food-sickness") || def?.description || "Food sickness from spoiled food.",
            disabled:    false,
            statuses:    ["food-sickness"],
            changes:     def?.changes ?? [],
            duration:    { seconds: FOOD_SICKNESS_DAYS * secondsPerDay(), startTime: Number(game.time?.worldTime) || 0 }
        }]);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | food-sickness AE create failed`, err);
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
        // Ingredient gate. Raw ingredients (kind === "ingredient") follow
        // their own consume rules:
        //   - not edible & not sickening → refuse the consume outright (you
        //     can't just chew a raw onion at the GM's discretion).
        //   - makesSick → route through the spoiled-food hazard regardless
        //     of edibility; the quantity still ticks down.
        //   - edible → proceed to the standard satiety / effects / taste
        //     path below, exactly like a meal would.
        // Falls through to the regular food path when kind isn't "ingredient",
        // so meals and drinks are unaffected.
        const isIngredient = item.system?.kind === "ingredient";
        if (isIngredient) {
            const edible    = !!item.system?.ingredient?.edible;
            const makesSick = !!item.system?.ingredient?.makesSick;
            if (!edible && !makesSick) {
                ui?.notifications?.info?.(
                    `${item.name} is a raw ingredient — not for eating as-is.`
                );
                return true;   // handled — block the default quantity decrement
            }
            if (makesSick && item.actor) {
                await applySpoiledHazard(item.actor, item.name);
                // If ALSO edible, fall through to satiety/effects/taste
                // below. If not edible, the only side effect is the hazard
                // plus the base quantity tick — return without handled so
                // the base mixin still decrements the unit.
                if (!edible) return false;
            }
        }
        // Spoilage gate. Fresh & stale items proceed as normal (stale just
        // appends a heads-up chip in the chat line further down). Spoiled
        // items zero out satiety, skip the taste line + alcohol roll, and
        // route the eater through the spoiled-food hazard. Charge tick still
        // runs so the spoiled portion is consumed (it has to go SOMEWHERE).
        const freshState = getFreshnessState(item);
        if (freshState === "spoiled" && item.actor) {
            await applySpoiledHazard(item.actor, item.name);
            if (isCharged(item)) {
                await consumeOneCharge(item);
                handled = true;
            }
            return handled;
        }
        // Hoisted so the already-full guard and the actual adjustment lower
        // down both see the same value without a second declaration.
        const restore = Number(item.system?.satietyRestore) || 0;
        // Already-full guard. Only refuse the consume when the actor is
        // ALREADY at the ceiling (125). If they're below 125, the consume
        // goes through and adjustSatiety clamps to 125 — so a 20-satiety
        // bite at 120 fills them to 125 instead of being refused for the
        // overflow. Drinks aren't exempt (chugging a mead at max satiety
        // still hits the wall); drinks with `satietyRestore: 0` still go
        // through at any value because they're not pushing anything.
        if (restore > 0 && item.actor?.type === "character") {
            const cur = Number(item.actor.system?.satiety) || 0;
            if (cur >= SATIETY_CEIL) {
                const verb = item.system?.kind === "drink" ? "drink" : "eat";
                const more = item.system?.kind === "drink" ? "another sip" : "another bite";
                ui?.notifications?.info?.(
                    `${item.actor.name} is too full to ${verb} ${item.name}.`
                );
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: item.actor }),
                    content: `<div style="border-left:3px solid #8b6f3a;padding:4px 8px">
                        <b>${item.actor.name}</b> is too stuffed for ${more} of <b>${item.name}</b>.
                    </div>`
                });
                return true;   // handled — skip the default decrement
            }
        }
        // Taste line — distinct from `description`, which stays the visual
        // layer per spec. Always announced even if there's no satiety/charge
        // side-effect, so the player sees what they're eating. Stale items
        // append a one-liner warning so the player has a clear signal the
        // next portion will tip into spoiled.
        const taste = String(item.system?.taste ?? "").trim();
        if (taste) {
            const staleLine = freshState === "stale"
                ? `<div style="margin-top:4px;color:#8b6f3a;"><i>(starting to turn — eat it soon)</i></div>`
                : "";
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: item.actor }),
                content: `<div style="border-left:3px solid #8b6f3a;padding:4px 8px">
                    <b>${item.actor?.name ?? "Someone"}</b> eats <b>${item.name}</b>.<br>
                    <i>${taste}</i>${staleLine}
                </div>`
            });
        }
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
                // Safety net for legacy data: the BASE item sheet's
                // _onCreateEffect used to default new effects' name to the
                // item's name. That meant eating "Mead" stamped a "Mead" AE
                // on the actor, which reads more like the item than its
                // effect. Strip that auto-default down to a neutral fallback
                // — the GM can rename on the food sheet to anything else.
                if (data.name === item.name) data.name = "Effect";
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
    // Rate is GM-configurable; defaults to 0.5 satiety per 1 STA spent.
    // The per-actor `satietyDrain.scale` (from ActiveEffects) folds in here
    // too — an Iron Stomach perk that halves hourly drain also halves the
    // combat-STA burn for symmetry.
    const rate = Number(getFoodAndDrinkConfig().decay.combatStaPerUnit);
    const baseRate = Number.isFinite(rate) ? rate : 0.5;
    const scale = Number(actor?.system?.satietyDrain?.scale);
    const safeScale = Number.isFinite(scale) ? Math.max(0, scale) : 1;
    await adjustSatiety(actor, -baseRate * safeScale * Number(staSpent));
}

// Default rate, kept exported for back-compat with macros / chat-bot tools
// that referenced the constant; the LIVE rate is read at fire time from the
// foodAndDrinkConfig setting (see onCombatStaminaSpend).
export const COMBAT_SATIETY_PER_STA = 0.5;

/* ─────────── Hook registration ──────────────────────────────────────────── */

/**
 * createActiveEffect hook handler — when an effect carrying a
 * `clearHangover` action lands on a character, delete every hangover AE the
 * actor has. Source effect is left in place (cleanup is the responsibility of
 * its own duration / manual removal). Active-GM-only to avoid duplicate writes
 * in a multi-client session.
 */
async function onCreateActiveEffectClearHangover(effect /*, options, userId */) {
    if (!game.user?.isActiveGM) return;
    const actor = effect?.parent;
    if (!actor || actor.documentName !== "Actor") return;
    if (actor.type !== "character") return;
    const actions = effect.flags?.[SYSTEM_ID]?.actions;
    if (!Array.isArray(actions) || !actions.some(a => a?.type === "clearHangover")) return;

    const hangovers = actor.effects.filter(e => e.getFlag(SYSTEM_ID, HANGOVER_FLAG));
    if (!hangovers.length) return;
    await safeDeleteEffects(actor, hangovers.map(e => e.id));
    try {
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div style="border-left:3px solid #4a7c59;padding:4px 8px">
                <b>${actor.name}</b> shakes off the hangover. (<i>${effect.name}</i> clears it.)
            </div>`
        });
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | clearHangover chat failed", err);
    }
}

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
 * Mute red-toast spam from a specific Foundry race during worldTime advance.
 *
 * Symptom: when the player skips an hour with a drunk / hangover / weather AE
 * on an actor, Foundry surfaces `ui.notifications.error("undefined id [X] does
 * not exist in the EmbeddedCollection collection.")`. The data layer is fine —
 * the AE got deleted by ONE worldTime listener (ours, or chrome's tick engine,
 * or Foundry's own expiry sweep) milliseconds before a concurrent listener
 * tried to touch the same id. Every food-and-drink delete is already wrapped in
 * `safeDeleteEffects` (filter + try/catch) and every create is wrapped too, so
 * the throw is escaping from a code path we don't control (Foundry's own
 * deleteEmbeddedDocuments validation, fired from a concurrent listener). The
 * toast is cosmetic noise — the actor's state is consistent.
 *
 * Strategy: intercept ui.notifications.error ONCE at registration time, and
 * shunt this specific stale-id error pattern to console.warn instead of the
 * UI. All other error toasts pass through untouched. Idempotent — re-running
 * registerFoodAndDrink (HMR / re-init) doesn't double-wrap.
 *
 * Pattern is deliberately broad: matches any "id [X] does not exist" across
 * any embedded collection (ActiveEffect, Item, PlaylistSound...) since the
 * race exists for all of them on time advance. The id-bracketed form is
 * specific enough that we won't accidentally swallow unrelated errors.
 */
function installStaleEmbeddedIdErrorMute() {
    // Two error formats slip through depending on which side notices first:
    //
    //   CLIENT (embedded-collection.mjs:227)
    //     `undefined id [X] does not exist in the EmbeddedCollection collection.`
    //     Thrown locally by #preDeleteDocumentArray / #preUpdateDocumentArray
    //     when our caller's id list is already stale on this client.
    //
    //   SERVER (dist/database/backend/server-backend.mjs)
    //     `ActiveEffect "X" does not exist!`
    //     Thrown server-side when the request reaches the database after a
    //     concurrent delete from us (or another client) already removed it.
    //     Surfaced via SocketInterface#handleError → ui.notifications.error.
    //
    // Both are races, both have the same fix (caller no-ops on stale id), and
    // both are cosmetic — by the time the toast fires, the actor is in the
    // intended state. Combined regex matches EITHER format, anchored on the
    // shapes specific to embedded-doc id staleness so other legitimate
    // "X does not exist" messages (User lookups, Region targets, etc.) pass
    // through to the UI unchanged.
    const PATTERN = new RegExp(
        "(?:" +
        // Client: ` id [X] does not exist in the <Collection> collection.`
        "\\sid\\s\\[[^\\]]+\\]\\s+does\\s+not\\s+exist\\s+in\\s+the\\s+\\S+\\s+collection" +
        "|" +
        // Server: `<Type> "X" does not exist!`
        "^\\s*[A-Z][A-Za-z]+\\s+\"[^\"]+\"\\s+does\\s+not\\s+exist\\b" +
        ")",
        "i"
    );
    const wrap = () => {
        const notif = globalThis.ui?.notifications;
        if (!notif?.error || notif.__wdmStaleIdMuteInstalled) return;
        notif.__wdmStaleIdMuteInstalled = true;
        const orig = notif.error.bind(notif);
        notif.error = function(msg, ...rest) {
            const text = (msg && typeof msg === "object" && msg.message) ? msg.message : String(msg ?? "");
            if (PATTERN.test(text)) {
                // Capture a stack trace at the suppression point so we can
                // pin the actual escape route on repro. The Foundry strict-get
                // throw is at common/abstract/embedded-collection.mjs:227 (a
                // get(id, {strict:true}) called from
                // client-backend.mjs:209 #preUpdateDocumentArray OR
                // client-backend.mjs:359 #preDeleteDocumentArray). Every food/
                // drink delete and update path is wrapped in try/catch — if
                // this fires, an unwrapped path exists somewhere. The stack
                // below is the only way to find it.
                const stack = new Error("wdm-suppress-stack").stack;
                console.error(`${SYSTEM_ID} | STALE-EMBEDDED-ID RACE (paste this stack):\n` +
                              `  message: ${text}\n` +
                              `  worldTime: ${game.time?.worldTime ?? "n/a"}\n` +
                              `  active GM: ${game.users?.activeGM?.name ?? "n/a"}\n` +
                              `  stack:\n${stack}`);
                if (msg instanceof Error) {
                    console.error(`${SYSTEM_ID} | original throw stack:\n${msg.stack}`);
                }
                return null;
            }
            return orig(msg, ...rest);
        };
    };
    // Notifications may not exist yet at setup — wrap immediately if available,
    // otherwise defer to ready (which is when ui.notifications is guaranteed
    // to be live). Both paths are idempotent via the install flag.
    wrap();
    Hooks.once("ready", wrap);

    // Cross-check: also trap window-level unhandled promise rejections so we
    // catch the case where the throw escapes through a path that never goes
    // through ui.notifications.error at all. Foundry doesn't install its own
    // rejection handler, so a promise rejection from inside an async hook
    // listener that didn't try/catch becomes an unhandled rejection. Logging
    // here surfaces the originating stack — that's the actual fix target.
    if (typeof globalThis.addEventListener === "function"
        && !globalThis.__wdmStaleIdRejectionHook) {
        globalThis.__wdmStaleIdRejectionHook = true;
        globalThis.addEventListener("unhandledrejection", (ev) => {
            const reason = ev?.reason;
            const text = (reason && typeof reason === "object" && reason.message)
                ? reason.message
                : String(reason ?? "");
            if (!PATTERN.test(text)) return;
            console.error(`${SYSTEM_ID} | UNHANDLED STALE-EMBEDDED-ID rejection:\n` +
                          `  message: ${text}\n` +
                          `  worldTime: ${game.time?.worldTime ?? "n/a"}\n` +
                          `  stack:\n${reason?.stack ?? "(no stack)"}`);
            // Stop the rejection from re-surfacing through other channels —
            // we've logged it, and the data layer is consistent.
            ev.preventDefault?.();
        });
    }
}

/**
 * Wire the recurring food-and-drink hooks. Called from setup/hooks.mjs at
 * setup. All handlers self-check the homebrew toggle so flipping it OFF stops
 * the ticks within one game.settings.set without a reload (the status
 * REGISTRATION still requires reload — Foundry caches CONFIG.statusEffects).
 */
export function registerFoodAndDrink() {
    installStaleEmbeddedIdErrorMute();
    Hooks.on("updateWorldTime", onWorldTimeHourTick);
    // Replaces the legacy `onWorldTimeDayTick` (which decremented a
    // daysRemaining flag manually). Now hangover & drunk both have native
    // Foundry duration; this sweep deletes hangover AEs and runs the
    // auto-sober check on expired drunk AEs.
    Hooks.on("updateWorldTime", onWorldTimeFoodDrinkSweep);
    // Announce food spoilage transitions in chat the moment they happen
    // (rather than waiting for the player to open inventory).
    Hooks.on("updateWorldTime", onWorldTimeFreshnessSweep);

    // Data-driven hangover cure — any effect authored with a `clearHangover`
    // action wipes every hangover AE off the bearer the moment it lands.
    Hooks.on("createActiveEffect", onCreateActiveEffectClearHangover);

    // Freshness anchor: stamp the worldTime the first time a food item lands
    // on an actor (drag from sidebar / compendium / created via recipe).
    // The hook fires on both first-acquisition and inter-actor transfers,
    // but stampFreshnessAnchor is idempotent (anchored items pass through),
    // so transferred food carries its existing age correctly.
    Hooks.on("createItem", (item) => { stampFreshnessAnchor(item); });
    // Also stamp on update: when the GM sets shelfLifeDays > 0 on an existing
    // actor-borne food item (the usual authoring path — you don't usually
    // know an item should spoil until after you've put it on a character),
    // there's no `createItem` to anchor against. Watch the field change and
    // anchor in-place.
    Hooks.on("updateItem", (item, changes) => {
        if (!foundry.utils.hasProperty(changes, "system.freshness.shelfLifeDays")) return;
        stampFreshnessAnchor(item);
    });
    // One-time backfill sweep at ready: any actor-borne food that already
    // carries shelfLifeDays > 0 but no anchor (authored before the feature,
    // or via a path that bypassed both hooks above) gets anchored to now.
    // GM-only to keep multi-client sessions from racing on the same stamp.
    Hooks.once("ready", () => {
        if (!game.user?.isActiveGM) return;
        if (!isHomebrewEnabled("foodAndDrink")) return;
        for (const actor of game.actors ?? []) {
            for (const item of (actor.items ?? [])) {
                stampFreshnessAnchor(item);
            }
        }
    });

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
    // satiety pool from the API even if the sheet hides the input.
    //
    // Internal mechanic writes (consume, combat-STA spend, hourly tick) flow
    // through adjustSatiety, which stamps `wdmSatietyInternal: true` on the
    // update. Those bypass the gate so a player consuming food doesn't get
    // their own satiety change stripped just because they're not the GM.
    Hooks.on("preUpdateActor", (actor, changes, options, userId) => {
        if (changes?.system?.satiety === undefined) return;
        if (options?.wdmSatietyInternal) return;
        const user = game.users?.get(userId);
        if (!user?.isGM) {
            // Silently drop the satiety change rather than failing the whole
            // update — a player edit may legitimately bundle other fields.
            delete changes.system.satiety;
            ui?.notifications?.warn?.("Satiety is GM-edited only.");
            return;
        }
        // GM edit. Stash the CURRENT (pre-update) satiety value on `options`
        // so the post-update reconcile can read it as `prev` and apply the
        // tier-cross stress in the right direction. Foundry shares the
        // options object across pre/update/onUpdate phases, so this is a
        // side-channel-free handoff (no per-actor Map to leak across edits).
        // Without this, every GM edit lands with prev=undefined → fireOnApply
        // is false (line 917) → wdmSkipOnApply: true → the onApply.stress
        // hook NEVER fires for GM manual edits, either gain or relief.
        const cur = Number(actor.system?.satiety);
        if (Number.isFinite(cur)) options.wdmSatietyPrev = cur;
    });

    // GM-side reconcile when the GM edits satiety directly on the sheet
    // (otherwise the hunger status doesn't refresh until the next hourly
    // tick). The pre-update gate above ensures only GM writes reach here
    // AND stashes the old satiety as `options.wdmSatietyPrev` so this
    // reconcile fires the proper direction-gated onApply stress.
    //
    // Internal writes from adjustSatiety carry options.wdmSatietyInternal so
    // we skip them here — adjustSatiety runs its own reconcile with the full
    // prev/next pair and would otherwise race with this hook (two reconciles
    // each spawning a hunger AE).
    Hooks.on("updateActor", async (actor, changes, options) => {
        if (options?.wdmSatietyInternal) return;
        if (!isHomebrewEnabled("foodAndDrink")) return;
        if (!game.user?.isActiveGM) return;
        if (actor.type !== "character") return;
        if (changes?.system?.satiety === undefined) return;
        const prev = Number(options?.wdmSatietyPrev);
        const next = Number(actor.system?.satiety) || 0;
        await reconcileHungerStatus(
            actor,
            Number.isFinite(prev) ? { prev, next } : { next }
        );
    });
}

/* ─────────── Public API ─────────────────────────────────────────────────── */

export const foodAndDrinkApi = Object.freeze({
    // Charges
    isCharged, getCharges, getChargeRatio, consumeOneCharge,
    // Drunk
    isAlcohol, getDrunkConfig, getDrunkLevel, getPeakDrunkLevel,
    hasAlcoholRollAdvantage,
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
