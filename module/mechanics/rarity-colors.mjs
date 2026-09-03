/**
 * Rarity-colour palette — a GM-owned, WORLD-GLOBAL override of the item
 * availability-tier flair colours (`--wdm-rarity-*` in styles/tokens.css).
 *
 * Unlike the UI Customizer (which has world + per-client scopes), the rarity
 * palette is deliberately single-scope / global: one setting the GM edits in
 * the "Inventory & Items" tab, applied identically for everyone. It reuses the
 * customizer's injection model — a single `<style id="wdm-rarity-colors">`
 * appended late in <head> so equal-specificity rules win by source order — but
 * keeps its own setting + style element so the two never entangle.
 *
 * Merge model: shipped tokens.css  ← world rarity palette (per-tier).
 * A tier left unset falls through to the shipped default, so an empty palette
 * (the default) emits nothing and the UI is byte-for-byte unchanged.
 */

import { isSafeColor } from "./ui-customizer.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

export const RARITY_COLORS_KEY = "rarityColors";

const STYLE_EL_ID   = "wdm-rarity-colors";
const PREVIEW_EL_ID = "wdm-rarity-colors-preview";

/** The eight flair-bearing availability tiers, in ladder order. `def` mirrors
 *  the shipped value in tokens.css (shown as the "inherited" swatch when a tier
 *  isn't overridden). `key` is the i18n label suffix
 *  (WITCHER.App.UiCustomizer.Rarity.<key>). everywhere/na carry no flair and are
 *  intentionally absent. */
export const RARITY_COLOR_TOKENS = Object.freeze([
    /* `everywhere` (the "no tier" baseline) ships with NO flair — the CSS maps
     *  it to `var(--wdm-rarity-everywhere, transparent)`, so an un-set palette
     *  paints nothing. Toggle it on in the customizer and pick a colour to give
     *  even mundane items a wash. `def` is only the picker's starting swatch. */
    { tier: "everywhere",   token: "--wdm-rarity-everywhere",   def: "#8a857b", key: "Everywhere"   },
    { tier: "common",       token: "--wdm-rarity-common",       def: "#8a857b", key: "Common"       },
    { tier: "poor",         token: "--wdm-rarity-poor",         def: "#6a4f8c", key: "Poor"         },
    { tier: "rare",         token: "--wdm-rarity-rare",         def: "#b06b44", key: "Rare"         },
    { tier: "witcher",      token: "--wdm-rarity-witcher",      def: "#a04040", key: "Witcher"      },
    { tier: "elderfolk",    token: "--wdm-rarity-elderfolk",    def: "#18cb00", key: "ElderFolk"    },
    { tier: "relic",        token: "--wdm-rarity-relic",        def: "#935c13", key: "Relic"        },
    { tier: "goetia",       token: "--wdm-rarity-goetia",       def: "#964c5a", key: "Goetia"       },
    { tier: "experimental", token: "--wdm-rarity-experimental", def: "#7799a9", key: "Experimental" }
]);

const TIER_BY_KEY = Object.fromEntries(RARITY_COLOR_TOKENS.map(t => [t.tier, t]));

/* ───────────────────────── settings I/O ───────────────────────── */

/** The stored palette: `{ [tier]: "#rrggbb" }` for overridden tiers only. */
export function getRarityColors() {
    let raw = {};
    try { raw = game.settings.get(SYSTEM_ID, RARITY_COLORS_KEY) ?? {}; }
    catch (_) { raw = {}; }
    const out = {};
    if (raw && typeof raw === "object") {
        for (const { tier } of RARITY_COLOR_TOKENS) {
            if (isSafeColor(raw[tier])) out[tier] = String(raw[tier]).trim();
        }
    }
    return out;
}

/* ───────────────────────── CSS build + inject ───────────────────────── */

/** Turn a palette map into a CSS string overriding the shipped `--wdm-rarity-*`
 *  tokens. Only known tiers with a valid hex are emitted, revalidated here. */
export function buildRarityCss(palette) {
    const decls = [];
    for (const [tier, value] of Object.entries(palette ?? {})) {
        const meta = TIER_BY_KEY[tier];
        if (!meta) continue;
        if (isSafeColor(value)) decls.push(`  ${meta.token}: ${String(value).trim()};`);
    }
    if (!decls.length) return "";
    return `body.witcher-ttrpg-death-march {\n${decls.join("\n")}\n}\n`;
}

function writeStyle(elId, css) {
    let el = document.getElementById(elId);
    if (!css) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement("style");
        el.id = elId;
        document.head.appendChild(el);
    } else if (el !== document.head.lastElementChild) {
        document.head.appendChild(el);
    }
    el.textContent = css;
}

/** (Re)inject the persisted global palette. Called on ready and from the
 *  setting's onChange, so a GM edit propagates live to every client. */
export function applyRarityColors() {
    try {
        writeStyle(STYLE_EL_ID, buildRarityCss(getRarityColors()));
        clearRarityPreview();   // a live persist supersedes any preview overlay
    } catch (err) {
        console.warn(`${SYSTEM_ID} | rarity-colors apply failed`, err);
    }
}

/** Live, non-persisted preview used by the config dialog while editing. */
export function previewRarityColors(palette) {
    try { writeStyle(PREVIEW_EL_ID, buildRarityCss(palette)); }
    catch (err) { console.warn(`${SYSTEM_ID} | rarity-colors preview failed`, err); }
}

export function clearRarityPreview() {
    document.getElementById(PREVIEW_EL_ID)?.remove();
}
