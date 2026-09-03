/**
 * A spell that deals damage can be aimed, the way a weapon can.
 *
 * The cast dialog never offered a called shot, so every damaging spell hit a
 * random location and a caster could not choose to go for the head — while the
 * attack dialog had offered exactly that, off the same `ATTACK_LOCATIONS`
 * table, all along. And the cast card carried no hit-location block, so even a
 * spell that DID land somewhere specific read as a different kind of card from
 * a sword swing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAll } from "./spells/harness.mjs";
import { getBlock } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const DIALOG = code(readFileSync(join(HERE, "..", "applications", "castDialog.mjs"), "utf8"));
const CAST   = code(readFileSync(join(HERE, "cast.mjs"), "utf8"));

registerAll();

async function whereItLanded(declaration, authored, targets = 1, faces = [1, 7, 3, 9]) {
    const seen = [];
    let n = 0;
    const ctx = {
        actor: { name: "C" }, item: { name: "S" },
        targets: Array.from({ length: targets }, (_, i) => ({ actor: { name: `T${i}` }, hit: true })),
        record: { castId: "x" }, vars: {}, created: [], control: {}, frame: {},
        declaration,
        adapter: { rollFormula: async () => 6,
                   /* The system's own d10 table, faked to a known sequence so
                    * the test can tell "rolled once" from "rolled again". */
                   rollLocation: async () => {
                       const face = faces[n++ % faces.length];
                       const key = face === 1 ? "head" : face === 7 ? "rightLeg" : face === 3 ? "torso" : "leftArm";
                       return { key, face, mult: key === "head" ? 3 : 1, label: key };
                   },
                   applyDamage: async (_t, _n, o) => { seen.push(o.location); return { penetrated: true, finalDamage: 6 }; } }
    };
    await getBlock("core:dealDamage").run(ctx, {
        formula: "1d6", damageType: "fire", location: authored,
        bypassArmour: false, channel: null, nonLethal: false }, {});
    return targets === 1 ? seen[0] : seen;
}

/** Run one damage block twice on the same context, as a two-block tree would. */
async function twice(declaration, authored, targets = 1) {
    const seen = [];
    let n = 0;
    const faces = [1, 7, 3, 9];
    const ctx = {
        actor: { name: "C" }, item: { name: "S" },
        targets: Array.from({ length: targets }, (_, i) => ({ actor: { name: `T${i}` }, hit: true })),
        record: { castId: "x" }, vars: {}, created: [], control: {}, frame: {},
        declaration,
        adapter: { rollFormula: async () => 6,
                   rollLocation: async () => {
                       const face = faces[n++ % faces.length];
                       const key = face === 1 ? "head" : face === 7 ? "rightLeg" : face === 3 ? "torso" : "leftArm";
                       return { key, face, mult: 1, label: key };
                   },
                   applyDamage: async (_t, _n, o) => { seen.push(o.location); return { finalDamage: 6 }; } }
    };
    const a = { formula: "1d6", damageType: "fire", location: authored,
                bypassArmour: false, channel: null, nonLethal: false };
    await getBlock("core:dealDamage").run(ctx, a, {});
    await getBlock("core:dealDamage").run(ctx, a, {});
    return seen;
}

const HEAD = { location: { mode: "specific", key: "head", mult: 3, penalty: -6, label: "Head" } };

test("a called shot reaches the damage", async () => {
    assert.equal(await whereItLanded(HEAD, "random"), "head");
});

test("an author who fixed the location wins", async () => {
    /* "Always the torso" means it — the caster does not get to override a
     * spell that names where it strikes. */
    assert.equal(await whereItLanded(HEAD, "torso"), "torso");
});

