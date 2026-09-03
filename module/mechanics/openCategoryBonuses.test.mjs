// module/mechanics/openCategoryBonuses.test.mjs
//
// Parser + context detection for EO open-category quality bonuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    parseOpenCategoryBonus,
    getActiveOpenCategoryBonuses,
    sumOpenCategoryWa,
    damageTailFromOpenCategory,
    grantedQualitiesFromOpenCategory,
    grantedQualityValuesFromOpenCategory,
    strangleSuffocation,
    OPEN_CATEGORY_QUALITY_KEYS
} from "./openCategoryBonuses.mjs";

test("Strangling text parses a flat suffocation add and a multiplier (garrote ×3)", () => {
    const flat = parseOpenCategoryBonus("+2 suffocation");
    assert.equal(flat.suffocation, 2);
    assert.equal(flat.suffocationMult, 1);
    const garrote = parseOpenCategoryBonus("×3 suffocation");
    assert.equal(garrote.suffocationMult, 3);
    const both = parseOpenCategoryBonus("+2 WA, +1 suffocation, x2 suffocation");
    assert.equal(both.wa, 2);
    assert.equal(both.suffocation, 1);
    assert.equal(both.suffocationMult, 2);
});

test("strangleSuffocation reads the weapon's Strangling open-category bonus", () => {
    const garrote = { system: { qualities: ["strangling"], qualityValues: { strangling: "×3 suffocation" } } };
    assert.deepEqual(strangleSuffocation(garrote), { flat: 0, mult: 3 });
    // No weapon (unarmed Brawling) → no bonus.
    assert.deepEqual(strangleSuffocation(null), { flat: 0, mult: 1 });
    // A plain grappling weapon (no strangling) → no suffocation bonus.
    const plain = { system: { qualities: ["grappling"], qualityValues: {} } };
    assert.deepEqual(strangleSuffocation(plain), { flat: 0, mult: 1 });
});

const mixinSrc = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");

test("OPEN_CATEGORY_QUALITY_KEYS lists the four combat-relevant EO open qualities", () => {
    assert.deepEqual([...OPEN_CATEGORY_QUALITY_KEYS].sort(),
        ["closeQuarters", "strangling", "throwing", "twoHand"]);
});

test("parseOpenCategoryBonus extracts +N WA and +NdM Dmg fragments", () => {
    const r = parseOpenCategoryBonus("+1 WA, +1d6 Dmg");
    assert.equal(r.wa, 1);
    assert.equal(r.dmgDice, "1d6");
    assert.deepEqual(r.grantedQualities, []);
    assert.equal(r.raw, "+1 WA, +1d6 Dmg");
});

test("parseOpenCategoryBonus handles WA-only and dice-only authoring", () => {
    const a = parseOpenCategoryBonus("+2 WA");
    assert.equal(a.wa, 2); assert.equal(a.dmgDice, ""); assert.deepEqual(a.grantedQualities, []);
    const b = parseOpenCategoryBonus("+2d6 damage");
    assert.equal(b.wa, 0); assert.equal(b.dmgDice, "2d6"); assert.deepEqual(b.grantedQualities, []);
});

test("parseOpenCategoryBonus detects a granted-quality LABEL in the bonus text", () => {
    /* Estoc's "Close Quarters (Improved Armor Piercing)" — should
     * capture both the parsed WA/dice (none here) AND the granted
     * quality key. */
    const r = parseOpenCategoryBonus("Improved Armor Piercing");
    assert.deepEqual(r.grantedQualities, ["improvedArmorPiercing"]);
    /* Longer-label wins over shorter substring: "Improved Armor
     * Piercing" should NOT also match "Armor Piercing". */
    assert.equal(r.grantedQualities.includes("armorPiercing"), false);
});

test("parseOpenCategoryBonus combines all three: WA + dice + granted qualities", () => {
    const r = parseOpenCategoryBonus("+2 WA, +1d6 Dmg, Improved Armor Piercing");
    assert.equal(r.wa, 2);
    assert.equal(r.dmgDice, "1d6");
    assert.deepEqual(r.grantedQualities, ["improvedArmorPiercing"]);
});

test("parseOpenCategoryBonus handles negative WA and case-insensitive dmg label", () => {
    const r = parseOpenCategoryBonus("-1 Hit, +1d3 DMG");
    assert.equal(r.wa, -1);
    assert.equal(r.dmgDice, "1d3");
});

