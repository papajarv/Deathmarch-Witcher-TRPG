/**
 * containerCapable — mixin schema + helpers that let a NON-container item
 * (armor with pockets today; saddles / saddlebags in Phase 2) hold items
 * exactly like a `container`.
 *
 * The whole container pipeline in `chrome/lib/container.js` (slot gating,
 * capacity, quick-draw / free-draw / quick-use, inventory surfacing) reads
 * generic `system.content` / `system.carry` / `system.storedWeight` off the
 * HOST item and the `flags.<sys>.containerCfg` blob — none of it is specific
 * to the `container` type. So mixing these fields in is enough for a host to
 * behave as a container.
 *
 * `pockets` gates whether the host acts as a container at all — an armor
 * piece is only a container once the owner enables pockets on it.
 */

const fields = foundry.data.fields;

export function containerCapableSchema() {
  return {
    pockets:      new fields.BooleanField({ initial: false }),
    content:      new fields.ArrayField(new fields.StringField()),
    itemContent:  new fields.ArrayField(new fields.ObjectField()),
    carry:        new fields.NumberField({ initial: 0, min: 0 }),
    storedWeight: new fields.NumberField({ initial: 0, min: 0 }),
  };
}

/** Recompute `storedWeight` on a container-capable host. Verbatim mirror of
 *  ContainerData#prepareDerivedData (contained items carry isStored=true and
 *  return 0 from their own calcWeight, so this is the sole aggregation site
 *  for the host's load). Call from the host model's prepareDerivedData. */
export function deriveContainerCapableStoredWeight(model) {
  let stored = 0;
  const contents = Array.isArray(model?.content) ? model.content : [];
  const actor = model?.parent?.parent;
  for (const ref of contents) {
    if (!ref) continue;
    let item = null;
    try { item = fromUuidSync(ref); } catch (_) { item = null; }
    if (!item && actor) item = actor.items?.get?.(ref) ?? null;
    if (!item) continue;
    const q = Number(item.system?.quantity) || 0;
    const w = Number(item.system?.weight)   || 0;
    const nested = item.type === "container" ? (Number(item.system?.storedWeight) || 0) : 0;
    stored += q * w + nested;
  }
  model.storedWeight = stored;
}
