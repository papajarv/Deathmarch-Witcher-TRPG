// module/setup/dragAction.test.mjs
//
// Drag — an either-role grapple action resolved by an OPPOSED PHYSIQUE test
// (auto-rolled, no defender combat-skill defense). On a win a reachable-tile
// overlay opens (radius = |physique-base diff|, min 2m, capped by free movement)
// flooded from the FOE — the picked tile is where THEY land; you then snap to
// clinch distance beside them (facing pick = which side). Both moves are flagged
// hold-preserving so the grapple stack doesn't snap. Available in the brawl menu
// AND (for a grappling weapon) the melee dialog.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cfgSrc   = readFileSync(new URL("./config.mjs", import.meta.url), "utf8");
const actSrc   = readFileSync(new URL("../data/combatExtended/actions.mjs", import.meta.url), "utf8");
const dragSrc  = readFileSync(new URL("../mechanics/drag.mjs", import.meta.url), "utf8");
const brawlSrc = readFileSync(new URL("../documents/mixins/brawlMixin.mjs", import.meta.url), "utf8");
const wamSrc   = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
const pushSrc  = readFileSync(new URL("../mechanics/pushToken.mjs", import.meta.url), "utf8");

test("BRAWL_ACTIONS.drag is an EITHER-ROLE grapple action routed to the drag handler", () => {
    const line = cfgSrc.match(/\n\s*drag:\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(line, /kind:\s*"grapple"/);
    assert.match(line, /needsGrappleAnyRole:\s*true/);   // holder OR grapplee
    assert.match(line, /isDrag:\s*true/);
    assert.doesNotMatch(line, /damage:/);
    assert.match(cfgSrc, /GroupGrapple[\s\S]*?"trip",\s*"drag"/);
    // CE action + weapon path also either-role (prereq inGrappleWith).
    assert.match(actSrc, /drag:\s*Object\.freeze\(\{[\s\S]*?prereq:\s*"inGrappleWith"/);
    assert.match(wamSrc, /decl\?\.strike === "drag"[\s\S]+?p\.targetUuid === su && p\.holderUuid === tu/);
});

test("drag.mjs: opposed Physique (auto), distance = base diff min 2m, movement-capped, hold-preserving move", () => {
    // Physique base = BODY + physique skill.
    assert.match(dragSrc, /export function physiqueBase[\s\S]*?stats\?\.body\?\.value[\s\S]*?skills\?\.body\?\.physique\?\.value/);
    // Auto opposed Physique via rollWitcherD10 (no defender prompt) + win check.
    assert.match(dragSrc, /myTotal[\s\S]+?rollWitcherD10[\s\S]+?theirTotal[\s\S]+?rollWitcherD10/);
    assert.match(dragSrc, /if \(!\(myTotal > theirTotal\)\)/);
    // Distance max(2, |diff|), capped by free movement.
    assert.match(dragSrc, /Math\.max\(2,\s*Math\.abs\(myBase\s*-\s*theirBase\)\)/);
    assert.match(dragSrc, /dist\s*=\s*Math\.min\(dist,\s*free\)/);
    // Reachable overlay + move BOTH tokens hold-preserving; charge movement.
    assert.match(dragSrc, /computeReachableCells\(token,\s*meters\)/);
    assert.match(dragSrc, /emitMoveToken\([\s\S]+?preserveHolds:\s*true[\s\S]+?emitMoveToken\([\s\S]+?preserveHolds:\s*true/);
    assert.match(dragSrc, /recordMovement\(movedM\)/);
    // The overlay is anchored on the FOE — reachable flood is flooded from tTok,
    // so the picked tile is where THEY land.
    assert.match(dragSrc, /dest = await pickDragDestination\(tTok,\s*dist\)/);
    // After the destination, a FACING pick chooses which way YOU'LL face them —
    // so you stand on the OPPOSITE side, at CLINCH DISTANCE (½ tile), looking
    // along that direction toward them.
    assert.match(dragSrc, /facing = await pickPushDirection\(\{\s*x:\s*dest\.x,\s*y:\s*dest\.y\s*\}/);
    assert.match(dragSrc, /const half = gs \* 0\.5/);
    assert.match(dragSrc, /if \(facing\)[\s\S]+?dest\.x - facing\.x \* half/);
    // Right-click during either pick cancels the pick (movement grid defers to isDragActive).
    assert.match(dragSrc, /export function isDragActive/);
    assert.match(dragSrc, /_dragActive = true[\s\S]+?pickDragDestination[\s\S]+?pickPushDirection[\s\S]+?_dragActive = false/);
    // Can't drag while pinned.
    assert.match(dragSrc, /isInPin\(grappler\)[\s\S]+?DragWhilePinned/);
    // No wall clip/squish: the foe lands grid-aligned on the picked cell; if a
    // wall's between you and them, drop YOU into the nearest passable adjacent
    // cell toward your side (grid-aligned, flush).
    assert.match(dragSrc, /wallBetween\(aCenter\)[\s\S]+?getAdjacentOffsets[\s\S]+?wallBetween\(c\)[\s\S]+?bestDot/);
    // You face the foe; the foe faces back at you.
    assert.match(dragSrc, /draggerRot\s*=\s*facingDeg\(aCenter,\s*dest\)/);
    assert.match(dragSrc, /draggeeRot\s*=\s*facingDeg\(dest,\s*aCenter\)/);
    assert.match(dragSrc, /rotation:\s*draggeeRot[\s\S]+?rotation:\s*draggerRot/);
});

test("both brawl and weapon paths call the shared performDrag", () => {
    assert.match(brawlSrc, /meta\.isDrag[\s\S]+?performDrag\(this,\s*grappleTargets\[0\]\)/);
    // Weapon path: needs an active grapple, then performDrag, skipping the weapon roll.
    assert.match(wamSrc, /decl\?\.strike === "drag"[\s\S]+?performDrag\(this,\s*_defenderActor\)/);
    // CE action so it shows in the melee dialog for a grappling weapon (either
    // party in the grapple — prereq inGrappleWith).
    assert.match(actSrc, /drag:\s*Object\.freeze\(\{[\s\S]*?requiresQuality:\s*"grappling"[\s\S]*?prereq:\s*"inGrappleWith"/);
});

test("pushToken/emitPushToken accept preserveHolds → wdmClinchMove so a drag doesn't break holds", () => {
    assert.match(pushSrc, /pushToken\(\{\s*token,\s*sourcePoint,\s*distanceMeters,\s*preserveHolds\s*=\s*false\s*\}\)/);
    assert.match(pushSrc, /preserveHolds[\s\S]+?wdmClinchMove:\s*true/);
});
