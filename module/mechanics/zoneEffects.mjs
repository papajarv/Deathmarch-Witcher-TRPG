/**
 * zoneEffects — persistent MeasuredTemplate zones that apply /
 * strip ActiveEffects as tokens cross their boundaries.
 *
 * Powers the PERSISTENT_ZONE_STATUS pattern (Yrden, Static Storm,
 * Consecrate, Blaze of the Korath, Freshen Air, Dormyn's Fog,
 * Stammelford's Earthquake, and any spell where `areaPersist:true`
 * and the schema has zone-mode riders).
 *
 * ── Architecture ──────────────────────────────────────────────────
 *
 * When a persistent-zone cast commits, `createZoneTemplate` writes
 * a native RegionDocument to `canvas.scene` (Stage 2b — persistent
 * zones were MeasuredTemplates until v14 merged that document into
 * Region; the deprecation shim broke the zone lifecycle, so we create
 * Regions directly). The region carries a `zoneEffect` flag payload —
 * including a `geometry` sub-object holding the original MeasuredTemplate
 * `{t,x,y,distance,direction,angle,width}` that drives `testPointOnTemplate`
 * containment (a Region has no such fields of its own):
 *   {
 *     itemUuid, casterUuid, castMessageUuid,
 *     roundsRemaining, roundsMax,
 *     excludeCaster, tangible,
 *     riders: [{ statusId, chance, duration, mode, stripOnExit,
 *                staScale, resolvedMagnitude }],
 *     damage: { formula, element, type, per, hitChance },
 *     handler                                       // for zone hooks
 *   }
 *
 * A cross-client GM-proxy socket (`zoneTemplateCreate`) is used so
 * non-GM players can request template creation on non-owned scenes
 * without the "requires TRUSTED role" gate.
 *
 * Every `updateToken` fires an entry/exit diff:
 *   for each zone template on the scene:
 *     const wasInside = template.object.testPoint(oldCenter)
 *     const nowInside = template.object.testPoint(newCenter)
 *     if (!wasInside && nowInside) onEnter(token, template)
 *     if (wasInside && !nowInside) onExit(token, template)
 * onEnter creates an AE on the token with:
 *     statuses: [rider.statusId]
 *     changes:  computed from clause mods scaled by resolvedMagnitude
 *     flags.SYSTEM_ID.zoneTemplate = template.uuid
 *     origin:   casterUuid
 * onExit deletes every AE on the token whose flag matches the
 * template uuid.
 *
 * `combatRound` decrements `roundsRemaining` on every zone region
 * in every scene (respecting `direction: -1` for rewinds). When it
 * hits 0, the region is deleted; the `deleteRegion` hook then walks
 * every token in the scene and strips its zone AEs so nothing is left
 * dangling.
 *
 * GM-only writes: only `game.users.activeGM` runs the mutation
 * paths. Every other client still sees the results because the
 * MeasuredTemplate / ActiveEffect writes broadcast.
 *
 * ── Rider scaling ─────────────────────────────────────────────────
 *
 * A rider's `staScale = { offset, divisor, cap }` encodes STA-scaled
 * penalties like errata Yrden. At create time:
 *   magnitude = offset + Math.floor((staSpent - 1) / divisor)
 * Then clamped by `cap` (respecting sign):
 *   cap &lt; 0 → magnitude = Math.max(magnitude, cap)
 *   cap &gt; 0 → magnitude = Math.min(magnitude, cap)
 *   cap === 0 → no clamp
 * The resolved magnitude is stamped into the template flags so
 * later entries use the same value even if the caster's Vigor
 * shifts. It's applied to any status clause `mods.stats[key]` /
 * `mods.roll[key]` entry that carries `zoneScaleKey: true` (defined
 * on the clause). See setup/statusClauses.mjs "yrden" for the
 * canonical example.
 */

import { getSpellHandler } from "./spellHandlers.mjs";
import { clauseFor } from "./statusEngine.mjs";
import { resolveScaleAt as _resolveScaleAt, scaleHasValue as _scaleHasValue } from "./staScale.mjs";
import { buildTemplateRegionData } from "./castArea.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
import { buildActiveShield } from "../setup/socketHook.mjs";
const SYSTEM_ID = "witcher-ttrpg-death-march";
const SOCKET_CHANNEL = `system.${SYSTEM_ID}`;

/* Foundry ActiveEffect change mode. 2 = ADD (numeric sum). Used for
 * every zone-produced change so overlapping zones stack cleanly. */
const AE_MODE_ADD = 2;

/* Witcher area shape → Foundry MeasuredTemplate.t. Duplicated from
 * castArea.mjs deliberately: castArea's map is scoped to the
 * placement UI; zoneEffects needs the same mapping when creating a
 * scene-persisted document from the placement snapshot. */
const SHAPE_TO_FOUNDRY = Object.freeze({
    cone: "cone", radius: "circle", cube: "rect", line: "ray"
});

/* ── Public API ──────────────────────────────────────────────────── */

/**
 * Create a persistent zone template from a completed cast.
 *
 * Called by castSpellMixin AFTER the cast roll resolves and BEFORE
 * defense/damage flow (persistent zones don't do a one-shot defense
 * fan-out — they apply as tokens enter). Uses the snapshot returned
 * by the persist-mode branch of `pickAreaTargets`.
 *
 * @param {object} args
 * @param {Actor}   args.actor          the caster
 * @param {Item}    args.item           the spell / hex being cast
 * @param {object}  args.castContext    the envelope built by castSpellMixin
 * @param {object}  args.placement      { x, y, direction, shape, size }
 * @param {number}  args.staSpent       spell's own STA (feeds staScale)
 * @param {ChatMessage} args.message    the cast card, for backlink flags
 * @returns {Promise&lt;RegionDocument|null&gt;}
 */
/**
 * `zoneBody` — the authored block tree this zone runs on whoever is inside.
 *
 * It is passed IN rather than registered by the caller afterwards, because the
 * "who is already standing here" sweep runs before this function returns. The
 * block engine registered its body on the next line after the call, which is
 * one line too late: `ZONE_BODIES` was empty for the sweep, so a whirlpool
 * dropped on two people did nothing to either of them while the cast card
 * announced it had. A zone that only affects people who WALK IN is not the
 * rule any of these spells are written to.
 */
