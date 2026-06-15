/**
 * Harvest Materials mechanic + carcass-as-container popup.
 *
 * Roll Wilderness Survival vs DC 12. On pass:
 *   - Iterate the source monster's inline loot rows (system.loot[]):
 *       · kind "item"   — a single linked drop (uuid + name). Roll its `qty`
 *                         field; flat numbers stay as-is, dice like "1d6" or
 *                         "2d4+1" are evaluated.
 *       · kind "random" — a pool of candidates. Roll `qty` draws; each draw
 *                         picks a random pool candidate (an Item, or a draw
 *                         from a linked RollTable). Candidates never stack —
 *                         resolved items are deduped by uuid.
 *   - Stash the resolved drops on the carcass at
 *       item.flags["witcher-ttrpg-death-march"].harvest.contents = [
 *         { sourceUuid, name, img, quantity }
 *       ]
 *   - Set the one-shot HARVESTED_FLAG so Harvest greys out.
 *   - Auto-open the carcass-as-container popup so the player can drag
 *     items out into their inventory.
 *
 * A separate "Open Carcass" context-menu entry re-opens the popup on
 * already-harvested remains so contents stay accessible until cleared.
 */

import { MODULE_ID } from "../setup/settings.js";
import { bumpResearchIfZero } from "../lib/bestiary.js";

const DialogV2 = foundry.applications.api.DialogV2;

const SURVIVAL_SKILL_KEY = "wilderness";
const SURVIVAL_DC        = 12;
const HARVESTED_FLAG     = "harvested";
const CONTENTS_FLAG      = "harvest.contents";

/* ──────────────────────────────────────────────────────────────────────────
 * Entry: roll the check, generate loot, store on the carcass.
 * ────────────────────────────────────────────────────────────────────────── */

export async function doHarvest(item, actor) {
  if (!actor) {
    ui.notifications?.warn("Harvest Materials must be triggered from a character sheet.");
    return false;
  }

  const monsterUuid = item.system?.monsterUuid || item.flags?.[MODULE_ID]?.monsterUuid;
  if (!monsterUuid) {
    ui.notifications?.error("These remains aren't linked to a source monster.");
    return false;
  }
  const monster = await fromUuid(monsterUuid);
  if (!monster) {
    ui.notifications?.error("The source monster could not be found.");
    return false;
  }

  const total = await rollWildernessSurvival(actor, SURVIVAL_DC);

  if (total < SURVIVAL_DC) {
    ui.notifications?.info(`${actor.name} failed to harvest materials (rolled ${total} vs DC ${SURVIVAL_DC}).`);
    /* Even a failed harvest attempt is "putting your hands on the body" —
     * counts as observation, so a fresh entry ticks up 0 → 1 (never
     * higher, never demotes). */
    await bumpResearchIfZero(actor, monster);
    return true;     // charge still spent (per the existing convention)
  }

  /* On pass: build the resolved-loot list. */
  const contents = await rollMonsterLoot(monster);
  await item.setFlag(MODULE_ID, "harvest", { contents });
  await item.setFlag(MODULE_ID, HARVESTED_FLAG, true);

  /* Bump research 0 → 1 if it was 0; otherwise leaves it alone. */
  await bumpResearchIfZero(actor, monster);

  ui.notifications?.info(
    contents.length
      ? `${actor.name} harvested ${contents.length} loot row${contents.length === 1 ? "" : "s"} from ${item.name}.`
      : `${actor.name} harvested ${item.name} — but the body had no loot rows configured.`
  );

  /* Chat card summary so everyone sees what was rolled. */
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: renderHarvestChatCard({ actor, item, monster, total, contents }),
  });

  /* Auto-open the carcass popup so the player can grab items immediately. */
  openCarcassPopup(item);

  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Loot resolution
 * ────────────────────────────────────────────────────────────────────────── */

async function rollMonsterLoot(monster) {
  const contents = [];
  const rows = Array.isArray(monster.system?.loot) ? monster.system.loot : [];

  for (const row of rows) {
    if (row?.kind === "random") {
      await resolveRandomRow(row, contents);
    } else {
      await resolveItemRow(row, contents);
    }
  }

  return contents;
}

/* kind "item" — a single linked drop. `qty` (dice code) is how many drop. */
async function resolveItemRow(row, contents) {
  const uuid = String(row?.uuid ?? "").trim();
  if (!uuid) return;
  const qty = await resolveQuantity(row?.qty ?? "1", `${row?.name || "loot"} qty`);
  if (qty <= 0) return;
  const doc = await fromUuid(uuid);
  if (!doc) return;
  contents.push({
    sourceUuid: uuid,
    name:       String(row?.name ?? "").trim() || doc.name,
    img:        doc.img,
    quantity:   qty,
    origin:     "loot",
  });
}

/* kind "random" — roll `qty` draws over the candidate pool. Each draw picks a
 * random candidate (an Item, or one draw from a linked RollTable). Resolved
 * items never stack — they're deduped by uuid. */
