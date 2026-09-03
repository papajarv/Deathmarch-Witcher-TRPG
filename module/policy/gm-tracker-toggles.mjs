/**
 * Shared combat-tracker GM toggle bar.
 *
 * The GM view/combat toggles (FOV Token Hide, Off-Turn Move, …) each live in
 * their own module but should read as ONE tidy row of labelled buttons in the
 * tracker header — not a scatter of separate icon squares. This module owns the
 * single flex container they all drop into, plus the shared button styling, so
 * they line up side by side with text like the rest of the header controls.
 */

const BAR_ID = "wdm-ct-gm-toggles";

/** Get (or lazily create) the shared toggle row inside the tracker header.
 *  Placed just above the encounter-controls block, matching where the
 *  "Take control on turn" checkbox sits. Returns null if there's no host. */
export function ensureGmToggleBar(html) {
    const host = (html instanceof HTMLElement) ? html : html?.[0] ?? null;
    if (!host) return null;
    const header = host.querySelector("header.combat-tracker-header, .combat-tracker-header, header") ?? host;
    let bar = header.querySelector(`#${BAR_ID}`);
    if (!bar) {
        bar = document.createElement("div");
        bar.id = BAR_ID;
        bar.style.cssText = [
            "display:flex",
            "flex-wrap:nowrap",       // one tidy horizontal row
            "gap:0.25rem",
            "align-items:stretch",    // equal-height buttons
            "justify-content:center",
            "padding:0.28rem 0.4rem",
            "width:100%",
            "box-sizing:border-box"
        ].join(";");
        const before = header.querySelector(".encounter-controls")
                    ?? header.querySelector("nav.encounters")?.nextElementSibling
                    ?? null;
        if (before) header.insertBefore(bar, before);
        else header.prepend(bar);
    }
    return bar;
}

/** Apply the shared compact text-button look to a tracker toggle. */
export function styleGmToggleButton(btn) {
    btn.classList.add("wdm-ct-gm-toggle");
    btn.style.cssText = [
        /* Size to content but ALLOW shrinking so 3+ buttons stay on one row in
         * the narrow tracker — they only give up width (min-width:0 + overflow)
         * when the row would otherwise overflow, instead of wrapping. */
        "flex:0 1 auto",
        "min-width:0",
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "gap:0.28rem",
        "padding:0.2rem 0.3rem",
        "font-family:var(--wdm-font-display,\"Bebas Neue\",sans-serif)",
        "font-size:0.7rem",
        "letter-spacing:0.02em",
        "text-transform:uppercase",
        "line-height:1.15",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
        "color:var(--wdm-ink-hi,#cac4b0)",
        "background:linear-gradient(180deg,rgba(22,18,13,0.96),rgba(10,9,8,0.96))",
        "border:1px solid var(--wdm-amber-dim,#6e5224)",
        "border-radius:2px",
        "cursor:pointer"
    ].join(";");
}

/** Reflect on/off state via border + text colour (amber = engaged). */
export function paintGmToggleState(btn, on) {
    btn.dataset.state = on ? "on" : "off";
    btn.style.borderColor = on ? "var(--wdm-amber,#c8a24a)" : "var(--wdm-amber-dim,#6e5224)";
    btn.style.color       = on ? "var(--wdm-amber,#c8a24a)" : "var(--wdm-ink-hi,#cac4b0)";
}
