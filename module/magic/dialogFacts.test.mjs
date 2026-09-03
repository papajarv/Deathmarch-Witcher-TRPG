/**
 * One reader for "what does this spell's tree need the dialog to ask?".
 *
 * The cast dialog is shared with the original engine and asks its questions
 * from the item's own fields. An authored spell keeps all of that in blocks, so
 * each question the dialog wanted to ask was being answered by a fresh inline
 * walk over `magic.on` at whichever call site needed it. That is how
 * `spellHasMagnitude` came to be computed one way in the mixin and the aiming
 * reach another way in the frame.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dialogFactsFor, DEFAULT_AIM_WITHIN } from "./dialogFacts.mjs";
import { CORPUS } from "./spells/corpus.mjs";

const sys = (on) => ({ magic: { on } });

test("a spell with no blocks needs nothing", () => {
    const f = dialogFactsFor({});
    assert.equal(f.hasBlocks, false);
    assert.equal(f.hasMagnitude, false);
    assert.equal(f.aims, false);
});

test("damage gives a magnitude, and a called shot only where the block allows one", () => {
    /* `aims` used to be true for ANY damage block, so the dialog offered a
     * called shot on Alzur's Thunder — a spell whose text names the torso —
     * and then discarded the answer. The word that means "the caster picks" is
     * `aimed`, and it is the only one that earns the control. */
    const fixed = dialogFactsFor(sys({ hit: [{ b: "core:dealDamage", a: { formula: "3d6" } }] }));
    assert.equal(fixed.hasMagnitude, true);
    assert.equal(fixed.aims, false, "the default is the torso, which is not the caster's to choose");

    const rolled = dialogFactsFor(sys({ hit: [{ b: "core:dealDamage", a: { formula: "3d6", location: "random" } }] }));
    assert.equal(rolled.aims, false, "a spell that rolls its location does not take requests either");

    const aimed = dialogFactsFor(sys({ hit: [{ b: "core:dealDamage", a: { formula: "3d6", location: "aimed" } }] }));
    assert.equal(aimed.hasMagnitude, true);
    assert.equal(aimed.aims, true);
    assert.equal(aimed.aimWithin, DEFAULT_AIM_WITHIN, "point-blank unless the block says otherwise");
});

test("a heal has a magnitude but nothing to aim", () => {
    const f = dialogFactsFor(sys({ success: [{ b: "core:healHealth", a: { formula: "2" } }] }));
    assert.equal(f.hasMagnitude, true);
    assert.equal(f.aims, false, "there is no limb to put a heal on");
});

test("the block's own reach is used", () => {
    const f = dialogFactsFor(sys({ hit: [{ b: "core:dealDamage", a: { formula: "1d6", location: "aimed", aimWithin: 4 } }] }));
    assert.equal(f.aimWithin, 4);
});

test("with several aiming blocks, the furthest wins", () => {
    /* If one part of a spell can be aimed from three metres, the caster is
     * offered the shot — the alternative is a control that appears and
     * disappears depending on which block happens to be listed first. */
    const f = dialogFactsFor(sys({ hit: [
        { b: "core:dealDamage", a: { formula: "1d6", location: "aimed", aimWithin: 1 } },
        { b: "core:dealDamage", a: { formula: "2d6", location: "aimed", aimWithin: 3 } }
    ] }));
    assert.equal(f.aimWithin, 3);
});

test("blocks nested inside gates still count", () => {
    /* Alzur's Thunder keeps its damage inside `forEachTarget`; a walk that only
     * looked at top-level nodes would call it a spell with no magnitude. */
    const f = dialogFactsFor(sys({ hit: [
        { b: "core:forEachTarget", body: [
            { b: "core:ifPercentile", a: { chance: "50" }, body: [
                { b: "core:dealDamage", a: { formula: "1d6", location: "aimed" } }
            ]}
        ]}
    ] }));
    assert.equal(f.hasMagnitude, true);
    assert.equal(f.aims, true);
});

test("the corpus agrees with itself", () => {
    /* Every spell the book says deals damage must report a magnitude, or the
     * glyph option silently vanishes for it. */
    const bad = [];
    for (const spell of CORPUS) {
        const f = dialogFactsFor({ magic: { on: spell.on } });
        const dealsDamage = JSON.stringify(spell.on ?? {}).includes("core:dealDamage");
        if (dealsDamage && !f.hasMagnitude) bad.push(`${spell.name}: damage not seen`);
        /* Aiming is not a property of dealing damage — it is a property of the
         * spell's TEXT. Igni at point blank "can be aimed at body locations";
         * Alzur's Thunder names the torso; the rest neither say nor imply it.
         * So the check is agreement between the block and the fact, in both
         * directions, rather than "damage implies a called shot". */
        const saysAimed = JSON.stringify(spell.on ?? {}).includes('"aimed"');
        if (saysAimed !== f.aims) {
            bad.push(`${spell.name}: block says aimed=${saysAimed}, dialog offers ${f.aims}`);
        }
    }
    assert.deepEqual(bad, [], "\n" + bad.join("\n"));
});
