/**
 * Shared enhancement display-context builder.
 *
 * Produces the human-readable "what this rune / glyph / weapon-mod / armor-mod
 * grants" view-model — hero figure, modifier rows, added damage types / granted
 * resistances, granted qualities, where it's socketed, and the effects blurb.
 *
 * Used by BOTH the enhancement item sheet (WitcherEnhancementSheet) and the
 * inventory inspect panel, so the two can never drift out of sync. Async because
 * it lazy-imports config + the enhancement data model (matching the sheet's
 * original load-order-safe pattern).
 */

import { t } from "../../chrome/lib/i18n.js";

export async function buildEnhancementDisplay(item) {
    const src = item?.toObject?.()?.system ?? item?.system ?? {};
    const cfg = await import("../../setup/config.mjs");
    const { ENHANCEMENT_TARGET } = await import("../../data/item/enhancement.mjs");

    const type   = src?.type ?? "rune";
    const target = ENHANCEMENT_TARGET[type] ?? "weapon";
    const isWeaponSide = target === "weapon";

    const TYPE_LABELS = {
        rune:   t("WITCHER.Sheet.Item.Base.EnhType.Rune",      "Rune"),
        glyph:  t("WITCHER.Sheet.Item.Base.EnhType.Glyph",     "Glyph"),
        weapon: t("WITCHER.Sheet.Item.Base.EnhType.WeaponMod", "Weapon Mod"),
        armor:  t("WITCHER.Sheet.Item.Base.EnhType.ArmorMod",  "Armor Mod")
    };
    const typeLabel = TYPE_LABELS[type] ?? type;

    // Quality catalog for the matching target side.
    const catalog  = isWeaponSide
        ? (cfg.getActiveWeaponQualities?.() ?? cfg.WEAPON_QUALITIES ?? {})
        : (cfg.getActiveArmorQualities?.()  ?? cfg.ARMOR_QUALITIES  ?? {});
    const defaults = isWeaponSide ? (cfg.WEAPON_QUALITIES ?? {}) : (cfg.ARMOR_QUALITIES ?? {});
    const values = src?.qualityValues ?? {};
    const grantedQualityList = (src?.grantedQualities ?? [])
        .map(key => {
            const entry = catalog[key] ?? defaults[key];
            if (!entry) return null;
            const param = entry.param ?? defaults[key]?.param ?? null;
            let label = entry.label;
            if (param) {
                const raw = values[key];
                const v   = raw == null ? "" : String(raw).trim();
                if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
            }
            return { key, label, description: entry.description, displayOnly: !!entry.displayOnly };
        })
        .filter(Boolean);

    // Display modifier rows — non-zero contributions only.
    const modRows = [];
    if (isWeaponSide) {
        const acc = Number(src?.accuracyBonus) || 0;
        const rel = Number(src?.reliabilityBonus) || 0;
        const dmg = (src?.damageBonus ?? "").toString().trim();
        if (acc) modRows.push({ val: (acc > 0 ? "+" : "") + acc, lbl: t("WITCHER.Sheet.Item.Base.ModRow.WeaponAccuracy", "Weapon Accuracy"), positive: acc > 0 });
        if (dmg) modRows.push({ val: (dmg.startsWith("-") ? "" : "+") + dmg, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Damage", "Damage"), positive: !dmg.startsWith("-") });
        if (rel) modRows.push({ val: (rel > 0 ? "+" : "") + rel, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Reliability", "Reliability"), positive: rel > 0 });
    } else {
        const sp = Number(src?.stopping) || 0;
        const ev = Number(src?.encumbranceMod) || 0;
        if (sp) modRows.push({ val: "+" + sp, lbl: t("WITCHER.Sheet.Item.Base.ModRow.StoppingPower", "Stopping Power"), positive: true });
        if (ev) modRows.push({ val: (ev > 0 ? "+" : "") + ev, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Encumbrance", "Encumbrance"), positive: ev < 0 });
    }

    // Added damage-type tags (weapon side) / granted resistance tags (armor side).
    const W = CONFIG.WITCHER ?? {};
    let addedTypeTags = [];
    let resistTags = [];
    if (isWeaponSide) {
        addedTypeTags = (src?.addedDamageTypes ?? []).map(k => game.i18n.localize(W.damageTypes?.[k] ?? k));
    } else {
        const res = [];
        if (src?.slashing)    res.push(t("WITCHER.Sheet.Item.Base.Text.Slashing",    "Slashing"));
        if (src?.piercing)    res.push(t("WITCHER.Sheet.Item.Base.Text.Piercing",    "Piercing"));
        if (src?.bludgeoning) res.push(t("WITCHER.Sheet.Item.Base.Text.Bludgeoning", "Bludgeoning"));
        if (src?.fire)        res.push(t("WITCHER.Damage.Fire",      "Fire"));
        if (src?.lightning)   res.push(t("WITCHER.Damage.Lightning", "Lightning"));
        if (src?.cold)        res.push(t("WITCHER.Damage.Cold",      "Cold"));
        if (src?.acid)        res.push(t("WITCHER.Damage.Acid",      "Acid"));
        resistTags = res;
    }

    // Hero — the dominant figure, type-driven.
    let heroValue, heroLabel;
    if (isWeaponSide) {
        const dmg = (src?.damageBonus ?? "").toString().trim();
        const acc = Number(src?.accuracyBonus) || 0;
        if (dmg)      { heroValue = (dmg.startsWith("-") ? "" : "+") + dmg; heroLabel = "DAMAGE"; }
        else if (acc) { heroValue = (acc > 0 ? "+" : "") + acc; heroLabel = "ACCURACY"; }
        else          { heroValue = typeLabel; heroLabel = "FOR WEAPON"; }
    } else {
        const sp = Number(src?.stopping) || 0;
        if (sp) { heroValue = "+" + sp; heroLabel = "STOPPING POWER"; }
        else    { heroValue = typeLabel; heroLabel = "FOR ARMOR"; }
    }

    // Where it's currently socketed (if applied).
    let attachedName = "";
    if (src?.attachedTo && typeof fromUuidSync === "function") {
        try { const p = fromUuidSync(src.attachedTo); if (p) attachedName = p.name; } catch (_) { /* unresolved */ }
    }

    return {
        target, isWeaponSide, isArmorSide: !isWeaponSide,
        typeLabel,
        qualitiesCatalog: catalog,          // config-form use (sheet only)
        damageTypes: cfg.DAMAGE_TYPES ?? W.damageTypes ?? {},  // config-form use (sheet only)
        grantedQualityList, modRows, addedTypeTags, resistTags,
        heroValue, heroLabel, attachedName,
        effects: src?.effects ?? ""
    };
}
