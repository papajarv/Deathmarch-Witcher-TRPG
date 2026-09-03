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
import { grantStress, getWill } from "./stress.mjs";
import { getFoodAndDrinkConfig } from "../applications/foodAndDrinkConfig.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Per-binge peak drunk level. Lives in actor flags so it survives reloads and
 * stays per-actor. Cleared when the hangover is applied. */
const PEAK_FLAG = "peakDrunkLevel";
/* Hangover marker — the day-tick handler scans for this flag on AEs and
 * decrements daysRemaining each in-game date crossing. */
const HANGOVER_FLAG = "hangover";

/** Strongest alcohol resistance across all race items on the actor. Values:
 *  "none" | "half" | "full". Full > half > none. Missing race items → "none". */
export function alcoholResistanceOf(actor) {
    const races = (actor?.items ?? []).filter(i => i?.type === "race");
    let out = "none";
    for (const r of races) {
        const v = r?.system?.alcoholResistance;
        if (v === "full") return "full";
        if (v === "half") out = "half";
    }
    return out;
}

/** Seconds per drunk-AE tick, given the actor's resistance. Default 3600 (1h). */
export function drunkTickSeconds(actor) {
    switch (alcoholResistanceOf(actor)) {
        case "full": return 900;   // 15 min
        case "half": return 1800;  // 30 min
        default:     return 3600;  // 1 hour
    }
}

/** Multiplier applied to base hangover duration. */
export function hangoverDurationFactor(actor) {
    switch (alcoholResistanceOf(actor)) {
        case "full": return 0.25;
        case "half": return 0.5;
        default:     return 1;
    }
}
/* Bland-diet stack tracker. The count lives ON an ActiveEffect attached
 * to the actor so it's visible in the character-sheet effects bar — the AE
 * name renders as e.g. "Bland Diet — 3/6 sittings" and updates each portion.
 * Created on first POOR+blandFood portion, deleted when the count returns
 * to 0 (either via a threshold-fire reset or enough non-bland meals). The
 * AE carries NO stat changes — it's purely a tracker. Source of truth is
 * the `flags.<SYSTEM_ID>.blandDietTracker` numeric value on the AE itself.
 *
 * The flag scope MUST be the registered system id — Foundry v13 strips
 * unregistered flag scopes on write, so an earlier `flags.wdm.…` write
 * silently vanished, `readBlandStack` never found the tracker back, and
 * the "Bland Diet" AE never surfaced on the sheet. A legacy fallback in
 * `readBlandStack` still recognises the old `wdm` scope so a next write
 * migrates any straggler on the actor.
 *
 * Why an AE not an actor flag: players need to SEE the stack to play
 * around it, and AEs surface naturally in every sheet's effect list. */
const BLAND_AE_FLAG   = "blandDietTracker";
const BLAND_AE_ICON   = "systems/witcher-ttrpg-death-march/assets/icons/statuses/bleak-diet.svg";
const BLAND_LEGACY_NS = "wdm";                       // pre-fix flag scope

function findBlandAE(actor) {
    return actor?.effects?.find?.(e =>
        e.flags?.[SYSTEM_ID]?.[BLAND_AE_FLAG] !== undefined
     || e.flags?.[BLAND_LEGACY_NS]?.[BLAND_AE_FLAG] !== undefined
    );
}

/** Read the current bland-stack value off the tracker AE (0 if absent). */
function readBlandStack(actor) {
    const ae = findBlandAE(actor);
    if (!ae) return 0;
    const v = ae.flags?.[SYSTEM_ID]?.[BLAND_AE_FLAG]
           ?? ae.flags?.[BLAND_LEGACY_NS]?.[BLAND_AE_FLAG];
    return Number(v) || 0;
}

/** Create / update / delete the tracker AE to match the new count. */
async function writeBlandStack(actor, count, will) {
    if (!actor) return;
    const ae = findBlandAE(actor);

    if (count <= 0) {
        // Stack cleared — remove the tracker.
        if (ae) await safeDeleteEffects(actor, [ae.id]);
        return;
    }

    const name = `Bleak Diet — ${count}/${will} sittings`;
    const description = t(
        "WITCHER.Mech.FoodAndDrink.BleakDiet.Description",
        "This food will keep you alive. But its depressing. You can gain enough Bleak Diet stacks equal to your WILL, then get a STRESS point. Eat or drink better quality food to lower this."
    );
    const flagPath = `flags.${SYSTEM_ID}.${BLAND_AE_FLAG}`;

    if (ae) {
        // Update payload: write the flag under the registered scope, and
        // null out any legacy wdm entry so we don't keep dual state around.
        // Also re-write `img` on every update so a tracker that pre-dates
        // the bland-diet.svg swap migrates to the new icon on next portion.
        // Description is re-written on every update so trackers created
        // before the description was authored migrate on next portion.
        const update = { _id: ae.id, name, description, img: BLAND_AE_ICON, [flagPath]: count };
        if (ae.flags?.[BLAND_LEGACY_NS]?.[BLAND_AE_FLAG] !== undefined) {
            update[`flags.${BLAND_LEGACY_NS}.-=${BLAND_AE_FLAG}`] = null;
        }
        try {
            await actor.updateEmbeddedDocuments("ActiveEffect", [update]);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | bland-diet AE update failed`, err);
        }
    } else {
        try {
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name,
                description,
                img: BLAND_AE_ICON,
                disabled: false,
                transfer: false,
                changes: [],
                flags: { [SYSTEM_ID]: { [BLAND_AE_FLAG]: count } }
            }]);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | bland-diet AE create failed`, err);
        }
    }
}

/* BODY-scaled satiety pool. MAX = hourly drain × 24 (one full BMR day of
 * calories). FLOOR = -MAX (up to one full day of starvation depth split into
 * four Famished quarters). All hunger tiers are percentages of this MAX so
 * the timing (Fed at 6h, Peckish at 12h, Hungry at 18h, Famished at 24h) is
 * uniform across BODY — bigger characters just hold and burn proportionally
 * more.
 *
 * Legacy fallbacks (SATIETY_*_LEGACY) preserve the RAW-book absolute range
 * (-100…125) for any code path that lacks an actor context. Prefer the
 * actor-aware getters below whenever possible. */
const SATIETY_FLOOR_LEGACY = -100;
const SATIETY_CEIL_LEGACY  = 125;

/* Per-actor satiety-ceiling cache. `getSatietyCeil` is on the hot path of
 * every cascade — cur/next tier lookups, floor+ceil clamps, gorged cap,
 * dialog + pill data prep — and each call did a full `hourlySatietyLoss`
 * recompute (BODY read + config read + arithmetic). Cache keyed by
 * actor.id, invalidated on any actor update (BODY, satietyDrain flags)
 * and on the foodAndDrinkConfig setting change. */
const _ceilCache = new Map();
function invalidateCeilCache(actorId) {
    if (actorId) _ceilCache.delete(actorId);
    else _ceilCache.clear();
}

/* CONFIG.statusEffects lookup Map. `reconcileHungerStatus` used to run
 * `(CONFIG.statusEffects ?? []).find(s => s.id === targetId)` on every
 * tier change — a linear scan over 60+ registered statuses. Build a
 * lazy Map on first use, rebuilt when the array length changes (the
 * simplest signal that new statuses were registered). */
let _statusEffectsMap = null;
let _statusEffectsLen = -1;
function getStatusEffectDef(id) {
    const arr = CONFIG.statusEffects ?? [];
    if (_statusEffectsMap === null || arr.length !== _statusEffectsLen) {
        _statusEffectsMap = new Map(arr.map(s => [s.id, s]));
        _statusEffectsLen = arr.length;
    }
    return _statusEffectsMap.get(id);
}

export function getSatietyCeil(actor) {
    if (!actor) return SATIETY_CEIL_LEGACY;
    const id = actor.id;
    if (id && _ceilCache.has(id)) return _ceilCache.get(id);
    const drain = hourlySatietyLoss(actor);
    // Floor of 24 so an actor with zero drain (e.g. paused hunger, or
    // config zeroed the base) still has a sensible pool ceiling.
    const val = Math.max(24, drain * 24);
    if (id) _ceilCache.set(id, val);
    return val;
}
/** Absolute maximum satiety — Full MAX plus the Gorged overflow band
 *  (25% of MAX). A big feast plate can push satiety above the Full ceiling
 *  into the Gorged zone; drain brings the actor back down over the next
 *  few hours. Nothing can push satiety above this hard cap. */
