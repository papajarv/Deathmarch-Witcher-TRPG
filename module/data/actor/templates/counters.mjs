/**
 * Counters template — character-only mechanical counters.
 *
 * Schema shape (from docs/compatibility.md §2):
 *   adrenaline.value                            clamped to body.value
 *   deathSaves                                  integer
 *   improvementPoints                           integer (general advancement)
 *   magic.magicImprovementPoints                integer (magic-school advancement)
 *   attackStats.meleeBonus                      integer
 */

const fields = foundry.data.fields;

export function countersSchema() {
    return {
        adrenaline: new fields.SchemaField({
            value: new fields.NumberField({ initial: 0, integer: true, min: 0 })
        }),
        deathSaves: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
        improvementPoints: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
        magic: new fields.SchemaField({
            magicImprovementPoints: new fields.NumberField({ initial: 0, integer: true, min: 0 })
        }),
        attackStats: new fields.SchemaField({
            meleeBonus: new fields.NumberField({ initial: 0, integer: true })
        })
    };
}
