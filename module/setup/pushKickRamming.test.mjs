// module/setup/pushKickRamming.test.mjs
//
// Push Kick — when the shove knocks the target into a wall, deal a FLAT 1d6
// ramming damage (like Slam's ramming): bludgeoning to the torso, bypassing
// worn/natural armour but NOT a magic shield (Quen/Barrier soaks it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cfgSrc   = readFileSync(new URL("./config.mjs", import.meta.url), "utf8");
const brawlSrc = readFileSync(new URL("../documents/mixins/brawlMixin.mjs", import.meta.url), "utf8");
const wamSrc   = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");

test("config: pushKick carries a FLAT 1d6 wall-ramming formula", () => {
    const line = cfgSrc.match(/pushKick:\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(line, /wallRamming:\s*true/);
    assert.match(line, /wallRammingFormula:\s*"1d6"/);
    // Non-lethal is NOT forced here — the natural-weapon damage-type selection
    // handles that; forcing meta.nonLethal double-applied and bugged it.
    assert.doesNotMatch(line, /nonLethal/);
});

test("bash: knocking the target into a wall deals a Quen-soakable 1d6 ramming", () => {
    const block = wamSrc.match(/if \(res\?\.hitWall\)[\s\S]+?bash wall ramming failed/)?.[0] ?? "";
    assert.match(block, /new Roll\("1d6"\)\.evaluate\(\)/);
    assert.match(block, /bypassesWornArmor: true, bypassesNaturalArmor: true/);
    assert.doesNotMatch(block, /bypassesMagicShield|bypassMagicShield|ignoreShield/);
});

test("brawlMixin: wall ramming uses the flat formula when present, else per-2m scaling", () => {
    // Gate is now just wallRamming + wall hit (no moved>=2 requirement for the flat case).
    assert.match(brawlSrc, /if \(meta\.wallRamming && clipped\)/);
    // Flat branch (Push Kick) then the scaling branch (Push / Slam).
    assert.match(brawlSrc, /if \(meta\.wallRammingFormula\)\s*\{[\s\S]+?new Roll\(meta\.wallRammingFormula\)[\s\S]+?else if \(moved >= 2\)[\s\S]+?\$\{inc\}d6/);
});

test("wall ramming stays Quen-soakable (bypasses worn/natural armour, not magic shield)", () => {
    // The ramming apply bypasses worn + natural armour but never sets a
    // magic-shield bypass — so Quen/Barrier catches it (same as Slam).
    const block = brawlSrc.match(/if \(meta\.wallRamming && clipped\)[\s\S]+?sourceLabel: "Ramming"/)?.[0] ?? "";
    assert.match(block, /bypassesWornArmor: true, bypassesNaturalArmor: true/);
    assert.doesNotMatch(block, /bypassesMagicShield|bypassMagicShield|ignoreShield/);
});
