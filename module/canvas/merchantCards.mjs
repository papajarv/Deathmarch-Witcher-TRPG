/**
 * Merchant scene cards — a shop portrait dropped onto the canvas.
 *
 * Two synced layers, because weather/lighting must render OVER the card while
 * its buttons stay clickable:
 *   - VISUAL: a PIXI container on canvas.primary (below canvas.effects), so the
 *     weather/darkness shaders draw on top of it like any token.
 *   - INTERACTION: an HTML overlay pinned to the canvas viewport and synced to
 *     pan/zoom each animation frame. Carries the Browse button + GM controls;
 *     pure-PIXI hit-testing on a primary-group child is unreliable, hence HTML.
 *
 * Cards are authored data: a per-scene flag array. The GM drops a merchant
 * actor on the canvas to place one; players click "Browse shop" to open the
 * buy window (openMerchantShop). Merchant actors never spawn tokens.
 *
 * Rewritten from witcher-merchant-system scene-cards.js for this system: net
 * layer (openMerchantShop), pricing.mjs prices, --wdm styling, i18n.
 */

import { openMerchantShop } from "../sheets/actor/buy.mjs";
import { snapshotUnitPrice, rarityOf } from "../merchant/pricing.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const SCENE_FLAG = "merchantCards";

const CARD_WIDTH = 224;
const PORTRAIT_SIZE = 200;
const FRAME_PAD = 8;
const PORTRAIT_X = (CARD_WIDTH - PORTRAIT_SIZE) / 2;   // 12
const PORTRAIT_Y = FRAME_PAD;                          // 8
const NAMEPLATE_H = 32;
const BROWSE_Y = PORTRAIT_Y + PORTRAIT_SIZE + 12;      // 220
const BROWSE_BAND_H = 22;
const SLOT_SIZE = 44;
const ROW_Y = BROWSE_Y + 26;                           // 246
const CARD_HEIGHT = ROW_Y + SLOT_SIZE + FRAME_PAD;     // 298
const FEATURED_SLOTS = 4;
const ROTATION_MS = 30000;

/* Theme palette — PIXI hex mirror of the --wdm-* design tokens (tokens.css). */
const C = {
    plate:       0x0a0908,   /* --wdm-bg        */
    plateDeep:   0x050402,   /* --wdm-void / --wdm-bg-deep */
    bgLifted:    0x14110d,   /* --wdm-bg-lifted */
    rule:        0x8c8579,   /* inventory slot hairline (rgba 140,133,121) */
    amberDim:    0x6e5224,   /* --wdm-amber-dim    */
    amber:       0xa88450,   /* --wdm-amber        */
    amberHi:     0xb89464,   /* --wdm-amber-hi     */
    amberBright: 0xc8a878,   /* --wdm-amber-bright */
    ink:         0xb0a994,   /* --wdm-ink    */
    inkHi:       0xcac4b0    /* --wdm-ink-hi */
};
const DISPLAY_FONT = "'PF DIN Text Cond Pro', 'Barlow Condensed', sans-serif";

/* Availability tiers → wash colour (mirror of --wdm-rarity-* in tokens.css).
   "everywhere"/"na" have no tier and keep the plain slot background. */
const RARITY_HEX = {
    common:  0x8a857b,
    poor:    0x6a4f8c,
    rare:    0xb06b44,
    witcher: 0xa04040
};
const ICON_RATIO = 0.92;   /* icon-to-box ratio, matches .wou-slot .icon { width: 92% } */

function lerpColor(a, b, t) {
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    return (Math.round(ar + (br - ar) * t) << 16)
         | (Math.round(ag + (bg - ag) * t) << 8)
         |  Math.round(ab + (bb - ab) * t);
}

/** Paint an inventory-style slot background: a bg-lifted→bg-deep base gradient
 *  with the availability tier colour fading in over the lower ~70%, drawn as
 *  1px rows (PIXI Graphics has no native gradient). Clipped by a rounded mask
 *  in the caller. */
