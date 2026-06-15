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

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

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
     * each source; when absent a single net "Mod" chip is shown instead.
     */
    async rollSkillCheck(entry, dc = null, { situational = 0, situationalParts = [], messageMode } = {}) {
        const skillKey = typeof entry === "string" ? entry : (entry?.name ?? entry?.skillKey);
        const v = this._readSkillValues(skillKey);
        if (!v) return null;
        // Status penalties to the check (Blinded −5 sight Awareness, Exhausted
        // −1 to every roll, …), summed live by the status engine.
        const statusSkill = statusSkillMod(this, skillKey);
        const sit      = Number(situational) || 0;
        const total    = v.total + statusSkill + sit;
        const formula  = `1d10 + ${total}`;
        const title    = game.i18n.localize(CONFIG.WITCHER.skillLabel(skillKey));
        const parts    = Array.isArray(situationalParts) ? situationalParts : [];
        const sitChips = parts.length
            ? parts.map(p => ({ label: p.label, value: signed(Number(p.value) || 0) }))
            : (sit ? [{ label: "Mod", value: signed(sit) }] : []);
        const flavor   = skillRollFlavor({
            actorName: this.name,
            title,
            chips: [
                { label: statName(v.meta.statKey), value: v.statVal },
                { label: "Rank", value: v.skillVal },
                v.skillMod ? { label: "Mod", value: `${v.skillMod >= 0 ? "+" : ""}${v.skillMod}` } : null,
                statusSkill ? { label: "Status", value: signed(statusSkill) } : null,
                ...sitChips,
                dc != null ? { label: "DC", value: dc } : null
            ]
        });
        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor,
            messageMode
        }, dc != null ? { threshold: dc } : {});
        return { ...result, formula };
    }

    /**
     * Roll a profession-tree skill (defining skill or a path slot). These
     * aren't general SKILL_MAP skills — the slot carries its own governing
     * stat key + trained level, so the check is `1d10 + stat.value + level`.
     * `slot` is a `{ skillName, stat, level }` shape read live off the
     * profession item.
     */
    async rollProfessionSkill(slot, { dc = null } = {}) {
        if (!slot?.skillName) return null;
        const statKey  = String(slot.stat ?? "").toLowerCase();
        /* No governing stat (N/A) → not a rollable check. */
        if (!statKey || statKey === "none") return null;
        const statVal  = Number(this.system.stats?.[statKey]?.value) || 0;
        const level    = Number(slot.level) || 0;
        const formula  = `1d10 + ${statVal + level}`;
        const flavor   = skillRollFlavor({
            actorName: this.name,
            title:     slot.skillName,
            subtitle:  "Profession",
            chips: [
                { label: statName(statKey), value: statVal },
                { label: "Lvl", value: level },
                dc != null ? { label: "DC", value: dc } : null
            ]
        });
        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor
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
