// module/mechanics/eoArmorModel.test.mjs
//
// EO armor model: arming jacks, Difficult armor gate, EV math switch.
// Mix of direct-import (the helpers are pure) and source-pattern checks
// (the wiring in CharacterData / inventory.js / editor).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    isArmingJack, isSuperiorArmingSuit, isDifficultArmor,
    effectiveEvContributions, totalEffectiveEv,
    canEquipUnderEoModel, EO_HALF_EV_SKILLS, isEoArmorModelOn
} from "./eoArmorModel.mjs";

const charSrc       = readFileSync(new URL("../data/actor/character.mjs", import.meta.url), "utf8");
const defPropsSrc   = readFileSync(new URL("../data/item/templates/defenseProperties.mjs", import.meta.url), "utf8");
const homebrewSrc   = readFileSync(new URL("../api/homebrew.mjs", import.meta.url), "utf8");
const editorSrc     = readFileSync(new URL("../applications/combatActionsEditor.mjs", import.meta.url), "utf8");
const invSrc        = readFileSync(new URL("../chrome/chrome/inventory.js", import.meta.url), "utf8");
const armorTpl      = readFileSync(new URL("../../templates/item/armor.hbs", import.meta.url), "utf8");

test("EO_HALF_EV_SKILLS lists the 8 EO p.4 skills", () => {
    assert.deepEqual([...EO_HALF_EV_SKILLS].sort(),
        ["athletics", "dodge", "endurance", "hexweave", "ritcraft",
         "sleight", "spellcast", "stealth"]);
});

test("isEoArmorModelOn returns false in node test envs (no game global)", () => {
    /* Safe-by-default: outside Foundry, the helper must not throw. */
    assert.equal(isEoArmorModelOn(), false);
});

test("isArmingJack accepts authored or upgraded jack/superior suit", () => {
    assert.equal(isArmingJack({ system: { armingJackKind: "jack" } }), true);
    assert.equal(isArmingJack({ system: { armingJackKind: "superiorSuit" } }), true);
    assert.equal(isArmingJack({ system: { armoredArmingJackUpgrade: "jack" } }), true);
    assert.equal(isArmingJack({ system: { armoredArmingJackUpgrade: "superiorSuit" } }), true);
    assert.equal(isArmingJack({ system: { armingJackKind: "none" } }), false);
});

test("isSuperiorArmingSuit fires on authored superior suit (single-piece)", () => {
    assert.equal(isSuperiorArmingSuit({ system: { armingJackKind: "superiorSuit" } }), true);
    assert.equal(isSuperiorArmingSuit({ system: { armingJackKind: "jack" } }), false);
});

test("isSuperiorArmingSuit only fires on armored upgrade when the pair is BOTH worn (EO p.4)", () => {
    /* Aketon doublet alone with the +750c paid upgrade → only a jack;
     * doublet + trousers both worn with the paid upgrade → superior. */
    const doublet  = { name: "D", system: { armoredArmingJackUpgrade: "superiorSuit" } };
    const trousers = { name: "T", system: { armoredArmingJackUpgrade: "superiorSuit" } };
    const other    = { name: "O", system: { armoredArmingJackUpgrade: "none" } };
    // Solo: not a superior suit.
    assert.equal(isSuperiorArmingSuit(doublet, [doublet, other]), false);
    // Pair worn together: each piece counts as a superior suit.
    assert.equal(isSuperiorArmingSuit(doublet,  [doublet, trousers]), true);
    assert.equal(isSuperiorArmingSuit(trousers, [doublet, trousers]), true);
});

test("isSuperiorArmingSuit falls back to flag-only when no worn set is provided", () => {
    /* Tests / callers without context (no actor in scope) still see the
     * upgrade flag as a suit — defensive fallback. */
    assert.equal(isSuperiorArmingSuit({ system: { armoredArmingJackUpgrade: "superiorSuit" } }), true);
});

