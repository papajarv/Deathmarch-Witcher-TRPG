/**
 * castArea — MeasuredTemplate placement + token harvest for area spells.
 *
 * When castSpellMixin resolves an area spell (cone / radius / cube /
 * line) with NO targets picked, `pickAreaTargets` drops an interactive
 * template preview and honours the item's `areaAnchor` schema field:
 *
 *   anchor "caster"  — origin LOCKED to the caster's token; mousemove
 *                      aims the direction (the shape spins around the
 *                      caster like an axis); wheel provides fine
 *                      adjust. Signs and self-emanating cones/lines/
 *                      domes (Aard, Igni, Quen, Aard Sweep).
 *   anchor "free"    — origin free to place; mousemove snaps to grid
 *                      centers; wheel rotates. Ranged zone spells
 *                      (Cinder Door, Lightning Storm, Magic Flare).
 *
 * Live targeting: while the preview is up, tokens whose center falls
 * inside the current shape are flagged via `token.setTarget(true)` so
 * Foundry's own yellow reticle renders on them. This gives a
 * continuously-updated highlight as the player aims/moves the
 * template. Any target added by the preview is un-set on cancel and
 * on commit — castSpellMixin uses the returned actor array, not the
 * reticle state.
 *
 * On commit the preview's PIXI shape + origin (x, y) is captured, the
 * preview object is destroyed, and every token in the scene is tested
 * against the captured shape. Actors whose token center falls inside
 * are returned, deduped by uuid. Caller feeds the array into the same
 * defense fan-out flow that manual targeting uses.
 *
 * Preview-only, no persist: earlier revisions called
 * `canvas.scene.createEmbeddedDocuments("MeasuredTemplate", ...)` then
 * `placed.delete()` — the delete could silently fail (permission
 * mismatch, render race) leaving stale outlines on the canvas. This
 * version never creates a scene document; the preview lives only for
 * the duration of the click loop.
 *
 * Skipped shapes: "touch" (single-target physical), "self" (caster
 * only), "none" (no area). Those fall through to `getActorTarget()`.
 *
 * Implementation: subclass `CONFIG.MeasuredTemplate.objectClass` so the
 * preview lives inside Foundry's own PlaceableObject lifecycle
 * (`draw()`, `refresh()`, layer.preview membership). Attempting to run
 * an inline `preview.draw()` without inheriting the placeable class
 * silently fails in Foundry v13 — the PIXI draw pipeline expects a
 * properly-constructed placeable with document + shape wiring already
 * in place. Extending the class inherits the shape-recomputation
 * machinery for free, so wheel-rotate / mousemove refreshes redraw
 * correctly.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Witcher area shape → Foundry MeasuredTemplate.t enum. */
const SHAPE_TO_FOUNDRY = Object.freeze({
    cone:   "cone",
    radius: "circle",
    cube:   "rect",
    line:   "ray"
});

/* Free-text range parser — many legacy spells were authored with the
 * shape in the RANGE field ("2m Cone", "3-meter radius", "5m line")
 * instead of the structured areaShape / areaSize fields. This lets
 * those spells behave as areas without editing every item. Runs ONLY
 * when the schema fields are unset ("none" / 0). */
const RANGE_AREA_RE = /(\d+(?:\.\d+)?)\s*(?:m|meters?)[\s\-]*(cone|radius|sphere|circle|cube|line|ray)/i;
const RANGE_SHAPE_ALIASES = Object.freeze({
    sphere: "radius",
    circle: "radius",
    ray:    "line"
});

/**
 * Return effective { shape, size } for an item, preferring the schema
 * fields when set. Falls back to parsing the free-text range string
 * for legacy spells authored before the schema fields existed. Returns
 * `{ shape: "none", size: 0 }` when neither yields an area.
 */
export function resolveAreaInfo(item) {
    const rawShape = String(item?.system?.areaShape ?? "none");
    const rawSize  = Number(item?.system?.areaSize) || 0;
    if (rawShape && rawShape !== "none" && rawSize > 0) {
        return { shape: rawShape, size: rawSize };
    }
    /* Fallback: extract "Nm cone" / "Nm radius" / "Nm line" from the
     * range field. Only accepts positive N; unknown shape aliases
     * ("sphere" → "radius", "ray" → "line") normalize into the four
     * mapped enum values. */
    const rangeStr = String(item?.system?.range ?? "");
    const match    = rangeStr.match(RANGE_AREA_RE);
    if (!match) return { shape: "none", size: 0 };
    const parsedSize  = Number(match[1]) || 0;
    const parsedShape = String(match[2]).toLowerCase();
    const shape       = RANGE_SHAPE_ALIASES[parsedShape] ?? parsedShape;
    if (parsedSize <= 0 || !SHAPE_TO_FOUNDRY[shape]) return { shape: "none", size: 0 };
    return { shape, size: parsedSize };
}

