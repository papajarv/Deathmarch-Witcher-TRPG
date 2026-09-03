/**
 * Dead-token z-ordering — a defeated token sinks beneath living tokens in the
 * token stack so corpses never hide the living. Toggling dead sinks it;
 * un-toggling restores its normal order.
 *
 * COST MODEL — deadness is computed ONLY when it can change (status effect
 * toggled, combatant defeated toggled, token first drawn), NEVER per refresh.
 *
 * HOW FOUNDRY SORTS TOKEN ART (verified against v14 client source):
 * The visible art is `token.mesh`, a PrimaryCanvasObject in PrimaryCanvasGroup.
 * `PrimaryCanvasGroup._compareObjects` orders siblings by
 *     elevation → sortLayer → sort → zIndex → _lastSortedIndex
 * All tokens share `sortLayer = TOKENS (700)`, so within an elevation the paint
 * order is driven by `mesh.sort`. `Token#_refreshState` — and ONLY that method —
 * rewrites `this.mesh.sort = this.document.sort`.
 *
 * THE MECHANISM: we cache a per-token sentinel (`token._wdmDeadSort`) whenever
 * deadness toggles, and wrap `_refreshState` so that — right after Foundry
 * writes `mesh.sort` — it re-applies the sentinel IF one is cached. The wrap
 * does zero deadness work: it reads one field and, for corpses only, writes one
 * number. Because `_refreshState` is the sole writer of `mesh.sort`, wrapping it
 * is the exact (and only) point a reassert is needed — no `refreshToken`
 * polling, no `statuses.has` / combat scans on the hot path.
 *
 * We never touch `elevation` (that drives roof occlusion / vision layering).
 */

/* Far below any real token sort (Foundry hands out non-negative, incrementing
 * document.sort). Offset by the token's own sort so corpses keep a stable
 * relative order among themselves instead of collapsing to a tie. */
const DEAD_SORT_BASE = -1_000_000;

/* One-time deadness test (event context only, never per-refresh): the "dead"
 * status effect, or a defeated combatant entry. */
function isDead(token) {
    const actor = token?.actor;
    if (!actor) return false;
    if (actor.statuses?.has?.("dead")) return true;
    const combatant = token?.combatant
        ?? game.combat?.combatants?.find?.(c => c.tokenId === token?.id);
    return !!combatant?.isDefeated;
}

/* Set/clear the cached sentinel from a KNOWN dead state and apply immediately.
 * Called only from toggle events + initial draw. */
function setDeadState(token, dead) {
    if (!token || token.destroyed) return;
    if (dead) {
        const want = DEAD_SORT_BASE + (Number(token.document?.sort) || 0);
        token._wdmDeadSort = want;
        if (token.mesh && token.mesh.sort !== want) token.mesh.sort = want;   // setter flags sortDirty
    } else {
        if (token._wdmDeadSort == null) return;   // already living, nothing cached
        delete token._wdmDeadSort;
        const base = Number(token.document?.sort) || 0;
        if (token.mesh && token.mesh.sort !== base) token.mesh.sort = base;   // restore normal order
    }
}

/* Recompute for every placed token of an actor (event context). */
function recomputeActorTokens(actor) {
    if (!actor) return;
    for (const t of (actor.getActiveTokens?.() ?? [])) setDeadState(t, isDead(t));
}

/* Wrap Token#_refreshState ONCE so a cached sentinel survives Foundry's
 * per-state rewrite of mesh.sort. Runs only when _refreshState runs (i.e. only
 * when sort was actually rewritten); pure cache read for living tokens. */
function patchRefreshState() {
    const TokenCls = foundry?.canvas?.placeables?.Token;
    if (!TokenCls || TokenCls.prototype.__wdmDeadSortPatched) return;
    TokenCls.prototype.__wdmDeadSortPatched = true;
    const orig = TokenCls.prototype._refreshState;
    TokenCls.prototype._refreshState = function _refreshStateDeadSort(...args) {
        const r = orig?.apply(this, args);
        const want = this._wdmDeadSort;   // undefined for living tokens
        if (want != null && this.mesh && this.mesh.sort !== want) this.mesh.sort = want;
        return r;
    };
}

export function registerDeadTokenZOrder() {
    patchRefreshState();

    // One-time per draw (scene load / token creation): seed the cache so a
    // token that's already dead when it appears starts sunk. NOT per-refresh.
    Hooks.on("drawToken", (token) => setDeadState(token, isDead(token)));

    // Deadness can only change on these signals — recompute exactly here.
    Hooks.on("createActiveEffect", (effect) => {
        if (effect?.statuses?.has?.("dead")) recomputeActorTokens(effect.parent);
    });
    Hooks.on("deleteActiveEffect", (effect) => {
        if (effect?.statuses?.has?.("dead")) recomputeActorTokens(effect.parent);
    });
    Hooks.on("updateCombatant", (combatant, changes) => {
        if (!("defeated" in (changes ?? {}))) return;
        const token = combatant?.token?.object
            ?? combatant?.combat?.scene?.tokens?.get?.(combatant.tokenId)?.object;
        if (token) setDeadState(token, isDead(token));
    });
    // Ending combat clears `isDefeated`; restore any token that was sunk purely
    // by a combatant defeat (dead-status corpses recompute to still-dead).
    Hooks.on("deleteCombat", (combat) => {
        for (const c of (combat?.combatants ?? [])) {
            const token = c?.token?.object ?? combat?.scene?.tokens?.get?.(c.tokenId)?.object;
            if (token?._wdmDeadSort != null) setDeadState(token, isDead(token));
        }
    });
}
