/**
 * consumeMixin — item method for consuming/using a stackable item.
 *
 * Composed onto WitcherItem. Exposes:
 *   item.consume()  — decrement quantity (or `time` charges if present).
 *
 * RAW Core p.87: alchemical items are single-use unless noted. Multi-dose
 * items just bump quantity.
 *
 * When the food & drink homebrew is enabled, `mechanics/foodAndDrink.onConsume`
 * gets first refusal: it posts the food item's `taste` to chat, restores
 * satiety, ticks per-portion charges on food items, and rolls the Endurance
 * check for alcoholic items. If it ticks a charge it returns `true` so we
 * skip the default quantity decrement (the charge counter owns consumption).
 */

import { onConsume as foodAndDrinkConsume } from "../../mechanics/foodAndDrink.mjs";

export const consumeMixin = (Base) => class extends Base {

    async consume() {
        const sys = this.system;

        // Homebrew food/drink (self-gated on the toggle) — taste, satiety,
        // charges, alcohol roll.
        const handled = await foodAndDrinkConsume(this);
        if (handled) return;

        // Charge-based consumable (legacy `time` field still on some items)
        if (Number.isFinite(sys.time) && sys.time > 0) {
            const remaining = sys.time - 1;
            if (remaining > 0) {
                return this.update({ "system.time": remaining });
            }
            const newQty = (sys.quantity ?? 1) - 1;
            if (newQty <= 0) return this.delete();
            return this.update({ "system.quantity": newQty, "system.time": 1 });
        }

        // Plain stackable
        const qty = sys.quantity ?? 1;
        if (qty <= 1) return this.delete();
        return this.update({ "system.quantity": qty - 1 });
    }
};
