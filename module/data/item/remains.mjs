/**
 * RemainsData — first-class Remains (monster carcass) item.
 *
 * A monster's body produced by the defeat hook (chrome/monster-remains.js).
 * Carries a back-pointer UUID to the source monster used by the harvest /
 * extract / dissect actions to read traits, mutagens, and bestiary metadata.
 *
 * Previously a subtype on `valuable`; promoted to its own item type so the
 * carcass workflow no longer depends on `valuable + system.type === "remains"`.
 *
 * Charge bookkeeping (current charges, base weight, harvested / mutagenExtracted
 * latches) lives on flags under the system id because the values were on flags
 * in the chrome's pre-port code and the harvest / dissect helpers keep reading
 * them via flag accessors — promoting to schema fields here would force a
 * parallel touch of every harvest/dissect call site. Flags work fine.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class RemainsData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),

            // UUID of the source monster — preferred compendium source first,
            // then world actor uuid as fallback (see createRemainsForMonster).
            // Consumers (extract / dissect / context menu) read this first;
            // the legacy `flags.<system>.monsterUuid` is only kept as a read
            // fallback for items created before the system field existed.
            monsterUuid: new fields.StringField({ initial: "" })
        };
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
