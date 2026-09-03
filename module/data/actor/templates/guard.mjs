/**
 * Combat Extended — guard-stance data template.
 *
 * Persistent per-actor state for the optional guard system (rules1.png):
 * Balanced (default, no effect), Warding (per-weapon protected location),
 * Closed (+2 def all / -2 atk), Fool's (+2 atk / -2 def all).
 *
 * Lifecycle:
 *   - GMs / players set a `preferred` guard out of combat (the actor's
 *     default fighting stance).
 *   - On `createCombatant`, `preferred` is copied to `current`.
 *   - On `deleteCombat`, `current` resets to "balanced" and
 *     `lockedThisRound` clears.
 *   - On each new combat round (`combatRound`/`combatTurn`),
 *     `lockedThisRound` clears so the actor can switch guards once that
 *     round (Special Action — see L5).
 *
 * Switching guards in combat goes through the guard config dialog
 * (applications/guardConfig.mjs); switching writes `current` AND sets
 * `lockedThisRound = true` so the slot is spent.
 *
 * `wardingLocations` is a free-shape map { [weaponId]: locationKey }.
 * Only meaningful when `current === "warding"`. Each equipped weapon may
 * have its own warded location (per rules1: "Pick a hit location per
 * weapon wielded"). Locations are the standard hit-location keys
 * (head / torso / leftArm / rightArm / leftLeg / rightLeg).
 *
 * Schema kept JSON-safe (no class instances). Guard mechanics live in
 * data/combatExtended/guards.mjs.
 */

const fields = foundry.data.fields;

export const GUARD_KEYS = Object.freeze(["balanced", "warding", "closed", "fools"]);

export function guardSchema() {
    return {
        guard: new fields.SchemaField({
            current:   new fields.StringField({ initial: "balanced", choices: GUARD_KEYS }),
            preferred: new fields.StringField({ initial: "balanced", choices: GUARD_KEYS }),
            /* ObjectField: arbitrary { [weaponId]: locKey } map. Keys are
             * Foundry item ids (16-char base62), values are hit-location
             * keys. Validated softly at read time — an unknown weapon id
             * is just ignored (the weapon was deleted / unequipped). */
            wardingLocations: new fields.ObjectField({ initial: {} }),
            lockedThisRound:  new fields.BooleanField({ initial: false }),
            /* Raise Shield state (L4). Lives alongside guard because both
             * share the per-round Special Action slot (lockedThisRound)
             * and the combat-end reset path. `itemId` is the equipped
             * shield's id; `coveredLocations` is an array of hit-location
             * keys (constrained to a contiguous CV-sized subset via
             * data/combatExtended/guards.mjs:contiguousSets); `headCovered`
             * is a fast-read flag so damageMixin / statusEngine don't
             * have to re-scan the array. */
            shieldRaised: new fields.SchemaField({
                itemId:           new fields.StringField({ initial: "" }),
                coveredLocations: new fields.ArrayField(
                    new fields.StringField({ blank: false }), { initial: [] }
                ),
                headCovered:      new fields.BooleanField({ initial: false })
            })
        })
    };
}
