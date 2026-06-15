/**
 * Native notice-board parchments — drop a Note item onto the canvas and it
 * pins as a paper posting instead of becoming a token.
 *
 * Ported from the standalone `witcher-parchments` module into the system.
 * Differences from that module:
 *  - Any `note` item is postable. There is no dedicated parchment item type,
 *    no `fromParchment` flag, and no item-type rewrite on drop — notes stay
 *    notes (they already sort correctly in the inventory and are themselves
 *    re-droppable onto a scene).
 *  - Swipe-to-inventory creates a `note` on the target character.
 *  - GM-mediated scene-flag writes go through the system socket
 *    (setup/socketHook.mjs emit helpers); players can't write scene flags.
 *
 * Architecture:
 *  - The whole posting (paper + title + body + action buttons) is drawn as
 *    PIXI into canvas.primary at a low elevation, so it lives IN the scene:
 *    it pans/zooms natively, renders behind scene content (and under weather
 *    / lighting VFX), and can never overlap HTML UI like the portrait dock
 *    or sidebar. No HTML overlay, no per-frame sync.
 *  - Scene flag flags.<system>.parchments persists placements.
 */

import { MODULE_ID } from "../setup/settings.js";
import { emitAddSceneParchment, emitRemoveSceneParchment } from "../../setup/socketHook.mjs";

const SCENE_FLAG = "parchments";
const SPRITE_NAME = "wdm-parchments-container";

const NOTE_WIDTH = 260;
const NOTE_HEIGHT = 320;
const PAD = 18;
const BTN_H = 22;

/* Witcher contract-notice palette — aged parchment, sepia ink, muted gilt.
   Mirrors the --wdm-* tokens (paper ≈ #e7d8ac, amber #a88450 / dim #6e5224,
   ink #2a1d10) so the scene posting matches the in-sheet W3 tooltip skin. */
const PAPER = 0xe7d8ac;
const PAPER_AGED = 0x8a6f3a;   // edge-darkening vignette
const STAIN = 0x5a4423;        // foxing / water stains
const SHADOW = 0x120c04;
const INK = 0x2a1d10;          // body ink
const INK_TITLE = 0x3a2510;    // heavier title ink
const INK_SOFT = 0x6e5a32;
const AMBER = 0xa88450;
const AMBER_DIM = 0x6e5224;
const TACK_RIM = 0x14100a;     // iron corner tacks
const TACK_METAL = 0x4a4239;
const TACK_HI = 0xb8ad98;

const i18n = (k, fb) => game.i18n?.localize(k) || fb;
const DISPLAY_FONT = "'PF DIN Text Cond Pro', 'Barlow Condensed', 'Oswald', sans-serif";
const BODY_FONT = "'Barlow', 'Barlow Condensed', system-ui, sans-serif";

/* ============================================================
   SCENE FLAG ACCESSORS
   ============================================================ */

function getSceneParchments(scene) {
    return scene?.getFlag(MODULE_ID, SCENE_FLAG) || [];
}

/** GM-only direct write (drag-move + scale are GM-only, so always permitted). */
async function updateSceneParchment(scene, id, patch) {
    const list = foundry.utils.duplicate(getSceneParchments(scene));
    const idx = list.findIndex(n => n.id === id);
    if (idx === -1) return;
    Object.assign(list[idx], patch);
    await scene.setFlag(MODULE_ID, SCENE_FLAG, list);
}

/** Return the first active GM user, or null if no GM is online. */
function findActiveGM() {
    return game.users?.find(u => u.isGM && u.active) ?? null;
}

/* ============================================================
   PIXI PAPER VISUAL
   ============================================================ */

