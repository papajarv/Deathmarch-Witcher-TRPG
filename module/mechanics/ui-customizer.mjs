/**
 * UI Customizer — user-facing theming layer for the Death March overhaul UI.
 *
 * The whole overhaul UI is scoped under `body.witcher-ttrpg-death-march` and
 * draws every colour / font from the `--wdm-*` design tokens defined once in
 * `styles/tokens.css`. This module lets the GM (world-wide) and each player
 * (per-client override) redefine a curated subset of those tokens plus drop
 * in raw custom CSS — WITHOUT editing the shipped stylesheets. It does that by
 * emitting a single `<style id="wdm-ui-customizer-theme">` element, appended LAST in
 * `<head>` so equal-specificity rules win by source order.
 *
 * Merge model (per-key):
 *   shipped tokens.css  ← world theme  ← client theme
 * A token/font left unset at a scope falls through to the next one down; unset
 * at every scope means we emit nothing for it and the shipped default stands.
 * Each scope has a master `enabled` flag; a disabled scope contributes nothing.
 *
 * Nothing here mutates existing CSS or DOM structure, so with both scopes
 * disabled (the shipped default) the UI is byte-for-byte what it was before.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

export const UI_CUSTOMIZER_WORLD_KEY  = "uiCustomizer.world";
export const UI_CUSTOMIZER_CLIENT_KEY = "uiCustomizer.client";

/* NOTE: must NOT equal the UiCustomizerConfigApp window id ("wdm-ui-customizer").
 * They previously collided — the injected <style> and the app window shared one
 * DOM id, so once a theme was actually applied the <style> existed in <head>
 * and opening the window (same id) failed to render AND clobbered the style
 * (customization "reset"). Distinct ids keep the injected theme and the app
 * window independent. */
const STYLE_EL_ID   = "wdm-ui-customizer-theme";
const PREVIEW_EL_ID = "wdm-ui-customizer-preview";

/** Curated colour tokens exposed in the picker. `def` mirrors the shipped
 *  value in tokens.css and is shown as the "inherited" swatch when a scope
 *  hasn't overridden it. `key` is the i18n label suffix
 *  (WITCHER.App.UiCustomizer.Color.<key>). All are hex so `<input type=color>`
 *  round-trips cleanly. */
