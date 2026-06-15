/**
 * Container model helpers.
 *
 * Every container's sheet exposes a Slot Rows section directly in the
 * encumbrance band.  Each row picks an item type + subtype + count.
 * Optional container-level extras: an "Items stack" tickbox (allows
 * quantity > 1 items) and a Weight Limit (kg) that, when set, also
 * enforces the system's normal kg cap on top of the slot rules.
 *
 * If a container has no slot rows configured it falls back to the old
 * weight-only model — a fresh container behaves like a plain sack.
 *
 *   Flag shape (under `flags.witcher-ttrpg-death-march.containerCfg`):
 *     { slots: [
 *         { type: itemType,           // weapon / armor / alchemical / ...
 *           subtype: string,          // category within the type (or "")
 *           count: int >= 1,
 *           maxConceal: ""|"T"|"S"|"L"|"NA"  // weapon-only size cap
 *         }, ...
 *       ],
 *       stack: boolean,
 *       weightLimitPerItem: number,  // 0 = no per-item kg cap
 *     }
 *
 * Backwards-compat: the system's own `system.carry` continues to act as
 * a weight cap for containers that have no slot rows.
 */

const MODULE_ID = "witcher-ttrpg-death-march";
const FLAG_KEY  = "containerCfg";
const RAIL_FLAG = "containerRail";

/* ── Rail (loadout equip slots) ───────────────────────────────────── */

export const DEFAULT_RAIL_COUNT = 4;
const MAX_RAIL_COUNT = 12;

/** Read the actor's container rail.  Returns `{ count, assignments }`
 *  where `assignments` is a length-`count` array of container ids
 *  (nullable for empty slots). */
export function getRail(actor) {
  const raw = actor?.flags?.[MODULE_ID]?.[RAIL_FLAG];
  const cnt = Number(raw?.count);
  const count = Number.isFinite(cnt) && cnt >= 1
    ? Math.min(MAX_RAIL_COUNT, Math.floor(cnt))
    : DEFAULT_RAIL_COUNT;
  const src = Array.isArray(raw?.assignments) ? raw.assignments : [];
  const assignments = new Array(count).fill(null);
  for (let i = 0; i < count; i++) {
    const v = src[i];
    if (typeof v === "string" && v) assignments[i] = v;
  }
  /* Drop assignments whose container no longer exists on the actor or
   * whose item.type isn't "container" (defensive — stale ids would
   * otherwise render as ghost slots). */
  if (actor?.items) {
    for (let i = 0; i < count; i++) {
      const id = assignments[i];
      if (!id) continue;
      const it = actor.items.get(id);
      if (!it || it.type !== "container") assignments[i] = null;
    }
  }
  return { count, assignments };
}

/** Persist a new slot count.  Clamped to [max(1, currently-occupied), MAX].
 *  If shrinking past an occupied slot, the trailing assignments are dropped
 *  (the user can re-equip the container later). */
export async function setRailCount(actor, value) {
  if (!actor) return;
  const cur = getRail(actor);
  const lastFilled = cur.assignments.reduce((acc, id, idx) => id ? idx + 1 : acc, 0);
  const floor = Math.max(1, lastFilled);
  const count = Math.max(floor, Math.min(MAX_RAIL_COUNT, Math.floor(value)));
  const assignments = cur.assignments.slice(0, count);
  while (assignments.length < count) assignments.push(null);
  await actor.setFlag(MODULE_ID, RAIL_FLAG, { count, assignments });
}

/** Persist an assignment change.  Pass `null` for `containerId` to
 *  clear the slot.  Equipping the same container twice clears the
 *  previous slot first (a container can only occupy one rail slot). */
export async function setRailAssignment(actor, slotIdx, containerId) {
  if (!actor) return;
  const cur = getRail(actor);
  if (slotIdx < 0 || slotIdx >= cur.count) return;
  const next = cur.assignments.slice();
  if (containerId) {
    // De-duplicate: if this container is already in another slot, clear it.
    for (let i = 0; i < next.length; i++) {
      if (next[i] === containerId && i !== slotIdx) next[i] = null;
    }
  }
  next[slotIdx] = containerId || null;
  await actor.setFlag(MODULE_ID, RAIL_FLAG, { count: cur.count, assignments: next });
  await syncRailEquipped(actor, cur.assignments, next);
}

