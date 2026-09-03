// module/setup/rideAction.test.mjs
//
// Ride — a CE grapple action: climb onto a LARGER foe you're grappling. On a
// won opposed Brawling roll the `mounted` hold lands (rider = holder, mount =
// target), the rider clamps to the mount's BACK, their movement slaves to the
// mount, and every attack they make against the mount counts as out-of-sight.
// The mount's only recourse is Shake Off Rider (Brawling vs the rider's
// Brawling); on a win the mounted pair clears and the rider is thrown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cfgSrc   = readFileSync(new URL("./config.mjs", import.meta.url), "utf8");
const modSrc   = readFileSync(new URL("../mechanics/holdModifiers.mjs", import.meta.url), "utf8");
const linkSrc  = readFileSync(new URL("../mechanics/holdLink.mjs", import.meta.url), "utf8");
const brawlSrc = readFileSync(new URL("../documents/mixins/brawlMixin.mjs", import.meta.url), "utf8");
const atkSrc   = readFileSync(new URL("../applications/attackDialog.mjs", import.meta.url), "utf8");
const defSrc   = readFileSync(new URL("../applications/defensePromptDialog.mjs", import.meta.url), "utf8");
const dlgSrc   = readFileSync(new URL("../applications/brawlDialog.mjs", import.meta.url), "utf8");
const gwSrc    = readFileSync(new URL("../mechanics/grappleWeapon.mjs", import.meta.url), "utf8");
const seSrc    = readFileSync(new URL("../mechanics/statusEngine.mjs", import.meta.url), "utf8");
const cbSrc    = readFileSync(new URL("../chrome/chrome/clinch-break.js", import.meta.url), "utf8");
const wtoSrc   = readFileSync(new URL("../policy/weapon-target-overlay.mjs", import.meta.url), "utf8");

