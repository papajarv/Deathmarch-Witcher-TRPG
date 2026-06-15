/**
 * DamageMessageData — typed chat card for damage application.
 *
 * Phase 3: schema scaffold.
 */

const fields = foundry.data.fields;

export class DamageMessageData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            targetUuid:  new fields.StringField({ initial: "" }),
            damageRoll:  new fields.ObjectField({ initial: {} }),
            damageType:  new fields.StringField({ initial: "" }),
            location:    new fields.StringField({ initial: "" }),
            appliedDamage: new fields.NumberField({ initial: 0, integer: true })
        };
    }
}
