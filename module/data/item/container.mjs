/**
 * ContainerData — TypeDataModel for inventory containers (bags, satchels).
 *
 * Schema additions over base (from docs/compatibility.md §3 / container):
 *   content       : [uuid, …]                   contained items by UUID
 *   itemContent   : [{ name, img, weight, … }]  cached metadata (overhaul-ui)
 *   carry         : number                       capacity in kg
 *   storedWeight  : number                       current load (derived)
 *
 * `prepareDerivedData` will rebuild `storedWeight` by resolving `content`
 * UUIDs and summing their `calcWeight()`. Phase 5 fills it in; current
 * stub returns 0 to keep documents creating cleanly.
 *
 * Note: overhaul-ui's containerData.js historically had a `fromUuidSync`
 * crash on missing items (see project_witcher_kb memory). Our
 * implementation guards against missing references.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class ContainerData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            content:     new fields.ArrayField(new fields.StringField()),
            itemContent: new fields.ArrayField(new fields.ObjectField()),
            carry:       new fields.NumberField({ initial: 0, min: 0 }),
            storedWeight: new fields.NumberField({ initial: 0, min: 0 })
        };
    }

    prepareDerivedData() {
        /* Sum the weight of every item inside this container, so the actor's
         * getTotalWeight()/encumbrance calc picks up the load through the
         * container. Contained items carry isStored=true and return 0 from
         * CommonItemData#calcWeight to avoid double-counting; this is the
         * sole aggregation site. */
        let stored = 0;
        const contents = Array.isArray(this.content) ? this.content : [];
        /* Container refs can be either UUIDs (cross-actor gifts via the
         * socket handler, socketHook.mjs:1260) or bare item ids
         * (actor-embedded moves via moveItemToContainer). Try both. */
        const actor = this.parent?.parent;
        for (const ref of contents) {
            if (!ref) continue;
            let item = null;
            try { item = fromUuidSync(ref); } catch (_) { item = null; }
            if (!item && actor) {
                /* Fall back to THIS actor's items by bare id, then by the ref's
                 * trailing item id. A corpse is usually an UNLINKED token actor
                 * whose synthetic items keep the base item id but get a
                 * token-scoped uuid; the content ref still holds the base uuid
                 * (Actor.<base>.Item.<id>), so a uuid lookup misses and the
                 * container would report storedWeight 0. Matching the trailing
                 * id resolves it. Purely additive — only runs when the uuid
                 * lookup already failed. */
                const refId = (typeof ref === "string" && ref.includes(".")) ? ref.split(".").pop() : ref;
                item = actor.items?.get?.(ref) ?? actor.items?.get?.(refId) ?? null;
            }
            if (!item) continue;
            const q = Number(item.system?.quantity) || 0;
            const w = Number(item.system?.weight)   || 0;
            /* Nested containers: fold their own storedWeight so a satchel
             * inside a pack cascades. Foundry runs prepareDerivedData in a
             * document-order pass; when the nested container hasn't derived
             * yet on this tick, the next tick self-corrects. */
            const nested = item.type === "container"
                ? (Number(item.system?.storedWeight) || 0)
                : 0;
            stored += q * w + nested;
        }
        this.storedWeight = stored;
    }

    calcWeight() {
        /* Container's own weight + full stored weight — the ONLY entry
         * point for contained items into the encumbrance sum. */
        return this.weight * this.quantity + (Number(this.storedWeight) || 0);
    }
}