export const UI_COLOR_TOKENS = Object.freeze([
    /* Backgrounds */
    { token: "--wdm-void",         def: "#050402", key: "Void",        group: "Backgrounds", label: "Void", desc: "Deepest background — the black behind everything (dialog scrims, darkest wells)." },
    { token: "--wdm-bg",           def: "#0a0908", key: "Bg",          group: "Backgrounds", label: "Background", desc: "Main window background of every Death March panel." },
    { token: "--wdm-bg-lifted",    def: "#14110d", key: "Panel",       group: "Backgrounds", label: "Panel", desc: "Raised surfaces — cards, rows and tiles that sit above the background." },
    { token: "--wdm-bg-deep",      def: "#050402", key: "BgDeep",      group: "Backgrounds", label: "Well", desc: "Recessed wells and shadow pits — inset areas like the chat log backing." },
    /* Text */
    { token: "--wdm-ink-faint",    def: "#5a574e", key: "InkFaint",    group: "Text", label: "Ink · faint", desc: "Faintest text — hairline rules and barely-there labels." },
    { token: "--wdm-ink-dim",      def: "#8a857a", key: "InkDim",      group: "Text", label: "Ink · dim", desc: "Muted text — secondary labels, hints, captions and disabled items." },
    { token: "--wdm-ink",          def: "#b0a994", key: "Ink",         group: "Text", label: "Ink", desc: "Default body text colour." },
    { token: "--wdm-ink-hi",       def: "#cac4b0", key: "InkHi",       group: "Text", label: "Ink · high", desc: "Emphasised text — names, values and highlighted labels." },
    { token: "--wdm-ink-bright",   def: "#e0dac4", key: "InkBright",   group: "Text", label: "Ink · bright", desc: "Brightest text — headings and hovered rows." },
    /* Accent — gold */
    { token: "--wdm-amber-dim",    def: "#6e5224", key: "AmberDim",    group: "Accent · gold", label: "Amber · dim", desc: "Muted accent — most borders, dividers and inactive accent marks." },
    { token: "--wdm-amber",        def: "#a88450", key: "Amber",       group: "Accent · gold", label: "Amber", desc: "Primary accent — the Witcher gold on buttons, icons and active borders." },
    { token: "--wdm-amber-hi",     def: "#b89464", key: "AmberHi",     group: "Accent · gold", label: "Amber · high", desc: "Mid-bright accent — hovered borders and secondary highlights." },
    { token: "--wdm-amber-bright", def: "#c8a878", key: "AmberBright", group: "Accent · gold", label: "Amber · bright", desc: "Bright accent — key numbers, active highlights and hover glow." },
    { token: "--wdm-gilt",         def: "#b58838", key: "Gilt",        group: "Accent · gold", label: "Gold · flourish", desc: "Ornament gold — gilded flourishes and special highlight lines." },
    { token: "--wdm-gilt-hi",      def: "#d8a448", key: "GiltHi",      group: "Accent · gold", label: "Gold · shine", desc: "Bright gold — the stamina bar and shining gilded edges." },
    { token: "--wdm-gilt-dk",      def: "#5a3e1c", key: "GiltDk",      group: "Accent · gold", label: "Gold · deep", desc: "Deep gold — the shadow side of gilded edges." },
    /* Danger */
    { token: "--wdm-red",          def: "#8c3c3c", key: "Red",         group: "Danger", label: "Red", desc: "Danger colour — HP, warnings and destructive buttons." },
    { token: "--wdm-red-bright",   def: "#a25050", key: "RedBright",   group: "Danger", label: "Red · bright", desc: "Bright danger — critical states and hovered destructive actions." },
    /* Nature & status */
    { token: "--wdm-poison",       def: "#6e8a4a", key: "Poison",      group: "Nature & status", label: "Poison", desc: "Poison / toxicity green — status effects and tox meters." },
    { token: "--wdm-frost",        def: "#6a8aa2", key: "Frost",       group: "Nature & status", label: "Frost", desc: "Cold / frost blue — chilled states and water." },
    { token: "--wdm-bronze",       def: "#9a7e44", key: "Bronze",      group: "Nature & status", label: "Bronze", desc: "Bronze — coin, weight and mundane-material accents." },
    { token: "--wdm-teal",         def: "#3a8a78", key: "Teal",        group: "Nature & status", label: "Teal", desc: "Teal — carried-weapon rail clips and secondary markers." },
    { token: "--wdm-teal-dim",     def: "#2c6258", key: "TealDim",     group: "Nature & status", label: "Teal · dim", desc: "Muted teal — the dim side of teal markers." },
    /* Alchemy — one control per element; each recolours BOTH that element's
     * hue and its matching substance hue (`also`), so there's a single alchemy
     * palette to reason about. */
    { token: "--wdm-elem-vitriol",    also: ["--wdm-sub-vitriol"],    def: "#4a8a5e", key: "ElemVitriol",    group: "Alchemy", label: "Vitriol", desc: "Vitriol — iron/copper-sulfate green." },
    { token: "--wdm-elem-rebis",      also: ["--wdm-sub-rebis"],      def: "#8a5a9a", key: "ElemRebis",      group: "Alchemy", label: "Rebis", desc: "Rebis — hermetic violet." },
    { token: "--wdm-elem-aether",     also: ["--wdm-sub-aether"],     def: "#8ea8b8", key: "ElemAether",     group: "Alchemy", label: "Aether", desc: "Aether — pale fifth-element cyan." },
    { token: "--wdm-elem-quebrith",   also: ["--wdm-sub-quebrith"],   def: "#c0a040", key: "ElemQuebrith",   group: "Alchemy", label: "Quebrith", desc: "Quebrith — sulfur yellow." },
    { token: "--wdm-elem-hydragenum", also: ["--wdm-sub-hydragenum"], def: "#a8b0b8", key: "ElemHydragenum", group: "Alchemy", label: "Hydragenum", desc: "Hydragenum — mercury silver." },
    { token: "--wdm-elem-vermilion",  also: ["--wdm-sub-vermilion"],  def: "#b04848", key: "ElemVermilion",  group: "Alchemy", label: "Vermilion", desc: "Vermilion — mercury-sulfide red." },
    { token: "--wdm-elem-sol",        also: ["--wdm-sub-sol"],        def: "#d8a448", key: "ElemSol",        group: "Alchemy", label: "Sol", desc: "Sol — sun gold." },
    { token: "--wdm-elem-caelum",     also: ["--wdm-sub-caelum"],     def: "#6a8aa2", key: "ElemCaelum",     group: "Alchemy", label: "Caelum", desc: "Caelum — sky blue." },
    { token: "--wdm-elem-fulgur",     also: ["--wdm-sub-fulgur"],     def: "#9a78c0", key: "ElemFulgur",     group: "Alchemy", label: "Fulgur", desc: "Fulgur — lightning violet." }
]);

/** Font roles → the CSS var each drives, plus a generic fallback appended
 *  after the chosen family so a missing glyph still resolves sanely. */