/** A single iron tack, drawn at (x, y). */
function buildTack(x, y) {
    const t = new PIXI.Graphics();
    t.beginFill(TACK_RIM, 0.85);
    t.drawCircle(x, y, 5.5);
    t.endFill();
    t.beginFill(TACK_METAL, 1);
    t.drawCircle(x, y, 4);
    t.endFill();
    t.beginFill(TACK_HI, 0.7);
    t.drawCircle(x - 1.3, y - 1.3, 1.4);
    t.endFill();
    return t;
}

/** Build the aged-parchment backing. `seed` makes the stains stable per note. */
function buildPaperGraphics(seed = "") {
    const g = new PIXI.Container();
    g.eventMode = "none";

    // Soft cast shadow.
    const shadow = new PIXI.Graphics();
    shadow.beginFill(SHADOW, 0.32);
    shadow.drawRoundedRect(5, 8, NOTE_WIDTH, NOTE_HEIGHT, 5);
    shadow.endFill();
    g.addChild(shadow);

    // Base paper.
    const paper = new PIXI.Graphics();
    paper.beginFill(PAPER, 1);
    paper.drawRoundedRect(0, 0, NOTE_WIDTH, NOTE_HEIGHT, 3);
    paper.endFill();
    g.addChild(paper);

    // Foxing / water stains — deterministic from the note id so they don't
    // flicker on re-render.
    const rng = mulberry32(hashStr(String(seed)));
    const stains = new PIXI.Graphics();
    for (let i = 0; i < 5; i++) {
        const sx = 18 + rng() * (NOTE_WIDTH - 36);
        const sy = 36 + rng() * (NOTE_HEIGHT - 72);
        const r = 6 + rng() * 24;
        stains.beginFill(STAIN, 0.04 + rng() * 0.05);
        stains.drawEllipse(sx, sy, r, r * (0.6 + rng() * 0.4));
        stains.endFill();
    }
    g.addChild(stains);

    // Edge vignette — concentric translucent strokes darken the borders.
    const vignette = new PIXI.Graphics();
    for (let i = 0; i < 6; i++) {
        const inset = i * 2.5;
        vignette.lineStyle({ width: 2.5, color: PAPER_AGED, alpha: 0.11 - i * 0.016 });
        vignette.drawRoundedRect(inset, inset, NOTE_WIDTH - inset * 2, NOTE_HEIGHT - inset * 2, 3);
    }
    g.addChild(vignette);

    // Gilt hairline frame.
    const frame = new PIXI.Graphics();
    frame.lineStyle({ width: 1, color: AMBER_DIM, alpha: 0.55 });
    frame.drawRect(7, 7, NOTE_WIDTH - 14, NOTE_HEIGHT - 14);
    g.addChild(frame);

    // Corner flourishes — short gilt L-brackets just inside the frame.
    const fl = new PIXI.Graphics();
    fl.lineStyle({ width: 1.5, color: AMBER, alpha: 0.7 });
    const m = 7, len = 13;
    fl.moveTo(m, m + len).lineTo(m, m).lineTo(m + len, m);
    fl.moveTo(NOTE_WIDTH - m - len, m).lineTo(NOTE_WIDTH - m, m).lineTo(NOTE_WIDTH - m, m + len);
    fl.moveTo(m, NOTE_HEIGHT - m - len).lineTo(m, NOTE_HEIGHT - m).lineTo(m + len, NOTE_HEIGHT - m);
    fl.moveTo(NOTE_WIDTH - m - len, NOTE_HEIGHT - m).lineTo(NOTE_WIDTH - m, NOTE_HEIGHT - m).lineTo(NOTE_WIDTH - m, NOTE_HEIGHT - m - len);
    g.addChild(fl);

    // Iron tacks in the top corners.
    g.addChild(buildTack(20, 16));
    g.addChild(buildTack(NOTE_WIDTH - 20, 16));

    return g;
}

/* ============================================================
   PARCHMENT RENDERER  (fully canvas-based)
   ============================================================ */

class ParchmentRenderer {
    constructor(entry, scene) {
        this.entry = entry;
        this.scene = scene;
        this.container = null;
        this._destroyed = false;
    }

