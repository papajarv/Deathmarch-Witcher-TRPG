import { t, tFormat } from "../chrome/lib/i18n.js";
import { resolveScaleAt } from "./staScale.mjs";
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
 *               label: t("WITCHER.Mech.SpellHandlers.Text.BoostNextCast", "Boost next cast:"), type: "select",
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
    const spec = resolveHandlerSpec(item);
    if (!spec) return undefined;
    const fn = spec[hookName];
    if (typeof fn !== "function") return undefined;
    try {
        return await fn(ctx);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | spell handler "${spec.__id ?? "?"}" hook "${hookName}" failed`, err);
        return undefined;
    }
}

/**
 * Resolve the handler spec for an item. First tries the explicit
 * `system.mechanicHandler` id; falls back to the item's name lowercased
 * (matching the same convention `registerSpellHandler(id, …)` uses) so
 * a spell authored in a compendium doesn't need a per-world annotation
 * to pick up its bespoke behaviour. Returns the spec augmented with the
 * resolved id under `__id` (non-enumerable-ish, just for logging), or
 * null when no match.
 */
export function resolveHandlerSpec(item) {
    const explicit = String(item?.system?.mechanicHandler ?? "").trim();
    if (explicit) {
        const spec = HANDLERS[explicit];
        if (spec) return { ...spec, __id: explicit };
        console.warn(`${SYSTEM_ID} | spell handler "${explicit}" not registered (item: ${item?.name})`);
        return null;
    }
    const nameKey = String(item?.name ?? "").trim().toLowerCase();
    if (nameKey && HANDLERS[nameKey]) return { ...HANDLERS[nameKey], __id: nameKey };
    return null;
}

/**
 * Derive {flags, stripPriorSource} for a rider from its SCHEMA alone —
 * no custom handler required. This is the primitive that lets an author
 * configure Axii-style save-penalty scaling and re-cast refresh purely
 * through the item sheet, without writing JS.
 *
 * Reads two rider-schema fields:
 *   refreshOnRecast — when true, sets a stable `stripPriorSource` key
 *                     AND stamps `flags[sys].source` with the same key,
 *                     so `handleApplyStatus`'s refresh sweep (see
 *                     socketHook.mjs) removes prior AEs from this SAME
 *                     source item on the target before applying fresh.
 *                     No stacking of duplicate stunned/paralysed effects
 *                     from repeated casts of the same sign.
 *
 *   staScaleTarget  — routes the resolved staScale value to a specific
 *                     field on the applied AE. Currently wired routes:
 *                       endCheckModifier → flags[sys].endCheckModifier
 *                         (target's Stun / Awareness save shifts by this)
 *                     Other routes ("magnitude", "duration") are honored
 *                     by the schema but need runtime wiring elsewhere;
 *                     they're no-ops here and fall through to the
 *                     clause-default resolution path used today.
 *
 * Returns null when the schema has nothing to contribute (unscaled
 * rider without refresh), so the caller can `?.` through without an
 * extra null check.
 */
function resolveSchemaRiderFlags(item, rider, castContext) {
    if (!rider) return null;
    const out = { flags: null, stripPriorSource: null };
    /* Stable per-item + per-status source key. Two different riders on
     * the SAME item (e.g. a spell that inflicts both stunned and prone)
     * refresh independently — a re-cast strips its own stunned but not
     * the prone. */
    const sourceKey = item?.id
        ? `spell:${item.id}:${rider.statusId ?? ""}`
        : null;
    if (rider.refreshOnRecast === true && sourceKey) {
        out.stripPriorSource = sourceKey;
        out.flags = out.flags ?? {};
        foundry.utils.setProperty(out.flags, `${SYSTEM_ID}.source`, sourceKey);
    }
    /* Resolve staScale → endCheckModifier stamp. Uses the shared
     * resolveScaleAt so the ladder-preview, this dispatch, and the
     * zone-enter dispatch all agree at every stamina level. Returns
     * null when the scale is default-off or the cast's stamina is
     * below baseSta (no scaling for this cast). */
    if (rider.staScaleTarget === "endCheckModifier" && rider.staScale) {
        const sta = Math.max(1, Number(castContext?.staSpent) || 1);
        const value = resolveScaleAt(rider.staScale, sta);
        if (value !== null) {
            out.flags = out.flags ?? {};
            foundry.utils.setProperty(out.flags, `${SYSTEM_ID}.endCheckModifier`, value);
        }
    }
    return (out.flags || out.stripPriorSource) ? out : null;
}

/**
 * Convenience: fetch {flags, stripPriorSource} for a specific rider.
 * Merges TWO sources:
 *   1. Schema-derived — from the rider's own staScaleTarget +
 *      refreshOnRecast fields (see resolveSchemaRiderFlags). Available
 *      to every item, no handler needed. The Axii schema path lives here.
 *   2. Handler-derived — from the item's mechanicHandler.resolveRiderFlags
 *      hook, if any. Escape hatch for spells the schema can't express.
 * Handler output wins on conflict so legacy handlers keep behaving as
 * they did before the schema route landed. Returns null when neither
 * source contributes anything, so the caller can `?.` through.
 */
export async function resolveRiderFlags(item, ctx) {
    const schemaOut = resolveSchemaRiderFlags(item, ctx?.rider, ctx?.castContext);
    const spec = resolveHandlerSpec(item);
    const fn   = spec?.resolveRiderFlags;
    let handlerOut = null;
    if (typeof fn === "function") {
        try {
            const raw = await fn(ctx);
            handlerOut = (raw && typeof raw === "object") ? raw : null;
        } catch (err) {
            console.warn(`${SYSTEM_ID} | spell handler "${spec.__id}" resolveRiderFlags failed`, err);
        }
    }
    if (!schemaOut && !handlerOut) return null;
    return {
        flags: foundry.utils.mergeObject(
            schemaOut?.flags ?? {},
            handlerOut?.flags ?? {},
            { inplace: false }
        ),
        stripPriorSource: handlerOut?.stripPriorSource ?? schemaOut?.stripPriorSource ?? null
    };
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
