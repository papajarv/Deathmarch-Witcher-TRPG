/**
 * skillMixin — actor methods for rolling skill checks.
 *
 * Composed onto WitcherActor in documents/actor.mjs. Exposes:
 *   actor.rollSkill(skillKey)                          — no DC
 *   actor.rollSkillCheck(skillEntry|skillKey, dc)      — vs threshold
 *
 * Both go through `extendedRoll(...)` so the d10 chain and chat card
 * are uniform across the system.
 *
 * The formula is `1d10 + stat + skill` per Witcher RAW. Modifiers from
 * active effects / wounds get added in Phase 6's modifier aggregation
 * — for now they're zero so the math is clean.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";
import { skillMod as statusSkillMod } from "../../mechanics/statusEngine.mjs";
import { grappleePhysicalMod } from "../../mechanics/holdModifiers.mjs";
import { getEnvironmentalModifiersForActor } from "../../mechanics/weather-modifiers.mjs";
import { visionEquipmentMods } from "../../mechanics/helmetVision.mjs";
import { lightLevelAt, ambientLightLevel, LIGHT_TIER_RANK } from "../../mechanics/light-level.mjs";
import { equippedArmorHasQualityLabeled } from "../../setup/config.mjs";

/* Like a Shadow (armor quality) — +2 to Stealth checks while the roller is in
 * Dim Light −2 (tier dim2) or darker (dim2 / dim3 / darkness / pitch). Uses the
 * roller's token light (the same finder the stealth system uses); when there is
 * no token on the active scene (theatre of mind), falls back to the scene's
 * current weather-aware ambient light. Quality matched by label so a custom OR
 * built-in entry works. */
function likeAShadowBonus(actor, skillKey) {
    if (skillKey !== "stealth") return 0;
    if (!equippedArmorHasQualityLabeled(actor, "Like a Shadow")) return 0;
    let tier = null;
    try {
        const tok = actor?.getActiveTokens?.()?.[0] ?? null;
        tier = tok ? lightLevelAt(tok) : ambientLightLevel();
    } catch (_) { tier = null; }
    if (!tier || (LIGHT_TIER_RANK[tier] ?? 6) > LIGHT_TIER_RANK.dim2) return 0;   // brighter than dim2 → no bonus
    return 2;
}

/* Skills whose checks auto-fold the live weather/light penalty for a given
 * modifier target. Awareness ← perception in fog/darkness/snow blindness. */
const SKILL_ENV_TARGET = Object.freeze({ awareness: "awareness" });

import { t, tFormat } from "../../chrome/lib/i18n.js";
const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

/* Skill key → auto-fumble category. Returns null for skills that don't
 * fit a RAW fumble table (perception, cooking, intimidation, …) so
 * extendedRoll just posts the fumble banner without auto-rolling. Combat
 * mixins (weaponAttackMixin, defenseMixin, brawlMixin, castSpellMixin)
 * pass their OWN fumble categories directly and never route through
 * skillMixin for their primary flow — this mapping only fires for
 * standalone skill checks (sheet buttons, macros, opposed skill tests).
 *
 * Mapping — user spec (2026-07-02):
 *   armed attack   ← weapon-attack skills (melee / smallblades / swords / staffspear)
 *   armed defense  ← parry / block are weapon actions (routed via defenseMixin, not here)
 *   unarmed attack ← brawling (default; brawlMixin covers the combat-flow case)
 *   unarmed defense← dodge, athletics (reposition + escape)
 *   ranged attack  ← archery, crossbow
 *   magic          ← spellcast, hexweave, ritcraft
 */
const SKILL_FUMBLE_CATEGORY = Object.freeze({
    brawling:      "unarmedAttack",
    dodge:         "unarmedDefense",
    athletics:     "unarmedDefense",
    melee:         "meleeAttack",
    smallblades:   "meleeAttack",
    swordsmanship: "meleeAttack",
    staffspear:    "meleeAttack",
    archery:       "rangedAttack",
    crossbow:      "rangedAttack",
    spellcast:     "magic",
    hexweave:      "magic",
    ritcraft:      "magic"
});

/** Localize a stat label, falling back to the upper-cased key when the
 *  i18n key is missing (localize returns the key unchanged in that case). */
function statName(statKey) {
    const key = String(statKey ?? "").toLowerCase();
    const out = game.i18n.localize(CONFIG.WITCHER.statLabel(key));
    return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
}

/**
 * Build the styled header for a skill/profession roll chat card.
 * Renders the actor + skill name and a row of stat/rank/mod/DC chips.
 * `chips` is an array of { label, value } — falsy entries are skipped.
 */