export function getSatietyGorgedCeil(actor) {
    return Math.floor(getSatietyCeil(actor) * 1.25);
}
export function getSatietyFloor(actor) {
    if (!actor) return SATIETY_FLOOR_LEGACY;
    return -getSatietyCeil(actor);
}

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
async function safeDeleteEffects(actor, ids, opts = {}) {
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
        /* opts.render forwarded to the doc op so cascade callers can
         * suppress intermediate sheet re-renders. Default true preserves
         * existing behaviour for every other caller of this helper. */
        const deleteOpts = opts.render === false ? { render: false } : undefined;
        myPromise = actor.deleteEmbeddedDocuments("ActiveEffect", toSend, deleteOpts);
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
/* Top-down hunger ladder. `min` values are LEGACY absolute thresholds kept
 * only for the fallback (no-actor) branch of tierForSatiety and for the
 * approachFrom direction machinery. Under the BODY-scaled model the real
 * thresholds are percentages of the actor's satiety MAX — see
 * `getFoodAndDrinkConfig().hungerTiers` for those. Ordering (top-down) is
 * what matters here. */
const HUNGER_TIERS = Object.freeze([
    { id: "gorged",     min: 101, effective: true,  approachFrom: "below" },
    { id: "full",       min:  76, effective: false },
    { id: "fed",        min:  51, effective: false },
    // Peckish is a warning tier — no stat changes, no stress on entry, but it
    // DOES land as a visible status on the actor so the player gets a heads-up
    // that Hungry is coming.
    { id: "peckish",    min:  26, effective: true },
    { id: "hungry",     min:   1, effective: true,  approachFrom: "above" },
    // Famished sub-tiers, each subdividing the negative range by 25% of MAX.
    { id: "famished-1", min:   0, effective: true,  approachFrom: "above" },
    { id: "famished-2", min: -25, effective: true,  approachFrom: "above" },
    { id: "famished-3", min: -50, effective: true,  approachFrom: "above" },
    { id: "famished-4", min: -Infinity, effective: true, approachFrom: "above" }
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
            /* Nested-in-container preservation: if the original stack lives
             * inside one of the actor's containers, the split spinoff must
             * land in the SAME container. Otherwise the new document
             * inherits `isStored=true` (via toObject) but no container
             * claims it in their `system.content` array — it disappears
             * from BOTH the grid (isStored filter hides it) AND the
             * container view (no ref). The lookup walks every container on
             * the parent; matching by UUID first, then bare id, mirrors
             * the ref format used throughout `system.content`. */
            const parentContainer = parent.items?.find?.(c =>
                c.type === "container" &&
                Array.isArray(c.system?.content) &&
                (c.system.content.includes(item.uuid) || c.system.content.includes(item.id))
            ) ?? null;
            const [created] = await parent.createEmbeddedDocuments("Item", [data]);
            if (parentContainer && created?.uuid) {
                const prevContent = parentContainer.system?.content ?? [];
                await parentContainer.update({
                    "system.content": [...prevContent, created.uuid]
                });
            } else if (created && created.system?.isStored) {
                /* No container claim → strip the stale isStored so the
                 * spinoff surfaces in the loose grid instead of nowhere.
                 * Belt-and-braces for the (rare) case where the source
                 * was flagged stored but not actually referenced by any
                 * container. */
                await created.update({ "system.isStored": false });
            }
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

/** Read the actor's current drunk level from their active statuses. */
export function getDrunkLevel(actor) {
    if (!actor?.effects) return 0;
    /* Read from actor.effects (embedded collection) directly rather than
     * actor.statuses (aggregate Set populated during applyActiveEffects).
     * The aggregate can lag one prepareData tick behind a fresh create —
     * e.g. immediately after `applyDrunkLevel(5)` deletes drunk-6 and
     * creates drunk-5 mid-cascade, actor.statuses would occasionally read
     * as empty (drunk-6 gone from aggregate, drunk-5 not yet in it), the
     * outer sweep backfill would see "level 0 with peak flag set" and
     * incorrectly stamp a hangover while drunk-5 was in fact still on the
     * actor. Direct effects iteration reads the authoritative document
     * state that Foundry commits on the createEmbeddedDocuments await. */
    let max = 0;
    for (const e of actor.effects) {
        if (e.disabled) continue;
        for (const id of (e.statuses ?? [])) {
            const m = /^drunk-(\d+)$/.exec(id);
            if (!m) continue;
            const n = Number(m[1]);
            if (n > max) max = n;
        }
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
    /* When ASCENDING (a fresh drink pushing the level up), also strip any
     * lingering hangover from the previous binge. Otherwise the old
     * hangover AE just sits alongside the new drunk-N AE — the player
     * would rightly ask "why am I hungover AND drunk-6 at the same time?"
     * and, worse, when the cascade eventually brings them down to a
     * mid-tier (say drunk-3), the leftover hangover looks like it just
     * appeared prematurely (this was the user's reported bug). */
    if (!descending) {
        for (const e of actor.effects) {
            if (e.getFlag(SYSTEM_ID, HANGOVER_FLAG) === true || e.statuses?.has?.("hangover")) {
                owned.push(e);
            }
        }
    }
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
    const def = getStatusEffectDef(id);
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
            //
            // v14 stores the start anchor at `start.time` (not the v13
            // `duration.startTime`). Writing `start: { time: X }` directly
            // is risky because the `start` SchemaField has sibling fields
            // (initiative/round/turn) that are required-and-non-nullable,
            // and a partial object risks validation rejection. The robust
            // path is to write the legacy `duration.startTime` shim —
            // Foundry's BaseActiveEffect.migrateData converts it to
            // `start.time` and fills the sibling defaults for us
            // (common/documents/active-effect.mjs:192-198).
            duration:    { seconds: drunkTickSeconds(actor), startTime: game.time?.worldTime ?? 0 },
            flags:       { [SYSTEM_ID]: { drunkLevel: level } }
        }], { wdmSkipOnApply: descending });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | drunk AE create failed`, err);
    }

    /* Alcohol-poisoning gate — only on ASCENT into drunk-6/7/8. Fires an
     * Endurance roll vs the tier's unconsciousDC; on fail, drops the actor
     * unconscious for 2d6 hours. Tiers 7 and 8 also roll for a small chance
     * of death (RAW). Guard against re-firing on the sober cascade — that
     * path calls applyDrunkLevel repeatedly with descending=true, and we
     * shouldn't punish the actor for sobering DOWN into a lethal tier. */
    if (!descending && level >= 6) {
        try { await _rollAlcoholPoisoning(actor, level); }
        catch (err) { console.warn(`${SYSTEM_ID} | alcohol poisoning roll failed`, err); }
    }
}

/* Endurance roll → 2d6-hour unconscious; drunk-8 alcohol poisoning check
 * runs ONLY as a follow-up to actually falling unconscious (RAW: you can
 * only die of alcohol poisoning if the drink knocked you out first). */
async function _rollAlcoholPoisoning(actor, level) {
    console.log(`${SYSTEM_ID} | alcohol poisoning check: ${actor.name} at Drunk-${level}`);
    /* Skip if actor is already unconscious or dead — no point rolling
     * again, and the chat spam would be confusing. */
    if (actor.statuses?.has?.("dead")) { console.log(`${SYSTEM_ID} | already dead; skip`); return; }
    if (actor.statuses?.has?.("unconscious")) { console.log(`${SYSTEM_ID} | already unconscious; skip`); return; }

    const tierCfg = getFoodAndDrinkConfig().drunkTiers?.[level];
    const unconsciousDC = Number(tierCfg?.unconsciousDC);
    if (!Number.isFinite(unconsciousDC) || unconsciousDC <= 0) {
        console.log(`${SYSTEM_ID} | no unconsciousDC for Drunk-${level}; skip`);
        return;
    }

    /* Endurance roll: 1d10 + endurance skill total. Fall back to bare 1d10
     * if the actor's skill map isn't available (monsters, edge-case data). */
    const endur = actor._readSkillValues?.("endurance");
    const formula = endur ? `1d10 + ${endur.total}` : "1d10";
    const enduranceRoll = await new Roll(formula).evaluate();
    const total = enduranceRoll.total;
    const pass = total >= unconsciousDC;

    const speaker = ChatMessage.getSpeaker({ actor });
    const whisper = collectFoodAudience(actor);

    if (pass) {
        console.log(`${SYSTEM_ID} | Drunk-${level} Endurance ${total} vs DC ${unconsciousDC} → PASS (holds liquor)`);
        await ChatMessage.create({
            speaker, whisper,
            content: tFormat(
                "WITCHER.Mech.FoodAndDrink.Chat.PoisoningHeld",
                { name: actor.name, roll: total, dc: unconsciousDC },
                `<b>${actor.name}</b> · Endurance <b>${total}</b> vs DC <b>${unconsciousDC}</b> · holds their liquor.`
            )
        });
        return;
    }

    /* Failed the Endurance DC — passes out for 2d6 hours. */
    const durRoll = await new Roll("2d6").evaluate();
    const hours = durRoll.total;
    console.log(`${SYSTEM_ID} | Drunk-${level} Endurance ${total} vs DC ${unconsciousDC} → FAIL, unconscious ${hours}h`);
    await _applyUnconsciousFromAlcohol(actor, hours);

    /* Death check — ONLY fires as a follow-up to unconsciousness, and
     * ONLY on Drunk-VIII by design (RAW: alcohol poisoning is a lethal-
     * dose consideration, not a middle-tier accident). If the config
     * carries a deathChance on any other tier the code still honors it;
     * the default schema only sets it on drunk-8. */
    const deathChance = Number(tierCfg?.deathChance) || 0;
    if (deathChance > 0) {
        const deathRoll = await new Roll("1d100").evaluate();
        console.log(`${SYSTEM_ID} | Drunk-${level} death roll ${deathRoll.total} vs ${deathChance}%`);
        if (deathRoll.total <= deathChance) {
            await _applyDeathFromAlcohol(actor);
            await ChatMessage.create({
                speaker, whisper,
                content: tFormat(
                    "WITCHER.Mech.FoodAndDrink.Chat.PoisoningDeath",
                    { name: actor.name, roll: total, dc: unconsciousDC, hours, deathRoll: deathRoll.total, deathChance },
                    `<b>${actor.name}</b> · Endurance <b>${total}</b> vs DC <b>${unconsciousDC}</b> · unconscious ${hours}h · alcohol poisoning (<b>${deathRoll.total}</b>/${deathChance}%) · <b style="color:#8b0000">DEAD</b>.`
                )
            });
            return;
        }
    }

    /* Unconscious card (no death). */
    await ChatMessage.create({
        speaker, whisper,
        content: tFormat(
            "WITCHER.Mech.FoodAndDrink.Chat.PoisoningUnconscious",
            { name: actor.name, roll: total, dc: unconsciousDC, hours },
            `<b>${actor.name}</b> · Endurance <b>${total}</b> vs DC <b>${unconsciousDC}</b> · passes out for <b>${hours}</b> hours.`
        )
    });
}

/* Drop the actor into the Foundry-native "dead" status + zero their HP.
 * Match how the death-state mechanic in other paths lands so downstream
 * subscribers (party HUD, combat tracker, sheet) all see the same state. */
async function _applyDeathFromAlcohol(actor) {
    try {
        await actor.update({ "system.derivedStats.hp.value": 0 }, { render: false });
        /* Fresh Dead status AE — Foundry's toggleStatusEffect handles the
         * duplicate-check for us; passing active:true is safe idempotent. */
        await actor.toggleStatusEffect?.("dead", { active: true });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | alcohol death apply failed`, err);
    }
}

/* Stamp an Unconscious AE with the rolled duration. Uses the same v14
 * duration.startTime shim pattern the drunk AE creation relies on so the
 * timer anchors correctly and the world-time sweep can auto-clear it. */
