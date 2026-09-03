/**
 * AttackMessageData — typed chat card for attack rolls.
 *
 * Phase 3: schema scaffold. Phase 6 fills in the actual fields once the
 * combat flow is ported.
 */

const fields = foundry.data.fields;

export class AttackMessageData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            attackerUuid: new fields.StringField({ initial: "" }),
            targetUuid:   new fields.StringField({ initial: "" }),
            weaponUuid:   new fields.StringField({ initial: "" }),
            hitLocation:  new fields.StringField({ initial: "" }),
            attackRoll:   new fields.ObjectField({ initial: {} }),
            isCrit:       new fields.BooleanField({ initial: false }),
            isMiss:       new fields.BooleanField({ initial: false }),
            vcDamage:     new fields.StringField({ initial: "" })   // verbal combat damage formula
        };
    }
}
