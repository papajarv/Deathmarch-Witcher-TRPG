/**
 * Open-Category Quality Configuration dialog.
 *
 * EO qualities like Two-Hand, Close Quarters, Throwing, and Strangling
 * grant "the indicated benefits" per-weapon. The bonus text on a weapon
 * is comma-separated free-form (e.g. "+1 WA, +1d6 Dmg, Improved Armor
 * Piercing, Bleeding(25)"). The parser in
 * `mechanics/openCategoryBonuses.mjs` decodes it into:
 *   · WA bonus (signed integer)
 *   · damage dice (formula like "1d6")
 *   · granted qualities (catalog quality keys matched by label)
 *   · granted-quality values (the parens payload, e.g. "25" for Bleeding)
 *
 * This dialog is the structured front-end for that text. It reuses the
 * EXACT same class names as the inline weapon-sheet config grid
 * (`wdm-cfg-section`, `wdm-cfg-checkgrid`, `wdm-cfg-check`,
 * `wdm-cfg-check-label`, `wdm-cfg-param`, `wdm-cfg-param-suffix`) so
 * the dialog matches the rest of the item-sheet config layer without
 * any custom styling. Stored granted-quality values are kept SUFFIX-
 * LESS to match `system.qualityValues` canonical storage (Bleeding =
 * "25", not "25%") — the rider engine's Number() coercion depends on
 * that.
 */

import { parseOpenCategoryBonus } from "../mechanics/openCategoryBonuses.mjs";
import { WEAPON_QUALITIES } from "../setup/config.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const QUALITY_LABEL_FALLBACKS = {
    closeQuarters: "Close Quarters",
    twoHand:       "Two-Hand",
    throwing:      "Throwing",
    strangling:    "Strangling"
};
const QUALITY_LABEL_OVERRIDE = new Proxy(QUALITY_LABEL_FALLBACKS, {
    get(target, prop) {
        if (!(prop in target)) return undefined;
        return t(`WITCHER.App.CategoryConfigDialog.Quality.${String(prop)}`, target[prop]);
    }
});

/* Open-category qualities themselves never grant other open-category
 * qualities, and the two non-combat qualities (Foraging / Crafting)
 * don't fire in the attack pipeline. nonLethal is deprecated. */
const SKIP_KEYS = new Set([
    "closeQuarters", "twoHand", "throwing", "strangling",
    "foraging", "crafting",
    "nonLethal"
]);

/** Open the config dialog for one open-category quality on a weapon.
 *  Returns a Promise that resolves to the new bonus string (or null
 *  if the user cancelled). Caller persists via `item.update({...})`. */
