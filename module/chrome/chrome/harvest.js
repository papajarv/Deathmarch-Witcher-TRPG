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
import { bumpResearchIfZero, promptCarcassModifier, resolveCarcassMonster } from "../lib/bestiary.js";

import { t, tFormat } from "../lib/i18n.js";
const DialogV2 = foundry.applications.api.DialogV2;

const SURVIVAL_SKILL_KEY = "wilderness";
const SURVIVAL_DC        = 12;
const HARVESTED_FLAG     = "harvested";
const CONTENTS_FLAG      = "harvest.contents";

/* ──────────────────────────────────────────────────────────────────────────
 * Entry: roll the check, generate loot, store on the carcass.
 * ────────────────────────────────────────────────────────────────────────── */

export async function doHarvest(item, actor, { skipCheck = false } = {}) {
  if (!actor) {
    ui.notifications?.warn(t("WITCHER.Notify.Harvest.NotSidebar", "Harvest Materials must be triggered from a character sheet."));
    return false;
  }

  // The SPECIFIC instance this carcass came from (the token actor it's embedded
  // on, including any post-spawn edits) — never the compendium source.
  const monster = await resolveCarcassMonster(item);
  if (!monster) {
    ui.notifications?.error(t("WITCHER.Notify.Harvest.MonsterMissing", "The source monster could not be found."));
    return false;
  }

  /* People carcasses (bandit corpses, dead cultists) bypass the Wilderness
   * Survival check — you're pocket-frisking, not identifying which glands
   * yield alchemy substrate. skipCheck: true short-circuits the roll and
   * goes straight to loot generation. Triggered by the "Loot" carcass
   * action (registered in context-menu-item.js), gated on the person
   * flag stamped by monster-remains.js. */
  /* Optional situational modifier on the harvest check. Only the real
   * Wilderness Survival roll prompts — the check-skipping Loot path has no
   * roll. Cancelling aborts the whole action (return false → no charge spent). */
  let harvestMod = 0;
  if (!skipCheck) {
    harvestMod = await promptCarcassModifier(t("WITCHER.Chrome.ContextMenuItem.Text.HarvestMaterials", "Harvest Materials"));
    if (harvestMod === null) return false;
  }
  const total = skipCheck ? null : await rollWildernessSurvival(actor, SURVIVAL_DC, harvestMod);

  if (!skipCheck && total < SURVIVAL_DC) {
    ui.notifications?.info(tFormat("WITCHER.Notify.Harvest.Failed", { actor: actor.name, total: total, dc: SURVIVAL_DC }, "{actor} failed to harvest materials (rolled {total} vs DC {dc})."));
    /* Even a failed harvest attempt is "putting your hands on the body" —
     * counts as observation, so a fresh entry ticks up 0 → 1 (never
     * higher, never demotes). */
    await bumpResearchIfZero(actor, monster);
    return true;     // charge still spent (per the existing convention)
  }

  /* On pass (or on a check-skipping Loot): build the resolved-loot list.
   * Prefer the snapshot the carcass captured at kill-time — that's the WORLD
   * monster's loot config, not the compendium source's. Falls back to live
   * fetch for legacy carcasses created before the snapshot flag existed. */
  const snapshot = item.flags?.[MODULE_ID]?.lootSnapshot ?? null;
  const contents = await rollMonsterLoot(monster, snapshot);
  /* Stash the rolled loot on the carcass + mark it harvested. GM-proxied: on
   * the map the remains is embedded on the (GM-owned) monster token actor, so
   * the player can't write it directly. The popup below works off the LOCAL
   * `contents` (not a flag re-read), so it stays correct despite the async
   * round-trip. */
  const { emitRemainsMutate } = await import("../../setup/socketHook.mjs");
  await emitRemainsMutate({ remainsUuid: item.uuid, update: {
    [`flags.${MODULE_ID}.harvest`]:          { contents },
    [`flags.${MODULE_ID}.${HARVESTED_FLAG}`]: true,
  } });

  /* Bump research 0 → 1 if it was 0; otherwise leaves it alone. */
  await bumpResearchIfZero(actor, monster);

  const verb = skipCheck ? "looted" : "harvested";
  ui.notifications?.info(
    contents.length
      ? `${actor.name} ${verb} ${contents.length} loot row${contents.length === 1 ? "" : "s"} from ${item.name}.`
      : `${actor.name} ${verb} ${item.name} — but the body had no loot rows configured.`
  );

  /* Chat card summary so everyone sees what was rolled. Loot rows skip
   * the roll block since there was no check to display. */
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: renderHarvestChatCard({ actor, item, monster, total, contents, skipCheck }),
  });

  /* Auto-open the carcass popup so the player can grab items immediately.
   * Pass the freshly-rolled `contents` so the first render doesn't depend on
   * the GM-proxied flag write having synced back yet. */
  openCarcassPopup(item, contents);

  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Loot resolution
 * ────────────────────────────────────────────────────────────────────────── */

