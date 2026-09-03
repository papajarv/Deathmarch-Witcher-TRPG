/**
 * Carousel Initiative — horizontal combatant strip anchored to the top of
 * the screen, glued to the underside of the chrome top bar (or Foundry's
 * scene navigation as fallback when chrome is off).
 *
 * Positioning:
 *   The carousel is a fixed-position DOM element sitting outside the canvas
 *   tree. Its `top` is set from the anchor element's bounding rect (bottom
 *   edge). A `ResizeObserver` on the anchor catches size changes (collapse
 *   animation frames), and a `MutationObserver` on `body.classList` catches
 *   the chrome topbar's open/close class toggle. When the anchor is fully
 *   collapsed or absent, the carousel sits at `top: 0`. Left/right is
 *   centered on the viewport via `translateX(-50%)`.
 *
 * Visibility:
 *   Rendered only when `game.combat?.started` is true. Removed from the
 *   DOM (not just display:none) when combat ends. Late combat hydration
 *   on login is caught by hooks on `canvasReady`, `renderCombatTracker`,
 *   and a short retry after `ready` — Foundry sometimes populates
 *   `game.combat` on a tick after the ready hook.
 *
 * Hidden combatants:
 *   Combatants that are secret/stealthed/GM-hidden are FILTERED OUT for
 *   non-GMs (both here and in the sidebar tracker, via the
 *   `renderCombatTracker` hook below). For GMs they render with a subtle
 *   eye-slash indicator so the GM knows they're hidden from the players.
 *   Detection folds three signals:
 *     - `combatant.hidden`             (GM-set combatant hidden flag)
 *     - disposition === SECRET          (token-level "don't show players")
 *     - isStealthed(actor)              (this system's stealth mechanic)
 *
 * Interaction:
 *   Left-click card  → control the combatant's token + pan camera to it
 *   Right-click card → open the actor sheet
 *   Middle-click     → toggle the token as a target (matches the canvas
 *                       middle-click semantics in canvas-token-middle-click)
 *
 * Portrait frame is disposition-colored (red HOSTILE / green FRIENDLY /
 * amber NEUTRAL / violet SECRET) so the initiative strip carries the same
 * at-a-glance color language as the token halos on the canvas.
 */

import { isStealthed, getStealthState } from "../../mechanics/stealth.mjs";
import { getCarouselConfig } from "../../mechanics/carousel-initiative-config.mjs";

const SYSTEM_ID    = "witcher-ttrpg-death-march";
const CAROUSEL_ID  = "wdm-carousel-init";
const STYLE_ID     = "wdm-carousel-init-style";
/* Anchor selectors in preference order — the chrome topbar wins when
 * present (it's what actually renders at the top for users with chrome
 * enabled); Foundry's scene navigation is the fallback for worlds with
 * chrome disabled or before topbar injection. */
const ANCHOR_SELECTORS = ["#wou-top-bar", "#navigation"];

let _carousel        = null;
let _navObserver     = null;
let _bodyClassObserver = null;
let _currentAnchor   = null;
let _sidebarPatchInstalled = false;
let _sidebarMutationObserver = null;
let _sidebarRefilterScheduled = false;
/* Round/combat tracking so we can detect wrap-arounds. When the round
 * ticks over (N → 1 turn wrap), the natural "animate strip transform
 * from current to target" motion is a big rightward slingshot across
 * the whole strip. Instead we snap the strip back to first-centered
 * without animation on wrap, which reads as "returns to the start". */
let _lastCombatId = null;
let _lastRound    = null;

/* Transparent so neutrals get no visible frame while the layout stays
 * stable (border-width still reserves 2px, no size shift between
 * neutral and colored cards). */
const DEFAULT_BORDER = "transparent";

/* Resolve the border CSS color for a combatant from the current live
 * carousel config. HOSTILE / FRIENDLY / SECRET pull their own colors;
 * NEUTRAL uses the configured neutral color only when neutralShowFrame
 * is enabled, otherwise stays transparent. Reading fresh per call so
 * GM color edits take effect on the next render without a reload. */
function dispositionBorderFrom(cfg, disposition) {
    switch (disposition) {
        case -2: return cfg.secretColor   || "#7a4a9a";
        case -1: return cfg.hostileColor  || "#e04040";
        case  1: return cfg.friendlyColor || "#3ec25a";
        case  0: return cfg.neutralShowFrame ? (cfg.neutralColor || "#d4a844") : DEFAULT_BORDER;
        default: return DEFAULT_BORDER;
    }
}

/* ── Hidden-from-player detection ─────────────────────────────────────── */

/* True if this combatant has a live token on a scene. Both disposition
 * and stealth are token-scoped concepts (disposition IS a token
 * property; stealth means "hidden from being SEEN on the map"), so
 * neither should apply to a tokenless / theater-of-the-mind combatant.
 * Foundry's `combatant.token` returns null when no scene token exists,
 * OR a synthetic token from the actor's prototype in some paths — the
 * `.parent` check filters to only tokens actually placed on a scene. */
function combatantHasSceneToken(combatant) {
    const t = combatant?.token;
    return !!(t && t.parent);
}

/* Whether a combatant should be hidden from THIS user. Called per-render;
 * result is per-user (owners of a spotter see stealthed combatants that
 * their character has spotted, other players don't). GM always sees
 * everything. Tokenless combatants are visible to everyone (only the
 * explicit GM `combatant.hidden` flag can hide them). */
function isCombatantHiddenFromCurrentUser(combatant) {
    if (!combatant) return false;
    if (game.user?.isGM) return false;
    if (combatant.hidden) return true;
    /* Tokenless — theater-of-the-mind. No map presence, no disposition
     * or stealth logic applies. */
    if (!combatantHasSceneToken(combatant)) return false;
    const cfg = getCarouselConfig();
    const tokenDoc = combatant.token;
    const disposition = Number(tokenDoc?.disposition ?? 0);
    if (disposition === -2 && cfg.hideSecretFromPlayers) return true;
    /* Stealthed → hidden UNLESS the current user owns an actor that has
     * spotted this stealther. Mirrors the token-visibility gate in
     * policy/stealth-token-visibility.mjs so the initiative UI stays in
     * lockstep with what the user can actually see on the canvas.
     * Owners of the stealther always see themselves (they know they're
     * hiding); other players' visibility depends on spottedBy IF the
     * respectSpotterVisibility flag is on. */
    if (!cfg.hideStealthFromPlayers) return false;
    try {
        const actor = combatant.actor;
        if (!actor || !isStealthed?.(actor)) return false;
        /* Owner of the stealther always sees */
        if (actor.testUserPermission?.(game.user, "OWNER")) return false;
        if (cfg.respectSpotterVisibility) {
            /* Any user-owned actor in the stealther's spottedBy → visible */
            const state = getStealthState?.(actor);
            if (state?.spottedBy?.length) {
                for (const other of (game.actors?.values?.() ?? [])) {
                    if (!other?.testUserPermission?.(game.user, "OWNER")) continue;
                    if (state.spottedBy.includes(other.uuid)) return false;
                }
            }
        }
        return true;   /* stealthed and no qualifying spotter */
    } catch (_) { /* stealth module edge case */ }
    return false;
}

/* GM-oriented "would this be hidden from someone" — used to badge a
 * combatant with the eye-slash indicator in the GM's own view when
 * players can't see them (SECRET / stealthed / GM-hidden), regardless
 * of THIS user (a GM) being able to see them. Same tokenless carve-out
 * as isCombatantHiddenFromCurrentUser — a tokenless combatant is never
 * hidden from any player by disposition or stealth. Respects the same
 * hideSecret / hideStealth config flags. */