/* ── The four words, and what each one means ─────────────────────────────
 *
 * Two of them used to mean nothing. `aimed` and `perAttack` were handed to the
 * damage pipeline as literals; `resolveLocation` knows neither and falls back
 * to a torso x1 without saying so. That is why Igni at point blank threw away
 * the caster's called shot, and why Tryferi Gaeaf — "each roll counts as its
 * own separate attack when determining location" — hit the same chest five
 * times. A fifth word, `chosen`, meant the same as `aimed` and was handled
 * nowhere; it is gone.
 */
test("aimed, with nobody aiming, is the TORSO", async () => {
    /* "Igni always deals damage to the torso unless used at point blank range.
     * When used at point blank range Igni can be aimed at body locations." */
    assert.equal(await whereItLanded({}, "aimed"), "torso");
    assert.equal(await whereItLanded(null, "aimed"), "torso");
    assert.equal(await whereItLanded({ location: { mode: "random", kind: "human" } }, "aimed"), "torso");
});

test("aimed, with a called shot, is the called shot", async () => {
    assert.equal(await whereItLanded(HEAD, "aimed"), "head");
});

test("random rolls a real location, and never sends the word onward", async () => {
    const landed = await whereItLanded({}, "random");
    assert.equal(landed, "head", "the faked d10 said 1");
    assert.notEqual(landed, "random", "the word itself must never reach the damage pipeline");
});

test("random rolls ONCE PER TARGET and keeps it for the rest of the cast", async () => {
    /* One victim, two damage blocks: one attack, one place. */
    assert.deepEqual(await twice({}, "random"), ["head", "head"]);
    /* Two victims: each is struck somewhere of their own — a cone does not
     * burn five people in the same shoulder. */
    assert.deepEqual(await twice({}, "random", 2), ["head", "rightLeg", "head", "rightLeg"]);
});

test("perAttack rolls fresh every single time", async () => {
    /* Carys' Gale and Tryferi Gaeaf: "Each roll counts as its own separate
     * attack when determining location and dealing damage." */
    assert.deepEqual(await twice({}, "perAttack"), ["head", "rightLeg"]);
});

test("a called shot outranks anything that rolls", async () => {
    assert.equal(await whereItLanded(HEAD, "random"), "head");
    assert.equal(await whereItLanded(HEAD, "perAttack"), "head");
});

test("the dropdown offers only words that do something", () => {
    const opts = getBlock("core:dealDamage").inputs.location.options;
    /* The four rules... */
    for (const rule of ["aimed", "random", "perAttack", "torso"]) assert.ok(opts.includes(rule), rule);
    /* ...and the six real places, because spells name them. */
    for (const key of ["head", "leftArm", "rightArm", "leftLeg", "rightLeg"]) {
        assert.ok(opts.includes(key), `${key} must be offerable — Cadfan's Grasp burns a specific limb`);
    }
    assert.ok(!opts.includes("chosen"), "the word that never did anything is gone");
});

test("the dialog offers the shot off the shared location table", () => {
    assert.match(DIALOG, /ATTACK_LOCATIONS/,
        "the cast dialog must use the same table as the attack dialog, or the two drift");
    assert.match(DIALOG, /name="location"/);
    /* only for a spell with damage to place */
    assert.match(DIALOG, /const spellAims = /);
});

test("the called shot's penalty is folded into the roll", () => {
    assert.match(DIALOG, /\+ \(Number\(location\.penalty\) \|\| 0\)/,
        "aiming for the head must cost the -6, or it is a free multiplier");
});

test("the cast card carries the same hit-location block as an attack", () => {
    assert.match(CAST, /wdm-attack-hit-loc/,
        "the spell card must use the weapon card's own markup, not a lookalike");
    /* Built from the damage that LANDED, not from what the caster asked for.
     * The declaration carries the word "Random (humanoid)" whenever nobody
     * called a shot, so a card built from it announced a hit location on a
     * knockback spell that struck nobody anywhere. */
    assert.match(CAST, /c\.kind !== "damage"/,
        "the location block must be built from ctx.created damage, not the declaration");
    assert.match(CAST, /l\.mult !== 1/, "and carry the damage multiplier, as the attack card does");
    assert.match(CAST, /landed\.length > 1/,
        "several victims, several places — random rolls one location per target");
    assert.match(CAST, /WITCHER\.Magic\.DefendedWith/,
        "the card should say what the target defended with, as the attack card does");
});