export async function createZoneTemplate({ actor, item, castContext, placement, staSpent, message, zoneBody = null }) {
    if (!canvas?.scene || !placement) return null;

    const foundryType = SHAPE_TO_FOUNDRY[placement.shape];
    if (!foundryType) return null;

    /* Filter to zone-mode riders and resolve their staScale into
     * concrete magnitudes stamped on the template. A rider without
     * staScale (or with all-zeros) resolves to null, which the
     * apply-AE path interprets as "use the clause's fixed magnitude". */
    const zoneRiders = (Array.isArray(item.system?.statusRiders) ? item.system.statusRiders : [])
        .filter(r => (r?.mode ?? "onHit") === "zone" || (r?.mode ?? "") === "onTick")
        .map(r => {
            const statusId = String(r.statusId ?? "");
            /* Scale resolution order: rider's own `staScale` wins when
             * authored; otherwise fall back to the clause-level
             * `staScale` (see statusClauses.mjs — Yrden carries the
             * RAW errata formula there so a rider left unconfigured
             * still scales). Only if BOTH are unset do we return null
             * and the entrant AE picks up the clause's static magnitude
             * via `buildAEChangesFromClause`. */
            const clauseScale = clauseFor(statusId)?.staScale ?? null;
            const scale = _scaleHasValue(r?.staScale) ? r.staScale : clauseScale;
            return {
                statusId,
                chance:            Number(r.chance ?? 100) || 0,
                duration:          {
                    value: String(r?.duration?.value ?? ""),
                    unit:  String(r?.duration?.unit  ?? "instant")
                },
                mode:              String(r.mode ?? "zone"),
                stripOnExit:       r.stripOnExit !== false,
                resolvedMagnitude: resolveStaScale(scale, staSpent)
            };
        })
        .filter(r => r.statusId);

    const roundsRemaining = computeRoundsRemaining(item);
    /* Absolute expiry worldTime — combatRound owns the tick inside
     * a fight; this stamp is the fallback so a zone cast out of combat
     * still self-cleans when worldTime elapses past the duration.
     * RAW ticking: 1 round = `CONFIG.time.roundTime` seconds, so a
     * 5-round Yrden with roundTime=3 expires after 15 worldTime
     * seconds — visible on the marker AE's countdown chip, matched
     * by the template's wall-clock expiry. */
    const expiresAt = computeAbsoluteExpiry(item);
    /* Wall-clock fallback expiry. `expiresAt` above is in `worldTime`
     * units and only fires cleanup when `game.time.worldTime` advances
     * past it. When the wall clock is paused (my time-flow gate:
     * no players online, out of combat), worldTime doesn't advance
     * and the template can linger forever even after the "real" duration
     * has elapsed. Also stamp a REAL-TIME expiry so a periodic
     * setInterval sweep can clean the template up independently of
     * worldTime — the user sees the zone expire on schedule even during
     * solo GM testing. Value is `Date.now()` at creation + duration in
     * ms; 0 (or missing) means "no wall-clock expiry — combatRound
     * ticks own this template". */
    const wallExpiresAt = (() => {
        const nowWorld = Number(game.time?.worldTime) || 0;
        const worldDelta = Number(expiresAt) - nowWorld;
        if (!Number.isFinite(worldDelta) || worldDelta <= 0) return 0;
        return Date.now() + (worldDelta * 1000);
    })();
    /* Capture the item's embedded AEs when `castsAuthoredAE: true`.
     * Serialized once here — `onZoneEnter` clones from this payload for
     * every entering token, so effect state stays consistent even if
     * the item is edited or unlinked mid-scene. This is the generic
     * bridge that makes an authored-AE spell (any spell — Yrden, Static
     * Storm, Blaze of Korath) behave as a zone effect: applied on
     * enter, stripped on exit / template delete / duration expiry. */
    const authoredEffects = (item.system?.castsAuthoredAE && Array.isArray(item.effects?.contents))
        ? item.effects.contents.map(e => e.toObject())
        : [];
    if (game.user?.isGM) {
        console.log(`${SYSTEM_ID} | wdm zone create`, {
            itemName:           item.name,
            castsAuthoredAE:    !!item.system?.castsAuthoredAE,
            itemEffectsCount:   Array.isArray(item.effects?.contents) ? item.effects.contents.length : "not-array",
            authoredCount:      authoredEffects.length,
            firstAuthoredName:  authoredEffects[0]?.name,
            firstAuthoredChanges: authoredEffects[0]?.changes,
            zoneRidersCount:    zoneRiders.length
        });
    }
    /* AE duration derived from the item's `system.duration`. Every
     * entrant AE gets this stamped on so the on-sheet countdown chip
     * shows a real number. For rounds-based zones the ACTUAL expiry
     * clock is the template's `roundsRemaining` flag — WitcherActiveEffect's
     * `_prepareDuration` override reads that flag on zone-linked AEs
     * and returns a synthetic remaining that never expires via
     * worldTime. The `{seconds}` value here is a fallback / display
     * seed only; the override drives the actual number the user sees
     * and prevents time-flow from eating the AE while out of combat. */
    const aeDuration = _itemDurationToAEDuration(item.system?.duration);
    const flagPayload = {
        itemUuid:        item.uuid,
        itemName:        item.name,
        itemImg:         item.img,
        casterUuid:      actor.uuid,
        castMessageUuid: message?.uuid ?? null,
        excludeCaster:   item.system?.areaExcludeCaster !== false,
        tangible:        item.system?.tangible !== false,
        roundsRemaining,
        roundsMax:       roundsRemaining,
        expiresAt,
        wallExpiresAt,
        aeDuration,
        riders:          zoneRiders,
        authoredEffects,
        damage:          {
            formula:   String(item.system?.damageFormula ?? ""),
            element:   String(item.system?.damageElement ?? "none"),
            type:      String(item.system?.damageType    ?? "none"),
            per:       String(item.system?.damagePer     ?? "cast"),
            hitChance: Number(item.system?.hitChance ?? 100) || 0
        },
        handler:         String(item.system?.mechanicHandler ?? ""),
        staSpent:        Number(staSpent) || 0
    };

    /* Stamp the caster's elevation onto the template so the enter/exit
     * diff can filter tokens on other floors — otherwise a Yrden on the
     * ground floor would catch anyone directly above on a balcony whose
     * 2D footprint overlaps the shape. */
    const casterElevation = Number(placement.elevation ?? actor.token?.elevation ?? actor.getActiveTokens?.()?.[0]?.document?.elevation ?? 0);
    /* MeasuredTemplate-shaped geometry, captured once. This is BOTH the
     * input to the native-Region shape builder (visual) AND the source
     * of truth for `testPointOnTemplate` containment (stored on the
     * zoneEffect flag as `geometry`) — a RegionDocument has no
     * `t/x/y/distance/direction/angle/width` fields of its own, so the
     * containment math reads them from the flag instead. */
    const geom = {
        t:         foundryType,
        x:         Number(placement.x) || 0,
        y:         Number(placement.y) || 0,
        distance:  Number(placement.size) || 0,
        direction: Number(placement.direction) || 0,
        angle:     foundryType === "cone" ? 90 : 0,
        width:     foundryType === "ray"  ? 1  : 0
    };
    const elev = Number.isFinite(casterElevation) ? casterElevation : 0;
    /* Stage 2b — persistent zones are now NATIVE RegionDocuments, not
     * MeasuredTemplates. The MeasuredTemplate document was merged into
     * Region in v14; going through `createEmbeddedDocuments("MeasuredTemplate")`
     * routed through a deprecation shim whose lazy placeable + synthetic
     * document broke the zone lifecycle (AE strip on exit failed with
     * "does not exist", region delete crashed in RegionMesh.destroy). We
     * build the Region directly. `templateData` is kept only as the input
     * shape for the region-geometry builder (Foundry's own MeasuredTemplate
     * → Region migrator), so the visual is byte-identical to what the shim
     * produced. */
    const templateData = {
        t:           foundryType,
        user:        actor.isOwner ? game.user?.id : (game.users?.activeGM?.id ?? game.user?.id),
        x:           geom.x,
        y:           geom.y,
        elevation:   elev,
        distance:    geom.distance,
        direction:   geom.direction,
        angle:       geom.angle,
        width:       geom.width,
        borderColor: "#c8a878",
        fillColor:   "#c8a878",
        itemName:    item.name,
        flags: { [SYSTEM_ID]: { zoneEffect: { ...flagPayload, zoneElevation: casterElevation, geometry: geom } } }
    };
    const regionData = buildTemplateRegionData(templateData, { elevation: elev });
    if (!regionData) return null;

    /* GM proxy: players can't create scene regions without the
     * TRUSTED role. Route through the socket so a GM writes it on
     * their behalf. When we ARE the GM, write directly. */
    if (game.user?.isGM || game.user === game.users?.activeGM) {
        const [doc] = await canvas.scene.createEmbeddedDocuments("Region", [regionData]);
        if (game.user?.isGM) {
            console.log(`${SYSTEM_ID} | wdm zone region created`, {
                regionUuid:   doc?.uuid,
                itemName:     item.name,
                expiresAt,
                wallExpiresAt,
                roundsRemaining,
                worldTime:    game.time?.worldTime,
                createdAt:    Date.now()
            });
        }
        /* The authored body FIRST, then the first-frame entry check for tokens
         * already standing inside the freshly-placed zone. Without the check, a
         * Yrden dropped ON an enemy wouldn't apply the status until they moved;
         * without the ordering, the check runs against a body that has not been
         * registered yet and the same enemy is missed anyway. */
        if (doc && zoneBody) registerZoneBody(doc.uuid, zoneBody);
        if (doc) await applyEntryToAllTokensInside(doc);
        return doc ?? null;
    }
    return await requestZoneCreate(regionData);
}

/* ── Hook handlers ───────────────────────────────────────────────── */

/** Register every zone-related hook. Idempotent; safe to call more
 *  than once (removes prior handlers before re-adding).
 *
 *  Called from hooks.mjs at setup time. */
export function installZoneHooks() {
    /* Cleanup any prior installation — hot reload during dev safely
     *  re-registers rather than stacking N handlers per hook. */
    for (const h of _installedHookHandlers) Hooks.off(h.name, h.id);
    _installedHookHandlers.length = 0;

    const push = (name, fn) => {
        const id = Hooks.on(name, fn);
        _installedHookHandlers.push({ name, id });
    };

    /* Zone-template collection cache invalidation (see collectZoneTemplates).
     * Registered BEFORE the lifecycle handlers below so that on a shared event
     * (deleteMeasuredTemplate / deleteRegion) the cache is dropped before any
     * same-event handler reads it. Deliberately NOT hooked on the per-move
     * events (preUpdateToken / updateToken / moveToken) — the cache is meant to
     * survive across a move, which is exactly what removes the per-move cost. */
    const _ztInvalidate = () => invalidateZoneTemplateCache();
    for (const h of ["createMeasuredTemplate", "updateMeasuredTemplate", "deleteMeasuredTemplate",
                     "createRegion", "updateRegion", "deleteRegion",
                     "updateScene", "deleteScene", "canvasReady"]) {
        push(h, _ztInvalidate);
    }

    push("preUpdateToken",          onPreUpdateToken);
    push("updateToken",             onUpdateToken);
    /* Foundry v14 fires `moveToken` on ALL clients after any
     * animated token movement (drag, ruler-drive, waypoint path)
     * with a `movement` object that carries `origin` + `destination`.
     * `preUpdateToken` only fires on the initiator's client, so
     * a player-driven move leaves the GM's local pre-position stash
     * empty and `onUpdateToken` sees `oldCenter === newCenter` —
     * no diff, `onZoneExit` never fires. `moveToken` sidesteps
     * that entirely by handing the GM the movement origin
     * directly. Kept `updateToken` in place for non-movement
     * writes (macro `.update({x, y})`, region teleports, etc.). */
    push("moveToken",               onMoveToken);
    push("combatRound",             onCombatRound);
    push("updateWorldTime",         onUpdateWorldTime);
    push("deleteMeasuredTemplate",  onDeleteMeasuredTemplate);
    /* v14 stores MeasuredTemplates as Regions under the hood (the
     * MeasuredTemplate document was merged into Region). `scene.templates`
     * is a synthetic view over regions carrying `flags.core.MeasuredTemplate:
     * true`; the actual delete pipeline routes through `deleteDocuments`
     * on the RegionDocument. If Foundry (or a third-party) deletes the
     * underlying region directly, `deleteMeasuredTemplate` may not fire —
     * but `deleteRegion` will. This backup logger + strip pipeline
     * catches that path so a rounds-based Yrden zone can't be quietly
     * yanked out from under us without leaving orphan entrant AEs. */
    push("deleteRegion",            onDeleteRegion);
    /* Elevation-based occlusion for zone-region visuals.
     *
     * `canvas.regions` (for the placeable's `#border`) and the layer's
     * `_highlights` container (for the tinted `RegionMesh` fill) both
     * render at fixed z-index above the primary group, so a roof at
     * higher elevation never covers them — the outline and fill of a
     * Yrden cast on floor 1 stay visible from floor 2 whether or not
     * there's a solid roof in between. Same class of bug as the token
     * decoration bleed-through in [[foundry-v14-decoration-occlusion]].
     *
     * Fix: on every region refresh, reparent both the highlight mesh
     * AND the placeable's border Graphics into a per-region carrier
     * that lives in `canvas.primary` at `document.elevation`, so the
     * primary group's `elevation → sortLayer → sort` compare sorts a
     * roof at higher elevation OVER the region visuals. When the viewer
     * has line-of-sight (no higher-elevation surface in between), the
     * region is still visible. */
    push("refreshRegion",           onRefreshRegionOcclusion);
    push("destroyRegion",           onDestroyRegionOcclusion);
    /* Marker AE → template linkage. `_applyCastDuration` in
     * castSpellMixin.mjs stamps the caster's "Concentrating on
     * Yrden" marker AE with `castMarker: true` +
     * `zoneTemplate: <uuid>`. When THAT AE goes away for any
     * reason — Foundry auto-expiry via `duration`, tick-effects
     * cleanup at turn boundary, user right-clicking it off — we
     * want the template to die with it (which then strips every
     * entrant AE via `stripZoneAEsForTemplate`). Without this back
     * edge, the marker would tick down to zero on the caster's
     * sheet while the template kept running its own
     * `roundsRemaining` clock, and the two clocks would visibly
     * disagree. Only the primary GM runs the delete so we don't
     * race N clients trying to delete the same template. */
    push("deleteActiveEffect",      onDeleteActiveEffect);

    /* GM-side socket handler — non-GM callers route zone creation
     * requests through here so a template gets written on their
     * behalf. */
    game.socket?.on(SOCKET_CHANNEL, onSocketMessage);

    /* Real-time wall-clock sweeper — independent of `game.time.worldTime`
     * (which the time-flow module can pause when no players are online)
     * so zone templates cast during solo GM testing still expire on
     * their own. Every 5 real seconds: walk every scene's zone templates,
     * check `wallExpiresAt` against `Date.now()`, delete anything past
     * due. Cheap (a handful of templates per scene at most). Only the
     * primary GM runs it, matching every other mutation path. Skipped
     * while the game is paused so a paused session doesn't spend
     * duration-time either. */
    _installWallClockSweeper();
}

