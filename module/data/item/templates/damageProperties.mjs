/**
 * Damage properties template — RAW weapon fields (Core p.72-77).
 *
 * Schema shape:
 *   damage             : string    roll formula, e.g. "2d6+2"
 *   damageTypes        : string[]  multi: slashing, piercing, bludgeoning, elemental
 *                                  (a flaming sword can be slashing + elemental)
 *   range              : number    meters (ranged weapons; 0 for melee)
 *   accuracy           : number    WA — attack-roll modifier (p.72)
 *   reliability        : number    blocks before breaking (p.72)
 *   requiresAmmo       : boolean   weapon fires loaded ammunition (bows/crossbows)
 *   ammoType           : string    ammo class fired: arrow (bows) / bolt (crossbows)
 *   reloadActions      : number    actions to reload a chamber-load (Slow Reload = 1)
 *   loaded             : schema    chamber state {uuid,name,img,count,capacity}
 *   effects            : HTML      free-form on-hit text (kept for narrative notes)
 *   qualities          : string[]  KEY references into CONFIG.WITCHER.weapon.qualities
 *                                  (Balanced, Armor-Piercing, etc.). Single source of
 *                                  truth for label + description is the config catalog.
 *   availability       : enum      everywhere / common / poor / rare (p.73)
 *   conceal            : enum      L / S / T / N/A (p.73 — printed weapon table)
 *   weaponEnhancement  : number    slots for runes / glyphs
 *   skillKey           : string    skill used to attack (swordsmanship, archery, …);
 *                                  filtered against WEAPON_SKILL_KEYS in the UI
 */

const fields = foundry.data.fields;

export function damagePropertiesSchema() {
    return {
        damage:             new fields.StringField({ initial: "" }),
        damageTypes:        new fields.ArrayField(new fields.StringField(), { initial: [] }),
        // Free-form so it can hold a derived expression like "BODYx4"
        // as well as a plain number of metres. A migration in
        // WeaponData.migrateData converts legacy numeric ranges to string.
        range:              new fields.StringField({ initial: "" }),
        accuracy:           new fields.NumberField({ initial: 0, integer: true }),
        /* Reliability is a pool — current/max. Player tracks blocks
         * remaining (`value`) vs. the original count (`max`). RAW Core
         * p.72: "the number of times the weapon can be used to block
         * before it breaks". A migration in WeaponData.migrateData
         * converts legacy `reliability: 10` (single number) into
         * `{ value: 10, max: 10 }`. */
        reliability:        new fields.SchemaField({
            value: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            max:   new fields.NumberField({ initial: 0, integer: true, min: 0 })
        }),
        // Bows / crossbows: damage type is dictated by the loaded
        // ammunition, so the weapon itself declares none. When true the
        // sheet hides the weapon's own damage-type picker.
        requiresAmmo:       new fields.BooleanField({ initial: false }),
        // Which ammo class this weapon fires: "arrow" (bows) or "bolt"
        // (crossbows). Only ammo whose ammoType matches is loadable. Only
        // meaningful when requiresAmmo. See CONFIG.WITCHER.weapon.ammoTypes.
        ammoType:           new fields.StringField({ initial: "arrow" }),
        // Actions needed to reload one chamber-load. RAW "Slow Reload"
        // (all crossbows, Core weapon-effects sidebar) = 1; bows = 0
        // (nock-and-loose — ammo is drawn per shot, no reload step). Heavier
        // homebrew arms can require 2+. Only meaningful when requiresAmmo.
        reloadActions:      new fields.NumberField({ initial: 0, integer: true, min: 0 }),
        // Chamber state: the ammo currently loaded and ready to fire. Empty
        // `uuid` = unloaded. `count` rounds are ready now; `capacity` is a
        // full load (Rate of Fire; default 1). A reloadActions>=1 weapon
        // fires from here and is BLOCKED when empty until reloaded; a
        // reloadActions==0 weapon ignores this and draws straight from ammo
        // per shot. The loaded ammo must come from an equipped container.
        loaded:             new fields.SchemaField({
            uuid:     new fields.StringField({ initial: "" }),
            name:     new fields.StringField({ initial: "" }),
            img:      new fields.StringField({ initial: "" }),
            count:    new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            capacity: new fields.NumberField({ initial: 1, integer: true, min: 0 }),
            // Reload actions banked toward chambering a round. A reloadActions>1
            // weapon fills the chamber only when this reaches reloadActions; it
            // resets to 0 if the wielder lets a turn pass without reloading
            // (combatRoundMixin.resetCombatRound).
            reloadProgress: new fields.NumberField({ initial: 0, integer: true, min: 0 })
        }),
        // Area-of-effect radius in metres for THROWN weapons (e.g. bombs,
        // Core p.88). Only meaningful when weaponType === "thrown".
        radius:             new fields.NumberField({ initial: 0, min: 0 }),
        effects:            new fields.HTMLField({ initial: "" }),
        qualities:          new fields.ArrayField(new fields.StringField(), { initial: [] }),
        // Free-form per-quality parameter map: { silver: "2d6",
        // bleeding: "25", focus: "3", stun: "-2" }. Only meaningful
        // when the matching quality key is present in `qualities`.
        // ObjectField rather than typed-schema because the parameter
        // shape varies per quality (text vs percent vs integer).
        qualityValues:      new fields.ObjectField({ initial: {} }),
        availability:       new fields.StringField({ initial: "common" }),
        conceal:            new fields.StringField({ initial: "N/A" }),
        weaponEnhancement:  new fields.NumberField({ initial: 0, integer: true, min: 0 }),
        // Socketed enhancement items (runes / weapon mods). Each entry is a
        // live UUID reference plus a cached name/img for display when the
        // referenced item can't be resolved. The weapon's effective stats
        // are recomputed from these in WeaponData.prepareDerivedData; the
        // base fields above are never mutated, so detaching reverts cleanly.
        // Slot count is capped by `weaponEnhancement` in the attach UI.
        appliedEnhancements: new fields.ArrayField(new fields.SchemaField({
            uuid: new fields.StringField({ initial: "" }),
            name: new fields.StringField({ initial: "" }),
            img:  new fields.StringField({ initial: "" })
        }), { initial: [] }),
        skillKey:           new fields.StringField({ initial: "" }),
        // Skill rolled when a THROWN weapon is used in melee mode (the attack
        // card offers a melee/thrown toggle). `skillKey` is the thrown skill
        // (e.g. athletics); this is the in-hand skill (e.g. smallblades). Empty
        // = no melee mode offered. Only meaningful when weaponType === "thrown".
        meleeSkillKey:      new fields.StringField({ initial: "" }),
        // Attack-style class — drives template visibility and the
        // melee-bonus damage rule (Core p.48: melee bonus is added to
        // melee and thrown attacks, not to ranged).
        weaponType:         new fields.StringField({ initial: "melee" }),
        // Per-weapon override of the default melee-bonus behavior.
        // Defaults true so most melee/thrown items just work; flip false
        // on the rare gimmick weapon that doesn't benefit (Core sidebar
        // examples). For ranged weapons this is ignored.
        appliesMeleeBonus:  new fields.BooleanField({ initial: true })
    };
}

/* Migration: the old schema had a singular `damageType` StringField. Old
 * data carries `system.damageType: "slashing"`; new schema expects
 * `system.damageTypes: ["slashing"]`. Run this in the WeaponData class's
 * static `migrateData(data)` so old saves load cleanly. */
export function migrateDamageType(data) {
    if (typeof data.damageType === "string") {
        data.damageTypes = data.damageType ? [data.damageType] : [];
        delete data.damageType;
    }
    return data;
}