function isCombatantHiddenFromAnyPlayer(combatant) {
    if (!combatant) return false;
    if (combatant.hidden) return true;
    if (!combatantHasSceneToken(combatant)) return false;
    const cfg = getCarouselConfig();
    const tokenDoc = combatant.token;
    const disposition = Number(tokenDoc?.disposition ?? 0);
    if (disposition === -2 && cfg.hideSecretFromPlayers) return true;
    if (cfg.hideStealthFromPlayers) {
        try { if (isStealthed?.(combatant.actor)) return true; } catch (_) {}
    }
    return false;
}

/* ── DOM ─────────────────────────────────────────────────────────────── */

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
        /* Container is a floating group with NO background / border / box.
         * Top padding is generous enough that the active card scaled to
         * 1.4x doesn't reach up into the topbar (card is 5.5rem tall;
         * 40% growth = ~2.2rem extra height; origin center splits that
         * half up / half down, so ~1.1rem of upward growth needs
         * clearing). */
        #${CAROUSEL_ID} {
            /* Fixed baseline font-size so every em inside the carousel
             * resolves to a raw pixel value that is INDEPENDENT of the
             * html font-size chain (which multiplies rem by --wdm-scale).
             * Consequence: the container's own transform: scale is the
             * only scaling applied — one slider input, one visual
             * output, identical in every mode. */
            font-size: 16px;
            position: fixed;
            top: var(--wdm-carousel-top, 0px);
            left: 50%;
            /* transform composes -50% (horizontal centering on the
             * viewport) with scale(S) via --wdm-cini-scale — set inline
             * by updateCarouselScale() so live UI Scale slider changes
             * reactively invalidate layout. transform-origin: top
             * center keeps the container's visual top-center anchored
             * at (50vw, --wdm-carousel-top) regardless of scale. */
            transform: translateX(-50%) scale(var(--wdm-cini-scale, 1));
            transform-origin: top center;
            z-index: 30;
            display: flex;
            flex-direction: column;
            align-items: center;
            /* Gap between the strip and the GM control row. Must exceed
             * the active card's downward scale growth (~1.1rem for a
             * 5.5em card at scale 1.4) or the scaled card overlaps the
             * buttons. 1.5em gives clean visual separation. */
            gap: 1.5em;
            /* Vertical padding must accommodate the active card's UP
             * growth (top) and clear space for its DOWN growth (bottom)
             * without clipping. 1.5em on each end matches the scale
             * budget for the current card height + scale factor. */
            padding: 1.5em 0 1.5em 0;
            /* Fixed width so the strip has a stable center to align to.
             * Content that exceeds this clips to hidden — the past/future
             * cards slide off-screen as turns advance. The default and
             * the applyConfigStyles override both divide the vw ceiling
             * by --wdm-cini-scale (the carousel's effective zoom, set
             * inline by updateCarouselScale) so the visual width stays
             * within 88% of the viewport regardless of zoom. */
            width: var(--wdm-cini-max-w,
                       min(56em, calc(88vw / var(--wdm-cini-scale, 1))));
            /* Container itself doesn't capture events — children opt in
             * with pointer-events: auto so canvas clicks pass through
             * empty carousel regions. */
            pointer-events: none;
            overflow: hidden;
            transition: top var(--wdm-dur-slow, 0.2s)
                        var(--wdm-ease, cubic-bezier(.2,.6,.25,1));
        }

        /* Strip is the persistent horizontal row of cards. Never re-created
         * across renders (only its innerHTML changes) so its transform value
         * survives updates. justify-content: center makes small combatant
         * lists sit at container center naturally (few cards, no scroll);
         * for larger lists the JS transform overrides to center the active
         * card specifically. */
        .wdm-cini-strip {
            display: flex;
            gap: var(--wdm-cini-gap, 0.5em);
            align-items: center;
            justify-content: center;
            transform: translateX(0);
            transition: transform var(--wdm-cini-transition, 320ms) cubic-bezier(.2,.6,.25,1);
            will-change: transform;
            pointer-events: auto;
        }

        /* Base card — moderate size. Active card scales up dramatically
         * for the "whose turn" cue. transform-origin: center bottom so
         * the scale-up does not shift the card's visual baseline. */
        .wdm-cini-card {
            position: relative;
            width:  var(--wdm-cini-card-w, 4.25em);
            /* min-height, NOT a fixed height: the guard-stance chip
             * (policy/combat-tracker-guards.mjs) is appended as an extra
             * bottom row that the original portrait+name+init layout
             * didn't budget for. With a fixed height that row overflowed
             * the card and got clipped by the container's overflow-hidden
             * mask. Sizing to content lets the card grow just enough to
             * hold the guard row, so nothing lands in the mask. */
            min-height: var(--wdm-cini-card-h, 5.5em);
            display: flex; flex-direction: column;
            align-items: center; justify-content: flex-start;
            padding: 0.1875em;
            background: rgba(0,0,0,0.55);
            border: 1px solid rgba(140,133,121,0.3);
            border-radius: 5px;
            cursor: pointer;
            transition: transform 220ms cubic-bezier(.2,.6,.25,1),
                        border-color 120ms, box-shadow 120ms, filter 120ms, opacity 120ms;
            user-select: none;
            flex: 0 0 auto;
            /* transform-origin center so scale grows equally in all four
             * directions from the card's midpoint. Container has enough
             * top padding to accommodate the upward growth. */
            transform-origin: center;
        }
        .wdm-cini-card:hover {
            border-color: rgba(168, 132, 80, 0.8);
        }
        .wdm-cini-card.is-active {
            transform: scale(var(--wdm-cini-active-scale, 1.4));
            z-index: 3;
            /* Opaque background. The active card scales up 1.4x and
             * overlaps its neighbours; base cards are translucent
             * (rgba(0,0,0,0.55)), so the overlap stacked two translucent
             * layers and read as darker additive edges. A solid bg lets the
             * on-top active card cover its neighbours cleanly. */
            background: #0a0907;
            border-color: var(--wdm-cini-active-glow, #e0b060);
        }
        /* Active glow as a COMPOSITED LAYER, not a live box-shadow on the card.
         * The blurred shadow lives on a ::before pseudo promoted to its own
         * layer (will-change), so it's rasterized once and merely composited —
         * it does NOT repaint when the card's content (portrait / HP / guard)
         * changes. Same halo as before (the pseudo tracks the card box via
         * inset:0 and scales with the card's transform); a plain opacity fade
         * replaces the old box-shadow transition. Sits behind the card content
         * (::before paints before content) so its outward halo rings the card. */
        .wdm-cini-card::before {
            content: "";
            position: absolute;
            inset: 0;
            border-radius: 5px;
            pointer-events: none;
            opacity: 0;
            box-shadow: 0 0 14px 3px color-mix(in srgb, var(--wdm-cini-active-glow, #e0b060) 70%, transparent);
            transition: opacity 120ms;
            will-change: opacity;
        }
        .wdm-cini-card.is-active::before { opacity: 1; }
        .wdm-cini-card.is-defeated {
            opacity: 0.4;
            filter: grayscale(1);
        }
        .wdm-cini-card.is-hidden-gm {
            outline: 1px dashed rgba(224, 176, 96, 0.35);
            outline-offset: -3px;
        }

        /* Portrait fills most of the card. Border color = disposition. */
        .wdm-cini-portrait {
            width: 100%;
            height: var(--wdm-cini-portrait-h, 3.75em);
            border-radius: 4px;
            object-fit: cover;
            object-position: top center;
            border: 2px solid var(--wdm-cini-disp, ${DEFAULT_BORDER});
            background: #000;
        }
        .wdm-cini-name {
            margin-top: 0.1875em;
            font-family: var(--wdm-font-display, "PF DIN Text Cond Pro", Impact, sans-serif);
            font-size: 0.75em;
            color: rgba(230, 220, 200, 0.92);
            white-space: nowrap;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            text-align: center;
        }
        .wdm-cini-init {
            position: absolute;
            top: 4px; right: 6px;
            font-family: var(--wdm-font-display, "PF DIN Text Cond Pro", Impact, sans-serif);
            font-size: 0.75em;
            font-weight: 700;
            color: #e0b060;
            text-shadow: 0 1px 2px #000, 0 0 3px #000;
            font-variant-numeric: tabular-nums;
            padding: 0 3px;
            background: rgba(0,0,0,0.6);
            border-radius: 3px;
            pointer-events: none;
        }
        .wdm-cini-hidden-icon {
            position: absolute;
            bottom: 4px; right: 6px;
            font-size: 0.75em;
            color: rgba(224, 176, 96, 0.85);
            text-shadow: 0 1px 2px #000;
            pointer-events: none;
        }

        /* GM control strip below the cards. Explicit pointer-events:auto
         * — the container is pointer-events:none so canvas clicks fall
         * through empty regions, but the buttons themselves must be
         * clickable. */
        .wdm-cini-controls {
            display: flex;
            gap: 0.375em;
            justify-content: center;
            pointer-events: auto;
        }
        .wdm-cini-btn {
            display: inline-flex; align-items: center; gap: 0.25em;
            font-family: var(--wdm-font-display, "PF DIN Text Cond Pro", Impact, sans-serif);
            font-size: 0.6875em;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: rgba(230, 220, 200, 0.9);
            background: rgba(0,0,0,0.55);
            border: 1px solid rgba(168, 132, 80, 0.5);
            border-radius: 3px;
            padding: 0.1875em 0.5em;
            cursor: pointer;
            transition: border-color 120ms, color 120ms, background 120ms;
        }
        .wdm-cini-btn:hover {
            border-color: #e0b060;
            color: #e0b060;
            background: rgba(20,15,10,0.85);
        }
        .wdm-cini-btn.is-primary {
            border-color: rgba(224, 176, 96, 0.8);
            color: #e0b060;
        }
        .wdm-cini-btn.is-danger:hover {
            border-color: #d23c3c;
            color: #ff7a7a;
        }
        .wdm-cini-btn i { font-size: 0.75em; }

        /* Sidebar tracker: dashed outline for GM-visible hidden rows,
         * fully hidden for non-GM. Selector uses [data-combatant-id]
         * rather than .combatant — the attribute is stable across
         * Foundry versions and any potential subclass, while the
         * .combatant class could theoretically be renamed. display:none
         * !important because Foundry's re-render pass can write inline
         * display styles that would otherwise override. */
        [data-combatant-id].wdm-hidden-gm {
            outline: 1px dashed rgba(224, 176, 96, 0.35);
            outline-offset: -3px;
        }
        [data-combatant-id].wdm-hidden-for-player {
            display: none !important;
        }

        /* Guard-stance chip (Fool's / Warding / Closed / Balanced) is
         * injected onto every [data-combatant-id] node by
         * policy/combat-tracker-guards.mjs — which includes these carousel
         * cards, since they carry data-combatant-id. On the carousel it
         * reads oversized next to the card art, so halve it HERE — scoped
         * to the carousel container so the SAME chip in Foundry's sidebar
         * tracker keeps its normal size. !important beats the chip's own
         * inline font-size. */
        #${CAROUSEL_ID} .wdm-ct-guard {
            /* em (not rem): the chip ships with a rem font-size that tracks
             * the global UI-scale chain, so on a scaled-up UI it stayed as
             * large as the name. em pins it to the carousel's fixed 16px
             * base like the name/init. The label span inherits this; the
             * icon has its own size below so shrinking the label leaves the
             * icon alone. */
            font-size: 0.385em !important;
        }
        /* Icon slightly larger than the label — FontAwesome glyphs read
         * visually small, so matching the label size left it miniscule. */
        #${CAROUSEL_ID} .wdm-ct-guard i {
            font-size: 0.65em !important;
        }
    `;
    document.head.appendChild(s);
}

function ensureCarousel() {
    if (_carousel && document.body.contains(_carousel)) return _carousel;
    ensureStyles();
    _carousel = document.createElement("div");
    _carousel.id = CAROUSEL_ID;
    document.body.appendChild(_carousel);
    return _carousel;
}

/* Push live-config values into CSS custom properties on the carousel
 * container. The main <style> block references these vars, so a single
 * assignment here reshapes layout / motion / color without editing the
 * stylesheet. Called on every render — cheap (six property writes). */
function applyConfigStyles(cfg) {
    if (!_carousel || !cfg) return;
    const s = _carousel.style;
    /* Gate on a signature. These config values change only when the GM edits
     * the carousel config dialog, yet this ran on EVERY render (each End Turn /
     * actor update). Nine setProperty writes dirty the container's style every
     * time, which forces the getBoundingClientRect / getComputedStyle reads
     * later in the same render to perform a full reflow. Skip when unchanged. */
    const sig = `${cfg.cardWidth}|${cfg.cardHeight}|${cfg.portraitHeight}|${cfg.activeScale}|${cfg.containerMaxWidth}|${cfg.cardGap}|${cfg.transitionMs}|${cfg.activeGlowColor}`;
    if (_carousel.__wdmCfgSig === sig) return;
    _carousel.__wdmCfgSig = sig;
    /* Values written in em (not rem) — the carousel container overrides
     * font-size to 16px so em resolves to raw pixels that don't inherit
     * the html font-size chain (`html { font-size: calc(16px * var(
     * --wdm-scale)) }`). This eliminates the chain contribution to the
     * carousel's layout, so the container's own transform: scale is the
     * ONLY scaling — one-slider input, one visual output, at any mode. */
    s.setProperty("--wdm-cini-card-w",       `${cfg.cardWidth}em`);
    s.setProperty("--wdm-cini-card-h",       `${cfg.cardHeight}em`);
    s.setProperty("--wdm-cini-portrait-h",   `${cfg.portraitHeight}em`);
    s.setProperty("--wdm-cini-active-scale", String(cfg.activeScale));
    /* 88vw stays layout-space; divide by --wdm-cini-scale so visual
     * (which is layout × scale) stays within 88% of the viewport. */
    s.setProperty("--wdm-cini-max-w",
        `min(${cfg.containerMaxWidth}em, calc(88vw / var(--wdm-cini-scale, 1)))`);
    s.setProperty("--wdm-cini-gap",          `${cfg.cardGap}em`);
    s.setProperty("--wdm-cini-transition",   `${cfg.transitionMs}ms`);
    s.setProperty("--wdm-cini-active-glow",  cfg.activeGlowColor);
}

function removeCarousel() {
    if (_carousel && document.body.contains(_carousel)) _carousel.remove();
    _carousel = null;
}

/* ── Positioning ─────────────────────────────────────────────────────── */

function pickAnchor() {
    for (const sel of ANCHOR_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) return el;
    }
    return null;
}

/* Read the carousel's target scale — the value of whichever UI Scale
 * slider is VISIBLE in the current mode:
 *   auto     → Overall Scaling  (--wdm-chrome-bars-scale)
 *   manual   → UI Scale          (--wdm-scale)
 *   detailed → UI Scale (Text)   (--wdm-scale)
 *
 * No compensation math needed anymore — the carousel's font-size is
 * fixed at 16px and its sizes are em-based, so the html font-size chain
 * (which inflates rem by --wdm-scale) doesn't reach in. Container
 * transform: scale(intent) applies once and the visual is exactly
 * intent × baseline. At slider = 1.0 in every mode the carousel is
 * true 1.0x baseline. */
function readCarouselZoom() {
    const cs = getComputedStyle(document.documentElement);
    let mode = "manual";
    try { mode = game.settings.get(SYSTEM_ID, "ui.scaleMode") ?? "manual"; }
    catch (_) { /* pre-ready or settings unavailable — safe default */ }
    const cssVar = (mode === "auto") ? "--wdm-chrome-bars-scale" : "--wdm-scale";
    return Number(cs.getPropertyValue(cssVar)) || 1;
}

/* Write the current effective scale as a CSS var on the carousel. The
 * CSS transform rule composes translateX(-50%) with scale(var(
 * --wdm-cini-scale)) — transform reacts reliably to var updates,
 * unlike CSS `zoom: var(...)` which Chromium doesn't always
 * invalidate. The same var is also read by width and top-compensation
 * calcs so every size path uses one source of truth.
 *
 * Also unconditionally clears any inline `zoom` — an earlier
 * iteration wrote inline zoom on this element, and if that inline
 * style survived a reload (Foundry sometimes keeps DOM around) it
 * would still apply on top of the new transform-based scaling and
 * make everything look 1.2x too big at "1.0x". */
function updateCarouselScale() {
    if (!_carousel) return;
    const s = String(readCarouselZoom());
    /* Write only on change — an unconditional setProperty every render dirties
     * style and forces the later layout reads to reflow. */
    if (_carousel.__wdmLastScale !== s) {
        _carousel.style.setProperty("--wdm-cini-scale", s);
        _carousel.__wdmLastScale = s;
    }
    if (_carousel.style.zoom) _carousel.style.zoom = "";
}

function updateCarouselTop() {
    if (!_carousel) return;
    const anchor = pickAnchor();
    if (!anchor) {
        document.body.style.setProperty("--wdm-carousel-top", "0px");
        return;
    }
    /* State-based read (not visual-rect-based):
     *   - The chrome topbar collapses via `transform: translateY(-100%)`,
     *     not via display:none or height:0. `getBoundingClientRect()`
     *     returns transform-affected values that ramp during the 0.35s
     *     transition — reading mid-animation gives a wrong intermediate.
     *   - `offsetHeight` is transform-stable (layout-space), giving the
     *     bar's true height regardless of animation state.
     *   - Whether the bar is currently "shown" is a class-state fact:
     *     `.is-open` on the topbar (registerCollapsible), or for the
     *     Foundry `#navigation` fallback there's no collapse animation
     *     to speak of (Foundry's own collapse just changes contents).
     *   - Setting a CSS variable rather than `style.top` lets the
     *     carousel's own CSS transition (matched to --wdm-dur-slow)
     *     handle the smooth slide, keeping it in lockstep with the
     *     topbar's slide-in/out. */
    const isOpen = anchor.classList.contains("is-open")
                || anchor.id === "navigation";  /* Foundry nav is "always open" from our POV */
    /* `getBoundingClientRect().height` (not `offsetHeight`) — the chrome
     * topbar has a `zoom` CSS property that scales its visual size but
     * doesn't affect `offsetHeight`. `getBoundingClientRect` accounts for
     * `zoom`, and since the topbar only uses `translateY` (never scale
     * transforms), the returned height is stable across the collapse
     * animation. Using this prevents the small strip of carousel that was
     * sitting behind the expanded topbar. */
    /* Under transform: scale(), unlike CSS zoom, the element's `top`
     * position is unaffected — scale multiplies visual dimensions but
     * leaves the CSS-pixel positioning coordinates alone. So the raw
     * anchor visual bottom is what we write; no division by scale. */
    const top = isOpen ? Math.ceil(anchor.getBoundingClientRect().height) : 0;
    const topStr = `${top}px`;
    /* Write only on change — avoids dirtying <body> style (and thus a reflow on
     * the next read) every render when the topbar height is unchanged. */
    if (document.body.__wdmLastCarouselTop !== topStr) {
        document.body.style.setProperty("--wdm-carousel-top", topStr);
        document.body.__wdmLastCarouselTop = topStr;
    }
}

function refreshObservers() {
    /* Re-target the ResizeObserver if the anchor changed (e.g., chrome
     * topbar just injected after our first call landed on Foundry's nav). */
    const anchor = pickAnchor();
    if (anchor === _currentAnchor && _navObserver) return;
    if (_navObserver) { try { _navObserver.disconnect(); } catch (_) {} _navObserver = null; }
    _currentAnchor = anchor;
    if (!anchor) return;
    _navObserver = new ResizeObserver(() => updateCarouselTop());
    _navObserver.observe(anchor);
}

function ensureBodyClassObserver() {
    /* MutationObserver on <body> class list catches the chrome topbar's
     * open/close toggle (`wou-topbar-open`). ResizeObserver alone misses
     * this when the collapse is done via `display:none` (element stops
     * having a size instead of animating to zero). Cheap — mutations
     * fire once per class toggle, not per frame. */
    if (_bodyClassObserver) return;
    _bodyClassObserver = new MutationObserver(() => updateCarouselTop());
    _bodyClassObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

/* Watch documentElement.style for --wdm-scale changes so a live drag in
 * the UI Scale dialog re-runs the top-compensation calc. That dialog
 * writes CSS vars directly (see chrome/setup/ui-scale.js applyUIScaleValues)
 * and never touches game.settings during the drag, so a setting hook
 * wouldn't catch the preview. Coalesced through rAF to avoid multi-fire
 * during a drag. */
let _scaleObserver = null;
function ensureScaleObserver() {
    if (_scaleObserver) return;
    let scheduled = false;
    _scaleObserver = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            updateCarouselScale();
            updateCarouselTop();
        });
    });
    _scaleObserver.observe(document.documentElement,
        { attributes: true, attributeFilter: ["style"] });
}