    async render() {
        this._build();
        return true;
    }

    _build() {
        if (this._destroyed) return;
        const host = sceneManager.spriteContainer;
        if (!host) {
            console.warn(`${MODULE_ID} | spriteContainer missing when rendering parchment ${this.entry.id}`);
            return;
        }

        const isGM = game.user.isGM;
        const c = new PIXI.Container();
        c.x = this.entry.x;
        c.y = this.entry.y;
        c.scale.set(this.entry.scale ?? 1.0);
        // GM drags the paper; players only click the buttons. `static`
        // captures pointer events for the drag, `passive` lets only the
        // interactive button children respond.
        c.eventMode = isGM ? "static" : "passive";
        c.interactiveChildren = true;
        c.hitArea = new PIXI.Rectangle(0, 0, NOTE_WIDTH, NOTE_HEIGHT);
        this.container = c;

        c.addChild(buildPaperGraphics(this.entry.id));

        const snapshot = this.entry.snapshot || {};

        // Title — uppercase, tracked DIN, like an in-game contract header.
        const rawName = snapshot.name || i18n("WOU.Parchment.UntitledTitle", "Untitled Parchment");
        const title = new PIXI.Text(
            String(rawName).toUpperCase(),
            new PIXI.TextStyle({
                fill: INK_TITLE, fontFamily: DISPLAY_FONT, fontSize: 21,
                fontWeight: "700", align: "center", letterSpacing: 1.5,
                wordWrap: true, wordWrapWidth: NOTE_WIDTH - PAD * 2 - 8
            })
        );
        title.anchor.set(0.5, 0);
        title.x = NOTE_WIDTH / 2;
        title.y = PAD + 8;
        c.addChild(title);

        // Fleuron divider — twin gilt rules with a centre diamond.
        const titleBottom = title.y + title.height + 9;
        const cx = NOTE_WIDTH / 2;
        const divider = new PIXI.Graphics();
        divider.lineStyle({ width: 1, color: AMBER, alpha: 0.6 });
        divider.moveTo(PAD, titleBottom).lineTo(cx - 9, titleBottom);
        divider.moveTo(cx + 9, titleBottom).lineTo(NOTE_WIDTH - PAD, titleBottom);
        divider.lineStyle({ width: 1, color: AMBER_DIM, alpha: 0.45 });
        divider.beginFill(AMBER, 0.65);
        divider.drawPolygon([cx, titleBottom - 4, cx + 4, titleBottom, cx, titleBottom + 4, cx - 4, titleBottom]);
        divider.endFill();
        c.addChild(divider);

        // Body — buttons sit at the bottom, so clip the body to the space above.
        const btnY = NOTE_HEIGHT - PAD - BTN_H;
        const bodyTop = titleBottom + 10;
        const body = new PIXI.Text(
            htmlToText(snapshot.description) || i18n("WOU.Parchment.EmptyBody", "(No content yet.)"),
            new PIXI.TextStyle({
                fill: INK, fontFamily: BODY_FONT, fontSize: 14,
                align: "left", wordWrap: true, wordWrapWidth: NOTE_WIDTH - PAD * 2,
                lineHeight: 19
            })
        );
        body.x = PAD;
        body.y = bodyTop;
        const bodyMask = new PIXI.Graphics();
        bodyMask.beginFill(0xffffff);
        bodyMask.drawRect(PAD, bodyTop, NOTE_WIDTH - PAD * 2, Math.max(0, btnY - bodyTop - 6));
        bodyMask.endFill();
        c.addChild(bodyMask);
        body.mask = bodyMask;
        c.addChild(body);

        // Action buttons
        const swipe = this._makeButton(i18n("WOU.Parchment.Swipe", "Swipe"), () => this._onSwipeToInventory());
        swipe.x = PAD;
        swipe.y = btnY;
        c.addChild(swipe);

        if (isGM) {
            const remove = this._makeButton("×", () => this._confirmRemove(), { square: true, danger: true });
            const up = this._makeButton("+", () => this._adjustScale(0.1), { square: true });
            const down = this._makeButton("−", () => this._adjustScale(-0.1), { square: true });
            remove.x = NOTE_WIDTH - PAD - BTN_H;
            up.x = remove.x - (BTN_H + 4);
            down.x = up.x - (BTN_H + 4);
            remove.y = up.y = down.y = btnY;
            c.addChild(down, up, remove);
            this._enableDragging();
        }

        host.addChild(c);
    }

