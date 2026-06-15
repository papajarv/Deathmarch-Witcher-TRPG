/**
 * statusOverrides — the runtime merge layer over `setup/statusClauses.mjs`.
 *
 * The frozen `STATUS_CLAUSES` are the RAW defaults. A GM can edit, add, or
 * remove statuses through the Status Effects editor (settings menu); their
 * changes live in the world setting `statusEffectsOverride` and are merged on
 * top of the defaults here. Everything that asks "what does this status do?"
 * goes through `getActiveClauses()` (via `statusEngine.clauseFor`), so an edit
 * is a data change with no code hunt.
 *
 * Override entry shape (per status id) — a full status record, presentation +
 * mechanics:
 *   { name, img,                       presentation (label + icon)
 *     description, mods, dot, restrict, … the clause vocabulary
 *     removed: true }                  drop a default status entirely
 *
 * The stored clause is COMPLETE (the editor writes the whole effective record,
 * not a diff), so a touched status overrides its default outright — "what you
 * see in the editor is what's stored". An absent entry falls through to the
 * code default, so unedited statuses always track the RAW defaults.
 *
 * Apply timing: the setting is registered `requiresReload: true`, so a save
 * rebuilds CONFIG.statusEffects + the clause cache from a clean init. The cache
 * here is invalidated on change as a belt-and-braces measure.
 */

import { STATUS_CLAUSES } from "../setup/statusClauses.mjs";

export const SYSTEM_ID = "witcher-ttrpg-death-march";
export const STATUS_OVERRIDE_SETTING = "statusEffectsOverride";

/* Presentation-only keys — everything else in an override entry is clause
 * mechanics fed to the engine. */
const PRESENTATION_KEYS = new Set(["name", "img", "removed"]);

let _clauseCache = null;

/** Drop the memoized merge; called from the setting's onChange. */
export function invalidateStatusClauseCache() {
    _clauseCache = null;
}

/** The raw override map from world settings, or {} before it is registered. */
export function readStatusOverride() {
    try {
        return game.settings.get(SYSTEM_ID, STATUS_OVERRIDE_SETTING) || {};
    } catch (_) {
        return {};
    }
}

/* Split a stored override entry into its mechanics (clause) half. */
function clausePart(entry) {
    const clause = {};
    for (const [k, v] of Object.entries(entry)) {
        if (!PRESENTATION_KEYS.has(k)) clause[k] = v;
    }
    return clause;
}

/**
 * The effective clause registry: RAW defaults with the GM's overrides layered
 * on. A `removed` entry drops the default; any other entry replaces it whole;
 * brand-new ids are appended. Memoized until the setting changes.
 */
export function getActiveClauses() {
    if (_clauseCache) return _clauseCache;
    const override = readStatusOverride();
    const out = { ...STATUS_CLAUSES };
    for (const [id, entry] of Object.entries(override)) {
        if (!entry || entry.removed) { delete out[id]; continue; }
        out[id] = clausePart(entry);
    }
    _clauseCache = out;
    return out;
}
