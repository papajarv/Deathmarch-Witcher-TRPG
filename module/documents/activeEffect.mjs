/**
 * WitcherActiveEffect — base ActiveEffect document.
 *
 * Hosts the unified action model. The friendly AE editor stores a single list
 * of action rows at flags.<systemId>.actions[]; each row's `type` selects a
 * behavior. The *modifier* actions are compiled here into native v14 change
 * objects (system.changes) so Foundry's own change-application engine applies
 * them — we don't reimplement stat math. Event actions (heal/damage) and gate
 * actions (suppress) are read by their own backends (the tick engine and
 * character.prepareDerivedData respectively) and are ignored here.
 */

import { compileActionsToChanges } from "../setup/config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

export class WitcherActiveEffect extends ActiveEffect {

    /** Inject compiled modifier-action changes into system.changes. We
     *  rebuild from a fresh clone of the persisted source changes (never the
     *  live array) so the injected entries can't accumulate across repeated
     *  prepareData cycles, then stamp the same `effect` / `priority`
     *  normalization the core prepareBaseData applies to source changes. */
    prepareBaseData() {
        super.prepareBaseData();
        const compiled = compileActionsToChanges(this.flags?.[SYSTEM_ID]?.actions);
        if (!compiled.length || !this.system) return;

        const base = foundry.utils.deepClone(this.system._source?.changes ?? []);
        const all  = [...base, ...compiled];
        for (const c of all) {
            c.effect = this;
            c.priority ??= ActiveEffect.CHANGE_TYPES?.[c.type]?.priority ?? 0;
        }
        this.system.changes = all;
    }

    /** Critical-wound effects are authored per state (flag `woundState`) and
     *  only apply while the wound is in that state — so the bearer's penalty
     *  swaps automatically as the wound is stabilized / treated. The flag is a
     *  live getter read, so a state change re-evaluates without any sync step;
     *  Foundry re-runs the bearer's effect application on the item update. */
    get isSuppressed() {
        if (super.isSuppressed) return true;
        const item = this.parent;
        if (item?.type === "criticalWound") {
            const tag = this.getFlag(SYSTEM_ID, "woundState") || "unstabilized";
            if (tag !== (item.system?.state || "unstabilized")) return true;
        }
        return false;
    }
}
