/**
 * terrainPaintLayer.mjs — GM canvas tool for painting terrain onto a scene's
 * grid cells and dropping a party marker.
 *
 * The painted cells + marker are AUTHORED data (a scene flag, schema in
 * weather-map.mjs), never generated weather. The weather engine reads them to
 * make weather a pure function of (time, PLACE): the marker's cell sets the
 * party's terrain/biome/latitude. This tool edits the CURRENTLY VIEWED scene;
 * the engine consumes whichever scene the GM designates as the weather map
 * (the `weatherMapScene` setting — set from the Weather & Calendar panel).
 *
 * v14 wiring: the layer is registered in CONFIG.Canvas.layers (group
 * "interface"); SceneControls auto-collects its tools from the static
 * prepareSceneControls() hook — no getSceneControlButtons hook needed. The
 * control key, the CONFIG.Canvas.layers key and layerOptions.name all match
 * ("witcherTerrain") so the control's onChange can `canvas.witcherTerrain.activate()`.
 *
 * Foundry's setFlag deep-MERGES (can add a cell but never erase one), so the
 * layer holds the whole map in memory and flushes it wholesale through
 * weather-map.mjs#writeWeatherMap (a ForcedReplacement) on click / drag-end.
 */

import { getActiveTerrain } from "../mechanics/terrain.mjs";
import { getWeatherMap, writeWeatherMap, clearMap as clearWeatherMapFlag } from "../mechanics/weather-map.mjs";

const { InteractionLayer } = foundry.canvas.layers;

const SYSTEM_ID = "witcher-ttrpg-death-march";
const LAYER_NAME = "witcherTerrain";
const MARKER_TOOL = "marker";
const ERASE_TOOL = "erase";
const CLEAR_TOOL = "clear";

const FILL_ALPHA = 0.45;          // painted cell fill (overlay shows only while the tool is open)
const MARKER_COLOR = 0xffd34d;    // party-marker highlight (gold)
const GRID_OUTLINE_COLOR = 0xffffff;
const MAX_GRID_OUTLINE = 4000;    // skip the full-grid outline on huge scenes

const ICON_SCALE = 0.4;           // biome glyph size as a fraction of the cell (small, subtle)
const ICON_ALPHA = 0.6;           // glyph opacity — a faint, colour-matched hint

