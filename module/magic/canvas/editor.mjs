/**
 * The spell canvas, as a Foundry application.
 *
 * Everything above this file is Foundry-free — palette, legality, layout and
 * markup are plain functions over plain data, exercised by node tests. This
 * file is the only thing that knows what an ApplicationV2 is, and it is
 * deliberately thin: it wires events to the pure functions and writes the
 * result back to the document.
 *
 * The split is the same one the runtime uses with its adapter, for the same
 * reason. Something that can only be tested by launching a game is something
 * that does not get tested.
 *
 * The stylesheet is `styles/spell-canvas.css`, loaded by system.json.
 */

import { spellSpec, entrySpec, frameSummary } from "./render.mjs";
import { entryHTML, lawHTML, railHTML } from "./dom.mjs";
import { palette } from "./palette.mjs";
import { canDrop, canMove, insertAt, removeAt, moveTo, atPath,
         entryOptions, unreachableIn } from "./legality.mjs";
import { getBlock } from "../registry.mjs";
import { defaultArgs } from "./palette.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const LABELS = Object.fromEntries(entryOptions().map(e => [e.id, e.label]));
const SCOPES = Object.fromEntries(entryOptions().map(e => [e.id, e.scope]));

export class SpellCanvas extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "witcher-spell-canvas-{id}",
        classes: ["witcher", "spell-canvas"],
        tag: "form",
        window: { title: "WITCHER.Magic.Canvas.Title", resizable: true, icon: "fa-solid fa-diagram-project" },
        position: { width: 1080, height: 720 },
        actions: {
            addEntry:    SpellCanvas.#onAddEntry,
            removeBlock: SpellCanvas.#onRemoveBlock
        }
    };

    static PARTS = { body: { template: "systems/TheWitcherTRPG/templates/magic/canvas.hbs" } };

    constructor(options = {}) {
        super(options);
        this.item = options.document;
        /** Which entry the author is looking at. Decides what the rail dims. */
        this.focus = Object.keys(this.trees)[0] ?? "hit";
        /** The last refusal, shown until the next successful drop clears it. */
        this.refusal = null;
    }

    /** The authored trees, straight off the item. Never cached — Foundry owns them. */
    get trees() { return this.item?.system?.magic?.on ?? {}; }
    get frame() { return this.item?.system?.magic?.frame ?? {}; }

    async _prepareContext() {
        const groups = palette();
        const dim = unreachableIn(this.focus, groups.flatMap(g => g.blocks));
        const spell = { name: this.item?.name ?? "Untitled", frame: this.frame,
                        tier: this.frame?.tier, on: this.trees };

        return {
            railHTML: railHTML(groups, dim),
            lawHTML:  lawHTML(spell, frameSummary(this.frame), null),
            entriesHTML: Object.entries(this.trees).map(([entry, tree]) =>
                entryHTML(entrySpec(entry, tree, {
                    label: LABELS[entry] ?? entry, scope: SCOPES[entry] ?? []
                }))).join(""),
            refusal: this.refusal,
            entryChoices: entryOptions().filter(e => !(e.id in this.trees))
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const root = this.element;

        for (const chip of root.querySelectorAll(".wm-chip")) {
            chip.addEventListener("dragstart", ev => this.#startDrag(ev, { from: "palette", id: chip.dataset.block }));
        }
        for (const blk of root.querySelectorAll(".wm-blk")) {
            blk.addEventListener("dragstart", ev => this.#startDrag(ev, { from: "canvas", at: blk.dataset.at }));
            blk.addEventListener("keydown", ev => this.#onBlockKey(ev, blk));
        }
        for (const zone of root.querySelectorAll(".wm-stack, .wm-body")) {
            zone.addEventListener("dragover",  ev => this.#onDragOver(ev, zone));
            zone.addEventListener("dragleave", () => zone.classList.remove("wm-body--over"));
            zone.addEventListener("drop",      ev => this.#onDrop(ev, zone));
        }
        for (const slot of root.querySelectorAll(".wm-slot")) {
            slot.addEventListener("click", ev => this.#editSlot(ev, slot));
        }
    }

    #startDrag(ev, payload) {
        ev.stopPropagation();               // a block inside a gate is not the gate
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", JSON.stringify(payload));
    }

    /**
     * Ask before allowing the drop, so the cursor tells the truth mid-drag.
     *
     * The check is the same `canDrop` the drop handler runs — a preview that
     * disagrees with the outcome is worse than no preview.
     */
    #onDragOver(ev, zone) {
        const payload = this.#peek(ev);
        if (!payload) return;
        const target = this.#targetOf(zone, ev);
        const verdict = payload.from === "palette"
            ? canDrop(this.trees[target.entry] ?? [], target.entry, target.path, target.index, payload.id)
            : { ok: true };                 // moves are checked on drop; the shape is known good
        if (!verdict.ok) return;            // no preventDefault → "no drop" cursor
        ev.preventDefault();
        zone.classList.add("wm-body--over");
    }

    async #onDrop(ev, zone) {
        ev.preventDefault();
        ev.stopPropagation();
        zone.classList.remove("wm-body--over");

        const payload = JSON.parse(ev.dataTransfer.getData("text/plain") || "null");
        if (!payload) return;
        const target = this.#targetOf(zone, ev);
        const tree = this.trees[target.entry] ?? [];

        if (payload.from === "palette") {
            const verdict = canDrop(tree, target.entry, target.path, target.index, payload.id);
            if (!verdict.ok) return this.#refuse(verdict.reason);
            const def = getBlock(payload.id);
            const node = { b: payload.id, a: defaultArgs(def) };
            if (def.shape !== "stack" && def.shape !== "reporter") node.body = [];
            return this.#commit(target.entry, insertAt(tree, target.path, target.index, node));
        }

        const from = this.#parseAddr(payload.at);
        const verdict = canMove(tree, target.entry, from, target);
        if (!verdict.ok) return this.#refuse(verdict.reason);
        return this.#commit(target.entry, moveTo(tree, from, target));
    }

    /** Which body, and where in it, the pointer is over. */
    #targetOf(zone, ev) {
        const entry = zone.closest("[data-entry]")?.dataset.entry ?? this.focus;
        const addr = zone.dataset.body;
        const path = addr ? [...this.#parseAddr(addr).path, this.#parseAddr(addr).index, "body"] : [];

        /* Insert above the first sibling whose midpoint is below the cursor —
         * so dropping near a block's top edge puts it before, not after. */
        const kids = [...zone.children].filter(c => c.matches(".wm-blk, .wm-gate"));
        const y = ev.clientY;
        let index = kids.length;
        for (const [i, kid] of kids.entries()) {
            const r = kid.getBoundingClientRect();
            if (y < r.top + r.height / 2) { index = i; break; }
        }
        return { entry, path, index };
    }

    #parseAddr(addr) {
        const [rawPath, rawIndex] = String(addr).split("|");
        const path = rawPath ? rawPath.split(".").map(p => (/^\d+$/.test(p) ? Number(p) : p)) : [];
        return { path, index: Number(rawIndex) };
    }

    #peek(ev) {
        /* `dataTransfer` is write-protected during dragover in every browser, so
         * the payload is stashed on the app for the preview to read. */
        return this._dragPayload ?? null;
    }

    #refuse(reason) {
        this.refusal = reason;
        return this.render();
    }

    async #commit(entry, tree) {
        this.refusal = null;
        this.focus = entry;
        await this.item.update({ [`system.magic.on.${entry}`]: tree });
        return this.render();
    }

    /* ── Keyboard ──────────────────────────────────────────────────────────
     * Drag-and-drop with no keyboard path is an editor a third of people
     * cannot use. Up and down move a block within its stack; Delete removes it. */
    async #onBlockKey(ev, blk) {
        const nudge = { ArrowUp: -1, ArrowDown: 1 }[ev.key];
        const at = this.#parseAddr(blk.dataset.at);
        const entry = blk.closest("[data-entry]")?.dataset.entry ?? this.focus;
        const tree = this.trees[entry] ?? [];

        if (nudge) {
            ev.preventDefault();
            const to = { path: at.path, index: at.index + (nudge > 0 ? 2 : -1) };
            if (to.index < 0) return;
            const verdict = canMove(tree, entry, at, to);
            if (!verdict.ok) return this.#refuse(verdict.reason);
            return this.#commit(entry, moveTo(tree, at, to));
        }
        if (ev.key === "Delete" || ev.key === "Backspace") {
            ev.preventDefault();
            return this.#commit(entry, removeAt(tree, at.path, at.index).tree);
        }
    }

    async #editSlot(ev, slot) {
        ev.stopPropagation();
        const blk = slot.closest(".wm-blk");
        if (!blk) return;
        const at = this.#parseAddr(blk.dataset.at);
        const entry = blk.closest("[data-entry]")?.dataset.entry ?? this.focus;
        const tree = structuredClone(this.trees[entry] ?? []);
        const node = at.path.length ? atPath(tree, at.path).body[at.index] : tree[at.index];
        const def = getBlock(node.b);
        const spec = def?.inputs?.[slot.dataset.key];
        if (!spec) return;

        const next = await promptFor(spec, node.a?.[slot.dataset.key], slot.dataset.key);
        if (next === undefined) return;
        (node.a ??= {})[slot.dataset.key] = next;
        return this.#commit(entry, tree);
    }

    static async #onAddEntry(ev, target) {
        const entry = target.dataset.entry;
        this.focus = entry;
        await this.item.update({ [`system.magic.on.${entry}`]: [] });
        return this.render();
    }

    static async #onRemoveBlock(ev, target) {
        const at = this.#parseAddr(target.dataset.at);
        const entry = target.closest("[data-entry]")?.dataset.entry ?? this.focus;
        return this.#commit(entry, removeAt(this.trees[entry] ?? [], at.path, at.index).tree);
    }
}

