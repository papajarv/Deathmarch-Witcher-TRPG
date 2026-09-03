import { t, tFormat } from "../chrome/lib/i18n.js";
/**
 * damageBreakdown — pure renderer for the audit log returned by
 * resolveDamage.  Produces HTML the socket handler embeds in a chat card
 * (wrapped in a <details> so the noise stays collapsed by default).
 *
 * The renderer is HTML-safe: every interpolated value runs through
 * `esc`.  No Foundry deps so the function is unit-testable directly.
 */

const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/* Friendly per-stage prose.  Each handler returns a single <li>.  Unknown
 * stage keys are skipped silently so a future calculator stage that lands
 * before the renderer is updated doesn't crash the card. */
const RENDER = {
    shield:                 (s) => {
        const shield = s.shieldName || t("WITCHER.Chat.MagicShield.Fallback", "magic shield");
        return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.Shield",
            { shield: esc(shield), drained: s.drained, before: s.before, after: s.before - s.drained, remaining: s.shieldRemaining },
            "{shield} drained <b>{drained}</b> (<i>{before} → {after}</i>); {remaining} remaining."));
    },
    activeShield:           (s) => {
        const shield = s.shieldName || t("WITCHER.Chat.MagicShield.Fallback", "magic shield");
        return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.ActiveShield",
            { shield: esc(shield), drained: s.drained, before: s.before, after: s.before - s.drained, remaining: s.hpRemaining },
            "{shield} drained <b>{drained}</b> (<i>{before} → {after}</i>); {remaining} remaining."));
    },
    sp: (s) => {
        if (s.soakedAll)  return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.SpSoaked",    { sp: s.sp, before: s.before },              "Armor SP <b>{sp}</b> fully soaked <i>{before}</i> &mdash; no penetration."));
        if (!s.spChipped) return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.SpSubtracted",{ sp: s.sp, before: s.before, after: s.after }, "Armor SP <b>{sp}</b> subtracted (<i>{before} → {after}</i>)."));
        /* Armor that can't be ablated (e.g. a monster without the Ablate box):
         * the SP still soaks the hit, but nothing gets shaved off — don't claim
         * an ablation that never happened. `=== false` so pre-existing stages
         * that lack the flag still render the normal ablated line. */
        if (s.armorAblated === false) {
            return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.SpNoAblate",
                { sp: s.sp, before: s.before, after: s.after },
                "Armor SP <b>{sp}</b> subtracted (<i>{before} → {after}</i>) &mdash; this armor can't be ablated."));
        }
        const baseChip = Number(s.baseChip) || 1;
        const ablating = Number(s.ablatingChip) || 0;
        const total    = Math.abs(Number(s.spDelta) || (baseChip + ablating));
        const breakdown = ablating > 0
            ? tFormat("WITCHER.Combat.DamageBreakdown.Line.SpAblateBreakdown",  { base: baseChip, crushing: baseChip === 2 ? " (Crushing Force)" : "", ablating }, " &mdash; base &minus;{base}{crushing} + Ablating &minus;{ablating} (rolled)")
            : (baseChip === 2 ? t("WITCHER.Combat.DamageBreakdown.Line.SpDoubledCrushing", " &mdash; doubled by Crushing Force") : "");
        return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.SpAblated", { sp: s.sp, before: s.before, after: s.after, total, breakdown }, "Armor SP <b>{sp}</b> subtracted (<i>{before} → {after}</i>), armor ablated &minus;{total} SP{breakdown}."));
    },
    "blocked-by-sp":        () => li(t("WITCHER.Combat.DamageBreakdown.Line.BlockedBySp",       "Hit fully blocked by armor SP.")),
    dr:                     (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.DR",                  { before: s.before, after: s.after }, "Armor resists this damage type &mdash; incoming damage halved (<i>{before} &rarr; {after}</i>).")),
    monsterImmune:          (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.MonsterImmune",       { before: s.before },                  "Target is <b>immune</b> to this damage type &mdash; incoming damage reduced to 0 (<i>{before} &rarr; 0</i>).")),
    monsterTypeResist:      (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.MonsterTypeResist",   { before: s.before, after: s.after },  "Target resists this damage type &mdash; incoming damage halved (<i>{before} &rarr; {after}</i>).")),
    monsterResist:          (s) => Number(s.silverAdded) > 0
        ? li(tFormat("WITCHER.Combat.DamageBreakdown.Line.MonsterResistSilver", { before: s.before, halved: s.halvedBase, added: s.silverAdded, after: s.after }, "Non-silver resistance &mdash; base incoming damage halved (<i>{before} &rarr; {halved}</i>), silver portion <b>+{added}</b> added &rArr; {after}."))
        : li(tFormat("WITCHER.Combat.DamageBreakdown.Line.MonsterResistPlain",  { before: s.before, after: s.after }, "Non-silver resistance &mdash; incoming damage halved (<i>{before} &rarr; {after}</i>).")),
    monsterMeteoriteResist: (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.MonsterMeteoriteResist", { before: s.before, after: s.after }, "Non-meteorite resistance &mdash; incoming damage halved (<i>{before} &rarr; {after}</i>).")),
    silverPoorEdge:         (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.SilverPoorEdge",       { before: s.before, after: s.after }, "Silver's poor edge &mdash; target isn't silver-weak, incoming damage halved (<i>{before} &rarr; {after}</i>).")),
    vulnerability:          (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.Vulnerability", { before: s.before, after: s.after }, "Target is <b>vulnerable</b> to this damage type &mdash; incoming damage doubled (<i>{before} &rarr; {after}</i>).")),
    "crit-monsterImmune":     (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritMonsterImmune",     { before: s.before },                 "Crit bonus zeroed &mdash; target immune to this damage type (<i>{before} &rarr; 0</i>).")),
    "crit-monsterTypeResist": (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritMonsterTypeResist", { before: s.before, after: s.after }, "Crit bonus halved &mdash; target resists this damage type (<i>{before} &rarr; {after}</i>).")),
    "crit-monsterResist":     (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritMonsterResist",     { before: s.before, after: s.after }, "Crit bonus halved &mdash; target resists non-silver damage (<i>{before} &rarr; {after}</i>).")),
    "crit-monsterMeteoriteResist": (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritMonsterMeteoriteResist", { before: s.before, after: s.after }, "Crit bonus halved &mdash; target resists non-meteorite damage (<i>{before} &rarr; {after}</i>).")),
    "crit-silverPoorEdge":    (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritSilverPoorEdge",    { before: s.before, after: s.after }, "Crit bonus halved &mdash; silver's poor edge against non-silver-weak targets (<i>{before} &rarr; {after}</i>).")),
    "crit-vulnerability":     (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritVulnerability", { before: s.before, after: s.after }, "Crit bonus doubled &mdash; target vulnerable to this damage type (<i>{before} &rarr; {after}</i>).")),
    critBonus:              (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritBonus", { added: s.added, weapon: s.weaponDamage, total: s.total }, "Crit bonus <b>+{added}</b> added past armor (weapon {weapon} + crit {added} = {total}).")),
    critShield:             (s) => {
        const shield = s.shieldName || t("WITCHER.Chat.MagicShield.Fallback", "magic shield");
        return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritShield",
            { shield: esc(shield), drained: s.drained, before: s.before, after: s.before - s.drained, remaining: s.shieldRemaining },
            "{shield} drained <b>{drained}</b> from crit bonus (<i>{before} → {after}</i>); {remaining} remaining."));
    },
    critActiveShield:       (s) => {
        const shield = s.shieldName || t("WITCHER.Chat.MagicShield.Fallback", "magic shield");
        return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.CritActiveShield",
            { shield: esc(shield), drained: s.drained, before: s.before, after: s.before - s.drained, remaining: s.hpRemaining },
            "{shield} drained <b>{drained}</b> from crit bonus (<i>{before} → {after}</i>); {remaining} remaining."));
    },
    /* Oil bonus — pushed in by socketHook.handleApplyDamage when the
     * weapon's appliedOil matched the target's monster category. The
     * fold happens upstream of the calculator (the combined number is
     * what every other stage sees), so this line is the audit trail
     * that explains where the extra came from. */
    oilBonus:               (s) => {
        const targetText = s.targetLabel ? tFormat("WITCHER.Combat.DamageBreakdown.Line.OilVsTarget", { label: esc(s.targetLabel) }, " vs {label}") : "";
        const oilText    = s.oilName     ? tFormat("WITCHER.Combat.DamageBreakdown.Line.OilName",     { name:  esc(s.oilName)     }, " ({name})")   : "";
        return li(tFormat("WITCHER.Combat.DamageBreakdown.Line.OilBonus", { oilText, added: s.added, targetText, baseWeapon: s.baseWeapon, combined: s.combined }, "Oil bonus{oilText} <b>+{added}</b>{targetText} (weapon {baseWeapon} + oil {added} = {combined})."));
    },
    location:               (s) => li(tFormat("WITCHER.Combat.DamageBreakdown.Line.Location", { mult: s.mult, label: s.label ? tFormat("WITCHER.Combat.DamageBreakdown.Line.LocationParen", { l: esc(s.label) }, " ({l})") : "", before: s.before, after: s.after }, "Location ×<b>{mult}</b>{label} (<i>{before} → {after}</i>)."))
};

function li(html) { return `<li>${html}</li>`; }

/** Produce the per-target breakdown HTML.  Returns a <details>...</details>
 *  block suitable for embedding directly in a chat message body.
 *
 *  @param {object} args
 *  @param {string} args.targetName
 *  @param {object} args.result        — the resolveDamage return value
 */
export function renderDamageBreakdown({ targetName, result }) {
    const stages = Array.isArray(result?.stages) ? result.stages : [];
    const lines = [];
    for (const s of stages) {
        const h = RENDER[s?.stage];
        if (h) lines.push(h(s));
    }
    // Effect riders (Active Shield collapse, on-penetrate triggers) get
    // their own line below the stages so the GM sees what fired.
    for (const eff of (Array.isArray(result?.effects) ? result.effects : [])) {
        if (eff.kind === "activeShieldCollapse") {
            lines.push(li(`<b>${t("WITCHER.Combat.DamageBreakdown.Text.ActiveShieldCollapsed", "Active Shield collapsed")}</b> &mdash; push ${eff.push}m and ${esc(eff.dmgFormula)} to ${esc(eff.location)} (apply manually).`));
        } else if (eff.kind === "onPenetrate") {
            // Quiet by design — the rider system in weaponAttackMixin handles
            // the actual application; the breakdown just notes the trigger fired.
        }
    }
    const finalDamage = Number(result?.finalDamage) || 0;
    const hpDelta     = Number(result?.patches?.hp?.delta) || 0;
    const summary = finalDamage > 0
        ? `<b>${esc(targetName ?? "Target")}</b> takes <b>${finalDamage}</b> damage (HP ${hpDelta}).`
        : `<b>${esc(targetName ?? "Target")}</b> takes no damage.`;
    // Always render the <details> wrapper — even a no-op chain (e.g. weapon
    // damage 0, no crit) shows the summary line so the card never goes dark.
    const body = lines.length
        ? `<ul style="margin:4px 0 0;padding-left:18px;">${lines.join("")}</ul>`
        : `<div style="opacity:0.7;font-style:italic;margin-top:4px;">${t("WITCHER.Combat.DamageBreakdown.Text.NoPipelineStagesFired", "No pipeline stages fired.")}</div>`;
    return `<details class="wdm-dmg-breakdown" style="margin-top:4px;">` +
           `<summary>${summary}</summary>${body}</details>`;
}