async function rollMonsterLoot(monster, snapshot = null) {
  const contents = [];
  // Prefer the LIVE instance's loot (the token actor, including edits made
  // after it left the bestiary); the kill-time snapshot is only a fallback for
  // when the source actor is gone (a theater carcass whose world actor was
  // deleted). This is what makes "the loot of that token in particular" win.
  const rows = Array.isArray(monster?.system?.loot)
    ? monster.system.loot
    : (Array.isArray(snapshot?.loot) ? snapshot.loot : []);

  for (const row of rows) {
    if (row?.kind === "random") {
      await resolveRandomRow(row, contents);
    } else {
      await resolveItemRow(row, contents);
    }
  }

  // Coin loot: each denomination stores an optional dice expression. Prefer
  // the carcass's captured snapshot (WORLD monster's config) over the live
  // fetch (which resolves to the compendium source for compendium-spawned
  // actors and would drop the GM's edits).
  const coinLoot = (monster?.system?.coinLoot && typeof monster.system.coinLoot === "object")
    ? monster.system.coinLoot
    : (snapshot?.coinLoot ?? {});
  for (const coin of COIN_KEYS) {
    const expr = String(coinLoot[coin] ?? "").trim();
    if (!expr) continue;
    const qty = await resolveQuantity(expr, `${coin} loot`);
    if (qty <= 0) continue;
    contents.push({
      kind:     "coin",
      coin,
      name:     `${qty} ${coin}${qty === 1 ? "" : "s"}`,
      img:      "icons/commodities/currency/coins-plain-gold.webp",
      quantity: qty,
      origin:   "loot",
    });
  }

  return contents;
}

const COIN_KEYS = ["crown", "oren", "bizant", "ducat", "lintar", "floren"];

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