test("config: ride lands the `mounted` hold; shakeOff is a mount-only counter", () => {
    // Ride — grapple action, applies `mounted`, flagged isRide.
    const ride = cfgSrc.match(/\n\s*ride:\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(ride, /kind:\s*"grapple"/);
    assert.match(ride, /status:\s*"mounted"/);
    assert.match(ride, /isRide:\s*true/);
    // Shake Off Rider — grapple action, mount-only (requiresMounted), no damage.
    const shake = cfgSrc.match(/\n\s*shakeOff:\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(shake, /kind:\s*"grapple"/);
    assert.match(shake, /isShakeOff:\s*true/);
    assert.match(shake, /requiresMounted:\s*true/);
    assert.doesNotMatch(shake, /damage:/);
    // Both live in the grapple group.
    assert.match(cfgSrc, /GroupGrapple[\s\S]*?"ride"[\s\S]*?"shakeOff"/);
});

test("holdModifiers.ridesTarget: registry check for rider(holder)→mount(target)", () => {
    assert.match(modSrc, /export function ridesTarget\(rider,\s*mount\)/);
    assert.match(modSrc, /p\.kind === "mounted" && p\.holderUuid === ru && p\.targetUuid === mu/);
});

test("holdLink: rider clamps to the mount's BACK (½ tile behind, by facing)", () => {
    // Geometry helper: behind = negation of the mount's forward (rot + 90).
    assert.match(linkSrc, /export function mountBackPlacement\(mountDoc,\s*riderTok\)/);
    assert.match(linkSrc, /\(\(rot \+ 90\) % 360\) \* Math\.PI \/ 180/);
    assert.match(linkSrc, /-Math\.cos\(fwd\),?\s*by = -Math\.sin\(fwd\)/);
    // Follow hook fires on move OR turn and repositions to the back, hold-preserving.
    const hookBlock = linkSrc.match(/async function onUpdateTokenForHold[\s\S]+?\n\}/m)?.[0] ?? "";
    assert.match(hookBlock, /const rotChanged\s*=\s*changes\?\.rotation != null/);
    assert.match(hookBlock, /mountBackPlacement\(tokenDoc,\s*rt\)/);
    assert.match(hookBlock, /wdmClinchMove:\s*true[\s\S]+?wdmFreeFacing:\s*true/);
});

test("brawlMixin: ride self-confirms (larger foe) then clamps on a win", () => {
    // Self-confirm + manual larger-enemy gate BEFORE the opposed roll.
    assert.match(brawlSrc, /if \(meta\.isRide\)[\s\S]+?DialogV2\.confirm\([\s\S]+?WITCHER\.Brawl\.RideConfirm[\s\S]+?larger/);
    // On a successful climb, snap the rider to the mount's back (hold-preserving).
    assert.match(brawlSrc, /meta\.isRide && opposedTarget && \(!isOpposedAction \|\| firstShotBeat\)[\s\S]+?mountBackPlacement\(mTok\.document,\s*aTok\)[\s\S]+?emitMoveToken\([\s\S]+?preserveHolds:\s*true/);
});

test("brawlMixin: Shake Off Rider — opposed Brawling, clears mounted on win", () => {
    // Fast-path option (dock parity with escape / reverse).
    assert.match(brawlSrc, /options\.shakeOff[\s\S]+?BRAWL_ACTIONS\.shakeOff/);
    // The branch: mount rolls Brawling, rider defends (attackKind shakeOff),
    // and a win clears the `mounted` pair.
    const branch = brawlSrc.match(/if \(meta\.isShakeOff\)\s*\{[\s\S]+?return \{ declaration: decl, kind: "shakeOff"[\s\S]+?\};/)?.[0] ?? "";
    assert.match(branch, /kind === "mounted" && p\.role === "target"/);
    assert.match(branch, /this\.rollSkill\("brawling"/);
    assert.match(branch, /attackKind:\s*"shakeOff"/);
    assert.match(branch, /won = mountTotal > riderTotal/);
    assert.match(branch, /clearHoldLink\(this,\s*"shaken off",\s*rider,\s*"mounted"\)/);
});

test("attackDialog: riding a foe forces the out-of-sight bonus", () => {
    assert.match(atkSrc, /ridesTarget[\s\S]+?ridesTarget\(aTok\.actor,\s*dTok\.actor\)\)\s*return true/);
});

test("defensePromptDialog: Shake Off is resisted with Brawling ONLY", () => {
    assert.match(defSrc, /shakeOff:\s*\{ parry: false, block: false, dodge: false, reposition: false, brawlBlock: true \}/);
    // A grappling weapon may stand in for the rider's Brawling.
    assert.match(gwSrc, /GRAPPLE_DEFENSE_KINDS[\s\S]+?"shakeOff"/);
});

test("brawlDialog: Shake Off shows only to a mount; Ride hides while riding", () => {
    assert.match(dlgSrc, /const _isMount = _myHolds\.some\(p => p\.targetUuid === actorUuid && p\.kind === "mounted"\)/);
    assert.match(dlgSrc, /const _isRider = _myHolds\.some\(p => p\.holderUuid === actorUuid && p\.kind === "mounted"\)/);
    assert.match(dlgSrc, /k === "shakeOff" && !_isMount\) return false/);
    assert.match(dlgSrc, /k === "ride" && _isRider\) return false/);
    assert.match(dlgSrc, /CE_ONLY_ACTIONS = new Set\(\[[^\]]*"shakeOff"/);
});

test("holdModifiers: isRidingSomeone (holder) + isRiddenMount (target)", () => {
    assert.match(modSrc, /export function isRidingSomeone[\s\S]+?p\.kind === "mounted" && p\.holderUuid === u/);
    assert.match(modSrc, /export function isRiddenMount[\s\S]+?p\.kind === "mounted" && p\.targetUuid === u/);
});

test("ride converts the grapple: rider can't grapple-act; mount moves at will", () => {
    // Rider commits: the normal grapple follow-ups are refused while mounted.
    assert.match(brawlSrc, /RIDE_BLOCKED_ACTIONS = new Set\(\["grapple", "pin", "choke", "trip", "drag", "takedown", "throw", "slam", "push", "reverseGrapple"\]\)/);
    assert.match(brawlSrc, /RIDE_BLOCKED_ACTIONS\.has\(decl\.action\) && isRidingSomeone\(this\)/);
    // Ride drops the clinch (mount then moves freely) but KEEPS the grapple base.
    assert.match(brawlSrc, /clearHoldLink\(this,\s*"ride",\s*opposedTarget,\s*"clinched"\)/);
    // A ridden mount's move-lock is waived in cannotMove (other locks still apply).
    assert.match(seSrc, /riddenMount = isRiddenMount\(actor\)/);
    assert.match(seSrc, /riddenMount && \(id === "grappled" \|\| id === "mounted"\)\) continue/);
    // Dialog greys the grapple follow-ups while riding.
    assert.match(dlgSrc, /rideLockedBlocked = _isRider && RIDE_LOCKED\.has\(key\)/);
});

test("melee targeting while riding: NORMAL overlay + whole mount clickable", () => {
    // Not the exclusive clinch lock — the rider isn't added to the lock `allowed`.
    // Instead the mount is injected into the normal overlay's cells + targetCells
    // so its whole footprint is highlighted and click-to-target, on top of reach.
    assert.match(wtoSrc, /p\.kind === "mounted" && p\.holderUuid === selfU/);
    assert.match(wtoSrc, /mountUuids[\s\S]+?cells\.set\(key,\s*\{ i, j, center, color: COLOR_MELEE \}\)[\s\S]+?targetCells\.set\(key, arr\)/);
});

test("back-clamp is wall-safe: pull the rider IN along the back vector, never through", () => {
    assert.match(linkSrc, /export function mountBackPlacement/);
    assert.match(linkSrc, /for \(const f of \[1, 0\.66, 0\.33, 0\][\s\S]+?testCollision\([\s\S]+?cx = tx; cy = ty; break/);
});

test("follow-mount is ZERO-latency + lockstep so the rider stays glued, not trailing", () => {
    const hook = linkSrc.match(/async function onUpdateTokenForHold[\s\S]+?\n\}/m)?.[0] ?? "";
    // Registry read + rider resolve are SYNC (no await before issuing the move).
    assert.match(hook, /const syncPairs\s*=\s*getHoldsSync\(worldUuid\)/);
    assert.match(hook, /fromUuidSync\(p\.holderUuid\)/);
    // The rider move is fire-and-forget (no await) with animate:true = lockstep.
    assert.match(hook, /rt\.document\.update\([\s\S]+?animate:\s*true[\s\S]+?\}\s*\)\s*\.catch/);
    // Follow runs BEFORE the async clinch-break (which comes after, order matters).
    assert.ok(hook.indexOf("mounted") < hook.indexOf('kind === "clinched"'));
});

test("mount breaks when the grapple breaks (dependency), and shows on holds", () => {
    // Clearing a `grappled` pair also clears the `mounted` pair for the same two.
    assert.match(linkSrc, /kind !== "mounted"[\s\S]+?removed\.filter\(p => p\.kind === "grappled"\)[\s\S]+?clearHold\(g\.holderUuid,\s*g\.targetUuid,\s*"mounted"\)/);
    // Holds UI: `mounted` pip (rider = Dismount, mount = Ridden) + break cascade.
    assert.match(cbSrc, /kind:\s*"mounted"[\s\S]+?holderFallback:\s*"Dismount"[\s\S]+?targetFallback:\s*"Ridden"/);
    assert.match(cbSrc, /grappled:\s*\["chokeheld", "pinned", "mounted", "grappled"\]/);
    assert.match(cbSrc, /mounted:\s*\["mounted"\]/);
});
