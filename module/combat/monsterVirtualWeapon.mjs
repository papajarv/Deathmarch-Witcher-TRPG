/**
 * Build a weapon-shaped virtual object from a monster's inline attack
 * (system.combat.attacks[i]) so that the unified weaponAttack pipeline
 * can fire on it the same way it fires on PC weapons.
 *
 * Shared by the monster sheet (its inline attack-row buttons) and the
 * chrome monster dock (its bottom-bar attack buttons). Lifted out of
 * the sheet so the dock doesn't need to instantiate a sheet to roll.
 */

/**
 * Pre-check: can this actor afford the attack's staminaCost? Called by
 * both the dock and the monster sheet BEFORE opening the attack dialog
 * so the GM sees a clear "not enough STA" warning instead of a silent
 * dialog cancel. Returns true when the attack can proceed (STA >= cost
 * OR cost is 0). Zero-cost attacks always pass. */
export function monsterAttackHasStamina(actor, attack) {
    const cost = Math.max(0, Number(attack?.staminaCost) || 0);
    if (cost <= 0) return true;
    const cur = Number(actor?.system?.derivedStats?.sta?.value) || 0;
    return cur >= cost;
}

/**
 * Post-commit STA drain — called AFTER `actor.weaponAttack(vw)` returns
 * non-null (i.e. an attack roll actually happened). Uses the actor's
 * `spendStamina` helper so the satiety/foodAndDrink hook + stunned-at-0
 * downstream fires the same way it does for PC combat spends. No-op for
 * zero-cost attacks. Reason "monster attack" surfaces in the STA-spend
 * satiety chat line. */
export async function chargeMonsterAttackStamina(actor, attack) {
    const cost = Math.max(0, Number(attack?.staminaCost) || 0);
    if (!cost || !actor?.spendStamina) return;
    try { await actor.spendStamina(cost, { reason: "monster attack" }); }
    catch (err) { console.warn("witcher-ttrpg-death-march | monster attack STA drain failed", err); }
}

export function buildMonsterVirtualWeapon(actor, attack, index) {
    const damage      = String(attack?.damage ?? "").trim();
    const qualities   = Array.isArray(attack?.qualities) ? attack.qualities : [];
    const qualityVals = (attack?.qualityValues && typeof attack.qualityValues === "object")
        ? attack.qualityValues : {};
    const damageTypes = Array.isArray(attack?.damageTypes) ? attack.damageTypes : [];
    const name        = attack?.name || game.i18n.localize("WITCHER.Monster.Attacks");

    /* Skill-derived to-hit: roll 1d10 + governing stat + the chosen `skill`'s
     * rank + WA. Setting the virtual weapon's `skillKey` lets the shared
     * weaponAttack pipeline resolve stat + skill against the monster's CURRENT
     * (wound-halved) stats automatically — no manual wound-loss math. The
     * `weaponAccuracy` (WA) rides in `accuracy`, exactly like a PC weapon. */
    const skillKey = attack?.skill || "melee";
    const accuracy = Number(attack?.weaponAccuracy) || 0;   // WA

    /* Melee vs ranged branching. Monster attack rows can be flagged
     * `weaponType: "ranged"` (with `rangeMeters`) to route them into
     * weaponAttackMixin's ranged path — distance penalties, cover
     * math, no reach checks. Default falls back to melee for legacy
     * data and natural weapons. `range` on the virtual weapon mirrors
     * the item-weapon schema field so the ranged pipeline finds it
     * where it expects. */
    const weaponType = attack?.weaponType === "ranged" ? "ranged" : "melee";
    const rangeMeters = Math.max(0, Number(attack?.rangeMeters) || 0);

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
            weaponType,
            range:       rangeMeters,
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
