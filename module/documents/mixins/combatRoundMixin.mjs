/**
 * combatRoundMixin — RAW action-economy accountability (Core p.151-152, 154).
 *
 * Composed onto WitcherActor in documents/actor.mjs. Tracks the per-round
 * budget written on `system.combatRound`:
 *   - movement (up to SPD meters)
 *   - one action
 *   - one optional extra action (3 STA, at -3)
 *   - a full-round action (locks all three slots — user spec)
 *   - defensive actions (1st free, each extra 1 STA unless Actively Dodging)
 *
 * STA spending lives here too (spendStamina clamps the pool at 0). At 0 STA the
 * actor is STUNNED (user ruling): every budget method is refused except the
 * Recovery full-round action, until STA climbs back to ≥1. See `_stunned`.
 */

import { isHomebrewEnabled } from "../../api/homebrew.mjs";
import { AIM_BONUS_CAP, AIM_BONUS_PER_TURN } from "../../setup/config.mjs";
import { cannotAct, cannotRecover, cannotDefend } from "../../mechanics/statusEngine.mjs";

const notify = (msg, type = "warn") => ui?.notifications?.[type]?.(msg);

const STUN_MSG = "Stunned at 0 STA — you can only take a Recovery action.";
const LOCKED_MSG = "You can take no actions while incapacitated.";

/** Highest Aim rank the status set supports (+1/turn up to the cap). */
const AIM_MAX_RANK = Math.max(1, Math.ceil(AIM_BONUS_CAP / AIM_BONUS_PER_TURN));

