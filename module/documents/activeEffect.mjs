/**
 * WitcherActiveEffect — base ActiveEffect document.
 *
 * Hosts the unified action model. The friendly AE editor stores a single list
 * of action rows at flags.<systemId>.actions[]; each row's `type` selects a
 * behavior. The *modifier* actions are compiled here into native v14 change
 * objects (system.changes) so Foundry's own change-application engine applies
 * them — we don't reimplement stat math. Event actions (heal/damage) and gate
 * actions (suppress) are read by their own backends (the tick engine and
 * character.prepareDerivedData respectively) and are ignored here.
 */

import { compileActionsToChanges, isActionValueFormula, normalizeAction } from "../setup/config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Seconds-per-unit for a Foundry v14 duration.units value. Mirrors the
 * table in chrome/policy/tick-effects.js — kept local rather than imported
 * so this module has no cross-module cycle risk during doc init. */
const DURATION_UNIT_SECONDS = Object.freeze({
    seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800,
    months: 2628000, years: 31536000
});

/* Roll a dice formula asynchronously. Used from _preCreate / _onCreate which
 * are both async — Foundry v14's `Roll.evaluate()` is async because the DsN
 * / seeded-RNG pipeline is inherently async. Returns null on a bad formula so
 * callers can fall back gracefully. Result is captured once and then reused
 * for the AE's lifetime via the persisted rolledValues cache. */
