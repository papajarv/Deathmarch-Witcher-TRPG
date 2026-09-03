import { t, tFormat } from "../../../chrome/lib/i18n.js";
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
            /* Combat Extended magazine model only (magazineReload subsystem,
             * capacity >= 2): whether the crossbow is COCKED — the top magazine
             * round drawn and ready to loose. Loading the magazine (rounds[])
             * and cocking (armed) are separate operations; firing needs armed.
             * A non-repeating crossbow drops to un-cocked after each shot; a
             * `repeating` one stays cocked while the magazine has rounds.
             * Ignored under RAW / capacity 1 (a loaded chamber is always ready). */
            armed:    new fields.BooleanField({ initial: false }),
            // Reload actions banked toward chambering a round. A reloadActions>1
            // weapon fills the chamber only when this reaches reloadActions; it
            // resets to 0 if the wielder lets a turn pass without reloading
            // (combatRoundMixin.resetCombatRound).
            reloadProgress: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            /* Coating snapshot for the chambered round. Set at reload
             * time from the source ammo's `system.appliedOil` — this
             * survives the ammo document being deleted (a coated 1-qty
             * stack is deleted on reload, since the round is now
             * physically in the chamber). Read at attack-roll time to
             * stamp the oil bonus onto the damage button. Cleared when
             * the chamber empties. */
            appliedOil: new fields.SchemaField({
                name:           new fields.StringField({ initial: "", blank: true }),
                oilTarget:      new fields.StringField({ initial: "", blank: true }),
                oilBonusDamage: new fields.NumberField({ initial: 0, integer: true, min: 0 })
            }),
            /* Snapshot of the source ammo document at reload time. Used
             * by unload() to reconstitute a coated 1-qty stack when the
             * original ammo document was deleted on reload (a coated
             * bolt physically leaves inventory when it enters the pipe,
             * but pulling it back out should put it back in the quiver
             * with its coating intact). Empty for uncoated reloads
             * where the source stack survives — unload just adds the
             * count back to the existing document in that case. */
            sourceData: new fields.ObjectField({ initial: {} }),
            /* Ordered chamber STACK — one entry per physically chambered round,
             * each carrying its OWN type + coating. FILO: index 0 = first
             * loaded (last to fire); the LAST element = last loaded (NEXT to
             * fire). `count` and the scalar `name/img/uuid/appliedOil` above
             * mirror the next-to-fire round (the top of this stack) so the many
             * places that read those stay correct. Legacy docs (count>0, empty
             * rounds) are lazily expanded from the scalars by
             * reloadMixin.getChamberRounds(). */
            rounds: new fields.ArrayField(new fields.SchemaField({
                uuid: new fields.StringField({ initial: "" }),
                name: new fields.StringField({ initial: "" }),
                img:  new fields.StringField({ initial: "" }),
                appliedOil: new fields.SchemaField({
                    name:           new fields.StringField({ initial: "", blank: true }),
                    oilTarget:      new fields.StringField({ initial: "", blank: true }),
                    oilBonusDamage: new fields.NumberField({ initial: 0, integer: true, min: 0 })
                }),
                sourceData: new fields.ObjectField({ initial: {} })
            }), { initial: [] })
        }),
        // Area-of-effect radius in metres for area-effect weapons (e.g.
        // bombs, Core p.88). Meaningful when the weapon is thrown (its
        // `range` field is set) AND its intended use is AoE — otherwise 0.
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
            img:  new fields.StringField({ initial: "" }),
            /* Type + snapshot of the enhancement's system data captured at
             * attach time. Lets effective-stats derivation and the detach-
             * recreate path work after the source item is deleted from
             * inventory. Legacy worlds without a snapshot fall back to
             * fromUuidSync via the uuid. */
            type:   new fields.StringField({ initial: "" }),
            system: new fields.ObjectField({ initial: {} }),
            /* True when the enhancement's stopping bonus has been baked
             * into the parent's base <loc>${t("WITCHER.Misc.DamageProperties.Text.Stopping", "Stopping /")} <loc>MaxStopping
             * fields at attach time (so damage drains the combined pool
             * and an armor at 0 SP truly has 0 SP, even with a glyph
             * socketed). Legacy slots without this flag stay in the
             * derived-modifier model — deriveArmorEffective still adds
             * their bonusSP so their SP doesn't silently vanish on
             * upgrade. Weapons don't have current-vs-max SP semantics,
             * so this flag is currently unused for weapon slots but
             * kept in the schema for shape symmetry. */
            baked:  new fields.BooleanField({ initial: false })
        }), { initial: [] }),
        // Attack skill. For melee weapons this is the swing/stab skill
        // (smallblades, swordsmanship, melee, staffspear, brawling). For
        // ranged weapons this is the shooting skill (archery, crossbow).
        // A melee weapon with a non-empty `range` is throwable; the throw
        // itself always rolls Athletics regardless of what's stored here.
        skillKey:           new fields.StringField({ initial: "" }),
        // LEGACY field — pre-migration this held the melee skill of a
        // "thrown"-typed weapon. Post-migration the melee skill lives in
        // `skillKey` and any weapon with a `range` is throwable, so this
        // field is dead weight. Kept in the schema so world data with
        // legacy values still validates; readers fall back to `skillKey`.
        meleeSkillKey:      new fields.StringField({ initial: "" }),
        // Attack-style class — "melee" for weapons you swing/stab (they
        // become throwable when `range` is set) and "ranged" for weapons
        // you shoot (bows, crossbows, siege). The legacy "thrown" value
        // was collapsed into "melee" — see WeaponData.migrateData.
        weaponType:         new fields.StringField({ initial: "melee" }),
        // Per-weapon override of the default melee-bonus behavior.
        // Defaults true so most melee/thrown items just work; flip false
        // on the rare gimmick weapon that doesn't benefit (Core sidebar
        // examples). For ranged weapons this is ignored.
        appliesMeleeBonus:  new fields.BooleanField({ initial: true }),
        /* Silver Weapon Trait (R. Talsorian Games, 7/11/25 rule update).
         * A boolean flag replacing the old "standard damage + silver damage"
         * split. Weapons with this trait deal their whole damage as silver:
         *   • Silver-weak monsters (system.combat.weaponWeakness === "silver")
         *     take FULL damage instead of the usual half.
         *   • Anyone else (characters, non-silver-weak monsters) takes HALF
         *     — the poor offensive quality of silver against mundane targets.
         * The legacy "silver" weapon quality still works (also marks isSilver);
         * this flag is the simpler single-formula path GMs are encouraged to
         * migrate to (fold the old silver damage into the base damage). */
        silverTrait:        new fields.BooleanField({ initial: false })
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