export async function openOpenCategoryConfigDialog(item, qualityKey) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return null;

    const label = QUALITY_LABEL_OVERRIDE[qualityKey]
        ?? WEAPON_QUALITIES[qualityKey]?.label
        ?? qualityKey;
    const currentText = String(item?.system?.qualityValues?.[qualityKey] ?? "").trim();
    const parsed = parseOpenCategoryBonus(currentText)
        ?? { wa: 0, dmgDice: "", suffocation: 0, suffocationMult: 1, grantedQualities: [], grantedQualityValues: {}, raw: "" };

    /* Strangling alone carries a per-turn CHOKE-damage bonus: a flat add and a
     * multiplier (e.g. a garrote's ×3). Only shown for that quality. */
    const isStrangling = qualityKey === "strangling";
    const suffFlat0 = Number(parsed.suffocation) || 0;
    const suffMult0 = Number(parsed.suffocationMult) || 1;

    const granted = new Set(parsed.grantedQualities ?? []);
    const grantedValues = parsed.grantedQualityValues ?? {};

    /* Build the checkbox grid. Match the EXACT HTML the inline weapon
     * sheet uses: `.wdm-cfg-check` for plain rows, `.wdm-cfg-check.is-
     * parameterized` (a <div>, not a <label>) for rows with a param
     * input. The shared CSS handles layout — no custom styling here. */
    const rows = Object.entries(WEAPON_QUALITIES)
        .filter(([k, e]) => !SKIP_KEYS.has(k) && e?.label)
        .sort(([, a], [, b]) => a.label.localeCompare(b.label))
        .map(([k, e]) => rowHTML(k, e, granted, grantedValues))
        .join("");

    /* DialogV2 strips/replaces an outer <form> tag in `content` with its
     * own `.dialog-form` wrapper, so put our scoping class on an inner
     * <div> instead — that way the dialog-specific styles below still
     * scope to .occ-dialog descendants. */
    const html = `
        <div class="occ-dialog">
            <div class="wdm-cfg-section">${t("WITCHER.App.OpenCategoryConfigDialog.Text.FlatBonuses", "Flat bonuses")} <span class="wdm-cfg-sub">${tFormat("WITCHER.App.OpenCategoryConfigDialog.Text.FlatBonusesSub", { label: escapeText(label) }, `(applied when ${escapeText(label)} fires)`)}</span></div>
            <div class="wdm-cfg-row occ-flat-row">
                <label class="wdm-cfg-field">
                    <span class="wdm-cfg-label">${t("WITCHER.App.OpenCategoryConfigDialog.Label.WA", "WA")}</span>
                    <input type="number" name="wa" value="${Number(parsed.wa) || 0}" step="1" />
                </label>
                <label class="wdm-cfg-field">
                    <span class="wdm-cfg-label">${t("WITCHER.App.OpenCategoryConfigDialog.Label.DamageDice", "Damage dice")}</span>
                    <input type="text" name="dice" value="${escapeAttr(parsed.dmgDice || "")}"
                           placeholder="1d6" pattern="\\d+d\\d+" />
                </label>
            </div>
            ${isStrangling ? `
            <div class="wdm-cfg-section">${t("WITCHER.App.OpenCategoryConfigDialog.Text.Suffocation", "Choke damage")} <span class="wdm-cfg-sub">${t("WITCHER.App.OpenCategoryConfigDialog.Text.SuffocationSub", "(per-turn suffocation: flat add, then multiply)")}</span></div>
            <div class="wdm-cfg-row occ-flat-row">
                <label class="wdm-cfg-field">
                    <span class="wdm-cfg-label">${t("WITCHER.App.OpenCategoryConfigDialog.Label.SuffocationFlat", "Suffocation +")}</span>
                    <input type="number" name="suffFlat" value="${suffFlat0}" step="1" min="0" />
                </label>
                <label class="wdm-cfg-field">
                    <span class="wdm-cfg-label">${t("WITCHER.App.OpenCategoryConfigDialog.Label.SuffocationMult", "Suffocation ×")}</span>
                    <input type="number" name="suffMult" value="${suffMult0}" step="1" min="1" placeholder="1" />
                </label>
            </div>` : ""}

            <div class="wdm-cfg-section">${t("WITCHER.App.OpenCategoryConfigDialog.Text.GrantedQualities", "Granted qualities")} <span class="wdm-cfg-sub">${tFormat("WITCHER.App.OpenCategoryConfigDialog.Text.GrantedQualitiesSub", { label: escapeText(label) }, `(fire post-hit when ${escapeText(label)} triggers — fill parameter values for those that have one)`)}</span></div>
            <div class="occ-filter">
                <input type="search" name="q" placeholder="${t("WITCHER.App.OpenCategoryConfigDialog.Text.FilterQualities", "Filter qualities…")}" autocomplete="off" />
            </div>
            <div class="wdm-cfg-checkgrid occ-grid">
                ${rows}
            </div>
        </div>
    `;

    try {
        const result = await DialogV2.prompt({
            window: { title: tFormat("WITCHER.App.CategoryConfigDialog.Title", { label }, `${label} — bonus`), contentClasses: ["occ-window"] },
            content: html,
            ok: {
                label: t("WITCHER.Common.Save", "Save"),
                callback: (_event, button) => {
                    const form = button.form;
                    const wa   = Number(form.elements.wa?.value) || 0;
                    const dice = String(form.elements.dice?.value ?? "").trim();
                    const grantedKeys = [];
                    const grantedVals = {};
                    for (const el of form.elements) {
                        if (el.type === "checkbox" && el.name?.startsWith("g_") && el.checked) {
                            grantedKeys.push(el.name.slice(2));
                        }
                    }
                    for (const k of grantedKeys) {
                        const v = form.elements[`v_${k}`]?.value;
                        if (v != null && String(v).trim() !== "") grantedVals[k] = String(v).trim();
                    }
                    const suffFlat = isStrangling ? (Number(form.elements.suffFlat?.value) || 0) : 0;
                    const suffMult = isStrangling ? (Number(form.elements.suffMult?.value) || 1) : 1;
                    return { wa, dice, grantedKeys, grantedVals, suffFlat, suffMult };
                }
            },
            /* Wire the live filter post-render — inline <script> tags
             * don't execute when DialogV2 inserts content via innerHTML. */
            render: (_event, dialog) => {
                const root = dialog.element ?? dialog;
                const search = root.querySelector?.('.occ-dialog input[name="q"]');
                if (!search) return;
                const rows = root.querySelectorAll('.occ-grid > .wdm-cfg-check');
                search.addEventListener('input', () => {
                    const q = search.value.trim().toLowerCase();
                    rows.forEach(row => {
                        if (!q) { row.style.display = ''; return; }
                        row.style.display = (row.textContent || '').toLowerCase().includes(q) ? '' : 'none';
                    });
                });
            },
            rejectClose: false
        });
        if (!result) return null;
        return formatBonusString(result, WEAPON_QUALITIES);
    } catch (_) {
        return null;
    }
}