export const UI_FONT_ROLES = Object.freeze([
    { role: "display", token: "--wdm-font-display", generic: "sans-serif",             key: "Display",
      label: "Display / headings", desc: "All uppercase headings, section labels, tab names, buttons, big numbers — the condensed \"chrome\" font seen everywhere." },
    { role: "body",    token: "--wdm-font-body",    generic: "system-ui, sans-serif",  key: "Body",
      label: "Body text", desc: "Running prose — descriptions, flavour text, journal and item body copy." },
    { role: "mono",    token: "--wdm-font-mono",    generic: "ui-monospace, monospace", key: "Mono",
      label: "Monospace", desc: "Fixed-width text — dice formulas, code blocks and numeric read-outs that need to align." }
]);

/** Per-section theming targets. Each is an independent region with its own
 *  root selector; overrides are emitted SCOPED to that selector so they only
 *  affect that part of the UI (no global token bleed). This is the "colours
 *  per section" model that replaces the old flat 47-token global picker.
 *
 *  bg capability:
 *    "solid" → single background colour + opacity
 *    "full"  → solid|gradient background + image overlay + opacity
 *  `foundry:true` marks the native-Foundry target (windows / sheets / dialogs);
 *  those elements do NOT read the --wdm-* tokens, so we emit concrete
 *  color/background properties there instead of variable overrides.
 *
 *  `defBg` seeds the background picker so an opacity change has a sensible
 *  colour to act on out of the box (mirrors the shipped --wdm-bg).
 *
 *  `pseudo` — the FREE pseudo-element (::before/::after) on that root, used as
 *  an absolutely-positioned backdrop to paint the gradient/image. Painting on
 *  the fixed+zoomed root itself mispaints in Chromium (background renders in a
 *  shifted coordinate space → "off-centre") and fights the shipped `!important`
 *  state-gated plate; an absolute pseudo avoids both. Foundry has no pseudo
 *  (windows vary) and paints its background concretely on the root. */
export const UI_SECTIONS = Object.freeze([
    // Left/right/bottom bars are position:fixed + zoomed, and their shipped
    // plate is `!important` (side bars) — a root-painted background mispaints
    // ("off-centre") and loses the cascade, so these use a pseudo backdrop.
    { id: "leftbar",   key: "LeftBar",   selector: "#scene-controls", bg: "full",  defBg: "#0a0908", pseudo: "::after"  },
    { id: "rightbar",  key: "RightBar",  selector: "#sidebar",        bg: "full",  defBg: "#0a0908", pseudo: "::after"  },
    // Top bar + panels paint fine on the root, so they keep root painting.
    { id: "topbar",    key: "TopBar",    selector: "#wou-top-bar",    bg: "full",  defBg: "#0a0908" },
    { id: "bottombar", key: "BottomBar", selector: "#wou-dock",       bg: "full",  defBg: "#0a0908", pseudo: "::after"  },
    // Middle panels — "panels" is the GLOBAL target (all panels at once); the
    // panel* variants below override it per-panel. They MUST come after "panels"
    // in this list so their scoped rules win by source order over the global.
    { id: "panels",    key: "Panels",    selector: "#wou-inventory, #wou-bestiary, #wou-character, #wou-journal, #wou-crafting, #wou-gm-panel, #wou-map", bg: "full", defBg: "#0a0908" },
    { id: "panelInventory", key: "PanelInventory", selector: "#wou-inventory", bg: "full", defBg: "#0a0908", panelOf: "panels" },
    { id: "panelJournal",   key: "PanelJournal",   selector: "#wou-journal",   bg: "full", defBg: "#0a0908", panelOf: "panels" },
    { id: "panelCharacter", key: "PanelCharacter", selector: "#wou-character", bg: "full", defBg: "#0a0908", panelOf: "panels" },
    { id: "panelBestiary",  key: "PanelBestiary",  selector: "#wou-bestiary",  bg: "full", defBg: "#0a0908", panelOf: "panels" },
    { id: "panelMap",       key: "PanelMap",       selector: "#wou-map",       bg: "full", defBg: "#0a0908", panelOf: "panels" },
    { id: "panelCrafting",  key: "PanelCrafting",  selector: "#wou-crafting",  bg: "full", defBg: "#0a0908", panelOf: "panels" },
    { id: "foundry",   key: "Foundry",   selector: ".window-app, .application", bg: "solid", defBg: "#0a0908", foundry: true }
]);

/** The middle-panel targets shown in the Panels tab's target selector:
 *  the global "panels" plus each per-panel override. */
export const PANEL_TARGETS = Object.freeze([
    "panels", "panelInventory", "panelJournal", "panelCharacter",
    "panelBestiary", "panelMap", "panelCrafting"
]);

