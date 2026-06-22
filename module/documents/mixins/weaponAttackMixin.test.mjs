// module/documents/mixins/weaponAttackMixin.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./weaponAttackMixin.mjs", import.meta.url), "utf8");

test("Rider lookup is data-driven (reads getActiveWeaponQualities, no hardcoded map)", () => {
  // The old hardcoded QUALITY_RIDERS map is gone — riderForQuality reads
  // the active catalog instead so the editor can rewire everything.
  assert.match(src, /function riderForQuality\(key\)/);
  assert.match(src, /getActiveWeaponQualities\(\) \?\? WEAPON_QUALITIES/);
  assert.doesNotMatch(src, /const QUALITY_RIDERS = Object\.freeze/);
});

test("applyQualityRiders handles auto / percent / stunSave kinds via catalog rider", () => {
  assert.match(src, /if \(rider\.kind === "auto"\)[\s\S]*?emitApplyStatus\(\{[\s\S]*?statusId:\s*rider\.statusId/);
  assert.match(src, /if \(rider\.kind === "percent"\)[\s\S]*?emitApplyStatus\(\{[\s\S]*?statusId:\s*rider\.statusId/);
  assert.match(src, /if \(rider\.kind === "stunSave"\)/);
});

test("Stun-save default locations fall back to [head, torso] when unspecified", () => {
  assert.match(src, /DEFAULT_STUN_LOCATIONS\s*=\s*\["head",\s*"torso"\]/);
  // The actual location gate uses rider.locations OR the default.
  assert.match(src, /const locations = rider\.locations[\s\S]*?DEFAULT_STUN_LOCATIONS/);
});

test("shotQualityRiders returns raw keys + values (sibling to shotQualityLabels)", () => {
  assert.match(src, /function shotQualityRiders\s*\(weapon,\s*ammoItem/);
  assert.match(src, /return \{[\s\S]*?keys:[\s\S]*?values:/);
});

test("damage button serializes the full quality payload + location key", () => {
  // Renamed from data-rider-* to data-qualit*: the same attrs feed BOTH
  // the calculator (AP/Improved AP/Ablating/Silver) and the rider logic.
  assert.match(src, /data-qualities=/);
  assert.match(src, /data-quality-values=/);
  assert.match(src, /data-loc-key=/);
});

test("rollDamageFromButton fires riders only on a damaging hit", () => {
  // The gate that allows riders to run is the same as the damage-apply gate.
  assert.match(src, /const isDamaging = Number\.isFinite\(roll\.total\) && roll\.total > 0/);
  assert.match(src, /if \(targets\.length && isDamaging\)/);
});

test("applyQualityRiders uses emitApplyStatus for percent riders (GM-proxied)", () => {
  assert.match(src, /emitApplyStatus\(\{\s*targetUuid:\s*target\.uuid,\s*statusId:\s*rider\.status/);
});

test("Stun-save prompt button is wired in installAttackChatHandlers", () => {
  assert.match(src, /data-action="wdm-stun-save"/);
  assert.match(src, /button\[data-action="wdm-stun-save"\]/);
  assert.match(src, /rollStunSaveFromButton/);
});

test("Stun-save handler calls target.rollStunSave with the listed modifier", () => {
  assert.match(src, /actor\.rollStunSave\(\{\s*modifier:\s*mod\s*\}\)/);
});

/* ── Crit detection wiring ─────────────────────────────────────────── */

test("Defense prompt fires per shot (inside the attacks loop) with a fresh engagementId", () => {
  // The prompt now lives INSIDE the for-loop so fast/joint attacks prompt
  // the defender once per shot; each shot generates its own engagementId.
  assert.match(src, /for \(let i = 0; i < attacks; i\+\+\)[\s\S]*?const _shotEngagementId = `eng-/);
  assert.match(src, /requestDefenseFromOwner\(\{[\s\S]*?engagementId:\s*_shotEngagementId/);
});

test("Per-shot prompt threads strike kind + shot index for the dialog header", () => {
  assert.match(src, /attackKind:\s*decl\.strike/);
  assert.match(src, /shotIndex:\s*i \+ 1/);
  assert.match(src, /totalShots:\s*attacks/);
});

test("Joint-attack disallow list grows after each parried shot", () => {
  // _usedDefenseItemIds collects itemIds across shots; passed ONLY when
  // it's a joint attack (offhandWeapon present), per RAW Core p.163.
  assert.match(src, /const _usedDefenseItemIds = \[\]/);
  assert.match(src, /const isJoint = !!offhandWeapon/);
  assert.match(src, /const disallowedItemIds = isJoint \? \[\.\.\._usedDefenseItemIds\] : \[\]/);
  assert.match(src, /if \(decl\._defenseChoice\?\.itemId\) _usedDefenseItemIds\.push/);
});

test("Feint shots skip the prompt (Deceit roll has no defense reaction)", () => {
  assert.match(src, /if \(_willPrompt && !isFeintRoll\)/);
});

test("Attack roll stamps engagementId + attackTotal + combat category as flags on the chat message", () => {
  // flags now also carry the chat-filter category ("combat") alongside the
  // engagement linkage; the conditional spread keeps both pieces together.
  assert.match(src, /flags:\s*\(r\) =>/);
  assert.match(src, /category:\s*"combat"/);
  assert.match(src, /engagementId:\s*decl\._engagementId,\s*attackTotal:\s*r\.total/);
});

test("rollDamageFromButton reads attack flags + finds matching defense for the delta", () => {
  assert.match(src, /msg\?\.getFlag\?\.\(SYSTEM_ID,\s*"engagementId"\)/);
  assert.match(src, /msg\?\.getFlag\?\.\(SYSTEM_ID,\s*"attackTotal"\)/);
  assert.match(src, /lookupDefenseTotal\(engagementId\)/);
  assert.match(src, /critSeverityFromDelta\(delta\)/);
});

test("emitApplyDamage payload includes critSeverity (socket maps it → critBonus)", () => {
  assert.match(src, /emitApplyDamage\(\{[\s\S]*?critSeverity[\s\S]*?\}\)/);
});

test("Reposition voids the next Fast-attack shot unless the weapon ignores reposition distance", () => {
  // The helper exists and reads the active catalog.
  assert.match(src, /function weaponIgnoresRepositionDistance\(weapon\)/);
  assert.match(src, /entry\?\.ignoresRepositionDistance === true/);

  // The void check fires INSIDE the multi-attack loop, AFTER the shot
  // resolves, and gates on (1) more shots remaining, (2) strike === fast,
  // (3) defender chose reposition, (4) defense beat the attack, (5) the
  // weapon does NOT carry the ignoresRepositionDistance flag. Joint
  // attacks pass through because they're simultaneous (RAW).
  assert.match(src, /i < attacks - 1/);
  assert.match(src, /decl\.strike === "fast"/);
  assert.match(src, /defChoice\?\.action === "reposition"/);
  assert.match(src, /Number\(result\?\.total\) <= Number\(defChoice\.defenseTotal\)/);
  assert.match(src, /!weaponIgnoresRepositionDistance\(shotWeapon\)/);
  // And actually breaks the loop when all conditions hold.
  assert.match(src, /follow-up Fast-attack swing finds empty air[\s\S]*?break;/);
});
