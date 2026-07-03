// module/data/combatExtended/actions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    DEFAULT_COMBAT_ACTIONS, EDITABLE_FIELDS, mergeCombatActions
} from "./actions.mjs";

const src = readFileSync(new URL("./actions.mjs", import.meta.url), "utf8");

test("DEFAULT_COMBAT_ACTIONS covers every Combat Extended action from rules1/2", () => {
    /* Escape is intentionally NOT here — under the bidirectional +
     * multi-clinch model, escape is pure movement (see holdLink.mjs
     * onUpdateTokenForHold), not an attack-picker action. */
    const expected = [
        // attacks
        "single", "strongAttack", "fastAttack", "jointAttack",
        "impale", "feint", "clinch", "charge", "grapple",
        "pommelStrike", "lunge", "bash", "push", "trip", "disarm",
        "pin", "chokehold", "ride",
        // defenses
        "parry", "block", "dodge", "reposition"
    ];
    for (const key of expected) {
        assert.ok(Object.hasOwn(DEFAULT_COMBAT_ACTIONS, key),
            `missing default action: ${key}`);
    }
    assert.ok(!Object.hasOwn(DEFAULT_COMBAT_ACTIONS, "escape"),
        "escape should be removed — movement handles it via the movement-break hook");
});

test("DEFAULT_COMBAT_ACTIONS uses the corrected defense STA costs", () => {
    // Per the rules1/2 corrections from the design pass:
    //   Parry 0, Block 0, Dodge 1, Reposition (→Relocate) 2
    assert.equal(DEFAULT_COMBAT_ACTIONS.parry.staCost,      0);
    assert.equal(DEFAULT_COMBAT_ACTIONS.block.staCost,      0);
    assert.equal(DEFAULT_COMBAT_ACTIONS.dodge.staCost,      1);
    assert.equal(DEFAULT_COMBAT_ACTIONS.reposition.staCost, 2);
});

test("DEFAULT_COMBAT_ACTIONS encodes the rules2 attack STA costs", () => {
    assert.equal(DEFAULT_COMBAT_ACTIONS.single.staCost,        1);
    assert.equal(DEFAULT_COMBAT_ACTIONS.strongAttack.staCost,  3);
    assert.equal(DEFAULT_COMBAT_ACTIONS.fastAttack.staCost,    2);
    assert.equal(DEFAULT_COMBAT_ACTIONS.jointAttack.staCost,   2);
    assert.equal(DEFAULT_COMBAT_ACTIONS.impale.staCost,        2);
    assert.equal(DEFAULT_COMBAT_ACTIONS.feint.staCost,         2);
    /* Clinch is a `movement` action (not attack) — free move-into-
     * grapple that stamps the status on both parties. staCost 0. */
    assert.equal(DEFAULT_COMBAT_ACTIONS.clinch.staCost,        0);
    assert.equal(DEFAULT_COMBAT_ACTIONS.charge.staCost,        3);
    assert.equal(DEFAULT_COMBAT_ACTIONS.grapple.staCost,       3);
    assert.equal(DEFAULT_COMBAT_ACTIONS.pommelStrike.staCost,  2);
    assert.equal(DEFAULT_COMBAT_ACTIONS.lunge.staCost,         3);
    assert.equal(DEFAULT_COMBAT_ACTIONS.bash.staCost,          3);
    assert.equal(DEFAULT_COMBAT_ACTIONS.push.staCost,          1);
    assert.equal(DEFAULT_COMBAT_ACTIONS.trip.staCost,          2);
    assert.equal(DEFAULT_COMBAT_ACTIONS.disarm.staCost,        2);
    assert.equal(DEFAULT_COMBAT_ACTIONS.pin.staCost,           2);
    assert.equal(DEFAULT_COMBAT_ACTIONS.chokehold.staCost,     2);
    assert.equal(DEFAULT_COMBAT_ACTIONS.ride.staCost,          3);
});

test("Pin / Chokehold / Ride carry the grappling prereq gate", () => {
    assert.equal(DEFAULT_COMBAT_ACTIONS.pin.prereq,       "grappling");
    assert.equal(DEFAULT_COMBAT_ACTIONS.chokehold.prereq, "grappling");
    assert.equal(DEFAULT_COMBAT_ACTIONS.ride.prereq,      "grappling");
});

