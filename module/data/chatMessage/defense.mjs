/**
 * DefenseMessageData — typed chat card for defense rolls.
 *
 * Phase 3: schema scaffold.
 */

const fields = foundry.data.fields;

export class DefenseMessageData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            defenderUuid:     new fields.StringField({ initial: "" }),
            attackMessageId:  new fields.StringField({ initial: "" }),
            defenseRoll:      new fields.ObjectField({ initial: {} }),
            success:          new fields.BooleanField({ initial: false })
        };
    }
}