async function rollFormulaAsync(expr) {
    const f = String(expr ?? "").trim();
    if (!f) return null;
    try {
        const r = new Roll(f);
        await r.evaluate();
        const n = Number(r.total);
        return Number.isFinite(n) ? Math.floor(n) : null;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | bad AE formula "${f}"`, err);
        return null;
    }
}

/* SYNC fallback — for the prepareBaseData path, which is called many times
 * per interaction and MUST be synchronous (returning a Promise would break
 * the derived-data pipeline). Handles the common shapes:
 *   NdM             → sum of N random 1..M rolls
 *   NdM+K / NdM-K   → same, with a flat modifier
 *   K               → the number K
 * Anything more complex (kh, r, math, references, chained ops) returns null
 * and the compile step will pass the raw string to Foundry — which coerces
 * unknown values to 0. The user should re-save the AE to persist a proper
 * async roll into rolledValues; this fallback just keeps legacy AEs
 * useful until then. */
function rollFormulaFallback(expr) {
    const f = String(expr ?? "").trim();
    if (!f) return null;
    // Plain numeric
    if (/^[+-]?\d+(?:\.\d+)?$/.test(f)) return Math.floor(Number(f));
    // NdM (+/- K)? Case-insensitive; whitespace tolerated around 'd' and sign.
    const m = /^(\d+)\s*d\s*(\d+)(?:\s*([+-])\s*(\d+))?$/i.exec(f);
    if (!m) return null;
    const n = Number(m[1]);
    const sides = Number(m[2]);
    const sign = m[3] === "-" ? -1 : 1;
    const flat = m[4] != null ? Number(m[4]) : 0;
    if (!Number.isFinite(n) || !Number.isFinite(sides) || sides < 1 || n < 1) return null;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.floor(Math.random() * sides) + 1;
    return sum + sign * flat;
}

/* Compute the rolledValues map for a set of actions. One roll per modify+
 * always action whose value is a dice formula; other actions are skipped and
 * omitted from the map. Async when possible (full Roll parser); the caller
 * can also pass a sync `rollFn` to use the fallback parser inside a sync
 * context like prepareBaseData. */
/* True if this action's dice value should be pre-rolled and cached: any
 * modify action whose WHEN routes to a passive path (always / condition)
 * OR to the one-off pool bump (onceOnApply — syncOneOffBumps reads the
 * cache back so the chat card and the applied number stay in lockstep).
 * Recurring "perTurn" (tick) actions roll fresh each turn and are NOT
 * cached here; event triggers (eachTurn / roundStart / etc.) accumulate
 * in the event ledger with their own dice handling. */
function shouldPreRollAction(a) {
    if (!a || a.type !== "modify") return false;
    return a.when === "always" || a.when === "condition" || a.when === "onceOnApply";
}

async function computeRolledActionValues(actions) {
    if (!Array.isArray(actions)) return {};
    const out = {};
    for (let i = 0; i < actions.length; i++) {
        const a = normalizeAction(actions[i]);
        if (!shouldPreRollAction(a)) continue;
        if (!isActionValueFormula(a.value)) continue;
        const n = await rollFormulaAsync(a.value);
        if (n != null) out[i] = n;
    }
    return out;
}

function computeRolledActionValuesSync(actions) {
    if (!Array.isArray(actions)) return {};
    const out = {};
    for (let i = 0; i < actions.length; i++) {
        const a = normalizeAction(actions[i]);
        if (!shouldPreRollAction(a)) continue;
        if (!isActionValueFormula(a.value)) continue;
        const n = rollFormulaFallback(a.value);
        if (n != null) out[i] = n;
    }
    return out;
}

/* Is this AE about to APPLY to an actor? Two shapes count:
 *   1. Parent is an Actor — the AE was created directly on the actor
 *      (consume-item potion apply, drag-effect-to-actor, macro-created).
 *   2. Parent is an Item whose parent is an Actor — the AE lives on an
 *      embedded item (worn armor, race passive, weapon quality) with
 *      transfer:true, so its changes propagate to the wearer.
 * Pure item templates (world / compendium items with no actor context) are
 * NOT pre-rolled — their dice values must stay authored formulas until the
 * item lands on a bearer, so each bearer rolls fresh. */
/* Compile a customStatus flag's mods.stats / mods.skills into native AE
 * changes. Shape mirrors statusEngine.change() (used by statusChanges for
 * world clauses): {key, value:String, type:"add", phase:"initial", priority:0}.
 * Only non-zero entries produce changes. Called from prepareBaseData so the
 * changes land in system.changes and Foundry's change-application engine
 * applies them the same way it does for world-status stat debuffs. */
function _compileCustomStatusMods(cs) {
    const out = [];
    const change = (key, value) => ({ key, value: String(value), type: "add", phase: "initial", priority: 0 });
    const stats = cs?.mods?.stats;
    if (stats && typeof stats === "object") {
        for (const [k, n] of Object.entries(stats)) {
            const v = Number(n);
            if (Number.isFinite(v) && v !== 0) out.push(change(`system.stats.${k}.modifier`, v));
        }
    }
    const skills = cs?.mods?.skills;
    if (skills && typeof skills === "object") {
        // Skills schema: mods.skills.<statKey>.<skillKey> = number  (matches
        // statusChanges convention). The custom-status editor doesn't currently
        // expose per-skill mods, but the format is honoured for future use.
        for (const [statKey, group] of Object.entries(skills)) {
            if (!group || typeof group !== "object") continue;
            for (const [skillKey, n] of Object.entries(group)) {
                const v = Number(n);
                if (Number.isFinite(v) && v !== 0) out.push(change(`system.skills.${statKey}.${skillKey}.modifier`, v));
            }
        }
    }
    return out;
}

function willApplyToActor(ae) {
    const p = ae?.parent;
    if (p instanceof Actor) return true;
    if (p?.documentName === "Item" && p.parent instanceof Actor) return true;
    return false;
}

/* In-memory fallback for AEs whose persisted `rolledValues` cache never
 * populated — typically:
 *   - Legacy AEs authored before the pre-roll hooks existed (no rolledValues
 *     flag on disk).
 *   - Edge cases where _preCreate / _onCreate on a non-GM client can't
 *     write back (permission gate, race with the create hook).
 * Keyed by ae.uuid + a hash of the actions[] array so an actions edit
 * invalidates automatically. Values persist for the lifetime of the JS
 * session; a page reload re-rolls. Not written to disk (compileActionsToChanges
 * is called from prepareBaseData, which runs many times per interaction and
 * must be synchronous — an actor.update from here would loop). */
const _rolledFallbackCache = new Map();   // key: uuid|hash → { [index]: number }

function actionsCacheKey(uuid, actions) {
    // Cheap deterministic hash: JSON.stringify of the value/type/when triples
    // only, so unrelated field edits (target, op) don't invalidate the roll.
    const summary = (actions ?? []).map(a => [a?.type, a?.value, a?.when]);
    return `${uuid}|${JSON.stringify(summary)}`;
}

function fallbackRolledValues(effect) {
    const uuid = effect?.uuid;
    const actions = effect?.flags?.[SYSTEM_ID]?.actions;
    if (!uuid || !Array.isArray(actions)) return null;
    const key = actionsCacheKey(uuid, actions);
    let cached = _rolledFallbackCache.get(key);
    if (cached) return cached;
    const rolled = computeRolledActionValuesSync(actions);
    if (!Object.keys(rolled).length) return null;
    _rolledFallbackCache.set(key, rolled);
    return rolled;
}

/* Async — roll the modify-action + durationFormula fields on `data`. Returns
 * `{ patch, rolledValues, rolledDuration }` — the patch to apply via
 * updateSource, and the raw rolled numbers so callers (e.g. consume-item's
 * chat card) can report what got rolled without doing the work twice.
 *
 * Skips re-rolling when data already carries `rolledValues` / `duration.value`,
 * so a caller that pre-rolls can populate those and _preCreate won't clobber
 * with a second roll. Uses getProperty for both nested and dot-flat shapes. */
export async function applyRolledValuesToData(data) {
    const patched = {};
    const actionsPath = `flags.${SYSTEM_ID}.actions`;
    const rolledPath  = `flags.${SYSTEM_ID}.rolledValues`;
    const formulaPath = `flags.${SYSTEM_ID}.durationFormula`;

    const actions = foundry.utils.getProperty(data, actionsPath);
    let rolledValues = foundry.utils.getProperty(data, rolledPath);
    const hasPreRolled = rolledValues && typeof rolledValues === "object"
                      && Object.keys(rolledValues).length > 0;
    if (!hasPreRolled) {
        rolledValues = await computeRolledActionValues(actions);
        if (Object.keys(rolledValues).length) {
            patched[rolledPath] = rolledValues;
        }
    }

    // durationFormula ALWAYS wins when set — that's the whole point of the
    // formula field. Ignore any authored duration.value in favor of the
    // fresh roll. If the user wants a fixed duration, they set duration.value
    // and leave the formula blank.
    const formula = String(foundry.utils.getProperty(data, formulaPath) ?? "").trim();
    let rolledDuration = null;
    if (formula) {
        rolledDuration = await rollFormulaAsync(formula);
        if (rolledDuration != null) patched["duration.value"] = Math.max(1, rolledDuration);
    }

    return { patch: patched, rolledValues, rolledDuration };
}

export class WitcherActiveEffect extends ActiveEffect {

    /** Gate Foundry's expiry check on this AE actually having a meaningful
     *  duration. Foundry v14's `ActiveEffectRegistry#refresh` treats
     *  `duration.remaining === Infinity` (the value for no-duration AEs) as
     *  `durationReached`, and its `isExpiryEvent("updateWorldTime")` returns
     *  true whenever `duration.expiry` is falsy — the combination means an AE
     *  with no duration AND no expiry would be added to the expired batch on
     *  every worldTime advance. Coupled with our `expiryAction = "delete"`
     *  (see chrome/policy/tick-effects.js), that would nuke every permanent
     *  AE the moment time ticks. Read the COMPUTED `duration.remaining` (which
     *  Foundry sets to Infinity for no-duration AEs at foundry.mjs:49761) —
     *  raw `duration.value` isn't a reliable signal because a fresh AE has
     *  `value = 0`, and `Number.isFinite(0)` is true. Only defer to core for
     *  AEs whose remaining is a finite number, so real expiries still fire
     *  deleteActiveEffect for the reclaim hooks. */
    isExpiryEvent(event, context) {
        const remaining = this.duration?.remaining;
        if (!Number.isFinite(remaining)) return false;
        // Belt-and-braces: an AE carrying a durationFormula whose roll hasn't
        // populated a positive duration.value (create/update ran into an
        // async race, restore-on-reload dropped the rolled value, etc.) has
        // remaining=0 in the eyes of the core registry. Treat it as pending
        // instead of expired so the reroll pathways get a chance to fill it
        // in without the effect vanishing under them.
        const formula = String(this.flags?.[SYSTEM_ID]?.durationFormula ?? "").trim();
        if (formula && !(Number(this.duration?.value) > 0)) return false;
        return super.isExpiryEvent(event, context);
    }

    /** Roll dice-formula authored fields ONCE at effect creation, so the
     *  applied buff carries a concrete integer for the rest of its life:
     *
     *   - modify-action values ("1d6+2 STR" → the rolled total, stashed at
     *     flags.<sys>.rolledValues.<index>). Foundry's change engine casts
     *     change.value via Number(raw) || 0, so a dice string would drop to
     *     zero without this pre-roll.
     *   - durationFormula ("1d6/2 rounds" → duration.value).
     *
     *  Fires for AEs landing on an actor OR on an actor's embedded item
     *  (transfer:true buffs — worn armor, race passives, applied oils). */
    async _preCreate(data, options, user) {
        const allowed = await super._preCreate(data, options, user);
        if (allowed === false) return false;
        if (!willApplyToActor(this)) return;

        const { patch } = await applyRolledValuesToData(data);

        /* Stamp `fromAlchemicalItem` when this AE's origin resolves to an
         * item of type "alchemical" (potion, oil, decoction, substance,
         * bomb). Done ONCE at create time so the tick-engine's pause check
         * is a flag read — no per-tick UUID resolution. Read by
         * chrome/policy/tick-effects. */
        if (!foundry.utils.getProperty(data, `flags.${SYSTEM_ID}.fromAlchemicalItem`)) {
            const origin = data?.origin || this.origin || "";
            if (origin) {
                try {
                    const doc = await fromUuid(origin);
                    if (doc?.documentName === "Item" && doc?.type === "alchemical") {
                        patch[`flags.${SYSTEM_ID}.fromAlchemicalItem`] = true;
                    }
                } catch (_) { /* origin doesn't resolve — leave flag unset */ }
            }
        }

        /* Custom-status id sync — if this AE authors an item-local status
         * clause (customStatus.enabled + id), make sure the id is in
         * `statuses[]` so Foundry treats it as a real status: token icon
         * renders, actor.statuses contains the id, and clauseFor(id, actor)
         * finds this AE first (see mechanics/statusEngine.mjs). */
        const cs = foundry.utils.getProperty(data, `flags.${SYSTEM_ID}.customStatus`);
        const csId = String(cs?.id ?? "").trim();
        if (cs?.enabled && csId) {
            const cur = Array.isArray(data?.statuses) ? data.statuses : [];
            if (!cur.includes(csId)) patch.statuses = [...cur, csId];
        }

        if (Object.keys(patch).length) this.updateSource(patch);
    }

    /** Belt-and-braces: if _preCreate's updateSource didn't stick (some
     *  create paths hydrate the doc BEFORE _preCreate observes the flag
     *  edit, particularly toObject-derived shapes from consume-item), do a
     *  post-create update. Idempotent: skip when rolledValues already exists
     *  in flags, so a second create pass can't clobber the first roll. */
    async _onCreate(data, options, userId) {
        await super._onCreate(data, options, userId);
        if (game.user?.id !== userId) return;
        if (!willApplyToActor(this)) return;

        const flags = this.flags?.[SYSTEM_ID] ?? {};
        const hasRolled = flags.rolledValues && Object.keys(flags.rolledValues).length > 0;
        const needsDuration = String(flags.durationFormula ?? "").trim() && !(Number(this.duration?.value) > 0);

        if (!hasRolled) {
            const rolled = await computeRolledActionValues(flags.actions);
            if (Object.keys(rolled).length) {
                await this.update({ [`flags.${SYSTEM_ID}.rolledValues`]: rolled });
            }
        }
        if (needsDuration) {
            const n = await rollFormulaAsync(String(flags.durationFormula).trim());
            if (n != null) await this.update({ "duration.value": Math.max(1, n) });
        }
    }

    /** When the actions array is edited, invalidate any stale rolledValues
     *  cache for changed / removed indexes. A simple full-recompute keeps the
     *  logic uniform: on any actions[] change, re-roll every dice-formula
     *  modify value. This trades a small cost (one Roll per formula action on
     *  each edit) for a guarantee that "change my +1d6 to +2d6" actually
     *  re-rolls, and dropping a row doesn't leave orphan cache entries. */
    async _preUpdate(changed, options, user) {
        const allowed = await super._preUpdate(changed, options, user);
        if (allowed === false) return false;
        if (!willApplyToActor(this)) return;

        /* Duration formula roll on update. The sheet's _processFormData
         * stashes any dice string typed into duration.value (like "2d6") as
         * `flags.<sys>.durationFormula` and writes `duration.value = 0` as a
         * placeholder — matching what `_preCreate` / applyRolledValuesToData
         * do at create time. Without a roll here, the AE lands with
         * duration.value=0, which flips isTemporary to true (Number.isFinite(0))
         * and enrolls the effect in the ActiveEffectRegistry with remaining=0
         * — next updateWorldTime tick deletes it. Roll the formula now so
         * duration.value carries the concrete integer for its lifetime. */
        const changedFormula = foundry.utils.getProperty(changed, `flags.${SYSTEM_ID}.durationFormula`);
        if (typeof changedFormula === "string" && changedFormula.trim()) {
            const rolled = await rollFormulaAsync(changedFormula.trim());
            if (rolled != null) {
                foundry.utils.setProperty(changed, "duration.value", Math.max(1, rolled));
            }
        }

        /* Custom-status id sync on update. If the user edited customStatus
         * (toggled enabled or changed id), reconcile statuses[]. New enabled
         * id → add. Disabled or id change → drop the OLD id. Old id is
         * inferred from the current document; new from `changed`. */
        const csChanged = foundry.utils.getProperty(changed, `flags.${SYSTEM_ID}.customStatus`);
        if (csChanged !== undefined) {
            const prev = this.flags?.[SYSTEM_ID]?.customStatus ?? {};
            const prevId = String(prev.id ?? "").trim();
            const nextEnabled = (csChanged.enabled ?? prev.enabled) === true;
            const nextId = String((csChanged.id ?? prev.id) ?? "").trim();
            const curStatuses = Array.isArray(changed.statuses) ? [...changed.statuses] : [...(this.statuses ?? [])];
            let statusesDirty = false;
            // Drop the previous id when it no longer applies (disabled, or id changed).
            if (prevId && (!nextEnabled || nextId !== prevId)) {
                const i = curStatuses.indexOf(prevId);
                if (i >= 0) { curStatuses.splice(i, 1); statusesDirty = true; }
            }
            // Add the new id when enabled + set + not already present.
            if (nextEnabled && nextId && !curStatuses.includes(nextId)) {
                curStatuses.push(nextId);
                statusesDirty = true;
            }
            if (statusesDirty) changed.statuses = curStatuses;
        }

        const changedActions = foundry.utils.getProperty(changed, `flags.${SYSTEM_ID}.actions`);
        if (changedActions === undefined) return;

        const rolled = await computeRolledActionValues(changedActions);
        if (Object.keys(rolled).length) {
            foundry.utils.setProperty(changed, `flags.${SYSTEM_ID}.rolledValues`, rolled);
        } else if (foundry.utils.hasProperty(this, `flags.${SYSTEM_ID}.rolledValues`)) {
            // No formula actions left AND a stale cache exists → clear it so a
            // future edit doesn't read stale data. Uses v14's ForcedDeletion
            // operator; the legacy `-=key: null` syntax is deprecated.
            foundry.utils.setProperty(changed, `flags.${SYSTEM_ID}.rolledValues`, new foundry.data.operators.ForcedDeletion());
        }
    }

    /** Inject compiled modifier-action changes into system.changes. We
     *  rebuild from a fresh clone of the persisted source changes (never the
     *  live array) so the injected entries can't accumulate across repeated
     *  prepareData cycles, then stamp the same `effect` / `priority`
     *  normalization the core prepareBaseData applies to source changes. */
    prepareBaseData() {
        super.prepareBaseData();
        // FAST PATH — most AEs in the wild carry no `actions` flag AND no
        // custom-status clause. Bail before any allocation / JSON hashing /
        // cache lookup. prepareBaseData is called on every AE per data prep
        // cycle, and menu opens fan out prep across every owned document —
        // this early-out has to be zero-cost.
        const flags = this.flags?.[SYSTEM_ID];
        const actions = flags?.actions;
        const cs = flags?.customStatus;
        const csHasMods = !!(cs?.enabled && (cs.mods?.stats || cs.mods?.skills));
        if ((!Array.isArray(actions) || !actions.length) && !csHasMods) return;
        if (!this.system) return;

        // Prefer the persisted rolledValues cache written by _preCreate /
        // _onCreate. When absent (legacy AEs from before the hook existed, or
        // create paths that couldn't persist a fallback), fall through to an
        // in-memory session cache — a single per-session roll per formula
        // action so the change engine always sees a concrete number.
        const rolled = flags?.rolledValues ?? fallbackRolledValues(this);
        const actionChanges = Array.isArray(actions) && actions.length
            ? compileActionsToChanges(actions, rolled)
            : [];

        // Compile customStatus stat / skill mods into native AE changes.
        // Mirrors statusChanges() in statusEngine — the change shape this
        // system's effect data model uses is {key, value: String, type,
        // phase, priority}. Only fires when customStatus.enabled + a mods
        // subtree is present; the fast path above already skipped the rest.
        const csChanges = csHasMods ? _compileCustomStatusMods(cs) : [];

        if (!actionChanges.length && !csChanges.length) return;

        const base = foundry.utils.deepClone(this.system._source?.changes ?? []);
        const all  = [...base, ...actionChanges, ...csChanges];
        for (const c of all) {
            c.effect = this;
            c.priority ??= ActiveEffect.CHANGE_TYPES?.[c.type]?.priority ?? 0;
        }
        this.system.changes = all;
    }

    /* Manual pause — freeze remaining time when the user has clicked the
     * pause button on this AE (chrome/policy/tick-effects.pauseEffect stamps
     * `pausedRemainingSecs` onto the flag). Foundry's registry-refresh reads
     * the frozen positive `remaining` on every worldTime advance and never
     * expires the AE. UI displays the frozen number. No per-tick writes;
     * unpausing restores start.time so live `remaining` picks up from the
     * snapshot at that moment. */
    _prepareDuration(duration, context) {
        const prepared = super._prepareDuration(duration, context);
        const snap = this.getFlag?.(SYSTEM_ID, "pausedRemainingSecs");
        if (snap == null) return prepared;
        const secs = Number(snap);
        if (!Number.isFinite(secs) || secs < 0) return prepared;
        const secondsPer = prepared?.units && DURATION_UNIT_SECONDS[prepared.units] || 1;
        prepared.seconds = secs;
        prepared.secondsRemaining = secs;
        prepared.remaining = secondsPer > 0 ? secs / secondsPer : secs;
        prepared.expired = false;
        return prepared;
    }

    /** Critical-wound effects are authored per state (flag `woundState`) and
     *  only apply while the wound is in that state — so the bearer's penalty
     *  swaps automatically as the wound is stabilized / treated. The flag is a
     *  live getter read, so a state change re-evaluates without any sync step;
     *  Foundry re-runs the bearer's effect application on the item update.
     *
     *  Homebrew gate — an AE tagged `flags.<sys>.wrGate = "<homebrewKey>"`
     *  is suppressed whenever that homebrew setting is off. Used by the
     *  Witchers Reborn race AEs so flipping the toggle really turns the
     *  perks off, rather than leaving derived stats permanently boosted
     *  on any character wearing the race item. */
    get isSuppressed() {
        if (super.isSuppressed) return true;
        const item = this.parent;
        if (item?.type === "criticalWound") {
            const tag = this.getFlag(SYSTEM_ID, "woundState") || "unstabilized";
            if (tag !== (item.system?.state || "unstabilized")) return true;
        }
        /* Armor items: an AE on an armor doc only applies to the wearer
         * while the piece is actually WORN. Foundry's default `transfer:
         * true` puts the AE on the actor as soon as the item is embedded;
         * without this gate, the buff would apply from inventory. Covers
         * the whole armor category — clothes especially rely on it (the
         * clothes subtype UI advertises "applied while equipped"), but
         * the same rule reads sensibly for light/medium/heavy too.
         *
         * Follow the origin pointer as well: on v10-13-style transfer,
         * the AE ends up cloned onto the ACTOR (parent = actor) with
         * `origin` set to the item uuid. The v14 pattern keeps the AE
         * on the item (parent = item), so the primary check catches most
         * paths — origin is the belt-and-braces branch.
         *
         * IMPORTANT: resolve the origin item from the LOCAL parent actor's
         * embedded collection, never via `fromUuidSync`. `isSuppressed` runs
         * inside `applyActiveEffects` during data prep; on an unlinked-token
         * (synthetic) actor a global UUID lookup re-enters
         * `ActorDelta._createSyntheticActor`, which re-runs prepare on that
         * same actor, which re-evaluates this getter — unbounded recursion
         * that surfaces as "Maximum call stack size exceeded". When the AE is
         * transferred, `this.parent` is already the bearer actor and `origin`
         * ends in `Item.<id>`, so a direct `items.get` returns the same doc
         * with zero synthetic-actor construction. */
        const originItem =
            (item?.documentName === "Actor" && this.origin)
                ? item.items?.get(this.origin.split(".").pop())
                : null;
        const armorSource =
            (item?.documentName === "Item" && item?.type === "armor") ? item
          : (originItem?.type === "armor") ? originItem
          : null;
        if (armorSource && armorSource.system?.equipped === false) {
            return true;
        }
        const wrGate = this.getFlag(SYSTEM_ID, "wrGate");
        if (wrGate) {
            try {
                const on = game.settings?.get?.(SYSTEM_ID, `homebrew.${wrGate}`);
                if (!on) return true;
            } catch (_) {
                /* Settings not registered yet — err on the side of applying
                 * so a mid-init read doesn't strip perks the user expects. */
            }
        }
        return false;
    }
}
