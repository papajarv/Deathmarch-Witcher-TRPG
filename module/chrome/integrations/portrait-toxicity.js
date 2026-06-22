/**
 * Variable portrait integration.
 *
 * A character whose race item has `system.variablePortrait` checked gets a
 * "Variable portrait" button in the character chrome header. The button opens
 * a config grid that links image paths to:
 *
 *   - seven TOXICITY TIERS (relative bands of the actor's toxicity.max), and
 *   - any number of user-defined CONDITION columns (matched against an active
 *     effect / status name — e.g. a potion, oil, spell, or "trance").
 *
 * At runtime `actor.img` is swapped to the matching image whenever toxicity or
 * a relevant effect changes, so the swap is visible everywhere the actor
 * portrait shows (chrome, sheet, token art that reads actor.img).
 *
 * Tier bands are RELATIVE: a tier applies when value / max ≤ its bound, so the
 * same config scales to any toxicity max. With the default max of 100 the bands
 * are 0-50 / 51-75 / 76-100 / 101-125 / 126-150 / 151-175 / 176+.
 *
 * Storage: `actor.system.variablePortrait` (TypeDataModel schema). A one-shot
 * migration lifts the legacy 6-tier×trance flag slots
 * (`flags.witcher-ttrpg-death-march.portrait_t{n}_{ne|ye}`) into the new shape.
 */

import { rasterizePortraitCrop, PORTRAIT_CROP_FLAG } from "../../applications/ringPortraitCropper.mjs";

const MODULE_ID = "witcher-ttrpg-death-march";

/* Upper bound (inclusive) of each tier, as a fraction of toxicity.max. Tier i
 * applies when value/max ≤ TIER_BOUNDS[i]; the final tier is everything above
 * the last bound. */
const TIER_BOUNDS = [0.50, 0.75, 1.00, 1.25, 1.50, 1.75];
const TIER_COUNT  = TIER_BOUNDS.length + 1; // 7
const TIER_NAMES  = ["Normal", "Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5", "Tier 6"];

const DEBOUNCE_MS = 60;

// ─── Tier maths ────────────────────────────────────────────────────────────

function computeTier(value, max) {
  const m = Number(max) > 0 ? Number(max) : 100;
  const pct = (Number(value) || 0) / m;
  for (let i = 0; i < TIER_BOUNDS.length; i++) if (pct <= TIER_BOUNDS[i]) return i;
  return TIER_COUNT - 1;
}

/* Human-readable absolute ranges for a given max, e.g. ["0–50","51–75",…]. */
function tierRanges(max) {
  const m = Number(max) > 0 ? Number(max) : 100;
  const out = [];
  let lo = 0;
  for (let i = 0; i < TIER_BOUNDS.length; i++) {
    const hi = Math.floor(TIER_BOUNDS[i] * m);
    out.push(`${lo}–${hi}`);
    lo = hi + 1;
  }
  out.push(`${lo}+`);
  return out;
}

// ─── Gate + config access ───────────────────────────────────────────────────

/** Feature is enabled when the actor owns a race with the box checked. */
export function isVariablePortraitEnabled(actor) {
  if (!actor || actor.type !== "character") return false;
  for (const it of actor.items ?? []) {
    if (it?.type === "race" && it.system?.variablePortrait) return true;
  }
  return false;
}

function getConfig(actor) {
  const cfg = actor.system?.variablePortrait ?? {};
  const base = Array.isArray(cfg.base) ? cfg.base.slice() : [];
  const conditions = Array.isArray(cfg.conditions)
    ? cfg.conditions.map(c => ({
        name:  c?.name ?? "",
        match: c?.match ?? "",
        tiers: Array.isArray(c?.tiers) ? c.tiers.slice() : []
      }))
    : [];
  return { base, conditions };
}

function hasAnyImage(actor) {
  const { base, conditions } = getConfig(actor);
  if (base.some(Boolean)) return true;
  for (const col of conditions) if (col.tiers.some(Boolean)) return true;
  return false;
}

// ─── Selection ──────────────────────────────────────────────────────────────

/* A condition is active when its match string (case-insensitive) is a status
 * id on the actor, or a substring of any enabled active-effect name. */
function conditionActive(actor, match) {
  const q = String(match ?? "").trim().toLowerCase();
  if (!q) return false;
  if (actor.statuses?.has?.(q)) return true;
  for (const e of actor.effects ?? []) {
    if (e.disabled) continue;
    if ((e.name?.toLowerCase() ?? "").includes(q)) return true;
    if (e.statuses?.has?.(q)) return true;
  }
  return false;
}