function drawSlotBackground(g, x, y, size, rarity) {
    const tier = RARITY_HEX[rarity];
    for (let i = 0; i < size; i++) {
        const t = i / (size - 1);
        g.beginFill(lerpColor(C.bgLifted, C.plateDeep, t), 1).drawRect(x, y + i, size, 1).endFill();
        if (tier == null || t < 0.30) continue;
        // alpha ramp mirrors the CSS stops: 0 @30%, .30 @62%, .85 @100%.
        const a = t < 0.62
            ? 0.30 * (t - 0.30) / 0.32
            : 0.30 + 0.55 * (t - 0.62) / 0.38;
        g.beginFill(tier, a).drawRect(x, y + i, size, 1).endFill();
    }
}

/* ── Scene-flag accessors ─────────────────────────────────────────────── */

const getSceneCards = (scene) => scene?.getFlag(SYSTEM_ID, SCENE_FLAG) ?? [];

async function addSceneCard(scene, card) {
    await scene.setFlag(SYSTEM_ID, SCENE_FLAG, [...getSceneCards(scene), card]);
}
async function updateSceneCard(scene, cardId, patch) {
    const cards = foundry.utils.duplicate(getSceneCards(scene));
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    Object.assign(card, patch);
    await scene.setFlag(SYSTEM_ID, SCENE_FLAG, cards);
}
async function removeSceneCard(scene, cardId) {
    await scene.setFlag(SYSTEM_ID, SCENE_FLAG, getSceneCards(scene).filter(c => c.id !== cardId));
}

/* ── Featured-item selection ──────────────────────────────────────────── */

const RARITY_SCORE = { witcher: 100, rare: 60, poor: 30, common: 15, everywhere: 5 };

