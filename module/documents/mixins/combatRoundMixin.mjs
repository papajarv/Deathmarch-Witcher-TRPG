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
import { AIM_BONUS_CAP, AIM_BONUS_PER_TURN, ARMOR_QUALITIES } from "../../setup/config.mjs";
import { cannotAct, cannotRecover, cannotDefend, cannotEscape } from "../../mechanics/statusEngine.mjs";
import { onCombatStaminaSpend } from "../../mechanics/foodAndDrink.mjs";
import { t, tFormat } from "../../chrome/lib/i18n.js";
import { resolveActorCombat } from "../../chrome/lib/actor.js";
import { hrExtraActionStaCost, hrExtraDefenseStaCost } from "../../mechanics/house-rules-config.mjs";
import { gmOffTurnMoveActive } from "../../policy/gm-offturn-move.mjs";
import { weatherAdjustedMoveCap } from "../../mechanics/weather-modifiers.mjs";
import { armorHalvesStaRecovery } from "../../mechanics/helmetVision.mjs";

const notify = (msg, type = "warn") => ui?.notifications?.[type]?.(msg);

/* Lazy so t() sees a loaded lang. */
const STUN_MSG   = () => t("WITCHER.Doc.CombatRoundMixin.Notify.Stunned",      "Stunned at 0 STA — you can only take a Recovery action.");
const LOCKED_MSG = () => t("WITCHER.Doc.CombatRoundMixin.Notify.Incapacitated","You can take no actions while incapacitated.");

/** Highest Aim rank the status set supports (+1/turn up to the cap). */
const AIM_MAX_RANK = Math.max(1, Math.ceil(AIM_BONUS_CAP / AIM_BONUS_PER_TURN));