function tearDownObservers() {
    if (_navObserver) { try { _navObserver.disconnect(); } catch (_) {} _navObserver = null; }
    if (_bodyClassObserver) { try { _bodyClassObserver.disconnect(); } catch (_) {} _bodyClassObserver = null; }
    if (_scaleObserver) { try { _scaleObserver.disconnect(); } catch (_) {} _scaleObserver = null; }
    _currentAnchor = null;
}

/* ── Render ──────────────────────────────────────────────────────────── */

function escapeHtml(s) {
    return String(s ?? "").replace(/[<>&"']/g, c => (
        { "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&#39;" }[c]
    ));
}

function combatantDispositionBorder(combatant, cfg) {
    const disp = Number(combatant?.token?.disposition ?? 0);
    return dispositionBorderFrom(cfg ?? getCarouselConfig(), disp);
}

/* Whether the carousel should render for THIS combat, given the current
 * live config. Considers: master enable, audience gate (GM/player),
 * context gate (token combat vs theater-of-the-mind). Returns false to
 * suppress the render entirely for this user. */
export function carouselShouldShow(combat) {
    const cfg = getCarouselConfig();
    if (!cfg.enabled) return false;
    const isGM = !!game.user?.isGM;
    if (isGM   && !cfg.showForGM)      return false;
    if (!isGM  && !cfg.showForPlayers) return false;
    /* Distinguish token combat from theater-of-the-mind by checking if
     * ANY combatant is scene-linked (has a real token). A combat with
     * even one linked token counts as "token combat" for the audience
     * gate — the GM's expectation is that a hybrid setup shows the bar
     * so the linked side is visible, and the tokenless side rides along. */
    const anyTokened = [...(combat.combatants?.values?.() ?? [])]
        .some(c => combatantHasSceneToken(c));
    if (anyTokened && !cfg.showForTokenCombat)     return false;
    if (!anyTokened && !cfg.showForTheaterOfMind)  return false;
    return true;
}

