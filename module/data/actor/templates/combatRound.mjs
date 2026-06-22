/**
 * Combat-round state template — RAW action economy (Core p.151-152).
 *
 * Per round a character gets: movement up to SPD (meters), ONE action, and
 * one optional EXTRA action (3 STA, at -3). A full-round action uses the
 * whole turn. The first defensive action is free; each additional costs
 * 1 STA unless the character used their action to Actively Dodge.
 *
 * These fields are transient turn-state, reset at the start of the
 * character's turn (see the combat turn-start hook). They live on the
 * actor document (not flags) so the dock reads them as ordinary system
 * fields and they sync across clients.
 *
 * Schema shape:
 *   combatRound:
 *     movementUsed    : boolean   movement spent this turn
 *     movementMeters  : number    how far the character declared moving (m)
 *     actionUsed      : boolean   the single action spent
 *     actionLabel     : string    what the action was (display)
 *     extraUsed       : boolean   the extra action spent (cost 3 STA)
 *     extraLabel      : string    what the extra action was (display)
 *     fullRound       : boolean   a full-round action was taken (locks all three)
 *     fullRoundLabel  : string    what the full-round action was (display)
 *     defenseCount    : number    defensive actions taken this round
 *     activelyDodging : boolean   used the action to Actively Dodge → defenses
 *                                  cost no STA this round (Core p.152)
 *     reloadedThisTurn: boolean   a reload action was taken this turn; gates
 *                                  whether banked reload progress survives
 */

const fields = foundry.data.fields;

export function combatRoundSchema() {
    return {
        combatRound: new fields.SchemaField({
            movementUsed:    new fields.BooleanField({ initial: false }),
            movementMeters:  new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            actionUsed:      new fields.BooleanField({ initial: false }),
            actionLabel:     new fields.StringField({ initial: "" }),
            extraUsed:       new fields.BooleanField({ initial: false }),
            extraLabel:      new fields.StringField({ initial: "" }),
            fullRound:       new fields.BooleanField({ initial: false }),
            fullRoundLabel:  new fields.StringField({ initial: "" }),
            // Set when the full-round action used was Run — multiplies the
            // movement cap by 3 for the remainder of the turn (SPD×3) and
            // locks the normal/extra action slots via the `fullRound` gate.
            runUsed:         new fields.BooleanField({ initial: false }),
            defenseCount:    new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            activelyDodging: new fields.BooleanField({ initial: false }),
            // Set when at least one reload action was taken this turn. If a
            // turn passes with this still false, banked reloadProgress on the
            // actor's weapons is zeroed at the next turn start (Slow Reload
            // can't be accumulated across idle turns).
            reloadedThisTurn: new fields.BooleanField({ initial: false })
        })
    };
}
