/**
 * The socket layer must not import the magic engine.
 *
 * It used to, inside the interception handler — four `await import("../magic/…")`
 * calls per request — and it HUNG there: `socketHook.mjs` is on the same module
 * graph those files reach back into, and resolving them from inside its own
 * handler never settled. The host received the request, resolved the target and
 * stopped; the attacker timed out and resolved the attack UNWARDED while the
 * ward had already spent a charge for it.
 *
 * Invisible to every unit test and to the single-client live matrix, because
 * neither ever takes the socket path — the host runs interception inline. Found
 * only by casting from a second browser logged in as a player.
 *
 * These assertions hold the shape that fixed it: the magic side hands the
 * socket layer a function at `ready`, and the socket layer just calls it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SOCKET   = read("../setup/socketHook.mjs");
const REGISTER = read("./register.mjs");
const INTERCEPT = read("./intercept.mjs");

/** The interception handler's body, which is the part that must stay clean. */
function handlerBody(src) {
    const i = src.indexOf("async function handleInterceptionRequest");
    assert.ok(i > 0, "the handler must exist");
    return src.slice(i, src.indexOf("\n}", src.indexOf("reply(verdict)", i)));
}

test("the interception handler imports nothing", () => {
    assert.doesNotMatch(handlerBody(SOCKET), /await import\(/,
        "a dynamic import here deadlocks — the magic modules reach back into this file");
});

test("the handler calls an injected runner instead", () => {
    assert.match(SOCKET, /export function setInterceptionRunner/);
    assert.match(handlerBody(SOCKET), /_interceptionRunner\(data\)/);
});

test("a host with no runner registered answers rather than hanging", () => {
    /* Falling silent is the failure mode that costs a ward its charge for an
     * attack that lands anyway. */
    assert.match(handlerBody(SOCKET), /if \(!_interceptionRunner\) \{ reply\(null\); return; \}/);
});

test("the magic side registers the runner at ready", () => {
    assert.match(REGISTER, /setInterceptionRunner\(/);
    assert.match(REGISTER, /runHostInterception/);
});

test("the runner takes its adapter factory as a parameter", () => {
    /* `adapter.mjs` cannot load outside Foundry, and `intercept.mjs` is
     * exercised by the unit suites — a static import here took 360 tests out. */
    assert.match(INTERCEPT, /export async function runHostInterception\(data, makeAdapter\)/);
    assert.doesNotMatch(INTERCEPT, /^import .*from "\.\/adapter\.mjs"/m);
});

test("the ward's adapter is built for the DEFENDER", () => {
    /* Built for the attacker, every write the ward makes crosses a permission
     * boundary and is silently dropped. */
    assert.match(INTERCEPT, /makeAdapter\?\.\(actor\)/);
});