/* ── Keyed card reconciliation ─────────────────────────────────────────
 * The carousel used to blow away and rebuild all card DOM every render
 * (`strip.innerHTML = …`). That re-created every portrait <img>, so the
 * browser re-decoded every combatant portrait on each render — and renders
 * fire on End Turn and on every in-combat actor update. Cost scaled with
 * combatant count, which is exactly the "more people → laggier" report.
 *
 * These helpers reuse card nodes across renders: build a node once
 * (makeCardEl, listeners attached here so they never stack), update only
 * the fields that changed (updateCardEl), and move nodes into turn order
 * without touching their <img> (reconcileCards). Steady-state renders do
 * near-zero work and zero image decoding. */

/** Build a card node ONCE. Event listeners are attached here and read
 *  `game.combat` live, so reused nodes keep working across renders and
 *  across different combats. */
function makeCardEl(id) {
    const el = document.createElement("div");
    el.className = "wdm-cini-card";
    el.dataset.combatantId = id;

    const img = document.createElement("img");
    img.className = "wdm-cini-portrait";
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);

    const name = document.createElement("div");
    name.className = "wdm-cini-name";
    el.appendChild(name);

    const init = document.createElement("div");
    init.className = "wdm-cini-init";
    el.appendChild(init);

    el.addEventListener("mousedown", (ev) => {
        const combat = game.combat;
        if (combat) onCardMouseDown(ev, combat);
    });
    el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        const combat = game.combat;
        if (combat) onCardRightClick(ev, combat);
    });
    return el;
}

