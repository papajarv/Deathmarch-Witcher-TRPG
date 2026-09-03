// module/magic/legacyCard.test.mjs
//
// EXECUTING test that a cast on the new engine produces a card the REST OF THE
// SYSTEM can act on.
//
// The engine was posting a tidy card of its own design, and it was a dead end.
// Every downstream feature finds its data through `flags[SYSTEM].castContext`
// and the `category: "combat"` envelope the attack flow shares — the Roll
// Damage button, the per-target verdict blocks, the zone hooks, the rider
// handlers, the crit lookups. A spell resolved correctly and then offered
// nothing, because nothing could see that a cast had happened.
//
// The field names here are the consumers', not the engine's. Renaming any of
// them means renaming it in every reader, which is the whole reason this file
// is a translation rather than a redesign.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registerAll, castOne } from "./spells/harness.mjs";
import { buildCastContext, buildCastFlags, castVerdict } from "./legacyCard.mjs";
import { AENYE } from "./spells/fire.mjs";
import { QUEN } from "./spells/signs.mjs";
import { _resetBus } from "./bus.mjs";
import { _resetLifetimes } from "./lifetimes.mjs";

const MIXIN = readFileSync(new URL("../documents/mixins/castSpellMixin.mjs", import.meta.url), "utf8");
const SYSTEM_ID = "TheWitcherTRPG";

const item = {
    id: "i1", uuid: "Item.1", type: "spell", name: "Aenye",
    system: {
        spellForm: "spell", school: "fire", spellType: "novice", staminaCost: 5,
        targetType: "direct", range: "12m", duration: { value: "", unit: "instant" },
        variableCost: false
    }
};
const actor = { uuid: "Actor.1", name: "Yennefer" };

test.before(registerAll);
test.beforeEach(() => { _resetBus(); _resetLifetimes(); });

/* ── The shape the consumers read ────────────────────────────────────────── */

test("the cast context carries every field the old path wrote", () => {
    // Taken from the mixin's own literal, so this fails if that grows a field
    // the engine does not fill.
    const literal = MIXIN.slice(MIXIN.indexOf("const castContext = {"));
    const expected = [...literal.slice(0, literal.indexOf("\n        };")).matchAll(/^\s{12}(\w+):/gm)]
        .map(m => m[1]);
    assert.ok(expected.length >= 10, `only found ${expected.length} fields in the mixin`);

    const built = buildCastContext({ frame: {}, vars: {}, record: {}, targets: [], control: {} },
                                   { item, actor });
    const missing = expected.filter(k => !(k in built));
    assert.deepEqual(missing, [], `${missing.join(", ")} would read as undefined downstream`);
});

test("the flag envelope matches the attack flow's", () => {
    // `attackerUuid`, `engagementId` and `attackTotal` are how every
    // downstream lookup finds its way back to the cast.
    const flags = buildCastFlags({ frame: {}, vars: {}, record: {}, targets: [], control: {} },
        { item, actor, total: 18, fumble: false, engagementId: "e1", systemId: SYSTEM_ID });
    const env = flags[SYSTEM_ID];
    for (const key of ["category", "attackerUuid", "attackerName", "engagementId",
                       "attackTotal", "castContext"]) {
        assert.ok(key in env, `${key} is missing from the envelope`);
    }
    assert.equal(env.category, "combat", "a cast that is not `combat` is invisible to the handlers");
});

/* ── Filled from a real cast ─────────────────────────────────────────────── */

test("targets carry their defence total and whether they were hit", async () => {
    // `castDamage` iterates this and skips the misses. Without `hit`, a spell
    // that missed still applies damage.
    const { ctx } = await castOne(AENYE, { sta: 5, defence: 9 },
                                  [{ name: "Ghoul", uuid: "Actor.2" }]);
    const cc = buildCastContext(ctx, { item, actor });
    assert.equal(cc.targets.length, 1);
    assert.equal(cc.targets[0].uuid, "Actor.2");
    assert.equal(typeof cc.targets[0].hit, "boolean");
    assert.equal(cc.targets[0].defenseTotal, 9);
});

test("the spell's stamina and adrenaline's are kept apart", async () => {
    // `staSpent` is what "1d6 per STA" scales against. Folding a channelled
    // side-cost into it would inflate every variable spell.
    const { ctx } = await castOne(AENYE);
    ctx.declaration = { adrenalineStaCost: 3 };
    const cc = buildCastContext(ctx, { item, actor });
    assert.equal(cc.staSpent, ctx.vars.sta, "the spell's own spend");
    assert.equal(cc.adrenalineStaSpent, 3, "and adrenaline's, separately");
    assert.notEqual(cc.staSpent, cc.staSpent + cc.adrenalineStaSpent);
});

test("the behaviour fields the blocks replaced are EMPTY, not absent", () => {
    // A consumer that iterates `statusRiders` throws on `undefined` and reads
    // "no riders" from `[]`. The blocks have already applied theirs, so empty
    // is the true answer.
    const cc = buildCastContext({ frame: {}, vars: {}, record: {}, targets: [], control: {} },
                                { item, actor });
    assert.deepEqual(cc.statusRiders, []);
    assert.equal(cc.damage, null);
    assert.ok(Array.isArray(cc.components));
});

test("the area reported is the FRAME's, not the sheet's stale copy", async () => {
    const areaItem = { ...item, system: { ...item.system, areaShape: "radius", areaSize: 99 } };
    const { ctx } = await castOne(AENYE);
    ctx.frame = { ...ctx.frame, targeting: { mode: "area", shape: "cone", size: 2 } };
    const cc = buildCastContext(ctx, { item: areaItem, actor });
    assert.equal(cc.area.shape, "cone");
    assert.equal(cc.area.size, 2);
});

test("a variable spell reports the factor its damage scales by", async () => {
    const sign = { ...item, system: { ...item.system, variableCost: true, staminaCost: 2 } };
    const { ctx } = await castOne(QUEN, { sta: 6 });
    const cc = buildCastContext(ctx, { item: sign, actor });
    assert.equal(cc.variable.supported, true);
    assert.equal(cc.variable.factor, 3, "6 spent against a 2-STA base");
});

/* ── The verdict the damage button gates on ──────────────────────────────── */

test("any target hit means the card offers damage", async () => {
    const { ctx } = await castOne(AENYE, { defence: 2 }, [{ name: "A", uuid: "1" }, { name: "B", uuid: "2" }]);
    assert.equal(castVerdict(ctx), "hit");
});

test("every target missing strips the button", async () => {
    const { ctx } = await castOne(AENYE, { defence: 99 }, [{ name: "A", uuid: "1" }]);
    assert.equal(castVerdict(ctx), "miss");
});

test("an unopposed cast still counts as landing", async () => {
    // Quen has no defence to roll against; it works, so the card must not
    // report it as a miss.
    const { ctx } = await castOne(QUEN, { sta: 3 });
    assert.equal(castVerdict(ctx), "hit");
});

/* ── What the engine adds ────────────────────────────────────────────────── */

test("the card can say what the blocks actually did", async () => {
    // Nothing downstream reads this yet. It is here so a card can report what
    // happened rather than what the spell's text claims.
    const { ctx } = await castOne(AENYE, { sta: 5, percentileHits: true });
    const cc = buildCastContext(ctx, { item, actor });
    assert.ok(cc.authored.created.some(c => c.kind === "damage"));
    assert.equal(cc.authored.outcome, ctx.control.outcome);
});