test("Actions that deal SPECIAL (non-weapon) damage carry noDamage:true per rules2", () => {
    // Per rules2: Push (punch dmg), Bash (push + maybe Stagger, no weapon dmg),
    // Pin (kick to torso), Chokehold (suffocation/turn), Ride (none), Escape (none).
    // All resolved via the chat-card rider — the weapon-damage roll is skipped.
    assert.equal(DEFAULT_COMBAT_ACTIONS.push.noDamage,      true);
    assert.equal(DEFAULT_COMBAT_ACTIONS.bash.noDamage,      true);
    assert.equal(DEFAULT_COMBAT_ACTIONS.pin.noDamage,       true);
    assert.equal(DEFAULT_COMBAT_ACTIONS.chokehold.noDamage, true);
    assert.equal(DEFAULT_COMBAT_ACTIONS.ride.noDamage,      true);
    // Sanity: WEAPON-damage strikes (Single, Strong, Fast, Joint, Charge,
    // Impale, Lunge, Pommel Strike) still roll damage.
    assert.notEqual(DEFAULT_COMBAT_ACTIONS.single.noDamage,        true);
    assert.notEqual(DEFAULT_COMBAT_ACTIONS.strongAttack.noDamage,  true);
    assert.notEqual(DEFAULT_COMBAT_ACTIONS.fastAttack.noDamage,    true);
    assert.notEqual(DEFAULT_COMBAT_ACTIONS.charge.noDamage,        true);
    assert.notEqual(DEFAULT_COMBAT_ACTIONS.impale.noDamage,        true);
    assert.notEqual(DEFAULT_COMBAT_ACTIONS.lunge.noDamage,         true);
    assert.notEqual(DEFAULT_COMBAT_ACTIONS.pommelStrike.noDamage,  true);
});

test("mergeCombatActions: untouched override returns the defaults verbatim", () => {
    const merged = mergeCombatActions(DEFAULT_COMBAT_ACTIONS, {});
    assert.deepEqual(Object.keys(merged), Object.keys(DEFAULT_COMBAT_ACTIONS));
    for (const k of Object.keys(merged)) {
        assert.equal(merged[k].staCost, DEFAULT_COMBAT_ACTIONS[k].staCost);
    }
});

test("mergeCombatActions: numeric override coerces and replaces", () => {
    const merged = mergeCombatActions(DEFAULT_COMBAT_ACTIONS, {
        strongAttack: { staCost: "5", toHit: "-4" }
    });
    assert.equal(merged.strongAttack.staCost, 5);
    assert.equal(merged.strongAttack.toHit,  -4);
    // Untouched fields stay at default
    assert.equal(merged.strongAttack.dmgMult, 2);
});

test("mergeCombatActions: label / desc overrides land as labelText / descText", () => {
    const merged = mergeCombatActions(DEFAULT_COMBAT_ACTIONS, {
        bash: { label: "Shield Bash", desc: "Custom bash text." }
    });
    assert.equal(merged.bash.labelText, "Shield Bash");
    assert.equal(merged.bash.descText,  "Custom bash text.");
    // Original labelKey still present (fallback path)
    assert.ok(merged.bash.labelKey);
});

test("mergeCombatActions: defense-only fields stay on defense entries", () => {
    const merged = mergeCombatActions(DEFAULT_COMBAT_ACTIONS, {
        parry: { staCost: "2", penalty: "-1" }
    });
    assert.equal(merged.parry.staCost, 2);
    assert.equal(merged.parry.penalty, -1);
    assert.equal(merged.parry.defenseSkill, "weapon");
});

test("EDITABLE_FIELDS lists are non-empty for both kinds", () => {
    assert.ok(EDITABLE_FIELDS.attack.length  >= 5);
    assert.ok(EDITABLE_FIELDS.defense.length >= 2);
});

test("getActiveCombatActions is exported", () => {
    assert.match(src, /export function getActiveCombatActions\(\)/);
});

test("getActiveStrikeTable is exported and falls back to the legacy table when CE is off", async () => {
    const mod = await import("./actions.mjs");
    assert.equal(typeof mod.getActiveStrikeTable, "function");
    // No `game` in node — the helper must swallow and return the legacy table.
    const legacy = Object.freeze({ normal: { labelKey: "x" } });
    const out = mod.getActiveStrikeTable(legacy);
    assert.strictEqual(out, legacy);
});

test("attackDialog + weaponAttackMixin both import the strike-table accessor", () => {
    const adSrc = readFileSync(new URL("../../applications/attackDialog.mjs", import.meta.url), "utf8");
    const wmSrc = readFileSync(new URL("../../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
    assert.match(adSrc, /from\s+"[^"]*data\/combatExtended\/actions\.mjs"/);
    assert.match(wmSrc, /from\s+"[^"]*data\/combatExtended\/actions\.mjs"/);
    assert.match(adSrc, /getActiveStrikeTable/);
    assert.match(wmSrc, /getActiveStrikeTable/);
});

test("attackDialog enforces CE prereq gating (grappling / anyHold)", () => {
    const adSrc = readFileSync(new URL("../../applications/attackDialog.mjs", import.meta.url), "utf8");
    // The predicate function exists
    assert.match(adSrc, /const\s+passesPrereq\s*=\s*\(s\)\s*=>/);
    // grappling check reads the actor's statuses for "grappled"
    assert.match(adSrc, /if\s*\(need\s*===\s*"grappling"\)\s*return\s+have\.has\?\.\("grappled"\)/);
    // anyHold accepts grappled / pinned / suffocation
    assert.match(adSrc, /need\s*===\s*"anyHold"[\s\S]+have\.has\?\.\("grappled"\)[\s\S]+have\.has\?\.\("pinned"\)[\s\S]+have\.has\?\.\("suffocation"\)/);
    // Both basicOpts and specialOpts filters include passesPrereq
    const occurrences = (adSrc.match(/passesPrereq\(s\)/g) || []).length;
    assert.ok(occurrences >= 2, "passesPrereq should be applied to both option lists");
});