test("the template is placed BEFORE the dialog opens", async () => {
    /* Not cosmetic: until the template has landed nobody knows who is caught
     * or how far away they are, and the dialog needs both to decide whether a
     * called shot is even on offer. */
    const { STAGES } = await import("./frame.mjs");
    const order = STAGES.map(([label]) => label.replace(/^L\d+ /, ""));
    assert.ok(order.indexOf("targets") < order.indexOf("declare"),
        `aim must come before the dialog — got ${order.join(" -> ")}`);
    /* and both still before the charge */
    assert.ok(order.indexOf("declare") < order.indexOf("price"));
    assert.ok(order.indexOf("targets") < order.indexOf("validate"));
});

test("a called shot is only offered to someone within reach", async () => {
    const { declare } = await import("./frame.mjs");
    /* The item needs a TREE — reach is now the block's word, not a constant,
     * so a spell with nothing that aims is correctly never aimable. */
    const withDamage = { name: "S", system: { magic: { on: { hit: [
        { b: "core:dealDamage", a: { formula: "1d6", location: "aimed" } }
    ] } } } };
    const at = (metres, item = withDamage) => ({
        actor: { name: "C" }, item,
        frame: {}, targets: metres.map(d => ({ actor: { d } })),
        control: {}, vars: {}, created: [], record: {},
        adapter: {
            distanceBetween: async (_a, t) => t.d,
            declareCast: async (_a, _f, opts) => { seen = opts; return {}; }
        }
    });
    let seen = null;

    await declare(at([1]));
    assert.equal(seen.aimable, true, "adjacent should allow a called shot");

    await declare(at([2]));
    assert.equal(seen.aimable, false, "2m away is too far to pick a limb");

    await declare(at([5, 1]));
    assert.equal(seen.aimable, true, "the NEAREST caught target is what counts");

    await declare(at([]));
    assert.equal(seen.aimable, false, "a spell that caught nobody has nothing to aim at");

    /* A spell whose damage names its own place is never aimable either — the
     * question is already answered and asking it would throw the answer away. */
    await declare(at([1], { name: "Fixed", system: { magic: { on: { hit: [
        { b: "core:dealDamage", a: { formula: "1d6", location: "torso" } }
    ] } } } }));
    assert.equal(seen.aimable, false, "torso means torso, so there is nothing to choose");

    /* A spell with no aiming block is never aimable, however close you are. */
    await declare(at([1], { name: "Buff", system: { magic: { on: { success: [
        { b: "core:healHealth", a: { formula: "2" } }
    ] } } } }));
    assert.equal(seen.aimable, false, "a heal has nowhere to put a called shot");

    /* And a block that says it reaches further is taken at its word. */
    await declare(at([3], { name: "Reach", system: { magic: { on: { hit: [
        { b: "core:dealDamage", a: { formula: "1d6", location: "aimed", aimWithin: 3 } }
    ] } } } }));
    assert.equal(seen.aimable, true, "the BLOCK decides how close is close enough");
});

test("the dialog treats an absent verdict as no opinion", () => {
    /* The legacy path has no template step, so it cannot answer — and there
     * the old behaviour has to hold rather than silently losing the control. */
    const DIALOG = code(readFileSync(join(HERE, "..", "applications", "castDialog.mjs"), "utf8"));
    assert.match(DIALOG, /ctx\.aimable === null \|\| ctx\.aimable === undefined \? true : ctx\.aimable === true/);
    assert.match(DIALOG, /aimable: opts\.aimable/, "openCastDialog must forward it, or the gate never arrives");
});