test("parseOpenCategoryBonus captures a flat +N Dmg (no dice) as dmgFlat", () => {
    // Doryo-style two-hand text: flat "+2 Dmg" carries no dice expression
    // and used to be dropped silently by the dice-only regex.
    const r = parseOpenCategoryBonus("+1 WA, +2 Dmg");
    assert.equal(r.wa, 1);
    assert.equal(r.dmgDice, "");
    assert.equal(r.dmgFlat, 2);
});

test("damageTailFromOpenCategory folds dmgFlat contributions into the tail", () => {
    const bonuses = [
        { key: "twoHand", label: "Two-Hand", wa: 1, dmgDice: "", dmgFlat: 2, raw: "+1 WA, +2 Dmg" },
        { key: "closeQuarters", label: "Close Quarters", wa: 0, dmgDice: "1d6", dmgFlat: 0, raw: "+1d6 Dmg" }
    ];
    assert.equal(damageTailFromOpenCategory(bonuses), "+ 2 + 1d6");
});

test("parseOpenCategoryBonus captures inline (value) for parameterized granted qualities", () => {
    const r = parseOpenCategoryBonus("+1 WA, Bleeding(25%), Stun(-2)");
    assert.equal(r.wa, 1);
    assert.deepEqual(r.grantedQualities, ["bleeding", "stun"]);
    assert.equal(r.grantedQualityValues.bleeding, "25%");
    assert.equal(r.grantedQualityValues.stun, "-2");
});

test("parseOpenCategoryBonus tolerates a granted quality with no inline value", () => {
    const r = parseOpenCategoryBonus("Improved Armor Piercing");
    assert.deepEqual(r.grantedQualities, ["improvedArmorPiercing"]);
    assert.deepEqual(r.grantedQualityValues, {});
});

test("grantedQualityValuesFromOpenCategory merges values across active bonuses", () => {
    const bonuses = [
        { key: "closeQuarters", grantedQualityValues: { bleeding: "25%" } },
        { key: "twoHand",       grantedQualityValues: { stun: "-2" } }
    ];
    const merged = grantedQualityValuesFromOpenCategory(bonuses);
    assert.equal(merged.bleeding, "25%");
    assert.equal(merged.stun, "-2");
});

test("weaponAttackMixin merges granted-quality VALUES into riderPayload (fills gaps only)", () => {
    assert.match(mixinSrc, /openCatGrantedQualityValues\s*=\s*grantedQualityValuesFromOpenCategory/);
    assert.match(mixinSrc, /riderPayload\.values\[q\]\s*=\s*v/);
});

test("end-to-end: dialog format \"Bleeding(25)\" → parser → activeBonuses → riderPayload-ready value", () => {
    /* This is the bus the user complained about: granted qualities
     * never reached combat because the dialog stored "Bleeding" with
     * no value (rider then fired at 0%). The fix path:
     *   1. Dialog writes canonical "Bleeding(25)" into qualityValues.twoHand
     *   2. parseOpenCategoryBonus picks it up via grantedQualityValues
     *   3. getActiveOpenCategoryBonuses surfaces it on the active bonus
     *   4. grantedQualityValuesFromOpenCategory flattens to { bleeding: "25" }
     *   5. weaponAttackMixin writes that into riderPayload.values
     *   6. applyQualityRiders does Number("25") = 25 and rolls vs 25%. */
    const weapon = {
        system: {
            qualities: ["twoHand"],
            qualityValues: { twoHand: "+1 WA, Bleeding(25)" }
        }
    };
    const fired = getActiveOpenCategoryBonuses(weapon, { isTwoHandedWield: true });
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0].grantedQualities, ["bleeding"]);
    assert.equal(fired[0].grantedQualityValues.bleeding, "25");
    const merged = grantedQualityValuesFromOpenCategory(fired);
    assert.equal(merged.bleeding, "25");
    /* The rider engine coerces with Number(); confirm "25" round-trips
     * to the integer 25 (NOT NaN as it did with the old "25%" format). */
    assert.equal(Number(merged.bleeding), 25);
});