export const combatRoundMixin = (Base) => class extends Base {

    get _round() {
        return this.system?.combatRound ?? {};
    }

    /** True only when this actor is in a started Foundry combat. The action
     *  economy applies solely in combat — out of combat the budget methods
     *  are free no-ops (you can still take the actions, they just don't
     *  consume slots or STA). */
    get _inActiveCombat() {
        const c = game?.combat;
        if (!c?.started) return false;
        // Match by token first so a synthetic/unlinked token actor (and the case
        // of several tokens sharing one base actor) resolves to its combatant.
        const tokenId = this.token?.id ?? null;
        return c.combatants?.some(cb =>
            (tokenId && cb.tokenId === tokenId) || (cb.actorId ?? cb.actor?.id) === this.id
        ) ?? false;
    }

    /** Current / max STA, defaulting to 0. */
    get _sta() {
        const sta = this.system?.derivedStats?.sta ?? {};
        return { value: Number(sta.value) || 0, max: Number(sta.max) || 0 };
    }

    /** Stunned: at 0 STA. Per user ruling, every action is locked out except the
     *  Recovery full-round action until STA returns to ≥1 — this applies whether
     *  or not a Foundry combat is "started". Guarded on max > 0 so actors with no
     *  STA pool configured (or not yet prepared) aren't falsely stunned. */
    get _stunned() {
        const { value, max } = this._sta;
        return max > 0 && value === 0;
    }

    /** Cannot take a normal action this turn — STA-stun OR a status that
     *  forbids actions (Stunned / Paralyzed / Unconscious). Recovery may still
     *  be allowed; see `_recoveryLocked`. */
    get _actionLocked() {
        return this._stunned || cannotAct(this);
    }

    /** The notify message for the current action lock. STA-stun keeps its own
     *  Recovery hint; a status lock is generic. */
    get _actionLockMsg() {
        return this._stunned ? STUN_MSG : LOCKED_MSG;
    }

    /** Even Recovery is off the table — full incapacitation (Paralyzed /
     *  Unconscious). Plain Stunned / STA-stun do NOT set this. */
    get _recoveryLocked() {
        return cannotRecover(this);
    }

    /**
     * Spend STA. Clamps at 0. Returns the new STA value. `n` may be 0 (no-op).
     * The stunned-at-0 consequence is applied by the STA-depletion hook.
     */
    async spendStamina(n, { reason } = {}) {
        n = Math.max(0, Number(n) || 0);
        if (!n) return this._sta.value;
        const { value } = this._sta;
        const next = Math.max(0, value - n);
        await this.update({ "system.derivedStats.sta.value": next });
        return next;
    }

    /** Recover STA up to max. Does not auto-clear stunned — RAW requires a
     *  Stun save once STA ≥ 20 (rollStunSave), so rousing stays an explicit act. */
    async recoverStamina(n) {
        n = Math.max(0, Number(n) || 0);
        if (!n) return this._sta.value;
        const { value, max } = this._sta;
        const next = max > 0 ? Math.min(max, value + n) : value + n;
        if (next !== value) await this.update({ "system.derivedStats.sta.value": next });
        return next;
    }

    /** True if a full-round action has locked the turn (no further slots). */
    get _locked() {
        return !!this._round.fullRound;
    }

    /**
     * Declare movement of `meters`. Behavior depends on the "Split Movement"
     * house rule (homebrew key `splitMovement`):
     *
     *   OFF (RAW): all movement is taken at the start of the turn, before any
     *     action. A single declaration locks the Move slot; once you've acted
     *     (action or extra action) you forfeit any remaining movement.
     *
     *   ON: movement may be split across the turn and interleaved with actions,
     *     accumulating up to total SPD. The slot locks only once cumulative
     *     meters reach SPD.
     */
    async recordMovement(meters) {
        if (this._actionLocked) return notify(this._actionLockMsg);
        if (!this._inActiveCombat) return;             // out of combat: free, untracked
        if (this._locked) return notify("Turn is committed to a full-round action.");
        const m   = Math.max(0, Math.round(Number(meters) || 0));
        const spd = Number(this.system?.stats?.spd?.value) || 0;
        const split = isHomebrewEnabled("splitMovement");

        if (!split) {
            // RAW: movement must precede any action; acting forfeits it.
            if (this._round.actionUsed || this._round.extraUsed) {
                return notify("You've already acted this turn — movement is forfeit (enable Split Movement to interleave).");
            }
            if (this._round.movementUsed) return notify("Already moved this turn.");
            if (spd && m > spd) notify(`Moved ${m}m — over your SPD of ${spd}m (Run is a full-round action for SPD×3).`);
            await this.update({
                "system.combatRound.movementUsed": true,
                "system.combatRound.movementMeters": m
            });
            return;
        }

        // Split Movement: accumulate up to total SPD, in any order.
        if (this._round.movementUsed) return notify("You've used all your movement this turn.");
        const prior     = Number(this._round.movementMeters) || 0;
        const remaining = spd ? Math.max(0, spd - prior) : Infinity;
        if (spd && m > remaining) {
            notify(`Only ${remaining}m of movement left this turn (SPD ${spd}).`);
        }
        const applied = spd ? Math.min(prior + m, spd) : prior + m;
        await this.update({
            "system.combatRound.movementMeters": applied,
            "system.combatRound.movementUsed": spd ? applied >= spd : false
        });
    }

    /** Spend the single action with a display `label`. Returns false if gone. */
    async recordAction(label = "Action") {
        if (this._actionLocked) { notify(this._actionLockMsg); return false; }
        if (!this._inActiveCombat) return true;        // out of combat: free, untracked
        if (this._locked) { notify("Turn is committed to a full-round action."); return false; }
        if (this._round.actionUsed) { notify("Action already spent — use the Extra Action (3 STA)."); return false; }
        await this.update({
            "system.combatRound.actionUsed": true,
            "system.combatRound.actionLabel": String(label)
        });
        return true;
    }

    /** Spend the extra action (3 STA, at -3). Returns false if gone. */
    async recordExtraAction(label = "Extra Action") {
        if (this._actionLocked) { notify(this._actionLockMsg); return false; }
        if (!this._inActiveCombat) return true;        // out of combat: free, no STA cost
        if (this._locked) { notify("Turn is committed to a full-round action."); return false; }
        if (!this._round.actionUsed) { notify("Use your action first — the extra action is a second action."); return false; }
        if (this._round.extraUsed) { notify("Extra action already spent this turn."); return false; }
        await this.update({
            "system.combatRound.extraUsed": true,
            "system.combatRound.extraLabel": String(label)
        });
        // 3 STA, less any combatMods.extraActionStaReduction (3 = free extra).
        const staCost = Math.max(0, 3 - (Number(this.system?.combatMods?.extraActionStaReduction) || 0));
        await this.spendStamina(staCost, { reason: "extra action" });
        return true;
    }

    /**
     * Auto-spend an action slot for an attack / cast / draw etc. Fills the
     * Action first, then the Extra Action (3 STA). Returns the slot used
     * ("action" | "extra") or null if none left.
     */
    /** Which slot the NEXT action will consume, without spending it:
     *    "action" — a normal action is free (preferred);
     *    "extra"  — no normal action left, but the extra action is open
     *               (costs 3 STA, -3 to the roll);
     *    null     — nothing left this turn (locked or both spent).
     *  Out of combat actions are unlimited, so this returns "action". */
    get nextActionSlot() {
        if (this._actionLocked) return null;
        if (!this._inActiveCombat) return "action";
        if (this._locked) return null;
        if (!this._round.actionUsed) return "action";
        if (!this._round.extraUsed)  return "extra";
        return null;
    }

    /** True if a normal/extra action slot is still free this turn. Callers gate
     *  on this BEFORE rolling so a slotless attack neither rolls nor spends
     *  ammo. */
    get hasActionSlot() {
        return this.nextActionSlot !== null;
    }

    async spendActionSlot(label = "Action") {
        if (this._actionLocked) { notify(this._actionLockMsg); return null; }
        if (!this._inActiveCombat) return null;        // out of combat: free, untracked
        if (this._locked) { notify("Turn is committed to a full-round action."); return null; }
        if (!this._round.actionUsed) { await this.recordAction(label); return "action"; }
        if (!this._round.extraUsed)  { await this.recordExtraAction(label); return "extra"; }
        notify("No actions left this turn.");
        return null;
    }

    /** True if a full-round action can still be taken this turn. Out of combat
     *  it's always available; in combat it needs the whole turn untouched (no
     *  movement / action / extra spent and no full round already committed).
     *  Callers (e.g. the Charge strike) gate selection on this BEFORE rolling. */
    get canTakeFullRound() {
        if (!this._inActiveCombat) return true;
        return !this._locked && !this._turnDirty;
    }

    /** True once any slot is spent — gates full-round actions, which need
     *  the whole turn and so can't follow movement/action/extra. */
    get _turnDirty() {
        const r = this._round;
        // Count partial split-movement too (movementUsed only flips at full SPD).
        return !!(r.movementUsed || (Number(r.movementMeters) || 0) > 0 || r.actionUsed || r.extraUsed);
    }

    /**
     * Take a full-round action — uses the whole turn. Per user spec this
     * locks all three slots (Movement + Action + Extra). "Actively Dodge"
     * additionally frees defenses from STA drain (Core p.152).
     *
     * Blocked once any slot is already spent this turn: a full-round action
     * needs the entire turn, so moving / acting / extra-acting rules it out.
     * Returns true on success, false if blocked.
     */
    async recordFullRound(label = "Full Round", { allowStunned = false } = {}) {
        if (this._recoveryLocked) { notify(LOCKED_MSG); return false; }
        if (this._actionLocked && !allowStunned) { notify(this._actionLockMsg); return false; }
        if (!this._inActiveCombat) return true;        // out of combat: free, no slot lock
        if (this._locked) { notify("Turn is already committed to a full-round action."); return false; }
        if (this._turnDirty) { notify("Can't take a full-round action — you've already moved or acted this turn."); return false; }
        const dodging = /actively\s*dodg/i.test(String(label));
        await this.update({
            "system.combatRound.fullRound": true,
            "system.combatRound.fullRoundLabel": String(label),
            "system.combatRound.movementUsed": true,
            "system.combatRound.actionUsed": true,
            "system.combatRound.extraUsed": true,
            "system.combatRound.activelyDodging": dodging
        });
        return true;
    }

    /** Highest active Aim rank (1..AIM_MAX_RANK), or 0 if not aiming. Reads the
     *  `aim-N` status set placed by takeAimAction. */
    get aimRank() {
        let rank = 0;
        for (const id of (this.statuses ?? [])) {
            const m = /^aim-(\d+)$/.exec(id);
            if (m) rank = Math.max(rank, Number(m[1]));
        }
        return rank;
    }

    /** To-hit bonus from the current Aim rank (+1/turn, capped). */
    get aimBonus() {
        return Math.min(AIM_BONUS_CAP, this.aimRank * AIM_BONUS_PER_TURN);
    }

    /** Aim Action (full round): lock the turn, then raise the Aim status one
     *  rank (capped). Each round spent aiming adds +1 to the next ranged
     *  attack's to-hit, up to +AIM_BONUS_CAP. */
    async takeAimAction() {
        if (!(await this.recordFullRound("Aim"))) return;
        const current = this.aimRank;
        const next = Math.min(AIM_MAX_RANK, current + 1);
        if (next === current) {
            notify(`${this.name} is already at maximum aim (Aim ${AIM_MAX_RANK}).`, "info");
            return;
        }
        if (current) await this.toggleStatusEffect?.(`aim-${current}`, { active: false });
        await this.toggleStatusEffect?.(`aim-${next}`, { active: true });
        notify(`${this.name} takes aim (Aim ${next}, +${this.aimBonus} to next ranged attack).`, "info");
    }

    /** Consume the Aim status, returning the to-hit bonus it conferred (0 if
     *  not aiming). Clears the status so the bonus is single-use. */
    async consumeAim() {
        const rank = this.aimRank;
        if (!rank) return 0;
        const bonus = this.aimBonus;
        try { await this.toggleStatusEffect?.(`aim-${rank}`, { active: false }); }
        catch (err) { console.warn("witcher-ttrpg-death-march | consumeAim failed", err); }
        return bonus;
    }

    /** Recovery Action (full round): lock the turn first, then regain STA
     *  equal to REC. Lock before recovering so a dirty turn (already moved /
     *  acted) is rejected without granting the STA. */
    async takeRecoveryAction() {
        if (!(await this.recordFullRound("Recovery Action", { allowStunned: true }))) return;
        const rec = Number(this.system?.derivedStats?.rec) || 0;
        await this.recoverStamina(rec);
        notify(`${this.name} catches their breath — recovered ${rec} STA.`, "info");
    }

    /**
     * Record a defensive action. The first is free; each additional costs
     * 1 STA — unless the character used their action to Actively Dodge this
     * round, in which case defenses are free (Core p.152).
     */
    async recordDefense() {
        if (this._stunned || cannotDefend(this)) { notify(this._stunned ? STUN_MSG : LOCKED_MSG); return 0; }
        if (!this._inActiveCombat) return 0;           // out of combat: free, no STA cost
        const r = this._round;
        const next = (Number(r.defenseCount) || 0) + 1;
        await this.update({ "system.combatRound.defenseCount": next });
        // 1st defense free; combatMods.freeDefenses grants extra free reactions
        // beyond it. Each one past that costs 1 STA (unless Actively Dodging).
        const freeDef = Number(this.system?.combatMods?.freeDefenses) || 0;
        if (next > (1 + freeDef) && !r.activelyDodging) {
            await this.spendStamina(1, { reason: "defense" });
        }
        return next;
    }

    /** Flag that a reload action was taken this turn, so banked reload
     *  progress on the wielder's weapons survives into the next turn. */
    async markReloadAction() {
        if (!this._inActiveCombat) return;
        if (this._round.reloadedThisTurn) return;
        await this.update({ "system.combatRound.reloadedThisTurn": true });
    }

    /** Zero any banked reload progress on this actor's weapons. Called when a
     *  turn passes without a reload action (Slow Reload can't be paused). */
    async _resetReloadProgress() {
        const updates = [];
        for (const it of this.items) {
            if (it.type !== "weapon") continue;
            if ((Number(it.system?.loaded?.reloadProgress) || 0) > 0) {
                updates.push({ _id: it.id, "system.loaded.reloadProgress": 0 });
            }
        }
        if (updates.length) await this.updateEmbeddedDocuments("Item", updates);
    }

    /** Reset the round budget — called at the start of the character's turn. */
    async resetCombatRound() {
        // If the turn that just ended had no reload action, drop any banked
        // reload progress before clearing the flag for the new turn.
        if (!this._round.reloadedThisTurn) await this._resetReloadProgress();
        await this.update({
            "system.combatRound.movementUsed": false,
            "system.combatRound.movementMeters": 0,
            "system.combatRound.actionUsed": false,
            "system.combatRound.actionLabel": "",
            "system.combatRound.extraUsed": false,
            "system.combatRound.extraLabel": "",
            "system.combatRound.fullRound": false,
            "system.combatRound.fullRoundLabel": "",
            "system.combatRound.defenseCount": 0,
            "system.combatRound.activelyDodging": false,
            "system.combatRound.reloadedThisTurn": false
        });
    }
};
