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
 * a real MeasuredTemplateDocument to `canvas.scene` with a
 * `zoneEffect` flag payload:
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
 * `combatRound` decrements `roundsRemaining` on every zone template
 * in every scene (respecting `direction: -1` for rewinds). When it
 * hits 0, the template is deleted; the `deleteMeasuredTemplate`
 * hook then walks every token in the scene and strips its zone AEs
 * so nothing is left dangling.
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
 * @returns {Promise&lt;MeasuredTemplateDocument|null&gt;}
 */
export async function createZoneTemplate({ actor, item, castContext, placement, staSpent, message }) {
    if (!canvas?.scene || !placement) return null;

    const foundryType = SHAPE_TO_FOUNDRY[placement.shape];
    if (!foundryType) return null;

    /* Filter to zone-mode riders and resolve their staScale into
     * concrete magnitudes stamped on the template. A rider without
     * staScale (or with all-zeros) resolves to null, which the
     * apply-AE path interprets as "use the clause's fixed magnitude". */
    const zoneRiders = (Array.isArray(item.system?.statusRiders) ? item.system.statusRiders : [])
        .filter(r => (r?.mode ?? "onHit") === "zone" || (r?.mode ?? "") === "onTick")
        .map(r => ({
            statusId:          String(r.statusId ?? ""),
            chance:            Number(r.chance ?? 100) || 0,
            duration:          {
                value: String(r?.duration?.value ?? ""),
                unit:  String(r?.duration?.unit  ?? "instant")
            },
            mode:              String(r.mode ?? "zone"),
            stripOnExit:       r.stripOnExit !== false,
            resolvedMagnitude: resolveStaScale(r?.staScale, staSpent)
        }))
        .filter(r => r.statusId);

    const roundsRemaining = computeRoundsRemaining(item);
    const flagPayload = {
        itemUuid:        item.uuid,
        itemName:        item.name,
        casterUuid:      actor.uuid,
        castMessageUuid: message?.uuid ?? null,
        excludeCaster:   item.system?.areaExcludeCaster !== false,
        tangible:        item.system?.tangible !== false,
        roundsRemaining,
        roundsMax:       roundsRemaining,
        riders:          zoneRiders,
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

    const templateData = {
        t:           foundryType,
        user:        actor.isOwner ? game.user?.id : (game.users?.activeGM?.id ?? game.user?.id),
        x:           Number(placement.x) || 0,
        y:           Number(placement.y) || 0,
        distance:    Number(placement.size) || 0,
        direction:   Number(placement.direction) || 0,
        angle:       foundryType === "cone" ? 90 : 0,
        width:       foundryType === "ray"  ? 1  : 0,
        borderColor: game.user?.color ?? "#c8a878",
        fillColor:   game.user?.color ?? "#c8a878",
        flags: { [SYSTEM_ID]: { zoneEffect: flagPayload } }
    };

    /* GM proxy: players can't create scene templates without the
     * TRUSTED role. Route through the socket so a GM writes it on
     * their behalf. When we ARE the GM, write directly. */
    if (game.user?.isGM || game.user === game.users?.activeGM) {
        const [doc] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);
        /* First-frame entry check for tokens already standing inside
         * the freshly-placed zone. Without this, a Yrden dropped ON
         * an enemy wouldn't apply the status until they moved. */
        if (doc) await applyEntryToAllTokensInside(doc);
        return doc ?? null;
    }
    return await requestZoneCreate(templateData);
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

    push("updateToken",             onUpdateToken);
    push("combatRound",             onCombatRound);
    push("deleteMeasuredTemplate",  onDeleteMeasuredTemplate);

    /* GM-side socket handler — non-GM callers route zone creation
     * requests through here so a template gets written on their
     * behalf. */
    game.socket?.on(SOCKET_CHANNEL, onSocketMessage);
}