async function rollWildernessSurvival(actor, dc, situational = 0) {
  if (!CONFIG.WITCHER?.skillMap?.[SURVIVAL_SKILL_KEY]) {
    ui.notifications?.error(tFormat("WITCHER.Notify.Harvest.SkillMapMissing", { key: SURVIVAL_SKILL_KEY }, "Skill map entry \"{key}\" missing from CONFIG.WITCHER."));
    return 0;
  }
  if (typeof actor.rollSkillCheck !== "function") {
    ui.notifications?.error(t("WITCHER.Notify.Harvest.HelperMissing", "System's rollSkillCheck helper missing."));
    return 0;
  }
  const opts = situational
    ? { situational, situationalParts: [{ label: t("WITCHER.Common.Mod", "Mod"), value: situational }] }
    : undefined;
  const roll = await actor.rollSkillCheck(SURVIVAL_SKILL_KEY, dc, opts);
  return roll?.total ?? 0;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Carcass-as-container popup
 * ────────────────────────────────────────────────────────────────────────── */

export async function openCarcassPopup(item, contentsOverride = null) {
  if (!item) return;
  /* Drive the popup from a LOCAL copy of the harvested rows. Carcass writes are
   * GM-proxied (async round-trip), so re-reading the remains flag right after a
   * mutation can see stale data and double-loot a row. The caller (doHarvest /
   * a refresh) passes the authoritative list; only a cold "Open Carcass" reopen
   * falls back to the persisted flag (by then long since synced). */
  const contents = Array.isArray(contentsOverride)
    ? contentsOverride.slice()
    : (Array.isArray(item.flags?.[MODULE_ID]?.harvest?.contents)
        ? item.flags[MODULE_ID].harvest.contents.slice()
        : []);

  const rowsHtml = contents.length
    ? contents.map((c, i) => {
        const isCoin = c?.kind === "coin";
        const img = isCoin
          ? (c.img || "icons/commodities/currency/coins-plain-gold.webp")
          : (c.img || "icons/svg/mystery-man.svg");
        const takeTip = isCoin
          ? t("WITCHER.Chrome.Harvest.Tip.TakeCoins",     "Take these coins into your currency")
          : t("WITCHER.Chrome.Harvest.Tip.TakeInventory", "Take to your inventory");
        const qtyText = isCoin ? String(c.quantity ?? 0) : `×${String(c.quantity ?? 1)}`;
        return `
        <li class="wou-carcass-row${isCoin ? " is-coin" : ""}" data-row-index="${i}">
          <img class="wou-carcass-img" src="${escAttr(img)}" alt="" />
          <span class="wou-carcass-name">${escText(c.name || t("WITCHER.Chrome.Harvest.Text.Unknown", "Unknown"))}</span>
          <span class="wou-carcass-qty" title="${t("WITCHER.Chrome.Harvest.Text.Quantity", "Quantity")}">${escText(qtyText)}</span>
          <a class="wou-carcass-take" data-action="take" data-row-index="${i}"
             data-tooltip="${escAttr(takeTip)}"><i class="fa-solid fa-hand-holding"></i></a>
          <a class="wou-carcass-drop" data-action="drop" data-row-index="${i}"
             data-tooltip="${t("WITCHER.Chrome.Harvest.Text.DiscardThisRow", "Discard this row")}"><i class="fa-solid fa-trash"></i></a>
        </li>`;
      }).join("")
    : `<li class="wou-carcass-empty">${t("WITCHER.Chrome.Harvest.Text.NothingLeftInside", "Nothing left inside.")}</li>`;

  const dlg = await DialogV2.wait({
    window: { title: tFormat("WITCHER.Dialog.Harvest.Carcass", { item: item.name }, "Carcass · {item}") },
    position: { width: 380 },
    content: `
      <div class="wou-carcass-popup">
        <p style="margin:0 0 6px;font-size:0.6875rem;opacity:0.75;">
          ${t("WITCHER.Chrome.Harvest.Text.ClickTheHandIconToSendARowToYourAssigned", "Click the hand icon to send a row to your assigned character. The trash icon discards a row outright.")}
        </p>
        <ul class="wou-carcass-list">${rowsHtml}</ul>
      </div>
    `,
    buttons: [
      { action: "close", label: t("WITCHER.Common.Close", "Close"), default: true, callback: () => "close" },
    ],
    rejectClose: false,
    render: (_ev, dialog) => wireCarcassPopup(dialog, item, contents),
  });
}

function wireCarcassPopup(dialog, item, contents) {
  const root = dialog.element;
  if (!root) return;

  /* Click handlers — Take + Drop. Both act on the LOCAL `contents` snapshot the
   * popup was opened with, then reopen the popup with the updated list (or
   * close it when nothing's left). Persisting to the remains is GM-proxied
   * inside removeEntry. */
  root.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    ev.preventDefault();
    const idx = Number(el.dataset.rowIndex);
    const entry = contents[idx];
    if (!entry) return;

    if (el.dataset.action === "take") {
      const target = game.user.character;
      if (!target) return ui.notifications?.warn(t("WITCHER.Notify.Harvest.NoCharacter", "No assigned character set — assign one in User Configuration first."));
      await transferEntryToActor(entry, target);
    }
    // Take AND Drop both remove the row from the carcass.
    const next = await removeEntry(item, contents, idx);
    if (!next.length) closeOpenCarcassPopup(item);
    else refreshOpenCarcassPopup(item, next);
  });
}