/** Default per-section theme object — every field optional / off. */
export const UI_SECTION_DEFAULTS = Object.freeze({
    // text / accent (each with an on-flag so "off" inherits the shipped look)
    textOn: false,    text:    "#b0a994",
    textHiOn: false,  textHi:  "#e0dac4",
    accentOn: false,  accent:  "#a88450",
    accentHiOn: false, accentHi: "#c8a878",
    // misc / decorative: dividers (hairlines, dotted separator, button rings)
    // and ornaments (gilt flourishes / parchment gold).
    dividerOn: false, divider:  "#8c8579",
    ornamentOn: false, ornament: "#b58838",
    // background: mode none|solid|gradient
    bgMode:  "none",
    bgSolid: "#0a0908",
    gradA:   "#14110d", gradB: "#0a0908", gradC: "#050402", gradAngle: 135,
    gradOpacity: 100, // 0..100 — how much the gradient shows over the base colour
    opacity: 100,     // 0..100 (percent), overall background alpha over canvas
    // image overlay
    imgUrl:  "",
    imgOpacity: 100,  // 0..100
    imgFit:  "cover"  // cover | contain | tile | stretch
});

export const IMG_FITS = Object.freeze(["cover", "contain", "tile", "stretch"]);

export const UI_CUSTOMIZER_DEFAULTS = Object.freeze({
    enabled: false,
    colors:  {},   // { "--wdm-amber": "#rrggbb", … } — only overridden tokens
    fonts:   {},   // { display: "Family Name", body: "…", mono: "…" }
    sections: {},  // { <sectionId>: { …UI_SECTION_DEFAULTS overrides } }
    css:     ""    // raw custom CSS, appended last
});

/* ───────────────────────── validation ───────────────────────── */

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Only accept plain hex — the picker never writes anything else, and this
 *  keeps a hand-edited setting from injecting `}` and breaking out of the
 *  token rule. */
export function isSafeColor(v) {
    return typeof v === "string" && HEX_RE.test(v.trim());
}

/** A font family from FontConfig.getAvailableFonts(). Allow letters, digits,
 *  spaces, hyphens — reject anything that could terminate the declaration or
 *  the quoted string (`;{}<>"'`). */
