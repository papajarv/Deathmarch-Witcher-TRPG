/**
 * Helmet vision restriction → token vision angle (Combat Extended).
 *
 * When an actor wears an equipped helm whose Restricted/Poor Vision is active
 * (see mechanics/helmetVision.mjs — respects the raised-visor negation and the
 * CE `eoArmorModel` gate), clamp the wearer's token ALLOWED vision angle to 90°.
 * Removing the helm (or raising the visor, or disabling CE) restores it.
 *
 * We drive the existing two-parameter vision system rather than writing
 * `sight.angle` directly: setting `flags.<sys>.allowedVisionAngle` makes the
 * `preUpdateToken` hook in policy/stealth-vision-config.mjs recompute
 * `sight.angle = min(trueVisionAngle, allowedVisionAngle)` in the same write.
 * So a human (true 180°) in a restricted helm renders a 90° cone, and a wider
 * biological FOV is still clamped correctly.
 *
 * Ownership: we stamp an APPLIED flag when WE set the angle and stash whatever
 * allowed angle we replaced (PREV) so removal restores the wearer's own manual
 * setting instead of clobbering it. Declarative reconcile (à la
 * policy/darkvision-sight.mjs): compute the desired state and diff.
 *
 * GM-gated: only the active GM writes token docs, so player equip changes don't
 * race across clients.
 */

import { ALLOWED_ANGLE_FLAG } from "../mechanics/stealth-hooks.mjs";
import { actorVisionRestricted, RESTRICTED_VISION_ANGLE, hasVisorQuality, isVisorRaised } from "../mechanics/helmetVision.mjs";
import { t } from "../chrome/lib/i18n.js";

const SYSTEM_ID    = "witcher-ttrpg-death-march";
const APPLIED_FLAG = "helmetVisionApplied";       // set → WE own the current allowed angle
const PREV_FLAG    = "helmetVisionPrevAllowed";   // the allowed angle we replaced (0 = none)
const VISOR_AE_FLAG = "visorDownFor";             // AE marker → the helm item whose lowered visor it represents

/** Compute the flag patch needed to bring one token doc into line with its
 *  actor's helmet-vision state, or null when it's already correct. */
function desiredPatch(tokenDoc) {
    if (!tokenDoc) return null;
    const actor      = tokenDoc.actor;
    const restricted = !!actor && actorVisionRestricted(actor);
    const applied    = !!tokenDoc.getFlag?.(SYSTEM_ID, APPLIED_FLAG);
    const curAllowed = Number(tokenDoc.getFlag?.(SYSTEM_ID, ALLOWED_ANGLE_FLAG)) || 0;

    if (restricted) {
        if (applied && curAllowed === RESTRICTED_VISION_ANGLE) return null;   // already clamped
        const patch = {
            [`flags.${SYSTEM_ID}.${ALLOWED_ANGLE_FLAG}`]: RESTRICTED_VISION_ANGLE,
            [`flags.${SYSTEM_ID}.${APPLIED_FLAG}`]:       true
        };
        // Remember what we replaced ONCE, for an exact restore later.
        if (!applied) patch[`flags.${SYSTEM_ID}.${PREV_FLAG}`] = curAllowed;
        return patch;
    }

    // Not restricted — undo only if WE were the ones who clamped it.
    if (!applied) return null;
    const prev = Number(tokenDoc.getFlag?.(SYSTEM_ID, PREV_FLAG)) || 0;
    /* Write the allowed-angle flag KEY (even to null) so stealth-vision-config's
     * preUpdateToken sees the change and recomputes sight.angle. A `-=` delete
     * would NOT be detected there, leaving the cone stuck at 90. null / 0 →
     * unbounded (min(true, 360) = true). */
    return {
        [`flags.${SYSTEM_ID}.${ALLOWED_ANGLE_FLAG}`]: prev > 0 ? prev : null,
        [`flags.${SYSTEM_ID}.-=${APPLIED_FLAG}`]:     null,
        [`flags.${SYSTEM_ID}.-=${PREV_FLAG}`]:        null
    };
}