function skillRollFlavor({ actorName, title, subtitle, chips = [] }) {
    const chipHtml = chips
        .filter(c => c && c.value != null && c.value !== "")
        .map(c => `<span class="wdm-chip"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
        .join("");
    return `
        <div class="wdm-skill-head">
            <div class="wdm-skill-actor">${esc(actorName)}</div>
            <div class="wdm-skill-name">${esc(title)}</div>
            ${subtitle ? `<div class="wdm-skill-sub">${esc(subtitle)}</div>` : ""}
            ${chipHtml ? `<div class="wdm-skill-chips">${chipHtml}</div>` : ""}
        </div>`;
}

export const skillMixin = (Base) => class extends Base {

    /**
     * Look up the (stat, skill) pair for a skill key from CONFIG.WITCHER.
     * Returns null if the key isn't registered.
     */
    _resolveSkill(skillKey) {
        const meta = CONFIG.WITCHER?.skillMap?.[skillKey];
        if (!meta) {
            console.warn(`witcher-ttrpg-death-march | unknown skill '${skillKey}'`);
            return null;
        }
        return meta;
    }

    /**
     * Read the rollable components for a skill. Returns the post-prepare
     * snapshot — stat.value is post-AE (e.g. Freeze drops REF), and
     * skill.total = stat + rank + modifier was computed by
     * prepareDerivedData. Defaults are safe-zero for missing keys.
     */
    _readSkillValues(skillKey) {
        const meta = this._resolveSkill(skillKey);
        if (!meta) return null;
        const skill    = this.system.skills?.[meta.statKey]?.[skillKey] ?? {};
        const statVal  = Number(this.system.stats?.[meta.statKey]?.value) || 0;
        const skillVal = Number(skill.value) || 0;
        const skillMod = Number(skill.modifier) || 0;
        const total    = Number(skill.total ?? (statVal + skillVal + skillMod));
        return { meta, statVal, skillVal, skillMod, total };
    }

    /**
     * Roll an open skill check (no DC). The formula is `1d10 + total`
     * where total = current-stat + rank + modifier (precomputed in
     * prepareDerivedData). Posts a chat card.
     */
    async rollSkill(skillKey, opts = {}) {
        return this.rollSkillCheck(skillKey, null, opts);
    }

    /**
     * Roll a skill check, optionally against a DC. `entry` may be a skill
     * key string or an object `{ name: skillKey, ... }` for callers that
     * already have skillMap metadata. Pass `dc = null` for an open roll.
     *
     * `opts.situational` is a flat step modifier folded into the roll on top
     * of the actor's own stat/rank/AE/status total — used by callers that
     * gather one-off mods (e.g. the dock Awareness prompt applying weather /
     * light penalties). `opts.situationalParts` is an optional breakdown
     * (`[{label, value}]`) rendered as individual chips so the card names
     * each source; when absent a single net t("WITCHER.Common.Mod", "Mod") chip is shown instead.
     */
    async rollSkillCheck(entry, dc = null, { situational = 0, situationalParts = [], messageMode, rollMode, vsActor = null } = {}) {
        const skillKey = typeof entry === "string" ? entry : (entry?.name ?? entry?.skillKey);
        const v = this._readSkillValues(skillKey);
        if (!v) return null;
        // Status penalties to the check (Blinded −5 sight Awareness, Exhausted
        // −1 to every roll, …), summed live by the status engine.
        const statusSkill = statusSkillMod(this, skillKey);
        /* Grappled -2 (RAW Core p.161) — was a static status clause, now applied
         * at roll time so it can be waived vs your grappler. Generic checks pass
         * no opponent (flat -2, as before); callers that ARE acting against a
         * specific foe (e.g. the brawl Reverse Grapple roll) pass `vsActor` so
         * the CE "no penalty vs your grappler" carve-out fires. */
        const holdSkill = grappleePhysicalMod(this, vsActor);
        const sit      = Number(situational) || 0;
        // Environmental (weather + light) penalties for this skill's target, read
        // from the actor's OWN tile — auto-applied to every check of the skill so
        // they don't hinge on a dialog, and stacking naturally (Dim −2 + storm −2
        // = −4). Empty for skills with no mapped target, or when unsheltered/clear.
        // Environmental (weather/light) mods, plus the CE Poor-Vision helmet
        // penalty (−2 Awareness while the visor is down) folded into the same
        // list so it flows into both the total and the readout chips.
        const envParts = [
            ...getEnvironmentalModifiersForActor(this, SKILL_ENV_TARGET[skillKey]),
            ...visionEquipmentMods(this, SKILL_ENV_TARGET[skillKey])
        ];
        // Like a Shadow (armor): +N Stealth in dim2-or-darker light.
        const shadowBonus = likeAShadowBonus(this, skillKey);
        if (shadowBonus) envParts.push({ label: "WITCHER.WeaponQuality.LikeaShadow.Label", value: shadowBonus });
        const envSum   = envParts.reduce((s, p) => s + (Number(p.value) || 0), 0);
        const total    = v.total + statusSkill + holdSkill + sit + envSum;
        const formula  = `1d10 + ${total}`;
        const title    = game.i18n.localize(CONFIG.WITCHER.skillLabel(skillKey));
        const parts    = Array.isArray(situationalParts) ? situationalParts : [];
        const sitChips = parts.length
            ? parts.map(p => ({ label: p.label, value: signed(Number(p.value) || 0) }))
            : (sit ? [{ label: t("WITCHER.Common.Mod", "Mod"), value: signed(sit) }] : []);
        const envChips = envParts.map(p => ({ label: game.i18n.localize(p.label), value: signed(Number(p.value) || 0) }));
        const flavor   = skillRollFlavor({
            actorName: this.name,
            title,
            chips: [
                { label: statName(v.meta.statKey), value: v.statVal },
                { label: t("WITCHER.Common.Rank", "Rank"), value: v.skillVal },
                v.skillMod ? { label: t("WITCHER.Common.Mod", "Mod"), value: `${v.skillMod >= 0 ? "+" : ""}${v.skillMod}` } : null,
                statusSkill ? { label: t("WITCHER.Common.Status", "Status"), value: signed(statusSkill) } : null,
                holdSkill ? { label: t("WITCHER.Mech.HoldModifiers.Text.Grappled", "Grappled"), value: signed(holdSkill) } : null,
                ...envChips,
                ...sitChips,
                dc != null ? { label: "DC", value: dc } : null
            ]
        });
        /* Every skill roll gets a fumble category — mapped ones go to
         * their RAW combat table (melee / dodge / archery / magic /
         * brawl / etc.); unmapped skills (perception, cooking,
         * intimidation, …) fall through to "skillCheck", a generic
         * category with no auto-roll table but which Balanced Stance
         * can still gate a 5-STA skip on ("a fumble of any kind"). */
        const fumbleCategory = SKILL_FUMBLE_CATEGORY[skillKey] ?? "skillCheck";
        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor,
            messageMode,
            rollMode,
            flags: { "witcher-ttrpg-death-march": { category: "skill" } }
        }, {
            ...(dc != null ? { threshold: dc } : {}),
            fumbleCategory
        });
        return { ...result, formula };
    }

    /**
     * Roll a profession-tree skill (defining skill or a path slot). These
     * aren't general SKILL_MAP skills — the slot carries its own governing
     * stat key + trained level, so the check is `1d10 + stat.value + level`.
     * `slot` is a `{ skillName, stat, level }` shape read live off the
     * profession item.
     */
    async rollProfessionSkill(slot, { dc = null, messageMode, rollMode, situational = 0 } = {}) {
        if (!slot?.skillName) return null;
        const statKey  = String(slot.stat ?? "").toLowerCase();
        /* No governing stat (N/A) → not a rollable check. */
        if (!statKey || statKey === "none") return null;
        const statVal  = Number(this.system.stats?.[statKey]?.value) || 0;
        const level    = Number(slot.level) || 0;
        const sit      = Number(situational) || 0;
        const formula  = `1d10 + ${statVal + level + sit}`;
        const flavor   = skillRollFlavor({
            actorName: this.name,
            title:     slot.skillName,
            subtitle:  t("WITCHER.Doc.SkillMixin.Text.Profession", "Profession"),
            chips: [
                { label: statName(statKey), value: statVal },
                { label: t("WITCHER.Doc.SkillMixin.Dialog.Button.Lvl", "Lvl"), value: level },
                sit ? { label: t("WITCHER.Common.Mod", "Mod"), value: signed(sit) } : null,
                dc != null ? { label: t("WITCHER.Doc.SkillMixin.Text.DC", "DC"), value: dc } : null
            ]
        });
        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor,
            flags: { "witcher-ttrpg-death-march": { category: "skill" } },
            messageMode,
            rollMode
        }, dc != null ? { threshold: dc } : {});
        return { ...result, formula };
    }

    /**
     * Find a profession-tree slot by its display name. Searches the defining
     * skill and all three path slots of the actor's profession item. Returns
     * the `{ skillName, stat, level, ... }` slot object, or null.
     */
    findProfessionSlot(skillName) {
        const sys = this.items.find(i => i.type === "profession")?.system;
        if (!sys) return null;
        const target = String(skillName ?? "").trim();
        if (!target) return null;
        const slots = [sys.definingSkill];
        for (const pk of ["skillPath1", "skillPath2", "skillPath3"]) {
            const p = sys[pk];
            if (p) for (const sk of ["skill1", "skill2", "skill3"]) slots.push(p[sk]);
        }
        return slots.find(s => s?.skillName && String(s.skillName).trim() === target) ?? null;
    }

    /**
     * Stub for modifier aggregation. Phase 6 walks active effects + item
     * effects and returns a formula fragment like " + 2 - 1". Returning
     * empty for now keeps rolls clean.
     */
    addAllModifiers(_skillKey) {
        return "";
    }
};