/** Write only the fields that can change between renders. Every write is
 *  guarded so an unchanged card touches no DOM at all. */
function updateCardEl(el, c, view) {
    const { started, activeId, isGM, cfg } = view;
    const isActive          = started && c.id === activeId;
    const defeated          = !!c.defeated;
    const badgedHiddenForGM = isGM && isCombatantHiddenFromAnyPlayer(c);
    const img               = c.img || c.actor?.img || c.token?.texture?.src
                              || "icons/svg/mystery-man.svg";
    const initStr           = (c.initiative == null || Number.isNaN(Number(c.initiative)))
                              ? "—" : String(c.initiative);
    const border            = combatantDispositionBorder(c, cfg);
    const name              = c.name ?? "";

    el.classList.toggle("is-active", isActive);
    el.classList.toggle("is-defeated", defeated);
    el.classList.toggle("is-hidden-gm", badgedHiddenForGM);

    if (el.style.getPropertyValue("--wdm-cini-disp") !== border) {
        el.style.setProperty("--wdm-cini-disp", border);
    }
    const tip = `${name}${defeated ? " (defeated)" : ""}${badgedHiddenForGM ? " — hidden from players" : ""}`;
    if (el.dataset.tooltip !== tip) el.dataset.tooltip = tip;

    /* Portrait: set src ONLY when it actually changed. This is the whole
     * point — an unchanged src means no re-fetch and no re-decode. */
    const imgEl = el.firstElementChild;
    if (imgEl && imgEl.getAttribute("src") !== img) imgEl.setAttribute("src", img);

    const nameEl = el.querySelector(".wdm-cini-name");
    if (nameEl && nameEl.textContent !== name) nameEl.textContent = name;

    const initEl = el.querySelector(".wdm-cini-init");
    if (initEl && initEl.textContent !== initStr) initEl.textContent = initStr;

    let icon = el.querySelector(".wdm-cini-hidden-icon");
    if (badgedHiddenForGM && !icon) {
        icon = document.createElement("i");
        icon.className = "fas fa-eye-slash wdm-cini-hidden-icon";
        el.appendChild(icon);
    } else if (!badgedHiddenForGM && icon) {
        icon.remove();
    }
}

/** Reconcile the strip's children against `visible` (turn order). Reuses
 *  existing nodes by combatant id, moving them into place; creates nodes
 *  only for new combatants; removes nodes for combatants that left. */
function reconcileCards(strip, visible, view) {
    const existing = new Map();
    for (const el of strip.querySelectorAll(".wdm-cini-card")) {
        existing.set(el.dataset.combatantId, el);
    }
    const seen = new Set();
    let i = 0;
    for (const c of visible) {
        let el = existing.get(c.id);
        if (!el) el = makeCardEl(c.id);
        updateCardEl(el, c, view);
        seen.add(c.id);
        /* Put the node at position i, moving it only if it isn't already
         * there — reordering an existing <img> node does NOT re-decode. */
        const atPos = strip.children[i];
        if (atPos !== el) strip.insertBefore(el, atPos ?? null);
        i++;
    }
    /* Drop cards for combatants no longer present / visible. */
    for (const [id, el] of existing) {
        if (!seen.has(id)) el.remove();
    }
}