    _makeButton(label, onClick, { square = false, danger = false } = {}) {
        const cont = new PIXI.Container();
        cont.eventMode = "static";
        cont.cursor = "pointer";

        const txt = new PIXI.Text(square ? label : String(label).toUpperCase(), new PIXI.TextStyle({
            fill: danger ? 0x7a1414 : INK_TITLE, fontFamily: square ? BODY_FONT : DISPLAY_FONT,
            fontSize: square ? 15 : 11, fontWeight: "700",
            letterSpacing: square ? 0 : 1.2
        }));
        const w = square ? BTN_H : Math.ceil(txt.width) + 18;

        const draw = (hover) => {
            bg.clear();
            // Inked parchment chip: warm fill, gilt edge, brighter on hover.
            bg.beginFill(hover ? AMBER : INK_SOFT, hover ? 0.22 : 0.12);
            bg.lineStyle({ width: 1, color: danger && hover ? 0x9a0e0e : (hover ? AMBER : AMBER_DIM), alpha: hover ? 0.9 : 0.6 });
            bg.drawRoundedRect(0, 0, w, BTN_H, 2);
            bg.endFill();
        };
        const bg = new PIXI.Graphics();
        cont.addChild(bg);
        draw(false);

        txt.anchor.set(0.5);
        txt.x = w / 2;
        txt.y = BTN_H / 2;
        cont.addChild(txt);

        cont.hitArea = new PIXI.Rectangle(0, 0, w, BTN_H);
        cont.on("pointerover", () => draw(true));
        cont.on("pointerout", () => draw(false));
        // Swallow pointerdown so it never starts a paper drag.
        cont.on("pointerdown", (e) => e.stopPropagation());
        cont.on("pointerup", (e) => { e.stopPropagation(); onClick(); });
        return cont;
    }

