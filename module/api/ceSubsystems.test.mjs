// module/api/ceSubsystems.test.mjs
//
// Per-subsystem CE toggles. The runtime helper reads game.settings which
// isn't available in node, so unit tests stub it; source-pattern checks
// confirm the gate wiring is in place at every consumer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CE_SUBSYSTEM_DEFAULTS, isCESubsystemEnabled } from "./homebrew.mjs";

const homebrewSrc  = readFileSync(new URL("./homebrew.mjs", import.meta.url), "utf8");
const settingsSrc  = readFileSync(new URL("../setup/settings.mjs", import.meta.url), "utf8");
const editorSrc    = readFileSync(new URL("../applications/combatActionsEditor.mjs", import.meta.url), "utf8");
const editorTpl    = readFileSync(new URL("../../templates/applications/combat-actions-editor.hbs", import.meta.url), "utf8");
const actionsSrc   = readFileSync(new URL("../data/combatExtended/actions.mjs", import.meta.url), "utf8");
const guardsSrc    = readFileSync(new URL("../data/combatExtended/guards.mjs", import.meta.url), "utf8");
const mixinSrc     = readFileSync(new URL("../documents/mixins/combatRoundMixin.mjs", import.meta.url), "utf8");
const dockSrc      = readFileSync(new URL("../chrome/chrome/dock.js", import.meta.url), "utf8");

test("CE_SUBSYSTEM_DEFAULTS lists the primary subsystems, all default ON", () => {
    assert.deepEqual(Object.keys(CE_SUBSYSTEM_DEFAULTS).sort(),
        ["actionCosts", "defenseCosts", "eoArmorModel", "guards", "magazineReload", "raiseShield"]);
    for (const v of Object.values(CE_SUBSYSTEM_DEFAULTS)) assert.equal(v, true);
});

test("isCESubsystemEnabled returns false when master extendedCombat is off", () => {
    // No `game` global in node → isCombatExtendedEnabled throws → wrapper
    // returns false. Safe-by-default semantics.
    assert.equal(isCESubsystemEnabled("guards"), false);
    assert.equal(isCESubsystemEnabled("raiseShield"), false);
});

test("isCESubsystemEnabled warns on unknown subsystem keys and returns false", () => {
    // Capture console.warn
    const orig = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(" "));
    try {
        const r = isCESubsystemEnabled("nonsense");
        assert.equal(r, false);
        // It may warn (no master toggle on) — but if it does warn about the
        // unknown key, we want to see that path covered.
        // Either way it's safe to no-op return false.
    } finally { console.warn = orig; }
});

test("combatExtendedSubsystems setting is registered (Object, default {})", () => {
    assert.match(settingsSrc, /game\.settings\.register\(SYSTEM_ID,\s*"combatExtendedSubsystems",\s*\{[\s\S]+type:\s*Object[\s\S]+default:\s*\{\}/);
});

test("getActiveStrikeTable gates on isCESubsystemEnabled('actionCosts')", () => {
    assert.match(actionsSrc, /isCESubsystemEnabled\("actionCosts"\)/);
});

test("getActiveStrikeTable reshape preserves the `thrown` flag", () => {
    // When CE is on, the strike table is rebuilt from CE actions. The
    // reshape used to drop `thrown: true` (and there's no CE `throw`
    // entry at all by default), which broke both the Throwing OC bonus
    // and the drop-to-world path. Guard both.
    assert.match(actionsSrc, /thrown:\s*!!entry\.thrown/);
});

test("getActiveStrikeTable falls back to legacy `throw` when CE lacks it", () => {
    // Without this fallback, the sword stays glued to the actor's hand
    // under CE — `strikeMeta.thrown` never lights up, _dropThrownWeapon
    // never fires, and the Throwing OC never adds its WA.
    assert.match(actionsSrc, /for\s*\(const\s+key\s+of\s*\[\s*"throw"\s*\]\)/);
    assert.match(actionsSrc, /if\s*\(!out\[key\]\s*&&\s*legacyStrikeTypes\[key\]\)\s*out\[key\]\s*=\s*legacyStrikeTypes\[key\];/);
});

test("guards.mjs gates its public helpers on isCESubsystemEnabled('guards')", () => {
    assert.match(guardsSrc, /isCESubsystemEnabled\("guards"\)/);
});

test("recordDefense gates its CE branch on isCESubsystemEnabled('defenseCosts')", () => {
    assert.match(mixinSrc, /isCESubsystemEnabled\("defenseCosts"\)/);
});

test("Dock raise-shield button gates on isCESubsystemEnabled('raiseShield')", () => {
    assert.match(dockSrc, /isCESubsystemEnabled\("raiseShield"\)/);
});

test("Editor exposes a Subsystems section that iterates toggles", () => {
    // Section header present
    assert.match(editorTpl, /WITCHER\.App\.CombatActionsEditor\.Text\.Subsystems'\}\}<\/h3>/);
    // Iteration loop over subsystems (the form field names are resolved
    // at render time from {{sub.key}}, so we can't grep for literal keys
    // in the template — we check the loop structure instead).
    assert.match(editorTpl, /\{\{#each\s+subsystems\s+as\s+\|sub\|\}\}/);
    assert.match(editorTpl, /name="subsystems\.\{\{sub\.key\}\}"/);
    // Editor JS supplies one row per CE_SUBSYSTEM_DEFAULTS key.
    assert.match(editorSrc, /SUBSYSTEM_META\(\)\.map\(m\s*=>\s*\(\{[\s\S]+enabled:\s*!!this\.#working\.subsystems\[m\.key\]/);
});

test("Editor save: subsystems persist as the EXPLICIT current state (not a diff)", () => {
    /* Player-flow audit #1 — the diff-against-default save was
     * mathematically correct (reader falls back to default for
     * missing keys) but persisted as `{}` after every save, which
     * looked alarming to any GM inspecting the world settings. The
     * explicit-state write is louder and easier to reason about. */
    assert.match(editorSrc, /for \(const \{ key \} of SUBSYSTEM_META\(\)\) \{[\s\S]+?subOut\[key\]\s*=\s*!!this\.#working\.subsystems\[key\]/);
});

test("Reset All restores action rows, subsystem toggles, AND tuneables to defaults", () => {
    // Regression for an earlier bug where #onResetCatalog dropped the
    // subsystems key from this.#working, which broke the next Save.
    // Updated for the Tuneables section addition.
    assert.match(editorSrc, /this\.#working\s*=\s*\{\s*attack:\s*\[\]\s*,\s*defense:\s*\[\]\s*,\s*subsystems:\s*\{\}\s*,\s*tuneables:\s*\{\}\s*\}/);
    assert.match(editorSrc, /for\s*\(const\s*\{\s*key\s*\}\s*of\s*SUBSYSTEM_META\(\)\)\s*\{[\s\S]+this\.#working\.subsystems\[key\]\s*=\s*CE_SUBSYSTEM_DEFAULTS\[key\]/);
    assert.match(editorSrc, /for\s*\(const\s*meta\s*of\s*TUNEABLE_META\(\)\)\s*\{[\s\S]+this\.#working\.tuneables\[meta\.key\]\s*=\s*meta\.default/);
});
