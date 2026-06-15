/**
 * Left bar — Party section.
 *
 * Injects <section.wou-party> + a runic divider at the END of #scene-controls
 * (so it visually sits below Foundry's tool categories).  Idempotent on
 * renderSceneControls — re-injects if missing, swaps innerHTML if data changed.
 *
 * Read-only this task; assignment is added in Task 5.
 */

import { getRoster, getAssignableActors } from "../lib/users.js";

// Wolf medallion PNG (white silhouette) — tinted to amber via the CSS filter
// chain on `.wou-player-av .medallion` in leftbar.css, matching the dock's
// established `<img class="medallion">` pattern (see chrome.css §medallion).
// Race-by-race medallion picking is a future enhancement; every player uses
// wolf.png for now.
const WOLF_MEDALLION_SRC = "systems/witcher-ttrpg-death-march/assets/medallions/wolf.png";

let refreshTimer = null;

export function wireLeftBar() {
  installClickHandlers();
  document.body.classList.add("wou-leftbar-active");
  Hooks.on("renderSceneControls", reinjectParty);
  Hooks.on("renderSceneControls", reinjectFps);
  Hooks.on("updateUser",       scheduleRefresh);
  Hooks.on("userConnected",    scheduleRefresh);
  Hooks.on("createActor",      scheduleRefresh);
  Hooks.on("deleteActor",      scheduleRefresh);
  Hooks.on("updateActor",      (_actor, changes) => { if ("name" in changes) scheduleRefresh(); });

  reinjectParty();
  reinjectFps();
  startFpsLoop();
}

/* ── FPS counter ──────────────────────────────────────────────────────
 * A tiny debug readout at the very bottom of #scene-controls.  Updates
 * twice a second from a requestAnimationFrame loop; the rAF cadence
 * IS the framerate signal so the counter naturally reads what the
 * browser is actually painting.
 */

let fpsFrames = 0;
let fpsLast   = 0;
let fpsLoopStarted = false;

function reinjectFps() {
  const sc = document.getElementById("scene-controls");
  if (!sc) return;
  if (sc.querySelector("section.wou-fps")) return;

  /* Section node sits AFTER the party section (and AFTER its preceding
   * divider) so it's the lowest element in the left bar.  Idempotent:
   * if `renderSceneControls` fires again, we just bail above. */
  const divider = document.createElement("div");
  divider.className = "wou-divider wou-divider-fps";
  const section = document.createElement("section");
  section.className = "wou-fps";
  section.innerHTML = `
    <div class="wou-fps-label">FPS</div>
    <div class="wou-fps-value" data-tier="ok">—</div>
  `;
  sc.append(divider, section);
}

