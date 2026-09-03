// module/setup/chokeAction.test.mjs
//
// Choke rework: a PIN-gated HOLD performed with Brawling or a Strangling weapon
// (not plain grappling). Deals 3 + melee bonus (+ Strangling) suffocation
// THROUGH armor, per action spent (normal ×1 / extra ×2). Maintained by
// re-Choking every turn; an un-maintained choke releases on the next turn.
// Resisted with Brawling (or a Grappling weapon) — no dodge/escape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { weaponUsesBrawlingSkill, findGrappleWeapon } from "../mechanics/grappleWeapon.mjs";

const cfgSrc   = readFileSync(new URL("./config.mjs", import.meta.url), "utf8");
const adSrc    = readFileSync(new URL("../applications/attackDialog.mjs", import.meta.url), "utf8");
const bdSrc    = readFileSync(new URL("../applications/brawlDialog.mjs", import.meta.url), "utf8");

test("a Brawling-skill weapon counts as a wrestling weapon (actions + defenses)", () => {
    const brawlWpn = { type: "weapon", system: { skillKey: "brawling", qualities: [] } };
    const swordWpn = { type: "weapon", system: { skillKey: "swordsmanship", qualities: [] } };
    assert.equal(weaponUsesBrawlingSkill(brawlWpn), true);
    assert.equal(weaponUsesBrawlingSkill(swordWpn), false);
    // findGrappleWeapon (defense side) accepts a brawling-skill weapon with no Grappling quality.
    const actor = { items: { find: (fn) => [brawlWpn, swordWpn].find(fn) ?? null } };
    assert.equal(findGrappleWeapon(actor), brawlWpn);
});

test("attackDialog: a Brawling-skill weapon satisfies the grappling/strangling gate", () => {
    assert.match(adSrc, /need === "grappling"\s*\|\|\s*need === "strangling"\)\s*&&\s*weaponUsesBrawlingSkill\(weapon\)/);
});

test("choke greys with 'needs pinned target' (CE) — brawl dialog branches to grapple in RAW", () => {
    // Melee dialog (prereq "pinning") — the CE strangling-weapon choke.
    assert.match(adSrc, /s\.prereq === "pinning" && !passesPrereq\(s\)\)\s*return\s*"needs pinned target"/);
    // Brawl dialog: CE greys until PINNED; RAW greys until GRAPPLING.
    assert.match(bdSrc, /chokeNeedsPinBlocked\s*=\s*a\.needsPin === true && \(_ceOn/);
    assert.match(bdSrc, /chokeNeedsPinBlocked\)\s*bits\.push\(_ceOn\s*\?\s*"needs pinned target"\s*:\s*"no grapple"\)/);
});
const actSrc   = readFileSync(new URL("../data/combatExtended/actions.mjs", import.meta.url), "utf8");
const defSrc   = readFileSync(new URL("../applications/defensePromptDialog.mjs", import.meta.url), "utf8");
const brawlSrc = readFileSync(new URL("../documents/mixins/brawlMixin.mjs", import.meta.url), "utf8");
const wamSrc   = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
const linkSrc  = readFileSync(new URL("../mechanics/holdLink.mjs", import.meta.url), "utf8");
const crSrc    = readFileSync(new URL("../documents/mixins/combatRoundMixin.mjs", import.meta.url), "utf8");

