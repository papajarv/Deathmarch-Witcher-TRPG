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
    shield:                 (s) => li(`Quen shield drained <b>${s.drained}</b> (<i>${s.before} → ${s.before - s.drained}</i>); ${s.shieldRemaining} remaining.`),
    activeShield:           (s) => li(`Active Shield drained <b>${s.drained}</b> (<i>${s.before} → ${s.before - s.drained}</i>); ${s.hpRemaining} remaining.`),
    sp: (s) => s.soakedAll
        ? li(`Armor SP <b>${s.sp}</b> fully soaked <i>${s.before}</i> &mdash; no penetration.`)
        : li(`Armor SP <b>${s.sp}</b> subtracted (<i>${s.before} → ${s.after}</i>)${s.ablated ? ", armor ablated &minus;1 SP." : "."}`),
    "blocked-by-sp":        () => li(`Hit fully blocked by armor SP.`),
    dr:                     (s) => li(`Damage Resistance halved (<i>${s.before} → ${s.after}</i>).`),
    monsterImmune:          (s) => li(`Target is <b>immune</b> to this damage type &mdash; weapon damage zeroed (<i>${s.before} → 0</i>).`),
    monsterTypeResist:      (s) => li(`Target resists this damage type &mdash; halved (<i>${s.before} → ${s.after}</i>).`),
    monsterResist:          (s) => li(`Non-silver resist halved damage (<i>${s.before} → ${s.after}</i>).`),
    monsterMeteoriteResist: (s) => li(`Non-meteorite resist halved damage (<i>${s.before} → ${s.after}</i>).`),
    vulnerability:          (s) => li(`Target is <b>vulnerable</b> &mdash; doubled (<i>${s.before} → ${s.after}</i>).`),
    critBonus:              (s) => li(`Crit bonus <b>+${s.added}</b> added (weapon ${s.weaponDamage} + crit ${s.added} = ${s.total}).`),
    location:               (s) => li(`Location ×<b>${s.mult}</b>${s.label ? ` (${esc(s.label)})` : ""} (<i>${s.before} → ${s.after}</i>).`)
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
            lines.push(li(`<b>Active Shield collapsed</b> &mdash; push ${eff.push}m and ${esc(eff.dmgFormula)} to ${esc(eff.location)} (apply manually).`));
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
        : `<div style="opacity:0.7;font-style:italic;margin-top:4px;">No pipeline stages fired.</div>`;
    return `<details class="wdm-dmg-breakdown" style="margin-top:4px;">` +
           `<summary>${summary}</summary>${body}</details>`;
}