function startFpsLoop() {
  if (fpsLoopStarted) return;
  fpsLoopStarted = true;
  fpsLast = performance.now();
  const tick = (t) => {
    fpsFrames++;
    if (t - fpsLast >= 500) {
      const fps = Math.round((fpsFrames * 1000) / (t - fpsLast));
      fpsFrames = 0;
      fpsLast = t;
      const el = document.querySelector("#scene-controls section.wou-fps .wou-fps-value");
      if (el) {
        el.textContent = String(fps);
        el.dataset.tier = fps >= 55 ? "ok" : fps >= 30 ? "warn" : "bad";
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    reinjectParty();
  }, 50);
}

function reinjectParty() {
  const sc = document.getElementById("scene-controls");
  if (!sc) return;

  let section = sc.querySelector("section.wou-party");
  if (!section) {
    const divider = document.createElement("div");
    divider.className = "wou-divider";
    section = document.createElement("section");
    section.className = "wou-party";
    sc.append(divider, section);
  }

  const html = buildPartyHTML();
  if (section.dataset.sig === html.sig) return;
  // Roster changed — the rows are about to be replaced, so any open picker is
  // now anchored to a stale row.  Close it before swapping.
  closePicker();
  section.dataset.sig = html.sig;
  section.innerHTML = html.body;
}

function buildPartyHTML() {
  const isGMViewer = game.user.isGM;
  const roster = getRoster();

  const label = game.i18n.localize("WOU.party.label");
  const unassigned = game.i18n.localize("WOU.party.unassigned");
  const noPlayers = game.i18n.localize("WOU.party.no-players");
  const gmLabel = game.i18n.localize("WOU.party.gm-label");

  const hasNonGM = roster.some(r => !r.isGM);
  let rowsHtml = roster.map(r => renderRow(r, isGMViewer, unassigned, gmLabel)).join("");
  if (!hasNonGM) {
    rowsHtml += `<div class="wou-party-empty">${escapeHtml(noPlayers)}</div>`;
  }

  // Signature catches any visible change. Picker state lives on the DOM and is
  // re-applied separately to avoid clobbering an open picker on refresh.
  const sig = roster.map(r =>
    `${r.user.id}:${r.online ? 1 : 0}:${r.character?.id ?? "-"}:${r.user.name}:${r.character?.name ?? ""}:${r.isGM ? "g" : "p"}`
  ).join("|");

  return {
    sig,
    body: `
      <div class="wou-party-label">${escapeHtml(label)}</div>
      <div class="wou-party-list">${rowsHtml}</div>
    `
  };
}

function renderRow(row, isGMViewer, unassignedLabel, gmLabel) {
  const pickable = isGMViewer;
  const classes = [
    "wou-player-row",
    row.online ? "is-online" : "is-offline",
    row.isSelf ? "is-self" : "",
    row.isGM ? "is-gm" : "",
    pickable ? "is-gm-viewer" : ""
  ].filter(Boolean).join(" ");

  let charHtml;
  if (row.character) {
    const gmSuffix = row.isGM
      ? ` <span class="wou-gm-tag">· ${escapeHtml(gmLabel)}</span>`
      : "";
    charHtml = `<span class="wou-player-char">${escapeHtml(row.character.name)}${gmSuffix}</span>`;
  } else if (row.isGM) {
    charHtml = `<span class="wou-player-char is-gm-tag">${escapeHtml(gmLabel)}</span>`;
  } else {
    charHtml = `<span class="wou-player-char is-unassigned">${escapeHtml(unassignedLabel)}</span>`;
  }

  // The picker is NOT embedded in the row.  #scene-controls carries a
  // transform (.wou-collapse-left slide) + overflow:hidden, which would trap
  // and clip a position:fixed child.  Instead togglePicker() builds the picker
  // on demand and appends it to <body>, positioned against the row's rect.
  return `
    <div class="${classes}" data-user-id="${row.user.id}" data-current-actor-id="${row.character?.id ?? ""}">
      <span class="wou-player-av"><img class="medallion" src="${WOLF_MEDALLION_SRC}" alt="" aria-hidden="true" /></span>
      <span class="wou-player-text">
        <span class="wou-player-name">${escapeHtml(row.user.name)}</span>
        ${charHtml}
      </span>
      <span class="wou-player-dot"></span>
    </div>
  `;
}

function renderPicker(currentActorId) {
  const actors = getAssignableActors();
  const unassignLabel = game.i18n.localize("WOU.party.unassign-option");
  const unassignSelected = currentActorId === null ? " is-selected" : "";
  const unassignOpt =
    `<div class="wou-actor-option is-unassign${unassignSelected}" data-actor-id=""><span>${escapeHtml(unassignLabel)}</span></div>`;

  if (actors.length === 0) {
    const empty = game.i18n.localize("WOU.party.no-characters");
    return `<div class="wou-player-picker">${unassignOpt}<div class="wou-actor-option is-empty">${escapeHtml(empty)}</div></div>`;
  }
  const options = actors.map(a => {
    const selected = a.id === currentActorId ? " is-selected" : "";
    const img = a.img ? `<img src="${escapeHtml(a.img)}" alt="">` : "";
    return `<div class="wou-actor-option${selected}" data-actor-id="${a.id}">${img}<span>${escapeHtml(a.name)}</span></div>`;
  }).join("");
  return `<div class="wou-player-picker">${unassignOpt}${options}</div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

let handlersInstalled = false;

// The single floating picker element, appended to <body> while open.  null
// when closed.  Stays out of #scene-controls so the bar's transform/overflow
// can't trap or clip it.
let floatingPicker = null;

function installClickHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  document.addEventListener("click", (event) => {
    if (!game.user.isGM) return;

    const optionEl = event.target.closest(".wou-actor-option:not(.is-empty)");
    if (optionEl && floatingPicker?.contains(optionEl)) {
      event.preventDefault();
      event.stopPropagation();
      const userId = floatingPicker.dataset.userId;
      // Empty data-actor-id is the unassign option — pass null through.
      const actorId = optionEl.dataset.actorId || null;
      if (userId) assignCharacter(userId, actorId);
      return;
    }

    const rowEl = event.target.closest("#scene-controls .wou-player-row.is-gm-viewer");
    if (rowEl) {
      event.preventDefault();
      event.stopPropagation();
      togglePicker(rowEl);
      return;
    }

    // Click anywhere else (including inside the picker's empty area) closes it.
    if (!floatingPicker || !floatingPicker.contains(event.target)) closePicker();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePicker();
  });

  // Keep the popup glued to its row as the bar or window moves.
  window.addEventListener("resize", closePicker);
  window.addEventListener("scroll", closePicker, true);
}

function togglePicker(rowEl) {
  const isOpenForRow = floatingPicker?.dataset.userId === rowEl.dataset.userId;
  closePicker();
  if (isOpenForRow) return;

  const currentActorId = rowEl.dataset.currentActorId || null;
  const picker = document.createElement("div");
  picker.innerHTML = renderPicker(currentActorId);
  const el = picker.firstElementChild;
  el.dataset.userId = rowEl.dataset.userId;
  document.body.appendChild(el);
  floatingPicker = el;
  positionPicker(el, rowEl);
}

// Anchor the picker to the right edge of the row, clamped into the viewport.
function positionPicker(el, rowEl) {
  const r = rowEl.getBoundingClientRect();
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  const gap = 6;
  // Prefer to the right of the bar; fall back to the left if it would overflow.
  let left = r.right + gap;
  if (left + pw > window.innerWidth - 4) left = r.left - gap - pw;
  if (left < 4) left = 4;
  let top = r.top;
  if (top + ph > window.innerHeight - 4) top = window.innerHeight - 4 - ph;
  if (top < 4) top = 4;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function closePicker() {
  if (!floatingPicker) return;
  floatingPicker.remove();
  floatingPicker = null;
}

async function assignCharacter(userId, actorId) {
  const user = game.users.get(userId);
  if (!user) return;
  const prevActor = user.character ?? null;
  const newActor = actorId ? game.actors.get(actorId) : null;
  try {
    // Revoke OWNER on the previous character (if any and different from new).
    if (prevActor && prevActor.id !== actorId) {
      await prevActor.update({ [`ownership.-=${userId}`]: null });
    }
    // Grant OWNER on the new character.
    if (newActor) {
      await newActor.update({
        [`ownership.${userId}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
      });
    }
    await user.update({ character: actorId });
    // Deterministically collapse the picker; do not rely on the updateUser
    // hook firing (it won't if the assignment was a no-op write).
    closePicker();
  } catch (err) {
    console.error("[wou] character assignment failed", err);
    ui.notifications.warn(game.i18n.localize("WOU.party.assign-failed"));
  }
}
