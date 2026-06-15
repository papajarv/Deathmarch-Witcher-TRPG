/**
 * consumeMixin — item method for consuming/using a stackable item.
 *
 * Composed onto WitcherItem. Exposes:
 *   item.consume()  — decrement quantity (or `time` charges if present).
 *
 * RAW Core p.87: alchemical items are single-use unless noted. Multi-dose
 * items just bump quantity. The witcher-food-and-drink charge / alcohol
 * delegation was removed when we switched to RAW-only mode.
 */

export const consumeMixin = (Base) => class extends Base {

    async consume() {
        const sys = this.system;

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
