// module/mechanics/eoSlotEnforcement.test.mjs
//
// EO p.4 slot model: glyphs consume from the total `enhancementSlots`
// pool (location-agnostic); armor mods consume from a specific
// `aeSlots[location]` bucket. Tests use the pure helpers — the drop
// handler that calls them is source-pattern checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    isGlyph, isPerLocationAe,
    aeSlotCap, aeSlotCapTotal, glyphSlotCap,
    aeSlotsUsed, glyphSlotsUsed, locationsWithFreeAeSlots
} from "./eoArmorModel.mjs";

const dropSrc       = readFileSync(new URL("../sheets/item/enhancementSlots.mjs", import.meta.url), "utf8");
const sheetBaseSrc  = readFileSync(new URL("../sheets/item/base.mjs", import.meta.url), "utf8");
const defPropsSrc   = readFileSync(new URL("../data/item/templates/defenseProperties.mjs", import.meta.url), "utf8");

const armor = {
    system: {
        aeSlots: { head: 0, torso: 2, leftArm: 1, rightArm: 1, leftLeg: 0, rightLeg: 0 },
        enhancementSlots: 2,
        appliedEnhancements: []
    }
};

test("isGlyph / isPerLocationAe classify enhancement.system.type correctly", () => {
    assert.equal(isGlyph({ system: { type: "glyph" } }), true);
    assert.equal(isGlyph({ system: { type: "armor" } }), false);
    assert.equal(isPerLocationAe({ system: { type: "armor" } }), true);
    assert.equal(isPerLocationAe({ system: { type: "glyph" } }), false);
});

test("aeSlotCap reads per-location numbers from system.aeSlots", () => {
    assert.equal(aeSlotCap(armor, "torso"), 2);
    assert.equal(aeSlotCap(armor, "head"), 0);
    assert.equal(aeSlotCap(armor, "missing"), 0);
});

test("aeSlotCapTotal sums the per-location AE pool", () => {
    assert.equal(aeSlotCapTotal(armor), 4);   /* 0 + 2 + 1 + 1 + 0 + 0 */
});

test("glyphSlotCap reads system.enhancementSlots", () => {
    assert.equal(glyphSlotCap(armor), 2);
});

test("aeSlotsUsed counts entries by location tag", () => {
    const a = { system: {
        aeSlots: { torso: 2, leftArm: 1 },
        appliedEnhancements: [
            { uuid: "a", location: "torso" },
            { uuid: "b", location: "torso" },
            { uuid: "c", location: "leftArm" },
            { uuid: "d", location: "" }       /* glyph entry — not counted */
        ]
    } };
    assert.equal(aeSlotsUsed(a, "torso"), 2);
    assert.equal(aeSlotsUsed(a, "leftArm"), 1);
    assert.equal(aeSlotsUsed(a, null), 3);    /* total per-location entries */
});

test("glyphSlotsUsed counts entries with empty/absent location", () => {
    const a = { system: {
        appliedEnhancements: [
            { uuid: "x", location: "torso" },
            { uuid: "y", location: "" },
            { uuid: "z" }   /* no location field at all */
        ]
    } };
    assert.equal(glyphSlotsUsed(a), 2);
});

test("locationsWithFreeAeSlots returns only locations with cap > 0 AND used < cap", () => {
    const a = { system: {
        aeSlots: { torso: 2, leftArm: 1, rightArm: 0 },
        appliedEnhancements: [
            { uuid: "a", location: "torso" },
            { uuid: "b", location: "leftArm" }  /* fills the 1-cap slot */
        ]
    } };
    const free = locationsWithFreeAeSlots(a);
    const keys = free.map(f => f.key).sort();
    assert.deepEqual(keys, ["torso"]);
    assert.equal(free[0].used, 1);
    assert.equal(free[0].cap, 2);
});