const _installedHookHandlers = [];

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

    const scene = tokenDoc.parent;
    const templates = collectZoneTemplates(scene);
    if (!templates.length) return;

    const oldCenter = tokenCenter(tokenDoc, tokenDoc.x, tokenDoc.y);
    const newCenter = tokenCenter(tokenDoc, changed.x ?? tokenDoc.x, changed.y ?? tokenDoc.y);

    for (const template of templates) {
        const zoneFlags = template.getFlag(SYSTEM_ID, "zoneEffect");
        if (!zoneFlags) continue;
        const wasInside = testPointOnTemplate(template, oldCenter);
        const nowInside = testPointOnTemplate(template, newCenter);
        if (wasInside === nowInside) continue;
        const token = template.parent?.tokens?.get?.(tokenDoc.id) ?? tokenDoc;
        if (nowInside) await onZoneEnter(token, template, zoneFlags);
        else            await onZoneExit(token, template, zoneFlags);
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
                /* deleteMeasuredTemplate hook does the AE strip. */
                await template.delete();
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
async function onDeleteMeasuredTemplate(templateDoc) {
    if (game.user !== game.users?.activeGM) return;
    const flags = templateDoc.getFlag(SYSTEM_ID, "zoneEffect");
    if (!flags) return;
    const templateUuid = templateDoc.uuid;
    const scene = templateDoc.parent;
    if (!scene?.tokens) return;
    for (const tokenDoc of scene.tokens) {
        const actor = tokenDoc.actor;
        if (!actor) continue;
        const stale = actor.effects.filter(e =>
            e.getFlag(SYSTEM_ID, "zoneTemplate") === templateUuid);
        if (stale.length) {
            try {
                await actor.deleteEmbeddedDocuments("ActiveEffect", stale.map(e => e.id));
            } catch (err) {
                console.warn(`${SYSTEM_ID} | zone AE strip failed on ${actor.name}`, err);
            }
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
        const [doc] = await scene.createEmbeddedDocuments("MeasuredTemplate", [data.templateData]);
        if (doc) await applyEntryToAllTokensInside(doc);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | zone template create (via socket) failed`, err);
    }
}

/* ── Internals ──────────────────────────────────────────────────── */

/** Non-GM caller routes template creation through the GM. Resolves
 *  optimistically (fire-and-forget) — Foundry will broadcast the
 *  successful create back to all clients as a document creation. */
async function requestZoneCreate(templateData) {
    if (!game.socket) return null;
    const activeGM = game.users?.activeGM;
    if (!activeGM) {
        ui.notifications?.warn("No active GM to persist the zone template.");
        return null;
    }
    game.socket.emit(SOCKET_CHANNEL, {
        type:            "zoneTemplateCreate",
        senderUserId:    game.user?.id,
        recipientUserId: activeGM.id,
        sceneId:         canvas.scene?.id,
        templateData
    });
    return null;   // fire-and-forget: caller doesn't need the doc
}

/** Handle a token entering a zone: apply the zone's status riders. */
async function onZoneEnter(token, template, zoneFlags) {
    const actor = token?.actor;
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
    for (const rider of (zoneFlags.riders ?? [])) {
        if (rider.mode !== "zone") continue;
        /* Skip chance rolls for zone entries — RAW zone effects
         * "always apply while inside" per the audit. Chance only
         * makes sense for one-shot onHit riders. */
        await applyZoneAE(actor, template.uuid, rider);
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
    const templateUuid = template.uuid;
    const stale = actor.effects.filter(e => {
        if (e.getFlag(SYSTEM_ID, "zoneTemplate") !== templateUuid) return false;
        const riderMode = e.getFlag(SYSTEM_ID, "zoneRiderMode");
        const stripOnExit = e.getFlag(SYSTEM_ID, "zoneStripOnExit");
        return riderMode === "zone" && stripOnExit !== false;
    });
    if (stale.length) {
        try {
            await actor.deleteEmbeddedDocuments("ActiveEffect", stale.map(e => e.id));
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
    for (const tokenDoc of scene.tokens) {
        const actor = tokenDoc.actor;
        if (!actor) continue;
        if (zoneFlags.excludeCaster && actor.uuid === casterUuid) continue;
        const center = tokenCenter(tokenDoc, tokenDoc.x, tokenDoc.y);
        if (!testPointOnTemplate(template, center)) continue;
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
            await applyZoneAE(actor, template.uuid, rider);
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
    for (const tokenDoc of scene.tokens) {
        const actor = tokenDoc.actor;
        if (!actor) continue;
        const center = tokenCenter(tokenDoc, tokenDoc.x, tokenDoc.y);
        if (!testPointOnTemplate(template, center)) continue;
        await onZoneEnter(tokenDoc.object ?? tokenDoc, template, zoneFlags);
    }
}

/** Create the AE payload from a zone rider, source-tag it, and
 *  create it on the target actor. */
async function applyZoneAE(actor, templateUuid, rider) {
    const clause = clauseFor(rider.statusId) ?? {};
    const changes = buildAEChangesFromClause(clause, rider);
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
                zoneAppliedAt:    game.time?.worldTime ?? 0
            }
        }
    };
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
    const statMods = clause?.mods?.stats ?? {};
    for (const [statKey, staticVal] of Object.entries(statMods)) {
        const useScaled = clause?.zoneScaleKeys?.stats?.[statKey] === true && mag !== null;
        const value = useScaled ? mag : Number(staticVal) || 0;
        if (!value) continue;
        changes.push({
            key:   `system.stats.${statKey}.current`,
            mode:  AE_MODE_ADD,
            value: String(value)
        });
    }

    /* roll map: { attack, defense, awareness, all, verbal, ... }
     *   → system.derivedStats.rollMods.<key> */
    const rollMods = clause?.mods?.roll ?? {};
    for (const [rollKey, staticVal] of Object.entries(rollMods)) {
        const useScaled = clause?.zoneScaleKeys?.roll?.[rollKey] === true && mag !== null;
        const value = useScaled ? mag : Number(staticVal) || 0;
        if (!value) continue;
        changes.push({
            key:   `system.derivedStats.rollMods.${rollKey}`,
            mode:  AE_MODE_ADD,
            value: String(value)
        });
    }
    return changes;
}

/* ── Helpers ────────────────────────────────────────────────────── */

/** Every MeasuredTemplateDocument on a scene carrying a
 *  `zoneEffect` flag. */
function collectZoneTemplates(scene) {
    if (!scene?.templates) return [];
    return scene.templates.filter(t => t.getFlag(SYSTEM_ID, "zoneEffect"));
}

/** Test a scene-space point against a template's PIXI shape. Uses
 *  the placeable's `testPoint` helper if present (handles the
 *  local-space translation for us); falls back to shape.contains
 *  with a manual origin shift when the placeable hasn't drawn
 *  yet (headless GM sockets). */
function testPointOnTemplate(templateDoc, point) {
    if (!point) return false;
    const object = templateDoc?.object;
    /* v13 helper: places the point in template-local space + hit-
     * tests the shape. Preferred path. */
    if (typeof object?.testPoint === "function") {
        try { return object.testPoint(point); } catch (_) { /* fall through */ }
    }
    const shape = object?.shape;
    if (!shape) return false;
    const localX = point.x - (Number(templateDoc.x) || 0);
    const localY = point.y - (Number(templateDoc.y) || 0);
    try { return shape.contains(localX, localY); } catch (_) { return false; }
}

/** Compute a token's center given a token document + its (possibly
 *  new) top-left coordinates. Derives from grid size so it works
 *  for oversized tokens too. */
function tokenCenter(tokenDoc, x, y) {
    const sceneGrid = tokenDoc?.parent?.grid;
    const gridSize = Number(sceneGrid?.size) || Number(canvas?.scene?.grid?.size) || 100;
    const widthTiles  = Number(tokenDoc?.width)  || 1;
    const heightTiles = Number(tokenDoc?.height) || 1;
    return {
        x: Number(x) + (gridSize * widthTiles)  / 2,
        y: Number(y) + (gridSize * heightTiles) / 2
    };
}

/** staScale → concrete magnitude.
 *   magnitude = offset * (1 + floor((staSpent - 1) / divisor))
 *   clamped by cap when cap is nonzero.
 *
 *   `offset` is BOTH the base value at STA=1 AND the per-step
 *   delta. Sign follows offset naturally: negative offset →
 *   penalty grows more negative each `divisor` STA; positive
 *   offset → bonus grows more positive.
 *
 *   Errata Yrden { -1, 2, -4 } at 1/3/5/7 STA → -1/-2/-3/-4:
 *     sta=1: -1 * (1 + 0) = -1
 *     sta=3: -1 * (1 + 1) = -2
 *     sta=5: -1 * (1 + 2) = -3
 *     sta=7: -1 * (1 + 3) = -4  (cap -4 holds; beyond it clamps)
 *
 *   A positive-offset buff { +2, 3, +6 } at 1/4/7/10 STA →
 *   +2/+4/+6/+6 (capped). */
function resolveStaScale(scale, staSpent) {
    if (!scale) return null;
    const offset  = Number(scale.offset) || 0;
    const divisor = Math.max(1, Number(scale.divisor) || 1);
    const cap     = Number(scale.cap) || 0;
    if (!offset && divisor === 1 && !cap) return null;    // all-zeros = no scaling
    const sta = Math.max(1, Number(staSpent) || 1);
    const steps = 1 + Math.floor((sta - 1) / divisor);
    let value = offset * steps;
    if (cap < 0) value = Math.max(value, cap);
    else if (cap > 0) value = Math.min(value, cap);
    return value;
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
