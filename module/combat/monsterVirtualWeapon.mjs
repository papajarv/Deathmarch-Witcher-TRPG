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
    const skillKey    = attack?.skill || "melee";
    const name        = attack?.name || game.i18n.localize("WITCHER.Monster.Attacks");
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
            accuracy:    0,
            damage,
            damageTypes,
            qualities,
            qualityValues: qualityVals,
            reliability: { value: 0, max: 0 },
            effective: {
                damage,
                accuracy:     0,
                qualities,
                qualityValues: qualityVals,
                damageTypes
            }
        }
    };
}