/** Render one quality row. Matches the inline weapon-sheet markup
 *  exactly so the shared `.wdm-cfg-check` CSS does all the layout. */
function rowHTML(k, entry, granted, grantedValues) {
    const isChecked = granted.has(k);
    const checkedAttr = isChecked ? "checked" : "";
    const tooltip = entry.description ?? "";
    const tooltipAttr = tooltip
        ? `data-tooltip="${escapeAttr(tooltip)}" data-tooltip-direction="UP"`
        : "";
    if (!entry.param) {
        return `
            <label class="wdm-cfg-check" ${tooltipAttr}>
                <input type="checkbox" name="g_${escapeAttr(k)}" ${checkedAttr} />
                <span>${escapeText(entry.label)}</span>
            </label>
        `;
    }
    const currentVal = grantedValues[k] ?? "";
    const suffix = entry.param.suffix
        ? `<span class="wdm-cfg-param-suffix">${escapeText(entry.param.suffix)}</span>`
        : "";
    return `
        <div class="wdm-cfg-check is-parameterized" ${tooltipAttr}>
            <label class="wdm-cfg-check-label">
                <input type="checkbox" name="g_${escapeAttr(k)}" ${checkedAttr} />
                <span>${escapeText(entry.label)}</span>
            </label>
            <input type="${escapeAttr(entry.param.type)}" class="wdm-cfg-param"
                   name="v_${escapeAttr(k)}"
                   value="${escapeAttr(currentVal)}"
                   placeholder="${escapeAttr(entry.param.placeholder ?? "")}"
                   title="${escapeAttr(entry.label)} value" />
            ${suffix}
        </div>
    `;
}

/** Compose the canonical bonus string from the parsed structured data.
 *  Format: "+N WA, +NdM Dmg, Label(value), Label2, …".
 *
 *  Granted-quality values are stored SUFFIX-LESS to match the canonical
 *  `system.qualityValues` storage (e.g. Bleeding = "25", not "25%") —
 *  the rider engine coerces with `Number()` and would NaN on "25%". */
function formatBonusString({ wa, dice, grantedKeys, grantedVals, suffFlat, suffMult }, catalog) {
    const parts = [];
    if (Number.isFinite(wa) && wa !== 0) {
        parts.push(`${wa > 0 ? "+" : ""}${wa} WA`);
    }
    if (dice) {
        parts.push(`+${dice.replace(/^\+/, "")} Dmg`);
    }
    /* Strangling per-turn choke damage: flat add then multiplier (garrote ×3). */
    const sf = Number(suffFlat) || 0;
    if (sf > 0) parts.push(`+${sf} suffocation`);
    const sm = Number(suffMult) || 1;
    if (sm !== 1) parts.push(`×${sm} suffocation`);
    for (const k of grantedKeys ?? []) {
        const entry = catalog?.[k];
        const lbl = entry?.label;
        if (!lbl) continue;
        const v = grantedVals?.[k];
        if (entry?.param && v != null && String(v).trim() !== "") {
            /* Strip a trailing suffix the GM may have typed by hand
             * (defensive — the dialog input does NOT include the
             * suffix, but a hand-edited bonus string might). */
            const suffix = entry.param.suffix ?? "";
            let vStr = String(v).trim();
            if (suffix && vStr.endsWith(suffix)) vStr = vStr.slice(0, -suffix.length).trim();
            parts.push(`${lbl}(${vStr})`);
        } else {
            parts.push(lbl);
        }
    }
    return parts.join(", ");
}

function escapeAttr(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeText(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