async function _applyUnconsciousFromAlcohol(actor, hours) {
    try {
        const def = getStatusEffectDef("unconscious");
        if (!def) return;
        await actor.createEmbeddedDocuments("ActiveEffect", [{
            name:        def.name,
            img:         def.img,
            statuses:    ["unconscious"],
            disabled:    false,
            duration:    { seconds: Math.max(1, hours) * 3600, startTime: game.time?.worldTime ?? 0 },
            flags:       { [SYSTEM_ID]: { source: "alcoholPoisoning" } }
        }], { render: false });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | alcohol unconscious apply failed`, err);
    }
}

/**
 * Roll Endurance vs DC after consuming alcohol. On failure, raises drunk
 * level by `levelJump` (plus one extra step per full 10 points missed).
 */
export async function handleEnduranceRoll(actor, cfg, itemName = "drink") {
    if (!actor) return;
    if (!isHomebrewEnabled("foodAndDrink")) return;

    const v = actor._readSkillValues?.("endurance");
    const formula = v ? `1d10 + ${v.total}` : "1d10";
    const r = await new Roll(formula).evaluate();
    const best = r.total;
    const pass = best > cfg.dc;

    const flavor = tFormat("WITCHER.Mech.FoodAndDrink.Text.ActorVerbItem", { name: actor.name, verb: cfg.flavorVerb, item: itemName }, `<b>${actor.name}</b> ${cfg.flavorVerb} ${itemName}.<br>`);
    let body;
    if (pass) {
        body = tFormat("WITCHER.Mech.FoodAndDrink.Text.EnduranceHoldsIt", { best, dc: cfg.dc }, `Endurance ${best} vs DC ${cfg.dc} — <b style="color:#4a7c59">holds it.</b>`);
    } else {
        const cur       = getDrunkLevel(actor);
        const missedBy  = cfg.dc - best;
        const extraJump = Math.max(0, Math.floor(missedBy / 10));
        const totalJump = cfg.levelJump + extraJump;
        const next      = Math.min(cur + totalJump, 8);
        await applyDrunkLevel(actor, next, cfg.effectIcon);
        const extraNote = extraJump > 0 ? tFormat("WITCHER.Mech.FoodAndDrink.Text.MissedByExtra", { missedBy, extraJump }, ` (missed by ${missedBy}: +${extraJump} extra)`) : "";
        body = tFormat("WITCHER.Mech.FoodAndDrink.Text.EnduranceFailsDrunk", { best, dc: cfg.dc, extraNote, next: roman(next) }, `Endurance ${best} vs DC ${cfg.dc} — <b style="color:#8b0000">fails${extraNote}.</b><br>Drunk level → <b>${roman(next)}</b>.`);
    }

    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: collectFoodAudience(actor),
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
        return ui.notifications?.info(tFormat("WITCHER.Mech.FoodAndDrink.Notify.XIsAlreadySober", { actor: actor.name }, "{actor} is already sober."));
    }
    const body = actor.system?.stats?.body?.value ?? 0;
    const roll = await new Roll("1d10").evaluate();
    const pass = roll.total < body;
    if (pass) await applyDrunkLevel(actor, cur - 1);

    return ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: collectFoodAudience(actor),
        content: `<div style="border-left:3px solid #6f8b3a;padding:4px 8px">
            ${tFormat("WITCHER.Mech.FoodAndDrink.Text.ActorSobersUp", { name: actor.name }, `<b>${actor.name}</b> sobers up.`)}<br>
            ${tFormat("WITCHER.Mech.FoodAndDrink.Text.SoberRollVsBody", { total: roll.total, body, verdict: pass
                ? tFormat("WITCHER.Mech.FoodAndDrink.Text.DropsToTier", { tier: roman(cur - 1) }, `<b style="color:#4a7c59">drops to ${roman(cur - 1)}</b>`)
                : tFormat("WITCHER.Mech.FoodAndDrink.Text.StillTier", { tier: roman(cur) }, `<b style="color:#8b0000">still ${roman(cur)}</b>`) }, `Rolled <b>${roll.total}</b> vs BODY <b>${body}</b> — {verdict}.`)}
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
    /* Defensive guard: refuse to stamp a hangover while the actor is still
     * carrying any drunk-N status. Normal flow (applyDrunkLevel → delete
     * drunk AEs → applyHangover) prevents this by ordering the awaits, but
     * a stray direct-call from a macro / outer-sweep race / a caller with a
     * stale actor reference could otherwise land the hangover early and the
     * player would see hangover + drunk-N side by side. */
    if (getDrunkLevel(actor) > 0) {
        console.warn(`${SYSTEM_ID} | applyHangover refused: ${actor.name} still at Drunk-${getDrunkLevel(actor)} — waiting for the cascade to complete first`);
        return;
    }

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

    /* Remove any in-flight hangover before stamping the new one — a fresh
     * binge resets the timer instead of stacking penalties. Match BOTH by
     * our flag AND by the "hangover" status id so a legacy AE that
     * carried only the status (no flag) still gets cleaned. */
    const existing = actor.effects.filter(e =>
        e.getFlag(SYSTEM_ID, HANGOVER_FLAG) === true || e.statuses?.has?.("hangover")
    );
    await safeDeleteEffects(actor, existing.map(e => e.id));

    const def = getStatusEffectDef("hangover");
    // Compose a per-actor description with PEAK-SCALED flavor + the actual
    // mechanic line. The static clause description is the medium-tier blurb;
    // peak 3 gets something milder, peak 7-8 gets something brutal, so a
    // light hangover doesn't sound like the apocalypse and a Drunk-VIII
    // hangover doesn't sound like a mild headache.
    const flavor = hangoverFlavor(peak);
    /* Effective duration accounts for the actor's race Alcohol Resistance —
     * "full" quarters, "half" halves. A 1-day base hangover on a "full"
     * resister renders as 6 hours. */
    const factor         = hangoverDurationFactor(actor);
    const effectiveDays  = days * factor;
    const effectiveHours = effectiveDays * 24;
    const dayLabel = effectiveDays >= 1
        ? (effectiveDays === 1 ? t("WITCHER.Mech.FoodAndDrink.Text.OneDay",  "1 day")  : tFormat("WITCHER.Mech.FoodAndDrink.Text.NDays",  { n: effectiveDays  }, "{n} days"))
        : effectiveHours >= 1
            ? (effectiveHours === 1 ? t("WITCHER.Mech.FoodAndDrink.Text.OneHour", "1 hour") : tFormat("WITCHER.Mech.FoodAndDrink.Text.NHours", { n: effectiveHours }, "{n} hours"))
            : t("WITCHER.Mech.FoodAndDrink.Text.UnderAnHour", "under an hour");
    const dynamicDesc = tFormat(
        "WITCHER.Mech.FoodAndDrink.Text.HangoverDesc",
        { flavor, recPenalty, dayLabel },
        "{flavor} <b>−{recPenalty} REC for {dayLabel}.</b>"
    );
    // Wrapped in try/catch — same race-with-concurrent-worldTime-listeners
    // concern as the drunk AE create above. If a stale-id throw escapes from
    // somewhere in the validate/preCreate chain, log it instead of red-toasting.
    try {
        const created = await actor.createEmbeddedDocuments("ActiveEffect", [{
            name:        def?.name || t("WITCHER.Mech.FoodAndDrink.Text.Hangover", "Hangover"),
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
            // deletes the AE once it expires, so the player sees the hangover
            // wear off the morning of recovery automatically. Flags still
            // record the source values for display / debugging.
            //
            // v14 anchor: use the legacy `duration.startTime` shim — Foundry
            // migrateData converts it to `start.time` and fills the sibling
            // schema fields (initiative/round/turn) with defaults, which a
            // partial `start: { time: X }` write would leave unset and risk
            // schema rejection.
            duration: { seconds: days * secondsPerDay() * hangoverDurationFactor(actor), startTime },
            flags: { [SYSTEM_ID]: {
                [HANGOVER_FLAG]: true,
                peak,
                // Stored for telemetry / future macros; the actual penalty
                // applies via the `changes` array above (flat AE on displayed REC).
                recPenalty,
                days
            } }
        }], { wdmSkipOnApply: true });   // hangover is not stress-bearing on apply

        /* Belt-and-braces: confirm the migration landed start.time where we
         * asked. If a peer module's preCreate hook re-set it (or the legacy
         * shim got skipped because the AE already had a `start` object),
         * force the value via update. Update writes go directly to the
         * schema field (no migration), so we target `start.time` here.
         * Returns the AE so the cascade can do a final sanity-check pass. */
        const ae = Array.isArray(created) ? created[0] : created;
        if (ae && actor.effects?.get?.(ae.id)) {
            const stored = Number(ae.start?.time);
            if (!Number.isFinite(stored) || stored !== startTime) {
                try { await ae.update({ "start.time": startTime }); }
                catch (err) { console.warn(`${SYSTEM_ID} | hangover start.time re-anchor failed`, err); }
            }
        }
        /* Duplicate sweep. Two concurrent code paths can both slip a
         * hangover through the pre-delete window: e.g. the auto-sober
         * cascade fires applyHangover with the correct mid-skip anchor,
         * and the outer onWorldTimeFoodDrinkSweep backfill's !hasHangover
         * check races the create and fires ITS applyHangover anchored to
         * nowWT (end-of-skip). Result: two AEs — one correct, one at the
         * wrong time. Sweep any hangover-tagged AE that ISN'T the one we
         * just created; keep our create as the winner because its anchor
         * was computed with the correct soberAt caller argument. */
        if (ae?.id) {
            const stale = actor.effects.filter(e =>
                e.id !== ae.id
                && (e.getFlag(SYSTEM_ID, HANGOVER_FLAG) === true || e.statuses?.has?.("hangover"))
            );
            if (stale.length) {
                try { await safeDeleteEffects(actor, stale.map(e => e.id)); }
                catch (err) { console.warn(`${SYSTEM_ID} | duplicate hangover sweep failed`, err); }
            }
        }
        return ae;
    } catch (err) { console.warn(`${SYSTEM_ID} | hangover AE create failed`, err); }
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
                        // v14: start anchor lives at `start.time`.
                        const start = Number(e.start?.time);
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
                        // v14: use secondsRemaining (start.time + seconds based),
                        // or duration.expired short-circuit. `duration.remaining`
                        // is a legacy v13 field and is undefined in v14.
                        const expired = e.duration?.expired === true;
                        const rem = Number(e.duration?.secondsRemaining);
                        if (!expired) {
                            if (!Number.isFinite(rem) || rem > 0) continue;
                        }

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
                //   Whether the hangover already exists or not, force-set its
                //   startTime to the optimistic sober anchor (earliestDrunkStart
                //   + earliestDrunkLevel * 3600) — that closes the loophole
                //   where applyHangover ran fine but with a missing soberAt
                //   somewhere upstream.
                try {
                    const peak = Number(actor.getFlag?.(SYSTEM_ID, PEAK_FLAG)) || 0;
                    if (peak >= 3 && getDrunkLevel(actor) === 0) {
                        const backfillSoberAt = (earliestDrunkStart !== null && earliestDrunkLevel > 0)
                            ? earliestDrunkStart + earliestDrunkLevel * 3600
                            : undefined;
                        const hasHangover = actor.effects.some(e =>
                            e.statuses?.has?.("hangover") || e.getFlag(SYSTEM_ID, HANGOVER_FLAG));
                        if (!hasHangover) {
                            await applyHangover(actor, peak, backfillSoberAt !== undefined ? { soberAt: backfillSoberAt } : {});
                            await actor.unsetFlag(SYSTEM_ID, PEAK_FLAG);
                        } else if (backfillSoberAt !== undefined) {
                            // Hangover already exists — force its startTime
                            // to the computed sober moment regardless of
                            // what's stored. This is the fix for "hangover
                            // anchored to end-of-skip instead of mid-skip".
                            const ae = actor.effects.find(e =>
                                e.statuses?.has?.("hangover") || e.getFlag(SYSTEM_ID, HANGOVER_FLAG));
                            if (ae && actor.effects.get(ae.id)) {
                                try { await ae.update({ "start.time": backfillSoberAt }); }
                                catch (err) { console.warn(`${SYSTEM_ID} | sweep hangover anchor fix failed`, err); }
                            }
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

    // v14: `duration.secondsRemaining` is the live counter (negative when
    // overdue). `duration.remaining` is a v13 alias and is undefined in v14.
    const remaining = Number(effect.duration?.secondsRemaining);
    // 1 roll for the just-expired hour, plus one per full additional hour
    // the worldTime advanced past expiry. Clamp upward sanity at 24 (a full
    // day) so a year-long skip can't lock the game in a roll loop.
    const overdue   = Number.isFinite(remaining) ? Math.max(0, -remaining) : 0;
    /* Actor-specific tick: race Alcohol Resistance shrinks the interval,
     * so a "full" resister processes 4× as many sober rolls per hour of
     * overdue as an unresisted drunk. */
    const tick      = drunkTickSeconds(actor);
    const hoursToProcess = Math.min(96, 1 + Math.floor(overdue / tick));

    // Capture the ORIGINAL drunk AE's start anchor — used to backdate the
    // hangover when the actor sobers mid-cascade. Each sober roll
    // conceptually consumes the in-game hour FROM that anchor, so a player
    // who got drunk at midnight and sobered after 5 hours of rolls during
    // a 24-hour skip should see their hangover starting at 5am, not at the
    // 24-hour end of the skip.
    //   v14 stores the anchor at `start.time`. The v13 `duration.startTime`
    //   field is dead in v14 — reading it returned undefined and we fell
    //   back to "now" (== end of skip), which was the canonical bug.
    const rawStart  = Number(effect.start?.time);
    const originalStartTime = Number.isFinite(rawStart) ? rawStart : (Number(game.time?.worldTime) || 0);

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
                ? { soberAt: originalStartTime + (i + 1) * tick }
                : {};
            if (willHitZero) soberAt = passOpts.soberAt;
            try { await applyDrunkLevel(actor, level - 1, "", passOpts); }
            catch (err) { console.warn("witcher-ttrpg-death-march | auto sober apply failed", err); }
            level -= 1;
        }
        // Failure simply consumes the hour — `level` and the effect stay.
    }

    // Belt-and-braces backdate — AUTHORITATIVE. The cascade threads
    // soberAt into applyHangover at create-time, but a thrown applyDrunk-
    // Level can leave the hangover anchored to nowWT (end of skip) via
    // the outer-sweep backfill OR via applyHangover's own fallback. To
    // make the timer behaviour deterministic, force-set the startTime
    // here whenever the cascade reached drunk-0 AND a hangover exists.
    // Match by status first (more reliable than the flag), fall back to
    // the flag. No `currentStart > soberAt` gate: we always overwrite,
    // because the cascade owns the anchor calculation.
    if (soberAt !== null) {
        const hangoverAE = actor.effects.find(e => e.statuses?.has?.("hangover"))
                        ?? actor.effects.find(e => e.getFlag(SYSTEM_ID, HANGOVER_FLAG));
        if (hangoverAE && actor.effects?.get?.(hangoverAE.id)) {
            // v14: start anchor lives at `start.time`.
            try { await hangoverAE.update({ "start.time": soberAt }); }
            catch (err) { console.warn("witcher-ttrpg-death-march | hangover backdate failed", err); }
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
            // v14: start anchor lives at `start.time`; duration uses
            // {value, units} (the v13 `duration.seconds` is a shim with
            // a getter only — direct update writes to it are silently
            // dropped at schema validation).
            //
            // Use the actor-specific tick (respects race Alcohol
            // Resistance) rather than hardcoded 3600. Without this,
            // failing a sober roll always reset the countdown to a full
            // hour — a "full" resister who should re-check in 15 min
            // was silently put on a 60-min timer.
            await effect.update({
                "start.time":         Number(game.time?.worldTime) || 0,
                "duration.value":     tick,
                "duration.units":     "seconds"
            });
        } catch (err) { console.warn("witcher-ttrpg-death-march | auto sober reset failed", err); }
    }

    // One consolidated chat note. Bulks multi-tick runs into a single line
    // instead of 24 separate messages on a big time jump.
    try {
        const passes = rollLog.filter(r => r.pass).length;
        const fails  = rollLog.length - passes;
        const verdict = level === 0
            ? `<b style="color:#4a7c59">${t("WITCHER.Mech.FoodAndDrink.Text.SobersAllTheWayUp", "sobers all the way up.")}</b>`
            : level < startLevel
                ? `<b style="color:#4a7c59">${tFormat("WITCHER.Mech.FoodAndDrink.Text.DropsToDrunkN", { n: roman(level) }, `drops to Drunk ${roman(level)}.`)}</b>`
                : `<b style="color:#8b0000">${tFormat("WITCHER.Mech.FoodAndDrink.Text.StillDrunkN", { n: roman(level) }, `still Drunk ${roman(level)}. Riding it out.`)}</b>`;
        /* Describe the tick cadence honestly — a "full" resister rolls
         * every 15 min, "half" every 30 min, otherwise every hour.
         * Without this the chat card said "automatic sober roll" for
         * all three, which read like a per-hour cadence and made resist
         * feel like it wasn't doing anything. */
        const tickLabel = tick <= 900  ? "15-min"
                        : tick <= 1800 ? "30-min"
                                       : "hourly";
        const rollNoun  = hoursToProcess > 1
            ? `${tickLabel} sober rolls × ${hoursToProcess}`
            : `${tickLabel} sober roll`;
        const resistNote = tick < 3600
            ? ` <span style="opacity:0.7">(alcohol resist: ${alcoholResistanceOf(actor)})</span>`
            : "";
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            whisper: collectFoodAudience(actor),
            content: `<div style="border-left:3px solid #6f8b3a;padding:4px 8px">
                <b>${actor.name}</b> — automatic ${rollNoun} vs BODY <b>${body}</b>${resistNote}.<br>
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
        return t("WITCHER.Mech.FoodAndDrink.Hangover.Mild",     "Hangover — a dull ache behind the eyes and a heavy mouth. You'll be back to yourself before the sun sets.");
    }
    if (peak <= 6) {
        return t("WITCHER.Mech.FoodAndDrink.Hangover.Moderate", "Hangover — paying for last night. Your head's pounding, your stomach's in a knot, and every REC roll feels like climbing out of a well. Sleep it off.");
    }
    // peak 7-8 — the lethal-tier binge aftermath
    return t("WITCHER.Mech.FoodAndDrink.Hangover.Severe",       "Hangover — existence is suffering. Light is an assault, sound a punishment, and the very thought of food is offensive. Every breath reminds you of the choices that brought you here. You are not getting out of bed unless someone drags you out.");
}

/* ─────────── Satiety ────────────────────────────────────────────────────── */

/** Tier id for a given satiety value. Reads GM-configurable thresholds as
 *  PERCENTAGES of the actor's satiety MAX (drain × 24 by default). Passing
 *  no actor falls back to the legacy 125-ceiling absolute-threshold behavior
 *  so any legacy caller still gets a sensible answer.
 *
 *  Tier ranges:
 *    Gorged:   above Full MAX, up to MAX × 1.25 (overflow zone from big meals)
 *    Full:     75-100% of MAX
 *    Fed:      50-75% of MAX
 *    Peckish:  25-50% of MAX
 *    Hungry:   0-25% of MAX
 *    Famished: below 0 (subdivided into 4 depths by `hungerDepthFor`) */
export function tierForSatiety(satiety, actor) {
    const v = Math.floor(Number(satiety) || 0);
    const cfg = getFoodAndDrinkConfig().hungerTiers;
    // If we have an actor, thresholds are percentages of that actor's max.
    // If we don't (legacy call), fall back to treating the config values as
    // absolute thresholds (the pre-BODY-scaling behavior).
    let gorgedT, fullT, fedT, peckishT, hungryT;
    if (actor) {
        const ceil = getSatietyCeil(actor);
        const pct = p => Math.floor(ceil * (Number(p) || 0) / 100);
        // Gorged threshold: satiety > MAX (100%) enters the Gorged overflow band.
        // The `cfg.gorged` config value (default 100%) is the boundary; anything
        // above MAX is Gorged, anything at-or-below is Full or lower.
        gorgedT  = pct(cfg.gorged) + 1;   // > MAX, not >=
        fullT    = pct(cfg.full);
        fedT     = pct(cfg.fed);
        peckishT = pct(cfg.peckish);
        hungryT  = pct(cfg.hungry);
    } else {
        gorgedT  = cfg.gorged;
        fullT    = cfg.full;
        fedT     = cfg.fed;
        peckishT = cfg.peckish;
        hungryT  = cfg.hungry;
    }
    if (v >= gorgedT)  return "gorged";
    if (v >= fullT)    return "full";
    if (v >= fedT)     return "fed";
    if (v >= peckishT) return "peckish";
    if (v >= hungryT)  return "hungry";
    // Sub-divided famished bands by depth. Under the BODY-scaled model each
    // band is 25% of MAX; without an actor we fall back to the legacy
    // absolute -25 / -50 / -75 anchors so old callsites still get an answer.
    if (actor) {
        const ceil = getSatietyCeil(actor);
        if (v >= -Math.floor(ceil * 0.25)) return "famished-1";
        if (v >= -Math.floor(ceil * 0.50)) return "famished-2";
        if (v >= -Math.floor(ceil * 0.75)) return "famished-3";
        return "famished-4";
    } else {
        if (v >= -25) return "famished-1";
        if (v >= -50) return "famished-2";
        if (v >= -75) return "famished-3";
        return "famished-4";
    }
}

/* English fallback labels for hunger tier ids. Kept as the source of truth
 * for `tierDisplayName` fallbacks so a missing i18n key never blanks the
 * pill / dialog / chrome UI. All nine tier ids map here; anything unknown
 * resolves to "Fed" (the neutral middle tier). */
const TIER_FALLBACK_LABEL = {
    "gorged":     "Gorged",
    "full":       "Full",
    "fed":        "Fed",
    "peckish":    "Peckish",
    "hungry":     "Hungry",
    "famished-1": "Very Hungry",
    "famished-2": "Weakening",
    "famished-3": "Famished",
    "famished-4": "Starving"
};

/** Localized display name for a hunger tier id. Single source of truth
 *  used by the actor sheet pill, chrome pill, and satiety dialog — all
 *  three used to duplicate a raw-English map. Reads
 *  `WITCHER.Mech.FoodAndDrink.Tier.<id>` with an English fallback. */
export function tierDisplayName(tierId) {
    const fallback = TIER_FALLBACK_LABEL[tierId] ?? "Fed";
    return t(`WITCHER.Mech.FoodAndDrink.Tier.${tierId}`, fallback);
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
    // Clamp at the GORGED ceiling (MAX × 1.25) not the Full ceiling — big
    // meals can push into the Gorged overflow band; only pushes past MAX×1.25
    // are wasted. Floor is unchanged (−MAX = the four Famished depths).
    const next = Math.max(getSatietyFloor(actor), Math.min(getSatietyGorgedCeil(actor), cur + delta));
    if (next === cur) return;

    /* Fast path when hunger is disabled for this actor: persist the satiety
     * value but skip the whole tier/depth/stress cascade. GM can pre-set
     * satiety on an NPC (via the dialog or the max-out macro) without
     * paying for AE reconciliation on an actor that isn't participating in
     * the mechanic. When the GM later enables hunger, the first
     * `reconcileHungerStatus` call will bring tier state in line with the
     * stored satiety value. */
    if (!isHungerActive(actor)) {
        await actor.update({ "system.satiety": next }, { wdmSatietyInternal: true, render: false });
        try { actor.sheet?.render(false); } catch (_) { /* sheet gone */ }
        return;
    }

    /* SINGLE combined actor.update for the entire cascade — satiety +
     * hungerStress + total stress + hunger-depth flag land together in
     * ONE round-trip. Was previously 3-5 sequential writes (satiety →
     * hungerStress+stress+flag → intermediate-tier grantStress → …),
     * each firing updateActor hooks that woke chrome / party / sidebar
     * subscribers, each round-tripping to the server. This is the biggest
     * remaining stutter source per user report; collapsing to one write
     * cuts hook count from ~5 to 1 for the actor-fields portion of the
     * cascade. Tier AE ops (delete/create/update) still need a separate
     * embedded-op round-trip.
     *
     * Cascade helpers now write into `changeBuffer` instead of doing their
     * own actor.update; adjustSatiety folds the aggregated payload in with
     * the satiety change and issues the combined write. Chat messages are
     * still batched into `chatBuffer` and flushed via one
     * `ChatMessage.createDocuments` call at the tail. */
    const chatBuffer = [];
    const changeBuffer = { payload: {}, opts: {}, famishedStressDelta: 0 };
    try {
        await applyFamishedDepthStress(actor, cur, next, chatBuffer, changeBuffer);
        await applyIntermediateTierStress(actor, cur, next, chatBuffer, changeBuffer);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | cascade change-compute failed`, err);
    }

    /* Combined write: satiety + every cascade-field delta the helpers
     * accumulated. `wdmSatietyInternal` tells the sheet-edit reconcile
     * hook (`Hooks.on updateActor` below) not to re-fire — we've already
     * computed the full cascade. */
    const combinedPayload = { "system.satiety": next, ...changeBuffer.payload };
    const combinedOpts    = { wdmSatietyInternal: true, render: false, ...changeBuffer.opts };
    try { await actor.update(combinedPayload, combinedOpts); }
    catch (err) { console.warn(`${SYSTEM_ID} | combined cascade write failed`, err); }

    /* Tier AE reconcile (delete+create OR update-in-place) + optional
     * STA clamp — separate ops because they hit the ActiveEffect embedded
     * document, not the actor itself. */
    try {
        await _reconcileTierAndStaOnly(actor, cur, next);
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | tier AE reconcile failed", err);
    }

    /* Flush the shared chat buffer with ONE createDocuments call instead
     * of N sequential ChatMessage.create()s. */
    if (chatBuffer.length) {
        try { await ChatMessage.createDocuments(chatBuffer); }
        catch (err) { console.warn(`${SYSTEM_ID} | batched cascade chat flush failed`, err); }
    }

    /* Final one-shot render after the whole cascade settles. Only
     * re-renders if the sheet is already open (force=false). */
    try { actor.sheet?.render(false); } catch (_) { /* sheet gone */ }
}

/* Hunger-depth LOCKED stress — reversible debt model, five bands.
 *
 * Every descent into a lower hunger band grants +1 stress that is LOCKED
 * (written to `system.hungerStress`). Locked stress counts toward all
 * stress-based DC checks / triggers, but CANNOT be removed voluntarily —
 * meditation, WILL saves, roleplay, therapy all skip it (setStress in
 * stress.mjs floors total stress at hungerStress unless the caller marks
 * itself as the hunger-refund path via opts.wdmHungerRefund).
 *
 * The ONLY way to reduce locked hunger stress is to eat back UP through the
 * tier that granted it. Depth bands are percentages of the actor's satiety
 * MAX (drain × 24):
 *
 *   depth 0: satiety >  25% MAX     — comfortable, no locked stress
 *   depth 1: satiety  0 to 25% MAX  — Hungry           (+1 locked)
 *   depth 2: satiety -25 to 0% MAX  — Famished 1       (+2 locked)  −12.5% max STA
 *   depth 3: satiety -50 to -25%    — Famished 2       (+3 locked)  −25% max STA
 *   depth 4: satiety -75 to -50%    — Famished 3       (+4 locked)  −37.5% max STA
 *   depth 5: below -75% MAX         — Famished 4       (+5 locked)  −50% max STA
 *
 * Max locked stress from the hunger cascade: 5.
 *
 * Persist the stored debt as a flag so we never double-grant or over-refund
 * across sessions / multiple updates.
 *
 * (Flag key retains the historical "famishedDepthDebt" for backward compat
 * with any existing actor data; the model is stress-locked and now covers
 * Hungry too.) */
const HUNGER_DEBT_FLAG = "famishedDepthDebt";

/* Depth is derived FROM the tier — single source of truth. The prior
 * implementation used hardcoded percentage thresholds (25 / 0 / -25 / -50
 * / -75) which disagreed with `tierForSatiety` on the boundary because
 * (a) tierForSatiety's thresholds are GM-configurable via foodAndDrinkConfig
 * and (b) it floors the percentage → integer satiety conversion. Concrete
 * misalignment: at satiety = floor(ceil × cfg.peckish/100), tier = "peckish"
 * (satiety >= threshold) but pct === cfg.peckish → not strictly greater,
 * so the old depth math returned 1 (Hungry-band) while the sheet still
 * showed Peckish. Symptom: "hunger gnaws deeper" fires while the actor's
 * pill reads Peckish. Deriving depth from tier makes them consistent by
 * construction. */
const TIER_TO_DEPTH = {
    "gorged":     0,
    "full":       0,
    "fed":        0,
    "peckish":    0,
    "hungry":     1,
    "famished-1": 2,
    "famished-2": 3,
    "famished-3": 4,
    "famished-4": 5
};
function hungerDepthFor(satiety, actor) {
    if (!Number.isFinite(satiety)) return 0;
    return TIER_TO_DEPTH[tierForSatiety(satiety, actor)] ?? 0;
}
// Legacy alias for any external caller — same shape, just the new name.
function famishedDepthFor(satiety, actor) { return hungerDepthFor(satiety, actor); }

/* If a `changeBuffer` is passed, MERGE our computed changes into
 * `changeBuffer.payload` / `changeBuffer.opts` instead of writing directly
 * — the outer `adjustSatiety` will fold every cascade helper's payload
 * into ONE actor.update. Without a buffer we fall back to the direct-write
 * path for any legacy caller (kept for API compatibility). Same shape for
 * `applyIntermediateTierStress` below. */
async function applyFamishedDepthStress(actor, prev, next, chatBuffer = null, changeBuffer = null) {
    if (!actor || actor.type !== "character") return;
    if (!game.user?.isActiveGM) return;
    if (!Number.isFinite(next)) return;   // need a target satiety to reconcile to

    const nextDepth = hungerDepthFor(next, actor);
    /* `prev` may be absent — a sheet edit whose prior value wasn't stashed, a
     * macro / API write, or a reconcile called with only `next`. Fall back to
     * the CURRENT depth so we still reconcile hungerStress to the target instead
     * of bailing (the old `!Number.isFinite(prev) → return` stranded the locked
     * stress). */
    const prevDepth = Number.isFinite(prev) ? hungerDepthFor(prev, actor) : nextDepth;
    /* Skip ONLY when there is genuinely nothing to do: the band didn't change
     * AND the locked Hunger Stress already equals the current depth. The old
     * `prevDepth === nextDepth → return` skipped every same-band move, so a
     * hungerStress that had drifted out of sync could NEVER be reconciled — the
     * "stuck at N stress after eating back up to full" bug. Now any satiety
     * change re-syncs it (newLocked always resolves to nextDepth below). */
    const lockedNow = Number(actor.system?.hungerStress) || 0;
    if (prevDepth === nextDepth && lockedNow === nextDepth) return;

    /* Fallback for when the stress homebrew is disabled: still sync the
     * hunger-depth flag AND zero out any stale hungerStress so that
     * re-enabling stress later doesn't retroactively dump 5 Hunger Stress
     * on the actor. Batched into a single actor.update — was two sequential
     * writes (setFlag + update) which doubled the roundtrip cost. */
    const stressOn = isHomebrewEnabled("stress");
    if (!stressOn) {
        const flagPath = `flags.${SYSTEM_ID}.${HUNGER_DEBT_FLAG}`;
        const payload = { [flagPath]: nextDepth };
        if ((Number(actor.system?.hungerStress) || 0) !== 0) {
            payload["system.hungerStress"] = 0;
        }
        if (changeBuffer) {
            Object.assign(changeBuffer.payload, payload);
            return;
        }
        try { await actor.update(payload, { render: false }); }
        catch (err) { console.warn(`${SYSTEM_ID} | hunger-depth flag sync (stress off) failed`, err); }
        return;
    }

    // Stored debt — what the system has put on the actor. Lazy init to the
    // pre-change depth: an actor who enters tracking already deep is treated
    // as "already owed" — we don't retroactively dump 5 stress on them, but
    // ascending out will still refund the implicit debt.
    //
    // Self-heal against legacy stale flags: hungerStress is user-visible
    // ground truth (it's on the sheet and floors total stress via the
    // preUpdateActor hook). If the flag disagrees with it — a common state
    // for actors migrated from an older version of this mechanic that used
    // different depth thresholds — trust hungerStress. Prevents spurious
    // "gnaws deeper" chats when the flag was set to a stale higher/lower
    // depth than the actor is actually in.
    const rawFlag = actor.getFlag(SYSTEM_ID, HUNGER_DEBT_FLAG);
    const flagDebt = Number.isFinite(Number(rawFlag)) ? Number(rawFlag) : prevDepth;
    const curLocked = Number(actor.system?.hungerStress) || 0;
    const storedDebt = (flagDebt !== curLocked) ? curLocked : flagDebt;
    const delta = nextDepth - storedDebt;

    /* Compute the payload upfront. When `changeBuffer` is passed, MERGE it
     * so the outer adjustSatiety folds this into ONE combined actor.update
     * along with the satiety change + the intermediate-tier stress delta.
     * Direct-write fallback preserved for legacy callers. */
    const flagPath = `flags.${SYSTEM_ID}.${HUNGER_DEBT_FLAG}`;
    const payload = { [flagPath]: nextDepth };
    let actualDelta = 0;
    if (delta !== 0) {
        const newLocked = Math.max(0, Math.min(5, curLocked + delta));
        actualDelta = newLocked - curLocked;
        if (actualDelta !== 0) {
            const curStress = Number(actor.system?.stress) || 0;
            const nextStress = Math.max(0, curStress + actualDelta);
            payload["system.hungerStress"] = newLocked;
            payload["system.stress"] = nextStress;
        }
    }

    if (changeBuffer) {
        Object.assign(changeBuffer.payload, payload);
        if (actualDelta < 0) changeBuffer.opts.wdmHungerRefund = true;
        /* Record how much this helper contributed to the stress delta so
         * the intermediate-tier walk can add ON TOP without re-reading the
         * pre-update stress value (which would be stale after our payload
         * lands). */
        changeBuffer.famishedStressDelta = actualDelta;
    } else {
        try {
            const opts = { render: false };
            if (actualDelta < 0) opts.wdmHungerRefund = true;
            await actor.update(payload, opts);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | hunger-depth Hunger Stress failed`, err);
            return;
        }
    }
    if (delta === 0) return;                       // synced silently — no chat

    // Terse one-line chat feedback. Message shape:
    //   "Name · hunger gnaws deeper · +N Hunger Stress · max STA −M"
    // The STA-max-loss addendum only appears when the new tier's
    // staMaxFraction differs from the prev tier's — most descents into
    // Famished-N shrink max STA and the player should see how much.
    try {
        const ascending = delta < 0;
        const verb = ascending
            ? t("WITCHER.Mech.FoodAndDrink.Chat.StarvationEases", "starvation eases")
            : t("WITCHER.Mech.FoodAndDrink.Chat.StarvationGnaws", "hunger gnaws deeper");
        const sign = ascending ? "" : "+";
        /* Predict the max-STA loss the new tier will impose vs the previous
         * tier's fraction. `staMaxFraction` is negative (e.g. -0.125 for
         * famished-1). We report the ABSOLUTE point loss so the player
         * knows how much STA they're missing on the next turn. Read the
         * actor's currently-prepared sta.max BEFORE the tier AE lands —
         * that's the pre-loss baseline. */
        let staNote = "";
        try {
            const prevTier = tierForSatiety(prev, actor);
            const nextTier = tierForSatiety(next, actor);
            const prevFrac = Number(clauseFor(prevTier)?.mods?.derived?.staMaxFraction) || 0;
            const nextFrac = Number(clauseFor(nextTier)?.mods?.derived?.staMaxFraction) || 0;
            const fracDelta = nextFrac - prevFrac;
            if (fracDelta < 0) {
                const baselineMax = Number(actor.system?.derivedStats?.sta?.max) || 0;
                /* baselineMax already includes prevFrac's reduction; back out
                 * to the raw max, then apply nextFrac. */
                const rawMax = prevFrac !== -1 ? baselineMax / (1 + prevFrac) : baselineMax;
                const newMax = Math.max(0, Math.round(rawMax * (1 + nextFrac)));
                const lost = Math.max(0, Math.round(baselineMax) - newMax);
                if (lost > 0) staNote = tFormat("WITCHER.Mech.FoodAndDrink.Chat.StaMaxLoss", { n: lost }, ` · max STA −${lost}`);
            }
        } catch (_) { /* prediction is best-effort; skip note on any error */ }

        const messageData = {
            speaker: ChatMessage.getSpeaker({ actor }),
            whisper: collectFoodAudience(actor),
            content: tFormat(
                "WITCHER.Mech.FoodAndDrink.Chat.FamishedDepth",
                { name: actor.name, verb, sign, delta, staNote },
                `<b>${actor.name}</b> · ${verb} · <b>${sign}${delta}</b> Hunger Stress${staNote}`
            )
        };
        if (chatBuffer) chatBuffer.push(messageData);
        else            await ChatMessage.create(messageData);
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
async function applyIntermediateTierStress(actor, prev, next, chatBuffer = null, changeBuffer = null) {
    if (!actor || actor.type !== "character") return;
    if (!game.user?.isActiveGM) return;
    if (!isHomebrewEnabled("stress")) return;
    if (!Number.isFinite(prev) || !Number.isFinite(next)) return;
    const prevTier = tierForSatiety(prev, actor);
    const nextTier = tierForSatiety(next, actor);
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
        const s = Number(clauseFor(tier.id, actor)?.onApply?.stress);
        if (!Number.isFinite(s) || s === 0) continue;
        stressDelta += s;
        fired.push({ id: tier.id, s });
    }
    if (stressDelta === 0) return;
    /* When called with a changeBuffer, ADD to the pending stress payload
     * that applyFamishedDepthStress already computed (if any) — the outer
     * adjustSatiety merges everything into ONE actor.update. Direct-write
     * fallback preserved for legacy callers. */
    if (changeBuffer) {
        /* Base = whatever famished-depth already wrote to system.stress,
         * else the current on-disk value. That way both helpers' deltas
         * compose in a single field without one clobbering the other. */
        const baseStress = ("system.stress" in changeBuffer.payload)
            ? Number(changeBuffer.payload["system.stress"]) || 0
            : Number(actor.system?.stress) || 0;
        changeBuffer.payload["system.stress"] = Math.max(0, baseStress + stressDelta);
    } else {
        try { await grantStress(actor, stressDelta, { render: false }); }
        catch (err) {
            console.warn(`${SYSTEM_ID} | intermediate tier stress failed`, err);
            return;
        }
    }
    // Terse one-liner: "Name · passed Very Hungry, Weakening · +2 stress"
    try {
        const sign = stressDelta > 0 ? "+" : "";
        const list = fired.map(f => tierDisplayName(f.id)).join(", ");
        const messageData = {
            speaker: ChatMessage.getSpeaker({ actor }),
            whisper: collectFoodAudience(actor),
            content: tFormat(
                "WITCHER.Mech.FoodAndDrink.Chat.IntermediateTierPassed",
                { name: actor.name, list, sign, delta: stressDelta },
                `<b>${actor.name}</b> · passed ${list} · <b>${sign}${stressDelta}</b> stress`
            )
        };
        if (chatBuffer) chatBuffer.push(messageData);
        else            await ChatMessage.create(messageData);
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

    /* Shared chat buffer — helpers push message data instead of firing their
     * own `ChatMessage.create()` per event. The tail flush in the try/finally
     * below issues one `ChatMessage.createDocuments(buffer)` for the whole
     * batch, saving up to 2 network round-trips per cascade (famished-depth
     * chat + intermediate tier chat can both fire on a big jump). */
    const chatBuffer = [];
    try { return await _reconcileHungerStatusInner(actor, { prev, next }, chatBuffer); }
    finally {
        if (chatBuffer.length) {
            try { await ChatMessage.createDocuments(chatBuffer); }
            catch (err) { console.warn(`${SYSTEM_ID} | batched cascade chat flush failed`, err); }
        }
    }
}

async function _reconcileHungerStatusInner(actor, { prev, next }, chatBuffer) {
    // Famished-depth stress: while satiety is below 0, every additional −25
    // crossed on the way down grants +1 stress. Fired BEFORE the tier
    // reconcile so it lands even when the actor stays inside Famished
    // (e.g. −30 → −60 doesn't change tier but still crosses −50). Gated on
    // descent so eating back up out of starvation doesn't refund the cost.
    await applyFamishedDepthStress(actor, prev, next, chatBuffer);

    // Intermediate-tier stress: a satiety jump that crosses MULTIPLE hunger
    // tier boundaries in one update only instantiates the final tier's AE,
    // so the per-tier onApply.stress on intermediate tiers (Hungry's +1 on
    // descent, etc.) would otherwise silently disappear. Walk the strictly-
    // between tiers and fire their stress directly here.
    await applyIntermediateTierStress(actor, prev, next, chatBuffer);

    return _reconcileTierAndStaOnly(actor, prev, next);
}

/* Tier AE swap + STA clamp portion of the cascade — factored out so
 * `adjustSatiety` can call it directly after the combined actor.update
 * (which folded in the stress/hungerStress/flag changes upfront via the
 * change buffer). The full `reconcileHungerStatus` path still runs the
 * apply* helpers via `_reconcileHungerStatusInner` above so the sheet-edit
 * hook keeps working end-to-end. */
async function _reconcileTierAndStaOnly(actor, prev, next) {
    const v = Number.isFinite(next) ? next : (Number(actor.system?.satiety) || 0);
    const targetId = tierForSatiety(v, actor);
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
        // render:false so the sheet doesn't repaint on this intermediate
        // delete — the outer adjustSatiety triggers one render at the end.
        await safeDeleteEffects(actor, ownedTier.map(e => e.id), { render: false });
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

    const def = getStatusEffectDef(targetId);
    if (!def) return;
    // Per-tier flag enrichment. Gorged adds a healing-only REC bonus the
    // heal dialog reads (the displayed REC stat is intentionally left alone
    // — the bonus reflects the full belly powering daily recovery, not a
    // general stat shift).
    const tierFlags = { hungerTier: targetId };
    if (targetId === "gorged") tierFlags.healingRecBonus = 2;

    /* Prefer updating the EXISTING hunger AE in place when we have exactly
     * one AND we're not about to fire an onApply hook — saves the delete
     * round-trip that the old delete+create dance always paid. The
     * gorged-only healingRecBonus flag has to be actively WIPED (via a
     * ForcedDeletion) when transitioning off gorged; otherwise a Full/Fed actor coming
     * down from Gorged would keep the healing bonus forever.
     *
     * IMPORTANT: `updateEmbeddedDocuments` fires the `updateActiveEffect`
     * hook, NOT `createActiveEffect`. `onCreateActiveEffectStatus` (which
     * grants the per-tier `onApply.stress` — Gorged's -2 relief being the
     * main one) only runs on create. So when the incoming tier has an
     * `onApply` payload AND `fireOnApply` is true, we MUST take the
     * delete-then-create path or the relief silently drops.
     *
     * Fresh actors (no existing hunger AE) fall through to createEmbedded;
     * the rare multiple-hunger-AE state (a hook-race artifact) also falls
     * through to the safe delete-all + create-one path. */
    const targetHasOnApply = !!clauseFor(targetId)?.onApply;
    const canReuseAE = (ownedTier.length === 1) && !(fireOnApply && targetHasOnApply);
    const reuseTarget = canReuseAE ? ownedTier[0] : null;
    if (reuseTarget) {
        const payload = {
            _id: reuseTarget.id,
            name:        def.name,
            img:         def.img,
            description: descriptionFor(targetId) || def.description,
            disabled:    false,
            statuses:    [targetId],
            changes:     def.changes ?? [],
            [`flags.${SYSTEM_ID}.hungerTier`]: targetId
        };
        if (targetId === "gorged") payload[`flags.${SYSTEM_ID}.healingRecBonus`] = 2;
        else                       payload[`flags.${SYSTEM_ID}.healingRecBonus`] = new foundry.data.operators.ForcedDeletion();
        await actor.updateEmbeddedDocuments("ActiveEffect", [payload], { wdmSkipOnApply: !fireOnApply, render: false });
    } else {
        /* render:false on both the delete and the create so neither triggers
         * an intermediate sheet re-render — the outer adjustSatiety fires one
         * render at the end. */
        if (ownedTier.length) await safeDeleteEffects(actor, ownedTier.map(e => e.id), { render: false });
        await actor.createEmbeddedDocuments("ActiveEffect", [{
            name:        def.name,
            img:         def.img,
            // Live description so stress-on text matches the current toggle.
            description: descriptionFor(targetId) || def.description,
            disabled:    false,
            statuses:    [targetId],
            changes:     def.changes ?? [],
            flags:       { [SYSTEM_ID]: tierFlags }
        }], { wdmSkipOnApply: !fireOnApply, render: false });
    }

    // Clamp current STA down to the new max. Hungry / Famished shrink sta.max
    // via the engine's `staMaxFraction` aggregate (read at prepareDerivedData
    // time), so by the time createEmbeddedDocuments resolves the actor's
    // prepared sta.max reflects the new ceiling. If the player was sitting at
    // 45 STA and the new max is 23, they should land at 23/23 — not 45/23,
    // which reads as broken. No-op when max grew (eating back into a sated
    // tier) since the floor here is the unchanged current value.
    //
    // Fast-path skip: only Famished-1..4 shrink sta.max (via staMaxFraction).
    // If the new tier isn't one of those AND the old tier wasn't either,
    // sta.max can't have shrunk, so skip the read + potential update.
    try {
        const newFrac = Number(clauseFor(targetId)?.mods?.derived?.staMaxFraction) || 0;
        if (newFrac < 0) {
            const sta = actor.system?.derivedStats?.sta;
            const curVal = Number(sta?.value);
            const curMax = Number(sta?.max);
            if (Number.isFinite(curVal) && Number.isFinite(curMax) && curVal > curMax) {
                /* render:false — outer adjustSatiety triggers the single
                 * final render. */
                await actor.update({ "system.derivedStats.sta.value": curMax }, { render: false });
            }
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

    /* Parallelize per-actor cascades — each writes to its own document, no
     * cross-actor dependencies. Serial `await` per actor made a 10-PC world
     * take ~10× the time of a 1-PC world on every hour tick; Promise.all
     * lets Foundry's document layer pipeline the writes.
     *
     * Errors on one actor's cascade are logged (Promise.allSettled) and
     * don't halt the others — matches the pre-batch behaviour where an
     * `adjustSatiety` throw would be caught inside `reconcileHungerStatus`
     * and only warn to console. */
    const tasks = [];
    for (const actor of game.actors) {
        if (actor.type !== "character") continue;
        if (actor.statuses?.has?.("dead")) continue;
        /* Per-actor opt-in. Default off unless a player owns the actor.
         * NPC "character" actors stay silent unless the GM turns hunger
         * on for them explicitly. */
        if (!isHungerActive(actor)) continue;
        const loss = hourlySatietyLoss(actor) * hours;
        tasks.push(adjustSatiety(actor, -loss).catch(err => {
            console.warn(`${SYSTEM_ID} | hourly hunger tick failed for ${actor.name}`, err);
        }));
    }
    if (tasks.length) await Promise.allSettled(tasks);
}

/** Whether hourly hunger applies to this actor.
 *
 *  Semantics:
 *    - Explicit flag `true`   → hunger ticks for this actor
 *    - Flag absent OR false   → hunger is OFF (skipped by the hourly tick,
 *                               skipped by consume, skipped by cascade)
 *
 *  Default is now OFF for every actor — a world with 20 unowned NPCs was
 *  running the full satiety cascade (20 × cascade cost) on every hour tick
 *  and every consume, causing the perceptible day-skip lag the user
 *  reported. The GM opts an actor in explicitly via the checkbox in the
 *  SatietyDialog (or `setHungerActive(actor, true)` programmatically). */
export function isHungerActive(actor) {
    return actor?.getFlag?.(SYSTEM_ID, "hungerActive") === true;
}

/** GM writes the per-actor hunger toggle. Explicitly persisted so an
 *  actor's state doesn't flip when a player is later assigned or
 *  unassigned. */
export async function setHungerActive(actor, active) {
    if (!actor) return false;
    await actor.setFlag(SYSTEM_ID, "hungerActive", !!active);
    return !!active;
}

/** True iff any race item on the actor sets `foodSicknessImmune`. Ghouls,
 *  iron-gutted dwarves, and any bespoke race the GM authored can opt in
 *  via the race sheet checkbox. Consulted BEFORE the Endurance roll in
 *  applySpoiledHazard so immune actors skip the hazard silently. */
export function hasFoodSicknessImmunity(actor) {
    const races = actor?.items?.filter?.(i => i.type === "race") ?? [];
    return races.some(r => r?.system?.foodSicknessImmune === true);
}

/** Audience for a food/drink/hunger chat message: every user with OWNER
 *  permission on the actor, plus all GMs. Other players don't see
 *  someone else's PC becoming hungry, drunk, or hungover. Fed into
 *  ChatMessage.create's `whisper` field on every food/drink event. */
export function collectFoodAudience(actor) {
    const ids = new Set();
    const users = game.users?.contents ?? [];
    for (const u of users) {
        if (u.isGM) { ids.add(u.id); continue; }
        if (actor?.testUserPermission?.(u, "OWNER")) ids.add(u.id);
    }
    return [...ids];
}

/* Spoilage transition detector. Freshness state is derived from worldTime,
 * so a time advance can flip an item from Fresh / Stale → Spoiled without
 * any document update firing. Walk every actor's food items once per advance;
 * for each tracked item, compute what its state WAS at the start of the
 * window vs what it is now. If it just crossed into Spoiled (and the actor
 * is alive), post a chat message so the player isn't surprised the next time
 * they try to eat it. GM-only writer so multi-client sessions don't double-post. */
/* Cached "next in-world time any tracked food item will spoil".
 *   null      → unknown; sweep must run + recompute on next tick
 *   Infinity  → no tracked spoilage anywhere in the world; sweep is a no-op
 *   number    → the earliest anchor+shelfLife across every tracked food
 *
 * Skips the full O(actors × items) iteration on 99% of world-time ticks —
 * only crosses the threshold and runs the body once per real spoilage. */
let _nextSpoilageAt = null;

/* Last worldTime the sweep body actually ran through. Used as the `before`
 * anchor of the transition detection so a skipped tick window still lets
 * items that spoiled DURING that window get caught on the first run after
 * they cross. Using `now - delta` from Foundry's hook args would only look
 * one tick back — miss the transition if the cache skipped intermediate
 * ticks. Initialized lazily on first sweep. */
let _lastSweptWT = null;

/* External invalidation for the spoilage cache. Called from item CRUD
 * hooks so a fresh-food purchase / anchor update / GM-set shelf life
 * change forces the next sweep tick to recompute. Cheap: single ref
 * assignment, no iteration until the next updateWorldTime. */
function invalidateSpoilageCache() { _nextSpoilageAt = null; }

async function onWorldTimeFreshnessSweep(worldTime, delta) {
    if (!isHomebrewEnabled("foodAndDrink")) return;
    if (!game.user?.isActiveGM) return;
    const d = Number(delta);
    if (!(d > 0)) return;
    /* Cache fast-path: if the earliest known spoilage is still in the future
     * relative to the new worldTime, nothing needs processing this tick. */
    const nowWT = Number(worldTime);
    if (_nextSpoilageAt !== null && Number.isFinite(nowWT) && nowWT < _nextSpoilageAt) {
        return;
    }
    /* Per-GM opt-out — chat.spoilageNotifications toggle in the Food & Drink
     * config. When off, we STILL run the sweep body so items get halved at
     * spoilage; we only skip the chat card creation. Default on preserves
     * pre-toggle behaviour for existing worlds. */
    const cfg = getFoodAndDrinkConfig();
    const chatOn = cfg?.chat?.spoilageNotifications !== false;
    const now    = Number(worldTime);
    const spd    = secondsPerDay();
    /* Batch every per-actor spoilage card into one createDocuments call so
     * a day-skip that turns food on N actors doesn't fire N serial chat
     * roundtrips (biggest visible stutter source on multi-PC parties). */
    const messages = [];
    for (const actor of game.actors ?? []) {
        if (actor.type !== "character" && actor.type !== "loot") continue;
        const justSpoiled = [];
        /* Per-item satiety halving batch — collect update payloads here
         * and flush with one updateEmbeddedDocuments call per actor.
         *
         * Detection uses a "currently spoiled AND not yet processed" flag
         * check instead of a wasRatio<1 → nowRatio>=1 transition. The
         * transition approach broke for two important cases:
         *   • Items that were ALREADY spoiled when the world loaded
         *     (previous session, or spoilage happened before this handler
         *     existed) — wasRatio is already >= 1, transition never fires.
         *   • Items whose GM-edited shelfLife just retroactively pushed
         *     them into spoiled — same problem.
         * The `spoilageProcessed` flag closes both cases: any currently-
         * spoiled item without the flag gets halved once, stamped, and
         * never re-halves. */
        const itemUpdates = [];
        for (const item of (actor.items ?? [])) {
            if (item.type !== "food") continue;
            const days = Number(item.system?.freshness?.shelfLifeDays) || 0;
            if (days <= 0) continue;
            const anchorRaw = item.system?.freshness?.anchorTime;
            if (anchorRaw == null) continue;
            const anchor = Number(anchorRaw);
            if (!Number.isFinite(anchor)) continue;
            const nowRatio = (now - anchor) / spd / days;
            if (nowRatio < 1) continue;                    // still fresh/stale
            if (item.getFlag(SYSTEM_ID, "spoilageProcessed") === true) continue; // already halved
            justSpoiled.push(item);
            const restore = Number(item.system?.satietyRestore) || 0;
            const payload = {
                _id: item.id,
                [`flags.${SYSTEM_ID}.spoilageProcessed`]: true
            };
            if (restore > 0) payload["system.satietyRestore"] = Math.floor(restore / 2);
            itemUpdates.push(payload);
        }
        if (itemUpdates.length) {
            try { await actor.updateEmbeddedDocuments("Item", itemUpdates, { render: false }); }
            catch (err) { console.warn(`${SYSTEM_ID} | spoilage satiety halve failed`, err); }
        }
        if (!justSpoiled.length) continue;
        /* Chat is gated by the per-GM toggle. Halving above always runs. */
        if (!chatOn) continue;
        /* Build the item-name list first (each item wrapped in <li>),
         * then hand the whole card to i18n via tFormat. Item names
         * themselves are user/GM data and stay as-is; the surrounding
         * "<name> — food has spoiled:" prose is what gets translated. */
        const lines = justSpoiled.map(it => `<li><b>${it.name}</b></li>`).join("");
        messages.push({
            speaker: ChatMessage.getSpeaker({ actor }),
            whisper: collectFoodAudience(actor),
            content: tFormat(
                "WITCHER.Mech.FoodAndDrink.Chat.FoodSpoiled",
                { actor: actor.name, lines },
                `<div style="border-left:3px solid #a83232;padding:4px 8px"><b>${actor.name}</b> — food has spoiled:<ul style="margin:4px 0 0 14px;padding:0;">${lines}</ul></div>`
            )
        });
    }
    if (messages.length) {
        try { await ChatMessage.createDocuments(messages); }
        catch (err) { console.warn(`${SYSTEM_ID} | batched spoilage announcement failed`, err); }
    }

    /* Recompute the earliest future-spoilage worldTime across all remaining
     * tracked food items. Next `updateWorldTime` tick can skip the whole
     * sweep body until crossing this threshold. Infinity when nothing's
     * tracked anywhere. Also stamp `_lastSweptWT` = nowWT so the NEXT run
     * uses this moment as the "before" anchor for its transition math. */
    _nextSpoilageAt = _computeNextSpoilageAt(nowWT);
    _lastSweptWT = nowWT;
}

/* Scan every food item across every actor for the earliest future
 * `anchor + shelfLifeDays × secondsPerDay` — the moment the NEXT item is
 * due to cross into spoiled. Items already past their shelf life are
 * skipped (they've been processed above; the sweep's `wasRatio < 1 &&
 * nowRatio >= 1` transition guard won't re-fire on subsequent ticks
 * even if the cache is invalidated). Untracked items (shelfLifeDays === 0
 * or no anchor) can't spoil at all — user-confirmed semantic. */
function _computeNextSpoilageAt(nowWT) {
    const spd = secondsPerDay();
    let earliest = Infinity;
    for (const actor of (game.actors ?? [])) {
        if (actor.type !== "character" && actor.type !== "loot") continue;
        for (const item of (actor.items ?? [])) {
            if (item.type !== "food") continue;
            const days = Number(item.system?.freshness?.shelfLifeDays) || 0;
            if (days <= 0) continue;
            const anchor = Number(item.system?.freshness?.anchorTime);
            if (!Number.isFinite(anchor)) continue;
            const spoilAt = anchor + days * spd;
            if (spoilAt > nowWT && spoilAt < earliest) earliest = spoilAt;
        }
    }
    return earliest;
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
const SPOILED_HAZARD_DC      = 16;
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
    /* Merchant-frozen food: unless the GM has explicitly toggled decay ON
     * for this specific item via the merchant stock button, freshness on
     * merchant shelves does NOT tick. Prevents the "buy a fresh apple that
     * silently spoiled in the shop over game weeks" bug. Decay resumes
     * once the item lands on a character/loot actor. */
    if (isMerchantFrozenFood(item)) return "fresh";
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
    /* Frozen on a merchant shelf — no meaningful "days remaining" reading;
     * the shelf life clock isn't running. Return null so tooltips hide the
     * readout rather than showing a stale count. */
    if (isMerchantFrozenFood(item)) return null;
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
    /* Merchant with decay OFF (the default) never gets an anchor stamped.
     * The item is treated as fresh while on the shelf and becomes
     * anchor-stamped only when it lands on a character/loot actor via
     * purchase / transfer (createItem hook re-fires on the receiver). */
    if (isMerchantFrozenFood(item)) return;
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

/* True when this item is a food item sitting on a merchant WITHOUT the
 * per-item "decay enabled" opt-in flag. Freshness reads and stamps
 * short-circuit on this so a shop's stock doesn't age between reloads.
 * Any other parent (character, loot, world sidebar) always returns false —
 * only merchants freeze food. */
export function isMerchantFrozenFood(item) {
    if (item?.type !== "food") return false;
    if (item?.parent?.type !== "merchant") return false;
    const decayOn = item.getFlag?.(SYSTEM_ID, "merchantFreshnessDecay");
    return decayOn !== true;
}

/**
 * Resolve the spoiled-food hazard. Endurance roll vs SPOILED_HAZARD_DC; on
 * failure, apply a 24-hour Food Sickness AE (−2 STA max, mild roll penalty).
 * Posted as a chat message either way so the table sees the outcome.
 */
async function applySpoiledHazard(actor, itemName) {
    if (!actor) {
        console.warn(`${SYSTEM_ID} | applySpoiledHazard called with no actor — bailing`);
        return;
    }
    /* Race-level immunity (race.system.foodSicknessImmune). Skip the roll
     * entirely, skip the chat card — for immune races the spoiled state
     * is a flavor cue for the player, not a mechanical event. */
    if (hasFoodSicknessImmunity(actor)) return;
    console.log(`${SYSTEM_ID} | applySpoiledHazard fired for ${actor.name} eating ${itemName}`);
    const dc = SPOILED_HAZARD_DC;
    // Endurance roll with a safe-zero fallback. If the actor sheet hasn't
    // populated the skill yet (sheet never opened on a freshly imported
    // monster, etc.), `_readSkillValues` returns null and we roll plain
    // 1d10. The roll evaluate itself is also caught so a broken Foundry
    // dice config doesn't make the whole hazard go silent — we keep
    // going with total=1 (worst case for the eater) and post the chat
    // so the table at least SEES the consume attempt.
    let total = 1;
    try {
        const v = actor._readSkillValues?.("endurance");
        const formula = v ? `1d10 + ${v.total}` : "1d10";
        total = (await new Roll(formula).evaluate()).total;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | spoiled-food endurance roll failed — defaulting to 1`, err);
    }
    const pass = total >= dc;
    const flavor = pass
        ? `<b style="color:#4a7c59">${t("WITCHER.Mech.FoodAndDrink.Text.StomachHolds", "stomach holds.")}</b>`
        : `<b style="color:#8b0000">${t("WITCHER.Mech.FoodAndDrink.Text.FoodSicknessSetsIn", "food sickness sets in.")}</b>`;
    try {
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            whisper: collectFoodAudience(actor),
            content: `<div style="border-left:3px solid #6b3f3f;padding:4px 8px">
                ${tFormat("WITCHER.Mech.FoodAndDrink.Text.SwallowedSpoiled", { name: actor.name, item: itemName }, `<b>${actor.name}</b> swallowed spoiled <b>${itemName}</b>.`)}<br>
                ${tFormat("WITCHER.Mech.FoodAndDrink.Text.EnduranceResult", { total, dc, flavor }, `Endurance ${total} vs DC ${dc} — ${flavor}`)}
            </div>`
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | spoiled-food chat post failed`, err);
    }
    if (pass) return;

    // Fail: apply Food Sickness AE for FOOD_SICKNESS_DAYS in-game days.
    // Wrap BOTH the existing-wipe and the create in try/catch — without
    // this, a stale-id throw from safeDeleteEffects would skip the
    // create entirely and the AE would never land. The result was a
    // visible chat ("food sickness sets in") with no actual effect on
    // the actor — the classic "food sickness isn't really working".
    const def = getStatusEffectDef("food-sickness");
    try {
        const existing = actor.effects.filter(e => e.statuses?.has?.("food-sickness"));
        if (existing.length) await safeDeleteEffects(actor, existing.map(e => e.id));
    } catch (err) {
        console.warn(`${SYSTEM_ID} | food-sickness pre-clear failed (continuing to create)`, err);
    }
    try {
        const created = await actor.createEmbeddedDocuments("ActiveEffect", [{
            name:        def?.name || t("WITCHER.Mech.FoodAndDrink.Text.FoodSickness", "Food Sickness"),
            img:         def?.img  || "systems/witcher-ttrpg-death-march/assets/icons/statuses/food-sickness.svg",
            description: descriptionFor("food-sickness") || def?.description || t("WITCHER.Mech.FoodAndDrink.Text.FoodSicknessDesc", "Food sickness from spoiled food."),
            disabled:    false,
            statuses:    ["food-sickness"],
            changes:     def?.changes ?? [],
            // v14 anchor: legacy `duration.startTime` shim, which Foundry
            // migrates to `start.time` while filling the required sibling
            // fields with their schema defaults (initiative/round/turn).
            // A partial `start: { time }` would risk validation rejection.
            duration:    { seconds: FOOD_SICKNESS_DAYS * secondsPerDay(),
                           startTime: Number(game.time?.worldTime) || 0 }
        }]);
        console.log(`${SYSTEM_ID} | food-sickness AE created`, created?.[0]?.id, "on", actor.name);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | food-sickness AE create failed`, err);
    }
}