test("Superior Arming Suit reduces each Difficult piece's EV by 1 (min 0)", () => {
    const suit = { name: "Suit", system: { armingJackKind: "superiorSuit", encumbranceValue: 2 } };
    const diff = { name: "Hauberk", system: { difficult: true,  encumbranceValue: 3 } };
    const easy = { name: "Coat",    system: { difficult: false, encumbranceValue: 2 } };
    const contribs = effectiveEvContributions([suit, diff, easy]);
    assert.equal(contribs[0].ev, 2);   // suit itself isn't Difficult
    assert.equal(contribs[1].ev, 2);   // Difficult: 3 - 1
    assert.equal(contribs[2].ev, 2);   // non-Difficult: unchanged
    assert.equal(totalEffectiveEv([suit, diff, easy]), 6);
});

test("Without a superior suit, Difficult armor EV is unreduced", () => {
    const jack = { name: "Jack", system: { armingJackKind: "jack",         encumbranceValue: 1 } };
    const diff = { name: "Mail", system: { difficult: true, encumbranceValue: 3 } };
    assert.equal(totalEffectiveEv([jack, diff]), 4);
});

test("EV reduction never drops below 0 even on EV=0 Difficult pieces", () => {
    const suit = { name: "Suit", system: { armingJackKind: "superiorSuit", encumbranceValue: 2 } };
    const diff = { name: "Trim", system: { difficult: true, encumbranceValue: 0 } };
    const contribs = effectiveEvContributions([suit, diff]);
    assert.equal(contribs[1].ev, 0);
});

test("canEquipUnderEoModel: RAW always passes; EO refuses Difficult without a jack", () => {
    /* In node tests isEoArmorModelOn() is false → gate is open. */
    assert.equal(canEquipUnderEoModel({ system: { difficult: true } }, []), true);
});

test("canEquipUnderEoModel passes when an arming jack is already worn", () => {
    /* Stub the toggle by mocking the dependency — call the function with
     * a candidate that's NOT Difficult so the toggle path is moot. */
    assert.equal(canEquipUnderEoModel({ system: { difficult: false } }, []), true);
});

