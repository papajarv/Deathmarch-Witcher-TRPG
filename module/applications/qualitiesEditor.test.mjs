// module/applications/qualitiesEditor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editorSrc   = readFileSync(new URL("./qualitiesEditor.mjs", import.meta.url), "utf8");
const templateSrc = readFileSync(new URL("../../templates/applications/qualities-editor.hbs", import.meta.url), "utf8");

test("editor exposes the damage-flag catalog so it stays in sync with the calculator", () => {
  assert.match(editorSrc, /DAMAGE_FLAG_KEYS\s*=\s*\[/);
  for (const flag of [
    "armorPiercing", "improvedArmorPiercing", "ablating",
    "bypassesWornArmor", "bypassesNaturalArmor", "bypassesShield", "isSilver"
  ]) {
    assert.match(editorSrc, new RegExp(`key:\\s*"${flag}"`), `missing flag in editor catalog: ${flag}`);
  }
});

test("editor exposes the three rider kinds + None", () => {
  assert.match(editorSrc, /RIDER_KINDS\s*=\s*\[/);
  for (const kind of ["none", "auto", "percent", "stunSave"]) {
    assert.match(editorSrc, new RegExp(`value:\\s*"${kind}"`), `missing rider kind: ${kind}`);
  }
});

test("#rowFromEntry hydrates both flags and rider fields", () => {
  assert.match(editorSrc, /for \(const \{ key: fk \} of DAMAGE_FLAG_KEYS\) flags\[fk\] = !!entry\?\.damageFlags\?\.\[fk\]/);
  assert.match(editorSrc, /riderKind:\s*rider\?\.kind/);
  assert.match(editorSrc, /riderStatus:\s*rider\?\.statusId/);
});

test("#entryFromRow drops empty flags + drops rider when kind is 'none' or no status picked", () => {
  // Only truthy flags are persisted (kept tight so diff-against-default works).
  assert.match(editorSrc, /if \(Object\.keys\(flagsOut\)\.length\) entry\.damageFlags = flagsOut/);
  // Rider is persisted only when kind is real AND a status was chosen.
  assert.match(editorSrc, /if \(row\.riderKind && row\.riderKind !== "none" && row\.riderStatus\)/);
});

test("status dropdown is fed from CONFIG.statusEffects at render time", () => {
  assert.match(editorSrc, /\(CONFIG\.statusEffects \?\? \[\]\)/);
  assert.match(editorSrc, /riderStatusOptions/);
});

test("template renders the Damage Flags checkbox grid and the Status Rider block", () => {
  assert.match(templateSrc, /Damage Flags/);
  assert.match(templateSrc, /name="\{\{\.\.\/cat\.prefix\}\}\.\{\{\.\.\/q\.index\}\}\.flags\.\{\{f\.key\}\}"/);
  assert.match(templateSrc, /Status Rider/);
  assert.match(templateSrc, /name="\{\{cat\.prefix\}\}\.\{\{q\.index\}\}\.riderKind"/);
  assert.match(templateSrc, /name="\{\{cat\.prefix\}\}\.\{\{q\.index\}\}\.riderStatus"/);
});

test("template surfaces the location filter only for the stunSave kind", () => {
  assert.match(templateSrc, /\{\{#if q\.riderHasLocations\}\}[\s\S]*?riderLocations[\s\S]*?\{\{else\}\}/);
});