export function isSafeFontFamily(v) {
    return typeof v === "string"
        && v.trim().length > 0
        && v.length <= 100
        && !/["';{}<>]/.test(v);
}

/** Validate an image path/URL destined for CSS `url("…")`. Rejects any char
 *  that could break out of the quoted url() or inject another declaration
 *  (quotes, parens, backslash, angle brackets, semicolons) and the
 *  `javascript:` scheme. Allows plain asset paths, http(s) URLs and
 *  base64 data:image URIs. */
export function isSafeImageUrl(v) {
    if (typeof v !== "string") return false;
    const s = v.trim();
    if (!s || s.length > 4000) return false;
    if (/^\s*javascript:/i.test(s)) return false;
    // base64 image data URI: checked FIRST, before the generic blocklist below —
    // a real data URI legitimately contains ';' (the `;base64,` marker) and only
    // the safe base64 alphabet after it, so it can't break out of url("…").
    if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(s)) return true;
    // Everything else (asset paths, http[s] URLs): reject any char that could
    // terminate the quoted url() or inject another declaration.
    if (/["'()\\<>;]/.test(s)) return false;
    return /^(https?:\/\/[^\s]+|[\w./\-%@ ]+)$/i.test(s);
}

/* ───────────────────────── colour math ───────────────────────── */

/** Normalise any accepted hex (#rgb / #rrggbb / #rrggbbaa) to #rrggbb.
 *  Alpha is dropped — callers that need alpha go through hexToRgba. */
function hex6(hex) {
    let h = String(hex ?? "").trim().replace(/^#/, "");
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "#000000";
    return "#" + h.toLowerCase();
}
function _rgb(hex) {
    const h = hex6(hex).slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function _hex(r, g, b) {
    const c = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
}
const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));
/** Lighten toward white / darken toward black by `amt` (0..1). */
function lighten(hex, amt) { const [r, g, b] = _rgb(hex); return _hex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt); }
function darken(hex, amt)  { const [r, g, b] = _rgb(hex); return _hex(r * (1 - amt), g * (1 - amt), b * (1 - amt)); }
function hexToRgba(hex, a) { const [r, g, b] = _rgb(hex); return `rgba(${r}, ${g}, ${b}, ${clamp01(a).toFixed(3)})`; }

/* ───────────────────────── settings I/O ───────────────────────── */

function readTheme(key) {
    let raw = {};
    try { raw = game.settings.get(SYSTEM_ID, key) ?? {}; }
    catch (_) { raw = {}; }
    const sections = {};
    if (raw.sections && typeof raw.sections === "object") {
        for (const { id } of UI_SECTIONS) {
            const s = raw.sections[id];
            if (s && typeof s === "object") sections[id] = { ...s };
        }
    }
    return {
        enabled: !!raw.enabled,
        colors:  (raw.colors && typeof raw.colors === "object") ? { ...raw.colors } : {},
        fonts:   (raw.fonts  && typeof raw.fonts  === "object") ? { ...raw.fonts  } : {},
        sections,
        css:     typeof raw.css === "string" ? raw.css : ""
    };
}

export function getWorldTheme()  { return readTheme(UI_CUSTOMIZER_WORLD_KEY);  }
export function getClientTheme() { return readTheme(UI_CUSTOMIZER_CLIENT_KEY); }

/** Effective theme = world (if enabled) overlaid by client (if enabled),
 *  merged per-key so a client can override just the accent and inherit the
 *  rest of the GM's world base. Accepts optional overrides so the config
 *  app can preview one scope's unsaved edits against the other's stored
 *  value. */
export function computeEffectiveTheme({ world, client } = {}) {
    const w = world  ?? getWorldTheme();
    const c = client ?? getClientTheme();
    const colors = {};
    const fonts  = {};
    const sections = {};
    const cssParts = [];
    /* No master on/off gate: a scope contributes whatever overrides it holds.
     * An untouched scope has empty colors/fonts/css, so it emits nothing and
     * the shipped default stands — same end result as the old `enabled:false`,
     * but ticking a colour and saving now just works. World is the base;
     * client overlays on top, per key. */
    Object.assign(colors, w.colors);
    Object.assign(fonts,  w.fonts);
    if (w.css?.trim()) cssParts.push(w.css);
    Object.assign(colors, c.colors);
    Object.assign(fonts,  c.fonts);
    if (c.css?.trim()) cssParts.push(c.css);
    /* Sections merge per-section, per-key: a client can override just the
     * top bar's opacity and inherit the GM's world section theme for the rest. */
    for (const { id } of UI_SECTIONS) {
        const ws = w.sections?.[id], cs = c.sections?.[id];
        if (ws || cs) sections[id] = { ...(ws ?? {}), ...(cs ?? {}) };
    }
    return { colors, fonts, sections, css: cssParts.join("\n\n") };
}

/* ───────────────────────── CSS build + inject ───────────────────────── */

const KNOWN_TOKENS = new Set(UI_COLOR_TOKENS.map(t => t.token));
const FONT_BY_ROLE = Object.fromEntries(UI_FONT_ROLES.map(r => [r.role, r]));

/* Some picker rows drive MORE than one CSS token from a single control (e.g.
 * one "Vitriol" swatch recolours both the element and substance hue). Map the
 * primary token → its mirrored tokens so buildThemeCss emits them together. */
const MIRROR_TOKENS = Object.fromEntries(
    UI_COLOR_TOKENS.filter(t => Array.isArray(t.also) && t.also.length).map(t => [t.token, t.also])
);

/** Turn an effective theme into a CSS string. Only whitelisted tokens and
 *  known font roles are emitted, each value revalidated at build time. Custom
 *  CSS is appended verbatim (the author owns it; it's injected via textContent
 *  below so a stray `</style>` can't break out). */
export function buildThemeCss(eff) {
    const decls = [];
    for (const [token, value] of Object.entries(eff.colors ?? {})) {
        if (!KNOWN_TOKENS.has(token)) continue;
        if (!isSafeColor(value)) continue;
        const v = value.trim();
        decls.push(`  ${token}: ${v};`);
        // Mirror the same value onto any linked tokens (e.g. substance hues).
        for (const extra of (MIRROR_TOKENS[token] ?? [])) decls.push(`  ${extra}: ${v};`);
    }
    for (const [role, family] of Object.entries(eff.fonts ?? {})) {
        const meta = FONT_BY_ROLE[role];
        if (!meta) continue;
        if (isSafeFontFamily(family))
            decls.push(`  ${meta.token}: '${family.trim()}', ${meta.generic};`);
    }
    let css = "";
    if (decls.length)
        /* Selector is deliberately MORE specific than tokens.css's
         * `body.witcher-ttrpg-death-march` (adds `html`, +1 element) so the
         * override wins by specificity, not just source order. Foundry can
         * (re)inject system stylesheets after our <style>, which would let an
         * equal-specificity rule beat us on order — this makes the override
         * reliably win regardless of load order. Custom properties set here
         * cascade to every descendant (windows + chrome) that reads them. */
        css += `html body.witcher-ttrpg-death-march {\n${decls.join("\n")}\n}\n`;
    const sectionCss = buildSectionCss(eff.sections);
    if (sectionCss) css += `\n/* ── UI Customizer · per-section ── */\n${sectionCss}`;
    if (typeof eff.css === "string" && eff.css.trim())
        css += `\n/* ── UI Customizer · custom CSS ── */\n${eff.css}\n`;
    return css;
}

/* ───────────────────────── per-section emission ───────────────────────── */

/** background-size / -repeat / -position for one image `fit` mode. */
function fitProps(fit) {
    switch (fit) {
        case "contain": return { size: "contain",   repeat: "no-repeat", position: "center" };
        case "tile":    return { size: "auto",       repeat: "repeat",    position: "top left" };
        case "stretch": return { size: "100% 100%", repeat: "no-repeat", position: "center" };
        case "cover":
        default:        return { size: "cover",      repeat: "no-repeat", position: "center" };
    }
}

/** Text/accent → the --wdm-* ink/amber ramp, scoped to a section. The user
 *  picks one Text and one Accent (plus optional bright variants); the dim /
 *  faint / bright steps are derived so a section reads coherently. */
function sectionVarDecls(sec) {
    const d = [];
    if (sec.textOn && isSafeColor(sec.text)) {
        const t = hex6(sec.text);
        const hi = (sec.textHiOn && isSafeColor(sec.textHi)) ? hex6(sec.textHi) : lighten(t, 0.25);
        d.push(`--wdm-ink: ${t};`);
        d.push(`--wdm-ink-dim: ${darken(t, 0.18)};`);
        d.push(`--wdm-ink-faint: ${darken(t, 0.4)};`);
        d.push(`--wdm-ink-hi: ${hi};`);
        d.push(`--wdm-ink-bright: ${lighten(hi, 0.15)};`);
    } else if (sec.textHiOn && isSafeColor(sec.textHi)) {
        const hi = hex6(sec.textHi);
        d.push(`--wdm-ink-hi: ${hi};`);
        d.push(`--wdm-ink-bright: ${lighten(hi, 0.15)};`);
    }
    if (sec.accentOn && isSafeColor(sec.accent)) {
        const a = hex6(sec.accent);
        const hi = (sec.accentHiOn && isSafeColor(sec.accentHi)) ? hex6(sec.accentHi) : lighten(a, 0.15);
        d.push(`--wdm-amber: ${a};`);
        d.push(`--wdm-amber-dim: ${darken(a, 0.3)};`);
        d.push(`--wdm-amber-hi: ${hi};`);
        d.push(`--wdm-amber-bright: ${lighten(hi, 0.15)};`);
    } else if (sec.accentHiOn && isSafeColor(sec.accentHi)) {
        const hi = hex6(sec.accentHi);
        d.push(`--wdm-amber: ${hi};`);
        d.push(`--wdm-amber-hi: ${hi};`);
        d.push(`--wdm-amber-bright: ${lighten(hi, 0.15)};`);
    }
    // Dividers: hairlines, the dotted hotkey separator and button-ring circles
    // all read `rgb(from var(--wdm-divider) …)`, so one hue recolours them.
    if (sec.dividerOn && isSafeColor(sec.divider)) d.push(`--wdm-divider: ${hex6(sec.divider)};`);
    // Ornaments: the gilt flourish ramp.
    if (sec.ornamentOn && isSafeColor(sec.ornament)) {
        const g = hex6(sec.ornament);
        d.push(`--wdm-gilt: ${g};`);
        d.push(`--wdm-gilt-hi: ${lighten(g, 0.2)};`);
        d.push(`--wdm-gilt-dk: ${darken(g, 0.45)};`);
    }
    return d;
}

/** Compose a section's background as stacked CSS background layers, top→bottom:
 *  [ image veil, image, gradient overlay, base colour ]. The base colour is the
 *  bottom fill; in gradient mode a gradient (with its OWN opacity) sits over it,
 *  so you control how much gradient shows on the colour. The overall section
 *  opacity is baked into every tint layer's alpha (canvas shows through);
 *  image opacity is a veil of the base colour fading the image toward it.
 *  Returns a { prop: value } map of background longhands, or null if nothing set. */
function composeBackground(sec) {
    const op = clamp01((sec.opacity ?? 100) / 100);
    const mode = sec.bgMode === "solid" || sec.bgMode === "gradient" ? sec.bgMode : "none";
    const hasImg = isSafeImageUrl(sec.imgUrl);
    if (mode === "none" && !hasImg) return null;

    const baseColor = hex6(sec.bgSolid || "#0a0908");
    // Tint layers (top→bottom): optional gradient overlay, then the base colour.
    const tint = [];
    if (mode === "gradient") {
        const gOp = clamp01((sec.gradOpacity ?? 100) / 100) * op;   // gradient-over-colour × overall
        const a = hex6(sec.gradA), b = hex6(sec.gradB), c = hex6(sec.gradC);
        const ang = Math.max(0, Math.min(360, Math.round(Number(sec.gradAngle) || 0)));
        tint.push(`linear-gradient(${ang}deg, ${hexToRgba(a, gOp)}, ${hexToRgba(b, gOp)}, ${hexToRgba(c, gOp)})`);
        tint.push(`linear-gradient(${hexToRgba(baseColor, op)}, ${hexToRgba(baseColor, op)})`);
    } else if (mode === "solid") {
        tint.push(`linear-gradient(${hexToRgba(baseColor, op)}, ${hexToRgba(baseColor, op)})`);
    }

    const imgLayers = [], sizes = [], repeats = [], positions = [];
    if (hasImg) {
        const imgOp = clamp01((sec.imgOpacity ?? 100) / 100);
        const veilA = op * (1 - imgOp);
        if (veilA > 0.001) {
            imgLayers.push(`linear-gradient(${hexToRgba(baseColor, veilA)}, ${hexToRgba(baseColor, veilA)})`);
            sizes.push("cover"); repeats.push("no-repeat"); positions.push("center");
        }
        const f = fitProps(sec.imgFit);
        imgLayers.push(`url("${sec.imgUrl.trim()}")`);
        sizes.push(f.size); repeats.push(f.repeat); positions.push(f.position);
    }
    for (const layer of tint) {
        imgLayers.push(layer);
        sizes.push("cover"); repeats.push("no-repeat"); positions.push("center");
    }
    if (!imgLayers.length) return null;
    return {
        "background-image":    imgLayers.join(", "),
        "background-size":     sizes.join(", "),
        "background-repeat":   repeats.join(", "),
        "background-position": positions.join(", "),
        "background-color":    "transparent"
    };
}

/** Raise a selector's specificity so our injected rule beats the section's own
 *  `!important` background (e.g. leftbar/sidebar set `background … !important` at
 *  `body.class.state #id`). We double the trailing id/class and prefix `html`,
 *  which outranks those rules; being injected last also wins equal ties. */
function boostPart(part) {
    const p = part.trim();
    // Triple the trailing id / double the class so we outrank even a
    // `body.class.state #id` author rule (leftbar/sidebar set `background …
    // !important` there). Being injected last also wins any true tie.
    const id = p.match(/#[\w-]+$/);
    if (id) return `html body.witcher-ttrpg-death-march ${p}${id[0]}${id[0]}`;
    const cl = p.match(/\.[\w-]+$/);
    if (cl) return `html body.witcher-ttrpg-death-march ${p}${cl[0]}${cl[0]}`;
    return `html body.witcher-ttrpg-death-march ${p}`;
}
function scopedSelector(selector, suffix = "") {
    return selector.split(",").map(s => boostPart(s) + suffix).join(",\n");
}

/** Build the scoped CSS for every configured section. */
export function buildSectionCss(sections) {
    if (!sections || typeof sections !== "object") return "";
    const blocks = [];
    for (const meta of UI_SECTIONS) {
        const sec = sections[meta.id];
        if (!sec || typeof sec !== "object") continue;
        const sel = scopedSelector(meta.selector);
        const lines = [];

        // Every section gets the scoped --wdm-* overrides. For Foundry windows
        // the ink/amber vars are mostly inert (native chrome doesn't read them),
        // but --wdm-divider / --wdm-gilt DO drive the sheet borders/ornaments we
        // rewired to those tokens, so they recolour here too.
        for (const v of sectionVarDecls(sec)) lines.push(`  ${v}`);
        if (meta.foundry && sec.textOn && isSafeColor(sec.text)) {
            // Foundry windows don't read --wdm-ink; set concrete text colour + a
            // couple of core text vars so sheet body copy follows suit.
            const t = hex6(sec.text);
            lines.push(`  color: ${t} !important;`);
            lines.push(`  --color-text-primary: ${t};`);
            lines.push(`  --color-text-dark-primary: ${t};`);
        }

        // When a background colour/gradient is set, also scope the --wdm-bg token
        // family to this section. Many surfaces (especially the sidebar's inner
        // panels, chat, tab content) paint `rgb(from var(--wdm-bg) …)` on CHILD
        // elements that would otherwise cover the root background-image we set
        // below — recolouring the token makes the WHOLE section follow the chosen
        // colour, not just its root plate. Skipped for Foundry (native windows
        // don't read --wdm-bg; their background is set concretely).
        const bgMode = (sec.bgMode === "solid" || sec.bgMode === "gradient") ? sec.bgMode : "none";
        if (!meta.foundry && bgMode !== "none") {
            const base = hex6(sec.bgSolid || meta.defBg || "#0a0908");
            lines.push(`  --wdm-bg: ${base};`);
            lines.push(`  --wdm-bg-lifted: ${lighten(base, 0.08)};`);
            lines.push(`  --wdm-bg-deep: ${darken(base, 0.35)};`);
            lines.push(`  --wdm-void: ${darken(base, 0.55)};`);
        }

        const bg = composeBackground(sec);
        if (bg) {
            if (meta.foundry || !meta.pseudo) {
                // Foundry windows: paint concretely on the root.
                for (const [k, val] of Object.entries(bg)) lines.push(`  ${k}: ${val} !important;`);
            } else {
                // Chrome bars/panels are position:fixed + zoomed; painting the
                // background on the root itself mispaints ("off-centre") and
                // fights the shipped !important plate. Instead clear the root's
                // background and paint the composed background on an
                // absolutely-positioned pseudo-element backdrop (z-index:-1 →
                // behind content, above the root's own background box).
                lines.push(`  background: transparent !important;`);
                const pdecls = [
                    `  content: ""`,
                    `  position: absolute`,
                    `  inset: 0`,
                    `  z-index: -1`,
                    `  pointer-events: none`,
                    `  border-radius: inherit`
                ];
                for (const [k, val] of Object.entries(bg)) pdecls.push(`  ${k}: ${val}`);
                blocks.push(`${scopedSelector(meta.selector, meta.pseudo)} {\n${pdecls.join(";\n")};\n}`);
            }
        }

        if (lines.length) blocks.push(`${sel} {\n${lines.join("\n")}\n}`);

        // Foundry accent → window header border + title colour (extra rule; the
        // native header isn't reachable from the root var cascade).
        if (meta.foundry && sec.accentOn && isSafeColor(sec.accent)) {
            const a = hex6(sec.accent);
            const titleC = (sec.accentHiOn && isSafeColor(sec.accentHi)) ? hex6(sec.accentHi) : lighten(a, 0.3);
            blocks.push(
                `${scopedSelector(".window-app")} .window-header,\n` +
                `${scopedSelector(".application")} .window-header {\n` +
                `  border-color: ${a} !important;\n  color: ${titleC} !important;\n}`);
        }
    }
    return blocks.length ? blocks.join("\n") + "\n" : "";
}

function writeStyle(elId, css) {
    let el = document.getElementById(elId);
    if (!css) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement("style");
        el.id = elId;
        document.head.appendChild(el);
    } else if (el !== document.head.lastElementChild) {
        /* Keep our override last so it wins equal-specificity cascades over
         * the shipped stylesheets. */
        document.head.appendChild(el);
    }
    // textContent (not innerHTML) → injection-safe for the custom-CSS blob.
    el.textContent = css;
}

/** (Re)inject the persisted theme. Called on ready and from every setting's
 *  onChange, so GM world edits propagate live to all clients and a player's
 *  own override applies without a reload. */
export function applyUiCustomizer() {
    try {
        writeStyle(STYLE_EL_ID, buildThemeCss(computeEffectiveTheme()));
        // A live persist supersedes any preview overlay.
        clearUiCustomizerPreview();
    } catch (err) {
        console.warn(`${SYSTEM_ID} | ui-customizer apply failed`, err);
    }
}

/** Live, non-persisted preview used by the config dialog while editing. */
export function previewUiCustomizer(effective) {
    try { writeStyle(PREVIEW_EL_ID, buildThemeCss(effective)); }
    catch (err) { console.warn(`${SYSTEM_ID} | ui-customizer preview failed`, err); }
}

export function clearUiCustomizerPreview() {
    document.getElementById(PREVIEW_EL_ID)?.remove();
}

/* ───────────────────────── font choices ───────────────────────── */

/** Every font family Foundry currently has loaded — core fonts,
 *  CONFIG.fontDefinitions, and the world's custom-added fonts. Sorted for
 *  the dropdown. Empty array if the API isn't reachable. */
export function availableFontChoices() {
    try {
        const FC = foundry.applications.settings.menus.FontConfig;
        const fonts = FC?.getAvailableFonts?.() ?? [];
        return Array.from(fonts).filter(isSafeFontFamily)
            .sort((a, b) => a.localeCompare(b));
    } catch (_) {
        return [];
    }
}