/**
 * Ask the author for one argument.
 *
 * Enum vocabularies that come from the world (`@statuses`) are resolved here
 * rather than baked into the block, so a module adding a status makes it
 * available to every block that takes one without touching the registry.
 */
async function promptFor(spec, current, key) {
    if (spec.type === "boolean") return !current;

    if (spec.type === "enum") {
        const options = Array.isArray(spec.options)
            ? spec.options
            : await vocabulary(spec.options);
        const picked = await foundry.applications.api.DialogV2.prompt({
            window: { title: game.i18n.localize("WITCHER.Magic.Canvas.Choose") },
            content: `<select name="v">${options.map(o =>
                `<option value="${o}"${o === current ? " selected" : ""}>${o}</option>`).join("")}</select>`,
            ok: { callback: (_e, button) => button.form.elements.v.value }
        });
        return picked ?? undefined;
    }

    const typed = await foundry.applications.api.DialogV2.prompt({
        window: { title: key },
        content: `<input type="text" name="v" value="${foundry.utils.escapeHTML(String(current ?? ""))}">`,
        ok: { callback: (_e, button) => button.form.elements.v.value }
    });
    return typed ?? undefined;
}

/** World vocabularies, resolved lazily so modules can extend them. */
async function vocabulary(name) {
    switch (name) {
        case "@statuses":       return CONFIG.statusEffects.map(s => s.id);
        case "@damageTypes":    return Object.keys(CONFIG.WITCHER?.damageTypes ?? {});
        case "@damageChannels": return ["attack", "poison", "disease", "suffocation", "burning", "bleeding"];
        case "@defences":       return ["dodge", "block", "blockOrDodge", "resistMagic", "spellCasting", "none"];
        case "@elements":       return ["earth", "air", "fire", "water", "mixed"];
        case "@infoKinds":      return ["health", "direction", "memory", "secret", "monsters", "augury"];
        default:                return [];
    }
}
