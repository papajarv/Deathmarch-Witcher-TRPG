/**
 * WitcherItem — base Item document for the system.
 *
 * Mixin-host pattern. Phase 5 adds consume; Phase 7 will add repair,
 * dismantle, defenseOption mixins as the chrome port lands them.
 */

import { consumeMixin } from "./mixins/consumeMixin.mjs";
import { reloadMixin } from "./mixins/reloadMixin.mjs";
import { getActiveWeaponQualities, WEAPON_QUALITIES } from "../setup/config.mjs";
import { t } from "../chrome/lib/i18n.js";

/** True if this weapon carries a Combat Extended Brawling (Punch)/(Kick)
 *  quality — the ones whose damage folds the wielder's punch/kick code in. */
function weaponHasBrawlingUnarmed(item) {
    if (item?.type !== "weapon") return false;
    const cat = getActiveWeaponQualities?.() ?? WEAPON_QUALITIES;
    const qs  = item.system?.effective?.qualities ?? item.system?.qualities ?? [];
    return qs.some(q => String(cat[q]?.brawlingUnarmedStrike ?? ""));
}

/** True if the owning actor fights with Natural Weapons (a race item with the
 *  naturalWeapons flag), whose damage REPLACES the punch/kick dice that a
 *  Brawling (Punch)/(Kick) weapon folds in — so the two can't coexist. */
function actorHasNaturalWeapons(actor) {
    return !!(actor?.items ?? []).some?.(i => i.type === "race" && i.system?.naturalWeapons);
}

export class WitcherItem extends reloadMixin(consumeMixin(Item)) {
    /** Block equipping a Brawling (Punch)/(Kick) weapon while the owner uses
     *  Natural Weapons — the quality folds in the wielder's punch/kick dice,
     *  which Natural Weapons override, so the combination is contradictory.
     *  Enforced here (document layer) so EVERY equip path is covered: the
     *  chrome inventory, the actor sheet toggle, socket gifts, and macros. */
    async _preUpdate(changed, options, user) {
        if (changed?.system?.equipped === true
            && weaponHasBrawlingUnarmed(this)
            && actorHasNaturalWeapons(this.parent)) {
            ui?.notifications?.warn?.(t(
                "WITCHER.WeaponQuality.BrawlingUnarmed.NoNaturalWeapons",
                "This weapon's Brawling quality can't be used with Natural Weapons."
            ));
            return false;   // veto the update
        }
        return super._preUpdate(changed, options, user);
    }
}