/** Up to four items to show on the card: pinned first, then weighted-random. */
function computeFeaturedItems(merchant) {
    const items = Array.from(merchant.items).filter(i => (Number(i.system.quantity) || 0) > 0);
    if (!items.length) return [];

    const priceOf = (item) => snapshotUnitPrice(merchant, item);
    const scored = items.map((item, idx) => ({
        item,
        price: priceOf(item),
        rarity: rarityOf(item),
        score: (RARITY_SCORE[rarityOf(item)] ?? 5) + priceOf(item) * 0.5 + (items.length - idx) * 0.3
    }));

    const result = [];
    const used = new Set();
    for (const id of merchant.system.featuredPinned ?? []) {
        if (result.length >= FEATURED_SLOTS) break;
        const hit = scored.find(s => s.item.id === id);
        if (!hit) continue;
        result.push({ name: hit.item.name, img: hit.item.img, price: hit.price, rarity: hit.rarity });
        used.add(id);
    }

    const pool = scored.filter(s => !used.has(s.item.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, FEATURED_SLOTS * 3);
    while (result.length < FEATURED_SLOTS && pool.length) {
        const pick = pool.splice(Math.floor(Math.random() * Math.min(pool.length, FEATURED_SLOTS)), 1)[0];
        result.push({ name: pick.item.name, img: pick.item.img, price: pick.price, rarity: pick.rarity });
    }
    return result;
}

/* ── PIXI visual ──────────────────────────────────────────────────────── */

const _textureCache = new Map();
async function loadTexture(src) {
    if (!src) return null;
    if (_textureCache.has(src)) return _textureCache.get(src);
    try {
        const tex = await PIXI.Assets.load(src);
        _textureCache.set(src, tex);
        return tex;
    } catch (_) {
        try { const tex = PIXI.Texture.from(src); _textureCache.set(src, tex); return tex; }
        catch (_e) { return null; }
    }
}

/** Build the card visual: framed plate, portrait + nameplate, browse band, item row. */
async function buildCardContainer(merchant, featured, opacity = 0.9) {
    const root = new PIXI.Container();
    root.eventMode = "none";
    root.interactiveChildren = false;
    root.alpha = opacity;

    // Backing plate — warm-dark with a brass double frame (outer 2px + inner hairline).
    const plate = new PIXI.Graphics();
    plate.beginFill(C.plate, 0.94)
        .lineStyle({ width: 2, color: C.amberHi, alpha: 0.85 })
        .drawRoundedRect(1, 1, CARD_WIDTH - 2, CARD_HEIGHT - 2, 8)
        .endFill();
    plate.lineStyle({ width: 1, color: C.amberDim, alpha: 0.55 })
        .drawRoundedRect(4, 4, CARD_WIDTH - 8, CARD_HEIGHT - 8, 6);
    root.addChild(plate);

    // Portrait (masked to a rounded box inset within the frame).
    const tex = await loadTexture(merchant.img || "icons/svg/mystery-man.svg");
    if (tex) {
        const sprite = new PIXI.Sprite(tex);
        const scale = Math.max(PORTRAIT_SIZE / tex.width, PORTRAIT_SIZE / tex.height);
        sprite.width = tex.width * scale;
        sprite.height = tex.height * scale;
        sprite.x = PORTRAIT_X + (PORTRAIT_SIZE - sprite.width) / 2;
        sprite.y = PORTRAIT_Y + (PORTRAIT_SIZE - sprite.height) / 2;
        sprite.eventMode = "none";

        const mask = new PIXI.Graphics();
        mask.beginFill(0xffffff).drawRoundedRect(PORTRAIT_X, PORTRAIT_Y, PORTRAIT_SIZE, PORTRAIT_SIZE, 5).endFill();
        root.addChild(mask);
        sprite.mask = mask;
        root.addChild(sprite);
    }

    // Nameplate — gradient scrim fading into the portrait foot, shop name in caps.
    const nameTop = PORTRAIT_Y + PORTRAIT_SIZE - NAMEPLATE_H;
    const scrim = new PIXI.Graphics();
    for (let i = 0; i < NAMEPLATE_H; i++) {
        scrim.beginFill(C.plateDeep, 0.88 * (i / NAMEPLATE_H))
            .drawRect(PORTRAIT_X, nameTop + i, PORTRAIT_SIZE, 1).endFill();
    }
    root.addChild(scrim);

    const shopName = String(merchant.system?.shopName || merchant.name || "").toUpperCase();
    const nameText = new PIXI.Text(shopName, {
        fontFamily: DISPLAY_FONT, fontSize: 16, fontWeight: "700",
        fill: C.inkHi, letterSpacing: 1.5, align: "center",
        wordWrap: true, wordWrapWidth: PORTRAIT_SIZE - 14,
        dropShadow: true, dropShadowColor: 0x000000, dropShadowBlur: 4, dropShadowDistance: 1
    });
    nameText.x = PORTRAIT_X + (PORTRAIT_SIZE - nameText.width) / 2;
    nameText.y = PORTRAIT_Y + PORTRAIT_SIZE - nameText.height - 6;
    root.addChild(nameText);

    // Brass frame over the portrait foot.
    const pBorder = new PIXI.Graphics();
    pBorder.lineStyle({ width: 1, color: C.amber, alpha: 0.7 })
        .drawRoundedRect(PORTRAIT_X, PORTRAIT_Y, PORTRAIT_SIZE, PORTRAIT_SIZE, 5);
    root.addChild(pBorder);

    // Browse band — a framed plate behind the PIXI label so it reads as a control.
    const browse = new PIXI.Text(game.i18n.localize("WITCHER.Merchant.BrowseShop").toUpperCase(), {
        fontFamily: DISPLAY_FONT, fontSize: 13, fontWeight: "700",
        fill: C.amberBright, letterSpacing: 3,
        dropShadow: true, dropShadowColor: 0x000000, dropShadowBlur: 3, dropShadowDistance: 1
    });
    const bandW = Math.max(browse.width + 28, 140);
    const bandX = (CARD_WIDTH - bandW) / 2;
    const band = new PIXI.Graphics();
    band.beginFill(C.plateDeep, 0.6)
        .lineStyle({ width: 1, color: C.amber, alpha: 0.6 })
        .drawRoundedRect(bandX, BROWSE_Y, bandW, BROWSE_BAND_H, 3).endFill();
    root.addChild(band);
    browse.x = (CARD_WIDTH - browse.width) / 2;
    browse.y = BROWSE_Y + (BROWSE_BAND_H - browse.height) / 2;
    root.addChild(browse);

    // Featured-item row — warm-dark slots, brass hairline, amber price tag.
    const gap = 6;
    const rowW = FEATURED_SLOTS * SLOT_SIZE + (FEATURED_SLOTS - 1) * gap;
    const startX = (CARD_WIDTH - rowW) / 2;
    for (let i = 0; i < featured.length; i++) {
        const item = featured[i];
        const x = startX + i * (SLOT_SIZE + gap);

        // Availability wash (inventory .wou-slot[data-rarity]), clipped to a rounded box.
        const slotBg = new PIXI.Graphics();
        drawSlotBackground(slotBg, x, ROW_Y, SLOT_SIZE, item.rarity);
        const slotMask = new PIXI.Graphics();
        slotMask.beginFill(0xffffff).drawRoundedRect(x, ROW_Y, SLOT_SIZE, SLOT_SIZE, 3).endFill();
        root.addChild(slotMask);
        slotBg.mask = slotMask;
        root.addChild(slotBg);

        // Slot frame + inner hairline (matches the inventory slot border treatment).
        const slotFrame = new PIXI.Graphics();
        slotFrame.lineStyle({ width: 1, color: C.rule, alpha: 0.22 })
            .drawRoundedRect(x, ROW_Y, SLOT_SIZE, SLOT_SIZE, 3);
        slotFrame.lineStyle({ width: 1, color: C.rule, alpha: 0.08 })
            .drawRoundedRect(x + 2, ROW_Y + 2, SLOT_SIZE - 4, SLOT_SIZE - 4, 2);
        root.addChild(slotFrame);

        const itemTex = await loadTexture(item.img);
        if (itemTex) {
            // object-fit: contain at 92% of the box (matches .wou-slot .icon).
            const s = new PIXI.Sprite(itemTex);
            const box = SLOT_SIZE * ICON_RATIO;
            const sc = Math.min(box / itemTex.width, box / itemTex.height);
            s.width = itemTex.width * sc;
            s.height = itemTex.height * sc;
            s.x = x + (SLOT_SIZE - s.width) / 2;
            s.y = ROW_Y + (SLOT_SIZE - s.height) / 2;
            s.eventMode = "none";
            root.addChild(s);
        }

        const priceBg = new PIXI.Graphics();
        priceBg.beginFill(C.plateDeep, 0.85).drawRect(x, ROW_Y + SLOT_SIZE - 12, SLOT_SIZE, 12).endFill();
        root.addChild(priceBg);

        const price = new PIXI.Text(String(item.price), {
            fontFamily: DISPLAY_FONT, fontSize: 9, fontWeight: "700", fill: C.amberBright
        });
        price.x = x + SLOT_SIZE - price.width - 3;
        price.y = ROW_Y + SLOT_SIZE - 11;
        root.addChild(price);
    }

    return root;
}

/* ── One card: PIXI sprite + HTML overlay + rotation timer ────────────── */

class MerchantCardRenderer {
    constructor(cardData, scene) {
        this.cardData = cardData;
        this.scene = scene;
        this.merchant = game.actors.get(cardData.merchantId);
        this.sprite = null;
        this.overlay = null;
        this._timer = null;
        this._dragCleanup = null;
        this._destroyed = false;
    }

    async render() {
        if (!this.merchant) return false;
        await this._buildSprite();
        this._buildOverlay();
        this._timer = setInterval(() => this._refreshSprite(), ROTATION_MS);
        return true;
    }

    get _opacity() { return this.merchant.system.portraitCardSettings?.cardOpacity ?? 0.9; }

    async _buildSprite() {
        if (this._destroyed) return;
        const container = await buildCardContainer(this.merchant, computeFeaturedItems(this.merchant), this._opacity);
        if (!container || this._destroyed) return;
        container.x = this.cardData.x;
        container.y = this.cardData.y;
        container.scale.set(this.cardData.scale ?? 1);
        container.eventMode = "none";
        container.interactiveChildren = false;
        this.sprite = container;
        manager.spriteContainer?.addChild(this.sprite);
    }

    async _refreshSprite() {
        if (this._destroyed || !this.sprite) return;
        const next = await buildCardContainer(this.merchant, computeFeaturedItems(this.merchant), this._opacity);
        if (!next || this._destroyed) return;
        next.x = this.cardData.x;
        next.y = this.cardData.y;
        next.scale.set(this.cardData.scale ?? 1);
        next.eventMode = "none";
        next.interactiveChildren = false;
        const parent = this.sprite.parent;
        parent?.addChild(next);
        parent?.removeChild(this.sprite);
        try { this.sprite.destroy({ children: true }); } catch (_) {}
        this.sprite = next;
    }

    _buildOverlay() {
        const host = manager.overlayHost;
        if (!host) return;
        const isGM = game.user.isGM;
        const el = document.createElement("div");
        el.className = "wdm-card-overlay";
        el.dataset.cardId = this.cardData.id;
        el.innerHTML = `
            <div class="wdm-card-drag"></div>
            <button type="button" class="wdm-card-browse" data-action="browse">
                <i class="fas fa-shop"></i> ${game.i18n.localize("WITCHER.Merchant.BrowseShop")}
            </button>
            ${isGM ? `
                <div class="wdm-card-gm">
                    <button type="button" class="wdm-card-gm-btn" data-action="scale-down" title="−">−</button>
                    <button type="button" class="wdm-card-gm-btn" data-action="scale-up" title="+">+</button>
                    <button type="button" class="wdm-card-gm-btn" data-action="remove" title="×">×</button>
                </div>` : ""}`;
        host.appendChild(el);
        this.overlay = el;
        this._positionOverlay();
        this._wireOverlay();
    }

    _positionOverlay() {
        if (!this.overlay || !canvas?.stage) return;
        const global = canvas.stage.toGlobal(new PIXI.Point(this.cardData.x, this.cardData.y));
        const board = document.getElementById("board");
        const rect = board ? board.getBoundingClientRect() : { left: 0, top: 0 };
        const total = canvas.stage.scale.x * (this.cardData.scale ?? 1);
        const s = this.overlay.style;
        s.left = `${global.x + rect.left}px`;
        s.top = `${global.y + rect.top}px`;
        s.width = `${CARD_WIDTH * total}px`;
        s.height = `${CARD_HEIGHT * total}px`;
        s.setProperty("--card-scale", total);
    }

    _wireOverlay() {
        const el = this.overlay;
        if (!el) return;
        el.querySelector('[data-action="browse"]')?.addEventListener("click", (e) => {
            e.stopPropagation();
            openMerchantShop(this.merchant);
        });
        if (!game.user.isGM) return;
        el.querySelector('[data-action="scale-up"]')?.addEventListener("click", (e) => { e.stopPropagation(); this._scaleBy(0.1); });
        el.querySelector('[data-action="scale-down"]')?.addEventListener("click", (e) => { e.stopPropagation(); this._scaleBy(-0.1); });
        el.querySelector('[data-action="remove"]')?.addEventListener("click", async (e) => {
            e.stopPropagation();
            const ok = await foundry.applications.api.DialogV2.confirm({
                window: { title: game.i18n.localize("WITCHER.Merchant.RemoveCard") },
                content: `<p>${game.i18n.localize("WITCHER.Merchant.RemoveCardConfirm")}</p>`,
                modal: true, rejectClose: false
            });
            if (ok) await removeSceneCard(this.scene, this.cardData.id);
        });
        this._enableDragging();
    }

    _enableDragging() {
        const area = this.overlay?.querySelector(".wdm-card-drag");
        if (!area) return;
        let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
        const onDown = (e) => {
            if (e.button !== 0 || e.target.closest("button")) return;
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            origX = this.cardData.x; origY = this.cardData.y;
            this.overlay.classList.add("is-dragging");
            e.preventDefault(); e.stopPropagation();
        };
        const onMove = (e) => {
            if (!dragging) return;
            const s = canvas.stage.scale.x;
            this.cardData.x = origX + (e.clientX - startX) / s;
            this.cardData.y = origY + (e.clientY - startY) / s;
            if (this.sprite) { this.sprite.x = this.cardData.x; this.sprite.y = this.cardData.y; }
            this._positionOverlay();
        };
        const onUp = async () => {
            if (!dragging) return;
            dragging = false;
            this.overlay.classList.remove("is-dragging");
            await updateSceneCard(this.scene, this.cardData.id, { x: this.cardData.x, y: this.cardData.y });
        };
        area.addEventListener("mousedown", onDown);
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        this._dragCleanup = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
    }

    async _scaleBy(delta) {
        const next = Math.max(0.4, Math.min(2, (this.cardData.scale ?? 1) + delta));
        await updateSceneCard(this.scene, this.cardData.id, { scale: next });
    }

    onCanvasPan() { this._positionOverlay(); }

    destroy() {
        this._destroyed = true;
        if (this._timer) clearInterval(this._timer);
        this._dragCleanup?.();
        if (this.sprite) {
            try { this.sprite.parent?.removeChild(this.sprite); this.sprite.destroy({ children: true }); } catch (_) {}
            this.sprite = null;
        }
        this.overlay?.remove();
        this.overlay = null;
    }
}

/* ── Scene manager ────────────────────────────────────────────────────── */

class SceneCardManager {
    constructor() {
        this.renderers = new Map();
        this.overlayHost = null;
        this.spriteContainer = null;
        this._rafId = null;
        this._rafActive = false;
    }

    init() {
        if (this.overlayHost) return;
        this.overlayHost = document.createElement("div");
        this.overlayHost.id = "wdm-merchant-cards-host";
        const parent = document.getElementById("board")?.parentElement
            || document.getElementById("interface") || document.body;
        parent.appendChild(this.overlayHost);
    }

    _ensureSpriteContainer() {
        if (!canvas?.stage) return;
        if (this.spriteContainer?.parent) this.spriteContainer.parent.removeChild(this.spriteContainer);
        if (!this.spriteContainer) {
            this.spriteContainer = new PIXI.Container();
            this.spriteContainer.name = "wdm-merchant-cards";
            this.spriteContainer.eventMode = "none";
            this.spriteContainer.interactiveChildren = false;
        }
        (canvas.primary || canvas.stage)?.addChild(this.spriteContainer);
    }

    _startSync() {
        if (this._rafActive) return;
        this._rafActive = true;
        const tick = () => {
            if (!this._rafActive) return;
            for (const r of this.renderers.values()) { try { r.onCanvasPan(); } catch (_) {} }
            this._rafId = requestAnimationFrame(tick);
        };
        this._rafId = requestAnimationFrame(tick);
    }

    _stopSync() {
        this._rafActive = false;
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = null;
    }

    async renderForScene(scene) {
        this.clear();
        if (!scene || !canvas?.stage) return;
        if (!this.overlayHost) this.init();
        this._ensureSpriteContainer();
        this._startSync();
        for (const card of getSceneCards(scene)) {
            const renderer = new MerchantCardRenderer(card, scene);
            if (await renderer.render()) this.renderers.set(card.id, renderer);
        }
    }

    refresh(scene) { this.renderForScene(scene); }

    clear() {
        for (const r of this.renderers.values()) r.destroy();
        this.renderers.clear();
        this.spriteContainer?.removeChildren();
        if (this.overlayHost) while (this.overlayHost.firstChild) this.overlayHost.removeChild(this.overlayHost.firstChild);
        this._stopSync();
    }
}

const manager = new SceneCardManager();

/* ── Debounced refresh ────────────────────────────────────────────────── */

const _debouncers = new Map();
function scheduleRefresh(scene, delay = 120) {
    if (!scene) return;
    clearTimeout(_debouncers.get(scene.id));
    _debouncers.set(scene.id, setTimeout(() => {
        _debouncers.delete(scene.id);
        manager.refresh(scene);
    }, delay));
}

const cardRelevant = (changes) =>
    foundry.utils.hasProperty(changes, "img") ||
    foundry.utils.hasProperty(changes, "name") ||
    foundry.utils.hasProperty(changes, "system.shopName") ||
    foundry.utils.hasProperty(changes, "system.featuredPinned") ||
    foundry.utils.hasProperty(changes, "system.portraitCardSettings");

/* ── Registration ─────────────────────────────────────────────────────── */

export function registerMerchantCards() {
    Hooks.once("ready", () => {
        manager.init();
        if (canvas?.ready && canvas.scene) manager.renderForScene(canvas.scene);
    });

    Hooks.on("canvasReady", (cv) => {
        for (const child of [...(cv?.stage?.children ?? []), ...(cv?.interface?.children ?? [])]) {
            if (child?.name === "wdm-merchant-cards") {
                try { child.parent?.removeChild(child); child.destroy({ children: true }); } catch (_) {}
            }
        }
        manager.spriteContainer = null;
        manager.renderForScene(cv.scene);
    });

    Hooks.on("canvasTearDown", () => {
        manager.clear();
        manager.spriteContainer = null;
    });

    Hooks.on("updateScene", (scene, changes) => {
        if (scene.id !== canvas?.scene?.id) return;
        if (foundry.utils.hasProperty(changes, `flags.${SYSTEM_ID}.${SCENE_FLAG}`)) scheduleRefresh(scene);
    });

    Hooks.on("updateActor", (actor, changes) => {
        if (actor.type === "merchant" && cardRelevant(changes) && canvas?.scene) scheduleRefresh(canvas.scene);
    });
    Hooks.on("createItem", (item) => { if (item.parent?.type === "merchant" && canvas?.scene) scheduleRefresh(canvas.scene); });
    Hooks.on("deleteItem", (item) => { if (item.parent?.type === "merchant" && canvas?.scene) scheduleRefresh(canvas.scene); });

    // GM drops a merchant actor on the canvas → place a card (no token).
    Hooks.on("dropCanvasData", (cv, data) => {
        if (data.type !== "Actor") return true;
        const actor = game.actors.get(data.id) || (data.uuid ? fromUuidSync(data.uuid) : null);
        if (actor?.type !== "merchant") return true;
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize("WITCHER.Merchant.GMOnlyCard"));
            return false;
        }
        addSceneCard(cv.scene, {
            id: foundry.utils.randomID(),
            merchantId: actor.id,
            x: (data.x ?? 100) - CARD_WIDTH / 2,
            y: (data.y ?? 100) - CARD_HEIGHT / 2,
            scale: actor.system.portraitCardSettings?.cardScale ?? 1
        });
        ui.notifications.info(game.i18n.format("WITCHER.Merchant.CardPlaced", { name: actor.name }));
        return false;
    });

    // Merchant actors are shops, not combatants — never let them spawn tokens.
    Hooks.on("preCreateToken", (tokenDoc) => {
        if (game.actors.get(tokenDoc.actorId)?.type === "merchant") return false;
        return true;
    });
}