/**
 * Public entry point — present an interactive template preview and
 * resolve to an array of Actor documents whose tokens intersect the
 * placed template. Empty array on cancel, missing shape/size, or no
 * active canvas.
 *
 * @param {object} args
 * @param {Actor}  args.actor  — caster (used to origin the preview on their token)
 * @param {Item}   args.item   — spell/hex item (system.areaShape, areaSize read here)
 */
export async function pickAreaTargets({ actor, item }) {
    if (!canvas?.scene || !canvas?.ready) return [];
    if (!actor || !item) return [];

    const { shape, size } = resolveAreaInfo(item);
    const foundryType = SHAPE_TO_FOUNDRY[shape];
    if (!foundryType || size <= 0) return [];

    /* No-canvas / theater-of-mind guard: if the caster has no active
     * token on this scene, the template is meaningless (there's
     * nothing to project it FROM). Bail out with an empty array so
     * castSpellMixin skips the fan-out entirely and the cast resolves
     * as a plain spellcasting roll with the item's effect description
     * on the chat card. Same guard fires when the scene simply has
     * no tokens placed at all. */
    const casterToken = actor.getActiveTokens?.()?.[0] ?? null;
    const anyTokens = (canvas.tokens?.placeables?.length ?? 0) > 0;
    if (!casterToken || !anyTokens) return [];
    const origin = casterToken.center;

    const templateData = {
        t: foundryType,
        user: game.user?.id ?? null,
        distance: size,
        direction: 0,
        x: origin.x,
        y: origin.y,
        fillColor: game.user?.color ?? "#c8a878",
        flags: { [SYSTEM_ID]: { areaSpell: true, sourceItem: item.uuid } }
    };
    /* Cone arc — 90° is the standard fantasy cone. A 45° arc at short
     * ranges (2-4m) rendered as a near-line and the user reported it
     * "acts as a straight line" in play; 90° reads unambiguously as
     * a cone at every range and matches how most VTT modules default. */
    if (foundryType === "cone") templateData.angle = 90;
    /* 1m-wide beam matches how the system treats line spells. */
    if (foundryType === "ray")  templateData.width = 1;

    /* Anchor mode — controls whether the preview's origin is locked to
     * the caster ("caster") or free-placed anywhere ("free"). Default
     * "caster" matches the schema default. */
    const anchor = String(item?.system?.areaAnchor ?? "caster") === "free" ? "free" : "caster";

    const AreaTemplateClass = buildAreaTemplateClass();
    /* place() now resolves to { shape, x, y, direction, t } captured
     * from the preview at commit time, NOT a persisted scene document.
     * This avoids a whole class of "template never disappears" bugs
     * where the delete silently failed. The preview is destroyed
     * inside teardown() before place() resolves, so nothing is left
     * on the canvas at all. */
    const captured = await AreaTemplateClass.place({
        templateData,
        itemName: item.name,
        anchor,
        casterCenter: origin
    });
    if (!captured) return [];
    return harvestTokens(captured);
}

/**
 * Persistent-zone entry point — same preview UX as pickAreaTargets
 * but returns the placement SNAPSHOT (x, y, direction, shape name,
 * size, foundryType) alongside the harvested actors, so
 * castSpellMixin can hand the snapshot to `createZoneTemplate` in
 * zoneEffects.mjs. Actors are still returned because a persistent
 * zone MAY still deal one-shot damage on placement (damagePer:
 * "cast") in addition to the ongoing zone effect.
 *
 * Returns null on cancel / missing area / no active token.
 *
 * @param {object} args
 * @param {Actor}  args.actor
 * @param {Item}   args.item
 * @returns {Promise&lt;{placement:{x,y,direction,shape,size,foundryType}, actors:Actor[]}|null&gt;}
 */
