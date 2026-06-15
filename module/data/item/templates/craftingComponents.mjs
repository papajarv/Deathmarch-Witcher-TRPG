/**
 * Crafting/alchemy components template — for diagrams.
 *
 * Schema shape (from docs/compatibility.md §3 / diagrams):
 *   alchemyComponents   : { [substanceKey]: number }   substance → qty map
 *   craftingComponents  : [{ uuid?, name, quantity }]
 *
 * Diagrams use one or the other depending on whether the formula is
 * alchemical (potions/oils/decoctions/bombs) or mundane (weapons/armor).
 */

const fields = foundry.data.fields;

export function craftingComponentsSchema() {
    return {
        alchemyComponents: new fields.ObjectField({ initial: {} }),
        craftingComponents: new fields.ArrayField(new fields.SchemaField({
            uuid:     new fields.StringField({ initial: "", required: false }),
            name:     new fields.StringField({ initial: "" }),
            quantity: new fields.NumberField({ initial: 1, integer: true, min: 0 })
        }))
    };
}
