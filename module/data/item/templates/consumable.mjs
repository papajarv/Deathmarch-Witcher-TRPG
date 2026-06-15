/**
 * Consumable template — for potions, oils, decoctions, foods, drinks.
 *
 * Schema shape:
 *   time / charges  : number  (uses remaining; "time" is the legacy field
 *                              name read at overhaul-ui inventory.js:3590)
 *   effect          : string  (effect description/name)
 *   consumeProperties : [...]  (declarative consume effects)
 *
 * The `time` field name is legacy — we keep it because docs/compatibility.md
 * says existing user data uses this name.
 */

const fields = foundry.data.fields;

export function consumableSchema() {
    return {
        time:   new fields.NumberField({ initial: 0, integer: true, min: 0 }),
        effect: new fields.StringField({ initial: "" }),
        consumeProperties: new fields.ArrayField(new fields.ObjectField())
    };
}
