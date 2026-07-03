// `displayOnly` is the chip-level "GM-resolved" honesty marker. Qualities
// without an engine consumer (Concealment, Crew Reload, Mounted, Injector,
// Lance Rest, Deployable, etc.) set this flag so the chip shows a small
// info glyph + dashed border instead of pretending the engine applies
// the effect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WEAPON_QUALITIES, ARMOR_QUALITIES } from "./config.mjs";

const sheetSrc  = readFileSync(new URL("../sheets/item/base.mjs", import.meta.url), "utf8");
const weaponTpl = readFileSync(new URL("../../templates/item/weapon.hbs", import.meta.url), "utf8");
const armorTpl  = readFileSync(new URL("../../templates/item/armor.hbs", import.meta.url), "utf8");
const shieldTpl = readFileSync(new URL("../../templates/item/shield.hbs", import.meta.url), "utf8");
const ammoTpl   = readFileSync(new URL("../../templates/item/ammo.hbs", import.meta.url), "utf8");

test("wq factory exposes displayOnly", () => {
    /* Verify the field flows through the factory on a known display-only
     * entry. Concealment is the canonical test case. */
    assert.equal(WEAPON_QUALITIES.concealment?.displayOnly, true);
    assert.equal(WEAPON_QUALITIES.crewReload?.displayOnly, true);
    assert.equal(WEAPON_QUALITIES.mounted?.displayOnly, true);
    assert.equal(WEAPON_QUALITIES.injector?.displayOnly, true);
    assert.equal(WEAPON_QUALITIES.grappling?.displayOnly, true);
});

test("wired weapon qualities do NOT get displayOnly", () => {
    /* Sanity: status riders and damage flags must not accidentally get
     * marked. Spot-check a handful. */
    assert.equal(!!WEAPON_QUALITIES.bleeding?.displayOnly, false);
    assert.equal(!!WEAPON_QUALITIES.armorPiercing?.displayOnly, false);
    assert.equal(!!WEAPON_QUALITIES.silver?.displayOnly, false);
    assert.equal(!!WEAPON_QUALITIES.parrying?.displayOnly, false);
    assert.equal(!!WEAPON_QUALITIES.nimble?.displayOnly, false);
});

test("armor qualities marked displayOnly cover the no-engine set", () => {
    assert.equal(ARMOR_QUALITIES.lanceRest?.displayOnly, true);
    assert.equal(ARMOR_QUALITIES.superiorLanceRest?.displayOnly, true);
    assert.equal(ARMOR_QUALITIES.options?.displayOnly, true);
    assert.equal(ARMOR_QUALITIES.bladeCatcherArmor?.displayOnly, true);
    assert.equal(ARMOR_QUALITIES.deployable?.displayOnly, true);
    assert.equal(ARMOR_QUALITIES.monsterResistance?.displayOnly, true);
    assert.equal(ARMOR_QUALITIES.setBonus?.displayOnly, true);
    assert.equal(ARMOR_QUALITIES.hidden?.displayOnly, true);
    assert.equal(ARMOR_QUALITIES.archeryShield?.displayOnly, true);
    /* `difficult` is WIRED — the chip toggle writes through to
     * system.difficult which mechanics/eoArmorModel.mjs enforces. The
     * chip should render solid-bordered, not dashed. */
    assert.equal(!!ARMOR_QUALITIES.difficult?.displayOnly, false);
});

test("armor qualities with real engine wiring stay non-displayOnly", () => {
    assert.equal(!!ARMOR_QUALITIES.fireproof?.displayOnly, false);
    assert.equal(!!ARMOR_QUALITIES.bleedResistance?.displayOnly, false);
    assert.equal(!!ARMOR_QUALITIES.silverContact?.displayOnly, false);
    assert.equal(!!ARMOR_QUALITIES.meteoriteContact?.displayOnly, false);
    assert.equal(!!ARMOR_QUALITIES.stifling?.displayOnly, false);
    assert.equal(!!ARMOR_QUALITIES.criticalDecimation?.displayOnly, false);
});

test("all four quality-list builders pass displayOnly through to the chip context", () => {
    /* The sed swap on line 399/492/543/659/712 was meant to add
     * `displayOnly: !!entry.displayOnly` to every chip-list builder. */
    const matches = sheetSrc.match(/displayOnly:\s*!!entry\.displayOnly/g) ?? [];
    assert.ok(matches.length >= 5, `expected at least 5 chip builders to surface displayOnly, got ${matches.length}`);
});

test("weapon / ammo / armor / shield templates render the displayOnly hint", () => {
    /* Each chip template adds `is-display-only` to the wrapper class +
     * an inline info glyph when the catalog flag is set. */
    for (const [name, src] of [
        ["weapon", weaponTpl], ["ammo", ammoTpl],
        ["armor", armorTpl], ["shield", shieldTpl]
    ]) {
        assert.match(src, /\{\{#if this\.displayOnly\}\}\s*is-display-only/,
            `${name} template missing is-display-only class branch`);
        assert.match(src, /wdm-w3-tag-info/,
            `${name} template missing info glyph`);
    }
});
