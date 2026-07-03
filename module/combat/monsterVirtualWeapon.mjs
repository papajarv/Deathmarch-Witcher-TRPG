/**
 * Build a weapon-shaped virtual object from a monster's inline attack
 * (system.combat.attacks[i]) so that the unified weaponAttack pipeline
 * can fire on it the same way it fires on PC weapons.
 *
 * Shared by the monster sheet (its inline attack-row buttons) and the
 * chrome monster dock (its bottom-bar attack buttons). Lifted out of
 * the sheet so the dock doesn't need to instantiate a sheet to roll.
 */
export function buildMonsterVirtualWeapon(actor, attack, index) {
    const damage      = String(attack?.damage ?? "").trim();
    const qualities   = Array.isArray(attack?.qualities) ? attack.qualities : [];
    const qualityVals = (attack?.qualityValues && typeof attack.qualityValues === "object")
        ? attack.qualityValues : {};
    const damageTypes = Array.isArray(attack?.damageTypes) ? attack.damageTypes : [];
    const name        = attack?.name || game.i18n.localize("WITCHER.Monster.Attacks");

    /* Monster attacks ALWAYS use the printed flat bonus (`Attack +X` per
     * modern Witcher stat blocks). Skill lookup is bypassed; the bonus
     * goes into accuracy. Wound-threshold scaling: monster.mjs snapshots
     * the unmodified REF onto `derivedStats.refUnmodified` BEFORE the
     * wound/dying halving runs, so we compute the penalty as the
     * difference between the snapshot and the current (halved/thirded)
     * value. Falls back to `_source.stats.ref.value` if the snapshot is
     * missing (pre-migration monsters). The `skill` field on the inline
     * attack is kept in schema for back-compat reads only. */
    const flatBonus  = Number(attack?.flatBonus) || 0;
    /* Read order: derivedStats.refUnmodified (snapshot taken before wound
     * halving in monster.mjs) → _source fallback for pre-migration data
     * → 0 final. Use a chained `||` over `??` because `Number(undefined)`
     * is NaN, not undefined; the falsy chain picks the first usable number. */
    const refSource  = (Number(actor?.system?.derivedStats?.refUnmodified) || 0)
                    || (Number(actor?.system?._source?.stats?.ref?.value) || 0);
    const refCurrent = Number(actor?.system?.stats?.ref?.value) || 0;
    const woundLoss  = Math.max(0, refSource - refCurrent);
    const accuracy   = flatBonus - woundLoss;
    const skillKey   = "";

    return {
        type:  "weapon",
        name,
        img:   actor?.img || "icons/svg/sword.svg",
        id:    `mva-${index}`,
        uuid:  `${actor?.uuid}.MonsterAttack.${index}`,
        actor,
        usesAmmo:        false,
        hasChamber:      false,
        isLoaded:        false,
        reloadActions:   0,
        getEligibleAmmo: () => [],
        getSelectedAmmo: () => null,
        selectAmmo:      async () => {},
        spendShot:       async () => {},
        system: {
            equipped:    true,
            skillKey,
            weaponType:  "melee",
            accuracy,
            damage,
            damageTypes,
            qualities,
            qualityValues: qualityVals,
            reliability: { value: 0, max: 0 },
            effective: {
                damage,
                accuracy,
                qualities,
                qualityValues: qualityVals,
                damageTypes
            }
        }
    };
}
