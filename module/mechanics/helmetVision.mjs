/**
 * Helmet vision restriction (Combat Extended).
 *
 * A worn helm with the `restrictedVision` or `poorVision` armor quality limits
 * the wearer. This module is the single source of truth for WHETHER that
 * restriction is currently biting, so every consumer agrees:
 *
 *   • token vision angle → 90°           (policy/helmet-vision-restriction.mjs)
 *   • in-combat STA recovery halved       (documents/mixins/combatRoundMixin.mjs)
 *   • −2 Awareness & −2 ranged (Poor)      (skillMixin + attackDialog)
 *
 * The `visor` quality (also CE) lets a helm raise/lower its visor as an Action.
 * While RAISED, all of the above are negated — that gate lives in `visorNegates`
 * and flows through every predicate here.
 *
 * All of this is gated behind the CE `eoArmorModel` subsystem: with CE off (or
 * that subsystem off) none of it applies, so RAW play is untouched.
 */

import { ARMOR_QUALITIES } from "../setup/config.mjs";
import { isCESubsystemEnabled } from "../api/homebrew.mjs";

/** Armor qualities that impose the vision restriction. */
const VISION_QUALITY_KEYS = ["restrictedVision", "poorVision"];

/** The effective quality-key list for an item (prefers the derived
 *  `effective.qualities`, falls back to the raw list). */
function qualitiesOf(item) {
    const q = item?.system?.effective?.qualities ?? item?.system?.qualities ?? [];
    return Array.isArray(q) ? q : [];
}

/** True when the item carries the CE `visor` quality (its visor can be
 *  raised/lowered). Drives the context-menu entries + the inventory pip. */
export function hasVisorQuality(item) {
    return qualitiesOf(item).includes("visor");
}

/** True when the item's visor is currently raised (state only — doesn't check
 *  the quality; pair with hasVisorQuality where that matters). */
export function isVisorRaised(item) {
    return !!item?.system?.visorRaised;
}

/** True when this item carries the `visor` quality AND the visor is currently
 *  raised — the state in which the helm's vision restriction is negated. */
export function visorNegates(item) {
    return hasVisorQuality(item) && isVisorRaised(item);
}

/** True when THIS armor piece's vision restriction is currently in effect:
 *  it carries a restricted/poor-vision quality and its visor isn't raised.
 *  (Does not check equipped state or CE — callers add those as needed.) */
export function itemVisionRestrictionActive(item) {
    if (item?.type !== "armor") return false;
    const q = qualitiesOf(item);
    if (!q.some(k => VISION_QUALITY_KEYS.includes(k))) return false;
    return !visorNegates(item);
}

/** True when this armor piece specifically has POOR vision active (drives the
 *  −2 Awareness / ranged penalty; restricted-vision alone doesn't). */
function itemPoorVisionActive(item) {
    if (item?.type !== "armor") return false;
    if (!qualitiesOf(item).includes("poorVision")) return false;
    return !visorNegates(item);
}

/** True when the CE helmet-vision feature is live (master CE + eoArmorModel). */
export function helmetVisionEnabled() {
    return isCESubsystemEnabled("eoArmorModel");
}

function equippedArmor(actor) {
    const items = actor?.items?.contents ?? actor?.items ?? [];
    return items.filter(it => it?.type === "armor" && it.system?.equipped);
}

/** Does the actor wear an equipped helm whose vision restriction is active
 *  right now? (CE-gated.) Drives the 90° token vision angle. */
export function actorVisionRestricted(actor) {
    if (!helmetVisionEnabled()) return false;
    return equippedArmor(actor).some(itemVisionRestrictionActive);
}

/** Does the actor wear an equipped Poor-Vision helm with the visor down?
 *  (CE-gated.) Drives the −2 Awareness / ranged penalty. */
export function actorPoorVisionActive(actor) {
    if (!helmetVisionEnabled()) return false;
    return equippedArmor(actor).some(itemPoorVisionActive);
}

/** The token vision angle a wearer should be clamped to, or null for none. */
export const RESTRICTED_VISION_ANGLE = 90;

/** The Poor-Vision penalty magnitude applied to Awareness and ranged attacks. */
export const POOR_VISION_PENALTY = -2;

/** Extra modifier entries to fold into the environmental-modifier list at the
 *  Awareness-skill and ranged-attack consumption points. Returns [] unless the
 *  target is one we penalize AND the actor has an active Poor-Vision helm.
 *  Shaped like `getEnvironmentalModifiersForActor` entries ({label,value,source})
 *  so callers can concat without special-casing. */
export function visionEquipmentMods(actor, target) {
    if (target !== "ranged" && target !== "awareness") return [];
    if (!actorPoorVisionActive(actor)) return [];
    return [{ label: "WITCHER.Armor.PoorVisionPenalty", value: POOR_VISION_PENALTY, source: "poorVision" }];
}

/** True if a quality key carries the STA-recovery-halving flag. */
export function qualityHalvesStaRecovery(qualityKey) {
    return !!ARMOR_QUALITIES?.[qualityKey]?.armorHalvesCombatStaRecovery;
}

/** True when the actor wears an equipped armor piece whose quality halves
 *  in-combat STA recovery (Restricted / Poor Vision) AND its visor isn't
 *  raised. The single authority behind BOTH recovery surfaces — the dock
 *  Recovery Action and the sheet Take a Breath — so they always agree. NOT
 *  CE-gated: the STA-halving qualities predate the CE armor model; only the
 *  visor negation is layered on top. */
export function armorHalvesStaRecovery(actor) {
    const items = actor?.items?.contents ?? actor?.items ?? [];
    for (const it of items) {
        if (it?.type !== "armor" || !it.system?.equipped) continue;
        const halves = qualitiesOf(it).some(q => ARMOR_QUALITIES?.[q]?.armorHalvesCombatStaRecovery);
        if (!halves) continue;
        if (visorNegates(it)) continue;   // visor up → restriction (incl. halving) lifted
        return true;
    }
    return false;
}