/* Pick the image for the current toxicity tier. Condition columns take
 * priority in order (first active column with an image for this tier wins);
 * otherwise fall back to the base column. */
function selectImage(actor) {
  const { base, conditions } = getConfig(actor);
  const tox = actor.system?.stats?.toxicity ?? {};
  const tier = computeTier(tox.value, tox.max);
  for (const col of conditions) {
    if (!conditionActive(actor, col.match)) continue;
    const img = col.tiers?.[tier];
    if (img) return img;
  }
  return base?.[tier] || null;
}

/* Single writer: the active GM if online, else the lowest-id active owner.
 * Stops every connected client from racing to write the same actor.img. */
function isResponsible(actor) {
  const gm = game.users?.activeGM;
  if (gm) return gm.isSelf;
  const owners = (game.users?.players ?? [])
    .filter(u => u.active && actor.testUserPermission?.(u, "OWNER"))
    .sort((a, b) => a.id.localeCompare(b.id));
  return owners[0]?.isSelf ?? false;
}

/* Tiny cache so repeated syncs of the same tier portrait don't re-rasterize
 * each time. Keyed by `${img}|${tx}|${ty}|${scale}` since the data URL is a
 * pure function of those inputs. Cleared on a slow LRU-ish bound. */
const _cropCache = new Map();
function cropCacheKey(img, c) { return `${img}|${c.tx ?? 0}|${c.ty ?? 0}|${c.scale ?? 1}`; }