function renderCarousel() {
    const combat = game.combat;
    const isGM = !!game.user?.isGM;
    /* Show whenever combat exists AND has combatants AND the config's
     * gates allow it. Master enable, audience, and context gates all
     * live in carouselShouldShow. */
    if (!combat || (combat.combatants?.size ?? 0) === 0 || !carouselShouldShow(combat)) {
        removeCarousel(); tearDownObservers();
        /* Reset wrap-detection state so the next combat starts clean —
         * otherwise a stale _lastRound from a prior combat could false-
         * trigger the snap on the new combat's first round. */
        _lastCombatId = null;
        _lastRound    = null;
        return;
    }
    /* Different combat than last render → reset the wrap tracker. */
    if (_lastCombatId !== combat.id) {
        _lastCombatId = combat.id;
        _lastRound    = null;
    }

    ensureCarousel();
    refreshObservers();
    ensureBodyClassObserver();
    ensureScaleObserver();
    updateCarouselScale();
    updateCarouselTop();
    /* Push live-config values into CSS variables on the container so
     * layout/motion/color edits from the config dialog take effect
     * without touching the injected <style> block. Keeps the CSS
     * declarative and the JS just data-plumbing. */
    const cfg = getCarouselConfig();
    applyConfigStyles(cfg);

    const started = !!combat.started;
    /* Pre-start combat has no turn order yet — Foundry populates `turns`
     * on start. Fall back to raw combatants ordered by initiative
     * (descending, tie-broken by name) to preview what the order will
     * look like. */
    const turns = started
        ? (combat.turns ?? [])
        : [...(combat.combatants?.contents ?? [])].sort((a, b) => {
            const ai = Number(a.initiative ?? -Infinity);
            const bi = Number(b.initiative ?? -Infinity);
            return bi - ai || (a.name ?? "").localeCompare(b.name ?? "");
          });
    const activeId = combat.combatant?.id;

    /* Collect the combatants THIS user may see, in turn order. GM never
     * skips; a player owning a spotter of a stealthed combatant DOES see
     * them, matching the canvas visibility gate. The DOM is built by keyed
     * reconciliation below (reconcileCards) rather than an innerHTML
     * rebuild, so portraits aren't re-decoded every render. */
    const visible = [];
    for (const c of turns) {
        if (isCombatantHiddenFromCurrentUser(c)) continue;
        visible.push(c);
    }

    /* GM control strip: Start (pre-combat) / End Turn + End Combat (in
     * combat). Players see no controls — they can't drive combat state. */
    let controls = "";
    if (isGM) {
        if (started) {
            controls = `
                <div class="wdm-cini-controls">
                    <button class="wdm-cini-btn is-primary" data-action="endTurn"
                            data-tooltip="End Turn / Next Combatant">
                        <i class="fas fa-forward-step"></i><span>End Turn</span>
                    </button>
                    <button class="wdm-cini-btn is-danger" data-action="endCombat"
                            data-tooltip="End Combat">
                        <i class="fas fa-stop"></i><span>End Combat</span>
                    </button>
                </div>`;
        } else {
            controls = `
                <div class="wdm-cini-controls">
                    <button class="wdm-cini-btn is-primary" data-action="startCombat"
                            data-tooltip="Start Combat">
                        <i class="fas fa-play"></i><span>Start Combat</span>
                    </button>
                    <button class="wdm-cini-btn is-danger" data-action="endCombat"
                            data-tooltip="Cancel Combat">
                        <i class="fas fa-xmark"></i><span>Cancel</span>
                    </button>
                </div>`;
        }
    }

    /* Persistent strip element — reused across renders so its transform
     * value survives updates. Replacing innerHTML of the container would
     * destroy the strip and reset its transform to (0,0), causing the
     * cards to snap to the left edge before animating back to center.
     * Keeping the strip element stable means the CSS transition on
     * transform animates smoothly between old and new positions. */
    let strip = _carousel.querySelector(".wdm-cini-strip");
    let controlsEl = _carousel.querySelector(".wdm-cini-controls");
    const stripIsNew = !strip;
    if (stripIsNew) {
        strip = document.createElement("div");
        strip.className = "wdm-cini-strip";
        _carousel.appendChild(strip);
    }
    /* Keyed reconcile instead of `strip.innerHTML = …`. Rebuilding the
     * innerHTML every render re-created every card — and every portrait
     * <img> — forcing the browser to re-decode all portraits on each
     * render (whose count scales with combatant count, and which fires on
     * every End Turn / actor update). Reconciliation reuses the existing
     * card nodes, moving them into turn order and writing only the fields
     * that changed, leaving the decoded <img> textures untouched. */
    reconcileCards(strip, visible, { started, activeId, isGM, cfg });

    /* Controls are cheap to replace — small button set that changes when
     * `started` flips. Replaced (not persistent) so old handlers don't
     * leak, and the swap is invisible since it doesn't animate. */
    if (controlsEl) controlsEl.remove();
    if (controls) {
        const wrap = document.createElement("div");
        wrap.innerHTML = controls;
        controlsEl = wrap.firstElementChild;
        _carousel.appendChild(controlsEl);
    }

    /* Card interactions are wired ONCE, when each card node is created in
     * makeCardEl (the reconcile reuses nodes across renders, so re-wiring
     * here would stack duplicate listeners). Only the GM control buttons —
     * which are rebuilt each render — need re-wiring. */
    for (const btn of _carousel.querySelectorAll(".wdm-cini-btn")) {
        btn.addEventListener("click", (ev) => onControlClick(ev, combat));
    }

    /* Center the active card by translating the strip. Deferred to next
     * frame so the browser has laid out the new card widths first.
     * Snap without animation when: (a) this is the FIRST render this
     * session (stripIsNew — pre-centered on paint), or (b) combat has
     * WRAPPED — the round just ticked over from N to N+1, meaning turn
     * order has looped back to combatant 1. Without the wrap-snap, the
     * "last card centered" → "first card centered" transition animates
     * as a big rightward slingshot across the entire strip. Snapping
     * makes it read as "returns to the start" cleanly. */
    const wrapDetected = _lastCombatId === combat.id
                       && _lastRound != null
                       && Number(combat.round ?? 0) > _lastRound
                       && cfg.snapOnRoundWrap;
    _lastCombatId = combat.id;
    _lastRound    = Number(combat.round ?? 0);
    const snap    = stripIsNew || wrapDetected;
    if (started && activeId) {
        requestAnimationFrame(() => centerActiveCard(strip, activeId, !snap));
    } else {
        requestAnimationFrame(() => centerActiveCard(strip, null, !snap));
    }
}

/* Translate the strip so the active card's horizontal center aligns
 * with the container's horizontal center.
 *
 * The math, stated once:
 *   - CENTER (target, visual pixels): the horizontal midpoint of the
 *     _carousel container's bounding rect on screen.
 *   - CARD CENTER (current, visual pixels): the horizontal midpoint of
 *     the active card's bounding rect on screen.
 *   - DELTA (visual pixels): CENTER minus CARD CENTER. This is how far
 *     the card needs to move on screen to reach CENTER.
 *
 * The catch — the container has `zoom: Z` applied inline, so the
 * strip's own `transform: translateX(X)` moves visually by X × Z. To
 * turn a visual delta into the CSS-pixel translate we write, divide
 * by Z.
 *
 * The other catch — the current translate must be the LIVE mid-
 * animation value (getComputedStyle matrix), not the target
 * (strip.style.transform). If a second render fires while an earlier
 * animation is still in flight (manual initiative reorder immediately
 * followed by End Turn), reading the target base plus a visual delta
 * against the mid-animation position produces overshoot — the
 * "slingshot".
 *
 *   newTxCSS = currentTxCSS + (deltaVisual / Z)
 *
 * With both terms in CSS-pixel space (the space strip.style.transform
 * lives in), the identity holds regardless of animation state or Z. */
function centerActiveCard(strip, activeId, animate) {
    if (!strip || !_carousel) return;
    /* When there IS an active turn but the active combatant isn't in
     * the strip (player-visible), leave the transform untouched — the
     * player shouldn't get any hint about whose turn it is (that's the
     * whole point of hiding the combatant), and snapping to 0 every
     * time a hook fires makes the strip spazz between the previous
     * visible card's centered position and 0. Just no-op. */
    if (activeId) {
        const el = strip.querySelector(`.wdm-cini-card[data-combatant-id="${CSS.escape(activeId)}"]`);
        if (!el) return;
        const cardRect      = el.getBoundingClientRect();
        const containerRect = _carousel.getBoundingClientRect();
        const deltaVisual = ((containerRect.left + containerRect.right) / 2)
                          - ((cardRect.left      + cardRect.right)      / 2);
        const z = readCarouselZoom() || 1;
        const currentTxCSS = readComputedTranslateX(strip);
        const newTxCSS = Math.round(currentTxCSS + (deltaVisual / z));
        applyTransform(strip, `translateX(${newTxCSS}px)`, animate);
        return;
    }
    /* No active turn (pre-combat-start / just-ended) — center the strip
     * at 0 (natural flex justify-content: center layout). */
    applyTransform(strip, "translateX(0)", animate);
}

/* Read the CURRENT (mid-animation, if transitioning) translateX from
 * an element's computed style, in CSS px. Used instead of parsing
 * `element.style.transform` (which returns the target of the last set,
 * not the current value) so a delta-based centering calc doesn't add
 * to a stale base and overshoot.
 *
 * DOMMatrix parses every serialization the browser emits — "none",
 * matrix(a,b,c,d,e,f), matrix3d(...), translateX(Npx), and
 * combinations — so we don't have to enumerate regex forms. .m41 is
 * the tx component in both 2D and 3D matrices. */
