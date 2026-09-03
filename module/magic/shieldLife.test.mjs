/**
 * A spent shield must actually end.
 *
 * `absorbDamage` ends its shield with `fireCondition(ctx.state.life, ...)`.
 * The state object handed to subscribers is built before the lifetime exists,
 * so unless the lifetime is attached back onto it, `state.life` is undefined
 * and `fireCondition` bails silently — the shield's expiry tree never runs and
 * its lifetime entry never leaves the live list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CORE = code(readFileSync(join(HERE, "blocks/core.mjs"), "utf8"));
const DEF  = code(readFileSync(join(HERE, "blocks/defensive.mjs"), "utf8"));

test("the shield's lifetime is reachable from the state its subscribers hold", () => {
    /* `?.` since the pool moved to the actor: a ward can now drain a shield
     * that outlived its subscription's state (a reload, a GM edit), and the
     * lifetime is still what ends it. */
    assert.match(DEF, /fireCondition\(ctx\.state\?\.life/,
        "absorbDamage no longer ends the shield through state.life — update this test");
    assert.match(CORE, /state\.life = life/,
        "createShield must attach the lifetime to the shared state, or poolEmpty can never fire");
    const attach = CORE.indexOf("state.life = life");
    const create = CORE.indexOf("const life = lifetimeFrom");
    assert.ok(create !== -1 && attach > create, "the lifetime must exist before it is attached");
});
