/**
 * Floating circular status indicators above the dock's namebar.
 *
 * Witcher-3-styled:  for each active ActiveEffect on the assigned actor,
 * renders a small disc with the effect's icon, a circular progress ring
 * showing turns remaining out of total duration, and (when the effect has
 * a duration) a small number badge with the remaining turn count.
 *
 * Hover a badge for a tooltip with the effect's name + description.
 *
 * Refreshes on:
 *   - actor effect create/update/delete
 *   - combat turn/round changes
 *   - assigned-character swaps (updateUser)
 */

import { getAssignedActor } from "../lib/actor.js";

let _hooksWired = false;
let _popoverInstalled = false;

/**
 * Custom hover popover for status badges, bypassing Foundry's TooltipManager.
 * The previous data-tooltip-based approach caused #interface to dislodge to
 * the left when the cursor crossed from a status badge into the right
 * sidebar — Foundry's tooltip-clamping logic seems to misbehave when the
 * tooltip's anchor element lives in #wou-dock (a sibling of #interface, not
 * a descendant).  This implementation owns its own DOM, positioning, and
 * show/hide, so it never touches the global #tooltip element or interacts
 * with Foundry's clamping machinery.
 */
const POPOVER_ID = "wou-status-popover";

function installStatusPopover() {
  if (_popoverInstalled) return;
  _popoverInstalled = true;

  // One styles block, one popover div, reused across all badges.
  const style = document.createElement("style");
  style.id = "wou-status-popover-style";
  style.textContent = `
    #${POPOVER_ID} {
      position: fixed;
      z-index: 9200;
      display: none;
      max-width: 320px;
      padding: 10px 14px 12px;
      background:
        radial-gradient(ellipse 280px 140px at 50% 0%, rgba(184,148,100,0.12), transparent 75%),
        linear-gradient(180deg, rgba(22,18,13,0.98) 0%, rgba(10,9,8,0.98) 100%);
      background-color: rgba(10,9,8,0.98);
      border: 1px solid var(--wdm-amber-dim);
      border-radius: 2px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.85), inset 0 0 0 1px rgba(184,148,100,0.10);
      color: var(--wdm-ink-hi);
      font-family: var(--wdm-font-body);
      font-size: 12px;
      line-height: 1.5;
      letter-spacing: 0.02em;
      text-align: left;
      pointer-events: none;             /* never grab the cursor */
    }
    #${POPOVER_ID}.is-open { display: block; }
  `;
  document.head.appendChild(style);

  const pop = document.createElement("div");
  pop.id = POPOVER_ID;
  document.body.appendChild(pop);

  // Delegated mouseenter/leave on the dock so we don't add one listener per
  // badge (the row re-renders frequently).
  const dock = document.getElementById("wou-dock");
  if (!dock) return;

  dock.addEventListener("mouseover", (e) => {
    const badge = e.target.closest(".wou-status-badge");
    if (!badge) return;
    const html = badge.dataset.wouTooltip;
    if (!html) return;
    pop.innerHTML = html;
    pop.classList.add("is-open");
    positionPopover(badge, pop);
  });
  dock.addEventListener("mouseout", (e) => {
    const badge = e.target.closest(".wou-status-badge");
    if (!badge) return;
    // Only hide when actually leaving the badge (not when moving inside it).
    if (badge.contains(e.relatedTarget)) return;
    pop.classList.remove("is-open");
  });
  // Hide if the badge gets removed mid-hover (refresh).
  window.addEventListener("scroll", () => pop.classList.remove("is-open"), { capture: true, passive: true });
}