test("appliedEnhancements schema carries an optional `location` field", () => {
    assert.match(defPropsSrc, /location:\s*new\s+fields\.StringField\(\s*\{\s*initial:\s*""\s*\}/);
});

test("Drop handler routes through EO when toggle is on and weapon target is excluded", () => {
    /* Weapon enhancements (rune / craftsman weapon mod) keep the legacy
     * single-bucket flow regardless of toggle — EO p.4 only restructures
     * armor slot accounting. */
    assert.match(dropSrc, /if\s*\(targetType\s*===\s*"armor"\)\s*\{[\s\S]+?isEoArmorModelOn\(\)/);
    /* EO armor branch: glyph → enhancementSlots pool. */
    assert.match(dropSrc, /eo\.isGlyph\(enh\)/);
    assert.match(dropSrc, /eo\.glyphSlotCap\(parent\)/);
    assert.match(dropSrc, /eo\.glyphSlotsUsed\(parent\)/);
    /* EO armor branch: per-location AE → location picker + cap check. */
    assert.match(dropSrc, /eo\.isPerLocationAe\(enh\)/);
    assert.match(dropSrc, /eo\.locationsWithFreeAeSlots\(parent\)/);
    /* Slot ref carries the chosen location (empty for glyph). */
    assert.match(dropSrc, /applied\.push\(\{\s*uuid:[^}]+location\s*\}\s*\)/);
});

test("Drop handler auto-picks the only-available location, prompts when multiple", () => {
    assert.match(dropSrc, /if\s*\(free\.length\s*===\s*1\)/);
    assert.match(dropSrc, /promptLocation\(parent\.name,\s*enh\.name,\s*free\)/);
});

test("Drop handler refuses when no free pool slot is available", () => {
    /* Glyph branch: refuses with "No free Enchantment (En.) slots". */
    assert.match(dropSrc, /No free Enchantment \(En\.\) slots/);
    /* Per-location AE branch: refuses with "No free AE slots". */
    assert.match(dropSrc, /No free AE slots on any covered location/);
});

test("RAW fallback (toggle off) preserves the single-bucket cap", () => {
    /* Falls through to the legacy `armorEnhancement` cap when EO isn't on. */
    assert.match(dropSrc, /Number\(parent\.system\?\.\[targetType\s*===\s*"weapon"\s*\?\s*"weaponEnhancement"\s*:\s*"armorEnhancement"\]\)/);
});

test("Armor sheet uses buildEnhancementSlotGroups under EO + flat single strip under RAW", () => {
    /* Sheet branches on the EO toggle: split groups vs single flat list. */
    assert.match(sheetBaseSrc, /ctx\.eoArmorModelOn\s*=\s*_eoMod\.isEoArmorModelOn\(\)/);
    assert.match(sheetBaseSrc, /buildEnhancementSlotGroups\(this\.item\)/);
    assert.match(sheetBaseSrc, /ctx\.enhancementSlotGroups\s*=\s*null/);
});

test("Drop handler honors per-strip pool override (no picker when location is given)", () => {
    /* The slot strip can carry data-enh-pool / data-enh-location. When
     * present, the drop handler pins routing to that pool and skips
     * the picker. Pool-mismatch (glyph dropped on AE strip) is
     * rejected with a clear message. */
    assert.match(dropSrc, /opts\.pool\s*===\s*"glyph"\s*&&\s*!eo\.isGlyph\(enh\)/);
    assert.match(dropSrc, /opts\.pool\s*===\s*"ae"\s*&&\s*!eo\.isPerLocationAe\(enh\)/);
    assert.match(dropSrc, /opts\.location\)\s*\{[\s\S]+?eo\.aeSlotCap\(parent,\s*opts\.location\)/);
});

test("wireEnhancementSlots reads data-enh-pool / data-enh-location from the strip", () => {
    assert.match(dropSrc, /strip\.dataset\?\.enhPool/);
    assert.match(dropSrc, /strip\.dataset\?\.enhLocation/);
});