function readComputedTranslateX(el) {
    if (!el) return 0;
    try {
        const t = getComputedStyle(el).transform;
        if (!t || t === "none") return 0;
        return new DOMMatrix(t).m41 || 0;
    } catch (_) {
        return 0;
    }
}

/* Set the strip transform, optionally suppressing the CSS transition via
 * a temporary style override + forced reflow. */
function applyTransform(strip, target, animate) {
    if (animate) {
        strip.style.transform = target;
        return;
    }
    const prev = strip.style.transition;
    strip.style.transition = "none";
    strip.style.transform = target;
    void strip.offsetWidth;
    strip.style.transition = prev || "";
}

/* Extract the current translateX value from an element's inline style.
 * Returns 0 for unset / non-translateX transforms. Simpler than parsing
 * the computed matrix — we only ever set translateX on the strip. */
function parseTranslateX(el) {
    const t = el?.style?.transform || "";
    const m = /translateX\(([-\d.]+)px\)/.exec(t);
    return m ? parseFloat(m[1]) : 0;
}

async function onControlClick(ev, combat) {
    const action = ev.currentTarget?.dataset?.action;
    if (!action || !combat) return;
    try {
        if (action === "startCombat")      await combat.startCombat();
        else if (action === "endTurn")     await combat.nextTurn();
        else if (action === "endCombat")   await combat.endCombat();
    } catch (err) {
        console.warn(`${SYSTEM_ID} | carousel control ${action} failed`, err);
    }
}

function onCardMouseDown(ev, combat) {
    const id = ev.currentTarget?.dataset?.combatantId;
    if (!id) return;
    const c = combat.combatants.get(id);
    if (!c) return;
    const actor = c.actor ?? null;
    /* Resolve the placeable robustly — combatant.token.object first, then by
     * tokenId on the active scene, then any placeable of this actor. The bare
     * `c.token?.object` alone silently returns null in several real cases
     * (token document not yet linked to a drawn placeable, a mid-redraw gap,
     * or a combatant whose token is on a scene the user isn't viewing), which
     * made middle-click targeting a no-op. Mirrors the sidebar tracker handler
     * in policy/combat-tracker-targets.mjs. */
    const token = c.token?.object
               ?? canvas?.tokens?.get?.(c.tokenId)
               ?? (actor ? canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id) : null);
    if (ev.button === 0) {
        try { token?.control?.({ releaseOthers: true }); } catch (_) {}
        try {
            if (token && canvas?.animatePan) {
                canvas.animatePan({ x: token.center?.x ?? token.x, y: token.center?.y ?? token.y, duration: 250 });
            }
        } catch (_) {}
    } else if (ev.button === 1) {
        ev.preventDefault();
        /* Canvas manual token target-lock is disabled — a token combatant on
         * the canvas is targeted via the weapon → tile flow, not a manual
         * middle-click lock. Only the tokenless (theatre-of-the-mind)
         * fallback below runs; a placed token is a no-op here. */
        if (token) return;
        /* No placeable (tokenless / theater-of-mind combatant) → toggle the
         * per-user actor-target flag the attack pipeline reads, same fallback
         * the sidebar tracker uses so targeting never silently no-ops. */
        if (!actor) return;
        import("./context-menu-actor.js")
            .then(m => m.toggleActorTargetUuid?.(actor.uuid))
            .catch(() => {});
    }
}

function onCardRightClick(ev, combat) {
    const id = ev.currentTarget?.dataset?.combatantId;
    if (!id) return;
    const c = combat.combatants.get(id);
    c?.actor?.sheet?.render(true);
}

let _renderScheduled = false;
function scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
        _renderScheduled = false;
        try { renderCarousel(); }
        catch (err) { console.warn(`${SYSTEM_ID} | carousel render failed`, err); }
    });
}

/* False ONLY for a pure combat-round bookkeeping write (`system.combatRound`:
 * movementMeters, action flags…), which fires on EVERY move and action but is
 * not shown anywhere on a card. Everything else (name, portrait, HP for the
 * defeated dimming, guard, flags/stealth, ownership…) still returns true and
 * re-renders exactly as before — the guard is deliberately narrow so nothing
 * displayed can go stale. Re-rendering the whole strip (portraits + active glow
 * + scroll re-center) for per-move bookkeeping was a pure per-move cost. */
function actorChangeAffectsCarousel(changes) {
    if (!changes) return false;
    const topKeys = Object.keys(changes).filter(k => k !== "_stats" && k !== "_id");
    if (topKeys.length === 1 && topKeys[0] === "system") {
        const sysKeys = Object.keys(changes.system || {});
        if (sysKeys.length >= 1 && sysKeys.every(k => k === "combatRound")) return false;
    }
    return true;
}

/* ── Sidebar combat tracker filter ────────────────────────────────────
 * Mirrors the carousel's hidden-from-players rule in Foundry's own combat
 * tracker sidebar. Hides rows entirely for non-GMs; marks them with the
 * dashed outline for GMs. */
/* Coalesced version — schedules one refilter per animation frame no
 * matter how many mutation events trigger it. The MutationObserver
 * below can fire many times per Foundry render pass; this keeps us
 * from doing N redundant walks over the same DOM. */
function scheduleSidebarRefilter() {
    if (_sidebarRefilterScheduled) return;
    _sidebarRefilterScheduled = true;
    requestAnimationFrame(() => {
        _sidebarRefilterScheduled = false;
        try { refilterExistingSidebar(); }
        catch (err) { console.warn(`${SYSTEM_ID} | sidebar refilter failed`, err); }
    });
}

/* MutationObserver on the sidebar (or document body as fallback) that
 * catches any DOM change touching the tracker — including Foundry
 * re-render passes that swap the row list AFTER our hook-based filter
 * has already run. Without this, my class-add on `updateActor` can
 * land on a row that Foundry then rebuilds without preserving classes,
 * leaving the fresh row uncleaned. The observer picks that up and
 * re-runs the filter on the current DOM. Debounced via rAF so we
 * don't loop over the tracker on every child mutation. */
function ensureSidebarMutationObserver() {
    if (_sidebarMutationObserver) return;
    /* Prefer scoping to #sidebar so we don't fire on canvas mutations,
     * but fall back to body if the sidebar isn't in the DOM yet. */
    const target = document.querySelector("#sidebar") || document.body;
    if (!target) return;
    _sidebarMutationObserver = new MutationObserver(() => scheduleSidebarRefilter());
    _sidebarMutationObserver.observe(target, { childList: true, subtree: true });
}

/* Re-run the sidebar filter against whatever tracker DOM is currently
 * in the page, without waiting for `renderCombatTracker` to fire.
 * Cheap DOM walk — safe to call from any state-change hook. */
