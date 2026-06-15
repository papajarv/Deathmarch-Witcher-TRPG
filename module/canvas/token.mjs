/**
 * WitcherToken — tints the two resource bars in the system palette so they
 * read at a glance instead of both rendering near-grey.
 *
 *   • Vitality (HP, `derivedStats.hp`, bottom bar / index 0) → blood red,
 *     brightening as it fills.
 *   • Stamina  (STA, `derivedStats.sta`, top bar / index 1)  → amber/gold,
 *     brightening as it fills.
 *
 * The geometry (sizing, rounded-rect backing, position) is kept verbatim from
 * the Foundry v14 Token#_drawBar (build 14.363) — only the fill colour is
 * replaced. Colour selection keys off the bound attribute path first, so it
 * stays correct even if a user swaps which attribute a bar shows; it falls
 * back to the bar index for any other attribute.
 */

const HP_ATTR  = "derivedStats.hp";
const STA_ATTR = "derivedStats.sta";

/* Empty → full RGB ramps (0..1 components). Distinct hues so the two bars are
 * never confusable: red for vitality, gold for stamina. */
const VITALITY = { lo: [0.30, 0.10, 0.08], hi: [0.78, 0.24, 0.24] };
const STAMINA  = { lo: [0.28, 0.20, 0.08], hi: [0.85, 0.66, 0.30] };

const lerp = (a, b, t) => a + ((b - a) * t);
const ramp = ({ lo, hi }, pct) =>
    foundry.utils.Color.fromRGB([
        lerp(lo[0], hi[0], pct),
        lerp(lo[1], hi[1], pct),
        lerp(lo[2], hi[2], pct)
    ]);

export class WitcherToken extends foundry.canvas.placeables.Token {
    /** @override — geometry copied from core; only the fill colour differs. */
    _drawBar(index, bar, data) {
        const val = Number(data.value);
        const pct = Math.clamp(val, 0, data.max) / data.max;

        // Determine sizing (verbatim from core).
        const { width, height } = this.document.getSize();
        const s  = canvas.dimensions.uiScale;
        const bw = width;
        const bh = 8 * (this.document.height >= 2 ? 1.5 : 1) * s;

        // Pick the palette: prefer the bound attribute, fall back to bar index.
        const attr = data.attribute;
        let ramped;
        if      (attr === HP_ATTR)  ramped = VITALITY;
        else if (attr === STA_ATTR) ramped = STAMINA;
        else                        ramped = index === 0 ? VITALITY : STAMINA;
        const color = ramp(ramped, pct);

        // Draw the bar (verbatim from core).
        bar.clear();
        bar.lineStyle(s, 0x000000, 1.0);
        bar.beginFill(0x000000, 0.5).drawRoundedRect(0, 0, bw, bh, 3 * s);
        bar.beginFill(color, 1.0).drawRoundedRect(0, 0, pct * bw, bh, 2 * s);

        // Set position (verbatim from core).
        const posY = index === 0 ? height - bh : 0;
        bar.position.set(0, posY);
    }
}

/* The token HUD (click a token) shows bar1 + bar2 as bare number inputs with no
 * label, so the two values are indistinguishable. Prepend a small icon to each,
 * chosen from the attribute the bar is actually bound to (token bar config) —
 * so swapping a bar to a different stat updates its icon too. Unmapped stats
 * fall back to a generic gauge labelled with the attribute path. */
const STAT_ICONS = {
    "derivedStats.hp":             { icon: "fa-heart-pulse",       label: "Vitality",        color: "hp" },
    "derivedStats.sta":            { icon: "fa-bolt",              label: "Stamina",         color: "sta" },
    "derivedStats.focus":          { icon: "fa-brain",             label: "Focus",           color: "focus" },
    "derivedStats.vigor":          { icon: "fa-hand-sparkles",     label: "Vigor",           color: "focus" },
    "derivedStats.stun":           { icon: "fa-dizzy",             label: "Stun",            color: "default" },
    "derivedStats.rec":            { icon: "fa-heart-circle-plus", label: "Recovery",        color: "default" },
    "derivedStats.enc":            { icon: "fa-weight-hanging",    label: "Encumbrance",     color: "default" },
    "derivedStats.resolve":        { icon: "fa-shield-heart",      label: "Resolve",         color: "default" },
    "derivedStats.woundThreshold": { icon: "fa-heart-crack",       label: "Wound Threshold", color: "hp" },
    "adrenaline.value":            { icon: "fa-fire",              label: "Adrenaline",      color: "hp" },
    "stats.body":                  { icon: "fa-dumbbell",          label: "Body",            color: "default" },
    "stats.ref":                   { icon: "fa-person-running",    label: "Reflex",          color: "default" },
    "stats.dex":                   { icon: "fa-hand",              label: "Dexterity",       color: "default" },
    "stats.int":                   { icon: "fa-lightbulb",         label: "Intelligence",    color: "default" },
    "stats.will":                  { icon: "fa-brain",             label: "Will",            color: "focus" },
    "stats.spd":                   { icon: "fa-gauge-high",        label: "Speed",           color: "default" },
    "stats.emp":                   { icon: "fa-face-smile",        label: "Empathy",         color: "default" },
    "stats.cra":                   { icon: "fa-hammer",            label: "Craft",           color: "default" },
    "stats.luck":                  { icon: "fa-clover",            label: "Luck",            color: "default" }
};

function iconForAttribute(attr) {
    if (!attr) return null;
    if (STAT_ICONS[attr]) return STAT_ICONS[attr];
    // Unmapped but valid attribute — generic gauge, labelled with the leaf name.
    const leaf = String(attr).split(".").pop();
    return { icon: "fa-gauge-simple-high", label: leaf, color: "default" };
}

function decorateTokenHudBars(app, element) {
    const root = element instanceof HTMLElement ? element : element?.[0];
    const doc  = app?.object?.document ?? app?.document;
    if (!root || !doc) return;
    for (const key of ["bar1", "bar2"]) {
        const box   = root.querySelector(`.attribute.${key}`);
        const input = box?.querySelector("input");
        if (!box || !input) continue;
        box.querySelector(".wdm-bar-icon")?.remove();   // re-derive on every render
        const spec = iconForAttribute(doc[key]?.attribute);
        if (!spec) continue;
        const i = document.createElement("i");
        i.className = `fa-solid ${spec.icon} wdm-bar-icon is-${spec.color}`;
        i.setAttribute("title", spec.label);
        i.setAttribute("aria-label", spec.label);
        box.insertBefore(i, input);
    }
}

/** Install the canvas Token object class + HUD bar labels. Call during `init`. */
export function registerWitcherToken() {
    CONFIG.Token.objectClass = WitcherToken;
    Hooks.on("renderTokenHUD", decorateTokenHudBars);
}
