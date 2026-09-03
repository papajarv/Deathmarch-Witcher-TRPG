/**
 * Base item template — fields shared by ~every item type.
 *
 * Schema shape (from docs/compatibility.md §3):
 *   description : HTML
 *   weight      : number  (kg per unit)
 *   cost        : number  (crowns per unit; defaults to 0)
 *   quantity    : number  (stack size)
 *   equipped    : boolean (in-hand / worn)
 *   isStored    : boolean (inside a container)
 *   encumb      : number  (per-unit encumbrance override)
 *   class       : string  (free-form classification, e.g. magic group)
 *
 * Method (added on the data model class, not the schema):
 *   calcWeight() → total weight contribution (quantity × weight unless
 *                  containers stop the recursion).
 *
 * Some item types omit some of these. They spread `baseItemSchema()` and
 * then redact / ignore unused fields rather than defining a stripped
 * version. Keeps the contract uniform.
 */

const fields = foundry.data.fields;

export function baseItemSchema() {
    return {
        description: new fields.HTMLField({ initial: "" }),
        weight:      new fields.NumberField({ initial: 0, min: 0 }),
        cost:        new fields.NumberField({ initial: 0, min: 0 }),
        quantity:    new fields.NumberField({ initial: 1, integer: true, min: 0 }),
        equipped:    new fields.BooleanField({ initial: false }),
        isStored:    new fields.BooleanField({ initial: false }),
        encumb:      new fields.NumberField({ initial: 0 }),
        class:       new fields.StringField({ initial: "" }),
        // Free-text provenance: which book / supplement the item is from
        // (e.g. "Core p.142", "A Tome of Chaos"). Surfaced on every item
        // sheet via the shared source-field partial.
        source:      new fields.StringField({ initial: "" }),
        // When true, "using" the item (hotbar / right-click) spends one dose
        // and applies its effects to the holder. Field lives on every item
        // (schema is never conditional) but the toggle UI is only surfaced
        // for the item types that support it (see WitcherAlchemicalSheet).
        consumable:  new fields.BooleanField({ initial: false }),
        // Per-item rarity-flair OVERRIDE. A hex colour ("#rrggbb") that replaces
        // the availability-derived flair wash on this item's inventory slot,
        // sheet display view and merchant card. Empty "" = no override (OFF by
        // default) → fall back to the availability tier colour. A plain string
        // (not ColorField, whose null-initial coerces to "#000000" and reads as
        // an active black override). Editable via flair-override.hbs.
        flairColor:  new fields.StringField({ required: false, blank: true, nullable: true, initial: "" })
    };
}
