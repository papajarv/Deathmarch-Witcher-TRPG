// Two-quality wire-up fixes from the post-Phase-8 audit:
//   1. parryingShield (ARMOR_QUALITIES) wasn't being read for shield items
//      because defenseMixin.weaponParryPenaltyDelta short-circuited with
//      `item.type !== "weapon"`. Shields now also fold their qualities'
//      parryPenaltyDelta from the armor catalog.
//   2. difficult was duplicated: a `system.difficult` boolean (canonical)
//      AND a `difficult` ARMOR_QUALITIES chip (display-only). isDifficultArmor
//      now treats either signal as sufficient, and the un-equip gate in
//      chrome/inventory.js mirrors that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const defSrc   = readFileSync(new URL("../documents/mixins/defenseMixin.mjs", import.meta.url), "utf8");
const armorSrc = readFileSync(new URL("./eoArmorModel.mjs", import.meta.url), "utf8");
const invSrc   = readFileSync(new URL("../chrome/chrome/inventory.js", import.meta.url), "utf8");
const cfgSrc   = readFileSync(new URL("../setup/config.mjs", import.meta.url), "utf8");

test("defenseMixin imports getActiveArmorQualities for shield-side parry lookup", () => {
    assert.match(defSrc, /import\s*\{[^}]*getActiveArmorQualities[^}]*\}\s*from\s*"\.\.\/\.\.\/setup\/config\.mjs"/);
});

test("weaponParryPenaltyDelta now also accepts shields and reads the armor catalog", () => {
    /* Guard widened from "weapon only" to "weapon OR shield"; catalog
     * chosen by item.type. */
    assert.match(defSrc, /item\.type\s*!==\s*"weapon"\s*&&\s*item\.type\s*!==\s*"shield"/);
    assert.match(defSrc, /item\.type\s*===\s*"shield"[\s\S]+?getActiveArmorQualities/);
});

test("isDifficultArmor accepts either the boolean OR the qualities-chip signal", () => {
    /* The canonical boolean still wins, but a chip-set is also enough
     * — the GM can mark a piece Difficult via either path. */
    assert.match(armorSrc, /armor\?\.system\?\.difficult/);
    assert.match(armorSrc, /qs\.includes\("difficult"\)/);
});

test("chrome inventory un-equip gate mirrors isDifficultArmor's dual read", () => {
    /* The EO arming-jack-removal gate used to read only the boolean;
     * now it must check the chip too so users who marked Difficult via
     * the qualities checkbox still get the gate. */
    assert.match(invSrc, /worn\.some\(p\s*=>\s*\{[\s\S]+?p\.system\?\.difficult[\s\S]+?qs\.includes\("difficult"\)/);
});

test("ARMOR_QUALITIES.difficult is wired (not displayOnly) so chip renders solid", () => {
    /* Chip toggle writes through to system.difficult via the sheet
     * binding, and the engine enforces the arming-jack rule from that
     * boolean. The chip is a real, wired quality — the displayOnly flag
     * was misleading. */
    assert.match(cfgSrc, /difficult:\s*wq\("Difficult",[\s\S]+?worn with an Arming Jack/);
    /* Extract from `difficult:` to the next top-level quality key so the
     * regex stops before lanceRest et al. and we don't accidentally find
     * THEIR displayOnly:true. */
    const m = cfgSrc.match(/difficult:\s*wq\([\s\S]+?\n\s{4}[a-z][a-zA-Z]+:/);
    assert.ok(m, "difficult block should be parseable");
    assert.ok(!/displayOnly:\s*true/.test(m[0]), "Difficult should NOT carry displayOnly:true");
});