async function commitPatch(tokenDoc) {
    const patch = desiredPatch(tokenDoc);
    if (!patch) return;
    try { await tokenDoc.update(patch); }
    catch (err) { console.warn(`${SYSTEM_ID} | helmet vision angle update failed`, err); }
}

/** Re-sync every placed token of an actor (their worn helm changed). */
function resyncActorTokens(actor) {
    for (const t of (actor?.getActiveTokens?.() ?? [])) {
        const doc = t?.document ?? t;
        if (doc) commitPatch(doc);
    }
}

/** Reconcile "Visor Down" status effects on an actor: one per equipped helm
 *  that carries the `visor` quality and has its visor LOWERED, tagged with the
 *  helm's item id and wearing the helm's icon so it reads at a glance on the
 *  token. Raising the visor (or removing the helm) drops the effect. Pure
 *  indicator — no `changes`; the mechanics live elsewhere. */
async function reconcileVisorAEs(actor) {
    if (!actor) return;
    // Desired set: helm id → icon for every equipped, visor-down helm.
    const want = new Map();
    for (const it of (actor.items ?? [])) {
        if (it.type !== "armor" || !it.system?.equipped) continue;
        if (!hasVisorQuality(it) || isVisorRaised(it)) continue;   // no visor, or visor up → no effect
        want.set(it.id, it.img);
    }
    const existing = (actor.effects?.contents ?? actor.effects ?? [])
        .filter(e => e.getFlag?.(SYSTEM_ID, VISOR_AE_FLAG));
    const haveIds = new Set(existing.map(e => e.getFlag(SYSTEM_ID, VISOR_AE_FLAG)));

    const toCreate = [];
    for (const [itemId, img] of want) {
        if (haveIds.has(itemId)) continue;
        toCreate.push({
            name: t("WITCHER.Effect.VisorDown", "Visor Down"),
            img:  img || "icons/svg/mystery-man.svg",
            transfer: false,
            flags: { [SYSTEM_ID]: { [VISOR_AE_FLAG]: itemId } }
        });
    }
    const toDelete = existing
        .filter(e => !want.has(e.getFlag(SYSTEM_ID, VISOR_AE_FLAG)))
        .map(e => e.id);

    try {
        if (toDelete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete);
        if (toCreate.length) await actor.createEmbeddedDocuments("ActiveEffect", toCreate);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | visor-down effect reconcile failed`, err);
    }
}

/** Both actor-scoped reconciles (token vision angle + Visor Down effect). */
function resyncActor(actor) {
    resyncActorTokens(actor);
    reconcileVisorAEs(actor);
}

export function registerHelmetVisionRestriction() {
    /* Equip / unequip, quality edits, and visor toggles all land as an armor
     * item create/update/delete on the wearer — reconcile the wearer's tokens.
     * GM-only write to avoid multi-client races. */
    const onItemChange = (item) => {
        if (!game.user?.isActiveGM) return;
        if (item?.type === "armor" && item.parent) resyncActor(item.parent);
    };
    Hooks.on("updateItem", onItemChange);
    Hooks.on("createItem", onItemChange);
    Hooks.on("deleteItem", onItemChange);

    /* Scene load: reconcile every placed token so a helm equipped before the
     * scene was active (or a stale flag) resolves to the right cone, and sweep
     * their actors' Visor Down effects. */
    Hooks.on("canvasReady", () => {
        if (!game.user?.isActiveGM) return;
        const seen = new Set();
        for (const tok of (canvas?.tokens?.placeables ?? [])) {
            if (tok?.document) commitPatch(tok.document);
            const actor = tok?.actor;
            if (actor && !seen.has(actor.id)) { seen.add(actor.id); reconcileVisorAEs(actor); }
        }
    });
}
