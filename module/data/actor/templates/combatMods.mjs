/**
 * combatMods — passive combat parameters that Active Effects can target so
 * profession passives (and gear) can grant Witcher-school traits. Every field
 * is a plain integer the engine READS at the relevant combat calc; an AE
 * "modify / add" raises it (a *PenaltyReduction of 3 fully nullifies a −3).
 *
 *   evTolerance                  ignore N points of armor Encumbrance Value
 *   startingAdrenaline           adrenaline you begin a combat with
 *   calledShotReduction          shave N off hit-location (called-shot) penalties
 *   parryPenaltyReduction        shave N off the −3 Parry penalty
 *   extraActionPenaltyReduction  shave N off the −3 extra-action to-hit
 *   extraActionStaReduction      shave N off the 3-STA extra-action cost
 *   strongStrikePenaltyReduction shave N off the −3 Strong strike
 *   chargePenaltyReduction       shave N off the −3 Charge strike
 *   offhandPenaltyReduction      shave N off the −3 off-hand / Joint strike
 *   fastDrawPenaltyReduction     shave N off the −3 Fast Draw
 *   freeDefenses                 extra free defensive reactions beyond the 1st
 *   flatAttackMod                passive flat to-hit on every attack
 *   flatDefenseMod               passive flat bonus on every defense
 *   shieldParryPenaltyReduction  shave N off the −3 Parry penalty, SHIELDS only
 *                                (Manticore — 3 = no penalty parrying with a shield)
 *   quickItemWithShield          >0 lets a quick item occupy the off-hand even
 *                                while a shield is held (Manticore)
 *   freeShieldEquip              >0 makes equipping a shield-type item cost no
 *                                action (Manticore)
 */

const fields = foundry.data.fields;
const red = () => new fields.NumberField({ initial: 0, integer: true, min: 0 });
const mod = () => new fields.NumberField({ initial: 0, integer: true });

export function combatModsSchema() {
    return {
        combatMods: new fields.SchemaField({
            evTolerance:                  red(),
            startingAdrenaline:           red(),
            calledShotReduction:          red(),
            parryPenaltyReduction:        red(),
            extraActionPenaltyReduction:  red(),
            extraActionStaReduction:      red(),
            strongStrikePenaltyReduction: red(),
            chargePenaltyReduction:       red(),
            offhandPenaltyReduction:      red(),
            fastDrawPenaltyReduction:     red(),
            freeDefenses:                 red(),
            flatAttackMod:                mod(),
            flatDefenseMod:               mod(),
            shieldParryPenaltyReduction:  red(),
            quickItemWithShield:          red(),
            freeShieldEquip:              red()
        })
    };
}
