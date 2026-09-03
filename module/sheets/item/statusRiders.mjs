/**
 * Status-rider list helpers — a spell / hex authors zero or more status
 * effects that fire on a successful cast. Stored on the item as
 * `system.statusRiders` = [{ statusId, chance, duration:{value, unit} }].
 *
 * Editing:
 *   - Rows render via `buildStatusRiderRows`
 *   - Add / remove buttons post to sheet actions (see below)
 *   - Per-row edits (statusId text, chance %, duration value+unit) are
 *     submitted via form field names `system.statusRiders.N.*` — the
 *     ArrayField in the schema round-trips this natively.
 */

/** Resolve the stored status riders to render-ready rows. Enriches each
 *  row with the display name + icon lookup from CONFIG.statusEffects so
 *  the sheet's display view can render a proper icon + label instead of
 *  the raw statusId slug. */
export function buildStatusRiderRows(item) {
    const list = Array.isArray(item.system?.statusRiders) ? item.system.statusRiders : [];
    const cfg = (typeof CONFIG !== "undefined" && Array.isArray(CONFIG.statusEffects)) ? CONFIG.statusEffects : [];
    return list.map((r, index) => {
        const statusId = String(r?.statusId ?? "");
        /* Foundry status entries carry {id, name/label, img/icon}; older
         * builds used name/img, newer ones use label/icon. Read both. */
        const def = cfg.find(s => s.id === statusId);
        const rawLabel = def?.name ?? def?.label ?? statusId;
        const label    = typeof game !== "undefined" ? (game.i18n?.localize?.(rawLabel) ?? rawLabel) : rawLabel;
        const icon     = def?.img ?? def?.icon ?? "icons/svg/aura.svg";
        return {
            index,
            statusId,
            label,
            icon,
            chance:   Math.max(0, Math.min(100, Math.round(Number(r?.chance ?? 100)))),
            duration: {
                value: String(r?.duration?.value ?? ""),
                unit:  String(r?.duration?.unit  ?? "instant")
            },
            /* Zone / STA-scaling extensions (default values match the
             * schema initials so authoring an old rider still round-
             * trips cleanly). */
            mode:        String(r?.mode ?? "onHit"),
            stripOnExit: r?.stripOnExit !== false,
            staScale: {
                offset:  Number(r?.staScale?.offset)  || 0,
                divisor: Math.max(1, Number(r?.staScale?.divisor) || 1),
                cap:     Number(r?.staScale?.cap)     || 0,
                baseSta: Math.max(1, Number(r?.staScale?.baseSta) || 1),
                maxSta:  Math.max(0, Number(r?.staScale?.maxSta)  || 0)
            },
            staScaleTarget: String(r?.staScaleTarget ?? "magnitude"),
            refreshOnRecast: r?.refreshOnRecast === true
        };
    });
}

/** Compute the STA-scaling ladder rungs for a rider. Target-aware so
 *  each staScaleTarget shows the right ladder:
 *   - magnitude / endCheckModifier → raw scaled value with sign
 *   - chance → the FINAL chance % at each stamina step (base + bonus,
 *              clamped 0-100), so the author sees "will land 70%"
 *              instead of "delta +20"
 *  Delegates to the shared buildLadder so the same formula drives the
 *  preview and the runtime cast dispatch. */
import { buildLadder } from "../../mechanics/staScale.mjs";
export function buildStaScaleLadder(scale, rider = null) {
    if (rider?.staScaleTarget === "chance") {
        const base = Math.max(0, Math.min(100, Number(rider?.chance) || 0));
        return buildLadder(scale, {
            combine: (v) => Math.max(0, Math.min(100, base + v)),
            format:  (v) => `${v}%`
        });
    }
    return buildLadder(scale);
}

/** Append a blank status rider to the item. */
export async function addStatusRider(item) {
    const list = foundry.utils.deepClone(item.system?.statusRiders ?? []);
    list.push({
        statusId: "",
        chance:   100,
        duration: { value: "", unit: "instant" },
        /* New extension defaults — mode: onHit is the sensible fallback
         * (a rider on a one-shot damaging cast). Authors editing a
         * persistent-zone spell flip it to "zone" in the sheet. */
        mode:            "onHit",
        stripOnExit:     true,
        staScale:        { offset: 0, divisor: 1, cap: 0, baseSta: 1, maxSta: 0 },
        staScaleTarget:  "magnitude",
        refreshOnRecast: false
    });
    await item.update({ "system.statusRiders": list });
    return true;
}

/** Remove the status rider at `index`. */
export async function removeStatusRider(item, index) {
    const list = foundry.utils.deepClone(item.system?.statusRiders ?? []);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return false;
    list.splice(index, 1);
    await item.update({ "system.statusRiders": list });
    return true;
}