test("BRAWL_ACTIONS.choke is pin-gated and routed to the choke handler", () => {
    const line = cfgSrc.match(/\n\s*choke:\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(line, /status:\s*"chokeheld"/);
    assert.match(line, /needsPin:\s*true/);
    assert.match(line, /isChoke:\s*true/);
    assert.doesNotMatch(line, /needsGrapple/);   // pin, not grapple
});

test("CE chokehold action needs a PIN + the Strangling weapon quality", () => {
    const block = actSrc.match(/chokehold:\s*Object\.freeze\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    assert.match(block, /prereq:\s*"pinning"/);
    assert.match(block, /requiresQuality:\s*"strangling"/);
    assert.match(block, /appliesStatus:\s*"chokeheld"/);
});

test("choke is resisted with Brawling only — no dodge/escape/relocate", () => {
    const gate = defSrc.match(/\n\s*choke:\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(gate, /dodge:\s*false/);
    assert.match(gate, /reposition:\s*false/);
    assert.match(gate, /brawlBlock:\s*true/);
});

test("brawlMixin: pin gate; choke applies once, no re-invoke, damage via the helper", () => {
    assert.match(brawlSrc, /meta\.needsPin[\s\S]+?pinsTarget\(this,\s*tg\)/);
    // No ×2 prompt, and no extra-action re-application.
    assert.doesNotMatch(brawlSrc, /chokeActions\s*=\s*2/);
    // Re-invoking Choke on a foe you already choke is REFUSED (maintained via prompt).
    assert.match(brawlSrc, /alreadyChoking[\s\S]+?ChokeAlready[\s\S]+?return null/);
    // The initial application deals one turn of damage through the shared helper.
    assert.match(brawlSrc, /meta\.isChoke && opposedTarget[\s\S]+?applyChokeDamage\(this,\s*opposedTarget/);
});

test("choke.mjs helper: flat, through armour + shield, stamina-then-HP, Strangling-scaled", () => {
    const chokeSrc = readFileSync(new URL("../mechanics/choke.mjs", import.meta.url), "utf8");
    // Amount = (3 + melee bonus + Strangling flat) × Strangling multiplier.
    assert.match(chokeSrc, /\(3\s*\+\s*mb\s*\+\s*flat\)\s*\*\s*mult/);
    assert.match(chokeSrc, /strangleSuffocation\(weapon\)/);
    // Applied flat (torso), through EVERYTHING, stamina first then HP.
    assert.match(chokeSrc, /locationKey:\s*"torso"/);
    assert.match(chokeSrc, /throughArmor:\s*true/);
    assert.match(chokeSrc, /staThenHp:\s*true/);
    // socketHook honours staThenHp: drain stamina, overflow into HP.
    const socketSrc = readFileSync(new URL("./socketHook.mjs", import.meta.url), "utf8");
    assert.match(socketSrc, /payload\.staThenHp[\s\S]+?Math\.min\(staCur,\s*hpLoss\)[\s\S]+?drainHp/);
});

test("weaponAttackMixin choke rider deals one action's Strangling-scaled suffocation", () => {
    const rider = wamSrc.match(/decl\.strike === "chokehold" && _defenderActor[\s\S]+?melee choke rider failed/)?.[0] ?? "";
    assert.ok(rider, "weapon choke rider must exist");
    assert.match(rider, /applyChokeDamage\(this,\s*_defenderActor,\s*weapon/);
    assert.doesNotMatch(rider, /_chokeActions/);   // no ×2 prompt anymore
});

test("choke has a turn-start UPKEEP prompt (keep = action + damage; decline = release; close = no-op)", () => {
    const chokeSrc = readFileSync(new URL("../mechanics/choke.mjs", import.meta.url), "utf8");
    assert.match(chokeSrc, /export function installChokeUpkeepPrompt/);
    assert.match(chokeSrc, /Hooks\.on\("combatTurnChange"/);
    // Explicit keep / release buttons (so closing is distinguishable).
    assert.match(chokeSrc, /pick === "release"[\s\S]+?clearHoldLink\(choker,\s*"choke released"[\s\S]*?"chokeheld"\)/);
    assert.match(chokeSrc, /pick === "keep"[\s\S]+?maintainChokeOnce\(choker,\s*target/);
    // Closing (pick == null) is a NO-OP — no `else` release branch.
    assert.match(chokeSrc, /pick == null[\s\S]*?no-op/);
    const hooksSrc = readFileSync(new URL("./hooks.mjs", import.meta.url), "utf8");
    assert.match(hooksSrc, /installChokeUpkeepPrompt\(\)/);
});

test("maintaining a choke is a FULL-ROUND action — no free damage if the turn's gone", () => {
    const chokeSrc = readFileSync(new URL("../mechanics/choke.mjs", import.meta.url), "utf8");
    // maintainChokeOnce commits a full round; if it returns false, bail before damage.
    assert.match(chokeSrc, /export async function maintainChokeOnce/);
    assert.match(chokeSrc, /spent\s*=\s*\(await choker\.recordFullRound[\s\S]+?if \(spent === false\)[\s\S]+?return false/);
    assert.match(chokeSrc, /const dealt = await applyChokeDamage/);
});

test("dock 'Maintain Choke' pill sits right of Break Choke and greys once maintained this turn", () => {
    const cbSrc = readFileSync(new URL("../chrome/chrome/clinch-break.js", import.meta.url), "utf8");
    // Break (left) + Maintain (right) share one flex row.
    assert.match(cbSrc, /wou-hold-row[\s\S]*?\$\{breakBtn\}\$\{maintainBtn\}/);
    assert.match(cbSrc, /data-role="maintain"/);
    // Greyed (is-disabled) when the choke was already maintained/applied THIS round.
    assert.match(cbSrc, /chokeRound === curRound/);
    assert.match(cbSrc, /maintained\s*\?\s*" is-disabled"\s*:\s*""/);
    // Clicking a live maintain pill maintains; the disabled one is handled by the
    // shared data-disabled guard above.
    assert.match(cbSrc, /role === "maintain"[\s\S]+?maintainChokeOnce\(actor,\s*tgt/);
});

test("a PINNED choke target can STILL resist a choke with Brawling (the pin exception)", () => {
    /* A pinned target normally can't defend a grapple attack — but choke is the
     * exception (it's resisted with Brawling), so brawlBlock stays on for it. */
    assert.match(defSrc, /isChokeAtk\s*=\s*attackKind === "choke"\s*\|\|\s*attackKind === "chokehold"/);
    assert.match(defSrc, /brawlBlock:\s*isChokeAtk/);
});

test("choke resists like Brawling in BOTH paths (no block/dodge — Brawling or grappling weapon)", () => {
    // Brawl: choke sends its own attackKind (not the looser "grapple" gate).
    assert.match(brawlSrc, /decl\.action\s*===\s*"choke"\s*\?\s*"choke"\s*:\s*"grapple"/);
    // Weapon: the CE "chokehold" strike maps to the "choke" defense gate.
    assert.match(defSrc, /chokehold:\s*"choke"/);
    assert.match(defSrc, /attackKind === "choke" \|\| attackKind === "chokehold"/);
});

test("passive suffocation DoT is NO LONGER co-applied on a chokehold (action-driven now)", () => {
    const applyBlock = linkSrc.match(/async function _doApplyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.doesNotMatch(applyBlock, /toggleStatusEffect\("suffocation"/);
});

test("an un-maintained choke auto-releases on the choker's next turn", () => {
    assert.match(crSrc, /chokeRound[\s\S]+?round - chokeRound >= 2[\s\S]+?clearHoldLink\(this,\s*"choke lapsed"[\s\S]+?"chokeheld"\)/);
});

test("Strangling config dialog exposes a suffocation flat + multiplier field that round-trips", () => {
    const dlgSrc = readFileSync(new URL("../applications/openCategoryConfigDialog.mjs", import.meta.url), "utf8");
    // Fields only for Strangling.
    assert.match(dlgSrc, /const\s+isStrangling\s*=\s*qualityKey === "strangling"/);
    assert.match(dlgSrc, /isStrangling\s*\?\s*`[\s\S]*name="suffFlat"[\s\S]*name="suffMult"/);
    // Read back on save…
    assert.match(dlgSrc, /suffFlat\s*=\s*isStrangling[\s\S]+?suffMult\s*=\s*isStrangling/);
    // …and emitted as parseable "+N suffocation" / "×N suffocation" text.
    assert.match(dlgSrc, /parts\.push\(`\+\$\{sf\} suffocation`\)/);
    assert.match(dlgSrc, /parts\.push\(`×\$\{sm\} suffocation`\)/);
});
