// module/setup/disarmAction.test.mjs
//
// Disarm — a grapple action made at −4. You must be in a grapple. Opposed
// Brawling (or a Grappling weapon's skill) vs the foe's Brawling (or Grappling
// weapon) or Dodge/Escape. On a win: PUNCH damage to the weapon ARM, then the
// weapon is knocked 1d6m in a random direction — or the attacker may make a
// DC 18 Brawling check to snatch it instead. Usable unarmed (brawl) or with a
// Grappling weapon (melee dialog).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cfgSrc   = readFileSync(new URL("./config.mjs", import.meta.url), "utf8");
const brawlSrc = readFileSync(new URL("../documents/mixins/brawlMixin.mjs", import.meta.url), "utf8");
const actSrc   = readFileSync(new URL("../data/combatExtended/actions.mjs", import.meta.url), "utf8");
const defSrc   = readFileSync(new URL("../applications/defensePromptDialog.mjs", import.meta.url), "utf8");
const gwSrc    = readFileSync(new URL("../mechanics/grappleWeapon.mjs", import.meta.url), "utf8");
const langSrc  = readFileSync(new URL("../../lang/en.json", import.meta.url), "utf8");

test("config: grapple disarm — punch dmg, needs grapple; the −4 is CE-only (ceToHitMod)", () => {
    // The grapple disarm (BRAWL_ACTIONS) — distinct from the RAW weapon-strike
    // disarm; match the entry that carries kind:"grapple".
    const line = cfgSrc.match(/disarm:\s*\{[^}]*kind:\s*"grapple"[^}]*\}/)?.[0] ?? "";
    assert.match(line, /damage:\s*"punch"/);
    assert.match(line, /needsGrapple:\s*true/);
    assert.match(line, /isDisarm:\s*true/);
    // −4 is a Combat-Extended-only modifier (applied only when CE is on).
    assert.match(line, /ceToHitMod:\s*-4/);
    assert.doesNotMatch(line, /\btoHitMod:/);
});

test("brawlMixin: disarm forces the WEAPON ARM location (no extra penalty, ½ mult)", () => {
    assert.match(brawlSrc, /if \(meta\.isDisarm\)\s*\{[\s\S]+?mode:\s*"specific",\s*key:\s*"leftArm"[\s\S]+?mult:\s*def\?\.mult\s*\?\?\s*0\.5/);
});

test("brawlMixin: disarm rider rolls the 1d6 toss + offers the DC 18 steal", () => {
    const rider = brawlSrc.match(/if \(meta\.isDisarm && opposedTarget && throwSucceeded[\s\S]+?ChatMessage\.create\(\{ content: html, speaker \}\)/)?.[0] ?? "";
    assert.match(rider, /new Roll\("1d8"\)\.evaluate\(\)/);
    assert.match(rider, /new Roll\("1d6"\)\.evaluate\(\)/);
    assert.match(rider, /DisarmTossed/);
    assert.match(rider, /DisarmSteal/);
    assert.match(rider, /DC18Brawling/);
    // The old CE-only enhancement + injection are gone.
    assert.doesNotMatch(brawlSrc, /ceDisarmRider|ceDisarmEnhanced|_ceOn/);
});

test("defense: disarm resisted with Brawling (or grappling weapon) or Dodge/Escape", () => {
    assert.match(defSrc, /disarm:\s*\{ parry: false, block: false, dodge: true, reposition: true, brawlBlock: true \}/);
    assert.match(gwSrc, /GRAPPLE_DEFENSE_KINDS[\s\S]+?"disarm"/);
});

test("CE melee action: disarm is −4, grapple-gated, needs the Grappling quality", () => {
    const block = actSrc.match(/disarm:\s*Object\.freeze\(\{[\s\S]+?\}\)/)?.[0] ?? "";
    assert.match(block, /toHit:\s*-4/);
    assert.match(block, /requiresQuality:\s*"grappling"/);
    assert.match(block, /prereq:\s*"grappling"/);
});

test("the grapple disarm is relabelled 'Grapple Disarm' to avoid confusion", () => {
    assert.match(langSrc, /"WITCHER\.Brawl\.Disarm":\s*"Grapple Disarm"/);
    assert.match(langSrc, /"WITCHER\.CombatExtended\.Action\.Disarm":\s*"Grapple Disarm"/);
});

test("Melee Disarm is a MELEE-WEAPON combat action: −6, ungated, no steal", () => {
    // A CE combat action (shows in the melee attack dialog), not a brawl action.
    const wamActSrc = readFileSync(new URL("../data/combatExtended/actions.mjs", import.meta.url), "utf8");
    const block = wamActSrc.match(/meleeDisarm:\s*Object\.freeze\(\{[\s\S]+?\}\)/)?.[0] ?? "";
    assert.match(block, /toHit:\s*-6/);
    assert.match(block, /meleeOnly:\s*true/);
    // No grapple prereq + no required quality → shows for ANY melee weapon.
    assert.doesNotMatch(block, /prereq/);
    assert.doesNotMatch(block, /requiresQuality/);
    // Not a brawl action anymore.
    assert.doesNotMatch(cfgSrc, /meleeDisarm:/);
    // Weapon scatter handles it, and the DC18 steal is grapple-disarm ONLY.
    const wamSrc = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
    assert.match(wamSrc, /decl\.strike === "disarm" \|\| decl\.strike === "meleeDisarm"/);
    assert.match(wamSrc, /\(decl\.strike === "disarm"\)[\s\S]+?DC18Brawling[\s\S]+?:\s*""/);
});

test("the (grapple) disarm is OPPOSED; the DC18 steal is CE-only", () => {
    // Grapple disarm carries no hold status → folded into the opposed check + the
    // "disarm" defense gate.
    assert.match(brawlSrc, /isOpposedAction\s*=\s*\(isGrapple\s*\|\|\s*isPlainAttack\s*\|\|\s*meta\.isDisarm\)/);
    assert.match(brawlSrc, /attackKind:\s*meta\.isDisarm\s*\?\s*"disarm"/);
    // The steal line shows only when Combat Extended is on (and not noSteal).
    assert.match(brawlSrc, /stealTxt\s*=\s*\(isCombatExtendedEnabled\(\) && !meta\.noSteal\)/);
});