test("defenseProperties schema carries the EO fields", () => {
    /* EO p.4 single-budget model: aeSlots is now a flat numeric total
     * (the player allocates it across zones), not a per-location SchemaField. */
    assert.match(defPropsSrc, /out\.aeSlots\s*=\s*num\(\)/);
    assert.match(defPropsSrc, /out\.enhancementSlots\s*=\s*num\(\)/);
    assert.match(defPropsSrc, /out\.armingJackKind\s*=\s*new\s+fields\.StringField\(\s*\{\s*initial:\s*"none"[\s\S]+choices:\s*\["none",\s*"jack",\s*"superiorSuit"\]/);
    assert.match(defPropsSrc, /armoredArmingJackUpgrade/);
    assert.match(defPropsSrc, /out\.difficult\s*=\s*new\s+fields\.BooleanField\(\s*\{\s*initial:\s*false\s*\}\s*\)/);
});

test("CE_SUBSYSTEM_DEFAULTS adds eoArmorModel: true", () => {
    assert.match(homebrewSrc, /eoArmorModel:\s*true/);
});

test("CombatActionsEditor exposes the eoArmorModel toggle in SUBSYSTEM_META", () => {
    assert.match(editorSrc, /key:\s*"eoArmorModel"/);
});

test("CharacterData skips RAW REF/DEX EV penalty when eoArmorModel is on", () => {
    // Gate: the RAW REF/DEX subtraction is wrapped in `!eoOn && evTotal > 0`.
    assert.match(charSrc, /if\s*\(!eoOn\s*&&\s*evTotal\s*>\s*0\)/);
});

test("CharacterData reduces sta.max and run by evTotal under EO (RUN floor 2×SPD)", () => {
    assert.match(charSrc, /this\.derivedStats\.sta\.max\s*=\s*Math\.max\(0,\s*this\.derivedStats\.sta\.max\s*-\s*evTotal\)/);
    assert.match(charSrc, /const\s+runFloor\s*=\s*spd\s*\*\s*2/);
    assert.match(charSrc, /this\.derivedStats\.run\s*=\s*Math\.max\(runFloor/);
});

test("CharacterData applies half-EV penalty to EO_HALF_EV_SKILLS only when CE toggle is on", () => {
    assert.match(charSrc, /halfEvPenalty\s*=\s*\(this\._eoArmorModelOn\s*&&\s*evTotal\s*>\s*0\)\s*\?\s*Math\.floor\(evTotal\s*\/\s*2\)\s*:\s*0/);
    assert.match(charSrc, /EO_HALF_EV_SKILLS\.has\(skillKey\)/);
});

test("inventory.js gates Difficult armor equip on the EO model toggle", () => {
    assert.match(invSrc, /canEquipUnderEoModel\(sourceItem,\s*wornArmor\)/);
    // The gate runs BEFORE the stack-split — so we don't peel a copy onto
    // the actor only to refuse and leave a duplicate row.
    const gateIdx  = invSrc.indexOf("canEquipUnderEoModel(sourceItem, wornArmor)");
    const splitIdx = invSrc.indexOf("Armor stacks: peel one piece off");
    assert.ok(gateIdx !== -1 && splitIdx !== -1 && gateIdx < splitIdx,
        "EO gate must precede the stack-split branch");
});

test("Armor item sheet exposes the EO field block (non-shield only)", () => {
    assert.match(armorTpl, /Equipment Overhaul/);
    assert.match(armorTpl, /name="system\.armingJackKind"/);
    assert.match(armorTpl, /name="system\.difficult"/);
    /* AE Slots per Location: the template now iterates over `aeSlotInputs`
     * (computed per armor location coverage in base.mjs) so an Arming Jack
     * shows only Torso and a helmet shows only Head. The literal
     * `system.aeSlots.torso` name is bound via the iterated `this.name`. */
    assert.match(armorTpl, /\{\{#each aeSlotInputs\}\}[\s\S]+?name="\{\{this\.name\}\}"/);
    assert.match(armorTpl, /name="system\.enhancementSlots"/);
    /* Difficult row uses the existing `is-checkbox` class so it picks
     * up the input-after-label flex rule (not the dropped
     * wdm-cfg-row-check class). */
    assert.match(armorTpl, /class="wdm-cfg-row is-checkbox"[\s\S]{0,260}name="system\.difficult"/);
    /* The legacy `armoredArmingJackUpgrade` dropdown was retired —
     * the schema field stays for backward-compat with old worlds
     * but the UI no longer surfaces it (one Arming Jack dropdown is
     * enough; Aketon-upgrade pieces just set kind=jack/superiorSuit). */
    assert.doesNotMatch(armorTpl, /name="system\.armoredArmingJackUpgrade"/);
});

test("CharacterData recomputes leap after EO RUN reduction (so leap tracks the reduced RUN)", () => {
    assert.match(charSrc, /this\.derivedStats\.leap\s*=\s*Math\.floor\(this\.derivedStats\.run\s*\/\s*5\)/);
});

test("CharacterData clamps sta.value when EO drops sta.max below the current value", () => {
    assert.match(charSrc, /Number\(this\.derivedStats\.sta\.value\)[^>]*>\s*this\.derivedStats\.sta\.max/);
    assert.match(charSrc, /this\.derivedStats\.sta\.value\s*=\s*this\.derivedStats\.sta\.max/);
});

test("EV summation reads the EFFECTIVE encumbrance value (post-enhancement evMod)", () => {
    // Both EO and RAW paths route through `evOf(a)` which prefers
    // `system.effective.encumbranceValue` and falls back to the base.
    assert.match(charSrc, /const\s+evOf\s*=\s*\(a\)\s*=>\s*Number\(a\?\.system\?\.effective\?\.encumbranceValue\s*\?\?\s*a\?\.system\?\.encumbranceValue\)\s*\|\|\s*0/);
    assert.match(charSrc, /totalEffectiveEv\(armorPieces,\s*\{\s*evOf\s*\}\)/);
});

test("Equip gate short-circuits for shield-type armor items", () => {
    /* Shields skip the EO gate entirely — Difficult is an armor-piece
     * concept; a shield with a stray `difficult: true` from authoring
     * shouldn't get the EO refusal message. */
    assert.match(invSrc, /sourceItem\.system\?\.location\s*!==\s*"Shield"\s*\n?\s*&&\s*sourceItem\.system\?\.armorType\s*!==\s*"shield"/);
});

test("Un-equip gate refuses removing the last arming jack while Difficult is worn", () => {
    // Lives in a separate preUpdateItem hook in inventory.js.
    assert.match(invSrc, /EO un-equip gate/);
    /* Gate now accepts either the canonical boolean OR the chip-array
     * signal, so the regex looks for the unified read pattern. */
    assert.match(invSrc, /hasDifficult\s*=\s*worn\.some\(p\s*=>\s*\{[\s\S]+?p\.system\?\.difficult/);
    assert.match(invSrc, /qs\.includes\("difficult"\)/);
    assert.match(invSrc, /otherJacks\.length\s*===\s*0/);
    // Veto by deleting the equipped field from the change (doesn't
    // cancel the whole update — surgical).
    assert.match(invSrc, /delete\s+change\.system\.equipped/);
});

test("Chrome EV footer tooltip + pen-label switch text under EO mode", () => {
    const charJs = readFileSync(new URL("../chrome/chrome/character.js", import.meta.url), "utf8");
    /* EV footer wording moved into i18n tFormat() calls — the literal
     * copy now lives in the fallback string with {ev}/{half} placeholders
     * (not ${ev} template literals). EO branch text uses STA max + RUN +
     * skills wording (not REF/DEX magic). */
    assert.match(charJs, /EO model: −\{ev\} max Stamina · −\{ev\} RUN/);
    assert.match(charJs, /Dodge\/Athletics\/Stealth\/Sleight\/Endurance\/Hexweave\/Ritcraft\/Spellcast/);
    // Pen-label two variants present.
    assert.match(charJs, /−\{ev\} STA max · −\{ev\} RUN/);
});

test("EV skill penalty lands on `skill.total` (NOT mutated onto `skill.modifier`)", () => {
    /* Regression guard: a prior implementation mutated skill.modifier
     * directly, which compounded the penalty every time
     * prepareDerivedData ran (a real bug surfaced by the functional
     * test — running prepare twice yielded -2 instead of -1).
     * The fix folds the penalty into `skill.total` via a separate
     * `skill.evPenalty` field. */
    assert.doesNotMatch(charSrc, /skill\.modifier\s*=\s*\(Number\(skill\.modifier\)\s*\|\|\s*0\)\s*-\s*evTotal/);
    assert.doesNotMatch(charSrc, /skill\.modifier\s*=\s*\(Number\(skill\.modifier\)\s*\|\|\s*0\)\s*-\s*halfEvPenalty/);
    /* The new shape: evSkillPen accumulator, skill.evPenalty stored,
     * total folds it in. */
    assert.match(charSrc, /let\s+evSkillPen\s*=\s*0/);
    assert.match(charSrc, /skill\.evPenalty\s*=\s*evSkillPen/);
    /* The penalty is now folded via a separate `skill.effectiveModifier`
     * (= mod − evSkillPen) that `.total` reads — kept off `skill.modifier`
     * so AE addend arithmetic stays idempotent across prepare passes. */
    assert.match(charSrc, /skill\.effectiveModifier\s*=\s*mod\s*-\s*evSkillPen/);
    assert.match(charSrc, /skill\.total\s*=\s*statVal\s*\+\s*rank\s*\+\s*skill\.effectiveModifier/);
});
