/**
 * TemporaryItemImprovementData — ActiveEffect subtype that temporarily
 * modifies an item on the parent actor.
 *
 * v14 requires every ActiveEffect data model to honor the canonical
 * `changes` shape (key/type/value/phase/priority) — the verifier in
 * Game#initializeDocuments throws if any field is missing or mistyped.
 * Easiest correct path: extend `foundry.data.ActiveEffectTypeDataModel`
 * (which defines `changes` canonically) and append our custom fields.
 *
 * The effect carries the target item UUID and the field changes; when
 * activated, the changes apply to the item; when removed, they revert.
 * The actual apply/revert hook lives in WitcherActiveEffect (Phase 6).
 */

const fields = foundry.data.fields;

export class TemporaryItemImprovementData extends foundry.data.ActiveEffectTypeDataModel {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            targetItemUuid: new fields.StringField({ initial: "" }),
            durationRounds: new fields.NumberField({ initial: 0, integer: true, min: 0 })
        };
    }
}
