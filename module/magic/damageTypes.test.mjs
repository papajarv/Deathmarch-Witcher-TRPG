/**
 * Every damage type a spell deals must be one the system registers.
 *
 * An unregistered type is not rejected anywhere — it simply matches no
 * resistance and no vulnerability. So a creature that shrugs off cold took full
 * damage from an "ice" spell, and `core:dealDamage`'s own DEFAULT was
 * `physical`, which is not a type either: a freshly dropped damage block
 * resisted nothing at all.
 *
 * The corpus was using four that do not exist — `ice`, `water`, `force` and
 * `suffocation` (the last already carries its real meaning in `channel`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DAMAGE_TYPES } from "../setup/config.mjs";
import { CORPUS } from "./spells/corpus.mjs";
import { registerAll } from "./spells/harness.mjs";
import { getBlock } from "./registry.mjs";

registerAll();
const KNOWN = new Set(Object.keys(DAMAGE_TYPES));

function walk(body, fn) {
    for (const n of body ?? []) { fn(n); if (n.body) walk(n.body, fn); }
}

test("the damage block's default is a real type", () => {
    const dflt = getBlock("core:dealDamage").inputs.damageType.default;
    assert.ok(KNOWN.has(dflt),
        `dropping a damage block defaults to "${dflt}", which resists nothing`);
});

test("every damage type in the corpus is registered", () => {
    const bad = [];
    for (const spell of CORPUS) {
        for (const [entry, body] of Object.entries(spell.on ?? {})) {
            walk(body, (n) => {
                const t = n?.a?.damageType;
                if (t && !String(t).startsWith("{") && !KNOWN.has(t)) {
                    bad.push(`${spell.name}.${entry}: "${t}"`);
                }
            });
        }
    }
    assert.deepEqual(bad, [], `\n${bad.join("\n")}\nknown: ${[...KNOWN].join(", ")}`);
});

test("a damage CHANNEL is not a damage type", () => {
    /* They are separate vocabularies and the block has an input for each.
     * `suffocation` is a channel; using it as a type is how the confusion
     * showed up. */
    const CHANNELS = ["attack", "poison", "disease", "suffocation", "burning", "bleeding"];
    for (const c of CHANNELS) {
        if (c === "attack") continue;
        assert.ok(!KNOWN.has(c), `"${c}" is a channel and must not double as a damage type`);
    }
});
