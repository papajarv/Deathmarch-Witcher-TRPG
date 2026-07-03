/**
 * toxicityMixin — RAW toxicity overdose (Core p.248) + White Honey purge.
 *
 * The consume policy already tracks combined potion/decoction toxicity on
 * `system.stats.toxicity.value` and reclaims it as each potion's effect ends.
 * This mixin adds the *consequence*: when toxicity exceeds the cap the bearer
 * is Overdosed (a poison-like status, its own id — NOT `poisoned`, so monster
 * poison / Golden Oriole immunity never touch it), and the escapes from it.
 *
 * Gated behind the `rawToxicity` homebrew rule so it can be switched off for a
 * house rule without touching the toxicity bookkeeping itself.
 */

import { isHomebrewEnabled } from "../../api/homebrew.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const OVERDOSED = "overdosed";

const toxAmount = (effect) => Number(effect?.getFlag?.(SYSTEM_ID, "consumedToxicity")) || 0;

export const toxicityMixin = (Base) => class extends Base {

    /** Bring the Overdosed status in line with current toxicity.
     *
     *  Gating order:
     *    1. Alchemy Reborn (alchemyPotency) is ON → suppress Overdosed
     *       entirely. The Reborn toxicity tier engine (Slight / Strong /
     *       Deadly markers in consume-item.js) replaces the at-cap RAW
     *       penalty with a finer-grained DoT ladder, so running both
     *       systems in parallel would double-bill the over-cap bearer.
     *       If an old Overdosed marker is on the actor (toggle just got
     *       flipped on), clear it.
     *    2. RAW toxicity rule (rawToxicity) is ON → value over cap →
     *       Overdosed; at/under cap → clear it.
     *    3. Both off → ensure no Overdosed.
     *  No-op for actors without a toxicity pool. */
    async reconcileToxicity() {
        const tox = this.system?.stats?.toxicity;
        if (!tox) return;
        const has  = !!this.statuses?.has?.(OVERDOSED);
        const rebornOn = isHomebrewEnabled("alchemyPotency");
        const over = !rebornOn
            && isHomebrewEnabled("rawToxicity")
            && (Number(tox.value) || 0) > (Number(tox.max) || 0);
        if (over && !has)      await this.toggleStatusEffect?.(OVERDOSED, { active: true });
        else if (!over && has) await this.toggleStatusEffect?.(OVERDOSED, { active: false });
    }

    /** End (delete) the most-recently-applied active potion/decoction effect —
     *  the "last potion consumed". Deleting it reclaims that potion's toxicity
     *  via the consume policy, which re-runs reconcileToxicity. Returns the
     *  ended effect's `{ name }`, or null if the bearer has no toxic potion up. */
    async endLastConsumedPotion() {
        let last = null, newest = -Infinity;
        for (const e of this.effects) {
            if (toxAmount(e) <= 0) continue;
            const t = Number(e._stats?.createdTime) || 0;
            if (t >= newest) { newest = t; last = e; }
        }
        if (!last) return null;
        const name = last.name;
        try { await last.delete(); }
        catch (err) { console.warn(`${SYSTEM_ID} | end last potion failed`, err); return null; }
        return { name };
    }

    /** White Honey: delete every toxicity-bearing potion/decoction effect on the
     *  bearer (their toxicity is reclaimed as they go), then reconcile. Skips
     *  `excludeId` (the purging effect itself, when it lingers). Returns the
     *  number cleared. */
    async purgeToxicEffects(excludeId = null) {
        const ids = [];
        for (const e of this.effects) {
            if (e.id === excludeId) continue;
            if (toxAmount(e) > 0) ids.push(e.id);
        }
        if (ids.length) await this.deleteEmbeddedDocuments("ActiveEffect", ids);
        await this.reconcileToxicity();
        return ids.length;
    }
};