async function resolveRandomRow(row, contents) {
  const pool = (Array.isArray(row?.pool) ? row.pool : [])
    .filter(c => String(c?.uuid ?? "").trim());
  if (!pool.length) return;
  const draws = await resolveQuantity(row?.qty ?? "1", `${row?.name || "random loot"} draws`);
  if (draws <= 0) return;

  const seen = new Set();
  for (let i = 0; i < draws; i++) {
    const pick = (await new Roll(`1d${pool.length}`).evaluate({ allowInteractive: false })).total - 1;
    const cand = pool[pick];
    if (!cand) continue;
    if (cand.kind === "table") {
      const itemUuid = await drawOnceFromTable(String(cand.uuid).trim());
      await pushUnique(itemUuid, seen, contents, `table:${cand.name || "table"}`);
    } else {
      await pushUnique(String(cand.uuid).trim(), seen, contents, "loot");
    }
  }
}

/* Draw a single result from a RollTable and resolve it to an Item uuid. */
async function drawOnceFromTable(tableUuid) {
  if (!tableUuid) return null;
  const table = await fromUuid(tableUuid);
  if (!table || typeof table.draw !== "function") return null;
  try {
    const res = await table.draw({ displayChat: false });
    const tr  = res?.results?.[0];
    return tr ? resolveTableResultUuid(tr) : null;
  } catch (err) {
    console.warn(`${MODULE_ID} | RollTable.draw failed on ${table.name}`, err);
    return null;
  }
}

/* Resolve a uuid → doc and push it once (dedupe via `seen`). */
async function pushUnique(uuid, seen, contents, origin) {
  if (!uuid || seen.has(uuid)) return;
  const doc = await fromUuid(uuid);
  if (!doc) return;
  seen.add(uuid);
  contents.push({
    sourceUuid: uuid,
    name:       doc.name,
    img:        doc.img,
    quantity:   1,
    origin,
  });
}

/** Returns the Item UUID a TableResult points to, normalised across
 *  Foundry versions (V12 split documentCollection / documentId, V13+
 *  surfaces documentUuid directly). Returns null when the result is a
 *  text-type entry. */
function resolveTableResultUuid(tr) {
  if (tr?.documentUuid) return tr.documentUuid;
  const coll = tr?.documentCollection;
  const id   = tr?.documentId;
  if (!coll || !id) return null;
  /* "Item" for world, otherwise a compendium pack id like
   * "wtrpg-complete-compendium.alchemy". */
  if (coll === "Item") return `Item.${id}`;
  return `Compendium.${coll}.Item.${id}`;
}

/** Parses a quantity string. Flat number → that number. Dice string
 *  → roll it. Empty/zero/garbage → 0. */
async function resolveQuantity(raw, label = "quantity") {
  if (raw == null || raw === "") return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const flat = Number(s);
  if (Number.isFinite(flat)) return Math.max(0, Math.floor(flat));

  try {
    const roll = new Roll(s);
    await roll.evaluate({ allowInteractive: false });
    return Math.max(0, Math.floor(roll.total ?? 0));
  } catch (err) {
    console.warn(`${MODULE_ID} | couldn't evaluate ${label} "${s}"`, err);
    return 0;
  }
}

async function rollWildernessSurvival(actor, dc) {
  if (!CONFIG.WITCHER?.skillMap?.[SURVIVAL_SKILL_KEY]) {
    ui.notifications?.error(`Skill map entry "${SURVIVAL_SKILL_KEY}" missing from CONFIG.WITCHER.`);
    return 0;
  }
  if (typeof actor.rollSkillCheck !== "function") {
    ui.notifications?.error("System's rollSkillCheck helper missing.");
    return 0;
  }
  const roll = await actor.rollSkillCheck(SURVIVAL_SKILL_KEY, dc);
  return roll?.total ?? 0;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Carcass-as-container popup
 * ────────────────────────────────────────────────────────────────────────── */

export async function openCarcassPopup(item) {
  if (!item) return;
  const contents = Array.isArray(item.flags?.[MODULE_ID]?.harvest?.contents)
    ? item.flags[MODULE_ID].harvest.contents
    : [];

  const rowsHtml = contents.length
    ? contents.map((c, i) => `
        <li class="wou-carcass-row" data-row-index="${i}">
          <img class="wou-carcass-img" src="${escAttr(c.img || "icons/svg/mystery-man.svg")}" alt="" />
          <span class="wou-carcass-name">${escText(c.name || "Unknown")}</span>
          <span class="wou-carcass-qty" title="Quantity">×${escText(String(c.quantity ?? 1))}</span>
          <a class="wou-carcass-take" data-action="take" data-row-index="${i}"
             data-tooltip="Take to your inventory"><i class="fa-solid fa-hand-holding"></i></a>
          <a class="wou-carcass-drop" data-action="drop" data-row-index="${i}"
             data-tooltip="Discard this row"><i class="fa-solid fa-trash"></i></a>
        </li>
      `).join("")
    : `<li class="wou-carcass-empty">Nothing left inside.</li>`;

  const dlg = await DialogV2.wait({
    window: { title: `Carcass · ${item.name}` },
    position: { width: 380 },
    content: `
      <div class="wou-carcass-popup">
        <p style="margin:0 0 6px;font-size:11px;opacity:0.75;">
          Click the hand icon to send a row to your assigned character.
          The trash icon discards a row outright.
        </p>
        <ul class="wou-carcass-list">${rowsHtml}</ul>
      </div>
    `,
    buttons: [
      { action: "close", label: "Close", default: true, callback: () => "close" },
    ],
    rejectClose: false,
    render: (_ev, dialog) => wireCarcassPopup(dialog, item),
  });
}

function wireCarcassPopup(dialog, item) {
  const root = dialog.element;
  if (!root) return;

  /* Click handlers — Take + Drop. */
  root.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    ev.preventDefault();
    const idx = Number(el.dataset.rowIndex);
    const list = item.flags?.[MODULE_ID]?.harvest?.contents ?? [];
    const entry = list[idx];
    if (!entry) return;

    if (el.dataset.action === "take") {
      const target = game.user.character;
      if (!target) return ui.notifications?.warn("No assigned character set — assign one in User Configuration first.");
      await transferEntryToActor(entry, target);
      const destroyed = await removeEntry(item, idx);
      if (destroyed) closeOpenCarcassPopup(item);
      else refreshOpenCarcassPopup(item);
    } else if (el.dataset.action === "drop") {
      const destroyed = await removeEntry(item, idx);
      if (destroyed) closeOpenCarcassPopup(item);
      else refreshOpenCarcassPopup(item);
    }
  });
}

