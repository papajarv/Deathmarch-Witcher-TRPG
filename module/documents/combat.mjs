/**
 * WitcherCombat — keeps the turn on the CURRENT combatant when the roster
 * changes mid-combat.
 *
 * The problem: Foundry's `Combat#setupTurns()` re-sorts the combatants (by
 * initiative) whenever the roster changes, but it only CLAMPS `this.turn` to
 * the array bounds — it does not track WHO the current turn-holder is. So when
 * a combatant is added (or has its initiative rolled) with a value HIGHER than
 * the active turn-holder, that new combatant sorts in AHEAD of them, every later
 * entry shifts down one index, and the unchanged `this.turn` number now points
 * at a DIFFERENT combatant. The visible turn "jumps" to someone who already
 * acted — the current person's turn gets stolen.
 *
 * The fix: capture the current turn-holder's id before the re-sort, let Foundry
 * sort + clamp as usual, then re-point `this.turn` at that same combatant's new
 * index. `setupTurns()` runs INSIDE Foundry's combatant-modify flow BEFORE the
 * turn-change bookkeeping (`#recordPreviousState` / `_manageTurnEvents`), so
 * correcting the index here means no spurious `combatTurnChange` fires and no
 * downstream round/budget bookkeeping runs against the wrong actor. Normal turn
 * advancement (nextTurn / nextRound) does NOT route through `setupTurns` — that
 * path updates `turn` directly — so this override never interferes with the GM
 * clicking "next turn".
 */

export class WitcherCombat extends Combat {
    /** @override */
    setupTurns() {
        /* Read the current turn-holder BEFORE the re-sort — but WITHOUT going
         * through the `this.combatant` getter, which throws during initial data
         * preparation (it indexes `this.turns[this.turn]` and `this.turns` isn't
         * populated yet the first time setupTurns runs). Read the array directly
         * and guard every step so a not-yet-initialised combat just falls back
         * to Foundry's default behaviour. */
        let priorId = null;
        try {
            if (this.started && this.turn !== null && Array.isArray(this.turns)) {
                priorId = this.turns[this.turn]?.id ?? null;
            }
        } catch (_) { priorId = null; }

        const turns = super.setupTurns();

        /* Re-anchor the turn to the same combatant if the sort moved them.
         * Skip when combat hasn't started, the holder is gone (deleted /
         * defeated-and-removed → keep Foundry's clamped fallback), or the
         * index is already correct. */
        if (priorId) {
            const idx = turns.findIndex(c => c.id === priorId);
            if (idx >= 0 && idx !== this.turn) {
                this.turn = idx;
                this.current = this._getCurrentState(turns[idx]);
            }
        }
        return turns;
    }
}
