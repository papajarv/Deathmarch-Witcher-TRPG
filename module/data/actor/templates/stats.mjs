/**
 * Stats template — the seven core attributes plus toxicity, luck, speed.
 *
 * Convention (post-redesign):
 *   stats.X.value is the SOURCE-of-truth field. The player edits it on
 *   the sheet — this is where IP gets allocated. ActiveEffects (Freeze,
 *   Drunk, etc.) target the same path so the PREPARED `actor.system.
 *   stats.X.value` is the modified/current value after debuffs. The
 *   sheet exposes both:
 *     - editable input → bound to SOURCE  (`source.stats.X.value`)
 *     - readonly display → bound to PREPARED (`system.stats.X.value`)
 *
 * Schema shape:
 *   stats.{int,ref,dex,body,emp,will,cra}: { value }            integer
 *   stats.toxicity: { value, max }      max default 100 (capacity cap)
 *   stats.luck:     { value, max }      max = total luck pool
 *   stats.spd:      { value }
 *
 * Note: prior convention had `.max` on every core attribute. It was
 * unused inconsistently (BODY/WILL derived stats read `.max`, SPD read
 * `.value`, skill rolls read `.value`). Dropping `.max` here removes
 * the ambiguity. toxicity/luck keep `.max` because their max is a real
 * capacity number, not a duplicate of the source.
 */

import { STATS } from "../../../setup/config.mjs";

const fields = foundry.data.fields;

/* Per RAW Core p.47, character stat values are 1-10 at the source (mutations
 * and AE-driven modifiers can push the prepared `system.stats.X.value` above
 * 10, but the player-edited source stays clamped). NumberField's `_cleanType`
 * clamps to {min,max} during validation, so out-of-range writes round to 1 or
 * 30 rather than rejecting.
 *
 * The 1-10 RAW cap is now a per-stat `.cap` field (see below) that AEs can
 * modify — e.g., a mutation raising REF cap to 12. The schema-level clamp
 * here is a hard sanity ceiling (30) higher than any AE stack should
 * plausibly reach; the actual user-facing cap is enforced by the sheet UI
 * (data-max on the +1 button) and honored by the adjustValue action.
 *
 * Monsters pass `statMax: null` — their printed stat blocks routinely
 * exceed 10 (e.g. Fiend BODY 15) and must not clamp. */
const statValue = (statMax = 30) => new fields.NumberField({
    initial: 1, integer: true, min: 1, ...(statMax == null ? {} : { max: statMax })
});

/* A core stat: the player-allocated `value` (schema-clamped 1-30 for
 * characters — the actual per-stat ceiling comes from `.cap` below;
 * uncapped for monsters), an UNBOUNDED `modifier` (AE-target for buffs
 * / debuffs — folded into value in prepareDerivedData), and an optional
 * per-stat `cap` field (characters only) that AEs can also target to
 * raise or lower the ceiling on the base value. */
const valueOnly = (statMax = 30, { includeCap = true } = {}) => new fields.SchemaField({
    value:    statValue(statMax),
    modifier: new fields.NumberField({ initial: 0, integer: true }),
    /* Only characters carry a per-stat cap. Monsters use their printed
     * bestiary value freely — no cap concept, no field. */
    ...(includeCap ? {
        cap: new fields.NumberField({ initial: 10, integer: true, min: 1 })
    } : {})
});

/* Toxicity uses a pool — value 0..100, max defaults 100. Not clamped to
 * the 1-10 stat range. */
const toxicityField = () => new fields.SchemaField({
    value: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
    max:   new fields.NumberField({ initial: 100, integer: true, min: 0 })
});

/* Luck — `.max` is the IP-allocated cap (1-10 per RAW), `.value` is the
 * current pool which depletes when spent (so it can hit 0). */
const luckField = () => new fields.SchemaField({
    value: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
    max:   new fields.NumberField({ initial: 1, integer: true, min: 0, max: 10 })
});

export function statsSchema({ statMax = 30, includeCap = true } = {}) {
    const stats = {};
    for (const key of STATS) {
        stats[key] = valueOnly(statMax, { includeCap });
    }
    stats.toxicity = toxicityField();
    stats.luck     = luckField();
    stats.spd      = valueOnly(statMax, { includeCap });
    return { stats: new fields.SchemaField(stats) };
}