function refilterExistingSidebar() {
    /* Scope to Foundry's sidebar so we don't touch our own carousel
     * cards (they also carry data-combatant-id and would otherwise
     * inherit the hidden-* classes, doubling up with the carousel's
     * own visual state). Fall back to broader search if the sidebar
     * isn't at the expected id — but still skip anything inside our
     * carousel container just to be safe. */
    const sidebar = document.querySelector("#sidebar");
    const rows = sidebar
        ? sidebar.querySelectorAll("[data-combatant-id]")
        : document.querySelectorAll(`[data-combatant-id]:not(#${CAROUSEL_ID} [data-combatant-id])`);
    if (!rows.length) return;
    const combat = game.combat;
    if (!combat) return;
    const isGM = !!game.user?.isGM;
    for (const row of rows) {
        if (row.closest?.(`#${CAROUSEL_ID}`)) continue;   /* belt-and-braces */
        const id = row.dataset.combatantId;
        const c = combat.combatants.get(id);
        if (!c) {
            row.classList.remove("wdm-hidden-gm", "wdm-hidden-for-player");
            continue;
        }
        if (!isGM) {
            row.classList.remove("wdm-hidden-gm");
            if (isCombatantHiddenFromCurrentUser(c)) row.classList.add("wdm-hidden-for-player");
            else                                     row.classList.remove("wdm-hidden-for-player");
        } else {
            row.classList.remove("wdm-hidden-for-player");
            if (isCombatantHiddenFromAnyPlayer(c)) row.classList.add("wdm-hidden-gm");
            else                                   row.classList.remove("wdm-hidden-gm");
        }
    }
}

function filterSidebarTracker(app, html) {
    const combat = game.combat;
    if (!combat) return;
    const isGM = !!game.user?.isGM;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const rows = root.querySelectorAll?.("[data-combatant-id]") ?? [];
    for (const row of rows) {
        const id = row.dataset.combatantId;
        const c = combat.combatants.get(id);
        if (!c) {
            row.classList.remove("wdm-hidden-gm", "wdm-hidden-for-player");
            continue;
        }
        /* Non-GM: strip the row entirely for anything THIS user can't see
         * (respects spotter status just like the carousel). GM: mark with
         * the dashed outline so they know the row is hidden from players
         * (uses the broader "hidden from any player" predicate, so a
         * stealther a specific player has spotted still shows the badge). */
        if (!isGM) {
            row.classList.remove("wdm-hidden-gm");
            if (isCombatantHiddenFromCurrentUser(c)) row.classList.add("wdm-hidden-for-player");
            else                                     row.classList.remove("wdm-hidden-for-player");
        } else {
            row.classList.remove("wdm-hidden-for-player");
            if (isCombatantHiddenFromAnyPlayer(c)) row.classList.add("wdm-hidden-gm");
            else                                   row.classList.remove("wdm-hidden-gm");
        }
    }
}

/* ── Registration ────────────────────────────────────────────────────── */

export function registerCarouselInitiative() {
    /* Carousel lifecycle */
    Hooks.on("combatStart",     scheduleRender);
    Hooks.on("deleteCombat",    scheduleRender);
    Hooks.on("updateCombat",    scheduleRender);
    Hooks.on("combatTurnChange", scheduleRender);
    Hooks.on("createCombatant", scheduleRender);
    Hooks.on("deleteCombatant", scheduleRender);
    Hooks.on("updateCombatant", scheduleRender);
    Hooks.on("updateActor", (actor, changes) => {
        if (!game.combat?.started) return;
        if (!game.combat.combatants.some(c => c.actor?.id === actor.id)) return;
        /* Ignore pure combat-round bookkeeping (fires on every move/action) —
         * the carousel displays none of it. Was a full strip rebuild per move. */
        if (!actorChangeAffectsCarousel(changes)) return;
        scheduleRender();
    });
    Hooks.on("updateToken", (tokenDoc, changes) => {
        if (!game.combat?.started) return;
        if (!game.combat.combatants.some(c => c.tokenId === tokenDoc.id)) return;
        if (!("disposition" in changes) && !("hidden" in changes)
            && !("name" in changes) && !("texture" in changes)) return;
        scheduleRender();
    });
    Hooks.on("canvasReady",    scheduleRender);
    /* Config-changed → re-render immediately so GM edits take effect
     * without a manual page reload for anything except the master
     * `enabled` toggle (which changes whether hooks are even active
     * — the CarouselInitiativeConfigApp raises a reload prompt for
     * that flip). */
    Hooks.on("wdm:carouselConfigChanged", () => {
        scheduleRender();
        scheduleSidebarRefilter();
    });
    /* Foundry sometimes populates game.combat on a tick AFTER `ready` —
     * when a player logs in mid-combat, `ready` fires but `game.combat`
     * isn't yet set. `renderCombatTracker` fires whenever the sidebar
     * tracker builds its DOM, which needs a valid combat — so it's a
     * reliable "combat is now available" signal that Foundry itself
     * chooses. Piggyback on it. */
    Hooks.on("renderCombatTracker", () => scheduleRender());
    /* Anchor position changes */
    Hooks.on("renderSceneNavigation", () => { refreshObservers(); updateCarouselTop(); });
    Hooks.on("collapseSidebar",       () => { updateCarouselTop(); });
    window.addEventListener("resize", () => updateCarouselTop());

    /* Sidebar tracker filter — install once. `renderCombatTracker` is
     * the primary trigger, but some combatant state changes (stealth
     * flag toggle, disposition change, hidden flag) don't cause the
     * tracker to re-render on their own. Those need the direct DOM
     * re-filter to run against the currently-rendered tracker. */
    if (!_sidebarPatchInstalled) {
        Hooks.on("renderCombatTracker", filterSidebarTracker);
        const refire = () => scheduleSidebarRefilter();
        Hooks.on("updateCombatant", refire);
        /* Same per-move guard as the carousel: the sidebar stealth/hidden
         * filter never depends on combat-round bookkeeping, so don't walk the
         * tracker DOM on every movement write. */
        Hooks.on("updateActor", (_actor, changes) => { if (actorChangeAffectsCarousel(changes)) refire(); });
        /* updateToken with disposition/hidden change: fire the normal
         * rAF-debounced refilter AND a delayed re-fire. The delayed
         * pass catches the race where Foundry re-renders the tracker
         * row AFTER my rAF refilter has already added the class —
         * without this second pass, the fresh row lands classless and
         * the hide never takes effect until the next unrelated hook
         * happens to run. 80ms is a comfortable margin above Foundry's
         * typical re-render latency without being a visible delay. */
        Hooks.on("updateToken", (tokenDoc, changes) => {
            /* Only disposition/hidden affect the stealth/hidden sidebar filter,
             * and only while a combat tracker exists to filter. Position writes
             * (x/y) fire updateToken on EVERY movement step — walking the whole
             * tracker DOM then was pure per-move waste (dropped FPS while
             * anyone moved during combat). Gate on the fields + combat, matching
             * the carousel's own updateToken guard above. */
            if (!game.combat?.started) return;
            if (!("disposition" in changes) && !("hidden" in changes)) return;
            scheduleSidebarRefilter();
            /* Delayed re-fire catches the race where Foundry re-renders the row
             * AFTER the rAF refilter, landing it classless. */
            setTimeout(refilterExistingSidebar, 80);
        });
        Hooks.on("combatStart",     refire);
        Hooks.on("combatTurnChange", refire);
        /* MutationObserver installed at ready — the sidebar element
         * exists by then. Catches DOM rebuilds that hook-based
         * refilters would miss the timing on. */
        Hooks.once("ready", () => {
            ensureSidebarMutationObserver();
            scheduleSidebarRefilter();
        });
        _sidebarPatchInstalled = true;
    }

    /* Initial render + retry burst. On login-into-active-combat, `ready`
     * often fires before game.combat is populated; the retries at 200 /
     * 800 / 2000ms catch late hydration with negligible cost (each is a
     * cheap early-return when combat is already rendered). */
    Hooks.once("ready", () => {
        scheduleRender();
        setTimeout(scheduleRender, 200);
        setTimeout(scheduleRender, 800);
        setTimeout(scheduleRender, 2000);
    });
}
