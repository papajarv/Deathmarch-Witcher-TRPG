/* Shared "does this actor have a wrestling weapon?" finder.
 *
 * CE *** rule: a weapon carrying the Grappling quality can perform grapple
 * ACTIONS and grapple DEFENSES using that weapon's OWN skill instead of
 * unarmed Brawling. The defense prompt (button label) and the socket-side
 * roll (skill selection) must agree on the SAME weapon, so the detection
 * lives here once — two copies drifting apart is exactly how "my grapple
 * weapon shows but doesn't roll" bugs happen.
 *
 * Match rules, deliberately forgiving so a correctly-flagged weapon is never
 * silently missed:
 *   - Quality compared case-insensitively against the stored key ("grappling").
 *   - Prefer an EQUIPPED grappling weapon (you wrestle with what's in hand),
 *     but fall back to any CARRIED grappling weapon so an unequipped catch-pole
 *     still lets you defend.
 *   - Requires a resolvable skill (`system.skillKey`, else `meleeSkillKey`);
 *     without one there's nothing to roll.
 */

/** @returns the weapon item to wrestle with, or null. */
export function findGrappleWeapon(actor) {
    const items = actor?.items;
    if (!items?.find) return null;
    const canWrestle = (i) => {
        if (i?.type !== "weapon") return false;
        if (!grappleWeaponSkill(i)) return false;
        const qs = i?.system?.effective?.qualities ?? i?.system?.qualities ?? [];
        const hasGrappling = Array.isArray(qs) && qs.some(q => String(q).toLowerCase() === "grappling");
        /* A weapon whose ATTACK SKILL is Brawling can perform every grapple
         * ACTION and DEFENSE unarmed Brawling can — so it counts as a wrestling
         * weapon even without the Grappling quality (the *** brawling rule). */
        return hasGrappling || weaponUsesBrawlingSkill(i);
    };
    return items.find(i => canWrestle(i) && i?.system?.equipped)
        ?? items.find(canWrestle)
        ?? null;
}

/** Skill key a grappling weapon rolls with (falls back to its melee skill). */
export function grappleWeaponSkill(weapon) {
    const s = weapon?.system;
    const key = String(s?.skillKey ?? s?.meleeSkillKey ?? "").trim();
    return key || null;
}

/** True when a weapon's own attack skill is Brawling — such a weapon is treated
 *  like unarmed Brawling for grapple actions AND grapple defenses (it can do
 *  everything a Grappling weapon can, without carrying the quality). */
export function weaponUsesBrawlingSkill(weapon) {
    if (weapon?.type !== "weapon") return false;
    return String(grappleWeaponSkill(weapon) ?? "").toLowerCase() === "brawling";
}

/* attackKinds that represent a wrestling exchange — a grappling weapon may be
 * used to DEFEND against any of these (grapple plus its follow-ups), per the
 * *** rule that grapple defenses can be made with the weapon's skill. */
export const GRAPPLE_DEFENSE_KINDS = new Set(["grapple", "pin", "choke", "chokehold", "throw", "reverseGrapple", "push", "slam", "takedown", "trip", "disarm"]);
