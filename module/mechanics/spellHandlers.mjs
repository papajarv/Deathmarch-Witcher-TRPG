/**
 * spellHandlers — registry for bespoke spell behaviour that can't
 * (or shouldn't) live in schema fields.
 *
 * ~180 spells in the corpus; ~55 fit the schema cleanly. The tail
 * has mechanic snowflakes: Empower buffs your NEXT spell; Dispel
 * hunts for an active AE; Wrath of Nature picks one of seven biome
 * branches based on scene environment; Omens of the Future forces a
 * fumble on a specific rolled d10. Trying to encode all of these as
 * schema flags produces an unbounded field list. Instead, an item
 * carries `system.mechanicHandler: "&lt;id&gt;"` and code lives in a
 * handler registered here.
 *
 * A handler is an object with any subset of these hook methods
 * (all `async`). The cast flow (castSpellMixin) invokes each one at
 * a documented point, passing a context bag the handler may mutate:
 *
 *   onCastDialog({ actor, item, dialogContext }) —
 *     Fired BEFORE openCastDialog. Handler may push extra fields
 *     into `dialogContext.extraFields` (rendered by the dialog
 *     under the STA / mod block). Return value ignored.
 *
 *   onBeforeRoll({ actor, item, castContext, decl }) —
 *     Fired AFTER dialog closes, BEFORE extendedRoll. Handler may
 *     mutate `castContext` (damage, area, riders) or set
 *     `castContext.abort = true` to cancel the cast (no STA spent).
 *     `decl` is the raw dialog result.
 *
 *   onAfterRoll({ actor, item, castContext, message, result }) —
 *     Fired AFTER the roll lands and defense fan-out completes.
 *     Handler may append to the chat card (via appendAttackResult),
 *     stamp additional flags, spawn linked messages, etc.
 *
 *   onDamageApplied({ actor, item, castContext, targetActor, amount, message }) —
 *     Fired inside the Roll Damage flow, once per target that took
 *     damage. Handler may react (spawn linked riders, trigger a
 *     secondary effect, etc.).
 *
 *   onDefend({ defenderActor, castContext, choice }) —
 *     Fired when a defender's owner is prompted. Handler may
 *     override `choice` or add a reactive-cast option.
 *
 *   onZoneEnter({ token, actor, template, castContext }) —
 *   onZoneExit({ token, actor, template, castContext }) —
 *   onZoneTick({ token, actor, template, castContext }) —
 *     Fired by the zone engine (see zoneEffects.mjs) when a token
 *     crosses / leaves / stays inside a persistent template that
 *     was created by this spell. Handler runs GM-side only.
 *
 * All hooks are OPTIONAL. Missing hook = no-op. Handlers do not
 * replace schema — they augment it. A spell can have BOTH schema
 * fields AND a handler; the schema fires first, then the handler
 * runs and can rewrite.
 *
 * @example
 *   registerSpellHandler("empower", {
 *       async onCastDialog({ dialogContext }) {
 *           dialogContext.extraFields.push({ id: "empowerTarget",
 *               label: "Boost next cast:", type: "select",
 *               options: [{ v: "damage", l: "+2d6 damage" },
 *                         { v: "roll",   l: "+2 to roll" },
 *                         { v: "riders", l: "riders auto-hit" }] });
 *       },
 *       async onAfterRoll({ actor, decl }) {
 *           await actor.setFlag(SYSTEM_ID, "empowerNext", {
 *               target: decl.empowerTarget,
 *               expiresAt: game.time.worldTime + 30
 *           });
 *       }
 *   });
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Registry — id -&gt; handler-spec. Frozen at module load; write only
 * via `registerSpellHandler`. */
const HANDLERS = Object.create(null);

/**
 * Register a handler under a unique id. Overwrites if the id is
 * already present (a later module can replace a base handler by
 * re-registering with the same id — useful for GM override modules).
 * @param {string} id
 * @param {object} spec  see file header for the hook menu
 */
export function registerSpellHandler(id, spec) {
    if (!id || typeof id !== "string") {
        console.warn(`${SYSTEM_ID} | registerSpellHandler needs a non-empty id`);
        return;
    }
    HANDLERS[id] = spec ?? {};
}

/**
 * Fetch a handler by id. Returns null for missing / empty ids so
 * call sites can `?.` through the hook chain safely.
 * @param {string} id
 * @returns {object|null}
 */
export function getSpellHandler(id) {
    if (!id) return null;
    return HANDLERS[id] ?? null;
}

/**
 * Fire a specific hook on a handler resolved from the item.
 * Convenience wrapper that (a) resolves the id from
 * `item.system.mechanicHandler`, (b) looks up the handler, (c)
 * invokes the hook if it exists, (d) soft-fails on error so a bad
 * handler can't cancel a whole cast flow.
 *
 * @param {Item}   item      the spell / hex / ritual being cast
 * @param {string} hookName  one of the documented hook names
 * @param {object} ctx       context bag passed to the hook
 * @returns {Promise&lt;any&gt;} the hook's return value, or `undefined`
 */
export async function invokeSpellHook(item, hookName, ctx) {
    const id = String(item?.system?.mechanicHandler ?? "").trim();
    if (!id) return undefined;
    const spec = HANDLERS[id];
    if (!spec) {
        console.warn(`${SYSTEM_ID} | spell handler "${id}" not registered (item: ${item?.name})`);
        return undefined;
    }
    const fn = spec[hookName];
    if (typeof fn !== "function") return undefined;
    try {
        return await fn(ctx);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | spell handler "${id}" hook "${hookName}" failed`, err);
        return undefined;
    }
}

/**
 * Enumerate registered handler ids. Used by the item sheet's
 * mechanicHandler dropdown so authors can pick from a live list
 * without hard-coding names.
 * @returns {string[]}
 */
export function listSpellHandlerIds() {
    return Object.keys(HANDLERS).sort();
}
