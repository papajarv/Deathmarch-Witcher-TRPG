/**
 * Witcher Token HUD — full custom replacement for Foundry's default token
 * HUD. Opens on right-click of a token; dismissed by clicking elsewhere
 * on the scene, by deselecting the token, or via the close button. Each
 * right-click reopens it, so the panel can be cycled freely. Matches the
 * chrome dock + character panel design (dark amber gradients, display-
 * font labels, hairline borders, ornate frame).
 *
 * Layout (vertical panel anchored to the right of the selected token):
 *
 *   ┌─────────────────────────┐
 *   │  ◯ Token portrait       │
 *   │  TOKEN NAME             │
 *   ├─────────────────────────┤
 *   │  COMBAT                 │
 *   │  [In Combat] [Hide]     │
 *   │  [Target]               │
 *   ├─────────────────────────┤
 *   │  STATUSES               │
 *   │  [◉][◉][◉][◉] …         │
 *   ├─────────────────────────┤
 *   │  VITALITY               │
 *   │  HP  ▓▓▓▓▓░░ 23/30      │
 *   │  STA ▓▓▓░░░░  8/10      │
 *   ├─────────────────────────┤
 *   │  [Sheet] [Configure]    │
 *   └─────────────────────────┘
 *
 * Implementation:
 *   - `renderTokenHUD` (fired by Foundry on right-click) is the trigger:
 *     we close Foundry's default HUD and build our own panel anchored to
 *     the right-clicked token. Re-firing on every right-click means the
 *     panel can be reopened without re-selecting the token.
 *   - A capture-phase window `pointerdown` listener dismisses the HUD on
 *     any click outside it that isn't a Foundry UI panel.
 *   - On `controlToken(token, false)` or scene change the HUD is removed.
 *   - On `canvasPan` (panning / zooming) the HUD is re-positioned so it
 *     tracks the token.
 *   - On actor or token updates the HUD re-renders to reflect new HP,
 *     status effects, etc.
 *
 * Status grid pulls directly from CONFIG.statusEffects so it picks up
 * the homebrew Witcher statuses (food/drink, stress breaks/boons, etc.)
 * as well as RAW conditions.
 */

import { clauseFor } from "../mechanics/statusEngine.mjs";
import { isStealthed, toggleStealth } from "../mechanics/stealth.mjs";
import { getStealthConfig } from "../mechanics/stealth-config.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";
const HUD_ID = "wdm-token-hud";

/* DoT statuses (bleed, burning, acid, poison …) stack per instance — each
 * application is its own AE that ticks separately. Matches the Apply Status
 * picker in chrome/chrome/context-menu-actor.js so the HUD and the actor-
 * sidebar dialog share one stacking model. */
const isStackableStatus = (id) => !!clauseFor(id)?.dot;
const statusInstanceCount = (actor, id) =>
    actor?.effects?.contents?.filter(e => e.statuses?.has?.(id)).length ?? 0;

let _hudEl = null;
let _activeToken = null;

/** DialogV2 explaining the stealth subsystem to players in plain
 *  language. Opened from the "?" affordance on the HUD sneak button.
 *  Content is inline HTML so it picks up system window chrome for
 *  free — no template file needed for a single static blurb. */