let _wallClockTimer = null;
function _installWallClockSweeper() {
    if (_wallClockTimer) return;
    _wallClockTimer = setInterval(async () => {
        try {
            if (game.paused) return;
            if (game.user !== game.users?.activeGM) return;
            /* Skip during active combat — `combatRound` owns expiry
             * while a fight is in progress. Real-time flows much
             * faster than combat rounds (a 3-round Yrden takes minutes
             * of table time to tick down, but the wall clock would
             * delete it in 9 seconds because roundTime=3s). Letting
             * the sweeper run in combat would consistently blow up the
             * template well before the correct round-count expiry. */
            if (game.combat?.started) return;
            const now = Date.now();
            for (const scene of game.scenes ?? []) {
                const templates = collectZoneTemplates(scene);
                for (const template of templates) {
                    const flags = template.getFlag(SYSTEM_ID, "zoneEffect");
                    if (!flags) continue;
                    const wallAt = Number(flags.wallExpiresAt);
                    if (!Number.isFinite(wallAt) || wallAt <= 0) continue;
                    if (now < wallAt) continue;
                    if (game.user?.isGM) console.log(`${SYSTEM_ID} | wdm delete src=wall-clock`, template.uuid);
                    await deleteZoneRegion(template);
                }
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | zone wall-clock sweeper failed`, err);
        }
    }, 5000);
}

const _installedHookHandlers = [];

/* Per-token map of the PRE-update coordinates. Populated by preUpdateToken
 * and consumed by updateToken so we can diff old vs. new position. Without
 * this, `updateToken` sees `tokenDoc.x/y` already at the new values and
 * every diff resolves to zero — onZoneExit would never fire. Keyed by
 * `${sceneId}:${tokenId}` so a token moving between scenes stays sane. */
const _tokenPreUpdate = new Map();

function _preKey(tokenDoc) {
    return `${tokenDoc?.parent?.id ?? ""}:${tokenDoc?.id ?? ""}`;
}

function onPreUpdateToken(tokenDoc, changed, options, userId) {
    if (game.user !== game.users?.activeGM) return;
    if (changed?.x === undefined && changed?.y === undefined) return;
    _tokenPreUpdate.set(_preKey(tokenDoc), { x: tokenDoc.x, y: tokenDoc.y });
}

/**
 * updateToken diff: is the new token center INSIDE any persistent
 * zone template that its old center was OUTSIDE (or vice-versa)?
 * GM-only mutation; every client receives the resulting AE writes
 * as broadcasts.
 */
async function onUpdateToken(tokenDoc, changed, options, userId) {
    if (game.user !== game.users?.activeGM) return;
    if (!tokenDoc?.parent) return;
    /* Fast-out when the update doesn't move the token. Other update
     * paths (hp changes, name edits) still fire this hook. */
    if (changed?.x === undefined && changed?.y === undefined) return;
    _tokenPreUpdate.delete(_preKey(tokenDoc));
    /* Prefer the DESTINATION from `changed` — Foundry v14's update
     * hook order can leave `tokenDoc.x/y` briefly at the origin
     * during animated moves, so a reconcile that reads from the
     * document sees the OLD position and the enter/exit event fires
     * ONE MOVE LATE (user: "step in, nothing happens; step again,
     * effect applies"). Reading `changed.x/y` gives the authoritative
     * new position at the moment the hook fires. */
    const nx = changed?.x !== undefined ? Number(changed.x) : Number(tokenDoc.x);
    const ny = changed?.y !== undefined ? Number(changed.y) : Number(tokenDoc.y);
    await reconcileTokenZoneAEs(tokenDoc, nx, ny);
}

/**
 * moveToken: fires on every client (including the GM) whenever any
 * animated movement pipeline commits — drag-drop, ruler-drive,
 * waypoint plan. Instead of comparing `origin` vs `destination` (which
 * depended on the movement object carrying both, and could miss any
 * update path that skipped the movement pipeline), we RECONCILE: look
 * at the token's CURRENT position + its CURRENT zone-AE inventory,
 * and for every zone template on the scene:
 *   - if the token is inside but has no AE from that template → apply
 *   - if the token is outside but has an AE from that template → strip
 * Robust against any movement path (drag, region teleport, macro
 * update) as long as the hook fires. GM-only mutation. */
async function onMoveToken(tokenDoc, movement /* , operation, user */) {
    if (game.user !== game.users?.activeGM) return;
    if (!tokenDoc?.parent) return;
    /* Prefer `movement.destination.x/y` over `tokenDoc.x/y`. In
     * Foundry v14 the moveToken hook can fire while the document
     * position is still at the animation origin — reading the doc
     * gets the OLD position and the reconcile misses the boundary
     * event. The movement object always carries the authoritative
     * arrival point. Fall back to `tokenDoc.x/y` for the rare case
     * where movement isn't populated (region teleport shim, macro
     * `.update({x,y})` proxied through). */
    const nx = movement?.destination?.x !== undefined
        ? Number(movement.destination.x)
        : Number(tokenDoc.x);
    const ny = movement?.destination?.y !== undefined
        ? Number(movement.destination.y)
        : Number(tokenDoc.y);
    await reconcileTokenZoneAEs(tokenDoc, nx, ny);
}

async function reconcileTokenZoneAEs(tokenDoc, atX, atY) {
    const scene = tokenDoc.parent;
    if (!scene) return;
    const templates = collectZoneTemplates(scene);
    if (!templates.length) return;
    const actor = tokenDoc.actor;
    if (!actor) return;

    const tokenElev = Number(tokenDoc.elevation ?? 0);
    /* Explicit coords passed by the caller (moveToken / updateToken)
     * override the document's current x/y — the doc can lag the real
     * destination during animated moves. */
    const useX = Number.isFinite(atX) ? Number(atX) : Number(tokenDoc.x);
    const useY = Number.isFinite(atY) ? Number(atY) : Number(tokenDoc.y);

    for (const template of templates) {
        const zoneFlags = template.getFlag(SYSTEM_ID, "zoneEffect");
        if (!zoneFlags) continue;
        const zoneElev = Number(zoneFlags.zoneElevation ?? template.elevation?.bottom ?? 0);
        const elevMatches = !Number.isFinite(zoneElev) || !Number.isFinite(tokenElev) || tokenElev === zoneElev;
        const nowInside = elevMatches && tokenIntersectsTemplate(template, tokenDoc, useX, useY);
        const templateUuid = template.uuid;

        /* Check for a zone-mode AE from this template on this actor.
         * onTick AEs aren't part of the enter/exit reconcile — they
         * fire once per round via applyTickToAllTokensInside and stay
         * put until the template deletes. */
        const zoneAE = actor.effects.find(e => {
            if (e.getFlag(SYSTEM_ID, "zoneTemplate") !== templateUuid) return false;
            return e.getFlag(SYSTEM_ID, "zoneRiderMode") === "zone";
        });
        const hasZoneAE = !!zoneAE;

        /* Diagnostic — GM-only. Grep the console for "wdm zone reconcile"
         * while walking a token in/out of the template to confirm the
         * hook fires, the actor is what we expect, and the strip is
         * being triggered. */
        if (game.user?.isGM) {
            console.log(`${SYSTEM_ID} | wdm zone reconcile`, {
                actor:        actor?.name,
                templateUuid,
                nowInside,
                hasZoneAE,
                zoneAEFlags:  zoneAE?.flags?.[SYSTEM_ID]
            });
        }

        const token = template.parent?.tokens?.get?.(tokenDoc.id)?.object ?? tokenDoc.object ?? tokenDoc;
        if (nowInside && !hasZoneAE) {
            await onZoneEnter(token, template, zoneFlags);
        } else if (!nowInside && hasZoneAE) {
            await onZoneExit(token, template, zoneFlags);
        }
    }
}

/**
 * combatRound: decrement roundsRemaining on every zone template on
 * every scene, respecting rewinds. Delete templates whose counter
 * hits 0. GM-only.
 */
async function onCombatRound(combat, updateData, updateOptions) {
    if (game.user !== game.users?.activeGM) return;
    const direction = Number(updateOptions?.direction) || 1;
    /* Walk EVERY scene, not just the active one — a zone in a
     * different scene should still tick. */
    for (const scene of game.scenes ?? []) {
        const templates = collectZoneTemplates(scene);
        for (const template of templates) {
            const flags = template.getFlag(SYSTEM_ID, "zoneEffect");
            if (!flags) continue;
            const next = Math.max(0, Number(flags.roundsRemaining) || 0) - direction;
            if (next <= 0) {
                if (game.user?.isGM) console.log(`${SYSTEM_ID} | wdm delete src=combatRound`, template.uuid);
                /* Race-safe delete (strips entrant AEs, then deletes the
                 * region once, guarding against a concurrent expiry path). */
                await deleteZoneRegion(template);
            } else {
                await template.setFlag(SYSTEM_ID, "zoneEffect", { ...flags, roundsRemaining: next });
                /* On-tick riders fire fresh for every token still
                 * inside — Blaze of Korath's per-round STA drain. */
                if (Array.isArray(flags.riders)) {
                    const hasTick = flags.riders.some(r => r.mode === "onTick");
                    if (hasTick) await applyTickToAllTokensInside(template);
                }
            }
        }
    }
}

/**
 * When a zone template is deleted (by round-tick expiry OR by
 * manual GM removal from the canvas), strip every AE across every
 * token that references the template's uuid.
 */
/**
 * When the caster's marker AE (the "Concentrating on Yrden"-style
 * AE created by castSpellMixin's `_applyCastDuration`) gets deleted
 * for any reason — Foundry auto-expiry, tick-effects cleanup at a
 * turn boundary, manual removal from the sheet — delete the linked
 * zone template. `stripZoneAEsForTemplate` (called from
 * `onDeleteMeasuredTemplate`) then strips every entrant AE, so
 * everyone standing inside loses the trap effect at the same instant
 * the caster's concentration drops.
 *
 * We only touch AEs whose flags carry BOTH `castMarker: true` AND a
 * `zoneTemplate` UUID — entrant AEs also have `zoneTemplate` (that's
 * the strip-on-delete pipeline) but lack `castMarker`, so deleting an
 * entrant's AE won't cascade into a template delete.
 */
async function onDeleteActiveEffect(effect) {
    if (game.user !== game.users?.activeGM) return;
    const wdmFlags = effect?.flags?.[SYSTEM_ID];
    if (!wdmFlags?.castMarker) return;
    const templateUuid = wdmFlags.zoneTemplate;
    if (!templateUuid) return;
    /* Diagnostic — grep "wdm marker→template" while testing to see WHY
     * the marker died: Foundry duration expiry, manual removal, or the
     * strip pipeline reacting to a template that already deleted. If
     * this fires within a second or two of cast, something upstream is
     * killing the marker before its duration should have run out. */
    if (game.user?.isGM) {
        console.log(`${SYSTEM_ID} | wdm marker→template cascade`, {
            effectName: effect?.name,
            actorName:  effect?.parent?.name,
            templateUuid,
            durationRemaining: effect?.duration?.remaining,
            durationSeconds:   effect?.duration?.seconds,
            worldTime:  game.time?.worldTime
        });
    }
    try {
        const template = await fromUuid(templateUuid);
        if (!template) return;
        if (game.user?.isGM) console.log(`${SYSTEM_ID} | wdm delete src=marker-cascade`, template.uuid);
        /* Race-safe delete — the marker often expires at the same instant
         * the wall-clock sweeper / worldTime expiry fires for the same
         * region; deleteZoneRegion strips + deletes exactly once. */
        await deleteZoneRegion(template);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | marker→template cascade delete failed`, err);
    }
}

const _REGION_OCCLUSION_MARK = "_wdmRegionOcclusionCarrier";

/** Create-or-get the primary-group carrier for a region. Mirrors the
 *  token / template carrier patterns in [[foundry-v14-decoration-occlusion]]:
 *  a plain container under `canvas.primary` with `elevation` tracked to
 *  the region's document, so `PrimaryCanvasGroup._compareObjects` sorts
 *  higher-elevation surfaces (roofs, upper-floor tiles) over the region
 *  visuals — same pass that occludes a token portrait. */
function _getOrCreateRegionOcclusionCarrier(regionObj) {
    if (!regionObj || regionObj.destroyed) return null;
    const existing = regionObj[_REGION_OCCLUSION_MARK];
    if (existing && !existing.destroyed) return existing;
    if (!canvas?.primary) return null;
    const c = new PIXI.Container();
    c.name = `WDMRegionOcclusionCarrier:${regionObj.document?.id ?? "?"}`;
    c[_REGION_OCCLUSION_MARK] = true;
    const elev = Number(regionObj.document?.elevation?.bottom ?? regionObj.document?.elevation) || 0;
    c.elevation = elev;
    c.sortLayer = 0;
    c.sort      = 0;
    c.zIndex    = 0;
    c.eventMode = "none";
    canvas.primary.addChild(c);
    regionObj[_REGION_OCCLUSION_MARK] = c;
    return c;
}

function _syncRegionOcclusionCarrier(regionObj) {
    const c = regionObj?.[_REGION_OCCLUSION_MARK];
    if (!c || c.destroyed) return;
    /* Region shapes are drawn in scene coordinates directly (RegionMesh
     * bakes the polygon into a geometry buffer against absolute scene
     * xy; #border strokes `polygonTree.drawShape` at absolute scene xy
     * too — see Region#_refreshBorder). Carrier stays at (0, 0) so the
     * reparented children render at the same pixels as before. */
    if (c.position.x !== 0 || c.position.y !== 0) c.position.set(0, 0);
    const elev = Number(regionObj.document?.elevation?.bottom ?? regionObj.document?.elevation) || 0;
    c.elevation = elev;
    /* Match token sortLayer − 1 so at equal elevation the region
     * paints under the token (matches the visual convention that the
     * caster's portrait draws over the Yrden circle they're standing
     * in — same rule the token-decoration carrier follows). */
    c.sortLayer = (Number(canvas.primary?.constructor?.SORT_LAYERS?.TOKENS) || 700) - 1;
    c.sort      = 0;
    c.zIndex    = 0;
    if (canvas.primary) canvas.primary.sortDirty = true;
}

function _findRegionBorder(regionObj) {
    /* Region#_draw adds: hitbox (Container), _measurementLines
     * (Graphics — public), #border (Graphics — PRIVATE), #controls
     * (Container), _measurementLabels (Container). `#border` is the
     * FIRST PIXI.Graphics child that isn't `_measurementLines`.
     *
     * Note: `#border` is only visible when the region is controlled /
     * hovered / on the "highlight all" layer state — it's NOT the
     * user-visible outline of a Yrden circle. The visible outline is
     * `_measurementLines` (drawn by `shape.drawReferenceLines` per
     * region.mjs `_refreshMeasurements`), reparented separately in
     * `onRefreshRegionOcclusion`. Border is still reparented here so
     * a GM hovering the region gets the outline occluded consistently
     * with the fill. */
    if (!regionObj?.children?.length) return null;
    const measurement = regionObj._measurementLines;
    for (const ch of regionObj.children) {
        if (ch === measurement) continue;
        if (ch instanceof PIXI.Graphics) return ch;
    }
    return null;
}

function _findRegionHighlightMesh(regionObj) {
    const layerHighlights = regionObj?.layer?._highlights;
    if (!layerHighlights?.children?.length) return null;
    for (const ch of layerHighlights.children) {
        if (ch?.region === regionObj) return ch;
    }
    return null;
}

function onRefreshRegionOcclusion(regionObj) {
    if (!regionObj || regionObj.destroyed) return;
    const zoneFlags = regionObj.document?.flags?.[SYSTEM_ID]?.zoneEffect;
    if (!zoneFlags) return;

    const carrier = _getOrCreateRegionOcclusionCarrier(regionObj);
    if (!carrier || carrier.destroyed) return;
    _syncRegionOcclusionCarrier(regionObj);

    const moveInto = (child) => {
        if (!child || child.destroyed) return;
        if (child.parent === carrier) return;
        try {
            child.parent?.removeChild?.(child);
            carrier.addChild(child);
        } catch (_) {}
    };
    /* The USER-VISIBLE outline of a Yrden circle is `_measurementLines`
     * (Foundry draws it via `shape.drawReferenceLines(graphics)`
     * whenever `document.displayMeasurements` is true — which our
     * migration sets on every zone template). The `RegionMesh`
     * highlight paints the fill. Both need to be in the carrier or
     * the roof-occlusion goes half-done — fill covered by roofs, but
     * outline visibly bleeding through, which is what "the outline
     * indicating a circle isn't there" flipped into after the first
     * pass reparented only the fill + hidden #border. `_measurementLabels`
     * (the distance text) rides along so a "5m" label doesn't float
     * above a hidden circle. */
    moveInto(_findRegionHighlightMesh(regionObj));
    moveInto(regionObj._measurementLines);
    moveInto(regionObj._measurementLabels);
    moveInto(_findRegionBorder(regionObj));
}

function onDestroyRegionOcclusion(regionObj) {
    const c = regionObj?.[_REGION_OCCLUSION_MARK];
    if (!c) return;
    /* `children: false`, and the distinction is the whole bug.
     *
     * The carrier does not OWN its children — it borrows them. The reparent
     * pipeline moves Foundry's own `RegionMesh`, the placeable's `#border` and
     * the measurement lines into it so a roof sorts over them. Destroying the
     * carrier with `children: true` destroyed all four, and then Foundry's own
     * `Region.destroy()` destroyed its mesh a second time and hit a null:
     *
     *     TypeError: Cannot read properties of null (reading 'refCount')
     *         at RegionMesh.destroy
     *
     * which surfaced on EVERY zone expiry as "zone region delete failed". A
     * bare Region created and deleted with no spell attached never showed it,
     * which is what pointed here: the difference was that ours had been
     * reparented.
     *
     * Anything the carrier made itself would need destroying here; it makes
     * nothing. Leave the borrowed objects for their real owner. */
    try { if (!c.destroyed) c.destroy({ children: false }); } catch (_) {}
    if (regionObj) regionObj[_REGION_OCCLUSION_MARK] = null;
}

/* Level-swap refresh: `refreshRegion` doesn't always fire on canvas
 * level / scene changes, so on canvasReady walk every zone region and
 * force the reparent pipeline to run against fresh carriers. Cheap
 * (a handful of regions per scene at most) and idempotent. */
Hooks.on("canvasReady", () => {
    const scene = canvas?.scene;
    if (!scene) return;
    for (const region of scene.regions ?? []) {
        const obj = region?.object;
        if (obj) onRefreshRegionOcclusion(obj);
    }
});

async function onDeleteRegion(regionDoc, options, userId) {
    if (game.user !== game.users?.activeGM) return;
    /* Only regions carrying our zoneEffect flag matter — every other
     * region-delete is somebody else's business. */
    const zoneFlags = regionDoc?.flags?.[SYSTEM_ID]?.zoneEffect;
    if (!zoneFlags) return;
    if (game.user?.isGM) {
        let stack = "";
        try { stack = new Error("wdm-region-delete-trace").stack?.split("\n").slice(0, 8).join(" | "); } catch (_) {}
        console.log(`${SYSTEM_ID} | wdm region deleted (was template)`, {
            regionId: regionDoc.id,
            regionUuid: regionDoc.uuid,
            userId,
            options,
            itemName:  zoneFlags.itemName,
            combatStarted: !!game.combat?.started,
            worldTime: game.time?.worldTime,
            stack
        });
    }
    const scene = regionDoc.parent;
    if (!scene) return;

    /* Stage 2b: the zone Region IS the document entrant AEs reference —
     * `zoneTemplate` on each AE equals `regionDoc.uuid` (Scene.<sid>.Region.<rid>).
     * So the primary strip runs straight against the region's own UUID.
     * This is the delete path that fires for every zone teardown now
     * (combatRound / worldTime / marker / wall-clock all call
     * `template.delete()` on a RegionDocument → this hook). */
    await stripZoneAEsForTemplate(regionDoc);

    /* Legacy safety: any pre-migration zone was a MeasuredTemplate stored
     * as a region carrying `flags.core.MeasuredTemplate`, and its entrant
     * AEs referenced the synthetic `Scene.<sid>.MeasuredTemplate.<rid>`
     * UUID. Strip those too so a zone placed before this upgrade still
     * cleans up when removed. Harmless (a no-op find) for native zones. */
    const legacyUuid = `Scene.${scene.id}.MeasuredTemplate.${regionDoc.id}`;
    const actors = new Set();
    for (const tokenDoc of scene.tokens ?? []) {
        if (tokenDoc.actor) actors.add(tokenDoc.actor);
    }
    if (zoneFlags.casterUuid) {
        try {
            const casterActor = fromUuidSync?.(zoneFlags.casterUuid);
            if (casterActor) actors.add(casterActor);
        } catch (_) {}
    }
    for (const actor of actors) {
        const stale = actor.effects.filter(e =>
            e.getFlag(SYSTEM_ID, "zoneTemplate") === legacyUuid);
        if (!stale.length) continue;
        try {
            await actor.deleteEmbeddedDocuments("ActiveEffect", stale.map(e => e.id));
        } catch (err) {
            console.warn(`${SYSTEM_ID} | region delete → legacy AE strip failed on ${actor.name}`, err);
        }
    }
}

async function onDeleteMeasuredTemplate(templateDoc, options, userId) {
    if (game.user !== game.users?.activeGM) return;
    const flags = templateDoc.getFlag(SYSTEM_ID, "zoneEffect");
    if (!flags) return;
    /* Diagnostic — grep "wdm template deleted" while testing. Captures
     * WHO deleted the template (userId), whether Foundry's own delete
     * pipeline was involved (options.deleteAll etc.), and a stack
     * fragment. If the template is dying "almost right away" without
     * combatRound / wall-clock / marker cascade firing, this log shows
     * whether it's Foundry's deprecation shim (MeasuredTemplate→Region
     * migration), a third-party module, or something in our own code
     * we've missed. */
    if (game.user?.isGM) {
        let stack = "";
        try { stack = new Error("wdm-template-delete-trace").stack?.split("\n").slice(0, 8).join(" | "); } catch (_) {}
        console.log(`${SYSTEM_ID} | wdm template deleted`, {
            templateUuid: templateDoc.uuid,
            userId,
            options,
            flagsSnippet: {
                itemName:      flags.itemName,
                roundsRemaining: flags.roundsRemaining,
                wallExpiresAt: flags.wallExpiresAt,
                expiresAt:     flags.expiresAt
            },
            combatStarted: !!game.combat?.started,
            worldTime:     game.time?.worldTime,
            stack
        });
    }
    await stripZoneAEsForTemplate(templateDoc);
}

/**
 * Walk every scene actor (token actors + the caster's world actor for
 * the marker AE) and remove every AE whose `zoneTemplate` flag equals
 * the given template's UUID. Called from:
 *
 *   1. `onDeleteMeasuredTemplate` (Foundry-level hook fires last)
 *   2. Every code path in this module that calls `template.delete()`
 *      just BEFORE the delete, so a Foundry v14 quirk where the
 *      `deleteMeasuredTemplate` hook doesn't fire (deprecation-routed
 *      through Regions, cross-scene race, etc.) still cleans up.
 *
 * Also strips the caster's own marker AE when the caster's world
 * actor is reachable via `zoneFlags.casterUuid` — the marker gets
 * stamped with `zoneTemplate` at cast time (see castSpellMixin
 * `_applyCastDuration`), so it lives under the same reconcile pass
 * as entrant AEs. */
export async function stripZoneAEsForTemplate(templateDoc) {
    if (!templateDoc) return;
    const flags = templateDoc.getFlag(SYSTEM_ID, "zoneEffect");
    if (!flags) return;
    const templateUuid = templateDoc.uuid;
    const scene = templateDoc.parent;
    if (!scene?.tokens) return;

    /* Every token actor on the scene. */
    const actors = new Set();
    for (const tokenDoc of scene.tokens) {
        if (tokenDoc.actor) actors.add(tokenDoc.actor);
    }
    /* Caster's world actor (for the marker AE — it lives on the
     * WORLD actor, not the scene's token actor, so an unlinked
     * token's synthetic actor doesn't hold the marker). */
    if (flags.casterUuid) {
        try {
            const casterActor = fromUuidSync?.(flags.casterUuid);
            if (casterActor) actors.add(casterActor);
        } catch (_) { /* soft-fail — bad UUID, skip */ }
    }

    for (const actor of actors) {
        const stale = actor.effects.filter(e =>
            e.getFlag(SYSTEM_ID, "zoneTemplate") === templateUuid);
        if (!stale.length) continue;
        try {
            await actor.deleteEmbeddedDocuments("ActiveEffect", stale.map(e => e.id));
        } catch (err) {
            /* "does not exist" = a concurrent expiry path already deleted
             * these AEs (see deleteZoneRegion). Benign race — swallow it
             * quietly; anything else is a real failure worth logging. */
            if (!/does not exist/i.test(String(err?.message ?? ""))) {
                console.warn(`${SYSTEM_ID} | zone AE strip failed on ${actor.name}`, err);
            }
        }
    }
}

/* Idempotent, race-safe delete for a zone Region. Multiple expiry paths —
 * combatRound, worldTime, marker-cascade, and the wall-clock sweeper — can
 * all fire for the SAME region within one tick (e.g. a marker AE expiring at
 * the exact moment the sweeper runs). Two concurrent `region.delete()` calls
 * made Foundry destroy the region's canvas mesh twice (`RegionMesh.destroy`
 * → null `refCount`) and threw a flurry of "Region/ActiveEffect does not
 * exist" errors as each path re-stripped already-deleted AEs. Every delete
 * now funnels through this guard: a per-uuid in-flight lock (added
 * synchronously before the first await, so it's a real mutex on the single JS
 * thread) plus a live existence re-check, swallowing the benign
 * "does not exist" race quietly. */
const _zoneDeleteInFlight = new Set();
/**
 * Exported so the magic engine ends a zone through the SAME door.
 *
 * A zone has two things entitled to end it: the engine's lifetime and this
 * module's own `roundsRemaining` countdown. `_zoneDeleteInFlight` is what stops
 * them colliding — and the engine's `removeZone` was calling `template.delete()`
 * directly, straight past it. Both deletes then ran against one region and
 * PIXI tore the same RegionMesh down twice:
 * `Cannot read properties of null (reading 'refCount')`.
 *
 * A checked-then-deleted guard in the caller is not enough, because the other
 * delete is usually already IN FLIGHT — the region still exists when you look.
 * One deleter, one guard.
 */
export async function deleteZoneRegion(template) {
    const uuid = template?.uuid;
    if (!uuid) return;
    if (_zoneDeleteInFlight.has(uuid)) return;
    const scene = template.parent;
    /* Already gone — a racing path deleted it before we got here. */
    if (scene?.regions && !scene.regions.get(template.id)) return;
    _zoneDeleteInFlight.add(uuid);
    try {
        await stripZoneAEsForTemplate(template);
        /* Re-check after the awaited strip: another path may have deleted
         * the region while we were stripping. */
        if (!scene?.regions || scene.regions.get(template.id)) {
            await template.delete();
        }
    } catch (err) {
        if (!/does not exist/i.test(String(err?.message ?? ""))) {
            console.warn(`${SYSTEM_ID} | zone region delete failed`, err);
        }
    } finally {
        _zoneDeleteInFlight.delete(uuid);
    }
}

/**
 * Absolute-time expiry: any zone template whose `expiresAt` worldTime
 * has passed gets deleted (which then strips its AEs via the delete
 * hook). Fires on every worldTime advance, so real-time seconds ticks
 * and manual GM jumps both flush stale zones.
 */
async function onUpdateWorldTime(worldTime /* , delta, options, userId */) {
    if (game.user !== game.users?.activeGM) return;
    const now = Number(worldTime) || 0;
    for (const scene of game.scenes ?? []) {
        const templates = collectZoneTemplates(scene);
        for (const template of templates) {
            const flags = template.getFlag(SYSTEM_ID, "zoneEffect");
            if (!flags) continue;
            const at = Number(flags.expiresAt);
            if (!Number.isFinite(at) || at <= 0) continue;
            if (now < at) continue;
            await deleteZoneRegion(template);
        }
    }
}

/**
 * Socket dispatcher — currently only handles `zoneTemplateCreate`
 * from non-GM callers. GM-side only.
 */
async function onSocketMessage(data) {
    if (game.user !== game.users?.activeGM) return;
    if (!data || data.type !== "zoneTemplateCreate") return;
    if (data.recipientUserId && data.recipientUserId !== game.user.id) return;
    try {
        const scene = game.scenes?.get(data.sceneId);
        if (!scene) return;
        /* Back-compat: accept either `regionData` (Stage 2b) or the legacy
         * `templateData` key from a mid-upgrade client, but always create a
         * native Region. */
        const regionData = data.regionData ?? data.templateData;
        if (!regionData) return;
        const [doc] = await scene.createEmbeddedDocuments("Region", [regionData]);
        if (doc) await applyEntryToAllTokensInside(doc);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | zone region create (via socket) failed`, err);
    }
}

/* ── Internals ──────────────────────────────────────────────────── */

/** Non-GM caller routes template creation through the GM. Resolves
 *  optimistically (fire-and-forget) — Foundry will broadcast the
 *  successful create back to all clients as a document creation. */
async function requestZoneCreate(regionData) {
    if (!game.socket) return null;
    const activeGM = game.users?.activeGM;
    if (!activeGM) {
        ui.notifications?.warn(t("WITCHER.Mech.ZoneEffects.Notify.NoActiveGMToPersistThe", "No active GM to persist the zone template."));
        return null;
    }
    game.socket.emit(SOCKET_CHANNEL, {
        type:            "zoneTemplateCreate",
        senderUserId:    game.user?.id,
        recipientUserId: activeGM.id,
        sceneId:         canvas.scene?.id,
        regionData
    });
    return null;   // fire-and-forget: caller doesn't need the doc
}

/* `buildTemplateRegionData` (MeasuredTemplate-shaped geometry → native
 * RegionDocument creation data) lives in castArea.mjs and is imported at
 * the top of this module. It was moved there deliberately: bombs.mjs also
 * needs it for the scatter-flash, and bombs.mjs → zoneEffects.mjs created a
 * module-load cycle (bombs is dynamic-imported by dock.js) that made the
 * named export fail to resolve. castArea.mjs is a shared leaf both callers
 * already import cleanly, so hosting it there breaks the cycle. */

/** Handle a token entering a zone: apply the zone's status riders. */
/**
 * Bodies belonging to authored zones, by region uuid.
 *
 * `core:createZone` hands the adapter an `onEnter` CLOSURE — the compiled body
 * of the zone, to be run for whoever steps in. The adapter passed it down as
 * part of `castContext`, which is written to the region's FLAGS, and a
 * function cannot survive being stored on a document. So it arrived as
 * `undefined` and nothing ever ran it: every authored zone in the engine
 * caught people and did nothing to them. Yrden's circle was decorative.
 *
 * A live Map is the honest fix for a live callback. It does not survive a
 * reload — the same limitation every other standing effect in this engine has
 * — but within a session the zone now does what it says.
 */
const ZONE_BODIES = new Map();

/* Exit can be signalled more than once for the same step. Both passes see the
 * same effect ids, both try to delete them, and the loser throws
 * `ActiveEffect "..." does not exist` — which aborts the rest of ITS batch, so
 * a second effect can survive the strip. Keyed `${regionUuid}:${actorUuid}`. */
const STRIPPING = new Set();

export function registerZoneBody(regionUuid, handlers) {
    if (regionUuid && handlers) ZONE_BODIES.set(regionUuid, { ...handlers, inside: new Set() });
}
export function clearZoneBody(regionUuid) { ZONE_BODIES.delete(regionUuid); }

async function onZoneEnter(token, template, zoneFlags) {
    const actor = token?.actor;
    if (game.user?.isGM) {
        console.log(`${SYSTEM_ID} | wdm onZoneEnter`, {
            actorName: actor?.name,
            actorUuid: actor?.uuid,
            excludeCaster: !!zoneFlags?.excludeCaster,
            casterUuid: zoneFlags?.casterUuid,
            wouldSkipAsCaster: !!(zoneFlags?.excludeCaster && actor?.uuid === zoneFlags?.casterUuid)
        });
    }
    if (!actor) return;
    if (zoneFlags.excludeCaster) {
        const casterActor = zoneFlags.casterUuid ? fromUuidSync?.(zoneFlags.casterUuid) : null;
        if (casterActor && actor.uuid === casterActor.uuid) return;
    }
    /* Handler hook — bespoke behavior BEFORE default apply. Handler
     * may set ctx.skip = true to cancel the default. */
    const ctx = { token, actor, template, castContext: zoneFlags, skip: false };
    if (zoneFlags.handler) {
        const spec = getSpellHandler(zoneFlags.handler);
        if (typeof spec?.onZoneEnter === "function") {
            try { await spec.onZoneEnter(ctx); } catch (err) {
                console.warn(`${SYSTEM_ID} | handler onZoneEnter failed`, err);
            }
        }
    }
    if (ctx.skip) return;

    /* The authored body, if this zone has one. Runs for whoever walked in.
     *
     * Guarded against running twice for the same person: entry can be
     * signalled by more than one path (the first-frame sweep over tokens
     * already standing inside, and the movement diff), and a body that applies
     * a -2 penalty twice leaves a -4 that only half lifts. Anything this zone
     * has already put on them is proof they are already inside. */
    const authored = ZONE_BODIES.get(template?.uuid);
    if (authored?.onEnter && !authored.inside.has(actor.uuid)) {
        /* Marked BEFORE the await, not after.
         *
         * The caller's own guard is "does this actor already carry one of this
         * zone's effects", and the effects are created through the GM socket —
         * so they do not exist yet when the next movement tick asks. Walking
         * in over several steps therefore ran the body once per step and
         * stacked the penalty. Membership is decided here, synchronously,
         * where there is no gap to race through. */
        authored.inside.add(actor.uuid);
        try { await authored.onEnter(actor); }
        catch (err) {
            authored.inside.delete(actor.uuid);
            console.warn(`${SYSTEM_ID} | authored zone body failed on ${actor.name}`, err);
        }
    }
    const aeDuration = zoneFlags.aeDuration ?? null;
    for (const rider of (zoneFlags.riders ?? [])) {
        if (rider.mode !== "zone") continue;
        /* Skip chance rolls for zone entries — RAW zone effects
         * "always apply while inside" per the audit. Chance only
         * makes sense for one-shot onHit riders. */
        await applyZoneAE(actor, template.uuid, rider, aeDuration, { tangible: zoneFlags.tangible !== false, itemUuid: zoneFlags.itemUuid });
    }
    /* Authored-AE zone bridge: when the spell has `castsAuthoredAE: true`
     * and is a persistent zone, we route the item's embedded AEs
     * through the zone system rather than the cast-time hit-target
     * block in castSpellMixin. This turns "define the effect on the
     * item as an authored AE" into a valid zone spell config — the
     * same AE the item authors gets cloned onto every token that
     * ENTERS the zone (not just those inside at cast time), and gets
     * stripped on exit / template delete / duration expiry via the
     * same `zoneTemplate` + `zoneRiderMode: "zone"` flag pipeline
     * `applyZoneAE` uses. Generic — no per-spell branching. */
    await applyAuthoredZoneAEs(actor, template.uuid, zoneFlags);
}

/* Same in-flight dedup pattern as `_inFlightZoneAEs` but for the
 * `castsAuthoredAE` bridge path. */
const _inFlightAuthoredAEs = new Map();

async function applyAuthoredZoneAEs(actor, templateUuid, zoneFlags) {
    const authored = zoneFlags?.authoredEffects;
    if (game.user?.isGM) {
        console.log(`${SYSTEM_ID} | wdm applyAuthoredZoneAEs entered`, {
            actor: actor?.name,
            templateUuid,
            authoredIsArray: Array.isArray(authored),
            authoredLength: authored?.length ?? "n/a",
            firstName: authored?.[0]?.name
        });
    }
    if (!Array.isArray(authored) || !authored.length) return;
    const flightKey = `${actor.uuid}|${templateUuid}|authored`;
    const inFlight = _inFlightAuthoredAEs.get(flightKey);
    if (inFlight) {
        if (game.user?.isGM) console.log(`${SYSTEM_ID} | wdm applyAuthoredZoneAEs dedup (in-flight)`, actor.name);
        return inFlight;
    }
    /* Skip if the actor already carries an authored-AE from this
     * template (walked back in during an ongoing cast, race between
     * enter-hooks). Prevents stacking. */
    const already = actor.effects.some(e =>
        e.getFlag(SYSTEM_ID, "zoneTemplate") === templateUuid
        && e.getFlag(SYSTEM_ID, "zoneAuthored") === true);
    if (already) {
        if (game.user?.isGM) console.log(`${SYSTEM_ID} | wdm applyAuthoredZoneAEs skip (already)`, actor.name);
        return;
    }
    const runPromise = _applyAuthoredZoneAEsCore(actor, templateUuid, zoneFlags, authored);
    _inFlightAuthoredAEs.set(flightKey, runPromise);
    try { return await runPromise; }
    finally { _inFlightAuthoredAEs.delete(flightKey); }
}

async function _applyAuthoredZoneAEsCore(actor, templateUuid, zoneFlags, authored) {

    const payloads = authored.map(src => {
        const cloned = foundry.utils.duplicate(src);
        delete cloned._id;
        cloned.origin = zoneFlags.casterUuid ?? null;
        cloned.transfer = false;
        cloned.flags = cloned.flags ?? {};
        cloned.flags[SYSTEM_ID] = {
            ...(cloned.flags[SYSTEM_ID] ?? {}),
            zoneTemplate:    templateUuid,
            zoneRiderMode:   "zone",
            zoneStripOnExit: true,
            zoneAuthored:    true,
            sourceItem:      zoneFlags.itemUuid ?? null,
            sourceCaster:    zoneFlags.casterUuid ?? null
        };
        return cloned;
    });
    /* Diagnostic — grep for "wdm zone authored" while walking a token
     * into the zone. If this fires, entrants got the item's authored
     * AE cloned + linked to the template so the strip pipeline catches
     * it on exit / delete / expiry. */
    if (game.user?.isGM) {
        console.log(`${SYSTEM_ID} | wdm zone authored`, {
            actor:        actor?.name,
            templateUuid,
            payloadCount: payloads.length,
            firstChanges: payloads[0]?.changes
        });
    }
    try {
        await actor.createEmbeddedDocuments("ActiveEffect", payloads);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | zone authored-AE apply failed on ${actor.name}`, err);
    }
}

/** Handle a token leaving a zone: strip any AE it holds sourced
 *  from THIS template (only when stripOnExit was set on the rider). */
async function onZoneExit(token, template, zoneFlags) {
    const actor = token?.actor;
    if (!actor) return;
    const ctx = { token, actor, template, castContext: zoneFlags, skip: false };
    if (zoneFlags.handler) {
        const spec = getSpellHandler(zoneFlags.handler);
        if (typeof spec?.onZoneExit === "function") {
            try { await spec.onZoneExit(ctx); } catch (err) {
                console.warn(`${SYSTEM_ID} | handler onZoneExit failed`, err);
            }
        }
    }
    if (ctx.skip) return;
    /* Out is out — they may walk back in and the body should run again. */
    ZONE_BODIES.get(template?.uuid)?.inside?.delete(actor.uuid);
    const templateUuid = template.uuid;
    const stale = actor.effects.filter(e => {
        if (e.getFlag(SYSTEM_ID, "zoneTemplate") !== templateUuid) return false;
        const riderMode = e.getFlag(SYSTEM_ID, "zoneRiderMode");
        const stripOnExit = e.getFlag(SYSTEM_ID, "zoneStripOnExit");
        if (riderMode !== "zone" || stripOnExit === false) return false;
        /* IT MAY LINGER. Freya's Bravery: "if they leave the area, its effects
         * last for 1d6 rounds — and these rounds renew if the person re-enters
         * and leaves again." An effect carrying a linger is not stripped on the
         * way out; its own countdown takes over, and walking back in re-applies
         * it from scratch, which is what "renew" means. */
        const linger = Number(e.getFlag(SYSTEM_ID, "zoneLingerRounds")) || 0;
        if (linger > 0) {
            e.update({ duration: { rounds: linger, startRound: game.combat?.round ?? 0 } })
             .catch(() => {});
            return false;
        }
        return true;
    });
    if (stale.length) {
        try {
            const key = `${templateUuid}:${actor.uuid}`;
            if (STRIPPING.has(key)) return;          // another pass is already on it
            STRIPPING.add(key);
            try {
                const ids = stale.map(e => e.id).filter(id => actor.effects.get(id));
                if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
            } finally {
                STRIPPING.delete(key);
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | zone exit AE strip failed on ${actor.name}`, err);
        }
    }
}

/** Fire onTick riders + per-round damage against every token
 *  currently inside a template. Called from the combatRound hook
 *  when at least one rider on the template has mode:"onTick". */
async function applyTickToAllTokensInside(template) {
    const zoneFlags = template.getFlag(SYSTEM_ID, "zoneEffect");
    if (!zoneFlags) return;
    const scene = template.parent;
    if (!scene?.tokens) return;
    const casterUuid = zoneFlags.casterUuid;
    const zoneElev = Number(zoneFlags.zoneElevation ?? template.elevation?.bottom ?? 0);
    for (const tokenDoc of scene.tokens) {
        const actor = tokenDoc.actor;
        if (!actor) continue;
        if (zoneFlags.excludeCaster && actor.uuid === casterUuid) continue;
        const tokenElev = Number(tokenDoc.elevation ?? 0);
        if (Number.isFinite(zoneElev) && Number.isFinite(tokenElev) && tokenElev !== zoneElev) continue;
        if (!tokenIntersectsTemplate(template, tokenDoc, tokenDoc.x, tokenDoc.y)) continue;
        const tickCtx = { token: tokenDoc.object, actor, template, castContext: zoneFlags, skip: false };
        if (zoneFlags.handler) {
            const spec = getSpellHandler(zoneFlags.handler);
            if (typeof spec?.onZoneTick === "function") {
                try { await spec.onZoneTick(tickCtx); } catch (err) {
                    console.warn(`${SYSTEM_ID} | handler onZoneTick failed`, err);
                }
            }
        }
        if (tickCtx.skip) continue;
        for (const rider of (zoneFlags.riders ?? [])) {
            if (rider.mode !== "onTick") continue;
            /* onTick riders fire each round even for tokens already
             * carrying the AE — the intent is a fresh damage/effect
             * pulse. If the clause is a stat penalty, we skip the
             * re-apply when the AE is already present so magnitudes
             * don't stack unbounded. */
            const already = actor.effects.find(e =>
                e.getFlag(SYSTEM_ID, "zoneTemplate") === template.uuid
                && e.statuses?.has?.(rider.statusId));
            if (already) continue;
            await applyZoneAE(actor, template.uuid, rider, zoneFlags.aeDuration ?? null, { tangible: zoneFlags.tangible !== false, itemUuid: zoneFlags.itemUuid });
        }
    }
}

/** Same as tick, but only for the "someone already stands here"
 *  first-frame case when a zone is placed onto occupied tiles. */
async function applyEntryToAllTokensInside(template) {
    const zoneFlags = template.getFlag(SYSTEM_ID, "zoneEffect");
    if (!zoneFlags) return;
    const scene = template.parent;
    if (!scene?.tokens) return;
    const zoneElev = Number(zoneFlags.zoneElevation ?? template.elevation?.bottom ?? 0);
    let visitedCount = 0;
    let insideCount = 0;
    for (const tokenDoc of scene.tokens) {
        visitedCount++;
        const actor = tokenDoc.actor;
        if (!actor) continue;
        const tokenElev = Number(tokenDoc.elevation ?? 0);
        if (Number.isFinite(zoneElev) && Number.isFinite(tokenElev) && tokenElev !== zoneElev) continue;
        const inside = tokenIntersectsTemplate(template, tokenDoc, tokenDoc.x, tokenDoc.y);
        if (!inside) continue;
        insideCount++;
        if (game.user?.isGM) {
            console.log(`${SYSTEM_ID} | wdm zone entry-scan hit`, {
                token: tokenDoc.name,
                actor: actor.name
            });
        }
        await onZoneEnter(tokenDoc.object ?? tokenDoc, template, zoneFlags);
    }
    if (game.user?.isGM) {
        console.log(`${SYSTEM_ID} | wdm zone entry-scan done`, {
            templateUuid: template.uuid,
            visitedCount,
            insideCount
        });
    }
}

/** Foundry-compatible AE duration object derived from an item's
 *  `system.duration.{value, unit}`. Mirrors the helper in
 *  castSpellMixin.mjs — duplicated locally so the zone system doesn't
 *  reach across into the mixin's private scope. Rounds → seconds via
 *  CONFIG.time.roundTime to sidestep Foundry v14's off-by-one bug in
 *  `_prepareCombatBasedDuration` (see earlier debugging notes). */
function _itemDurationToAEDuration(itemDuration) {
    if (!itemDuration || !itemDuration.unit) return null;
    const value = Number(itemDuration.value) || 0;
    if (value <= 0) return null;
    switch (itemDuration.unit) {
        case "rounds": {
            const rt = Number(CONFIG?.time?.roundTime) || 6;
            return { seconds: value * rt };
        }
        case "minutes": return { seconds: value * 60 };
        case "hours":   return { seconds: value * 3600 };
        case "days":    return { seconds: value * 86400 };
        default:        return null;
    }
}

/* In-flight tracker for concurrent apply calls.
 *
 * `applyEntryToAllTokensInside` (fires when the template is placed)
 * and `reconcileTokenZoneAEs` (fires from `moveToken` / `updateToken`
 * on the token that JUST triggered the placement) can both call
 * `applyZoneAE` for the same (actor, template, rider) tuple within
 * a few ms — before the first `createEmbeddedDocuments` awaits
 * long enough to commit its AE into `actor.effects`. The
 * `actor.effects.find(...)` idempotency guard below can't catch it
 * because at the moment both parallel calls run their check,
 * `actor.effects` is empty for this rider.
 *
 * This map records the FIRST call's in-flight promise per key; every
 * subsequent parallel call awaits the same promise and skips the
 * create, so exactly one AE lands per (actor, template, rider). Once
 * the create resolves, the key is dropped so future casts / re-entries
 * proceed normally. */
const _inFlightZoneAEs = new Map();

/** Create the AE payload from a zone rider, source-tag it, and
 *  create it on the target actor. */
async function applyZoneAE(actor, templateUuid, rider, aeDuration = null, opts = {}) {
    const flightKey = `${actor.uuid}|${templateUuid}|${rider.statusId}|${rider.mode}`;
    const inFlight = _inFlightZoneAEs.get(flightKey);
    if (inFlight) {
        if (game.user?.isGM) console.log(`${SYSTEM_ID} | wdm applyZoneAE dedup (in-flight)`, actor.name);
        return inFlight;
    }
    /* Idempotency: never stack two rider-AEs from the SAME template
     * with the SAME status. Committed-AE check — catches the case
     * where the previous apply for this key already landed and we're
     * re-entering after a walkout/walkin cycle. */
    const already = actor.effects.find(e =>
        e.getFlag(SYSTEM_ID, "zoneTemplate") === templateUuid
        && (e.statuses?.has?.(rider.statusId)
            || e.getFlag(SYSTEM_ID, "zoneRiderMode") === rider.mode));
    if (already) {
        if (game.user?.isGM) console.log(`${SYSTEM_ID} | wdm applyZoneAE skip (already)`, actor.name);
        return;
    }
    const runPromise = _applyZoneAECore(actor, templateUuid, rider, aeDuration, opts);
    _inFlightZoneAEs.set(flightKey, runPromise);
    try { return await runPromise; }
    finally { _inFlightZoneAEs.delete(flightKey); }
}

/** Body of the AE create (separated so `applyZoneAE` can wrap it with
 *  the in-flight tracker). */
async function _applyZoneAECore(actor, templateUuid, rider, aeDuration, opts = {}) {

    /* Cast-shield gate — mirror the one-shot onHit rider path
     * (handleApplyStatus): a tangible zone source is absorbed by the
     * entrant's active shield (the non-cast activeShield AE that
     * buildActiveShield reports; Quen-style castShield pools are
     * deliberately excluded there). An intangible zone (mental / gas /
     * suffocation) bypasses it. Without this, zone riders slipped past
     * the shield that identical onHit riders respect. Silent (no chat)
     * to avoid spam on re-entry; onHit posts once per hit, zones can
     * re-trigger on every walk-in. */
    if (opts?.tangible === true && buildActiveShield(actor)) {
        if (game.user?.isGM) console.log(`${SYSTEM_ID} | zone AE absorbed by active shield`, actor?.name, rider?.statusId);
        return;
    }

    /* refreshOnRecast — a re-cast of the same source spell should REPLACE
     * its prior zone AE on this actor, not stack a second copy. The
     * per-template idempotency guard in applyZoneAE only dedups within a
     * SINGLE template; a recast mints a NEW template, so we strip prior
     * zone AEs carrying the same stable source key here. Key mirrors the
     * onHit path's `spell:<itemId>:<statusId>` (resolveSchemaRiderFlags)
     * so the two refresh models agree. */
    const _sourceKey = opts?.itemUuid ? `zone:${opts.itemUuid}:${rider.statusId ?? ""}` : null;
    if (rider.refreshOnRecast === true && _sourceKey) {
        try {
            const priors = (actor.effects ?? []).filter(e =>
                e.getFlag?.(SYSTEM_ID, "zoneTemplate") !== templateUuid
                && String(e.getFlag?.(SYSTEM_ID, "zoneSource") ?? "") === _sourceKey
            );
            if (priors.length) await actor.deleteEmbeddedDocuments("ActiveEffect", priors.map(e => e.id));
        } catch (err) {
            console.warn(`${SYSTEM_ID} | zone refreshOnRecast strip failed`, err);
        }
    }

    const clause = clauseFor(rider.statusId, actor) ?? {};
    const changes = buildAEChangesFromClause(clause, rider);
    /* Diagnostic — GM-only, one line per zone AE apply. When STA
     * scaling reports the wrong magnitude, this shows exactly what
     * `resolveStaScale` returned, whether `zoneScaleKeys` reached
     * `buildAEChangesFromClause`, and what stat changes ended up on
     * the AE. Grep the console for "wdm zone apply" while casting to
     * confirm the pipeline is producing the right numbers. */
    if (game.user?.isGM) {
        console.log(`${SYSTEM_ID} | wdm zone apply`, {
            actor:             actor?.name,
            statusId:          rider?.statusId,
            resolvedMagnitude: rider?.resolvedMagnitude,
            clauseHasScaleKeys:!!clause?.zoneScaleKeys,
            clauseMods:        clause?.mods,
            changes
        });
    }
    const ae = {
        name:     nameForStatus(rider.statusId, clause),
        img:      iconForStatus(rider.statusId, clause),
        statuses: [rider.statusId],
        changes,
        origin:   null,
        flags: {
            [SYSTEM_ID]: {
                zoneTemplate:     templateUuid,
                zoneRiderMode:    rider.mode,
                zoneStripOnExit:  rider.stripOnExit !== false,
                zoneMagnitude:    rider.resolvedMagnitude,
                zoneAppliedAt:    game.time?.worldTime ?? 0,
                /* Stable source key for refreshOnRecast strip (only stamped
                 * when the rider opts into refresh, so non-refresh zones stay
                 * untouched by a later recast's sweep). */
                ...(rider.refreshOnRecast === true && _sourceKey ? { zoneSource: _sourceKey } : {})
            }
        }
    };
    /* Link the AE's duration to the item's — so the entrant sees a
     * countdown on the AE that ticks in lockstep with the template's
     * expiry. `stripZoneAEsForTemplate` still cleans up when the
     * template deletes for any reason (combatRound expiry, template
     * manually removed, etc.), so this duration is really a display /
     * safety-net; the authoritative lifetime is the template's. */
    if (aeDuration) ae.duration = aeDuration;
    try {
        await actor.createEmbeddedDocuments("ActiveEffect", [ae]);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | zone AE create failed on ${actor.name} (${rider.statusId})`, err);
    }
}

/** Walk a clause's `mods.stats` / `mods.roll` and translate to
 *  ActiveEffect `changes[]`. When a clause entry carries the
 *  `zoneScaleKey: true` marker, the rider's resolved magnitude
 *  overrides the clause value. Otherwise the clause's static
 *  magnitude is used. */
function buildAEChangesFromClause(clause, rider) {
    const changes = [];
    const mag = Number.isFinite(rider.resolvedMagnitude) ? rider.resolvedMagnitude : null;

    /* stats map: { ref: -N, dex: -N, ... } → system.stats.<key>.current */
    /* CANONICAL SHAPE: this system's AEs use the string-typed
     * change format (see setup/config.mjs `EFFECT_CHANGE_MODES` and
     * `statusEngine.mjs` `change()` helper) — not Foundry's legacy
     * numeric `mode`. And stat debuffs target `.modifier` (the
     * unbounded add-in field folded into the prepared value by
     * `prepareDerivedData`), not `.current` / `.value` (the source
     * fields, which are clamped 1–10 for character stats and get
     * overwritten each derive pass). Getting either wrong makes the
     * AE apply cleanly on the sheet but leave the actor's stats
     * untouched. */
    const statMods = clause?.mods?.stats ?? {};
    for (const [statKey, staticVal] of Object.entries(statMods)) {
        const useScaled = clause?.zoneScaleKeys?.stats?.[statKey] === true && mag !== null;
        const value = useScaled ? mag : Number(staticVal) || 0;
        if (!value) continue;
        changes.push({
            key:      `system.stats.${statKey}.modifier`,
            value:    String(value),
            type:     "add",
            phase:    "initial",
            priority: 0
        });
    }

    /* NOTE: `mods.roll` values (attack/defense/awareness/all/verbal
     * penalties) are NOT baked into AE changes here — `rollMods()`
     * in `statusEngine.mjs` walks `actor.statuses` at read time and
     * sums the current clause's `mods.roll` bucket live. Emitting AE
     * changes for these would double-count once a token has the
     * status. The AE's `statuses: [rider.statusId]` entry is what
     * makes the status active on the actor, and rollMods reads it
     * from there. */
    return changes;
}

/* ── Helpers ────────────────────────────────────────────────────── */

/** Every zone RegionDocument on a scene carrying a `zoneEffect` flag.
 *
 *  Stage 2b: persistent zones are now native Regions, so we read the live
 *  `scene.regions` collection directly (NOT the deprecated + heavy
 *  `scene.templates` getter, which rebuilt a RegionDocument + a
 *  MeasuredTemplateDocument per region on every access — the bulk of the
 *  old in-combat move lag). `scene.regions` is a plain EmbeddedCollection
 *  access, so this is already cheap; the cache is retained mainly to keep
 *  the `.filter` allocation out of the per-move path and to return a stable
 *  array reference. Invalidated on region / scene lifecycle hooks. */
let _ztCache = null;   // { sceneId, gen, templates }
let _ztGen = 0;
function invalidateZoneTemplateCache() { _ztGen++; }

function collectZoneTemplates(scene) {
    if (!scene?.id) return [];
    if (_ztCache && _ztCache.sceneId === scene.id && _ztCache.gen === _ztGen) {
        return _ztCache.templates;
    }
    const regions = scene.regions;
    const templates = regions ? regions.filter(r => r.getFlag(SYSTEM_ID, "zoneEffect")) : [];
    _ztCache = { sceneId: scene.id, gen: _ztGen, templates };
    return templates;
}

/** Test whether a scene-space point falls inside a MeasuredTemplate.
 *
 *  We compute the geometry from the DOCUMENT directly instead of
 *  going through `template.object.shape` / `object.testPoint`. Under
 *  v14's deprecation shim MeasuredTemplate placeables are lazily
 *  constructed the first time `templateDoc.object` is accessed, and
 *  their `.shape` isn't populated until a render tick fires — which
 *  is AFTER `applyEntryToAllTokensInside` runs on a freshly-created
 *  template. Result: `object.testPoint(point)` throws
 *  "Cannot read properties of undefined (reading 'contains')" for
 *  every token, no one is detected as inside, and the zone AE
 *  never gets applied at cast time. Diagnostic run confirmed this
 *  (via_testPoint / via_shape both undefined; template distance:3
 *  at (1450, 750) with tokens sitting exactly at (1450, 750)).
 *
 *  Doing the math ourselves is straightforward for all four
 *  MeasuredTemplate shapes (circle, cone, rect, ray) and side-steps
 *  the entire lazy-placeable timing issue. distance is in scene
 *  units; convert to pixels via the scene's grid ratio. */
function testPointOnTemplate(templateDoc, point) {
    if (!templateDoc || !point) return false;
    const scene = templateDoc.parent;
    const gridSize     = Number(scene?.grid?.size) || 100;
    const gridDistance = Number(scene?.grid?.distance) || 1;
    const distancePx   = gridSize / gridDistance;

    /* Stage 2b: zones are RegionDocuments now, which have no
     * `t/x/y/distance/direction/angle/width` fields of their own — the
     * MeasuredTemplate geometry is stashed on the `zoneEffect.geometry`
     * flag at create time. Read from there, falling back to the document's
     * own fields so a stray legacy MeasuredTemplate (pre-migration) still
     * resolves. Containment stays euclidean-analytic exactly as before —
     * this only changes WHERE the numbers are read from. */
    const geom = templateDoc.getFlag?.(SYSTEM_ID, "zoneEffect")?.geometry ?? templateDoc;

    const ox = Number(geom.x) || 0;
    const oy = Number(geom.y) || 0;
    const dx = point.x - ox;
    const dy = point.y - oy;
    const distancePixels = (Number(geom.distance) || 0) * distancePx;
    const type = String(geom.t ?? "");

    switch (type) {
        case "circle": {
            /* Point inside circle centered at (ox, oy) with the given
             * radius (already in pixels). Uses squared distance to
             * skip the sqrt. */
            return (dx * dx + dy * dy) <= (distancePixels * distancePixels);
        }
        case "cone": {
            /* Cone extends from (ox, oy) toward `direction` (degrees)
             * spanning `angle` degrees, out to `distance` scene units.
             * Point is inside iff (a) within the radial reach and
             * (b) its bearing from the apex lies within ±angle/2 of
             * direction. Bearing normalised into (-180, 180]. */
            const r2 = dx * dx + dy * dy;
            if (r2 > distancePixels * distancePixels) return false;
            const dir = Number(geom.direction) || 0;
            const half = (Number(geom.angle) || 0) / 2;
            if (half <= 0) return false;
            const bearing = Math.toDegrees(Math.atan2(dy, dx));
            let delta = bearing - dir;
            delta = ((delta + 540) % 360) - 180;
            return Math.abs(delta) <= half;
        }
        case "rect": {
            /* Foundry rects: `distance` is the diagonal length from
             * (ox, oy) to the far corner, direction picks the corner.
             * The rectangle spans between (ox, oy) and that corner. */
            const dir = Number(geom.direction) || 0;
            const rad = Math.toRadians(dir);
            const farX = distancePixels * Math.cos(rad);
            const farY = distancePixels * Math.sin(rad);
            const minX = Math.min(0, farX);
            const maxX = Math.max(0, farX);
            const minY = Math.min(0, farY);
            const maxY = Math.max(0, farY);
            return dx >= minX && dx <= maxX && dy >= minY && dy <= maxY;
        }
        case "ray": {
            /* Rotated-rectangle beam of length `distance` and width
             * `width` (scene units) from (ox, oy) in `direction`.
             * Transform the point into ray-local coords: rotate by
             * -direction, then test against 0..distancePixels along
             * the axis and ±width/2 across it. */
            const dir = Number(geom.direction) || 0;
            const rad = -Math.toRadians(dir);
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const localAxis = dx * cos - dy * sin;
            const localCross = dx * sin + dy * cos;
            const widthPx = (Number(geom.width) || 0) * distancePx;
            const halfW = widthPx / 2;
            return localAxis >= 0
                && localAxis <= distancePixels
                && localCross >= -halfW
                && localCross <=  halfW;
        }
        default:
            return false;
    }
}

/** Cell-based "is the token standing on a zone-highlighted tile" test.
 *
 *  Per user's spec: apply fires when the token MOVES INTO a tile the
 *  template covers; strip fires when it MOVES OUT of a tile the
 *  template covers. Foundry's own tile-highlight algorithm (see
 *  `MeasuredTemplate#_getGridHighlightPositions`) uses each cell's
 *  CENTER against the shape — so aligning our detection to the cell
 *  center gives the same in/out boundary the visible highlight
 *  shows.
 *
 *  Earlier iterations of this helper sampled 4 corners + center,
 *  which felt "one tile off" on exit (a token barely poking into
 *  the zone with one corner counted as inside, so stripping only
 *  fired when the whole bbox had cleared). Cell-center alignment
 *  produces boundary events that match what the player SEES as
 *  the zone footprint.
 *
 *  For oversized tokens we still use the geometric center of the
 *  full bbox — the cell footprint is the token's own occupation
 *  square, and its center is the natural "am I in the zone" pivot.
 */
function tokenIntersectsTemplate(templateDoc, tokenDoc, x, y) {
    if (!templateDoc || !tokenDoc) return false;
    const sceneGrid = tokenDoc?.parent?.grid;
    const gridSize = Number(sceneGrid?.size) || Number(canvas?.scene?.grid?.size) || 100;
    const widthTiles  = Number(tokenDoc?.width)  || 1;
    const heightTiles = Number(tokenDoc?.height) || 1;
    const center = {
        x: Number(x) + (gridSize * widthTiles)  / 2,
        y: Number(y) + (gridSize * heightTiles) / 2
    };
    return testPointOnTemplate(templateDoc, center);
}

/* staScale resolution is shared with the UI preview and the onHit cast
 * dispatch via `mechanics/staScale.mjs` — same formula, same fields
 * (offset / divisor / cap / baseSta / maxSta), so an author changing
 * the ladder in the sheet sees identical values here at cast time. */
function resolveStaScale(scale, staSpent) {
    return _resolveScaleAt(scale, staSpent);
}

/** Absolute worldTime at which the template should self-delete for
 *  time-based durations. Returns 0 when the duration is rounds-based
 *  (combatRound owns those) or permanent. */
function computeAbsoluteExpiry(item) {
    const dur = item?.system?.duration;
    if (!dur) return 0;
    const raw = String(dur.value ?? "").trim();
    const unit = String(dur.unit ?? "instant");
    if (unit === "permanent" || unit === "instant") return 0;
    const asNum = /^\d+$/.test(raw) ? Number(raw) : (/\d+d\d+/.test(raw)
        ? (() => { try { return new Roll(raw).evaluateSync?.().total ?? 0; } catch (_) { return 0; } })()
        : 0);
    if (!asNum) return 0;
    /* Rounds-based durations ALSO get an absolute-time expiry: a
     * Yrden cast out of combat (or one whose combat ends before the
     * rounds tick down) would otherwise never fire the `combatRound`
     * hook and the template would linger forever. Converting rounds
     * to seconds at 6s / round (Witcher / D&D convention; overridden
     * by `CONFIG.time.roundTime` when the system sets it) means the
     * `updateWorldTime` cleanup path catches it as soon as the world
     * clock advances past the expiry. In combat, the `combatRound`
     * tick still deletes the template on the round boundary — this
     * expiry is a floor, not a replacement. */
    const roundTime = Number(CONFIG?.time?.roundTime) || 6;
    const perUnit = {
        seconds: 1,
        minutes: 60,
        hours:   3600,
        days:    86400,
        rounds:  roundTime
    }[unit] ?? 0;
    if (!perUnit) return 0;
    const now = Number(game.time?.worldTime) || 0;
    return now + (asNum * perUnit);
}

/** Roll the item's duration into a round count. Non-round durations
 *  fall back to a large default so time-unit expiries are handled
 *  by Foundry's own AE duration decay — the zone template itself
 *  just needs to survive that long. */
function computeRoundsRemaining(item) {
    const dur = item?.system?.duration;
    if (!dur) return 3;
    const raw = String(dur.value ?? "").trim();
    const unit = String(dur.unit ?? "instant");
    const asNum = /^\d+$/.test(raw) ? Number(raw) : null;
    if (unit === "rounds") {
        if (asNum !== null) return Math.max(1, asNum);
        /* Dice-defined round durations (1d6) — roll now so the tick
         * counter has a concrete integer. */
        if (/\d+d\d+/.test(raw)) {
            try { return Math.max(1, new Roll(raw).evaluateSync?.().total ?? 3); } catch (_) { return 3; }
        }
        return 3;
    }
    /* minutes / hours / days: cover a lot of ticks; combatRound
     * expiry probably won't fire before the AE's own duration
     * expires. Set a large number so we don't accidentally
     * expire early. */
    if (unit === "minutes") return (asNum || 1) * 10;
    if (unit === "hours")   return (asNum || 1) * 600;
    if (unit === "days")    return (asNum || 1) * 14400;
    if (unit === "permanent") return 999999;
    return 1;
}

function nameForStatus(statusId, clause) {
    const def = (CONFIG.statusEffects ?? []).find(s => s?.id === statusId);
    const key = def?.name ?? def?.label;
    if (key) {
        try { const l = game.i18n.localize(key); if (l) return l; } catch (_) {}
    }
    if (clause?.description) return String(clause.description).split(/[:.—]/)[0].trim();
    return statusId;
}

function iconForStatus(statusId, clause) {
    const def = (CONFIG.statusEffects ?? []).find(s => s?.id === statusId);
    return def?.img ?? clause?.img ?? "icons/svg/aura.svg";
}