export async function pickAreaSnapshot({ actor, item }) {
    if (!canvas?.scene || !canvas?.ready) return null;
    if (!actor || !item) return null;

    const { shape, size } = resolveAreaInfo(item);
    const foundryType = SHAPE_TO_FOUNDRY[shape];
    if (!foundryType || size <= 0) return null;

    const casterToken = actor.getActiveTokens?.()?.[0] ?? null;
    const anyTokens = (canvas.tokens?.placeables?.length ?? 0) > 0;
    if (!casterToken || !anyTokens) return null;
    const origin = casterToken.center;

    const templateData = {
        t: foundryType,
        user: game.user?.id ?? null,
        distance: size,
        direction: 0,
        x: origin.x,
        y: origin.y,
        fillColor: game.user?.color ?? "#c8a878",
        flags: { [SYSTEM_ID]: { areaSpell: true, sourceItem: item.uuid } }
    };
    if (foundryType === "cone") templateData.angle = 90;
    if (foundryType === "ray")  templateData.width = 1;

    const anchor = String(item?.system?.areaAnchor ?? "caster") === "free" ? "free" : "caster";
    const AreaTemplateClass = buildAreaTemplateClass();
    const captured = await AreaTemplateClass.place({
        templateData, itemName: item.name, anchor, casterCenter: origin
    });
    if (!captured) return null;
    const actors = harvestTokens(captured);
    return {
        placement: {
            x:           captured.x,
            y:           captured.y,
            direction:   captured.direction,
            shape,
            size,
            foundryType
        },
        actors
    };
}

/** Every actor whose token center falls inside the captured template
 *  shape. Deduped by actor uuid. Takes the raw { shape, x, y } snapshot
 *  from the preview so no persisted document is required. */
function harvestTokens({ shape, x: originX, y: originY }) {
    if (!shape) return [];
    const tokens = canvas.tokens?.placeables ?? [];
    const seen = new Set();
    const out = [];
    for (const token of tokens) {
        if (!token?.actor) continue;
        if (seen.has(token.actor.uuid)) continue;
        /* Translate the token center into template-local space — the
         * placeable's shape is anchored at (0, 0). */
        const cx = (token.center?.x ?? token.x) - originX;
        const cy = (token.center?.y ?? token.y) - originY;
        let inside = false;
        try { inside = shape.contains(cx, cy); } catch (_) { inside = false; }
        if (inside) {
            seen.add(token.actor.uuid);
            out.push(token.actor);
        }
    }
    return out;
}

/** Late-build the subclass so `CONFIG.MeasuredTemplate.objectClass`
 *  is available (only populated after Foundry sets up its canvas
 *  document classes). Cached across calls. */
