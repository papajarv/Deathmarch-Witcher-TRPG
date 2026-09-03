// module/setup/tripAction.test.mjs
//
// Trip is a GRAPPLER-ONLY finisher: like Takedown (opposed Brawling / Grappling
// weapon vs the foe's Brawling; NON-LETHAL punch to Stamina still soaked by SP;
// grapple maintained) — but only the TARGET goes prone (no self-prone), and
// only the holder may use it (needsGrapple, not needsGrappleAnyRole).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cfgSrc     = readFileSync(new URL("./config.mjs", import.meta.url), "utf8");
const actionsSrc = readFileSync(new URL("../data/combatExtended/actions.mjs", import.meta.url), "utf8");
const brawlSrc   = readFileSync(new URL("../documents/mixins/brawlMixin.mjs", import.meta.url), "utf8");
const wamSrc     = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
const defSrc     = readFileSync(new URL("../applications/defensePromptDialog.mjs", import.meta.url), "utf8");
const gwSrc      = readFileSync(new URL("../mechanics/grappleWeapon.mjs", import.meta.url), "utf8");

test("BRAWL_ACTIONS.trip is a grappler-only, target-only-prone takedown variant", () => {
    // The BRAWL_ACTIONS trip (grapple menu) — distinct from the RAW
    // STRIKE_TYPES.trip weapon strike, which stays a standalone leg-trip.
    const line = cfgSrc.match(/\n\s*trip:\s*\{[^}]*needsGrapple[^}]*\}/)?.[0] ?? "";
    assert.match(line, /kind:\s*"grapple"/);
    assert.match(line, /damage:\s*"punch"/);
    assert.match(line, /nonLethal:\s*true/);
    assert.match(line, /status:\s*"prone"/);
    assert.match(line, /needsGrapple:\s*true/);          // grappler-only (holder)
    assert.doesNotMatch(line, /needsGrappleAnyRole/);    // NOT either-role (that's Takedown)
    assert.doesNotMatch(line, /selfProne/);              // grappler stays up
});

test("CE action trip: noDamage, Grappling-weapon + grapple gated, no leg/appliesStatus", () => {
    const block = actionsSrc.match(/trip:\s*Object\.freeze\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    assert.match(block, /noDamage:\s*true/);
    assert.match(block, /requiresQuality:\s*"grappling"/);
    assert.match(block, /prereq:\s*"grappling"/);
    assert.doesNotMatch(block, /fixedLoc/);      // rider handles the effect now
    assert.doesNotMatch(block, /appliesStatus/); // prone comes from the rider, not the generic path
});

test("brawlMixin: trip needs the target standing; old kick/knockback enhancement is gone", () => {
    assert.match(brawlSrc, /decl\.action === "trip"[\s\S]{0,160}?TripTargetProne/);
    assert.doesNotMatch(brawlSrc, /ceTripEnhanced/);
    // trip is no longer force-injected with needsGrapple (config sets it directly).
    assert.doesNotMatch(brawlSrc, /decl\.action === "trip"\s*\|\|\s*decl\.action === "disarm"/);
});

test("weaponAttackMixin trip rider: non-lethal punch + ONLY the target goes prone", () => {
    const rider = wamSrc.match(/decl\.strike === "trip"[\s\S]+?melee trip rider failed/)?.[0] ?? "";
    assert.ok(rider, "trip rider block must exist");
    assert.match(rider, /nonLethal:\s*true/);
    assert.match(rider, /emitApplyStatus\(\{\s*targetUuid:\s*_defenderActor\.uuid,\s*statusId:\s*"prone"/);
    // Unlike Takedown, the grappler does NOT go prone — no self-prone apply.
    assert.doesNotMatch(rider, /targetUuid:\s*this\.uuid,\s*statusId:\s*"prone"/);
});

test("trip defends like Takedown (Brawling/Dodge, no parry/block/relocate) and a Grappling weapon can resist it", () => {
    const gate = defSrc.match(/\n\s*trip:\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(gate, /dodge:\s*true/);
    assert.match(gate, /brawlBlock:\s*true/);
    assert.match(gate, /reposition:\s*false/);
    assert.match(gwSrc, /GRAPPLE_DEFENSE_KINDS\s*=\s*new Set\(\[[^\]]*"trip"/);
});
