/**
 * GM-only hold-registry actor.
 *
 * Foundry's `actor.getFlag` doesn't gate reads on document ownership
 * — once an actor doc is in the player client's `game.actors`, every
 * flag on it is readable. Storing the hold-link partner UUID directly
 * on the held actor's flag is therefore an info-disclosure leak: a
 * player can read `npc.getFlag(SYS, "holdLink")` and see who's
 * holding the GM-only NPC, even with NONE ownership on the NPC.
 *
 * The pattern this module implements:
 *
 *   ONE hidden registry actor exists per world. Its ownership map is
 *   { default: NONE }, which means client bundles for non-GM users
 *   exclude it entirely from `game.actors`. The registry actor stores
 *   the hold relationships as an ARRAY of pairs:
 *
 *     flags.<sys>.holds = [
 *       { holderUuid: <A>, targetUuid: <B>, kind },
 *       { holderUuid: <C>, targetUuid: <B>, kind },  // multi-clinch B
 *       { holderUuid: <D>, targetUuid: <E>, kind },
 *     ]
 *
 * Multi-clinch model: one target can be clinched by many holders (A,
 * C both clinch B). Bidirectional model: both parties in a pair carry
 * the `clinched` status (see holdLink.mjs). Escape is pure movement —
 * step off the clincher and the movement hook fires clearHold.
 *
 * Pair-based storage (no per-actor uuid key) is required for the
 * multi-clinch case: uuid-keyed storage forces one-relationship-per-
 * actor, which silently clobbers earlier holds when a new one lands.
 *
 * No pre-recorded positions: the current-position distance check
 * (in holdLink.mjs) reads token centers directly, so we don't need
 * to remember where the holder stood when the clinch started.
 *
 * Foundry setFlag safety: array storage (not object) sidesteps
 * setFlag's `.` path-expansion, which corrupted uuid-keyed storage
 * (actor UUIDs contain `.` characters).
 *
 * Caching: the registry actor reference is cached so we don't pay an
 * `game.actors.find` cost on every read.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const REGISTRY_NAME = "__witcher_hold_registry__";
const HOLDS_FLAG = "holds";

let _cachedRegistry = null;
/* In-flight create promise — two near-simultaneous holds (e.g. a GM
 * macro applying clinch to four targets at once) would both miss the
 * cache and race to Actor.create, duplicating the registry. Sharing
 * the same promise for concurrent calls serializes the create. */
let _creatingPromise = null;

/** Find or lazily create the registry actor. GM-only — players never
 *  call this. Returns null if Foundry isn't ready yet.
 *
 *  Dedup safety:
 *    - Cached after first call.
 *    - If two callers race, the second await-s the first's create.
 *    - If multiple registry actors already exist (legacy data, accidental
 *      duplicate creates), keeps the oldest + logs a warn the GM can
 *      see in the console. The maintainer can hand-delete the dupes. */
