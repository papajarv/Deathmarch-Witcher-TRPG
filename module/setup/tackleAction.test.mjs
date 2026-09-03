// module/setup/tackleAction.test.mjs
//
// Tackle — a MELEE-WEAPON combat action (shows in the melee attack dialog), NOT
// a grappling/brawl action. A full-round smash resolved by opposed PHYSIQUE
// (auto-rolled): win → you both go prone; lose → only you go prone. No weapon
// roll / no damage — resolved by the tackle branch in weaponAttackMixin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cfgSrc   = readFileSync(new URL("./config.mjs", import.meta.url), "utf8");
const actSrc   = readFileSync(new URL("../data/combatExtended/actions.mjs", import.meta.url), "utf8");
const wamSrc   = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");

test("Tackle is a full-round melee CE action, not a brawl/grapple action", () => {
    const block = actSrc.match(/tackle:\s*Object\.freeze\(\{[\s\S]+?\}\)/)?.[0] ?? "";
    assert.match(block, /fullRound:\s*true/);
    assert.match(block, /meleeOnly:\s*true/);
    assert.match(block, /noDamage:\s*true/);
    assert.doesNotMatch(block, /prereq/);        // shows for any melee weapon
    // Not a brawl action.
    assert.doesNotMatch(cfgSrc, /tackle:\s*\{/);
});

test("weaponAttackMixin: tackle resolves opposed Physique; you always prone, foe on win", () => {
    // Scope to the tackle branch (from its guard to the header card).
    const branch = wamSrc.match(/if \(decl\?\.strike === "tackle"\)[\s\S]+?TackleHeader/)?.[0] ?? "";
    // Opposed Physique = physique base + rollWitcherD10, both sides.
    assert.match(branch, /rollWitcherD10/);
    assert.match(branch, /physBase[\s\S]+?body\?\.value[\s\S]+?skills\?\.body\?\.physique\?\.value/);
    assert.match(branch, /won = myTotal > theirTotal/);
    // You always go prone; the foe only on a win. Prone routed through the GM.
    assert.match(branch, /emitApplyStatus\(\{ targetUuid: this\.uuid, statusId: "prone"/);
    assert.match(branch, /if \(won\)[\s\S]+?emitApplyStatus\(\{ targetUuid: _defenderActor\.uuid, statusId: "prone"/);
    // Skips the weapon roll + records the full round.
    assert.match(wamSrc, /strike === "tackle"[\s\S]+?recordFullRound/);
    // Mirrors the drag weapon-branch precedent (special strike, early return).
    assert.match(wamSrc, /if \(decl\?\.strike === "drag"\)/);
});

test("Tackle is ARMED like Charge: dock Full Round → tackling status → melee dialog shows it only then", () => {
    const dockSrc = readFileSync(new URL("../chrome/chrome/dock.js", import.meta.url), "utf8");
    const seSrc   = readFileSync(new URL("./statusEffects.mjs", import.meta.url), "utf8");
    const dlgSrc  = readFileSync(new URL("../applications/attackDialog.mjs", import.meta.url), "utf8");
    // Full-Round dock option + handler + arming flow (grant SPD×3 + tackling).
    assert.match(dockSrc, /key:\s*"tackle"[\s\S]+?TackleSPD3/);
    assert.match(dockSrc, /btn\.dataset\.key === "tackle"[\s\S]+?openTackleFlow\(actor\)/);
    const flow = dockSrc.match(/async function openTackleFlow\(actor\)\s*\{[\s\S]+?\n\}/)?.[0] ?? "";
    assert.match(flow, /combatRound\.runUsed":\s*true/);
    assert.match(flow, /toggleStatusEffect\?\.\("tackling",\s*\{ active: true \}\)/);
    // `tackling` status exists.
    assert.match(seSrc, /id:\s*"tackling"/);
    // Melee dialog: when tackling, the picker is restricted to Tackle (like charging);
    // Tackle is excluded from the normal Special Attacks group.
    assert.match(dlgSrc, /_isTackling = !!ctx\.actor\?\.statuses\?\.has\?\.\("tackling"\)/);
    assert.match(dlgSrc, /else if \(_isTackling\)[\s\S]+?key === "tackle"[\s\S]+?defaultStrike = "tackle"/);
    assert.match(dlgSrc, /key !== "charge" && key !== "tackle"/);
    // weaponAttack strips the tackling status on commit.
    assert.match(wamSrc, /_wasTackling = !!this\.statuses\?\.has\?\.\("tackling"\)/);
    assert.match(wamSrc, /if \(_wasTackling\)[\s\S]+?toggleStatusEffect\?\.\("tackling",\s*\{ active: false \}\)/);
});