const cellKey = (i, j) => `${i},${j}`;
function hexToNum(c) {
    const n = parseInt(String(c ?? "").replace(/^#/, ""), 16);
    return Number.isFinite(n) ? n : 0x888888;
}

/* FontAwesome class → a renderable glyph. Reads the ::before content + font the
 * loaded FA stylesheet resolves, so we never hardcode codepoints and we track
 * whichever FA build Foundry ships. Only successful lookups are cached (a miss
 * before fonts are ready can retry on the next redraw). */
const _glyphCache = new Map();
function faGlyph(iconClass) {
    if (!iconClass) return null;
    if (_glyphCache.has(iconClass)) return _glyphCache.get(iconClass);
    let glyph = null;
    try {
        const probe = document.createElement("i");
        probe.className = iconClass;
        probe.setAttribute("aria-hidden", "true");
        Object.assign(probe.style, { position: "absolute", left: "-9999px", top: "-9999px", visibility: "hidden" });
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe, "::before");
        // FA6 may append alt-text: content: "\f6fc" / "mountain". Take only the
        // first quoted run (the glyph) and drop the "/ label" remainder.
        const raw = String(cs?.content ?? "");
        const quoted = raw.match(/(["'])((?:\\.|[^\\])*?)\1/);
        const char = quoted ? quoted[2] : "";
        const family = cs?.fontFamily || "";
        const weight = cs?.fontWeight || "900";
        probe.remove();
        if (char && family) {
            glyph = { char, family, weight };
            _glyphCache.set(iconClass, glyph);
        }
    } catch (_) { glyph = null; }
    return glyph;
}

export class TerrainPaintLayer extends InteractionLayer {

    /** In-memory working copy of the scene's painted map (flushed on edit). */
    cells = {};
    marker = null;
    biome = null;
    /** Live terrain catalog (key → {color,…}); refreshed on each draw. */
    _terrain = {};
    /** True between drag-start and drag-drop, so external redraws don't clobber a stroke. */
    _painting = false;
    /** When a drag begins with Shift held, the whole stroke erases (not just one cell). */
    _eraseStroke = false;

    /** @inheritDoc */
    static get layerOptions() {
        return foundry.utils.mergeObject(super.layerOptions, {
            name: LAYER_NAME,
            zIndex: 75
        });
    }

    /* ─────────── scene controls (v14 auto-collected) ───────────────────────── */

    /** @override */
    static prepareSceneControls() {
        if (!game.user?.isGM) return null;
        const terrain = getActiveTerrain();

        const tools = {};
        let order = 0;
        for (const [key, t] of Object.entries(terrain)) {
            tools[key] = {
                name: key,
                order: order++,
                title: t.label || `WITCHER.Weather.Terrain.${key}`,
                icon: t.icon || "fa-solid fa-brush"
            };
        }
        tools[MARKER_TOOL] = {
            name: MARKER_TOOL,
            order: order++,
            title: "WITCHER.Weather.Map.Marker",
            icon: "fa-solid fa-location-dot"
        };
        tools[ERASE_TOOL] = {
            name: ERASE_TOOL,
            order: order++,
            title: "WITCHER.Weather.Map.Erase",
            icon: "fa-solid fa-eraser"
        };
        tools[CLEAR_TOOL] = {
            name: CLEAR_TOOL,
            order: order++,
            title: "WITCHER.Weather.Map.Clear",
            icon: "fa-solid fa-trash",
            button: true,
            onChange: () => canvas?.[LAYER_NAME]?.clearMap()
        };

        return {
            name: LAYER_NAME,
            title: "WITCHER.Weather.Map.Controls",
            icon: "fa-solid fa-earth-europe",
            layer: LAYER_NAME,
            visible: true,
            activeTool: Object.keys(terrain)[0] ?? ERASE_TOOL,
            onChange: (_event, active) => { if (active) canvas?.[LAYER_NAME]?.activate(); },
            tools
        };
    }

    /* ─────────── rendering ─────────────────────────────────────────────────── */

    /** @override */
    async _draw(_options) {
        this.overlay = this.addChild(new PIXI.Graphics());
        this.iconLayer = this.addChild(new PIXI.Container());
        this.iconLayer.eventMode = "none";          // glyphs never intercept painting
        this.iconLayer.interactiveChildren = false;
        this._loadModel();
        this._refresh();
    }

    /** @override */
    async _tearDown(options) {
        // super.removeChildren() detaches but does NOT destroy, so the icon Texts'
        // texture slabs would leak. Destroy ours explicitly first.
        this._clearIcons();
        this.iconLayer?.destroy({ children: true });
        this.overlay?.destroy();
        this.overlay = null;
        this.iconLayer = null;
        return super._tearDown(options);
    }

    /** @override */
    _activate() { this._refresh(); }

    /** @override */
    _deactivate() { this._refresh(); }

    /** Pull the working model from the viewed scene's flag. */
    _loadModel() {
        const scene = canvas?.scene;
        const map = getWeatherMap(scene);
        this.cells = foundry.utils.deepClone(map.cells) ?? {};
        this.marker = map.marker ? { ...map.marker } : null;
        this.biome = map.biome ?? null;
        this._terrain = getActiveTerrain();
    }

    /**
     * Redraw the overlay from the in-memory model. The painted map is an EDITING
     * aid: it renders only for the GM and only while the Weather Map tool is open
     * (`this.active`). Otherwise the overlay clears — players never see it and it
     * doesn't clutter the GM's normal scene view. Weather still applies from the
     * stored flag regardless; only the visualization is hidden.
     */
    _refresh() {
        const g = this.overlay;
        const scene = canvas?.scene;
        if (!g || !scene || this._isGridless() || !this.active || !game.user?.isGM) {
            g?.clear();
            this._clearIcons();
            return;
        }
        const grid = scene.grid;
        g.clear();
        this._clearIcons();

        // Faint full-grid outline so the paintable cells are visible.
        this._drawGridOutline(g, grid, scene);

        // Painted cells: colour fill + the biome's icon (shape, not colour alone,
        // so terrains stay distinguishable for colour-blind GMs).
        for (const [key, cell] of Object.entries(this.cells)) {
            const [i, j] = key.split(",").map(Number);
            if (!Number.isFinite(i) || !Number.isFinite(j)) continue;
            const t = this._terrain[cell?.terrain];
            const color = hexToNum(t?.color);
            this._fillCell(g, grid, i, j, color, FILL_ALPHA);
            if (t?.icon) this._drawCellIcon(grid, i, j, t.icon, color);
        }

        // Party marker.
        if (this.marker) this._outlineCell(g, grid, this.marker.i, this.marker.j, MARKER_COLOR, 4, 1);
    }

    _drawGridOutline(g, grid, scene) {
        const d = scene.dimensions;
        const rect = d?.sceneRect;
        if (!rect) return;
        let range;
        try { range = grid.getOffsetRange(rect); } catch (_) { return; }
        const [i0, j0, i1, j1] = range;
        if (((i1 - i0) * (j1 - j0)) > MAX_GRID_OUTLINE) return;
        g.lineStyle({ width: 1, color: GRID_OUTLINE_COLOR, alpha: 0.12 });
        for (let i = i0; i < i1; i++) {
            for (let j = j0; j < j1; j++) {
                const flat = this._cellPath(grid, i, j);
                if (flat) g.drawPolygon(flat);
            }
        }
        g.lineStyle(0);
    }

    _fillCell(g, grid, i, j, color, alpha) {
        const flat = this._cellPath(grid, i, j);
        if (!flat) return;
        g.beginFill(color, alpha);
        g.drawPolygon(flat);
        g.endFill();
    }

    /** Destroy and remove all biome glyphs (each PIXI.Text frees its own texture). */
    _clearIcons() {
        if (this.iconLayer) this.iconLayer.removeChildren().forEach(c => c.destroy());
    }

    /** Center a terrain's FontAwesome glyph in cell (i,j), tinted to the tile colour. */
    _drawCellIcon(grid, i, j, iconClass, color) {
        if (!this.iconLayer) return;
        const glyph = faGlyph(iconClass);
        if (!glyph) return;
        let center;
        try { center = grid.getCenterPoint({ i, j }); } catch (_) { return; }
        if (!center) return;
        const cellSize = Math.min(grid.sizeX ?? grid.size ?? 100, grid.sizeY ?? grid.size ?? 100);
        const fontSize = Math.max(8, Math.round(cellSize * ICON_SCALE));
        const text = new PIXI.Text(glyph.char, {
            fontFamily: glyph.family,
            fontWeight: glyph.weight,
            fontSize,
            fill: color,
            align: "center"
        });
        text.anchor.set(0.5);
        text.position.set(center.x, center.y);
        text.alpha = ICON_ALPHA;
        text.resolution = 2;                         // crisper when the GM zooms in
        this.iconLayer.addChild(text);
    }

    _outlineCell(g, grid, i, j, color, width, alpha) {
        const flat = this._cellPath(grid, i, j);
        if (!flat) return;
        g.lineStyle({ width, color, alpha });
        g.drawPolygon(flat);
        g.lineStyle(0);
    }

    /** Flat [x0,y0,x1,y1,…] vertices of a cell, or null if unavailable. */
    _cellPath(grid, i, j) {
        let verts;
        try { verts = grid.getVertices({ i, j }); } catch (_) { return null; }
        if (!verts?.length) return null;
        const flat = [];
        for (const p of verts) flat.push(p.x, p.y);
        return flat;
    }

    /* ─────────── interaction ───────────────────────────────────────────────── */

    /** @override */
    _canDragLeftStart(_user, _event) { return game.user?.isGM === true; }

    /** @override */
    _onClickLeft(event) {
        // Erase via the dedicated tool or Shift-click; right-click stays scene-pan.
        if (this._guardGridless()) return;
        const cell = this._cellUnder(event);
        if (cell && this._applyAt(cell.i, cell.j, event.shiftKey === true)) this._flush();
    }

    /** @override */
    _onDragLeftStart(event) {
        if (this._guardGridless()) return;
        this._painting = true;
        this._eraseStroke = event.shiftKey === true;   // Shift-drag erases the whole swath
        const cell = this._cellUnder(event);
        if (cell) this._applyAt(cell.i, cell.j, this._eraseStroke);
    }

    /** @override */
    _onDragLeftMove(event) {
        if (!this._painting) return;
        const cell = this._cellUnder(event);
        if (cell) this._applyAt(cell.i, cell.j, this._eraseStroke);
    }

    /** @override */
    _onDragLeftDrop(_event) {
        if (!this._painting) return;
        this._painting = false;
        this._eraseStroke = false;
        this._flush();
    }

    /** @override */
    _onDragLeftCancel(_event) {
        // Commit what was painted before the abort: cancel() doesn't reload the
        // model, so an un-flushed stroke would linger on-screen yet vanish on the
        // next redraw (overlay/flag divergence).
        if (!this._painting) return;
        this._painting = false;
        this._eraseStroke = false;
        this._flush();
    }

    /** Apply the active tool (or a forced erase) to cell (i,j) in memory + redraw.
     *  Shift-click/drag forces erase regardless of the active brush. Returns true if changed. */
    _applyAt(i, j, forceErase = false) {
        const tool = forceErase ? ERASE_TOOL : this._activeTool();
        const key = cellKey(i, j);
        if (tool === ERASE_TOOL) {
            if (!this.cells[key]) return false;
            delete this.cells[key];
        } else if (tool === MARKER_TOOL) {
            if (this.marker?.i === i && this.marker?.j === j) return false;
            this.marker = { i, j };
        } else if (tool && this._terrain[tool]) {
            if (this.cells[key]?.terrain === tool) return false;
            this.cells[key] = { terrain: tool };
        } else {
            return false;
        }
        this._refresh();
        return true;
    }

    _activeTool() {
        try { return ui.controls?.tool?.name ?? null; } catch (_) { return null; }
    }

    /** Cell offset {i,j} under the pointer, in scene-pixel space, or null. */
    _cellUnder(event) {
        const scene = canvas?.scene;
        const data = event?.interactionData;
        const pt = data?.destination ?? data?.origin ?? event?.getLocalPosition?.(canvas.stage);
        if (!scene || !pt) return null;
        try {
            const off = scene.grid.getOffset(pt);
            return { i: off.i, j: off.j };
        } catch (_) { return null; }
    }

    _flush() {
        const scene = canvas?.scene;
        if (!scene) return;
        writeWeatherMap(scene, { cells: this.cells, marker: this.marker, biome: this.biome })
            .catch(err => console.error(`${SYSTEM_ID} | terrain map write failed`, err));
    }

    /** Clear the painted map after a confirm dialog (wired to the Clear button). */
    async clearMap() {
        const scene = canvas?.scene;
        if (!scene) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "WITCHER.Weather.Map.Clear" },
            content: `<p>${game.i18n.localize("WITCHER.Weather.Map.ClearConfirm")}</p>`
        });
        if (!ok) return;
        await clearWeatherMapFlag(scene);
        this._loadModel();
        this._refresh();
    }

    _isGridless() {
        return canvas?.scene?.grid?.type === CONST.GRID_TYPES.GRIDLESS;
    }

    /** Warn (once per gesture) and bail when the scene has no grid to paint. */
    _guardGridless() {
        if (!this._isGridless()) return false;
        ui.notifications?.warn(game.i18n.localize("WITCHER.Weather.Map.NoGrid"));
        return true;
    }
}

/**
 * Register the layer in CONFIG.Canvas.layers and wire a cross-client redraw so a
 * GM's edits (or another GM's) repaint the overlay. Called from the init hook.
 */
export function registerTerrainPaintLayer() {
    CONFIG.Canvas.layers[LAYER_NAME] = { layerClass: TerrainPaintLayer, group: "interface" };

    Hooks.on("updateScene", (scene, changes) => {
        if (!game.user?.isGM) return;                // players never render the editing overlay
        const layer = canvas?.[LAYER_NAME];
        if (!layer || scene !== canvas?.scene || layer._painting) return;
        if (changes?.flags?.[SYSTEM_ID] !== undefined) layer.draw();
    });
}