async function transferEntryToActor(entry, actor) {
  const src = await fromUuid(entry.sourceUuid);
  if (!src) {
    ui.notifications?.warn(`${entry.name}: source item not found.`);
    return;
  }
  const data = src.toObject();
  delete data._id;
  data.system ??= {};
  /* Preserve the rolled-out quantity — the system's `addItem` would stack
   * by name+type; we go straight to createEmbeddedDocuments to keep each
   * harvested row as its own document with its own quantity. */
  data.system.quantity = entry.quantity ?? 1;
  await actor.createEmbeddedDocuments("Item", [data]);
  ui.notifications?.info(`${actor.name} took ${entry.name} ×${entry.quantity ?? 1}.`);
}

/** Remove one harvested row. If that empties a fully-spent carcass (0
 *  charges), destroy the carcass too. Returns true if the carcass was
 *  deleted, so the popup can close instead of refreshing. */
async function removeEntry(item, idx) {
  const list = (item.flags?.[MODULE_ID]?.harvest?.contents ?? []).slice();
  if (idx < 0 || idx >= list.length) return false;
  list.splice(idx, 1);
  await item.setFlag(MODULE_ID, "harvest", { contents: list });
  if (list.length === 0 && (item.flags?.[MODULE_ID]?.remainsCharges ?? null) === 0) {
    await item.delete();
    return true;
  }
  return false;
}

/** Close+reopen the dialog so the row list reflects the updated flag.
 *  Cheap; the dialog content is tiny. */
function refreshOpenCarcassPopup(item) {
  closeOpenCarcassPopup(item);
  /* Re-open on the next microtask so the close finishes first. */
  setTimeout(() => openCarcassPopup(item), 0);
}

/** Close the carcass popup for `item` without re-opening it (used when the
 *  carcass was destroyed because it's now empty). */
function closeOpenCarcassPopup(item) {
  const open = foundry.applications.instances.values?.()
    ? [...foundry.applications.instances.values()]
        .find(a => a?.options?.window?.title === `Carcass · ${item.name}`)
    : null;
  if (open) open.close({ submitted: false });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Chat card
 * ────────────────────────────────────────────────────────────────────────── */

function renderHarvestChatCard({ actor, item, monster, total, contents }) {
  const lines = contents.length
    ? contents.map(c => `<li>${escText(c.name)} ×${escText(String(c.quantity ?? 1))}${c.origin && c.origin !== "loot" ? ` <span style="opacity:0.6;">(${escText(c.origin)})</span>` : ""}</li>`).join("")
    : `<li style="opacity:0.7;font-style:italic;">The body yielded nothing.</li>`;
  return `
    <div class="wou-harvest-card">
      <h3 style="margin:0 0 4px;">Harvest · ${escText(item.name)}</h3>
      <div style="font-size:11px;opacity:0.85;">
        ${escText(actor.name)} → ${escText(monster.name)} ·
        <span style="color:#5a8a4a;font-weight:bold;">Pass</span>
        <b>${total}</b> vs DC <b>${SURVIVAL_DC}</b>
      </div>
      <ul style="margin:4px 0 0;padding-left:18px;">${lines}</ul>
    </div>
  `;
}

function escText(s) {
  return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
function escAttr(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("'","&#39;")
    .replaceAll("<","&lt;").replaceAll(">","&gt;");
}