let _areaTemplateClass = null;
function buildAreaTemplateClass() {
    if (_areaTemplateClass) return _areaTemplateClass;
    const Base = CONFIG.MeasuredTemplate.objectClass;

    class WitcherAreaTemplate extends Base {
        /**
         * Static factory + placement entry. Constructs the placeable
         * off an unpersisted MeasuredTemplateDocument, draws it into
         * the templates layer's preview, activates listeners, and
         * resolves to the persisted document once the user clicks.
         * Resolves to null on cancel.
         */
        static async place({ templateData, itemName, anchor = "caster", casterCenter = null }) {
            const DocClass = CONFIG.MeasuredTemplate.documentClass;
            const doc = new DocClass(templateData, { parent: canvas.scene });
            const previewObj = new WitcherAreaTemplate(doc);
            previewObj._anchor       = anchor === "free" ? "free" : "caster";
            previewObj._casterCenter = casterCenter && Number.isFinite(casterCenter.x)
                ? { x: Number(casterCenter.x), y: Number(casterCenter.y) }
                : null;
            return previewObj._drawPreview({ itemName });
        }

        async _drawPreview({ itemName } = {}) {
            const initialLayer = canvas.activeLayer;
            try {
                await this.draw();
            } catch (err) {
                console.warn(`${SYSTEM_ID} | area template preview draw failed`, err);
                try { initialLayer?.activate?.(); } catch (_) {}
                return null;
            }
            canvas.templates.activate();
            canvas.templates.preview.addChild(this);
            try {
                const modeHint = this._anchor === "caster"
                    ? "aim with mouse, wheel to fine-tune"
                    : "move with mouse, wheel to rotate";
                ui.notifications?.info(
                    `${itemName ?? "Area spell"}: ${modeHint}, left-click to place, right-click / Esc to cancel.`
                );
            } catch (_) { /* soft-fail */ }

            return this._activatePreviewListeners(initialLayer);
        }

        _activatePreviewListeners(initialLayer) {
            return new Promise((resolve) => {
                const handlers = {};
                let lastMove = 0;
                let done = false;
                /* Set of token IDs the preview has flagged as targeted.
                 * Tracked so cancel() can un-target only tokens we set
                 * (not stomp any pre-existing targets the user had). */
                const targetedTokenIds = new Set();

                /** Recompute which tokens fall inside the CURRENT preview
                 *  shape and sync Foundry's target reticle. Called on
                 *  mousemove + wheel. Additive: sets targets on tokens
                 *  that entered, unsets on tokens that left. */
                const refreshTargeting = () => {
                    const shape  = this?.shape;
                    if (!shape) return;
                    const ox = Number(this.document?.x) || 0;
                    const oy = Number(this.document?.y) || 0;
                    const tokens = canvas.tokens?.placeables ?? [];
                    const nextInside = new Set();
                    for (const token of tokens) {
                        if (!token?.actor) continue;
                        const cx = (token.center?.x ?? token.x) - ox;
                        const cy = (token.center?.y ?? token.y) - oy;
                        let inside = false;
                        try { inside = shape.contains(cx, cy); } catch (_) { inside = false; }
                        if (inside) nextInside.add(token.id);
                    }
                    /* Set on newly-inside, unset on newly-outside. */
                    for (const token of tokens) {
                        if (!token?.setTarget) continue;
                        const nowIn = nextInside.has(token.id);
                        const wasIn = targetedTokenIds.has(token.id);
                        if (nowIn && !wasIn) {
                            try {
                                token.setTarget(true, {
                                    user: game.user, releaseOthers: false, groupSelection: false
                                });
                                targetedTokenIds.add(token.id);
                            } catch (_) {}
                        } else if (!nowIn && wasIn) {
                            try {
                                token.setTarget(false, {
                                    user: game.user, releaseOthers: false, groupSelection: false
                                });
                                targetedTokenIds.delete(token.id);
                            } catch (_) {}
                        }
                    }
                };

                /** Clear every target flag WE placed during the preview.
                 *  Called from BOTH cancel() and commit(): a canceled
                 *  placement should leave target state exactly as it
                 *  was, and a committed placement should hand its
                 *  candidates off through the returned actor array
                 *  (not through the target reticle) so a subsequent
                 *  single-target cast doesn't inherit a stale AoE
                 *  target set. The chat card carries the visual audit
                 *  trail (per-target hit/miss blocks) that used to
                 *  justify keeping the reticles. */
                const clearOurTargets = () => {
                    for (const id of targetedTokenIds) {
                        const t = canvas.tokens?.get?.(id);
                        try {
                            t?.setTarget?.(false, {
                                user: game.user, releaseOthers: false, groupSelection: false
                            });
                        } catch (_) {}
                    }
                    targetedTokenIds.clear();
                };

                /* Teardown tears down listeners + PIXI preview but does
                 * NOT touch reticle state — cancel() and commit() decide
                 * whether to preserve or clear the reticles. */
                const teardown = () => {
                    if (done) return;
                    done = true;
                    try { canvas.stage.off("pointermove", handlers.move); } catch (_) {}
                    try { canvas.stage.off("pointerdown", handlers.commit); } catch (_) {}
                    try { canvas.app?.view?.removeEventListener?.("contextmenu", handlers.cancel); } catch (_) {}
                    try { canvas.app?.view?.removeEventListener?.("wheel", handlers.rotate, { capture: true }); } catch (_) {}
                    try { document.removeEventListener("keydown", handlers.key); } catch (_) {}
                    try { this.destroy({ children: true }); } catch (_) {}
                    try { initialLayer?.activate?.(); } catch (_) {}
                };

                const cancel = () => {
                    /* Cancel = spell not cast → un-target everything we
                     * flagged during preview so the canvas returns to
                     * its pre-preview state. */
                    clearOurTargets();
                    teardown();
                    resolve(null);
                };

                const commit = () => {
                    /* Snapshot the preview's shape geometry + origin
                     * BEFORE teardown destroys the placeable. `this.shape`
                     * is populated by draw()/refresh() and remains valid
                     * as a plain PIXI polygon reference even after the
                     * placeable is destroyed — the container gets torn
                     * down but the shape object itself is not owned by
                     * the display tree. Passing it out of this closure
                     * lets harvestTokens hit-test without ever
                     * persisting anything to canvas.scene.
                     *
                     * The snapshot also carries `direction` and the
                     * document's `t` type so a persistent-zone caller
                     * (createZoneTemplate in zoneEffects.mjs) can
                     * reconstruct a scene MeasuredTemplate with the
                     * exact orientation the caster aimed. */
                    const snapshot = {
                        shape:     this.shape,
                        x:         Number(this.document?.x) || 0,
                        y:         Number(this.document?.y) || 0,
                        direction: Number(this.document?.direction) || 0,
                        t:         String(this.document?.t ?? "")
                    };
                    /* Clear the preview reticles: the harvested actors
                     * are passed back to castSpellMixin via the snapshot,
                     * not through game.user.targets. Leaving reticles
                     * on after commit would leak the AoE catches into
                     * the caster's next spell (which reads game.user
                     * .targets as its target set). */
                    clearOurTargets();
                    teardown();
                    resolve(snapshot);
                };

                handlers.move = (event) => {
                    const now = Date.now();
                    if (now - lastMove < 20) return;
                    lastMove = now;
                    try {
                        const localPos = event.data?.getLocalPosition
                            ? event.data.getLocalPosition(canvas.stage)
                            : (event.getLocalPosition ? event.getLocalPosition(canvas.stage) : null);
                        if (!localPos) return;

                        if (this._anchor === "caster") {
                            /* Caster-anchored: origin stays pinned at
                             * the caster's token center. The mouse
                             * cursor sets the DIRECTION (aim toward
                             * cursor). Wheel provides fine adjust.
                             * Circles have no meaningful direction —
                             * they still snap to the caster's origin
                             * so the preview never drifts. */
                            const origin = this._casterCenter;
                            if (origin) {
                                const dx = localPos.x - origin.x;
                                const dy = localPos.y - origin.y;
                                const deg = Math.atan2(dy, dx) * 180 / Math.PI;
                                const patch = { x: origin.x, y: origin.y };
                                if (this.document.t !== "circle") patch.direction = deg;
                                this.document.updateSource(patch);
                            }
                        } else {
                            /* Free-placed: snap origin to nearest grid
                             * center (matches Foundry's own template
                             * placement UX). Direction is controlled
                             * entirely by wheel. */
                            const snapMode = CONST.GRID_SNAPPING_MODES?.CENTER ?? 0x10;
                            const snapped = canvas.grid?.getSnappedPoint
                                ? canvas.grid.getSnappedPoint(localPos, { mode: snapMode })
                                : localPos;
                            this.document.updateSource({ x: snapped.x, y: snapped.y });
                        }
                        this.refresh();
                        refreshTargeting();
                    } catch (_) { /* cursor may leave canvas — soft-fail */ }
                };

                handlers.commit = (event) => {
                    /* PIXI federated events expose .button on the event
                     * OR on event.data depending on version — check
                     * both. Middle/right clicks are handled separately
                     * (cancel via contextmenu). */
                    const btn = event?.button ?? event?.data?.button ?? 0;
                    if (btn !== 0) return;
                    try { event.stopPropagation?.(); } catch (_) {}
                    /* commit() is now synchronous — it snapshots geometry
                     * off the preview and tears down; no scene document
                     * write means no async round-trip. */
                    commit();
                };

                handlers.rotate = (event) => {
                    if (this.document.t === "circle") return;
                    event.preventDefault();
                    event.stopPropagation();
                    const snapDeg = event.shiftKey ? 5 : 15;
                    const dir = Number(this.document.direction) || 0;
                    const next = event.deltaY > 0 ? dir + snapDeg : dir - snapDeg;
                    try {
                        this.document.updateSource({ direction: next });
                        this.refresh();
                        refreshTargeting();
                    } catch (_) { /* soft-fail */ }
                };

                handlers.cancel = (event) => {
                    try { event.preventDefault?.(); event.stopPropagation?.(); } catch (_) {}
                    cancel();
                };

                handlers.key = (event) => {
                    if (event.key === "Escape") cancel();
                };

                canvas.stage.on("pointermove", handlers.move);
                canvas.stage.on("pointerdown", handlers.commit);
                canvas.app?.view?.addEventListener?.("contextmenu", handlers.cancel);
                canvas.app?.view?.addEventListener?.("wheel", handlers.rotate, { capture: true, passive: false });
                document.addEventListener("keydown", handlers.key);
            });
        }
    }

    _areaTemplateClass = WitcherAreaTemplate;
    return WitcherAreaTemplate;
}