test("end-to-end: granted DAMAGE FLAG keys reach the damage flow via riderPayload.keys", () => {
    /* Improved Armor Piercing is a damage-flag quality (no rider, just a
     * boolean on damageFlags). When granted via Close Quarters, its key
     * must land in riderPayload.keys so qualitiesToDamageFlags() picks
     * it up at damage application time. We test the upstream side
     * (active bonus exposes it) and assert the mixin writes the key
     * through. */
    const weapon = {
        system: {
            qualities: ["closeQuarters"],
            qualityValues: { closeQuarters: "Improved Armor Piercing" }
        }
    };
    const fired = getActiveOpenCategoryBonuses(weapon, { isCloseQuartersContext: true });
    assert.deepEqual(fired[0].grantedQualities, ["improvedArmorPiercing"]);
    const merged = grantedQualitiesFromOpenCategory(fired);
    assert.ok(merged.includes("improvedArmorPiercing"));
    // The mixin writes each merged key into riderPayload.keys (the same
    // array that gets serialized into the damage button's data-qualities
    // and read back by qualitiesToDamageFlags).
    assert.match(mixinSrc, /openCatGrantedQualities\.length\s*\)\s*\{[\s\S]+?if\s*\(\s*!\s*riderPayload\.keys\.includes\(\s*q\s*\)\s*\)\s*riderPayload\.keys\.push\(\s*q\s*\)/);
});

test("end-to-end: granted Stun(-2) becomes a stunSave rider with the right modifier", () => {
    /* Stun's rider.kind = "stunSave"; applyQualityRiders does
     * parseInt("-2") = -2 and posts a Stun-save prompt with that
     * modifier. The granted value reaches it via riderPayload.values
     * the same way Bleeding's % does. */
    const weapon = {
        system: {
            qualities: ["twoHand"],
            qualityValues: { twoHand: "Stun(-2)" }
        }
    };
    const fired = getActiveOpenCategoryBonuses(weapon, { isTwoHandedWield: true });
    assert.deepEqual(fired[0].grantedQualities, ["stun"]);
    const merged = grantedQualityValuesFromOpenCategory(fired);
    assert.equal(merged.stun, "-2");
    assert.equal(parseInt(String(merged.stun), 10), -2);
});

test("end-to-end: granted Silver(2d6) carries a damage formula string downstream", () => {
    const weapon = {
        system: {
            qualities: ["closeQuarters"],
            qualityValues: { closeQuarters: "Silver(2d6)" }
        }
    };
    const fired = getActiveOpenCategoryBonuses(weapon, { isCloseQuartersContext: true });
    assert.deepEqual(fired[0].grantedQualities, ["silver"]);
    const merged = grantedQualityValuesFromOpenCategory(fired);
    assert.equal(merged.silver, "2d6");
    // Silver dice should pass through as a string for the damage formula.
    assert.equal(typeof merged.silver, "string");
});

test("end-to-end: base weapon's Bleeding% is preserved when open-cat ALSO grants Bleeding without value", () => {
    /* Gap-fill rule: granted-quality values only fill gaps in
     * riderPayload.values. A weapon that natively has Bleeding 15% must
     * keep that 15% even if Close Quarters also grants Bleeding (with
     * no inline value). */
    const weapon = {
        system: {
            qualities: ["bleeding", "closeQuarters"],
            qualityValues: { bleeding: "15", closeQuarters: "Bleeding" }
        }
    };
    const fired = getActiveOpenCategoryBonuses(weapon, { isCloseQuartersContext: true });
    assert.equal(fired.length, 1);
    const merged = grantedQualityValuesFromOpenCategory(fired);
    // No value attached to the granted bleeding (just the label).
    assert.equal(merged.bleeding, undefined);
});

test("parseOpenCategoryBonus returns null for empty / whitespace text", () => {
    assert.equal(parseOpenCategoryBonus(""), null);
    assert.equal(parseOpenCategoryBonus("   "), null);
    assert.equal(parseOpenCategoryBonus(undefined), null);
});

test("getActiveOpenCategoryBonuses fires Close Quarters only when ctx flag is set", () => {
    const weapon = { system: { qualities: ["closeQuarters"], qualityValues: { closeQuarters: "+1 WA, +1d6 Dmg" } } };
    assert.deepEqual(getActiveOpenCategoryBonuses(weapon, { isCloseQuartersContext: false }), []);
    const fired = getActiveOpenCategoryBonuses(weapon, { isCloseQuartersContext: true });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].key, "closeQuarters");
    assert.equal(fired[0].wa, 1);
    assert.equal(fired[0].dmgDice, "1d6");
});

test("getActiveOpenCategoryBonuses skips empty-text qualities (narrative-only)", () => {
    const weapon = { system: { qualities: ["closeQuarters"], qualityValues: { closeQuarters: "" } } };
    assert.deepEqual(getActiveOpenCategoryBonuses(weapon, { isCloseQuartersContext: true }), []);
});