/** Reflect rail membership onto each container's `system.equipped`:
 *  a container on the rail is "worn", one that leaves it is not. Writes
 *  are guarded to the actual flip so we never re-fire a no-op update
 *  (which keeps the equipped→rail hook from looping back here). */
async function syncRailEquipped(actor, before, after) {
  const oldSet = new Set(before.filter(Boolean));
  const newSet = new Set(after.filter(Boolean));
  const updates = [];
  for (const id of oldSet) {
    if (newSet.has(id)) continue;
    const it = actor.items.get(id);
    if (it?.type === "container" && it.system?.equipped) updates.push({ _id: id, "system.equipped": false });
  }
  for (const id of newSet) {
    if (oldSet.has(id)) continue;
    const it = actor.items.get(id);
    if (it?.type === "container" && !it.system?.equipped) updates.push({ _id: id, "system.equipped": true });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

/** True if `containerId` is currently equipped in any rail slot. */
export function isContainerRailed(actor, containerId) {
  if (!actor || !containerId) return false;
  return getRail(actor).assignments.includes(containerId);
}

/** Returns the slot index a container occupies, or -1 if not railed. */
export function railSlotOf(actor, containerId) {
  if (!actor || !containerId) return -1;
  return getRail(actor).assignments.indexOf(containerId);
}

/* ── Vocabulary ───────────────────────────────────────────────────── */

/** Item types selectable as a slot type.  "any" is a wildcard — the
 *  subtype select disappears and the row accepts any item type. */
export const SLOT_TYPES = [
  "any",
  "weapon",
  "armor",
  "alchemical",
  "component",
  "mutagen",
  "valuable",
  "enhancement",
  "diagrams",
  "note",
  "container",
];

const SLOT_TYPE_LABELS = {
  any:         "Any item",
  weapon:      "Weapon",
  ammo:        "Ammunition",
  armor:       "Armor",
  alchemical:  "Alchemical",
  component:   "Component",
  mutagen:     "Mutagen",
  valuable:    "Valuable",
  enhancement: "Enhancement",
  diagrams:    "Diagram",
  note:        "Note",
  container:   "Container",
};

/** Per-type subtype enums.  Keys are stored values; the value is a
 *  display label.  An empty subtype on a row means "any subtype". */
export const SUBTYPES_BY_TYPE = {
  weapon: {
    swordsmanship: "Swordsmanship",
    smallblades:   "Small Blades",
    staffspear:    "Staff/Spear",
    melee:         "Melee",
    brawling:      "Brawling",
    archery:       "Archery",
    crossbow:      "Crossbow",
  },
  armor: {
    Light:   "Light",
    Medium:  "Medium",
    Heavy:   "Heavy",
    Natural: "Natural",
  },
  alchemical: {
    alchemical: "Alchemical",
    potion:     "Potion",
    decoction:  "Decoction",
    oil:        "Oil",
  },
  component: {
    "crafting-material": "Crafting Material",
    "animal-parts":      "Animal Parts",
    "alchemical":        "Alchemical Treatment",
    "minerals":          "Ingots & Minerals",
    "substances":        "Substance",
  },
  mutagen: {
    red:   "Red",
    green: "Green",
    blue:  "Blue",
  },
  valuable: {
    "general":           "General",
    "toolkit":           "Toolkit",
    "food-drink":        "Food & Drink",
    "clothing":          "Clothing",
    "alchemical-item":   "Alchemical Item",
    "mount-accessories": "Mount Accessories",
    "remains":           "Remains",
  },
  enhancement: {
    weapon: "Weapon",
    rune:   "Rune",
    armor:  "Armor",
    glyph:  "Glyph",
  },
  diagrams: {
    "ingredients":       "Ingredients",
    "weapon":            "Weapon",
    "armor":             "Armor",
    "armor-enhancement": "Armor Enhancement",
    "elderfolk-weapon":  "Elderfolk Weapon",
    "elderfolk-armor":   "Elderfolk Armor",
    "ammunition":        "Ammunition",
    "bomb":              "Bomb",
    "traps":             "Traps",
  },
};

export function slotTypeLabel(type) {
  return SLOT_TYPE_LABELS[type] ?? type;
}

export function subtypeLabel(type, subtype) {
  if (!subtype) return "";
  return SUBTYPES_BY_TYPE[type]?.[subtype] ?? subtype;
}

/* ── Concealment (weapon-only size cap) ───────────────────────────── */

export const CONCEAL_CODES = ["T", "S", "L", "NA"];
const CONCEAL_RANK = { T: 1, S: 2, L: 3, NA: 4 };
export const CONCEAL_LABELS = {
  T:  "Tiny",
  S:  "Small",
  L:  "Large",
  NA: "Can't hide",
};

export function weaponConceal(item) {
  const v = String(item?.system?.conceal ?? "").trim().toUpperCase();
  return CONCEAL_CODES.includes(v) ? v : "";
}

/** True if a slot whose cap is `maxCap` (e.g. "S") will accept `item`.
 *  Empty cap = no restriction.  Items with no conceal value pass freely. */
export function slotAcceptsConceal(maxCap, item) {
  if (!maxCap) return true;
  const wc = weaponConceal(item);
  if (!wc) return true;
  return CONCEAL_RANK[wc] <= CONCEAL_RANK[maxCap];
}

/* ── Config read / write ──────────────────────────────────────────── */

/** Read the container config blob (with safe defaults). */
export function getContainerCfg(container) {
  const raw = container?.flags?.[MODULE_ID]?.[FLAG_KEY];
  const slots = Array.isArray(raw?.slots) ? raw.slots : [];
  return {
    slots: slots
      .filter(s => s && typeof s.type === "string" && SLOT_TYPES.includes(s.type))
      .map(s => {
        const type = String(s.type);
        const subtype = (SUBTYPES_BY_TYPE[type] && SUBTYPES_BY_TYPE[type][s.subtype]) ? String(s.subtype) : "";
        return {
          type,
          subtype,
          count:      Math.max(1, Math.floor(Number(s.count) || 1)),
          maxConceal: (type === "weapon" && CONCEAL_CODES.includes(s.maxConceal)) ? s.maxConceal : "",
        };
      }),
    stack:              !!raw?.stack,
    weightLimitPerItem: Math.max(0, Number(raw?.weightLimitPerItem) || 0),
  };
}

/** True if the container has any slot rows configured. */
export function hasSlotRows(container) {
  return getContainerCfg(container).slots.length > 0;
}

/* ── Matching logic ───────────────────────────────────────────────── */

/** Extract the subtype value from an item, by type.  This is what we
 *  compare against a slot row's `subtype` to decide a match. */
export function itemSubtypeOf(item) {
  if (!item) return "";
  const sys = item.system ?? {};
  switch (item.type) {
    case "weapon":
      return sys.meleeAttackSkill || sys.rangedAttackSkill || "";
    case "ammo":
      return "";
    case "armor":
    case "alchemical":
    case "component":
    case "mutagen":
    case "valuable":
    case "enhancement":
    case "diagrams":
      return String(sys.type ?? "");
    default:
      return "";
  }
}

/** True if `item` would fill `slot` (type + subtype + weapon-only conceal). */
export function itemMatchesSlot(slot, item) {
  if (!slot || !item) return false;
  if (slot.type === "any") {
    // Any-type rows still enforce conceal if the user set one.
    return slotAcceptsConceal(slot.maxConceal, item);
  }
  if (item.type !== slot.type) return false;
  if (slot.subtype && itemSubtypeOf(item) !== slot.subtype) return false;
  if (slot.type === "weapon" && !slotAcceptsConceal(slot.maxConceal, item)) return false;
  return true;
}

/** Greedy assignment of stored items to slot rows.  Each item lands in
 *  the FIRST row (config order) that matches AND has enough free slots
 *  for the item's quantity.  Returns enriched rows: `{ ...row, used,
 *  items: [{item, qty}] }`. */
function assignToRows(container) {
  const cfg = getContainerCfg(container);
  const rows = cfg.slots.map(r => ({ ...r, used: 0, items: [] }));
  for (const ref of container?.system?.content ?? []) {
    const inner = (typeof fromUuidSync === "function") ? fromUuidSync(ref) : null;
    if (!inner) continue;
    const qty = Number(inner.system?.quantity) || 1;
    const row = rows.find(r => itemMatchesSlot(r, inner) && (r.count - r.used) >= qty);
    if (row) {
      row.used += qty;
      row.items.push({ item: inner, qty });
    }
  }
  return rows;
}

/* ── Capacity API used by drop sites ──────────────────────────────── */

/** True if `item` can be added to `container`. */
export function fitsInContainer(container, item) {
  const cfg = getContainerCfg(container);
  const w   = Number(item?.system?.weight) || 0;

  // Per-item weight cap is independent of slot config — applies always.
  if (cfg.weightLimitPerItem > 0 && w > cfg.weightLimitPerItem) return false;

  if (hasSlotRows(container)) {
    const qty = Number(item?.system?.quantity) || 1;
    if (!cfg.stack && qty > 1) return false;

    const rows = assignToRows(container);
    return rows.some(r => itemMatchesSlot(r, item) && (r.count - r.used) >= qty);
  }

  // No slot rows → fall back to the system's own kg cap so legacy
  // containers (created before our editor existed) still respect their
  // original capacity.
  const capacity = Number(container?.system?.carry) || 0;
  if (capacity <= 0) return true;
  const stored = liveStoredWeight(container);
  const q = Number(item?.system?.quantity) || 1;
  return (stored + w * q) <= capacity;
}

/** Sum of weights of every resolved item in `system.content`. */
function liveStoredWeight(container) {
  const content = container?.system?.content ?? [];
  if (content.length === 0) return 0;
  let total = 0;
  for (const ref of content) {
    if (typeof fromUuidSync !== "function") return Number(container?.system?.storedWeight) || 0;
    const inner = fromUuidSync(ref);
    if (!inner) continue;
    total += (Number(inner.system?.weight) || 0) * (Number(inner.system?.quantity) || 1);
  }
  return total;
}

/** Header-bar capacity readout for the popup chrome.
 *  Returns null when there's nothing useful to render. */
export function getCapacityDisplay(container) {
  const cfg = getContainerCfg(container);
  const storedW = liveStoredWeight(container);
  const perItem = cfg.weightLimitPerItem;
  if (hasSlotRows(container)) {
    const rows = assignToRows(container);
    const max = cfg.slots.reduce((s, r) => s + r.count, 0);
    const cur = rows.reduce((s, r) => s + r.used, 0);
    return {
      cur, max, label: "",
      over: cur > max,
      hasSlots: true,
      storedWeight: storedW,
      perItemWeightCap: perItem,
    };
  }
  const carry = Number(container?.system?.carry) || 0;
  if (carry <= 0 && perItem <= 0 && storedW <= 0) return null;
  // Summed float weights can carry long fractional tails — show at most 2 dp.
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    cur: round2(storedW),
    max: carry,
    label: "kg",
    over: carry > 0 && storedW > carry,
    hasSlots: false,
    storedWeight: storedW,
    totalWeightCap: carry,
    perItemWeightCap: perItem,
  };
}

/** Build the visual slot layout for the popup body.  For each row, emit
 *  one tile per slot-unit: an item that occupies N slot-units (a stack
 *  of N) emits N filled tiles all pointing back to the same item, then
 *  the remaining (count - used) emit as empty placeholders. */
export function buildSlotLayout(container) {
  if (!hasSlotRows(container)) return [];
  const rows = assignToRows(container);
  const tiles = [];
  for (const r of rows) {
    let emitted = 0;
    for (const a of r.items) {
      for (let i = 0; i < a.qty; i++) {
        tiles.push({ row: r, item: a.item, isStack: a.qty > 1, stackIndex: i });
        emitted++;
      }
    }
    while (emitted < r.count) {
      tiles.push({ row: r, item: null });
      emitted++;
    }
  }
  return tiles;
}

/** Total slot count across all configured rows. */
export function totalSlots(container) {
  return getContainerCfg(container).slots.reduce((s, r) => s + r.count, 0);
}

/* ── Empty-tile presentation hint ─────────────────────────────────── */

/** FontAwesome class to render in an empty placeholder tile, picked
 *  from the slot row's type+subtype. */
export function tilePlaceholderIcon(row) {
  if (!row) return "fa-circle-question";
  if (row.type === "weapon") {
    const m = {
      swordsmanship: "fa-sword",
      smallblades:   "fa-utensils",
      staffspear:    "fa-staff-aesculapius",
      melee:         "fa-hammer",
      brawling:      "fa-hand-fist",
      archery:       "fa-bow-arrow",
      crossbow:      "fa-crosshairs",
    };
    return m[row.subtype] ?? "fa-khanda";
  }
  switch (row.type) {
    case "ammo":        return "fa-location-arrow";
    case "armor":       return "fa-shield-halved";
    case "alchemical":  return "fa-flask";
    case "component":   return "fa-leaf";
    case "mutagen":     return "fa-vial";
    case "valuable":    return "fa-coins";
    case "enhancement": return "fa-gem";
    case "diagrams":    return "fa-scroll";
    case "note":        return "fa-feather";
    case "container":   return "fa-box";
    default:            return "fa-cube";
  }
}

/** Human-readable description of a row for tooltips. */
export function rowTooltip(row) {
  if (!row) return "";
  const t = slotTypeLabel(row.type);
  const s = row.subtype ? subtypeLabel(row.type, row.subtype) : "";
  return s ? `${s} (${t})` : t;
}

/* ── Warning composition ──────────────────────────────────────────── */

export function overflowWarning(container, item) {
  const cfg  = getContainerCfg(container);
  const name = container?.name ?? "Container";
  const w    = Number(item?.system?.weight) || 0;

  // Per-item cap applies regardless of slot config.
  if (cfg.weightLimitPerItem > 0 && w > cfg.weightLimitPerItem) {
    return `${name}: per-item weight limit ${cfg.weightLimitPerItem} kg — ${item?.name ?? "this item"} is ${w} kg.`;
  }

  if (hasSlotRows(container)) {
    const qty = Number(item?.system?.quantity) || 1;

    if (!cfg.stack && qty > 1) {
      return `${name} does not accept stacks — split ${item?.name ?? "the item"} into single units first.`;
    }

    const matchingRows = cfg.slots.filter(r => itemMatchesSlot(r, item));
    if (matchingRows.length === 0) {
      return `${name} has no slot accepting ${item?.name ?? "this item"}.`;
    }

    const rows = assignToRows(container);
    const total = matchingRows.reduce((s, r) => s + r.count, 0);
    const used = rows
      .filter(r => matchingRows.some(m => m === r || (m.type === r.type && m.subtype === r.subtype && m.maxConceal === r.maxConceal)))
      .reduce((s, r) => s + r.used, 0);
    return `${name} is out of matching slots (${used}/${total}, need ${qty}).`;
  }

  // Weight fallback.
  const carryCap = Number(container?.system?.carry) || 0;
  const stored = liveStoredWeight(container);
  const q = Number(item?.system?.quantity) || 1;
  const add = w * q;
  return `Can't store ${item?.name ?? "item"} (${add} kg) — ` +
         `${container?.name ?? "container"} would exceed ${carryCap} kg capacity ` +
         `(currently ${stored} kg, +${add} = ${stored + add} kg).`;
}