async function syncPortrait(actor) {
  if (!isVariablePortraitEnabled(actor)) return;
  if (!hasAnyImage(actor)) return;       // nothing configured → never clobber img
  if (!isResponsible(actor)) return;
  const target = selectImage(actor);
  if (!target) return;

  /* Actor portrait — always the raw (uncropped) source image. */
  if (actor.img !== target) {
    try { await actor.update({ img: target }); }
    catch (err) { console.error(`${MODULE_ID} | variable portrait sync failed for ${actor.name}`, err); }
  }

  /* For TOKEN textures (prototype + every active token doc) apply the
   * saved crop transform — same {tx, ty, scale} the user picked once in
   * the cropper — so every variable-portrait swap inherits the circular
   * framing. Without this, the syncs below would clobber the cropper's
   * output every time toxicity ticks. If no crop is saved, fall back to
   * pushing the raw image. */
  const cropState = actor.getFlag?.(MODULE_ID, PORTRAIT_CROP_FLAG);
  let tokenTextureSrc = target;
  if (cropState) {
    const key = cropCacheKey(target, cropState);
    let cached = _cropCache.get(key);
    if (!cached) {
      try {
        cached = await rasterizePortraitCrop(target, cropState);
        if (cached) {
          if (_cropCache.size > 32) _cropCache.clear(); // simple bound
          _cropCache.set(key, cached);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | portrait crop rasterize failed, using raw image`, err);
      }
    }
    if (cached) tokenTextureSrc = cached;
  }

  /* Prototype token texture — keep newly-spawned tokens of this actor in
   * sync with the current tier/condition portrait. */
  if (actor.prototypeToken?.texture?.src !== tokenTextureSrc) {
    try { await actor.update({ "prototypeToken.texture.src": tokenTextureSrc }); }
    catch (err) { console.warn(`${MODULE_ID} | prototype token texture sync failed for ${actor.name}`, err); }
  }

  /* All active token DOCUMENTS for this actor across the loaded scenes.
   * Linked tokens don't pull from the prototype on every change — they
   * carry their own texture.src once placed — so we have to push the new
   * image to each token doc explicitly to swap what's on the canvas. */
  const tokenDocs = (typeof actor.getActiveTokens === "function")
    ? (actor.getActiveTokens(false, true) ?? [])  // (linked=false → all, document=true → TokenDocuments)
    : [];
  for (const td of tokenDocs) {
    if (td?.texture?.src === tokenTextureSrc) continue;
    try { await td.update({ "texture.src": tokenTextureSrc }); }
    catch (err) { console.warn(`${MODULE_ID} | token texture sync failed for ${td?.name ?? "token"}`, err); }
  }
}

const pending = new Map(); // actorId → timer
function schedule(actor) {
  if (!actor?.id) return;
  clearTimeout(pending.get(actor.id));
  pending.set(actor.id, setTimeout(() => {
    pending.delete(actor.id);
    syncPortrait(actor);
  }, DEBOUNCE_MS));
}

// ─── Hooks: react to toxicity, config, race, and effect changes ─────────────

Hooks.on("updateActor", (actor, changes) => {
  if (foundry.utils.hasProperty(changes, "system.stats.toxicity") ||
      foundry.utils.hasProperty(changes, "system.variablePortrait")) {
    schedule(actor);
  }
});

function onRaceItemChange(item) {
  if (item?.type !== "race") return;
  if (item.parent) schedule(item.parent);
}
Hooks.on("createItem", onRaceItemChange);
Hooks.on("deleteItem", onRaceItemChange);
Hooks.on("updateItem", (item, changes) => {
  if (item?.type !== "race") return;
  if (!foundry.utils.hasProperty(changes, "system.variablePortrait")) return;
  onRaceItemChange(item);
});

function onEffectChange(effect) {
  const actor = effect?.parent;
  if (actor?.documentName === "Actor") schedule(actor);
}
Hooks.on("createActiveEffect", onEffectChange);
Hooks.on("deleteActiveEffect", onEffectChange);
Hooks.on("updateActiveEffect", onEffectChange);

// ─── Config dialog ──────────────────────────────────────────────────────────

const FilePickerImpl = () =>
  foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;

function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function cssUrl(s) {
  return String(s ?? "").replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function cellHtml(col, tier, value) {
  const v = value || "";
  const style = v ? ` style="background-image:url('${cssUrl(v)}')"` : "";
  return `<td class="wou-vp-cell-td">
    <div class="wou-vp-cell${v ? " is-set" : ""}" data-col="${col}" data-tier="${tier}" data-path="${escapeAttr(v)}">
      <button type="button" class="wou-vp-thumb" data-action="pick" data-col="${col}" data-tier="${tier}"${style} title="${v ? escapeAttr(v) : "Choose image"}">
        ${v ? "" : `<i class="fa-solid fa-plus"></i>`}
      </button>
      <button type="button" class="wou-vp-clear" data-action="clear" data-col="${col}" data-tier="${tier}" title="Clear"><i class="fa-solid fa-xmark"></i></button>
    </div>
  </td>`;
}

function gridHtml(actor, state) {
  const ranges = tierRanges(actor.system?.stats?.toxicity?.max);
  const conds = state.conditions;
  const maxTox = Number(actor.system?.stats?.toxicity?.max) || 100;

  const headCols = conds.map((c, i) => `
    <th class="wou-vp-condhead" data-col="${i}">
      <button type="button" class="wou-vp-removecol" data-action="remove-col" data-col="${i}" title="Remove this condition"><i class="fa-solid fa-xmark"></i></button>
      <input class="wou-vp-cname" type="text" data-col="${i}" value="${escapeAttr(c.name)}" placeholder="Condition" />
      <input class="wou-vp-cmatch" type="text" data-col="${i}" value="${escapeAttr(c.match)}" placeholder="effect / status name" />
    </th>`).join("");

  const bodyRows = Array.from({ length: TIER_COUNT }, (_, t) => {
    const condCells = conds.map((c, i) => cellHtml(i, t, c.tiers?.[t])).join("");
    return `<tr>
      <th class="wou-vp-tierhead">
        <span class="wou-vp-tiername">${TIER_NAMES[t]}</span>
        <span class="wou-vp-tierrange">${ranges[t]}</span>
      </th>
      ${cellHtml(-1, t, state.base?.[t])}
      ${condCells}
      <td class="wou-vp-spacer"></td>
    </tr>`;
  }).join("");

  return `
    <div class="wou-vp-note">
      <p>Pick a portrait for each <b>toxicity tier</b> (bands scale to this actor's max of <b>${maxTox}</b>). Add <b>condition</b> columns matched against an active-effect or status name — e.g. a potion, oil, spell, or <i>trance</i>. The leftmost active condition with an image wins; otherwise the <b>Base</b> column shows. Keep the <b>Normal</b> base cell set to the everyday portrait so it swaps back.</p>
    </div>
    <div class="wou-vp-scroll">
      <table class="wou-vp-table">
        <thead>
          <tr>
            <th class="wou-vp-corner"></th>
            <th class="wou-vp-basehead"><span class="wou-vp-colname">Base</span><span class="wou-vp-colsub">no condition</span></th>
            ${headCols}
            <th class="wou-vp-addcol"><button type="button" data-action="add-col" title="Add condition column"><i class="fa-solid fa-plus"></i> Condition</button></th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}

/* Read the current grid DOM back into a {base, conditions} state object. Used
 * to preserve edits across add/remove-column re-renders and on save. */
function collect(root) {
  const condCount = root.querySelectorAll(".wou-vp-cname").length;
  const base = new Array(TIER_COUNT).fill("");
  const conditions = [];
  for (let i = 0; i < condCount; i++) {
    conditions.push({
      name:  root.querySelector(`.wou-vp-cname[data-col="${i}"]`)?.value?.trim() ?? "",
      match: root.querySelector(`.wou-vp-cmatch[data-col="${i}"]`)?.value?.trim() ?? "",
      tiers: new Array(TIER_COUNT).fill("")
    });
  }
  root.querySelectorAll(".wou-vp-cell").forEach(cell => {
    const col = Number(cell.dataset.col);
    const tier = Number(cell.dataset.tier);
    const v = String(cell.dataset.path ?? "").trim();
    if (col < 0) base[tier] = v;
    else if (conditions[col]) conditions[col].tiers[tier] = v;
  });
  return { base, conditions };
}

function renderGrid(root, actor, state) {
  const host = root.querySelector(".wou-vp-host");
  if (!host) return;
  host.innerHTML = gridHtml(actor, state);
}

export async function openVariablePortraitConfig(actor) {
  if (!actor) return;
  if (!(game.user?.isGM || actor.isOwner)) return;
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications?.error?.(`${MODULE_ID} | DialogV2 unavailable on this Foundry build.`);
    return;
  }

  // Seed the Base/Normal cell with the actor's current portrait if unset, so a
  // freshly-configured actor still has something to swap back to.
  const initial = getConfig(actor);
  if (initial.base.length < TIER_COUNT) {
    initial.base = Array.from({ length: TIER_COUNT }, (_, i) => initial.base[i] ?? "");
  }
  if (!initial.base[0] && actor.img && !actor.img.includes("mystery-man")) {
    initial.base[0] = actor.img;
  }

  await DialogV2.wait({
    window: { title: `Variable Portrait — ${actor.name}`, icon: "fa-solid fa-flask-vial" },
    classes: ["wou-vp-dialog"],
    position: { width: 640 },
    content: `<div class="wou-vp-host">${gridHtml(actor, initial)}</div>`,
    buttons: [
      {
        action: "save",
        label: "Save",
        icon: "fa-solid fa-floppy-disk",
        default: true,
        callback: async (_event, _button, dialog) => {
          const root = dialog?.element ?? dialog;
          const state = collect(root);
          try {
            await actor.update({ "system.variablePortrait": state });
            schedule(actor);
          } catch (err) {
            console.error(`${MODULE_ID} | variable portrait save failed`, err);
            ui.notifications?.error?.("Failed to save variable portrait config.");
          }
        }
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false,
    render: (_event, dialog) => {
      const root = dialog?.element ?? dialog;

      root.addEventListener("click", async (ev) => {
        const el = ev.target.closest("[data-action]");
        if (!el) return;
        const action = el.dataset.action;

        if (action === "add-col") {
          ev.preventDefault();
          const state = collect(root);
          state.conditions.push({ name: "", match: "", tiers: new Array(TIER_COUNT).fill("") });
          renderGrid(root, actor, state);
          return;
        }
        if (action === "remove-col") {
          ev.preventDefault();
          const col = Number(el.dataset.col);
          const state = collect(root);
          state.conditions.splice(col, 1);
          renderGrid(root, actor, state);
          return;
        }
        if (action === "clear") {
          ev.preventDefault();
          ev.stopPropagation();
          const { col, tier } = el.dataset;
          setCellImage(root, col, tier, "");
          return;
        }
        if (action === "pick") {
          ev.preventDefault();
          const { col, tier } = el.dataset;
          const cell = root.querySelector(`.wou-vp-cell[data-col="${col}"][data-tier="${tier}"]`);
          if (!cell) return;
          const FP = FilePickerImpl();
          if (!FP) { ui.notifications?.error?.("FilePicker not available."); return; }
          new FP({
            type: "image",
            current: cell.dataset.path || "",
            callback: (path) => setCellImage(root, col, tier, path)
          }).render(true);
          return;
        }
      });

      function setCellImage(root, col, tier, path) {
        const cell = root.querySelector(`.wou-vp-cell[data-col="${col}"][data-tier="${tier}"]`);
        if (!cell) return;
        const v = String(path ?? "").trim();
        cell.dataset.path = v;
        cell.classList.toggle("is-set", !!v);
        const thumb = cell.querySelector(".wou-vp-thumb");
        if (thumb) {
          thumb.style.backgroundImage = v ? `url('${cssUrl(v)}')` : "";
          thumb.title = v || "Choose image";
          thumb.innerHTML = v ? "" : `<i class="fa-solid fa-plus"></i>`;
        }
      }
    }
  }).catch(() => null);
}

// ─── One-shot migration from legacy flag slots ──────────────────────────────
//
// The previous port stored 6 tiers × 2 eye-states (normal "ne" / trance "ye")
// at flags.<MODULE_ID>.portrait_t{0..5}_{ne|ye}. Lift those into the new schema:
// "ne" → base[tier], "ye" → a "Trance" condition column. Tier 6 stays empty
// (the legacy model had no >175% band). Enable the feature on the actor's race
// item so the migrated images actually swap.

const LEGACY_TIERS = ["t0", "t1", "t2", "t3", "t4", "t5"];

async function migrateActor(actor) {
  if (actor.type !== "character") return;
  if (hasAnyImage(actor)) return;            // already on the new schema
  const flags = actor.flags?.[MODULE_ID];
  if (!flags) return;

  const base = new Array(TIER_COUNT).fill("");
  const tranceTiers = new Array(TIER_COUNT).fill("");
  const unset = {};
  let found = false;

  LEGACY_TIERS.forEach((t, i) => {
    const ne = flags[`portrait_${t}_ne`];
    const ye = flags[`portrait_${t}_ye`];
    if (ne) { base[i] = ne; found = true; }
    if (ye) { tranceTiers[i] = ye; found = true; }
    if (ne !== undefined) unset[`flags.${MODULE_ID}.-=portrait_${t}_ne`] = null;
    if (ye !== undefined) unset[`flags.${MODULE_ID}.-=portrait_${t}_ye`] = null;
  });
  if (!found) return;

  const conditions = tranceTiers.some(Boolean)
    ? [{ name: "Trance", match: "trance", tiers: tranceTiers }]
    : [];

  try {
    await actor.update({ "system.variablePortrait": { base, conditions }, ...unset });
    const race = actor.items.find(i => i.type === "race");
    if (race && !race.system?.variablePortrait) {
      await race.update({ "system.variablePortrait": true });
    }
    console.log(`${MODULE_ID} | migrated variable portrait for ${actor.name}`);
  } catch (err) {
    console.error(`${MODULE_ID} | variable portrait migration failed for ${actor.name}`, err);
  }
}

Hooks.once("ready", async () => {
  if (game.user?.isGM) {
    for (const actor of game.actors) {
      try { await migrateActor(actor); } catch (_) { /* per-actor isolation */ }
    }
  }
  // Initial sweep — correct any img that drifted from the current tier.
  for (const actor of game.actors) {
    try { syncPortrait(actor); } catch (_) { /* per-actor isolation */ }
  }
});

/* Inject a flask-vial button into the ApplicationV2 actor sheet's window
 * header — placed immediately before the 3-dot controls toggle (so it sits
 * to its LEFT) when the actor has variable portrait enabled. Click opens
 * the same Variable Portrait config the chrome character panel uses, so
 * GMs / owners can edit the tier+condition table from the sheet without
 * going through the chrome dock first. */
function injectVariablePortraitHeaderButton(app, element) {
  try {
    if (!element) return;
    const actor = app?.actor;
    if (!actor) return;
    if (!isVariablePortraitEnabled(actor)) return;
    if (!(game.user?.isGM || actor.isOwner)) return;

    const header = element.querySelector?.(".window-header");
    if (!header) return;
    // Idempotent: re-renders happen on every form change, don't pile up.
    if (header.querySelector('[data-wdm-vp-btn]')) return;

    const controlsBtn = header.querySelector('button[data-action="toggleControls"]');
    if (!controlsBtn) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "header-control icon fa-solid fa-flask-vial";
    btn.dataset.wdmVpBtn = "1";
    btn.dataset.tooltip = "Variable portrait";
    btn.setAttribute("aria-label", "Variable portrait");
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { await openVariablePortraitConfig(actor); }
      catch (err) { console.error(`${MODULE_ID} | open variable portrait config failed`, err); }
    });
    header.insertBefore(btn, controlsBtn);
  } catch (err) {
    console.warn(`${MODULE_ID} | variable portrait sheet button inject failed`, err);
  }
}

/* renderActorSheetV2 catches every V2 actor sheet via Foundry's parent-class
 * hook chain (renderWitcherCharacterSheet → renderWitcherActorSheet →
 * renderActorSheetV2 → …). One handler covers all subclasses. */
Hooks.on("renderActorSheetV2", injectVariablePortraitHeaderButton);