    _enableDragging() {
        const c = this.container;
        const host = sceneManager.spriteContainer;
        let dragging = false;
        let start = null;
        let orig = null;

        c.on("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();   // don't let the canvas start a drag-select
            dragging = true;
            start = e.getLocalPosition(host);
            orig = { x: c.x, y: c.y };
        });
        c.on("globalpointermove", (e) => {
            if (!dragging) return;
            const p = e.getLocalPosition(host);
            c.x = orig.x + (p.x - start.x);
            c.y = orig.y + (p.y - start.y);
        });
        const end = async () => {
            if (!dragging) return;
            dragging = false;
            this.entry.x = c.x;
            this.entry.y = c.y;
            await updateSceneParchment(this.scene, this.entry.id, { x: c.x, y: c.y });
        };
        c.on("pointerup", end);
        c.on("pointerupoutside", end);
    }

    async _confirmRemove() {
        const confirm = await foundry.applications.api.DialogV2.confirm({
            window: { title: i18n("WOU.Parchment.Remove", "Remove Parchment") },
            content: `<p>${i18n("WOU.Parchment.ConfirmRemove", "Remove this parchment from the scene?")}</p>`,
            modal: true,
            rejectClose: false
        });
        if (confirm) emitRemoveSceneParchment({ sceneId: this.scene.id, entryId: this.entry.id });
    }

    async _adjustScale(delta) {
        const current = this.entry.scale ?? 1.0;
        const newScale = Math.max(0.4, Math.min(2.5, current + delta));
        await updateSceneParchment(this.scene, this.entry.id, { scale: newScale });
    }

    async _onSwipeToInventory() {
        const candidates = game.user.character
            ? [game.user.character]
            : game.actors.filter(a => a.isOwner && a.type === "character");

        if (candidates.length === 0) {
            ui.notifications.warn(i18n("WOU.Parchment.NoOwnedCharacter", "You don't own a character to swipe this into."));
            return;
        }

        let target = candidates[0];
        if (candidates.length > 1) {
            target = await this._promptCharacter(candidates);
            if (!target) return;
        }

        let source = null;
        try {
            if (this.entry.itemUuid) {
                const sourceItem = await fromUuid(this.entry.itemUuid);
                if (sourceItem) source = sourceItem.toObject();
            }
        } catch (e) { /* fall through to snapshot */ }

        const snapshot = this.entry.snapshot || {};
        const name = source?.name ?? snapshot.name ?? i18n("WOU.Parchment.UntitledTitle", "Untitled Parchment");
        const img = source?.img ?? snapshot.img ?? "icons/sundries/scrolls/scroll-bound-sealed-tan.webp";
        const sys = source?.system ?? snapshot;

        const itemData = {
            name,
            type: "note",
            img,
            system: {
                description: sys.description ?? "",
                quantity: Number(sys.quantity ?? 1),
                weight: Number(sys.weight ?? 0),
                cost: Number(sys.cost ?? 0)
            }
        };

        try {
            await target.createEmbeddedDocuments("Item", [itemData]);
            ui.notifications.info(game.i18n.format("WOU.Parchment.Swiped", { note: name, actor: target.name }));
            emitRemoveSceneParchment({ sceneId: this.scene.id, entryId: this.entry.id });
        } catch (err) {
            console.error(`${MODULE_ID} | failed to swipe parchment to ${target.name}:`, err);
            ui.notifications.error(`Parchments: ${err.message}`);
        }
    }

    async _promptCharacter(candidates) {
        const options = candidates.map(a =>
            `<option value="${a.id}">${escapeAttr(a.name)}</option>`
        ).join("");
        const content = `
            <p>${escapeText(i18n("WOU.Parchment.ChooseCharacter", "Choose which character takes the parchment:"))}</p>
            <select name="actor-id" style="width:100%;">${options}</select>
        `;
        return new Promise(resolve => {
            new foundry.applications.api.DialogV2({
                window: { title: i18n("WOU.Parchment.Swipe", "Swipe to Inventory") },
                content,
                buttons: [
                    {
                        action: "confirm",
                        label: i18n("WOU.Parchment.Swipe", "Swipe to Inventory"),
                        default: true,
                        callback: (event, button, dialog) => {
                            const id = dialog.element.querySelector('select[name="actor-id"]')?.value;
                            resolve(game.actors.get(id));
                        }
                    },
                    { action: "cancel", label: i18n("WOU.Parchment.Cancel", "Cancel"), callback: () => resolve(null) }
                ],
                rejectClose: false
            }).render(true);
        });
    }

    destroy() {
        this._destroyed = true;
        if (this.container) {
            try {
                if (this.container.parent) this.container.parent.removeChild(this.container);
                this.container.destroy({ children: true });
            } catch (e) { /* ignore */ }
            this.container = null;
        }
    }
}

/* ============================================================
   SCENE MANAGER
   ============================================================ */

class SceneParchmentManager {
    constructor() {
        this.renderers = new Map();
        this.spriteContainer = null;
        this.activeScene = null;
        /* Generation token guards the renderForScene self-race: a canvasReady
         * firing mid-render bumps the token so the stale pass stops. */
        this._renderGen = 0;
    }