async function transferEntryToActor(entry, actor) {
  // Coin entries write into the recipient's currency directly — no item
  // create, no source uuid to resolve.
  if (entry?.kind === "coin") {
    const coin = entry.coin;
    const qty  = Math.max(0, Math.floor(Number(entry.quantity) || 0));
    if (!coin || qty <= 0) return;
    const cur = Number(actor.system?.currency?.[coin]) || 0;
    await actor.update({ [`system.currency.${coin}`]: cur + qty });
    ui.notifications?.info(tFormat("WITCHER.Notify.Harvest.TookCoin", { actor: actor.name, qty: qty, coin: coin, plural: qty === 1 ? "" : "s" }, "{actor} took {qty} {coin}{plural}."));
    return;
  }
  const src = await fromUuid(entry.sourceUuid);
  if (!src) {
    ui.notifications?.warn(tFormat("WITCHER.Notify.Harvest.SourceMissing", { entry: entry.name }, "{entry}: source item not found."));
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
  ui.notifications?.info(tFormat("WITCHER.Notify.Harvest.Took", { actor: actor.name, entry: entry.name, qty: entry.quantity ?? 1 }, "{actor} took {entry} ×{qty}."));
}

/** Remove one harvested row from the LOCAL `contents` snapshot and persist the
 *  new list to the carcass (GM-proxied). If that empties a fully-spent carcass
 *  (0 charges), the GM destroys it too (cleanupIfSpent). Returns the new list
 *  so the popup can reopen with it (or close when it's empty). */
async function removeEntry(item, contents, idx) {
  const next = Array.isArray(contents) ? contents.slice() : [];
  if (idx < 0 || idx >= next.length) return next;
  next.splice(idx, 1);
  const { emitRemainsMutate } = await import("../../setup/socketHook.mjs");
  await emitRemainsMutate({
    remainsUuid: item.uuid,
    update: { [`flags.${MODULE_ID}.harvest`]: { contents: next } },
    cleanupIfSpent: true,
  });
  return next;
}

/** Close+reopen the dialog so the row list reflects the updated `contents`.
 *  Cheap; the dialog content is tiny. Passes the local list through so the
 *  reopen doesn't depend on the GM-proxied flag write having synced. */
function refreshOpenCarcassPopup(item, contents = null) {
  closeOpenCarcassPopup(item);
  /* Re-open on the next microtask so the close finishes first. */
  setTimeout(() => openCarcassPopup(item, contents), 0);
}

/** Close the carcass popup for `item` without re-opening it (used when the
 *  carcass was destroyed because it's now empty). */
function closeOpenCarcassPopup(item) {
  const open = foundry.applications.instances.values?.()
    ? [...foundry.applications.instances.values()]
        .find(a => a?.options?.window?.title === tFormat("WITCHER.Dialog.Harvest.Carcass", { item: item.name }, "Carcass · {item}"))
    : null;
  if (open) open.close({ submitted: false });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Chat card
 * ────────────────────────────────────────────────────────────────────────── */

function renderHarvestChatCard({ actor, item, monster, total, contents, skipCheck = false }) {
  const lines = contents.length
    ? contents.map(c => c?.kind === "coin"
        ? `<li>${escText(c.name)}${c.origin && c.origin !== "loot" ? ` <span style="opacity:0.6;">(${escText(c.origin)})</span>` : ""}</li>`
        : `<li>${escText(c.name)} ×${escText(String(c.quantity ?? 1))}${c.origin && c.origin !== "loot" ? ` <span style="opacity:0.6;">(${escText(c.origin)})</span>` : ""}</li>`
      ).join("")
    : `<li style="opacity:0.7;font-style:italic;">${t("WITCHER.Chrome.Harvest.Text.TheBodyYieldedNothing", "The body yielded nothing.")}</li>`;
  const title = skipCheck
    ? t("WITCHER.Chrome.Harvest.Text.TitleLoot", "Loot")
    : t("WITCHER.Chrome.Harvest.Text.TitleHarvest", "Harvest");
  const rollLine = skipCheck
    ? `${escText(actor.name)} → ${escText(monster.name)} · <span style="opacity:0.75;">no check needed</span>`
    : `${escText(actor.name)} → ${escText(monster.name)} · <span style="color:#5a8a4a;font-weight:bold;">Pass</span> <b>${total}</b> vs DC <b>${SURVIVAL_DC}</b>`;
  return `
    <div class="wou-harvest-card">
      <h3 style="margin:0 0 4px;">${title} · ${escText(item.name)}</h3>
      <div style="font-size:0.6875rem;opacity:0.85;">${rollLine}</div>
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