test("getActiveOpenCategoryBonuses respects effective overlay over base", () => {
    const weapon = {
        system: {
            qualities: [],
            qualityValues: {},
            effective: { qualities: ["twoHand"], qualityValues: { twoHand: "+1 WA, +1d6 Dmg" } }
        }
    };
    const fired = getActiveOpenCategoryBonuses(weapon, { isTwoHandedWield: true });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].key, "twoHand");
});

test("sumOpenCategoryWa + damageTailFromOpenCategory aggregate correctly", () => {
    const bonuses = [
        { key: "closeQuarters", label: "Close Quarters", wa: 1, dmgDice: "1d6", raw: "+1 WA, +1d6 Dmg" },
        { key: "twoHand",       label: "Two-Hand",       wa: 2, dmgDice: "1d3", raw: "+2 WA, +1d3 Dmg" }
    ];
    assert.equal(sumOpenCategoryWa(bonuses), 3);
    assert.equal(damageTailFromOpenCategory(bonuses), "+ 1d6 + 1d3");
});

test("damageTailFromOpenCategory returns '' when no dice fragments present", () => {
    const bonuses = [{ key: "closeQuarters", label: "x", wa: 1, dmgDice: "", raw: "+1 WA" }];
    assert.equal(damageTailFromOpenCategory(bonuses), "");
});

test("parseOpenCategoryBonus refuses to grant OPEN-CATEGORY keys (no nesting)", () => {
    /* An OC bonus text can mention other OC labels ("Close Quarters",
     * "Two-Hand", "Throwing", "Strangling") — either by GM typo or by a
     * mis-authored pack. The parser must NOT grant them: OC firing is
     * gated on the weapon's `qualities` list PLUS its context
     * predicate; granting one from within another's bonus text creates
     * a misleading chip on the card (a Close Quarters chip that never
     * actually fires the CQ bonus) and could cascade confusing state.
     * Non-OC labels in the same string still work — the skip is
     * specifically on OPEN_CATEGORY_QUALITY_KEYS.
     *
     * The structured OC config dialog already prevents this at the UI
     * layer (its SKIP_KEYS set); this test guards the raw-parser path
     * for pack authors and paste-in text. */
    const r = parseOpenCategoryBonus("+2 WA, Close Quarters, Throwing, Strangling, Two-Hand, Armor Piercing");
    /* Non-OC still grants. */
    assert.ok(r.grantedQualities.includes("armorPiercing"), "armorPiercing should still grant");
    /* OC keys are skipped. */
    assert.equal(r.grantedQualities.includes("closeQuarters"), false, "closeQuarters must NOT grant");
    assert.equal(r.grantedQualities.includes("throwing"), false, "throwing must NOT grant");
    assert.equal(r.grantedQualities.includes("strangling"), false, "strangling must NOT grant");
    assert.equal(r.grantedQualities.includes("twoHand"), false, "twoHand must NOT grant");
});

test("weaponAttackMixin pulls the helper and folds wa+tail into the math", () => {
    assert.match(mixinSrc, /import\s*\{\s*getActiveOpenCategoryBonuses\s*,\s*sumOpenCategoryWa\s*,\s*damageTailFromOpenCategory\s*,\s*grantedQualitiesFromOpenCategory\s*,\s*grantedQualityValuesFromOpenCategory\s*,\s*strangleSuffocation\s*\}/);
    // The context detection covers the four firing predicates.
    assert.match(mixinSrc, /isCloseQuartersContext\s*:/);
    assert.match(mixinSrc, /isTwoHandedWield\s*:/);
    assert.match(mixinSrc, /isThrown\s*:/);
    assert.match(mixinSrc, /isChokehold\s*:/);
    // openCatWa is folded into grandMod alongside guard/status.
    assert.match(mixinSrc, /\+\s*openCatWa\s*\+/);
    // openCatTail is appended to BOTH display + formula (so the chat
    // card text and the rollable expression agree).
    assert.match(mixinSrc, /mainDamage\.display\s*=\s*[^;]*openCatTail/);
    assert.match(mixinSrc, /mainDamage\.formula\s*=\s*[^;]*openCatTail/);
    // Granted qualities from the parsed bonus text union into the
    // strike's rider payload so e.g. Improved Armor Piercing on
    // Estoc's Close Quarters actually fires post-hit.
    assert.match(mixinSrc, /openCatGrantedQualities\s*=\s*grantedQualitiesFromOpenCategory/);
    assert.match(mixinSrc, /riderPayload\.keys\.push\(q\)/);
});