    _ensureSpriteContainer() {
        if (!canvas?.stage) return;
        if (this.spriteContainer && this.spriteContainer.parent) {
            this.spriteContainer.parent.removeChild(this.spriteContainer);
        }
        if (!this.spriteContainer) {
            this.spriteContainer = new PIXI.Container();
            this.spriteContainer.name = SPRITE_NAME;
            this.spriteContainer.sortableChildren = false;
            this.spriteContainer.interactiveChildren = true;
            this.spriteContainer.eventMode = "passive";
        }
        // canvas.primary places us in scene space (pans/zooms natively).
        // PrimaryCanvasGroup orders children by elevation → sortLayer → sort.
        // Staying in the SCENE sort-layer keeps the posting behind tiles (500),
        // drawings (600) and tokens (700); a positive `sort` lifts it just
        // above the background image so it's visible rather than buried under
        // it. Result: pinned on the map, behind every other scene object, and
        // — being in the canvas at all — never over HTML UI like the dock.
        const target = canvas.primary || canvas.stage;
        if (target) {
            const sceneLayer = canvas.primary?.constructor?.SORT_LAYERS?.SCENE ?? 0;
            this.spriteContainer.elevation = 0;
            this.spriteContainer.sortLayer = sceneLayer;
            this.spriteContainer.sort = 100;
            // PrimaryCanvasGroup ships with eventMode "none", which prunes its
            // whole subtree from hit-testing — our posting included. Relax it
            // to "passive": the group itself stays a non-target (so it never
            // eats empty-canvas clicks / token deselects), but our interactive
            // children get hit-tested. The group is rebuilt on canvas draw, so
            // this re-applies every canvasReady.
            if (target === canvas.primary && target.eventMode === "none") {
                target.eventMode = "passive";
                target.interactiveChildren = true;
            }
            target.addChild(this.spriteContainer);
            try { target.sortChildren?.(); } catch (e) { /* ignore */ }
        }
    }

    async renderForScene(scene) {
        this.clear();
        const gen = ++this._renderGen;
        this.activeScene = scene;
        if (!scene || !canvas?.stage) return;
        this._ensureSpriteContainer();

        const entries = getSceneParchments(scene);
        for (const entry of entries) {
            if (gen !== this._renderGen) return;   // a newer pass superseded us
            await this._renderOne(entry, scene);
        }
    }

    async _renderOne(entry, scene) {
        const renderer = new ParchmentRenderer(entry, scene);
        const ok = await renderer.render();
        if (ok) this.renderers.set(entry.id, renderer);
    }

    refresh(scene) { this.renderForScene(scene); }

    clear() {
        for (const r of this.renderers.values()) r.destroy();
        this.renderers.clear();
        if (this.spriteContainer) this.spriteContainer.removeChildren();
    }
}

const sceneManager = new SceneParchmentManager();

/* ============================================================
   HELPERS
   ============================================================ */

