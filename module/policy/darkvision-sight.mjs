/**
 * Darkvision → Foundry token vision.
 *
 * A character with the Dark Vision race toggle (race item `nightVision === "dark"`,
 * i.e. visionRank ≥ 3) should GENUINELY see in pitch darkness on the canvas — not
 * merely ignore the light penalty. This wires that toggle to a Foundry vision mode
 * on the actor's token (the mode + range are chosen on the race — see
 * DARK_VISION_MODES in mechanics/light-level.mjs), so an unlit scene resolves for
 * them within their sight range.
 *
 * Applied at three points:
 *   • token creation      — folded into the create so it lands in one write
 *   • race night-vision changed / race added or removed — re-sync placed tokens
 *   • canvas load         — reconcile tokens placed before the toggle was set
 *
 * A per-token flag marks the mode as OURS and remembers the mode we replaced, so
 * losing darkvision restores exactly the prior vision mode and never clobbers a
 * GM-chosen one. Re-sync + reconcile are GM-only (single writer; vision is
 * GM-authoritative), while the spawn-time path works for whoever drops the token.
 */

import { hasDarkVision, darkVisionRange, darkVisionMode } from "../mechanics/light-level.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const APPLIED_FLAG = "darkvisionSight";      // set → WE own the current vision mode
const PREV_FLAG    = "darkvisionPrevMode";   // the mode we replaced, for clean restore
const PREV_RANGE   = "darkvisionPrevRange";  // the sight range we replaced, for clean restore

/* The {sight, flags} patch a token needs given its actor's Dark Vision, or null
 * when nothing should change. Idempotent — returns null once the desired state is
 * set, and re-applies when the race/AE vision mode or distance is edited. */
function desiredPatch(tokenDoc) {
    if (!tokenDoc) return null;
    const actor   = tokenDoc.actor;
    const has     = !!actor && hasDarkVision(actor);
    const applied = !!tokenDoc.getFlag?.(SYSTEM_ID, APPLIED_FLAG);
    const sight   = tokenDoc.sight ?? {};

    if (has) {
        // Race/AE chooses the vision mode; the vision distance drives the token's
        // sight range (0 → leave the token's own range alone).
        const mode      = darkVisionMode(actor);
        const range     = darkVisionRange(actor);
        const wantRange = range > 0 ? range : null;
        const rangeOk   = wantRange == null || Number(sight.range) === wantRange;
        if (applied && sight.enabled && sight.visionMode === mode && rangeOk) return null;

        const nextSight = { enabled: true, visionMode: mode };
        if (wantRange != null) nextSight.range = wantRange;
        const patch = {
            sight: nextSight,
            [`flags.${SYSTEM_ID}.${APPLIED_FLAG}`]: true
        };
        if (!applied) {   // remember what we replace ONCE, for exact restore
            patch[`flags.${SYSTEM_ID}.${PREV_FLAG}`]  = sight.visionMode ?? "basic";
            patch[`flags.${SYSTEM_ID}.${PREV_RANGE}`] = Number(sight.range) || 0;
        }
        return patch;
    }

    // No darkvision: undo ONLY what we applied, restoring the prior mode + range.
    if (applied) {
        return {
            sight: {
                visionMode: tokenDoc.getFlag?.(SYSTEM_ID, PREV_FLAG) ?? "basic",
                range:      Number(tokenDoc.getFlag?.(SYSTEM_ID, PREV_RANGE)) || 0
            },
            [`flags.${SYSTEM_ID}.-=${APPLIED_FLAG}`]: null,
            [`flags.${SYSTEM_ID}.-=${PREV_FLAG}`]:    null,
            [`flags.${SYSTEM_ID}.-=${PREV_RANGE}`]:   null
        };
    }
    return null;
}

/* Commit the patch to a PLACED token document (an actual DB write). */
async function commitPatch(tokenDoc) {
    const patch = desiredPatch(tokenDoc);
    if (!patch) return;
    try { await tokenDoc.update(patch); }
    catch (err) { console.warn(`${SYSTEM_ID} | darkvision sight update failed`, err); }
}

/* Re-sync every placed token of an actor (its vision source changed). */
function resyncActorTokens(actor) {
    for (const t of (actor?.getActiveTokens?.() ?? [])) {
        const doc = t?.document ?? t;
        if (doc) commitPatch(doc);
    }
}

/* Walk an embedded document's parent chain up to the owning Actor (an ActiveEffect
 * may sit on the actor directly or on one of its items). */
function ownerActor(doc) {
    let p = doc?.parent;
    while (p) {
        if (p.documentName === "Actor") return p;
        p = p.parent;
    }
    return null;
}

export function registerDarkvisionSight() {
    /* Spawn: fold the vision mode into the create data so it commits in one write —
     * no permission issue (the creator owns the pending document). */
    Hooks.on("preCreateToken", (tokenDoc) => {
        const patch = desiredPatch(tokenDoc);
        if (patch) { try { tokenDoc.updateSource(patch); } catch (_) { /* ignore */ } }
    });

    /* Race night-vision edited, or a race added / removed → re-sync placed tokens.
     * GM-only so exactly one client writes. */
    const onRaceChange = (item) => {
        if (!game.user?.isActiveGM) return;
        if (item?.type === "race" && item.parent) resyncActorTokens(item.parent);
    };
    Hooks.on("updateItem", onRaceChange);
    Hooks.on("createItem", onRaceChange);
    Hooks.on("deleteItem", onRaceChange);

    /* A `vision` Active Effect added / toggled / edited / removed can change the
     * actor's effective vision (an item's transferred effect, or one on the actor)
     * → re-sync its placed tokens. GM-only. */
    const onEffectChange = (effect) => {
        if (!game.user?.isActiveGM) return;
        const actor = ownerActor(effect);
        if (actor) resyncActorTokens(actor);
    };
    Hooks.on("createActiveEffect", onEffectChange);
    Hooks.on("updateActiveEffect", onEffectChange);
    Hooks.on("deleteActiveEffect", onEffectChange);

    /* Canvas load: reconcile tokens placed before the toggle existed / changed. */
    Hooks.on("canvasReady", () => {
        if (!game.user?.isActiveGM) return;
        for (const t of (canvas?.tokens?.placeables ?? [])) {
            if (t?.document) commitPatch(t.document);
        }
    });
}
