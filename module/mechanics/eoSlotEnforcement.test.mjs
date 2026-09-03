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

/* EO p.4 single-budget model: `aeSlots` is now a flat total (the player
 * allocates it across covered zones at attach time), not a per-location
 * object. Coverage is derived from per-limb MaxStopping (see coveredZones). */
const armor = {
    system: {
        aeSlots: 4,
        enhancementSlots: 2,
        torsoMaxStopping: 5,
        leftArmMaxStopping: 3, rightArmMaxStopping: 3,
        appliedEnhancements: []
    }
};

test("isGlyph / isPerLocationAe classify enhancement.system.type correctly", () => {
    assert.equal(isGlyph({ system: { type: "glyph" } }), true);
    assert.equal(isGlyph({ system: { type: "armor" } }), false);
    assert.equal(isPerLocationAe({ system: { type: "armor" } }), true);
    assert.equal(isPerLocationAe({ system: { type: "glyph" } }), false);
});

test("aeSlotCap returns the flat total AE budget (location arg is legacy/ignored)", () => {
    /* EO p.4 single-budget model: per-location caps no longer exist —
     * aeSlotCap(armor, _) returns the same total for any location. */
    assert.equal(aeSlotCap(armor, "torso"), 4);
    assert.equal(aeSlotCap(armor, "head"), 4);
    assert.equal(aeSlotCap(armor, "missing"), 4);
});

test("aeSlotCapTotal reads the flat AE budget from system.aeSlots", () => {
    assert.equal(aeSlotCapTotal(armor), 4);
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

test("locationsWithFreeAeSlots lists physically-covered zones while budget remains", () => {
    /* EO p.4 single-budget model: `aeSlots` is a flat total the player
     * allocates across zones. Covered zones come from per-limb MaxStopping
     * (not the location enum). Any covered zone is offered as long as the
     * total budget isn't fully spent. Each entry's `cap` is remaining +
     * that zone's own used (display-only "you can put another here"). */
    const a = { system: {
        aeSlots: 3,
        torsoMaxStopping: 5,
        leftArmMaxStopping: 2, rightArmMaxStopping: 2,   /* arms covered */
        /* legs have no SP → not offered */
        appliedEnhancements: [
            { uuid: "a", location: "torso" },
            { uuid: "b", location: "arms" }
        ]
    } };
    const free = locationsWithFreeAeSlots(a);
    const keys = free.map(f => f.key).sort();
    assert.deepEqual(keys, ["arms", "torso"]);
    const torso = free.find(f => f.key === "torso");
    assert.equal(torso.used, 1);        /* one AE tagged torso */
    assert.equal(torso.cap, 2);         /* remaining (3-2=1) + zone used (1) */
});

test("locationsWithFreeAeSlots returns [] once the total AE budget is spent", () => {
    const a = { system: {
        aeSlots: 1,
        torsoMaxStopping: 5,
        appliedEnhancements: [ { uuid: "a", location: "torso" } ]
    } };
    assert.deepEqual(locationsWithFreeAeSlots(a), []);
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
    /* Slot ref carries the chosen location (empty for glyph). buildSlotRef
     * is the sole writer into `applied` — every push routes through it
     * with (enh, location, { baked }). The `baked` flag records whether
     * the enhancement's SP contribution has been written into the parent's
     * base <loc>Stopping fields at attach time. */
    assert.match(dropSrc, /applied\.push\(\s*buildSlotRef\(\s*enh\s*,\s*location\s*,\s*\{\s*baked\s*\}\s*\)\s*\)/);
    assert.match(dropSrc, /function\s+buildSlotRef\s*\(\s*enh\s*,\s*location\s*,\s*\{\s*baked\s*=\s*false\s*\}\s*=\s*\{\}\s*\)/);
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
    /* EO single-budget model: cap is checked once against the total
     * (aeSlotCapTotal / aeSlotsUsed) before branching; a strip-provided
     * `opts.location` then just pins the target zone and skips the picker. */
    assert.match(dropSrc, /const\s+totalCap\s*=\s*eo\.aeSlotCapTotal\(parent\)/);
    assert.match(dropSrc, /const\s+totalUsed\s*=\s*eo\.aeSlotsUsed\(parent\)/);
    assert.match(dropSrc, /if\s*\(opts\.location\)\s*\{[\s\S]*?location\s*=\s*opts\.location/);
});

test("wireEnhancementSlots reads data-enh-pool / data-enh-location from the strip", () => {
    assert.match(dropSrc, /strip\.dataset\?\.enhPool/);
    assert.match(dropSrc, /strip\.dataset\?\.enhLocation/);
});