export const combatRoundMixin = (Base) => class extends Base {

    get _round() {
        return this.system?.combatRound ?? {};
    }

    /** True only when this actor is a combatant of the current-scene started
     *  combat (via `resolveActorCombat`, which is scene-scoped so a lingering
     *  combat the GM left running on another scene doesn't count). The action
     *  economy applies solely in combat — out of combat the budget methods are
     *  free no-ops (you can still take the actions, they just don't consume
     *  slots or STA). */
    get _inActiveCombat() {
        // Sourced from resolveActorCombat, NOT game.combat: in v14 game.combat
        // rides the combat tracker's render state and collapses to null on an
        // inactive-but-started combat every time the tracker re-renders (which
        // it does on each item/actor update), which was making mid-update
        // action charges (ranged fire, reload, weapon draw) silently free.
        return !!resolveActorCombat(this);
    }

    /** True only when it's CURRENTLY this actor's turn in the active combat.
     *  Off-turn actors get zero budget. Resolves the combat the same way as
     *  `_inActiveCombat` (`resolveActorCombat`, not `game.combat`), so the two
     *  stay consistent. */
    get _isMyTurn() {
        // Same combat source as _inActiveCombat (resolveActorCombat, not
        // game.combat) so the turn check doesn't wrongly read "not your turn"
        // when the tracker de-renders on a started-but-inactive combat.
        const c = resolveActorCombat(this);
        if (!c) return false;
        const cb = c.combatant;
        if (!cb) return false;
        const tokenId = this.token?.id ?? null;
        if (tokenId && cb.tokenId === tokenId) return true;
        if ((cb.actorId ?? cb.actor?.id) === this.id) return true;
        return false;
    }

    /** Current / max / temp STA, defaulting to 0. `temp` is the "adrenaline →
     *  temporary stamina" house-rule buffer: spent BEFORE real STA and counted
     *  toward everything spendable (affordability + un-stun). `spendable` folds
     *  temp into the current value so gate sites read one number. */
    get _sta() {
        const sta = this.system?.derivedStats?.sta ?? {};
        const value = Number(sta.value) || 0;
        const temp  = Math.max(0, Number(sta.temp) || 0);
        return { value, max: Number(sta.max) || 0, temp, spendable: value + temp };
    }

    /** Stunned: at 0 STA. Per user ruling, every action is locked out except the
     *  Recovery full-round action until STA returns to ≥1 — this applies whether
     *  or not a Foundry combat is "started". Guarded on max > 0 so actors with no
     *  STA pool configured (or not yet prepared) aren't falsely stunned. */
    get _stunned() {
        const { spendable, max } = this._sta;
        // Temp STA (house-rule buffer) counts as spendable stamina, so a stunned
        // actor who converts adrenaline into temp STA is no longer stunned until
        // that buffer is exhausted.
        return max > 0 && spendable === 0;
    }

    /** Cannot take a normal action this turn — STA-stun OR a status that
     *  forbids actions (Stunned / Paralyzed / Unconscious). Recovery may still
     *  be allowed; see `_recoveryLocked`. */
    get _actionLocked() {
        return this._stunned || cannotAct(this);
    }

    /** GM-toggled per-actor override. When on, every action-slot gate treats
     *  the actor as fresh: `nextActionSlot` always returns "action", record*
     *  helpers no-op instead of marking the slot used, so an NPC (or a PC in a
     *  narrative sequence) can act freely without the round budget draining.
     *  Stored on the actor as `flags.<sys>.freeActions`. */
    get _freeActionsMode() {
        return !!this.getFlag?.("witcher-ttrpg-death-march", "freeActions");
    }

    /** The notify message for the current action lock. STA-stun keeps its own
     *  Recovery hint; a status lock is generic. */
    get _actionLockMsg() {
        return this._stunned ? STUN_MSG() : LOCKED_MSG();
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
        const { value, temp } = this._sta;
        // Temp STA (adrenaline house-rule buffer) is spent FIRST, mirroring how
        // temp HP absorbs damage before real HP. Only the overflow drains real STA.
        const fromTemp = Math.min(temp, n);
        const fromReal = n - fromTemp;
        const next = Math.max(0, value - fromReal);
        const upd = { "system.derivedStats.sta.value": next };
        if (fromTemp > 0) upd["system.derivedStats.sta.temp"] = temp - fromTemp;
        await this.update(upd);
        // Homebrew (foodAndDrink): in-combat STA expenditure burns satiety
        // (0.5 per STA, configurable in mechanics/foodAndDrink.mjs). Only the
        // REAL stamina spent burns satiety — temp STA is a free buffer. The
        // helper self-gates on combat state + homebrew toggle so out-of-combat
        // spends (e.g. casting a spell at camp) skip the drain.
        if (fromReal > 0) {
            try { await onCombatStaminaSpend(this, fromReal); }
            catch (err) { console.warn("witcher-ttrpg-death-march | satiety drain on STA spend failed", err); }
        }
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
        if (this._actionLocked) { notify(this._actionLockMsg); return false; }
        if (!this._inActiveCombat) return true;        // out of combat: free, untracked
        /* GM Free-Actions override: no movement budget, no cap, no
         * turn-lock check, no "already moved" gate. Matches the intent
         * of the flag — "let this actor do whatever without spending
         * anything" — extended from action slots (existing behaviour)
         * to movement. A run-distance move is just fine; no Run
         * declaration is required. Leaves system.combatRound.movement*
         * untouched so subsequent moves also pass through freely and
         * the round-reset flow doesn't see a partial-turn state to
         * clear up. */
        if (this._freeActionsMode) return true;
        /* Off-turn → zero budget. The actor whose turn it ISN'T can't act
         * or move on the canvas; the dock buttons refuse via the same
         * gate. Use _isMyTurn (the strict "current combatant" check) so
         * being merely in the tracker isn't enough.
         *
         * GM Off-Turn Move override: when the GM has the combat-tracker toggle
         * on, allow the off-turn move but record NO budget (return true, as if
         * out of combat) — the GM is repositioning, not spending this actor's
         * turn. Mirrors the canvas-side bypass in policy/canvas-movement.mjs. */
        if (!this._isMyTurn) {
            if (gmOffTurnMoveActive()) return true;
            notify(t("WITCHER.Doc.CombatRoundMixin.Notify.NotYourTurn", "Not your turn.")); return false;
        }
        if (this._locked) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.TurnCommitted", "Turn is committed to a full-round action.")); return false; }
        const m   = Math.max(0, Math.round(Number(meters) || 0));
        const spd = Number(this.system?.stats?.spd?.value) || 0;
        const split = isHomebrewEnabled("splitMovement");

        /* Run (full-round): SPD×3 movement budget, locks all other slots.
         * `runUsed` is the "spent the full-round action on Run" flag set
         * by recordRun; when on, the movement cap is tripled and other
         * action slots are already blocked by the _locked check above.
         *
         * Viper heroic — Lightning Fast: rolled Nd6 bonus meters, stamped
         * on flags.wr.lightningFastBonus by wrHeroic.lightningFast and
         * cleared on turn end. Added AFTER the run multiplier so the
         * bonus is additive rather than tripled by Run. */
        const runMul = this._round.runUsed ? 3 : 1;
        const wrBonus = Number(this.getFlag?.("witcher-ttrpg-death-march", "wr.lightningFastBonus")) || 0;
        // Weather footing (wind/rain/snow) trims the NORMAL speed (min 1); Run is
        // 3× the already-penalised speed. Lightning-Fast bonus rides on top.
        const cap = spd ? weatherAdjustedMoveCap(spd, runMul, wrBonus, this) : 0;

        if (!split) {
            // RAW: movement must precede any action; acting forfeits it.
            if (this._round.actionUsed || this._round.extraUsed) {
                notify(t("WITCHER.Doc.CombatRoundMixin.Notify.MovementForfeit", "You've already acted this turn — movement is forfeit (enable Split Movement to interleave)."));
                return false;
            }
            if (this._round.movementUsed) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.AlreadyMoved", "Already moved this turn.")); return false; }
            /* HARD CAP — refuse over-budget moves instead of recording with
             * a warning. Canvas drags snap back on `return false` so the
             * visual position matches the budget. */
            if (cap && m > cap) {
                notify(tFormat(
                    "WITCHER.Doc.CombatRoundMixin.Notify.CantMoveOverCap",
                    { m, cap, mode: runMul > 1 ? t("WITCHER.Doc.CombatRoundMixin.Notify.RunSpd3Tag", " (Run, SPD×3)") : tFormat("WITCHER.Doc.CombatRoundMixin.Notify.SpdRunTag", { r: spd * 3 }, " (SPD; Run for {r}m)") },
                    "Can't move {m}m — exceeds cap of {cap}m{mode}."
                ));
                return false;
            }
            await this.update({
                "system.combatRound.movementUsed": true,
                "system.combatRound.movementMeters": m
            });
            return true;
        }

        // Split Movement: accumulate up to total cap (SPD or SPD×3 if Run), in any order.
        if (this._round.movementUsed) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.MovementUsed", "You've used all your movement this turn.")); return false; }
        const prior     = Number(this._round.movementMeters) || 0;
        const remaining = cap ? Math.max(0, cap - prior) : Infinity;
        /* HARD CAP — refuse if this move would push past the remaining
         * budget. Same reasoning as the RAW branch: canvas drag snaps back. */
        if (cap && m > remaining) {
            notify(tFormat(
                "WITCHER.Doc.CombatRoundMixin.Notify.MovementLeftCap",
                { remaining, cap, mode: runMul > 1 ? t("WITCHER.Doc.CombatRoundMixin.Notify.RunTag", ", Run") : "" },
                "Only {remaining}m of movement left this turn (cap {cap}m{mode})."
            ));
            return false;
        }
        const applied = cap ? Math.min(prior + m, cap) : prior + m;
        await this.update({
            "system.combatRound.movementMeters": applied,
            "system.combatRound.movementUsed": cap ? applied >= cap : false
        });
        return true;
    }

    /** Spend the full-round action on Run: locks all other action slots,
     *  triples the movement cap to SPD×3 for the remainder of the turn.
     *  Mirrors the existing fullRound flag pattern.
     *
     *  Combat Extended: RUN costs 3 STA (mirror of the extra-action cost
     *  gate). Refuses the RUN if the actor can't afford it — no half-
     *  measures like extraActionPenaltyReduction; the AE-settable
     *  reduction is `system.combatMods.runStaReduction` (positive N shaves
     *  N off the base 3, so 3 = free RUN). RAW (no CE) keeps RUN free. */
    async recordRun() {
        /* Free-Actions override — no turn-lock, no full-round commit,
         * no action-slot bookkeeping. Consistent with recordMovement's
         * override above: under Free Actions you can move any distance
         * (including Run range) without declaring anything. */
        if (this._freeActionsMode) return true;
        if (this._actionLocked) { notify(this._actionLockMsg); return false; }
        if (!this._inActiveCombat) return true;
        if (!this._isMyTurn) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.NotYourTurn", "Not your turn.")); return false; }
        if (this._locked) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.TurnCommitted", "Turn is committed to a full-round action.")); return false; }
        if (this._round.actionUsed || this._round.extraUsed) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.CantRun", "You've already acted this turn — can't Run.")); return false; }
        /* CE STA gate — only when Combat Extended's action-costs subsystem
         * is on (mirrors defenseCosts pattern for consistency). Base 3
         * STA, less any runStaReduction from AEs / passives. Refuse the
         * RUN when the pool can't cover it, matching how extra-action
         * would fall back to "no slot" if the STA gate wasn't met. */
        let runStaCost = 0;
        try {
            const { isCESubsystemEnabled } = await import("../../api/homebrew.mjs");
            if (isCESubsystemEnabled("actionCosts")) {
                const reduction = Number(this.system?.combatMods?.runStaReduction) || 0;
                runStaCost = Math.max(0, 3 - reduction);
                if (runStaCost > this._sta.spendable) {
                    notify(tFormat("WITCHER.Doc.CombatRoundMixin.Notify.NotEnoughStaRun", { need: runStaCost, have: this._sta.spendable }, "Not enough STA to Run (need {need}, have {have})."));
                    return false;
                }
            }
        } catch (_) { /* CE unavailable → free RUN, RAW behavior */ }
        /* Also drop the movementUsed flag if it was set. Run redefines
         * the movement budget as SPD×3, so a prior "used full SPD" flag
         * is stale under the new cap — the actor still has 2×SPD more
         * to spend. movementMeters intentionally stays (the actor
         * already committed those meters); only the "action fully
         * spent" latch is cleared. */
        await this.update({
            "system.combatRound.fullRound": true,
            "system.combatRound.fullRoundLabel": "Run",
            "system.combatRound.runUsed": true,
            "system.combatRound.movementUsed": false
        });
        if (runStaCost > 0) await this.spendStamina(runStaCost, { reason: "run" });
        return true;
    }

    /** Spend the single action with a display `label`. Returns false if gone.
     *
     *  Options:
     *    escapeAttempt — bypass hold-family act-restrictions (pinned /
     *                    chokeheld / clinched). RAW Core "Brawling &
     *                    Wrestling" leaves Escape as the one action a
     *                    held actor can still take, so a Pin has to
     *                    stop *every other* action but still allow the
     *                    dedicated Escape roll. True incapacitation
     *                    (Paralyzed / Unconscious) still blocks. */
    async recordAction(label = "Action", { escapeAttempt = false, force = false } = {}) {
        if (this._freeActionsMode) return true;        // GM override — no slot spent
        const locked = escapeAttempt
            ? (this._stunned || cannotEscape(this))
            : this._actionLocked;
        if (locked) { notify(this._actionLockMsg); return false; }
        /* `force` — the caller pre-verified (before an async cast that placed
         * an area template) that the actor was in combat and on its turn.
         * `game.combat` transiently reads null during that placement, so the
         * live _inActiveCombat / _isMyTurn checks would wrongly no-op the
         * spend. Skip only those two gates; every real gate below still runs. */
        if (!force && !this._inActiveCombat) return true;   // out of combat: free, untracked
        if (!force && !this._isMyTurn) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.NotYourTurn", "Not your turn.")); return false; }
        if (this._locked) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.TurnCommitted", "Turn is committed to a full-round action.")); return false; }
        if (this._round.actionUsed) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.ActionSpent", "Action already spent — use the Extra Action (3 STA).")); return false; }
        await this.update({
            "system.combatRound.actionUsed": true,
            "system.combatRound.actionLabel": String(label)
        });
        return true;
    }

    /** Spend the extra action (3 STA, at -3). Returns false if gone.
     *
     * Per RAW (Core p.152) the extra action is a SECOND action — you
     * can't take it without having used your normal action first.
     * `requirePriorAction` enforces that. Special Actions (Combat
     * Extended — Raise Shield, Change Guards) pass `false` to bypass
     * the gate: paying the 3 STA cost is the player "giving up" their
     * extra-action slot regardless of whether the regular action is
     * still pending. */
    async recordExtraAction(label = "Extra Action", { requirePriorAction = true, escapeAttempt = false, force = false } = {}) {
        if (this._freeActionsMode) return true;        // GM override — no slot, no STA
        const locked = escapeAttempt
            ? (this._stunned || cannotEscape(this))
            : this._actionLocked;
        if (locked) { notify(this._actionLockMsg); return false; }
        // `force`: see recordAction — bypasses only the combat/turn no-op gates
        // for a cast whose async template placement transiently nulled game.combat.
        if (!force && !this._inActiveCombat) return true;   // out of combat: free, no STA cost
        if (!force && !this._isMyTurn) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.NotYourTurn", "Not your turn.")); return false; }
        if (this._locked) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.TurnCommitted", "Turn is committed to a full-round action.")); return false; }
        if (requirePriorAction && !this._round.actionUsed) {
            notify(t("WITCHER.Doc.CombatRoundMixin.Notify.UseActionFirst", "Use your action first — the extra action is a second action."));
            return false;
        }
        if (this._round.extraUsed) { notify(t("WITCHER.Doc.CombatRoundMixin.Notify.ExtraSpent", "Extra action already spent this turn.")); return false; }
        await this.update({
            "system.combatRound.extraUsed": true,
            "system.combatRound.extraLabel": String(label)
        });
        /* Base cost from the House Rules panel (RAW default 3), minus the
         * per-actor `extraActionStaReduction` AE (a reduction that matches or
         * exceeds the base = free extra action) AND the transient Nimble
         * weapon reduction stashed by weaponAttack (EO p.7 — reduce the cost,
         * don't refund after). Consume the Nimble value so it never carries
         * into a later, non-Nimble extra action. */
        const nimbleRed = Math.max(0, Number(this._nimbleExtraStaReduction) || 0);
        this._nimbleExtraStaReduction = 0;
        const staCost = Math.max(0, hrExtraActionStaCost() - (Number(this.system?.combatMods?.extraActionStaReduction) || 0) - nimbleRed);
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
        if (this._freeActionsMode) return "action";  // GM override — unlimited
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

    async spendActionSlot(label = "Action", { force = false } = {}) {
        /* Free-actions override: mirror `nextActionSlot`'s bypass so the
         * dock's pre-attack gate (which reads nextActionSlot via
         * hasActionSlot) and the post-attack spend agree. Without this
         * mirror, an attack passes the gate but the spend returns null,
         * causing callers to skip ROF ticks / status-slot commits. */
        if (this._freeActionsMode) return "action";
        if (this._actionLocked) { notify(this._actionLockMsg); return null; }
        /* `force`: caller pre-verified in-combat/on-turn before an async cast
         * that transiently nulled game.combat (area-template placement). Skip
         * the live in-combat gate here and in the record* calls below. */
        if (!force && !this._inActiveCombat) return null;   // out of combat: free, untracked
        if (this._locked) { notify(t("WITCHER.Doc.CombatRound.Notify.TurnCommittedFullRound", "Turn is committed to a full-round action.")); return null; }
        if (!this._round.actionUsed) { await this.recordAction(label, { force }); return "action"; }
        if (!this._round.extraUsed)  { await this.recordExtraAction(label, { force }); return "extra"; }
        notify(t("WITCHER.Doc.CombatRound.Notify.NoActionsLeft", "No actions left this turn."));
        return null;
    }

    /**
     * Combat Extended (L5) — spend a slot for a Special Action (Raise
     * Shield, Change Guards, etc.). Per rules1: "Spend move action or
     * your action. Can be extra action but with the STA cost."
     *
     * Two modes:
     *   - `{ slot: "movement" | "action" | "extra" }` — explicit pick
     *     (used by the slot-picker prompt). Tries ONLY the named slot.
     *   - omitted → auto-pick by priority (movement → action → extra).
     *     Kept for non-interactive callers / backwards compat.
     *
     * Multi-use per round: the action economy itself caps the count
     * (max three Special Actions per turn, since there are three slots
     * total). When the picked / all slots are spent, this returns null.
     *
     * Returns the slot used ("movement" / "action" / "extra"), or null
     * when the spend was refused. Out of combat returns "free" (no slot
     * spent, Special Actions are free outside a fight).
     */
    async spendSpecialActionSlot(label = "Special Action", { slot = null } = {}) {
        /* Free-actions override: no slot, no lock check. Special Actions
         * become effectively free while the GM has this on. */
        if (this._freeActionsMode) return "free";
        if (!this._inActiveCombat) return "free";
        if (this._actionLocked) { notify(this._actionLockMsg); return null; }
        if (this._locked)       { notify(t("WITCHER.Doc.CombatRound.Notify.TurnCommittedFullRound", "Turn is committed to a full-round action.")); return null; }

        const moveAvail = !this._round.movementUsed && !((Number(this._round.movementMeters) || 0) > 0);
        const actAvail  = !this._round.actionUsed;
        const extraAvail= !this._round.extraUsed;

        const spendMovement = async () => {
            if (!moveAvail) { notify(t("WITCHER.Doc.CombatRound.Notify.MovementUsed", "Movement already used this turn.")); return null; }
            await this.update({
                "system.combatRound.movementUsed": true,
                "system.combatRound.actionLabel":  String(label)
            });
            return "movement";
        };
        const spendAction = async () => {
            if (!actAvail) { notify(t("WITCHER.Doc.CombatRound.Notify.ActionUsed", "Action already used this turn.")); return null; }
            const ok = await this.recordAction(label);
            return ok ? "action" : null;
        };
        const spendExtra = async () => {
            if (!extraAvail) { notify(t("WITCHER.Doc.CombatRound.Notify.ExtraUsed", "Extra action already used this turn.")); return null; }
            /* Special Actions bypass the "use your normal action first"
             * RAW gate — paying the 3 STA cost is the player explicitly
             * giving up their extra-action slot, regardless of whether
             * the normal action is still pending. */
            const ok = await this.recordExtraAction(label, { requirePriorAction: false });
            return ok ? "extra" : null;
        };

        if (slot === "movement") return await spendMovement();
        if (slot === "action")   return await spendAction();
        if (slot === "extra")    return await spendExtra();

        /* Auto-pick fallback — movement → action → extra. */
        if (moveAvail)  return await spendMovement();
        if (actAvail)   return await spendAction();
        if (extraAvail) return await spendExtra();
        notify(t("WITCHER.Doc.CombatRound.Notify.NoSlotForSpecial", "No slot left for a Special Action this turn."));
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
    async recordFullRound(label = "Full Round", { allowStunned = false, postCharge = false, force = false } = {}) {
        /* Free-actions override: full-round declarations no-op instead of
         * locking the whole turn, so a GM'd actor can chain Aim / Recovery
         * / Actively Dodge without consuming their budget. */
        if (this._freeActionsMode) return true;
        if (this._recoveryLocked) { notify(LOCKED_MSG()); return false; }
        if (this._actionLocked && !allowStunned) { notify(this._actionLockMsg); return false; }
        // `force`: see recordAction — a full-round cast (ritual / long casting
        // time) whose async template placement transiently nulled game.combat.
        if (!force && !this._inActiveCombat) return true;   // out of combat: free, no slot lock
        if (this._locked) { notify(t("WITCHER.Doc.CombatRound.Notify.TurnAlreadyCommitted", "Turn is already committed to a full-round action.")); return false; }
        /* `postCharge` skips the dirty guard: a Charge grants SPD×3 movement
         * up-front and the player is expected to have moved before the strike
         * that finalizes the full-round. Without this bypass the finalize
         * silently fails and the action / extra slots stay unspent. */
        if (this._turnDirty && !postCharge) { notify(t("WITCHER.Doc.CombatRound.Notify.CantFullRoundDirty", "Can't take a full-round action — you've already moved or acted this turn.")); return false; }
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
     *  acted) is rejected without granting the STA.
     *
     *  Restricted Vision / Poor Vision (house variant of EO p.8): a worn
     *  helm with the visor down HALVES the in-combat STA recovery rather
     *  than blocking it entirely. The check scans the actor's equipped
     *  armor for the `armorHalvesCombatStaRecovery` flag; if any piece
     *  carries it, REC is floored to half. The chat notification calls
     *  the reduction out so the player understands why the gain looks
     *  short. */
    async takeRecoveryAction() {
        /* Can't catch your breath while being choked — a chokeheld actor is
         * suffocating, not recovering. Backstop for the greyed dock option. */
        if (this.statuses?.has?.("chokeheld")) {
            notify(t("WITCHER.Chrome.Dock.Text.ChokedNoRecovery", "You can't recover while you're being choked."), "warn");
            return;
        }
        if (!(await this.recordFullRound("Recovery Action", { allowStunned: true }))) return;
        let rec = Number(this.system?.derivedStats?.rec) || 0;
        const halved = this.#armorHalvesStaRecovery();
        if (halved) rec = Math.floor(rec / 2);
        await this.recoverStamina(rec);
        notify(halved
            ? `${this.name} catches their breath — recovered ${rec} STA (halved by Restricted Vision).`
            : `${this.name} catches their breath — recovered ${rec} STA.`, "info");
    }

    /** True if any equipped armor on this actor carries an
     *  `armorHalvesCombatStaRecovery` flag (Restricted Vision / Poor Vision)
     *  with its visor down. Shared with the sheet's Take a Breath so both
     *  recovery surfaces agree — see mechanics/helmetVision.mjs. */
    #armorHalvesStaRecovery() {
        return armorHalvesStaRecovery(this);
    }

    /**
     * Record a defensive action. Spend semantics depend on which ruleset
     * is active:
     *
     *   RAW (Core p.152) — 1st defense free; each additional costs 1 STA
     *   unless the actor used their action to Actively Dodge this round.
     *   `actionKey` is ignored.
     *
     *   Combat Extended (rules2.png) — each defense has a BASE STA cost
     *   from the active combat-actions table (Parry 0, Block 0, Dodge 1,
     *   Reposition 2 by default), AND every defense after the first adds
     *   an extra +1 STA on top. Actively Dodging still zeroes everything
     *   (same letter of the Core "free defenses" rule). The freeDefenses
     *   combatMod is honored under both rulesets — it shifts the "after
     *   the first" boundary up by N.
     *
     * @param {string|null} actionKey — combat-actions key ("parry",
     *   "block", "dodge", "reposition") OR null for non-CE-aware callers
     *   (brawl block, etc.) which then default to the RAW shape.
     */
    async recordDefense(actionKey = null) {
        if (this._stunned || cannotDefend(this)) { notify(this._stunned ? STUN_MSG() : LOCKED_MSG()); return 0; }
        if (!this._inActiveCombat) return 0;           // out of combat: free, no STA cost
        /* Free-Actions override — no defense-count bank, no STA cost,
         * no recurrence step. Matches how record{Action,Extra,Movement,
         * Run} treat the flag: return a truthy result without writing
         * any round state so the caller's flow continues but the GM
         * panel's `Def` pill stays at 0. */
        if (this._freeActionsMode) return 1;
        const r = this._round;
        const next = (Number(r.defenseCount) || 0) + 1;
        await this.update({ "system.combatRound.defenseCount": next });
        if (r.activelyDodging) return next;            // Active Dodge zeroes everything (RAW + CE)
        const freeDef = Number(this.system?.combatMods?.freeDefenses) || 0;

        /* CE path: base STA from the actions table + the additive
         * recurrence step. Imported lazily so the RAW path stays free
         * of the CE dependency. */
        let ceBase = null;
        if (actionKey) {
            try {
                const { isCESubsystemEnabled } = await import("../../api/homebrew.mjs");
                if (isCESubsystemEnabled("defenseCosts")) {
                    const { getActiveCombatActions } = await import("../../data/combatExtended/actions.mjs");
                    const entry = getActiveCombatActions()[actionKey];
                    if (entry?.kind === "defense") ceBase = Number(entry.staCost) || 0;
                }
            } catch (_) { /* CE module missing — fall through to RAW */ }
        }
        if (ceBase !== null) {
            /* Base cost on every defense (Parry/Block can be 0, that's fine
             * — spendStamina(0) is a no-op). Recurrence: +1 per defense
             * past the first (and past any freeDefenses combatMod). The
             * recurrence step is gated by the `additiveDefenseRecurrence`
             * tuneable — when OFF, only the base cost is charged. */
            let recurOn = true;
            try {
                const { ceTuneable } = await import("../../api/homebrew.mjs");
                recurOn = ceTuneable("additiveDefenseRecurrence") !== false;
            } catch (_) { /* tuneable read failed — keep default behavior */ }
            /* Recurrence STA per extra defense from the House Rules
             * panel (RAW default 1). Setting the panel value to 0
             * disables the cumulative cost regardless of the tuneable. */
            const recurStep = hrExtraDefenseStaCost();
            const recur = (recurOn && next > (1 + freeDef)) ? recurStep : 0;
            const total = ceBase + recur;
            if (total > 0) await this.spendStamina(total, { reason: "defense" });
            return next;
        }

        /* RAW (legacy) path — 1st free, +N each extra where N is the
         * "Extra Defense STA cost" from the House Rules panel (RAW
         * default 1). A panel value of 0 makes all defenses free. */
        if (next > (1 + freeDef)) {
            const cost = hrExtraDefenseStaCost();
            if (cost > 0) await this.spendStamina(cost, { reason: "defense" });
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
            "system.combatRound.runUsed": false,
            "system.combatRound.defenseCount": 0,
            "system.combatRound.activelyDodging": false,
            "system.combatRound.reloadedThisTurn": false,
            "system.combatRound.repositionMeters": 0,
            /* Adrenaline → temporary stamina (house rule): the temp-STA buffer
             * lasts until the START of the actor's NEXT turn, then evaporates —
             * exactly like the RAW "temp HP until end of encounter" but per-turn.
             * Cleared here so a buffer bought last turn is gone this turn. */
            "system.derivedStats.sta.temp": 0,
            /* Witchers Reborn — Viper · Lightning Fast: heroic movement
             * bonus is a per-turn effect; zero it on turn reset so a
             * Viper who declared Lightning Fast last turn doesn't carry
             * the extra meters into their next turn. */
            "flags.witcher-ttrpg-death-march.wr.lightningFastBonus": 0
        });

        /* Also clear Foundry V13's per-token `_movementHistory`. The combat
         * flow does this on the GM client via `_clearMovementHistoryOnStartTurn`,
         * but the DB write may not have propagated to other clients by the
         * time their next canvas drag fires — leaving canvas-movement's
         * history-total reader to pick up STALE waypoints from the previous
         * turn and stamp them as the new total. Belt-and-suspenders clear
         * here from the same iShouldWrite gate that just zeroed the budget. */
        const tokens = (typeof this.getActiveTokens === "function")
            ? (this.getActiveTokens(false, true) ?? [])
            : [];
        for (const td of tokens) {
            if (typeof td?.clearMovementHistory !== "function") continue;
            try { await td.clearMovementHistory(); }
            catch (_) { /* token may have been destroyed mid-turn */ }
        }

        /* Choke maintenance — a chokehold must be re-applied (Choke action)
         * every turn. `chokeRound` is stamped each time this actor Chokes. If
         * their turn is starting and they let a full turn lapse without
         * maintaining (round fell 2+ behind), the grip slips: release every
         * chokehold they hold. Re-maintaining this turn restamps chokeRound. */
        try {
            // resolveActorCombat (not game.combat) so an inactive-but-started
            // combat still yields the real round — game.combat can read null
            // here for the same v14 tracker-render reason as _inActiveCombat.
            const round = Number(resolveActorCombat(this)?.round) || 0;
            const chokeRound = Number(this.getFlag?.("witcher-ttrpg-death-march", "chokeRound"));
            if (Number.isFinite(chokeRound) && round - chokeRound >= 2) {
                const { getHoldLinks, clearHoldLink } = await import("../../mechanics/holdLink.mjs");
                const pairs = await getHoldLinks(this);
                let released = false;
                for (const p of pairs) {
                    if (p.kind !== "chokeheld" || p.role !== "holder") continue;
                    const partner = p.partnerUuid ? await fromUuid(p.partnerUuid).catch(() => null) : null;
                    await clearHoldLink(this, "choke lapsed", partner ?? null, "chokeheld");
                    released = true;
                }
                if (released) { try { await this.unsetFlag("witcher-ttrpg-death-march", "chokeRound"); } catch (_) {} }
            }
        } catch (err) { console.warn("witcher-ttrpg-death-march | choke lapse check failed", err); }
    }
};
