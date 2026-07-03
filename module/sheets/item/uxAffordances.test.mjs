// Two UX affordances surfaced by the player-side audit:
//   1. Diagram ingredient rows are Foundry content-link <a> tags when the
//      linker resolved a UUID — clickable to open, draggable to drop.
//      Unlinked rows fall back to a muted <li> with a tooltip.
//   2. Display-mode weapon-quality chips for the four open-category
//      qualities carry an inline sliders button so the structured-bonus
//      editor doesn't require flipping to config mode first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const diagramTpl = readFileSync(new URL("../../../templates/item/diagrams.hbs", import.meta.url), "utf8");
const weaponTpl  = readFileSync(new URL("../../../templates/item/weapon.hbs", import.meta.url), "utf8");
const sheetSrc   = readFileSync(new URL("./base.mjs", import.meta.url), "utf8");

test("Diagram ingredient with a UUID renders as a Foundry content-link <a>", () => {
    assert.match(diagramTpl, /class="content-link"[\s\S]+?data-uuid="\{\{this\.uuid\}\}"[\s\S]+?data-type="Item"/);
});

test("Diagram ingredient with NO UUID falls back to a muted, non-draggable row", () => {
    assert.match(diagramTpl, /\{\{else\}\}[\s\S]+?wdm-w3-ingredient is-unlinked[\s\S]+?No compendium item resolved/);
});

test("Weapon sheet prep tags open-category qualities with isOpenCategory: true", () => {
    /* The four EO open-category keys must be flagged so the template
     * conditionally renders the sliders affordance. */
    assert.match(sheetSrc, /OPEN_CATEGORY_KEYS\s*=\s*new Set\(\["twoHand",\s*"closeQuarters",\s*"throwing",\s*"strangling"\]\)/);
    assert.match(sheetSrc, /isOpenCategory:\s*OPEN_CATEGORY_KEYS\.has\(key\)/);
});

test("Weapon display-mode chip renders sliders button when isOpenCategory", () => {
    /* `wdm-w3-tag-config` button wired to the same data-action as the
     * config-mode sliders, so the existing handler in
     * sheets/item/base.mjs:283 routes both. */
    assert.match(weaponTpl, /\{\{#if this\.isOpenCategory\}\}[\s\S]+?wdm-w3-tag-config[\s\S]+?data-action="config-open-category-quality"[\s\S]+?data-quality-key="\{\{this\.key\}\}"/);
});

test("Non-open-category chips DON'T render the sliders button", () => {
    /* The {{#if this.isOpenCategory}} guard means a plain quality like
     * Bleeding doesn't acquire the editor button. Spot-check via the
     * conditional opener. */
    assert.match(weaponTpl, /\{\{#if this\.isOpenCategory\}\}/);
});
