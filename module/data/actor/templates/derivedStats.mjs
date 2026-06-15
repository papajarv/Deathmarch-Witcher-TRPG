/**
 * Derived stats template — RAW Witcher TRPG (Core p.48 stat-block + p.176
 * verbal combat). HP and STA are pools (current/max); the max auto-derives
 * in prepareDerivedData. Stun/wound/REC/ENC/Run/Leap and Resolve auto-
 * derive as single numbers. Shield and Vigor are PLAYER-SET single numbers
 * — per user spec they are static (not consumable pools driven by formula).
 *
 * Schema shape:
 *   derivedStats:
 *     hp          : { value, max, temp }  max auto-derived (BODY+WILL)/2 × 5;
 *                                          temp = non-regenerable damage buffer
 *     sta         : { value, max }   max auto-derived (BODY+WILL)/2 × 5
 *     resolve     : number           (WILL+INT)/2 × 5  (verbal combat HP)
 *     stun        : number           clamp((BODY+WILL)/2, 1, 10)
 *     stunUnmodified : number        clamp((BODY+WILL)/2, 1, 10) from the
 *                                     PRE death/wound-penalty stats — death
 *                                     saves roll against this so a dying
 *                                     character isn't double-penalized
 *     rec         : number           (BODY+WILL)/2 — from BASE stats; the
 *                                     wound penalty does NOT shrink it, only
 *                                     Death State (×1/3, p.158) does
 *     woundThreshold : number        (BODY+WILL)/2
 *     enc         : number           BODY × 10
 *     run         : number           SPD × 3
 *     leap        : number           Run / 5
 *     meleeBonus  : number           Body table p.48: ceil((BODY-6)/2)×2
 *     punch       : string           `1d6+meleeBonus` (or `1d6-X`)
 *     kick        : string           `1d6+meleeBonus+4`
 *     shield      : number           player-set (Quen pool counter)
 *     vigor       : number           player-set (per-round ceiling)
 *     focus.max   : number           ⌊(WILL+INT)/2⌋ × 3  (Journal p.145)
 *     focus.value : number           player-set (drained in investigations)
 *     damageBonus : number           flat bonus added to weapon damage rolls
 *                                     (effect target; not auto-derived)
 *
 * Health state (`healthState`) is attached on `actor.system` in
 * prepareDerivedData — `{ wounded, dying, woundThreshold }`. Not in
 * schema; recomputed each prepare cycle. Templates read it to flag
 * the sheet when HP < threshold or ≤ 0.
 */

const fields = foundry.data.fields;

const pool = () => new fields.SchemaField({
    value: new fields.NumberField({ initial: 0, integer: true }),
    max:   new fields.NumberField({ initial: 0, integer: true })
});

/* HP additionally carries `temp` — a non-regenerable buffer that absorbs
 * damage before real HP. It is never touched by healing or by the auto-
 * derived max; damage drains it first (see drainHp in setup/config.mjs). */
const hpPool = () => new fields.SchemaField({
    value: new fields.NumberField({ initial: 0, integer: true }),
    max:   new fields.NumberField({ initial: 0, integer: true }),
    temp:  new fields.NumberField({ initial: 0, integer: true, min: 0 })
});

const num = () => new fields.NumberField({ initial: 0, integer: true });
const str = (initial = "") => new fields.StringField({ initial });

export function derivedStatsSchema() {
    return {
        derivedStats: new fields.SchemaField({
            hp:             hpPool(),
            sta:            pool(),
            resolve:        num(),
            stun:           num(),
            stunUnmodified: num(),
            rec:            num(),
            woundThreshold: num(),
            enc:            num(),
            run:            num(),
            leap:           num(),
            meleeBonus:     num(),
            punch:          str("1d6"),
            kick:           str("1d6"),
            shield:         num(),
            vigor:          num(),
            focus:          pool(),   // Investigation mental pool (A Witcher's
                                      // Journal p.145): max = ⌊(WILL+INT)/2⌋×3,
                                      // value drained by failed Evidence checks

            damageBonus:    num(),
            aimMod:         num()   // player/AE-set: shifts EVERY called-shot
                                    // location penalty (+ = easier to aim)
        })
    };
}