function positionPopover(anchor, pop) {
  const ar = anchor.getBoundingClientRect();
  // Measure popover after content swap
  pop.style.left = "0px";
  pop.style.top = "0px";
  const pr = pop.getBoundingClientRect();
  let left = ar.left + ar.width / 2 - pr.width / 2;
  let top = ar.top - pr.height - 8;        // 8px gap above the badge
  // Clamp to viewport with 8px margin
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  if (top < 8) top = ar.bottom + 8;        // flip below if no room above
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

/* =========================================================================
   ROW INJECTION + REFRESH
   ========================================================================= */

export function injectStatusesRow() {
  const dock = document.getElementById("wou-dock");
  if (!dock) return;
  // Inject INSIDE the namebar so icons sit on the same line as TRISTAN
  // (matches the design in status.png).  margin-left:auto on the row
  // pushes it to the right side of the name-row.
  const nameRow = dock.querySelector(".identity .ident-text .name-row");
  if (!nameRow) return;
  if (nameRow.querySelector(".wou-statuses")) return;

  const row = document.createElement("div");
  row.className = "wou-statuses";
  /* Absolute-positioned along the name-row's right edge so the badges
   * don't dictate the row's height — name / profession determine the
   * row height, and the elements below (rule, vitality bar, race) stay
   * at their natural y position regardless of how many badges show.
   *
   * `max-width: 60%` caps the badge row to 60% of the name-row width so
   * it CAN shrink when it would otherwise overlap the name text.  Inside
   * that cap, each badge stays at its natural 22px size when there's
   * room, and only flex-shrinks (`flex: 0 1 22px; min-width: 8px`) when
   * the row hits its max-width ceiling. */
  row.style.cssText = [
    "display: flex",
    "flex-direction: row",
    "flex-wrap: nowrap",
    "align-items: center",
    "justify-content: flex-end",
    "gap: 4px",
    "overflow: visible",
    "pointer-events: auto",
    "position: absolute",
    "top: 0",
    "right: 0",
    "bottom: 0",
    "max-width: 60%",
    "min-width: 0",
    "z-index: 5"
  ].join("; ");
  nameRow.appendChild(row);

  if (!_hooksWired) {
    const refresh = () => refreshStatusesRow();
    const ownsEffect = (eff) => eff?.parent?.id === game.user.character?.id;
    Hooks.on("createActiveEffect", (eff) => { if (ownsEffect(eff)) refresh(); });
    Hooks.on("updateActiveEffect", (eff) => { if (ownsEffect(eff)) refresh(); });
    Hooks.on("deleteActiveEffect", (eff) => { if (ownsEffect(eff)) refresh(); });
    Hooks.on("combatTurn",   refresh);
    Hooks.on("combatRound",  refresh);
    Hooks.on("createCombat", refresh);
    Hooks.on("deleteCombat", refresh);
    Hooks.on("updateCombat", refresh);
    Hooks.on("updateWorldTime", refresh);  /* tick seconds-based badges */
    Hooks.on("updateUser",   (u) => { if (u.id === game.user.id) refresh(); });
    Hooks.on("updateActor",  (a) => { if (a.id === game.user.character?.id) refresh(); });
    _hooksWired = true;
  }

  installStatusPopover();
  refreshStatusesRow();
}

export function refreshStatusesRow() {
  const dock = document.getElementById("wou-dock");
  if (!dock) return;
  const row = dock.querySelector(".wou-statuses");
  if (!row) return;

  const actor = getAssignedActor();
  const effects = collectEffects(actor);

  if (effects.length === 0) {
    row.innerHTML = "";
    const profEl = row.parentElement?.querySelector(":scope > .profession");
    if (profEl) profEl.style.marginRight = "";
    return;
  }
  row.innerHTML = effects.map(statusBadgeHTML).join("");
  fitStatusGap(row);
  /* Recompute the gap when the name-row (or anything that affects its
   * width) resizes.  One observer per row instance is enough — bail if
   * we've already attached it. */
  if (!row.dataset.wouFitObs) {
    row.dataset.wouFitObs = "1";
    const parent = row.parentElement;
    if (parent && "ResizeObserver" in window) {
      new ResizeObserver(() => fitStatusGap(row)).observe(parent);
    }
  }
}

/**
 * Cap the badge row so it can't cover the name, then size the badges by
 * COUNT: full 60px for one, scaling down (never up) only as more need to
 * fit in the space after the name.
 *
 * The name (`.name`) is `white-space:nowrap` with no truncation, so its
 * full text — "Tristan" — is always laid out at full width even when the
 * absolutely-positioned badge row visually overlaps it.  We measure the
 * name's real right edge and cap the box (`max-width`) to the space after
 * it.  Then the badge size is the largest square (≤60) that lets all N
 * fit packed at MIN_GAP.  When they all fit at full size we clear the
 * explicit sizing entirely (pure CSS rendering, the known-good path) and
 * just space them with a comfortable gap.  When we DO scale, width AND
 * height are pinned together so the square can't blow up.
 */
function fitStatusGap(row) {
  if (!row) return;
  const N = row.children.length;

  const FULL        = 30;  // full badge size — never exceed
  const MIN_SIZE    = 14;  // smallest a badge scales to
  const COMFORT_GAP = 6;
  const MIN_GAP     = 2;
  const GUTTER      = 12;  // stop this far before the name text
  const PROF_GAP    = 10;  // breathing room between profession and badges

  const nameRow = row.parentElement;
  if (!nameRow) return;

  /* Pin an explicit square (width AND height together) on every badge.
   * Setting both dimensions removes any reliance on the CSS aspect-ratio
   * path, which renders unpredictably small inside this absolutely-
   * positioned, height-constrained row. */
  const applySize = (s) => {
    const v = `${s}px`;
    for (const c of row.children) {
      c.style.flexBasis = v; c.style.width = v; c.style.height = v; c.style.minWidth = v; c.style.maxWidth = v;
    }
  };

  /* Cap the box to the space after the name's true right edge. */
  const rowRect = nameRow.getBoundingClientRect();
  if (!rowRect.width) return;  // not laid out yet
  const nameEl    = nameRow.querySelector(":scope > .name");
  const nameRight = nameEl ? nameEl.getBoundingClientRect().right : rowRect.left;
  const allottedW = Math.max(FULL, Math.floor(rowRect.right - nameRight - GUTTER));
  row.style.width = "";
  row.style.maxWidth = `${allottedW}px`;

  const profEl = nameRow.querySelector(":scope > .profession");

  if (N < 1) {
    row.style.gap = "";
    if (profEl) profEl.style.marginRight = "";
    return;
  }

  /* Largest square (≤ FULL) that fits all N packed at MIN_GAP. One badge
   * always lands at FULL; size only drops as more must share the box. */
  const maxFit = Math.floor((allottedW - (N - 1) * MIN_GAP) / N);
  const size   = Math.max(MIN_SIZE, Math.min(FULL, maxFit));
  applySize(size);

  let gapNum;
  if (size >= FULL && N >= 2) {
    /* Plenty of room — open the gap up to a comfortable spacing that
     * closes as they crowd toward full packing. */
    const slack = allottedW - N * FULL;
    gapNum = Math.max(MIN_GAP, Math.floor(Math.min(COMFORT_GAP, slack / (N - 1))));
  } else {
    gapNum = MIN_GAP;
  }
  row.style.gap = `${gapNum}px`;

  /* Reserve the badges' footprint on the right so the profession text
   * ellipsizes just before them instead of rendering underneath.  The
   * name is `flex:0 0 auto` and never shrinks, so only the profession
   * yields — exactly what we want. */
  const occupied = N * size + (N - 1) * gapNum;
  if (profEl) profEl.style.marginRight = `${occupied + PROF_GAP}px`;
}

/** Visible effects: enabled and not suppressed. */
function collectEffects(actor) {
  if (!actor) return [];
  const all = actor.effects?.contents ?? actor.effects ?? [];
  return all.filter(eff => !eff.disabled && !eff.isSuppressed);
}

/* =========================================================================
   BADGE HTML
   ========================================================================= */

function statusBadgeHTML(effect) {
  const icon = effect.img || effect.icon || "icons/svg/aura.svg";
  const name = effect.name ?? "Effect";
  const desc = stripHtml(
    effect.description
    ?? effect.system?.description
    ?? effect.flags?.core?.statusId?.description
    ?? ""
  );
  const tooltipHTML = `<strong>${escapeText(name)}</strong>${
    desc ? `<br/><span style="opacity:0.85">${escapeText(desc)}</span>` : ""
  }`;

  const dur = effect.duration ?? {};
  const { total, remaining, label } = describeDuration(dur);
  const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 1;
  const pct  = Math.round(frac * 100);

  /* Badge size is flex-driven so a long status list shrinks badges in
   * place instead of pushing the layout or wrapping.
   *   - flex: 0 1 60px  → preferred 60px, can shrink, won't grow
   *   - min-width: 14px → shrink floor when the box is crowded
   *   - max-width: 60px → never grow past full size
   *   - aspect-ratio: 1 → height tracks width, badge stays square
   * Ring + icon size in PERCENT so they scale with the badge. */
  const badgeStyle = [
    "position: relative",
    "display: block",
    "flex: 0 1 60px",
    "min-width: 14px",
    "max-width: 60px",
    "aspect-ratio: 1",
    "overflow: visible",
    "cursor: help"
  ].join("; ");

  return `
    <div class="wou-status-badge" style="${badgeStyle}"
         data-wou-tooltip='${escapeAttr(tooltipHTML)}'
         data-effect-id="${escapeAttr(effect.id)}">
      <svg class="wou-status-ring" viewBox="0 0 30 30" aria-hidden="true"
           style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;">
        <circle class="ring-track" cx="15" cy="15" r="12"
                fill="none" stroke-width="3" pathLength="100"/>
        <circle class="ring-fill" cx="15" cy="15" r="12"
                fill="none" stroke-width="3" pathLength="100"
                stroke-dasharray="${pct} 100"
                transform="rotate(-90 15 15)"/>
      </svg>
      <img class="wou-status-icon" src="${escapeAttr(icon)}" alt="" draggable="false"
           style="position:absolute;top:50%;left:50%;width:73%;height:73%;transform:translate(-50%,-50%);border-radius:50%;object-fit:cover;border:1px solid rgba(140,133,121,0.45);"/>
      ${total > 0 ? `<span class="wou-status-num" style="position:absolute;top:-2px;right:-1px;z-index:10;line-height:1;font-weight:700;white-space:nowrap;color:#e8e1cb;text-shadow:0 0 2px #000,0 0 3px #000,0 1px 0 #000;pointer-events:none;">${label}</span>` : ""}
    </div>
  `;
}

/**
 * Classify a duration object as seconds-based or rounds-based and return
 * the total / remaining (in matching units) plus a formatted label.
 *
 *   seconds-based  →  H:MMh   (>= 1 hour)
 *                  →  Mm      (>= 1 minute, < 1 hour)
 *                  →  S       (< 1 minute, raw seconds)
 *   rounds-based   →  N       (rounds remaining)
 */
export function describeDuration(dur) {
  if (!dur) return { total: 0, remaining: 0, label: "" };

  const roundSecs = Number(CONFIG.time?.roundTime) || 0;
  const inCombat  = !!game.combat?.started && roundSecs > 0;

  /* Combat-pacing units (rounds / turns). v14 stores them as {value, units};
   * `remaining` is the Foundry-computed count this round (Infinity out of
   * combat, where there's no tracker to ride).
   *   IN combat  → a count that ticks one-per-round ("20 r" → 19 → 18).
   *   OUT of combat → the same span expressed on the wall clock (roundTime
   *   seconds per round), so a rounds-based effect reads as a timer just like
   *   a minute potion does — the two stay uniform. */
  if (dur.units === "rounds" || dur.units === "turns") {
    const total = Number(dur.value) || 0;
    const r = Number(dur.remaining);
    const remaining = Number.isFinite(r) ? Math.max(0, Math.ceil(r)) : total;
    if (inCombat) {
      const suffix = dur.units === "rounds" ? "r" : "t";
      return { total, remaining, label: total > 0 ? `${remaining} ${suffix}` : "" };
    }
    const totalSecs = total * roundSecs;
    const remSecs   = remaining * roundSecs;
    return { total: totalSecs, remaining: remSecs, label: total > 0 ? formatSecondsLabel(remSecs) : "" };
  }

  /* Time-based: v14 computes secondsRemaining from start.time + value/units.
   * IN combat the wall clock is paced by the round clock, so a minute/hour
   * potion would crawl down a few seconds at a time — convert it to a rounds
   * readout so it ticks one-per-round, matching combat-unit effects. */
  const totalSecs = Number(dur.seconds);
  if (Number.isFinite(totalSecs) && totalSecs > 0) {
    const rem = Number(dur.secondsRemaining);
    const remaining = Number.isFinite(rem) ? Math.max(0, rem) : totalSecs;
    if (inCombat) {
      const totalR = Math.max(1, Math.ceil(totalSecs / roundSecs));
      const remR   = Math.max(0, Math.ceil(remaining / roundSecs));
      return { total: totalR, remaining: remR, label: remR > 0 ? `${remR} r` : "" };
    }
    return { total: totalSecs, remaining, label: formatSecondsLabel(remaining) };
  }

  return { total: 0, remaining: 0, label: "" };
}

/* Largest whole-unit readout, with the next-smaller unit shown when non-zero
 * so the label tracks real elapsed time without rounding up:
 *   < 60s   → "23s"        (exact seconds, never rounded up to a minute)
 *   < 60m   → "1:30 m"     ("2m" when no leftover seconds)
 *   < 24h   → "1:12 h"     ("3h"  when no leftover minutes)
 *   else    → "1:06 d"     ("2d"  when no leftover hours)
 * Seconds are floored, never ceiled — 59s reads "59s", not "1m". */
export function formatSecondsLabel(secs) {
  secs = Math.max(0, Math.floor(secs));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60), s = secs % 60;
    return s ? `${m}:${String(s).padStart(2, "0")} m` : `${m}m`;
  }
  if (secs < 86400) {
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
    return m ? `${h}:${String(m).padStart(2, "0")} h` : `${h}h`;
  }
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600);
  return h ? `${d}:${String(h).padStart(2, "0")} d` : `${d}d`;
}

/* =========================================================================
   UTILS
   ========================================================================= */

function stripHtml(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html);
  return (tmp.textContent || "").trim();
}

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