/* ─────────── Diet tier / bland-stack mechanic ────────────────────────────── */

/**
 * Bland-diet stack accounting. Runs ONCE per consumed portion, after satiety
 * is adjusted and before the item's authored AE blob is copied to the actor.
 *
 *   POOR  + blandFood:true  → stacks += 1. If stacks ≥ WILL, fires +1 stress
 *                              via grantStress() and resets stacks to 0.
 *   POOR  + blandFood:false → no-op (foraged berries, hand-cakes, ritual
 *                              offerings — narratively not "a bad meal").
 *   MEDIUM                  → stacks = max(0, stacks - 1). No bonus AE.
 *   GOOD                    → stacks = max(0, stacks - 2). Authored AE
 *                              applies via the copy step below.
 *   LAVISH                  → stacks = max(0, stacks - 3) + grantStress(-1)
 *                              at consume. Authored AE also applies.
 *
 * Gated on the `stress` homebrew toggle — same as the famished-depth and
 * intermediate-tier stress mechanics already in this file. If stress is off,
 * the stack still moves (for save-data consistency) but no stress is granted.
 *
 * Players-only: NPCs / monsters don't accumulate diet stress.
 */
async function applyDietTierMechanics(item) {
    const actor = item?.actor;
    /* Loud entry-log so a failure to tick is diagnosable: every consume
     * that reaches this function prints its item type / kind / tier /
     * blandFood / actor. If the log DOESN'T appear when you consume,
     * upstream `onConsume` short-circuited (raw-ingredient gate, spoiled-
     * food gate, already-full guard, or the foodAndDrink homebrew being
     * off). If it DOES appear and the stack doesn't move, the `diet.result`
     * log below shows which branch was chosen. Console filter: `diet.`. */
    console.log(`witcher-ttrpg-death-march | diet.enter: name="${item?.name}" type=${item?.type} kind=${item?.system?.kind} tier=${item?.system?.tier} blandFood=${item?.system?.blandFood} actor=${actor?.name} (type=${actor?.type})`);

    if (!actor || actor.type !== "character") { console.log("  diet.exit: non-character actor"); return; }
    if (item?.type !== "food") { console.log(`  diet.exit: non-food item (type=${item?.type})`); return; }

    const tier = String(item.system?.tier || "medium").toLowerCase();
    const blandFood = item.system?.blandFood !== false;   // default true
    const itemName = item.name;
    const stressOn = isHomebrewEnabled("stress");

    // WILL is needed for both threshold check and the AE label ("3/6
    // sittings"). Compute once up front so the same value is used everywhere.
    const will = Math.max(1, Number(getWill(actor)) || 1);
    const current = readBlandStack(actor);
    let next = current;
    let stressFired = 0;
    let stressNote = "";

    const isDrink = item.system?.kind === "drink";

    /* Drink-specific rule: POOR drinks never contribute to the bland-
     * diet stack — drinking cheap ale isn't "bland eating." The drunk-
     * level mechanic (handleEnduranceRoll above) is the poor-drink
     * consequence. Everything above poor tier reduces the stack the
     * same way food does — a fine drink lifts the diet fatigue just
     * like a fine meal, per the player's request. */
    if (isDrink && tier === "poor") return;

    if (tier === "poor") {
        if (!blandFood) {
            // No-op for POOR forage / sweet / ritual items — they don't
            // contribute to bland accumulation.
            return;
        }
        next = current + 1;
        if (next >= will) {
            stressFired = 1;
            stressNote = tFormat(
                "WITCHER.Mech.FoodAndDrink.DietTier.BlandTriggerReason",
                { sittings: will, actor: actor.name },
                `Bleak diet — ${will} sittings of poor food caught up with ${actor.name}`
            );
            next = 0;
        }
    } else if (tier === "medium") {
        next = Math.max(0, current - 1);
    } else if (tier === "good") {
        next = Math.max(0, current - 2);
    } else if (tier === "lavish") {
        next = Math.max(0, current - 3);
        stressFired = -1;
        stressNote = isDrink
            ? tFormat("WITCHER.Mech.FoodAndDrink.DietTier.LavishReasonDrink", { item: itemName }, `A truly fine drink — ${itemName}`)
            : tFormat("WITCHER.Mech.FoodAndDrink.DietTier.LavishReasonMeal",  { item: itemName }, `A truly fine meal — ${itemName}`);
    } else {
        return;   // unknown tier, leave stacks untouched
    }

    console.log(`  diet.result: tier=${tier} kind=${item.system?.kind} blandFood=${blandFood} → stack ${current}→${next} (delta ${next-current}) stress=${stressFired}`);
    if (next !== current) {
        await writeBlandStack(actor, next, will);
    }

    if (stressFired !== 0 && stressOn) {
        try {
            await grantStress(actor, stressFired, { reason: stressNote });
        } catch (err) {
            console.warn(`${SYSTEM_ID} | diet-tier stress grant failed`, err);
        }
    }

    // Chat ping summarising the stack change. Keep terse so the consume flow
    // (taste, satiety, AE) doesn't drown the chat log. Match the sheet badge
    // wording so "Bland meal" on the sheet corresponds to "Bland meal" in chat.
    const delta = next - current;
    /* Localized tier label (Bland/Modest/Good/Lavish) + noun (drink/meal).
     * Each has its own key so translators can adapt adjective/noun agreement
     * per language rather than fighting concatenation. */
    const tierFallbackLabels = { poor: "Bleak", medium: "Modest", good: "Good", lavish: "Lavish" };
    const tierLabelKey = { poor: "Poor", medium: "Medium", good: "Good", lavish: "Lavish" }[tier];
    const tierLabel = t(`WITCHER.Mech.FoodAndDrink.DietTier.Label.${tierLabelKey}`, tierFallbackLabels[tier]);
    const consumeVerb = isDrink
        ? t("WITCHER.Mech.FoodAndDrink.DietTier.Kind.Drink", "drink")
        : t("WITCHER.Mech.FoodAndDrink.DietTier.Kind.Meal",  "meal");
    // The stress lines only render when stress homebrew is actually on —
    // otherwise grantStress() was a no-op and the chat would lie about
    // a state change that didn't happen.
    if (delta !== 0 || (stressFired !== 0 && stressOn)) {
        const sign  = delta > 0 ? "+" : "";
        const color = delta > 0 ? "#6b3f3f" : (delta < 0 ? "#4a7c59" : "#8b6f3a");
        const stressLine = (stressFired > 0 && stressOn)
            ? t("WITCHER.Mech.FoodAndDrink.DietTier.StressLineBland",  `<div style="margin-top:4px;color:#6b3f3f"><b>+1 stress</b> — bland diet caught up.</div>`)
            : (stressFired < 0 && stressOn)
                ? t("WITCHER.Mech.FoodAndDrink.DietTier.StressLineLavish", `<div style="margin-top:4px;color:#4a7c59"><b>−1 stress</b> — a fine meal lifts the spirit.</div>`)
                : "";
        /* The "count delta" parenthetical is optional (only shown when the
         * bland stack actually moved), so it's its own key with the same
         * placeholders present in the outer template. */
        const deltaSuffix = delta !== 0
            ? tFormat(
                "WITCHER.Mech.FoodAndDrink.DietTier.DeltaSuffix",
                { sign, delta, next },
                ` (bland count: <b>${sign}${delta}</b>, now <b>${next}</b>)`
            )
            : "";
        try {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                whisper: collectFoodAudience(actor),
                content: tFormat(
                    "WITCHER.Mech.FoodAndDrink.DietTier.ChatCard",
                    { color, actor: actor.name, label: tierLabel, kind: consumeVerb, deltaSuffix, stressLine },
                    `<div style="border-left:3px solid ${color};padding:4px 8px;color:${color}"><b>${actor.name}</b> — ${tierLabel} ${consumeVerb}${deltaSuffix}.${stressLine}</div>`
                )
            });
        } catch (err) {
            console.warn(`${SYSTEM_ID} | diet chat ping failed`, err);
        }
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
            console.log(`${SYSTEM_ID} | ingredient consume: ${item.name} edible=${edible} makesSick=${makesSick} actor=${item.actor?.name ?? "<none>"}`);
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
        // items STILL restore satiety — the item's satietyRestore field
        // was already halved by the freshness sweep the moment it turned
        // spoiled (visible in inventory), so we just use the current stored
        // value directly. Skip the taste line, the diet-tier + AE copies,
        // and the alcohol roll (spoiled meals don't confer their authored
        // effects). Charge tick runs so the spoiled portion is consumed.
        const freshState = getFreshnessState(item);
        const shelfLifeDays = Number(item.system?.freshness?.shelfLifeDays) || 0;
        const anchorTime    = item.system?.freshness?.anchorTime;
        console.log(`${SYSTEM_ID} | consume freshness check: ${item.name} state=${freshState} shelfLife=${shelfLifeDays}d anchor=${anchorTime} now=${game.time?.worldTime} actor=${item.actor?.name ?? "<none>"}`);
        if (freshState === "spoiled" && item.actor) {
            /* Belt-and-braces: if the sweep hasn't processed this item yet
             * (edge case — no worldTime tick between spoilage and consume),
             * halve satietyRestore here and stamp the processed flag so
             * the sweep's later pass short-circuits. */
            if (item.getFlag(SYSTEM_ID, "spoilageProcessed") !== true) {
                try {
                    const restoreNow = Number(item.system?.satietyRestore) || 0;
                    const payload = { [`flags.${SYSTEM_ID}.spoilageProcessed`]: true };
                    if (restoreNow > 0) payload["system.satietyRestore"] = Math.floor(restoreNow / 2);
                    await item.update(payload, { render: false });
                } catch (err) {
                    console.warn(`${SYSTEM_ID} | consume-time spoilage halve failed`, err);
                }
            }
            await applySpoiledHazard(item.actor, item.name);
            /* Use the (now-halved) satietyRestore directly. Skips the
             * already-full guard on purpose — the spoiled swallow always
             * goes down (you can't turn down what you already committed
             * to eating), and adjustSatiety clamps at the ceiling anyway. */
            const restore = Number(item.system?.satietyRestore) || 0;
            if (restore > 0 && item.actor.type === "character") {
                await adjustSatiety(item.actor, restore);
            }
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
        // ALREADY at the GORGED ceiling — MAX × 1.25 — which is the absolute
        // top of the pool including the overflow band from big meals. If
        // they're below their personal Gorged cap the consume goes through
        // and adjustSatiety clamps. Drinks aren't exempt; drinks with
        // `satietyRestore: 0` still go through at any value.
        if (restore > 0 && item.actor?.type === "character") {
            const cur = Number(item.actor.system?.satiety) || 0;
            const ceil = getSatietyGorgedCeil(item.actor);
            if (cur >= ceil) {
                /* verb / more each pick their own localized noun via the
                 * .Drink vs .Food sub-keys so a translator can adapt the
                 * verb agreement per language rather than fighting a
                 * hard-coded English "eat"/"drink". */
                const isDrink = item.system?.kind === "drink";
                const verb = t(
                    isDrink ? "WITCHER.Mech.FoodAndDrink.Verb.Drink" : "WITCHER.Mech.FoodAndDrink.Verb.Eat",
                    isDrink ? "drink" : "eat"
                );
                const more = t(
                    isDrink ? "WITCHER.Mech.FoodAndDrink.More.Sip" : "WITCHER.Mech.FoodAndDrink.More.Bite",
                    isDrink ? "another sip" : "another bite"
                );
                ui?.notifications?.info?.(tFormat(
                    "WITCHER.Mech.FoodAndDrink.Notify.TooFullToConsume",
                    { actor: item.actor.name, verb, item: item.name },
                    `${item.actor.name} is too full to ${verb} ${item.name}.`
                ));
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: item.actor }),
                    whisper: collectFoodAudience(item.actor),
                    content: tFormat(
                        "WITCHER.Mech.FoodAndDrink.Chat.TooStuffedForMore",
                        { actor: item.actor.name, more, item: item.name },
                        `<div style="border-left:3px solid #8b6f3a;padding:4px 8px"><b>${item.actor.name}</b> is too stuffed for ${more} of <b>${item.name}</b>.</div>`
                    )
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
                whisper: collectFoodAudience(item.actor),
                content: `<div style="border-left:3px solid #8b6f3a;padding:4px 8px">
                    <b>${item.actor?.name ?? "Someone"}</b> eats <b>${item.name}</b>.<br>
                    <i>${taste}</i>${staleLine}
                </div>`
            });
        }
        if (restore > 0 && item.actor?.type === "character") {
            /* Fresh/stale path — spoiled food is handled earlier with
             * its own halved-satiety branch, so this only sees full
             * satiety values. */
            await adjustSatiety(item.actor, restore);
        }
        // Diet-tier mechanic: bland-stack accounting + LAVISH stress relief.
        // Runs once per consumed portion, after satiety, before AE copy.
        // Players-only and homebrew-gated inside the function.
        await applyDietTierMechanics(item);
        // Copy any authored ActiveEffects onto the consumer. Mirrors the
        // alchemical consumable pattern — effects live dormant on the item
        // (transfer:false from WitcherFoodSheet) and only apply on use.
        // Each copy is independent (no link back) so it lingers on its own
        // duration / persists indefinitely if no duration was authored.
        //
        // Axis-aware refresh: if a new AE carries a `flags.wdm.foodAxis`
        // tag and the actor already has an AE with the same axis (e.g.
        // two GOOD meat dishes → two "stamax-good" AEs), the existing AE's
        // duration is reset instead of stacking a duplicate. Cross-axis
        // bonuses (meat + fish) still stack because their axes differ.
        if (item.actor?.documentName === "Actor" && item.effects?.size) {
            const lingering = [];
            const refresh = [];
            for (const eff of item.effects) {
                if (eff.disabled) continue;
                const data = eff.toObject();
                delete data._id;
                data.transfer = false;
                data.disabled = false;
                data.origin   = item.actor.uuid;
                // Inherit the parent item's icon on the actor-side copy —
                // GMs authoring per-item AEs shouldn't also have to re-set
                // the AE's img to match. Foundry seeds a generic aura.svg
                // when the GM creates an AE via the sheet, which lands on
                // the character looking nothing like the food that granted
                // it. Force the food's own image so the actor's effects bar
                // reads visually as "consumed X" at a glance.
                data.img = item.img;
                // Safety net for legacy data: the BASE item sheet's
                // _onCreateEffect used to default new effects' name to the
                // item's name. That meant eating "Mead" stamped a "Mead" AE
                // on the actor, which reads more like the item than its
                // effect. Strip that auto-default down to a neutral fallback
                // — the GM can rename on the food sheet to anything else.
                if (data.name === item.name) data.name = "Effect";

                // Migrate the legacy `wdm` flag scope to the registered
                // system id so Foundry v13 doesn't strip it on write. If
                // both are present the registered one wins.
                if (data.flags?.wdm?.foodAxis && !data.flags?.[SYSTEM_ID]?.foodAxis) {
                    data.flags[SYSTEM_ID] = { ...(data.flags[SYSTEM_ID] ?? {}), foodAxis: data.flags.wdm.foodAxis };
                }
                if (data.flags?.wdm) delete data.flags.wdm;

                // Axis-aware refresh check — read either scope so legacy
                // and freshly-created AEs both match.
                const axis = data.flags?.[SYSTEM_ID]?.foodAxis ?? data.flags?.wdm?.foodAxis;
                if (axis) {
                    const existing = item.actor.effects.find(e =>
                        (e.flags?.[SYSTEM_ID]?.foodAxis ?? e.flags?.wdm?.foodAxis) === axis);
                    if (existing) {
                        // Partial duration shape — Foundry's updateEmbeddedDocuments
                        // recursive-merges into the existing duration object, so
                        // we don't need to spread existing.duration (doing so risks
                        // mixing legacy startTime with v14's start.time sibling and
                        // tripping validation). Just write the new seconds (carries
                        // the authored 24h window forward) and reset startTime to
                        // "now" so the duration window resets.
                        refresh.push({
                            _id: existing.id,
                            duration: {
                                seconds: data.duration?.seconds
                                      ?? existing.duration?.seconds,
                                startTime: Number(game.time?.worldTime) || 0
                            }
                        });
                        continue;
                    }
                }
                lingering.push(data);
            }
            if (refresh.length) {
                try {
                    await item.actor.updateEmbeddedDocuments("ActiveEffect", refresh);
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | food AE refresh failed", err);
                }
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
    /* Burn is a PERCENTAGE of the actor's satiety MAX per STA spent —
     * the fixed-absolute rate insulated bigger-BODY characters from combat
     * hunger (BODY 12 with MAX 96 lost 6.5% per 25-STA fight vs BODY 5's
     * 8.7% of MAX 72). Percentage-based scaling makes every character feel
     * the same PROPORTIONAL cost regardless of body size.
     *
     * Default 0.35% × MAX per STA calibrates so that a BODY 5-8 character
     * (MAX 72) burns ~0.25 satiety per STA — matching the previous
     * absolute-rate feel at the mid-body reference point. Bigger characters
     * lose more absolute satiety per STA but the % of pool is uniform.
     *
     * The per-actor `satietyDrain.scale` (from ActiveEffects) still folds
     * in — an Iron Stomach perk that halves hourly drain also halves the
     * combat-STA burn for symmetry. */
    const rate = Number(getFoodAndDrinkConfig().decay.combatStaPerUnit);
    const pctPerSta = Number.isFinite(rate) ? rate : 0.0025;
    const scale = Number(actor?.system?.satietyDrain?.scale);
    const safeScale = Number.isFinite(scale) ? Math.max(0, scale) : 1;
    const max = getSatietyCeil(actor);
    await adjustSatiety(actor, -pctPerSta * max * safeScale * Number(staSpent));
}

// Default rate, kept exported for back-compat with macros / chat-bot tools
// that referenced the constant. Legacy absolute-satiety-per-STA meaning
// has been replaced with the percentage-of-MAX-per-STA semantic; the
// constant is retained so any old macro that read it still evaluates,
// but macros should switch to the multiplier + getSatietyCeil pattern.
export const COMBAT_SATIETY_PER_STA = 0.0025;

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
            whisper: collectFoodAudience(actor),
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
                // Suppress the red toast — the underlying race is handled
                // upstream (safeDeleteEffects dedup + Foundry-registry veto
                // for paused AEs). One quiet console.debug so it's still
                // findable if we need to trace a real regression, but not
                // scary red console output on every OOC tick.
                console.debug(`${SYSTEM_ID} | stale-id delete swallowed: ${text}`);
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

    /* Cache invalidation for the per-actor satiety-ceiling cache
     * (getSatietyCeil). Only invalidate when the actual INPUTS to the
     * ceiling formula changed — BODY or the satietyDrain flags. The
     * naive "invalidate on any updateActor" approach was self-defeating:
     * cascade writes fired updateActor, which wiped the cache mid-cascade,
     * forcing every subsequent getSatietyCeil call in the same cascade
     * to recompute. Config change wipes the whole cache since
     * base/bodyDivisor also feed the formula. */
    Hooks.on("updateActor", (actor, changes) => {
        if (!actor?.id) return;
        const bodyChanged = foundry.utils.hasProperty(changes ?? {}, "system.stats.body");
        const drainChanged = foundry.utils.hasProperty(changes ?? {}, "system.satietyDrain");
        if (bodyChanged || drainChanged) invalidateCeilCache(actor.id);
    });
    Hooks.on("deleteActor", (actor) => { invalidateCeilCache(actor?.id); });
    Hooks.on("updateSetting", (setting) => {
        if (setting?.key === `${SYSTEM_ID}.foodAndDrinkConfig`) invalidateCeilCache();
    });

    Hooks.on("updateWorldTime", onWorldTimeHourTick);
    // Replaces the legacy `onWorldTimeDayTick` (which decremented a
    // daysRemaining flag manually). Now hangover & drunk both have native
    // Foundry duration; this sweep deletes hangover AEs and runs the
    // auto-sober check on expired drunk AEs.
    Hooks.on("updateWorldTime", onWorldTimeFoodDrinkSweep);
    // Announce food spoilage transitions in chat the moment they happen
    // (rather than waiting for the player to open inventory).
    Hooks.on("updateWorldTime", onWorldTimeFreshnessSweep);

    /* Invalidate the next-spoilage cache when any food item is created,
     * deleted, or has its shelf life / freshness anchor changed. Cheap
     * (single ref assignment); next updateWorldTime tick recomputes the
     * threshold. Without this a fresh food purchase or GM shelf-life
     * edit could delay the sweep past its correct spoilage moment. */
    const isTrackableFood = (item) => item?.type === "food";
    Hooks.on("createItem", (item) => { if (isTrackableFood(item)) invalidateSpoilageCache(); });
    Hooks.on("deleteItem", (item) => { if (isTrackableFood(item)) invalidateSpoilageCache(); });
    Hooks.on("updateItem", (item, changes) => {
        if (!isTrackableFood(item)) return;
        if (foundry.utils.hasProperty(changes ?? {}, "system.freshness")) {
            invalidateSpoilageCache();
        }
    });

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
    // Merchant-borne food with decay OFF gets its anchor CLEARED so old
    // stock that pre-dates the freeze rule stops reading as spoiled after
    // this fix lands. GM-only to keep multi-client sessions from racing
    // on the same stamp. */
    Hooks.once("ready", () => {
        if (!game.user?.isActiveGM) return;
        if (!isHomebrewEnabled("foodAndDrink")) return;
        for (const actor of game.actors ?? []) {
            const isMerchant = actor.type === "merchant";
            for (const item of (actor.items ?? [])) {
                if (isMerchant) {
                    if (item.type !== "food") continue;
                    if (item.getFlag(SYSTEM_ID, "merchantFreshnessDecay") === true) continue;
                    const anchor = item.system?.freshness?.anchorTime;
                    if (anchor == null) continue;
                    item.update({ "system.freshness.anchorTime": null })
                        .catch(err => console.warn(`${SYSTEM_ID} | merchant anchor clear failed`, err));
                    continue;
                }
                stampFreshnessAnchor(item);
            }
        }
    });

    /* When food lands on a merchant, clear any inherited anchor so it
     * reads as fresh on the shelf. Also normalise the flag: absence
     * means frozen (default), so no explicit stamp needed. Skips items
     * that arrive with the decay flag already `true` — the GM is
     * opting-in to shelf-life advancement. */
    Hooks.on("createItem", async (item) => {
        if (!isHomebrewEnabled("foodAndDrink")) return;
        if (item?.type !== "food") return;
        if (item?.parent?.type !== "merchant") return;
        if (!game.user?.isActiveGM) return;
        if (item.getFlag(SYSTEM_ID, "merchantFreshnessDecay") === true) return;
        const anchor = item.system?.freshness?.anchorTime;
        if (anchor == null) return;
        try { await item.update({ "system.freshness.anchorTime": null }); }
        catch (err) { console.warn(`${SYSTEM_ID} | merchant anchor clear failed`, err); }
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
        /* Same opt-in gate as adjustSatiety — a GM sheet-edit on a
         * hunger-disabled actor updates the stored satiety value but
         * doesn't spin up tier AEs / hunger stress. */
        if (!isHungerActive(actor)) return;
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
    applyDrunkLevel, handleEnduranceRoll, soberUp,
    // Hangover
    applyHangover,
    // Satiety
    tierForSatiety, tierDisplayName, hourlySatietyLoss, adjustSatiety, reconcileHungerStatus,
    getSatietyCeil, getSatietyGorgedCeil, getSatietyFloor,
    COMBAT_SATIETY_PER_STA,
    // Hooks
    onConsume, onCombatStaminaSpend,
    // Tier ids (for external readers, e.g. inventory panels)
    HUNGER_TIERS, DRUNK_IDS
});