/** Cheap deterministic string hash → 32-bit seed. */
function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Seeded PRNG so a note's stains stay put across re-renders. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function escapeAttr(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escapeText(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Flatten stored HTML description to plain multi-line text for PIXI.Text. */
function htmlToText(html) {
    let s = String(html ?? "");
    s = s.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
    const tmp = document.createElement("div");
    tmp.innerHTML = s;
    return (tmp.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function buildSnapshot(item) {
    return {
        name: item.name,
        img: item.img,
        description: item.system?.description ?? "",
        weight: item.system?.weight ?? 0,
        cost: item.system?.cost ?? 0,
        quantity: item.system?.quantity ?? 1
    };
}

/** A `note` item is postable to a scene as a parchment. */
function isPostableParchment(item) {
    return item?.type === "note";
}

/**
 * Pin a note as a notice-board posting on the given scene. Shared by the
 * dropCanvasData hook and the inventory "Drop on Scene" context entry.
 *
 * If the source note lives on an actor it is deleted after a successful
 * post (the player is "putting it back up on the board"); world-level notes
 * keep their uuid so editing the source updates the posting.
 */
async function postNoteToScene(scene, item, { x, y } = {}) {
    if (!scene || !item) return;
    const dropX = (x ?? (scene.dimensions?.width ?? 1000) / 2) - (NOTE_WIDTH / 2);
    const dropY = (y ?? (scene.dimensions?.height ?? 1000) / 2) - (NOTE_HEIGHT / 2);

    if (!game.user.isGM && !findActiveGM()) {
        ui.notifications.warn(i18n("WOU.Parchment.NoGMOnline", "Cannot post parchment — no GM is online."));
        return;
    }

    const entry = {
        id: foundry.utils.randomID(),
        itemUuid: item.parent ? null : item.uuid,
        snapshot: buildSnapshot(item),
        x: dropX,
        y: dropY,
        scale: 1.0
    };

    try {
        emitAddSceneParchment({ sceneId: scene.id, entry });
        ui.notifications.info(game.i18n.format("WOU.Parchment.Posted", { name: item.name }));
        if (item.parent && item.isOwner) {
            try { await item.delete(); }
            catch (err) { console.warn(`${MODULE_ID} | could not delete source note after post:`, err); }
        }
    } catch (err) {
        console.error(`${MODULE_ID} | failed to post parchment to scene:`, err);
        ui.notifications.error(`Parchments: ${err.message}`);
    }
}

/* ============================================================
   INSTALL / HOOKS
   ============================================================ */

let _installed = false;

export function installParchments() {
    if (_installed) return;
    _installed = true;

    if (canvas?.ready && canvas.scene) sceneManager.renderForScene(canvas.scene);

    Hooks.on("canvasReady", (cv) => {
        // Drop any stale sprite container left on the old stage.
        if (cv?.stage?.children) {
            for (const child of [...cv.stage.children]) {
                if (child?.name === SPRITE_NAME) {
                    try { child.parent?.removeChild(child); child.destroy({ children: true }); }
                    catch (e) { /* ignore */ }
                }
            }
        }
        sceneManager.spriteContainer = null;
        sceneManager.renderForScene(cv.scene);
    });

    Hooks.on("canvasTearDown", () => {
        sceneManager.clear();
        sceneManager.spriteContainer = null;
    });

    Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas?.scene?.id) return;
        if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${SCENE_FLAG}`)) {
            sceneManager.refresh(scene);
        }
    });

    // Drag a note from the sidebar / sheet straight onto the canvas → post.
    Hooks.on("dropCanvasData", (canvasInst, data) => {
        if (data?.type !== "Item") return true;
        let item = null;
        try { if (data.uuid) item = fromUuidSync(data.uuid); }
        catch (e) { /* ignore */ }
        if (!item && data.id) item = game.items.get(data.id);

        if (!item && data.uuid?.startsWith("Compendium.")) {
            (async () => {
                const resolved = await fromUuid(data.uuid);
                if (resolved && isPostableParchment(resolved)) {
                    await postNoteToScene(canvasInst.scene, resolved, { x: data.x, y: data.y });
                }
            })();
            return false;
        }

        if (!item || !isPostableParchment(item)) return true;
        postNoteToScene(canvasInst.scene, item, { x: data.x, y: data.y });
        return false;
    });

    // Keep a world-level note's posting snapshot in sync when its source edits.
    Hooks.on("updateItem", async (item, changes, options, userId) => {
        if (item.type !== "note") return;
        if (game.userId !== userId || !game.user.isGM) return;
        const scene = canvas?.scene;
        if (!scene) return;
        const entries = getSceneParchments(scene);
        if (!entries.some(n => n.itemUuid === item.uuid)) return;
        const updated = entries.map(n =>
            n.itemUuid === item.uuid ? { ...n, snapshot: buildSnapshot(item) } : n
        );
        await scene.setFlag(MODULE_ID, SCENE_FLAG, updated);
    });
}

export {
    sceneManager,
    getSceneParchments,
    postNoteToScene
};