async function showStealthExplainerDialog() {
    const DialogV2 = foundry.applications.api.DialogV2;
    if (!DialogV2) return;
    const L = (k, fallback) => t(k, fallback);
    /* Numbers come from the LIVE config, not hardcoded prose. The previous
     * version of this dialog described the passive-vs-passive model with an
     * entry roll and fixed range bands — all of which had been replaced — and
     * nothing flagged it, because prose has no tests. Interpolating the real
     * values means a GM who retunes the ladder sees their own numbers here. */
    const cfg  = getStealthConfig();
    const tier = cfg.tierModifiers ?? {};
    const sgn  = (n) => (Number(n) > 0 ? `+${Number(n)}` : `${Number(n) || 0}`);
    const cov  = cfg.coverBonuses ?? {};
    const pace = cfg.paceBonuses ?? {};
    const content = `
      <div class="wdm-stealth-explainer" style="padding:0.35rem 0.15rem 0.15rem;line-height:1.55;">
        <p>${L("WITCHER.App.StealthGuide.Intro",
              "Each watcher projects a cone. Outside it you are simply unseen. Inside it you roll your Stealth over and over, once every few seconds, and every failure builds their suspicion until they find you.")}</p>

        <h3 style="margin:0.9rem 0 0.35rem;font-size:0.9rem;">${L("WITCHER.App.StealthGuide.ConeHead", "The cone: how far they could notice you")}</h3>
        <p>${L("WITCHER.App.StealthGuide.ConeDesc",
              "Cone size is fixed by BASE numbers — your DEX + Stealth against their INT + Awareness — plus the light, the weather, and whether you are dead ahead or off to their side. No dice go into it, so the shape holds still while you move and you can learn it. A watcher who cannot see at all (no light, no darkvision) projects no cone.")}</p>

        <h3 style="margin:0.9rem 0 0.35rem;font-size:0.9rem;">${L("WITCHER.App.StealthGuide.RollHead", "Inside the cone: you roll, they don't")}</h3>
        <p>${L("WITCHER.App.StealthGuide.RollDesc",
              "Every 3 seconds — or at the end of your turn in combat — you roll <strong>1d10 + DEX + Stealth + modifiers</strong> against that watcher's passive Awareness. Guards never roll; their number is fixed. There is no roll when you enter stealth, only the situational modifier you agree with your GM, which then applies to every check.")}</p>

        <h3 style="margin:0.9rem 0 0.35rem;font-size:0.9rem;">${L("WITCHER.App.StealthGuide.ModsHead", "What moves your roll")}</h3>
        <ul style="margin:0.1rem 0 0.6rem 1.1rem;padding:0;">
          <li><strong>${L("WITCHER.App.StealthGuide.Depth", "How deep in the cone you are")}.</strong>
              ${L("WITCHER.App.StealthGuide.DepthDesc", "The cone is banded by colour, outermost to innermost:")}
              <em>${sgn(tier.outer ?? 0)} / ${sgn(tier.mid ?? -5)} / ${sgn(tier.inner ?? -10)} / ${sgn(tier.core ?? -15)}</em>.
              ${L("WITCHER.App.StealthGuide.DepthDesc2", "Staying in the outer band is the whole game.")}</li>
          <li><strong>${L("WITCHER.App.StealthGuide.Cover", "How much of you is exposed")}.</strong>
              ${L("WITCHER.App.StealthGuide.CoverDesc", "Measured from your actual silhouette against walls, doors and the cone's edge — clipping one corner of a cone is much safer than standing in it.")}
              <em>${sgn(cov.threeQuarter ?? 1)} / ${sgn(cov.half ?? 2)} / ${sgn(cov.quarter ?? 4)} / ${sgn(cov.sliver ?? 6)}</em></li>
          <li><strong>${L("WITCHER.App.StealthGuide.Light", "Light")}.</strong>
              ${L("WITCHER.App.StealthGuide.LightDesc", "Shadow helps you and shortens their cone. Night vision and darkvision take that advantage away.")}</li>
          <li><strong>${L("WITCHER.App.StealthGuide.Pace", "How fast you moved")}.</strong>
              ${L("WITCHER.App.StealthGuide.PaceDesc", "Measured from the ground you actually covered since the last check, not what you declared:")}
              <em>${L("WITCHER.App.StealthGuide.PaceStill", "still")} ${sgn(pace.still ?? 2)} · ${L("WITCHER.App.StealthGuide.PaceCreep", "creep")} ${sgn(pace.creep ?? 1)} · ${L("WITCHER.App.StealthGuide.PaceWalk", "walk")} ${sgn(pace.walk ?? 0)} · ${L("WITCHER.App.StealthGuide.PaceRun", "run")} ${sgn(pace.run ?? -2)}</em></li>
          <li><strong>${L("WITCHER.App.StealthGuide.Prone", "Prone")}.</strong>
              ${L("WITCHER.App.StealthGuide.ProneDesc", "Going flat makes you harder to pick out.")}</li>
        </ul>

        <h3 style="margin:0.9rem 0 0.35rem;font-size:0.9rem;">${L("WITCHER.App.StealthGuide.ExposureHead", "Getting caught is gradual")}</h3>
        <p>${L("WITCHER.App.StealthGuide.ExposureDesc",
              "Fail a check and the amount you missed by is added to that watcher's suspicion — the eye above their head. Miss badly and it jumps. Reach")} <strong>${Number(cfg.threshold) || 10}</strong> ${L("WITCHER.App.StealthGuide.ExposureDesc2",
              "and they have found you. Passing a check does not push suspicion back down; only breaking out of their cone does, and it fades slowly. Suspicion is tracked per watcher, so being caught by one sentry does not mean the rest have seen you.")}</p>
        <p>${L("WITCHER.App.StealthGuide.PointBlank",
              "One exception: standing within")} <strong>${Number(cfg.pointBlankMetres) || 1} m</strong> ${L("WITCHER.App.StealthGuide.PointBlank2",
              "of a watcher who can see is an automatic spot. No roll, however good your Stealth — proximity is a fact, not a contest.")}</p>

        <h3 style="margin:0.9rem 0 0.35rem;font-size:0.9rem;">${L("WITCHER.App.StealthGuide.MapHead", "Reading the map")}</h3>
        <p>${L("WITCHER.App.StealthGuide.MapDesc",
              "Cones warm from amber at the edge to red at the core — that colour IS the penalty you are taking. The eye over each watcher fills as their suspicion grows. The marker under your token shows the pace your last move was measured at. Cones are drawn only where your own character can see; nothing is shown behind your back.")}</p>

        <p style="margin-top:1rem;font-style:italic;opacity:0.8;">${L("WITCHER.App.StealthGuide.Footer",
              "Every number above is set by your GM under Configure Settings → Token Stealth, and this page reflects whatever they chose.")}</p>
      </div>
    `;

    /* Size to the VIEWPORT, not to a fixed guess. The old `{ width: 560 }` with
     * no height let the window grow to whatever the content needed, so on a
     * laptop the guide ran off the bottom of the screen with the Close button
     * out of reach and no way to scroll to it. Capped at a comfortable reading
     * width, then clamped to the actual window so it always fits. */
    const vw = Number(globalThis.innerWidth)  || 1280;
    const vh = Number(globalThis.innerHeight) ||  800;
    await DialogV2.wait({
        window: {
            title: L("WITCHER.App.StealthGuide.Title", "How Stealth Works"),
            icon: "fa-solid fa-user-ninja",
            /* Gives the frame Foundry's bottom-right drag handle. */
            resizable: true
        },
        position: {
            width:  Math.max(320, Math.min(620, Math.round(vw * 0.92))),
            /* A BOUNDED height is what makes the content scroll — with height
             * left to "auto" the frame just grows and `overflow-y` never
             * engages, which is why a scrollbar never appeared before. */
            height: Math.max(240, Math.min(760, Math.round(vh * 0.85)))
        },
        content,
        classes: ["wdm-stealth-explainer-dialog"],
        buttons: [
            {
                action: "close",
                label: L("WITCHER.Common.Close", "Close"),
                icon: "fa-solid fa-xmark",
                default: true,
                callback: () => null
            }
        ],
        rejectClose: false
    }).catch(() => { /* dismiss = no-op */ });
}
let _hooksWired = false;
/* Persisted across re-renders so the GM's preferences aren't reset
 * every time the HUD repaints (which happens on every actor/token/effect
 * update tick). Module-level so they survive token deselect+reselect too. */