export async function getOrCreateRegistry() {
    if (!game?.actors) return null;
    if (_cachedRegistry && !_cachedRegistry.invalid) return _cachedRegistry;
    /* Search by marker flag (more robust than the name match alone —
     * a GM-renamed registry would still be found). */
    const candidates = game.actors.filter(a =>
        a?.getFlag?.(SYSTEM_ID, "isHoldRegistry") === true);
    if (candidates.length) {
        if (candidates.length > 1) {
            console.warn(`${SYSTEM_ID} | multiple hold-registry actors found (${candidates.length}); using the oldest. Delete dupes via 'game.actors.filter(a => a.getFlag(...))' macro.`);
        }
        /* Sort by creation timestamp (Foundry's `_stats.createdTime`) so
         * the deterministic "oldest wins" rule survives reloads. */
        candidates.sort((a, b) => (a._stats?.createdTime ?? 0) - (b._stats?.createdTime ?? 0));
        _cachedRegistry = candidates[0];
        /* Legacy fixup: old worlds shipped the registry with default
         * NONE ownership, which excluded it from every player's world
         * bundle. `getHolds()` on their client then returned [], and the
         * needsGrapple gate on Pin / Choke / Throw / Trip refused because
         * `attackerHoldsTarget` couldn't see the pair the GM had just
         * written. Bump to OBSERVER (read-only) so the pair data reaches
         * the player. Writes still route through the socket to the GM. */
        try {
            const OBS  = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
            const curr = Number(_cachedRegistry.ownership?.default) || 0;
            if (game.user?.isActiveGM && curr < OBS) {
                await _cachedRegistry.update({ "ownership.default": OBS });
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | holdRegistry: default-ownership fixup failed`, err);
        }
        return _cachedRegistry;
    }
    if (!game.user?.isActiveGM) return null;  // only GM creates it
    /* Serialize concurrent creates so we don't ship two registries
     * because two clinches landed in the same tick. */
    if (_creatingPromise) return _creatingPromise;
    _creatingPromise = (async () => {
        try {
            const actor = await Actor.create({
                name: REGISTRY_NAME,
                type: "loot",
                /* OBSERVER default so the registry actor is present in
                 * every player's world bundle. Players read pair data
                 * via `.getFlag()` locally (needed by the needsGrapple
                 * gate for follow-up Pin / Choke / Throw); writes still
                 * route through the socket to the GM. NONE (the old
                 * default) hid the actor entirely from players, which
                 * broke `attackerHoldsTarget` after a successful grapple
                 * — the player's client couldn't see the pair the GM
                 * had just written. */
                ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2 },
                /* Marker flag so a future migration / sweep can find
                 * the registry without name-matching. */
                flags: { [SYSTEM_ID]: { [HOLDS_FLAG]: [], isHoldRegistry: true } }
            }, { keepId: false, renderSheet: false });
            _cachedRegistry = actor;
            return actor;
        } catch (err) {
            console.warn(`${SYSTEM_ID} | holdRegistry: create failed`, err);
            return null;
        } finally {
            _creatingPromise = null;
        }
    })();
    return _creatingPromise;
}

/** Sweep the registry for pairs touching a deleted actor. Called from
 *  a deleteActor hook so a GM clearing the field doesn't leave stale
 *  pairs. Safe to call on registry-less worlds — short-circuits when
 *  nothing exists. Removes EVERY pair the deleted actor was part of,
 *  whether as holder or target. */
export async function sweepDeletedActor(actorUuid) {
    const reg = await getOrCreateRegistry();
    if (!reg) return;
    const cur = _readEntries(reg);
    const next = cur.filter(p => p.holderUuid !== actorUuid && p.targetUuid !== actorUuid);
    if (next.length !== cur.length) {
        await reg.setFlag(SYSTEM_ID, HOLDS_FLAG, next);
    }
}

/* Storage shape: an ARRAY of pairs `{ holderUuid, targetUuid, kind }`.
 * Foundry's `setFlag` treats `.` in object keys as a path separator
 * (so an actor UUID like `Actor.abc123` would be deep-expanded into
 * `flags.holds.Actor.abc123`), which silently corrupted the read on
 * the way back out. An array sidesteps the path-expansion. Lookup is
 * O(n) but n is the number of in-flight holds in the world — never
 * large enough to matter. */

/** Read the current pairs array. Returns [] if no holds. */
function _readEntries(reg) {
    const raw = reg.getFlag(SYSTEM_ID, HOLDS_FLAG);
    return Array.isArray(raw) ? raw : [];
}

/** Write a hold relationship to the registry as ONE pair. Multi-clinch
 *  is supported: repeat calls with the same target but different
 *  holders each add a new pair (no overwrite). The exact-duplicate
 *  case (same holder+target+kind already present) is a no-op so the
 *  apply is idempotent.
 *
 *  Returns true if a new pair was appended, false if it already
 *  existed. */
export async function setHold(holderUuid, targetUuid, kind) {
    const reg = await getOrCreateRegistry();
    if (!reg) return false;
    const cur = _readEntries(reg);
    /* Same exact pair already present — idempotent apply. */
    if (cur.some(p =>
        p.holderUuid === holderUuid &&
        p.targetUuid === targetUuid &&
        p.kind === kind)) {
        return false;
    }
    cur.push({ holderUuid, targetUuid, kind });
    await reg.setFlag(SYSTEM_ID, HOLDS_FLAG, cur);
    return true;
}

/** Return every pair an actor is currently in — as either holder OR
 *  target. Each pair is returned in its canonical shape
 *  `{ holderUuid, targetUuid, kind }`.
 *
 *  Callers wanting the per-actor view ("who's on the other side of
 *  this pair, from actor's perspective?") can compute:
 *     const partnerUuid = p.holderUuid === actorUuid
 *         ? p.targetUuid : p.holderUuid;
 */
export async function getHolds(actorUuid) {
    const reg = await getOrCreateRegistry();
    if (!reg) return [];
    return _readEntries(reg).filter(p =>
        p.holderUuid === actorUuid || p.targetUuid === actorUuid);
}

/** Back-compat single-pair reader. Returns the FIRST pair the actor
 *  is in, in the legacy `{ uuid, partnerUuid, kind }` shape (role
 *  derived from which side of the pair the actor is on).
 *
 *  Returns null if the actor isn't in any pair. Prefer `getHolds` in
 *  new code — this exists so callers written for the pre-multi-clinch
 *  model don't break on migration. */
export async function getHold(actorUuid) {
    const pairs = await getHolds(actorUuid);
    if (pairs.length === 0) return null;
    const p = pairs[0];
    return _asLegacyShape(p, actorUuid);
}

/** Synchronous variant of getHolds — useful in hooks where we don't
 *  want to await. Returns [] if the registry isn't cached yet. */
export function getHoldsSync(actorUuid) {
    if (!_cachedRegistry) return [];
    return _readEntries(_cachedRegistry).filter(p =>
        p.holderUuid === actorUuid || p.targetUuid === actorUuid);
}

/** Back-compat single-pair sync reader. Returns null if no pairs. */
export function getHoldSync(actorUuid) {
    const pairs = getHoldsSync(actorUuid);
    if (pairs.length === 0) return null;
    return _asLegacyShape(pairs[0], actorUuid);
}

/** Convert a pair to the legacy `{ uuid, partnerUuid, kind, role }`
 *  shape from the caller's perspective. */
function _asLegacyShape(p, actorUuid) {
    if (p.holderUuid === actorUuid) {
        return { uuid: p.holderUuid, partnerUuid: p.targetUuid, kind: p.kind, role: "holder" };
    }
    return { uuid: p.targetUuid, partnerUuid: p.holderUuid, kind: p.kind, role: "target" };
}

/** Clear a hold pair. Two modes:
 *
 *    clearHold(actorUuid)               — removes ALL pairs the actor
 *                                          is in (cascade cleanup;
 *                                          used by deletion sweeps).
 *    clearHold(actorUuid, partnerUuid)  — removes ONLY the specific
 *                                          pair between these two
 *                                          uuids (used by movement
 *                                          break: A moves away from
 *                                          B, only the A↔B pair
 *                                          breaks — other pairs B is
 *                                          in stay intact).
 *
 *  Returns the array of removed pairs, or [] if nothing was cleared.
 *  The caller uses the returned pairs to decide which actors need
 *  their status stripped (an actor keeps `clinched` if any pair of
 *  that kind remains — see clearHoldLink in holdLink.mjs). */
export async function clearHold(actorUuid, partnerUuid = null) {
    const reg = await getOrCreateRegistry();
    if (!reg) return [];
    const cur = _readEntries(reg);
    const removed = [];
    const next = cur.filter(p => {
        const touchesActor = p.holderUuid === actorUuid || p.targetUuid === actorUuid;
        if (!touchesActor) return true;
        if (partnerUuid === null) {
            /* Cascade mode — remove any pair the actor is in. */
            removed.push(p);
            return false;
        }
        /* Targeted mode — remove only the pair with this specific
         * partner (regardless of which side each is on). */
        const touchesPartner = p.holderUuid === partnerUuid || p.targetUuid === partnerUuid;
        if (touchesPartner) {
            removed.push(p);
            return false;
        }
        return true;
    });
    if (removed.length > 0) {
        await reg.setFlag(SYSTEM_ID, HOLDS_FLAG, next);
    }
    return removed;
}

/** Reverse dominance on a specific pair. Swaps holderUuid ↔ targetUuid
 *  on the FIRST pair matching (holderUuid=holderUuid, targetUuid=
 *  targetUuid, kind=kind). Idempotent for the "already swapped" case:
 *  if no pair with the original orientation is found, does nothing and
 *  returns null. On success, returns the pre-swap pair.
 *
 *  Used by CE Reverse Grapple (mechanics/holdLink.reverseHold), which
 *  atomically swaps holder/target after the reverser wins an opposed
 *  Brawling roll. */
export async function reversePair(holderUuid, targetUuid, kind) {
    const reg = await getOrCreateRegistry();
    if (!reg) return null;
    const cur = _readEntries(reg);
    const idx = cur.findIndex(p =>
        p.holderUuid === holderUuid &&
        p.targetUuid === targetUuid &&
        p.kind === kind);
    if (idx < 0) return null;
    const old = cur[idx];
    cur[idx] = { holderUuid: targetUuid, targetUuid: holderUuid, kind };
    await reg.setFlag(SYSTEM_ID, HOLDS_FLAG, cur);
    return old;
}

/** Test-seam: discard the cache so a re-init / fresh actor lookup
 *  refreshes. Used by integration tests + the world-rebuild path. */
export function _resetCache() {
    _cachedRegistry = null;
}