let _statusesOpen = false;
let _hudPosition = null;   // {left, top} once dragged; null = anchor to token
let _dragState = null;

/* ─────────── DOM rendering ─────────── */

function escapeAttr(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
function escapeText(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function getActorPortrait(actor, token) {
    return actor?.img && !actor.img.includes("mystery-man")
        ? actor.img
        : token?.document?.texture?.src ?? "";
}

function renderVitalityBar(label, cur, max) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
    return `
        <div class="wdm-hud-bar">
            <span class="wdm-hud-bar-label">${escapeText(label)}</span>
            <div class="wdm-hud-bar-track">
                <span class="wdm-hud-bar-fill" data-kind="${escapeAttr(label.toLowerCase())}" style="width:${pct}%;"></span>
            </div>
            <span class="wdm-hud-bar-num">${cur}/${max}</span>
        </div>
    `;
}

function renderStatusGrid(token) {
    const statuses = CONFIG.statusEffects ?? [];
    const actor = token?.actor;
    /* Source of truth is the actor's status Set (derived from its applied
     * effects), NOT the token document — token.document.statuses is not a
     * mirror of the actor's effect-borne statuses, so reading it here was
     * making statuses applied via any other path (sidebar Apply Status
     * dialog, drag-drop, programmatic toggles) look inactive in the HUD. */
    const active = actor?.statuses ?? new Set();
    return statuses.map(s => {
        const id = s.id;
        if (!id) return "";
        const name = game.i18n?.localize?.(s.name ?? s.label ?? id) ?? (s.name ?? id);
        const img  = s.img ?? s.icon ?? "icons/svg/aura.svg";
        const stack = isStackableStatus(id);
        const count = stack && actor ? statusInstanceCount(actor, id) : 0;
        const isActive = stack ? count > 0 : active.has?.(id);
        const title = stack
            ? `${name} — left-click: add a stack · right-click: remove one (non-wound)`
            : name;
        return `
            <button type="button" class="wdm-hud-status ${isActive ? "is-active" : ""}"
                    data-action="toggle-status" data-status="${escapeAttr(id)}"
                    data-stackable="${stack}"
                    title="${escapeAttr(title)}">
                <img src="${escapeAttr(img)}" alt="" draggable="false"/>
                ${stack && count > 0 ? `<span class="wdm-hud-status-count">${count}</span>` : ""}
            </button>
        `;
    }).join("");
}

function buildHUD(token) {
    const actor = token.actor;
    const portraitSrc = getActorPortrait(actor, token);
    const name = actor?.name ?? token.name ?? "Token";

    // Vitality readouts from Witcher's derivedStats (chrome dock uses the
    // same path). Fall back gracefully if a non-character is selected.
    const hp  = { cur: Number(actor?.system?.derivedStats?.hp?.value)  || 0,
                  max: Number(actor?.system?.derivedStats?.hp?.max)    || 0 };
    const sta = { cur: Number(actor?.system?.derivedStats?.sta?.value) || 0,
                  max: Number(actor?.system?.derivedStats?.sta?.max)   || 0 };

    const inCombat = !!game.combat?.combatants?.some?.(c => c.tokenId === token.id);
    const isHidden = !!token.document.hidden;
    const isTargeted = token.document.isTargeted;
    const isSneaking = isStealthed(actor);
    const stealthFeatureOn = !!getStealthConfig().enabled;

    const el = document.createElement("div");
    el.id = HUD_ID;
    el.className = "wdm-token-hud";
    /* DELIBERATELY skipping the `data-wdm-scaled` stamp for the token
       HUD. That attribute triggers `zoom: var(--wdm-popup-scale, ...)`
       in tokens.css:144, and CSS `zoom` multiplies BOTH the element's
       size AND its left/top positional offsets by the zoom factor —
       useful for free-floating popups whose positions are viewport-
       fixed, but broken here because the HUD lives inside Foundry's
       #hud container and its `left/top` are token WORLD coords. Adding
       zoom on top of that shifted the HUD by `(zoom − 1) × worldX`
       viewport pixels — the "far away" symptom in scaled.png. The
       parent #hud already applies `transform: scale(canvas.stage.
       scale.x)` for canvas zoom; UI text stays readable via the html
       font-size rule that inflates rem-based sizes. */
    /* Inline safety net: keep the panel and portrait from blowing up if the
     * system CSS fails to load (cache miss, override conflict). Uses
     * `max-width` / `max-height` rather than fixed `width` so the CSS
     * `15rem` / `1.5rem` sizing (which scales via the rem chain) can still
     * drive layout under normal operation. The cap is 4× the CSS baseline
     * so scaling up stays possible without the raw image ballooning to
     * its natural resolution. */
    el.style.cssText = "max-width:960px;box-sizing:border-box;";
    el.innerHTML = `
        <header class="wdm-hud-titlebar" data-drag-handle="1">
            ${portraitSrc ? `<img class="wdm-hud-portrait" src="${escapeAttr(portraitSrc)}" alt="" draggable="false"
                                 style="max-width:96px;max-height:96px;object-fit:cover;border-radius:50%;flex:0 0 auto;border:1px solid #6b5a3a;background:#0a0907;"/>` : ""}
            <div class="wdm-hud-title">${escapeText(name)}</div>
            <button type="button" class="wdm-hud-close" data-action="close" title="${t("WITCHER.Policy.WitcherTokenHud.Text.CloseHUD", "Close HUD")}">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </header>

        <div class="wdm-hud-body">

        <section class="wdm-hud-section">
            <div class="wdm-hud-section-label">${t("WITCHER.Policy.WitcherTokenHud.Text.Combat", "Combat")}</div>
            <div class="wdm-hud-row">
                <button type="button" class="wdm-hud-btn ${inCombat ? "is-on" : ""}" data-action="toggle-combat" title="${t("WITCHER.Policy.WitcherTokenHud.Text.ToggleInCombat", "Toggle in combat")}">
                    <i class="fa-solid fa-swords"></i><span>${inCombat ? t("WITCHER.Policy.WitcherTokenHud.Text.Leave", "Leave") : t("WITCHER.Policy.WitcherTokenHud.Text.Enter", "Enter")}</span>
                </button>
                <button type="button" class="wdm-hud-btn ${isHidden ? "is-on" : ""}" data-action="toggle-hidden" title="${t("WITCHER.Policy.WitcherTokenHud.Text.ToggleVisibility", "Toggle visibility")}">
                    <i class="fa-solid ${isHidden ? "fa-eye-slash" : "fa-eye"}"></i><span>${isHidden ? t("WITCHER.Policy.WitcherTokenHud.Text.Hidden", "Hidden") : t("WITCHER.Policy.WitcherTokenHud.Text.Visible", "Visible")}</span>
                </button>
                ${stealthFeatureOn ? `<div class="wdm-hud-btn-wrap">
                    <button type="button" class="wdm-hud-btn wdm-hud-btn-with-help ${isSneaking ? "is-on" : ""}" data-action="toggle-stealth" title="${t("WITCHER.Policy.WitcherTokenHud.Text.ToggleStealth", "Toggle stealth (sneak / unsneak)")}">
                        <i class="fa-solid ${isSneaking ? "fa-user-secret" : "fa-user-ninja"}"></i><span>${isSneaking ? t("WITCHER.Policy.WitcherTokenHud.Text.Unsneak", "Unsneak") : t("WITCHER.Policy.WitcherTokenHud.Text.Sneak", "Sneak")}</span>
                    </button>
                    <button type="button" class="wdm-hud-btn-help" data-action="stealth-info" title="${t("WITCHER.Policy.WitcherTokenHud.Text.HowStealthWorks", "How stealth works")}"><i class="fa-solid fa-circle-question"></i></button>
                </div>` : ""}
            </div>
        </section>

        <details class="wdm-hud-section wdm-hud-section-collapsible" data-section="statuses" ${_statusesOpen ? "open" : ""}>
            <summary class="wdm-hud-section-label">
                ${t("WITCHER.Policy.WitcherTokenHud.Text.Statuses", "Statuses")}
                <i class="fa-solid fa-chevron-right wdm-hud-chev wdm-hud-chev-end"></i>
            </summary>
            <div class="wdm-hud-status-grid">
                ${renderStatusGrid(token)}
            </div>
        </details>

        ${(hp.max > 0 || sta.max > 0) ? `
        <section class="wdm-hud-section">
            <div class="wdm-hud-section-label">${t("WITCHER.Policy.WitcherTokenHud.Text.Vitality", "Vitality")}</div>
            ${hp.max  > 0 ? renderVitalityBar("HP",  hp.cur,  hp.max)  : ""}
            ${sta.max > 0 ? renderVitalityBar("STA", sta.cur, sta.max) : ""}
        </section>
        ` : ""}

        <footer class="wdm-hud-foot">
            <button type="button" class="wdm-hud-btn" data-action="open-sheet" title="${t("WITCHER.Policy.WitcherTokenHud.Text.OpenActorSheet", "Open actor sheet")}">
                <i class="fa-solid fa-id-card"></i><span>${t("WITCHER.Policy.WitcherTokenHud.Text.Sheet", "Sheet")}</span>
            </button>
            <button type="button" class="wdm-hud-btn" data-action="configure-token" title="${t("WITCHER.Policy.WitcherTokenHud.Text.ConfigureToken", "Configure token")}">
                <i class="fa-solid fa-gear"></i><span>${t("WITCHER.Policy.WitcherTokenHud.Text.Token", "Token")}</span>
            </button>
        </footer>

        </div>
    `;
    return el;
}

/* ─────────── positioning ─────────── */

function positionHUD(hud, token) {
    if (!hud) return;
    /* Body-fixed positioning with a manual world→viewport map so the
       HUD is completely independent of Foundry's #hud container: its
       parent transform used to swallow our own scale (children were
       painted through the parent's transform pipeline and any inline
       transform we set was flattened into the same visual pipeline as
       the anchor). Live in body with position:fixed and everything
       stays under our control: position via manual world→screen, size
       via inline scale from the WDM UI-scale vars. */
    hud.style.position = "fixed";
    hud.style.zIndex = "100";

    /* UI scale via CSS `zoom`. `zoom` scales both size AND left/top
       proportionally — so if we set `left: X`, the visual left is at
       `X * zoom`. Divide the calculated position by zoom AFTER the
       anchor math and the two multiplications cancel: visual position
       is exactly the anchor coord we computed, and the HUD's visual
       size scales as intended.
       Reason for zoom over transform:scale — several rounds of testing
       showed `transform: scale()` reads as "anchor shifting" at
       non-1 scales in this environment (likely a CSS-origin quirk on
       body-fixed elements). `zoom` behaves deterministically here.
       Scale = main UI Scale (Text) × a secondary factor (popup in Detailed,
       else Overall Scaling). The previous code used a priority FALLBACK
       (popup → bars → wdm), but --wdm-chrome-bars-scale is ALWAYS set
       (default 1.0), so `bars` always won and `--wdm-scale` was never used —
       the HUD text tracked Overall Scaling but not UI Scale. Multiplying
       --wdm-scale in (same as the chrome bars now do) makes UI Scale grow the
       HUD text too. rem doesn't reach this HUD in v14, so this zoom is the
       only thing that scales it — no double-scale. */
    const rootCS = getComputedStyle(document.documentElement);
    const popup = parseFloat(rootCS.getPropertyValue("--wdm-popup-scale"));
    const bars  = parseFloat(rootCS.getPropertyValue("--wdm-chrome-bars-scale"));
    const wdm   = parseFloat(rootCS.getPropertyValue("--wdm-scale"));
    const secondary = Number.isFinite(popup) && popup > 0 ? popup
                    : Number.isFinite(bars)  && bars  > 0 ? bars
                    : 1;
    const wdmSafe = Number.isFinite(wdm) && wdm > 0 ? wdm : 1;
    const uiScale = wdmSafe * secondary;
    hud.style.zoom = String(uiScale);
    /* Clear the transform we were setting in prior attempts so it can't
       compound with the zoom below. */
    hud.style.transform = "";
    hud.style.transformOrigin = "";

    // If the user dragged the HUD, honor that viewport position across
    // re-renders until they close it.
    if (_hudPosition) {
        /* _hudPosition is a VISUAL (viewport) coord. The HUD carries `zoom`,
           which paints style.left/top at value×zoom, so divide by uiScale to
           land the visible corner exactly on the stored spot — same
           compensation as the fresh-anchor placement below. */
        hud.style.left = `${_hudPosition.left / uiScale}px`;
        hud.style.top  = `${_hudPosition.top / uiScale}px`;
        return;
    }

    if (!token || !canvas?.stage) return;
    const bounds = token.bounds ?? new PIXI.Rectangle(token.x, token.y, token.w ?? 100, token.h ?? 100);

    /* Screen-space (viewport-relative) anchoring — immersive-token-mode
       rotates the whole stage, so mapping a specific WORLD corner (e.g.
       world top-right) through worldTransform.apply doesn't land visually
       to the right of the token anymore; it lands wherever that world
       corner rotated to on screen. Anchor to the token's CENTER converted
       to viewport, then offset horizontally by half the token's screen
       width so the HUD always sits to the visual right of the token
       regardless of camera rotation. Stage scale is a uniform factor
       (rotation preserves the token's on-screen dimensions), so
       `bounds.width * scale.x` gives the correct screen-pixel width. */
    const stage = canvas.stage;
    const scale = Number(stage.scale?.x) || 1;
    const centerWorld = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const centerViewport = stage.worldTransform.apply(centerWorld);
    const halfW = (bounds.width  * scale) / 2;
    const halfH = (bounds.height * scale) / 2;
    const padding = 12;
    /* Divide by zoom to compensate for `zoom`'s position-multiplier
       side effect: browser will paint at `left * zoom` visually, so
       setting `left = anchor / zoom` puts the visible top-left exactly
       at `anchor` viewport pixels. Same math for top. */
    hud.style.left = `${Math.round((centerViewport.x + halfW + padding) / uiScale)}px`;
    hud.style.top  = `${Math.round((centerViewport.y - halfH) / uiScale)}px`;

    /* Right-edge flip — if the HUD would overflow the viewport's right
       edge, put it on the LEFT of the token instead. Same viewport-space
       math so rotation stays a non-factor. */
    const panelRect = hud.getBoundingClientRect();
    if (panelRect.right > window.innerWidth - 4) {
        hud.style.left = `${Math.round((centerViewport.x - halfW - panelRect.width - padding) / uiScale)}px`;
    }

    /* Bottom-edge lift — the immersive-camera bottom bar (`#wou-dock`)
       covers the lower portion of the viewport. If the HUD's default
       "top-aligned to the token" position runs it past the top edge
       of the dock, shift the top upward by the overflow amount so
       every action stays fully visible. Uses the LIVE dock rect at
       position time so a dock that expanded for combat (extra STA /
       adrenaline rows) is honored. Falls back to a small safety
       margin when no dock is mounted. */
    const dockEl = document.getElementById("wou-dock");
    const dockTop = dockEl?.getBoundingClientRect?.().top ?? (window.innerHeight - 4);
    const bottomLimit = dockTop - 4;
    /* Re-read after any right-edge flip above so we measure the
       correct final width and its resulting bottom edge. */
    const finalRect = hud.getBoundingClientRect();
    if (finalRect.bottom > bottomLimit) {
        const overflow = finalRect.bottom - bottomLimit;
        /* Lift by `overflow / uiScale` — same zoom-compensation math
           as the initial placement so the visual shift matches the
           actual overflow in viewport pixels. Clamp so the HUD never
           slides above the top of the viewport. */
        const currentTop = parseFloat(hud.style.top) || 0;
        const liftedTop = Math.max(4 / uiScale, currentTop - overflow / uiScale);
        hud.style.top = `${Math.round(liftedTop)}px`;
    }
}

/* ─────────── show / hide ─────────── */

function hideHUD() {
    if (_hudEl) {
        try { _hudEl.remove(); } catch (_) { /* detached */ }
    }
    _hudEl = null;
    _activeToken = null;
}

function showHUD(token) {
    hideHUD();
    if (!token || !token.actor && !token.document) return;
    _activeToken = token;
    _hudEl = buildHUD(token);
    /* Body-fixed: keeps the HUD out of Foundry's #hud container so
       #hud's own `transform: scale(canvas.stage.scale.x)` doesn't
       swallow our inline scale. positionHUD does the world→viewport
       math itself so canvas pan + zoom still track correctly. */
    document.body.appendChild(_hudEl);
    _hudEl.style.pointerEvents = "auto";
    positionHUD(_hudEl, token);
    wireActions(_hudEl, token);
}

function refreshHUD() {
    if (!_activeToken) return;
    showHUD(_activeToken);
}

/* ─────────── status apply (shared with chrome/context-menu-actor) ─────────── */

/* Add a status. DoT/stackable statuses create a fresh AE instance (so a new
 * combat bleed piles on top of any wound-sourced bleed); non-stackable
 * statuses are a binary toggle on the actor's shared status Set. Matches the
 * Apply Status dialog so both entry points behave identically. */
async function applyStatus(actor, id, stack) {
    if (!actor || !id) return;
    try {
        if (stack) {
            const def = (CONFIG.statusEffects ?? []).find(s => s.id === id) ?? {};
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name:     def.name ? game.i18n.localize(def.name) : id,
                img:      def.img ?? "icons/svg/aura.svg",
                statuses: [id]
            }]);
        } else {
            const active = actor.statuses?.has?.(id) ?? false;
            await actor.toggleStatusEffect(id, { active: !active });
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | apply status ${id} failed`, err);
        ui.notifications?.error(tFormat("WITCHER.Policy.WitcherTokenHud.Notify.FailedToApplyStatusX", { id: id }, "Failed to apply status: {id}"));
    }
}

/* Remove one non-wound instance of a stackable status. Wound-sourced
 * instances are flagged and left alone (they clear when the wound is
 * treated). Mirrors the Apply Status dialog. */
async function removeStatusStack(actor, id) {
    if (!actor || !id) return;
    const nonWound = (actor.effects?.contents ?? [])
        .filter(e => e.statuses?.has?.(id) && !e.flags?.[SYSTEM_ID]?.woundStatus);
    if (!nonWound.length) {
        ui.notifications?.info(tFormat("WITCHER.Policy.WitcherTokenHud.Notify.NoRemovableXWoundSourcedInstances", { id: id }, "No removable {id} — wound-sourced instances clear when the wound is treated."));
        return;
    }
    try { await actor.deleteEmbeddedDocuments("ActiveEffect", [nonWound[nonWound.length - 1].id]); }
    catch (err) { console.warn(`${SYSTEM_ID} | remove status ${id} failed`, err); }
}

/* ─────────── action wiring ─────────── */

function wireActions(hud, token) {
    /* Action delegation (clicks). */
    hud.addEventListener("click", async (ev) => {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const action = btn.dataset.action;
        try {
            switch (action) {
                case "close":             hideHUD(); _hudPosition = null; return;
                case "toggle-combat":     await toggleCombatant(token); break;
                case "toggle-hidden":     await token.document.update({ hidden: !token.document.hidden }); break;
                case "toggle-target":     token.setTarget(!token.isTargeted, { releaseOthers: false }); break;
                case "toggle-stealth": {
                    /* Owner-only. HUD stays visible after; the flag update
                     * fires an `updateActor` hook that re-renders the HUD. */
                    if (!token.actor?.isOwner) {
                        ui.notifications?.warn(t("WITCHER.Mech.Stealth.Notify.NotOwner",
                            "You don't own this actor."));
                        break;
                    }
                    await toggleStealth(token.actor);
                    break;
                }
                case "stealth-info": {
                    /* Small "?" affordance on the sneak button — opens a
                     * proper dialog explaining the stealth system in
                     * layman's terms, styled with our system chrome. */
                    await showStealthExplainerDialog();
                    break;
                }
                case "open-sheet":        await token.actor?.sheet?.render(true); break;
                case "configure-token":   await token.document.sheet?.render(true); break;
                case "toggle-status": {
                    const statusId = btn.dataset.status;
                    if (!statusId) break;
                    const stack = btn.dataset.stackable === "true";
                    await applyStatus(token.actor, statusId, stack);
                    break;
                }
            }
            if (action === "toggle-target") refreshHUD();
        } catch (err) {
            console.warn(`${SYSTEM_ID} | token HUD action "${action}" failed`, err);
        }
    });

    /* Right-click a stackable status to remove one (non-wound) instance. */
    hud.addEventListener("contextmenu", async (ev) => {
        const btn = ev.target.closest('.wdm-hud-status[data-stackable="true"]');
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const statusId = btn.dataset.status;
        if (statusId) await removeStatusStack(token.actor, statusId);
    });

    /* Persist the collapsed/open state of any <details> section across the
     * HUD's frequent re-renders. The native <details> toggle fires after
     * the attribute changes, so we capture the new state on `toggle`. */
    hud.addEventListener("toggle", (ev) => {
        const det = ev.target;
        if (!(det instanceof HTMLDetailsElement)) return;
        if (det.dataset.section === "statuses") _statusesOpen = det.open;
    }, true);

    /* Window-style drag on the titlebar. Mousedown captures the offset
     * from the click point to the HUD's top-left corner; mousemove
     * updates `_hudPosition` (which positionHUD honors); mouseup releases.
     * Detaches listeners on cancel to avoid leaks across re-renders. */
    const handle = hud.querySelector('[data-drag-handle]');
    if (handle) {
        const onDown = (ev) => {
            if (ev.button !== 0) return; // left only
            const target = ev.target;
            // Don't start a drag if the user clicked the close button.
            if (target.closest('[data-action="close"]')) return;
            ev.preventDefault();
            const rect = hud.getBoundingClientRect();
            _dragState = {
                offsetX: ev.clientX - rect.left,
                offsetY: ev.clientY - rect.top
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        };
        const onMove = (ev) => {
            if (!_dragState) return;
            _hudPosition = {
                left: Math.max(0, Math.min(window.innerWidth - 50, ev.clientX - _dragState.offsetX)),
                top:  Math.max(0, Math.min(window.innerHeight - 50, ev.clientY - _dragState.offsetY))
            };
            /* _hudPosition is VISUAL px but the HUD carries `zoom`, which paints
               style.left/top at value×zoom. Without dividing by the live zoom the
               panel drifts at the scale factor (moving faster/slower than the
               cursor and slipping past it). Divide so it tracks the cursor 1:1. */
            const uiScale = parseFloat(hud.style.zoom) || 1;
            hud.style.left = `${_hudPosition.left / uiScale}px`;
            hud.style.top  = `${_hudPosition.top / uiScale}px`;
        };
        const onUp = () => {
            _dragState = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        handle.addEventListener("mousedown", onDown);
    }
}

async function toggleCombatant(token) {
    const inCombat = !!game.combat?.combatants?.some?.(c => c.tokenId === token.id);
    if (inCombat) {
        const c = game.combat.combatants.find(c => c.tokenId === token.id);
        if (c) await c.delete();
    } else {
        if (!game.combat) {
            const cls = getDocumentClass("Combat");
            await cls.create({ scene: canvas.scene.id });
        }
        const [created] = await game.combat.createEmbeddedDocuments("Combatant", [{
            tokenId: token.id,
            sceneId: canvas.scene.id,
            actorId: token.actor?.id ?? null
        }]);
        /* Auto-roll initiative on add. Without this, the token sits in the
         * tracker at no initiative value until the GM clicks the d20 button,
         * which is an extra step for every monster on a busy encounter.
         * Pass the Witcher initiative formula (1d10 + REF) — this system
         * does NOT register a default `CONFIG.Combat.initiative.formula`,
         * so Foundry falls back to `1d20` if we don't specify. That was
         * the "REF not applied to initiative" symptom. Read the actor's
         * REF from the token's actor at roll time so a live buff/debuff
         * is honored. */
        if (created?.id) {
            const ref = Number(token.actor?.system?.stats?.ref?.value) || 0;
            const formula = `1d10 + ${ref}`;
            try {
                await game.combat.rollInitiative([created.id], { updateTurn: false, formula });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | auto-roll initiative failed", err);
            }
        }
    }
}

/* ─────────── lifecycle hooks ─────────── */

/* Right-click should ONLY open the options HUD — never change token selection.
 * Foundry's base PlaceableObject#_onClickRight controls (selects) the token
 * BEFORE binding the HUD:
 *
 *     const releaseOthers = !this.#controlled && !event.shiftKey;
 *     this.control({releaseOthers});                 // ← unwanted selection
 *     if ( this.hasActiveHUD ) this.layer.hud.close();
 *     else this.layer.hud.bind(this);
 *
 * Token doesn't override single right-click, so it inherits that. Selecting on
 * right-click is disruptive here (it also yanks the GM's view-as / dock onto
 * whatever was right-clicked). Install a Token-level _onClickRight that binds
 * the HUD (→ renderTokenHUD → our custom panel) WITHOUT the control() call.
 * Left-click selection is untouched. */
function patchRightClickNoSelect() {
    const TokenCls = foundry?.canvas?.placeables?.Token;
    if (!TokenCls || TokenCls.prototype.__wdmNoSelectRightClick) return;
    TokenCls.prototype.__wdmNoSelectRightClick = true;
    TokenCls.prototype._onClickRight = function _onClickRightWitcher(event) {
        const layer = this.layer;
        if (layer?.hud) {
            if (this.hasActiveHUD) layer.hud.close();
            else layer.hud.bind(this);
        }
        // Preserve Foundry's canvas-propagation contract for the right-click.
        if (!this._propagateRightClick(event)) event.stopPropagation();
    };
}

export function registerWitcherTokenHUD() {
    if (_hooksWired) return;
    _hooksWired = true;

    try { patchRightClickNoSelect(); }
    catch (err) { console.warn("witcher-ttrpg-death-march | right-click no-select patch failed", err); }

    /* Right-click on a token is the only trigger — Foundry's default Token
     * HUD opens on right-click, so we hijack `renderTokenHUD`: close the
     * default and show our custom panel for the same token. Every right-
     * click re-fires this, so re-opening after the user dismissed the panel
     * works without needing to deselect+reselect the token. */
    Hooks.on("renderTokenHUD", (hud) => {
        const token = hud?.object ?? null;
        try { hud.close({ force: true }); } catch (_) { /* not yet rendered */ }
        if (token) showHUD(token);
    });

    // Deselecting the token also hides the HUD (matches Foundry's default).
    Hooks.on("controlToken", (token, controlled) => {
        if (!controlled && _activeToken && _activeToken.id === token.id) hideHUD();
    });

    // Keep position in sync with canvas pan / zoom.
    Hooks.on("canvasPan", () => {
        if (_hudEl && _activeToken) positionHUD(_hudEl, _activeToken);
    });

    /* Live-track UI Scale slider changes. ui-scale.js writes
       `--wdm-scale` (and `--wdm-popup-scale` in Detailed mode) to
       <html>'s style attribute; a MutationObserver on that attribute
       lets us re-run positionHUD (which reads the vars and rewrites
       hud.style.transform) without waiting for the next canvas pan.
       Cheap — the callback only touches DOM when the HUD is open. */
    try {
        new MutationObserver(() => {
            if (_hudEl && _activeToken) positionHUD(_hudEl, _activeToken);
        }).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["style"]
        });
    } catch (_) { /* no MutationObserver → no live update */ }

    // Document updates → re-render the HUD content so HP / statuses /
    // visibility track the current document state.
    Hooks.on("updateToken", (doc) => {
        if (_activeToken && _activeToken.id === doc.id) refreshHUD();
    });
    Hooks.on("updateActor", (actor) => {
        if (_activeToken?.actor?.id === actor.id) refreshHUD();
    });
    Hooks.on("createActiveEffect", (eff) => {
        if (_activeToken?.actor?.id === eff?.parent?.id) refreshHUD();
    });
    Hooks.on("deleteActiveEffect", (eff) => {
        if (_activeToken?.actor?.id === eff?.parent?.id) refreshHUD();
    });
    Hooks.on("updateActiveEffect", (eff) => {
        if (_activeToken?.actor?.id === eff?.parent?.id) refreshHUD();
    });
    Hooks.on("createCombatant", refreshHUD);
    Hooks.on("deleteCombatant", refreshHUD);

    // Scene change / token delete clears any lingering HUD.
    Hooks.on("canvasReady", hideHUD);
    Hooks.on("deleteToken",  (doc) => { if (_activeToken?.id === doc.id) hideHUD(); });

    /* Click anywhere on the scene that isn't the HUD or a Foundry UI panel
     * closes the HUD. Capture-phase so canvas pointer handling doesn't eat
     * the event first. The right-click that opens the HUD also fires this,
     * but _hudEl is null at that moment so the early-return short-circuits;
     * by the time the user clicks again, _hudEl is set and dismissal works. */
    window.addEventListener("pointerdown", (ev) => {
        if (!_hudEl) return;
        if (_hudEl.contains(ev.target)) return;
        const inUI = !!ev.target.closest?.(
            "#sidebar, #ui-left, #ui-top, #ui-bottom, #ui-right, " +
            ".application, .window-app, dialog, [role=\"dialog\"]"
        );
        if (inUI) return;
        hideHUD();
        _hudPosition = null;
    }, true);
}
