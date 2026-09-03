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
 *     { capacityMode: "general"|"slots"|"hybrid",
 *       slots: [
 *         { type: itemType,           // weapon / ammo / armor / alchemical / ...
 *           subtype: string,          // category within the type (or "")
 *           count: int >= 1,
 *           maxConceal: ""|"T"|"S"|"L"|"NA",  // size cap (any slot type)
 *           maxWeight: number,        // 0 = no per-slot kg cap
 *           quickUse: boolean,        // use (draw/drink/eat/consume) free
 *           quickDraw: boolean,       // weapon here may snap/fast-draw
 *           freeDraw: boolean,        // draw / take out with no action
 *         }, ...
 *       ],
 *       stack: boolean,
 *       weightLimitPerItem: number,  // 0 = no per-item kg cap
 *     }
 *
 * `capacityMode` (default: slots-if-rows-exist, else general):
 *   general — accepts anything up to the kg cap (a plain sack)
 *   slots   — accepts only items that fit a configured slot row
 *   hybrid  — slot compartments PLUS a general kg pool for the rest
 *
 * The three per-slot behavior toggles are enforced by the draw / use wiring
 * (see slotFlag / itemIn*Slot). Backwards-compat: containers with no config
 * behave as a plain `general` sack capped by the system's own `system.carry`.
 */

import { t, tFormat } from "./i18n.js";

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
  "ammo",
  "armor",
  "alchemical",
  "component",
  "mutagen",
  "valuable",
  "map",
  "remains",
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
  map:         "Map",
  remains:     "Remains",
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
    athletics:     "Athletics (Thrown)",
    bomb:          "Bombs",
  },
  ammo: {
    arrow:       "Arrows",
    bolt:        "Bolts",
    slingBullet: "Sling Bullets",
    siege:       "Siege",
  },
  armor: {
    light:  "Light",
    medium: "Medium",
    heavy:  "Heavy",
  },
  alchemical: {
    alchemical: "Alchemical",
    potion:     "Potion",
    decoction:  "Decoction",
    oil:        "Oil",
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
  const fb = SLOT_TYPE_LABELS[type];
  if (!fb) return type;
  return t(`WITCHER.Chrome.Lib.Container.SlotType.${type}`, fb);
}

export function subtypeLabel(type, subtype) {
  if (!subtype) return "";
  const fb = SUBTYPES_BY_TYPE[type]?.[subtype];
  if (!fb) return subtype;
  return t(`WITCHER.Chrome.Lib.Container.Subtype.${type}.${subtype}`, fb);
}

/* Container behavior is configured entirely per-slot + per-capacity-mode now
 * (no preset "types" like scabbard / quiver / bandolier — those were removed
 * in favor of hand-built compartments). */

/* ── Concealment (size cap) ───────────────────────────────────────── */

export const CONCEAL_CODES = ["T", "S", "L", "NA"];
const CONCEAL_RANK = { T: 1, S: 2, L: 3, NA: 4 };
const CONCEAL_FALLBACKS = {
  T:  "Tiny",
  S:  "Small",
  L:  "Large",
  NA: "Can't hide",
};
/* Lazy proxy so consumers (e.g. `CONCEAL_LABELS.T`) get the localized
 * value at read time — the underlying strings must not be captured at
 * module-eval, before Foundry has loaded lang. */
export const CONCEAL_LABELS = new Proxy(CONCEAL_FALLBACKS, {
  get(target, prop) {
    if (!(prop in target)) return undefined;
    return t(`WITCHER.Chrome.Lib.Container.Conceal.${String(prop)}`, target[prop]);
  }
});

export function weaponConceal(item) {
  let v = String(item?.system?.conceal ?? "").trim().toUpperCase();
  // The weapon table stores the "can't hide" code as "N/A" (config.mjs
  // CONCEALMENT), but our rank table / rule codes use "NA". Without this
  // mapping an N/A weapon reads as having NO conceal size — so it slips past
  // both ≤ size limits and ≥ deny thresholds (e.g. an N/A crossbow evading a
  // "deny weapons that can't be hidden" rule).
  if (v === "N/A" || v === "NA") return "NA";
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

/** Capacity handling modes:
 *   general — accepts anything up to the kg cap (a plain sack); slots ignored
 *   slots   — accepts ONLY items that fit a configured slot row
 *   hybrid  — slots for matching items PLUS a general kg pool for the rest
 *             (a pack with a couple of dedicated compartments). */
export const CAPACITY_MODES = ["general", "slots", "hybrid"];

/** Normalize one accept-entry ({type, subtype}) or null if the type is invalid. */
function normAcceptEntry(e) {
  if (!e || typeof e.type !== "string" || !SLOT_TYPES.includes(e.type)) return null;
  const ty = String(e.type);
  const subtype = (SUBTYPES_BY_TYPE[ty] && SUBTYPES_BY_TYPE[ty][e.subtype]) ? String(e.subtype) : "";
  return { type: ty, subtype };
}
/** Normalize a list of accept-entries: valid entries only, deduped on
 *  type+subtype, order preserved. */
function normAcceptList(list) {
  const out = []; const seen = new Set();
  for (const e of (Array.isArray(list) ? list : [])) {
    const n = normAcceptEntry(e);
    if (!n) continue;
    const k = `${n.type}|${n.subtype}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(n);
  }
  return out;
}

/** Read the container config blob (with safe defaults). */
export function getContainerCfg(container) {
  const raw = container?.flags?.[MODULE_ID]?.[FLAG_KEY];
  const rawSlots = Array.isArray(raw?.slots) ? raw.slots : [];
  const slots = rawSlots
      .filter(s => s && (SLOT_TYPES.includes(s.type) || Array.isArray(s.accepts)))
      .map(s => {
        // A slot accepts a LIST of {type, subtype} entries. Back-compat: old
        // configs stored a single {type, subtype}; normalize both to a
        // non-empty `accepts` array and keep `type`/`subtype` = the first entry
        // so every legacy reader (icons, labels, matcher fallback) still works.
        const accepts = normAcceptList(Array.isArray(s.accepts) ? s.accepts : [{ type: s.type, subtype: s.subtype }]);
        if (!accepts.length) return null;
        const st = accepts[0].type;
        const subtype = accepts[0].subtype;
        return {
          type: st,
          subtype,
          accepts,
          count:      Math.max(1, Math.floor(Number(s.count) || 1)),
          // Conceal cap is now a general per-slot gate (items without a
          // `conceal` field pass freely), not weapon-only.
          maxConceal: CONCEAL_CODES.includes(s.maxConceal) ? s.maxConceal : "",
          maxWeight:  Math.max(0, Number(s.maxWeight) || 0),
          // ── Per-slot behavior toggles ──
          // quickDraw: snap/fast-draw a WEAPON out of this slot (scabbard).
          // freeUse  : using the item in combat (draw a weapon / drink / eat /
          //            consume / take out) costs no action. Absorbs the old
          //            freeDraw + quickUse flags (mapped for back-compat).
          quickDraw:  !!s.quickDraw,
          freeUse:    !!(s.freeUse || s.freeDraw || s.quickUse),
          // ── Stacking ──
          // stack   : this compartment's slots may hold a multi-unit stack.
          // stackMax: max units per slot (only when stack). A stack spreads
          //           across the compartment's slots, up to stackMax each.
          stack:      !!s.stack,
          stackMax:   Math.max(1, Math.floor(Number(s.stackMax) || 1)),
        };
      })
      .filter(Boolean);
  /* General-pool acceptance filter (general / hybrid modes): an ORDERED list of
   * allow/deny rules. Evaluated top-down; the FIRST rule that matches an item
   * decides (allow or deny). Nothing matches = deny. EMPTY list = accept
   * everything. This lets you layer exceptions — e.g. (top) allow small blades,
   * (mid) deny weapons, (bottom) allow anything = "everything except non-small-
   * bladed weapons". `mode` defaults to "allow" so legacy whitelists are
   * unchanged (first matching allow → accepted, no match → denied). */
  const generalAccept = (Array.isArray(raw?.generalAccept) ? raw.generalAccept : [])
    .filter(g => g && typeof g.type === "string" && SLOT_TYPES.includes(g.type))
    .map(g => {
      const gt = String(g.type);
      const subtype = (SUBTYPES_BY_TYPE[gt] && SUBTYPES_BY_TYPE[gt][g.subtype]) ? String(g.subtype) : "";
      const mode = g.mode === "deny" ? "deny" : "allow";
      // Per-condition comparator (≤ / ≥), independent of mode and separately
      // settable for size vs weight. Defaults to the mode's natural direction
      // (allow caps at ≤, deny thresholds at ≥) so legacy rules are unchanged.
      const dir = g.mode === "deny" ? "ge" : "le";
      const cmp = v => (v === "le" || v === "ge") ? v : dir;
      return {
        type: gt,
        subtype,
        mode,
        maxConceal: CONCEAL_CODES.includes(g.maxConceal) ? g.maxConceal : "",
        concealCmp: cmp(g.concealCmp),
        maxWeight:  Math.max(0, Number(g.maxWeight) || 0),
        weightCmp:  cmp(g.weightCmp),
      };
    });
  /* Default preserves the pre-mode behavior: a container WITH slot rows
   * gated by slots, one without behaves as a plain weight sack. An explicit
   * capacityMode overrides. */
  const capacityMode = CAPACITY_MODES.includes(raw?.capacityMode)
    ? raw.capacityMode
    : (slots.length ? "slots" : "general");
  return {
    capacityMode,
    slots,
    generalAccept,
    weightLimitPerItem: Math.max(0, Number(raw?.weightLimitPerItem) || 0),
  };
}

/** Does `item` satisfy a rule's SIZE condition — its conceal size `cmp` (≤ / ≥)
 *  `cap`? An empty cap = no size condition (always satisfied). An item with no
 *  conceal size passes a ≤ bound (nothing to exceed) but fails a ≥ bound (can't
 *  reach any threshold). */
function concealSatisfies(cmp, cap, item) {
  if (!cap) return true;
  const wc = weaponConceal(item);
  if (!wc) return cmp !== "ge";
  return cmp === "ge"
    ? CONCEAL_RANK[wc] >= CONCEAL_RANK[cap]
    : CONCEAL_RANK[wc] <= CONCEAL_RANK[cap];
}

/** Does `item` satisfy a rule's WEIGHT condition — its weight `cmp` (≤ / ≥)
 *  `cap`? A 0/absent cap = no weight condition. */
function weightSatisfies(cmp, cap, item) {
  if (!(cap > 0)) return true;
  const w = Number(item?.system?.weight) || 0;
  return cmp === "ge" ? w >= cap : w <= cap;
}

/** One rule's verdict for `item`: "allow", "deny", or null (rule doesn't apply
 *  → fall through). SCOPE is type+subtype; size & weight are conditions with
 *  their own per-condition comparators (≤ or ≥). All set conditions must hold
 *  for the rule to "match".
 *   • allow — CLAIMS its whole scope: an in-scope item that matches every
 *     condition is allowed, one that doesn't is denied (not leaked to a lower
 *     rule). So "allow weapons, size ≤ small" rejects bigger weapons.
 *   • deny  — blocks in-scope items that match every condition; items that
 *     don't match fall through to lower rules. */
function generalRuleVerdict(r, item) {
  if (r.type !== "any") {
    if (!item || item.type !== r.type) return null;
    if (r.subtype && itemSubtypeOf(item) !== r.subtype) return null;
  } else if (!item) {
    return null;
  }
  const ok = concealSatisfies(r.concealCmp, r.maxConceal, item)
          && weightSatisfies(r.weightCmp, r.maxWeight, item);
  if (r.mode === "deny") return ok ? "deny" : null;
  return ok ? "allow" : "deny";
}

/** Is `item` allowed in the general pool? Rules are an ORDERED, layered list
 *  read bottom → top (topmost match wins). The FIRST rule (top-down) that
 *  applies decides. Nothing applies → denied. No rules at all → everything
 *  allowed. */
export function matchesGeneralAccept(cfg, item) {
  const rules = cfg?.generalAccept ?? [];
  if (!rules.length) return true;
  for (const r of rules) {
    const v = generalRuleVerdict(r, item);
    if (v !== null) return v === "allow";
  }
  return false;
}

/** True if the container presents a SLOT layout (slots or hybrid mode with
 *  rows). A "general" container renders as a plain weight grid even if stale
 *  rows are still configured. */
export function hasSlotRows(container) {
  const cfg = getContainerCfg(container);
  return cfg.capacityMode !== "general" && cfg.slots.length > 0;
}

/* ── Matching logic ───────────────────────────────────────────────── */

/** Extract the subtype value from an item, by type.  This is what we
 *  compare against a slot row's `subtype` to decide a match. */
export function itemSubtypeOf(item) {
  if (!item) return "";
  const sys = item.system ?? {};
  switch (item.type) {
    case "weapon":
      // Bombs are weapons with `weaponType: "bomb"` (thrown via Athletics) —
      // surface them as their own subtype so a slot can hold bombs
      // specifically, separate from ordinary Athletics-thrown weapons.
      if (sys.weaponType === "bomb") return "bomb";
      // Otherwise the weapon's combat skill lives in `skillKey`
      // (swordsmanship / archery / athletics / …), legacy `meleeSkillKey`.
      return String(sys.skillKey || sys.meleeSkillKey || "");
    case "ammo":
      // Arrows vs bolts vs sling/siege are distinguished by ammoType.
      return String(sys.ammoType ?? "");
    case "armor":
      // Armor category lives in `armorType` (light / medium / heavy).
      return String(sys.armorType ?? "");
    case "alchemical":
    case "mutagen":
    case "valuable":
    case "enhancement":
    case "diagrams":
      return String(sys.type ?? "");
    default:
      // component (no clean category field) and everything else → no subtype.
      return "";
  }
}

/** True if `item` would fill `slot` (type + subtype + weapon-only conceal). */
export function itemMatchesSlot(slot, item) {
  if (!slot || !item) return false;
  // Per-slot weight cap applies to every slot type (0 = no cap). An item
  // too heavy for THIS slot can still land in another row that accepts it.
  if (slot.maxWeight > 0 && (Number(item?.system?.weight) || 0) > slot.maxWeight) return false;
  // Conceal cap applies to every slot type now; items with no `conceal`
  // field (armor, components, …) pass slotAcceptsConceal freely.
  if (!slotAcceptsConceal(slot.maxConceal, item)) return false;
  // A slot accepts a LIST of {type, subtype}; the item passes if it matches ANY
  // entry. (Legacy single-type rows fall back to their {type, subtype}.)
  const accepts = (Array.isArray(slot.accepts) && slot.accepts.length)
    ? slot.accepts
    : [{ type: slot.type, subtype: slot.subtype }];
  return accepts.some(a => {
    if (a.type === "any") return true;
    if (item.type !== a.type) return false;
    if (a.subtype && itemSubtypeOf(item) !== a.subtype) return false;
    return true;
  });
}

/** Greedy assignment of stored items to slot rows.  Each item lands in
 *  the FIRST row (config order) that matches AND has enough free slots
 *  for the item's quantity.  Returns enriched rows: `{ ...row, used,
 *  items: [{item, qty}] }`. */
/** An item's placement inside a container: a compartment index, "loose", or
 *  null (auto — no explicit placement, greedily assigned). Set on drop (see
 *  the inventory drop handlers). */
export function itemContainerPlacement(item) {
  const p = item?.flags?.[MODULE_ID]?.containerSlot;
  if (p === "loose") return "loose";
  if (typeof p === "string" && /^\d+:\d+$/.test(p)) {
    const [row, slot] = p.split(":").map(Number);
    return { row, slot };
  }
  return null;
}

/** Fill a compartment row with `qty` units of `item`, spreading across free
 *  slots (up to the row's stackMax each). Returns leftover units that didn't
 *  fit. Mutates row.slotFills / row.used / row.items. */
function fillRow(row, item, qty) {
  let remaining = qty;
  for (let i = 0; i < row.slotFills.length && remaining > 0; i++) {
    if (row.slotFills[i]) continue;
    const put = Math.min(remaining, row.stackMax);
    row.slotFills[i] = { item, qty: put };
    remaining -= put;
  }
  const placed = qty - remaining;
  if (placed > 0) { row.used += placed; row.items.push({ item, qty: placed }); }
  return remaining;
}

/** Resolve every content ref → item, honoring per-item placement:
 *  explicit-compartment items claim their slots first, then auto items fill
 *  greedily. Each row gains `slotFills` (per-slot {item, qty}|null), `used`,
 *  `items`, and the resolved `stackMax`. */
function assignToRows(container) {
  const cfg = getContainerCfg(container);
  const rows = cfg.slots.map(r => ({
    ...r,
    stackMax: r.stack ? Math.max(1, r.stackMax || 1) : 1,
    slotFills: new Array(Math.max(1, r.count)).fill(null),
    used: 0,
    items: [],
  }));
  const resolved = [];
  for (const ref of container?.system?.content ?? []) {
    const inner = resolveContentRef(container, ref);
    if (!inner) continue;
    // Skip a genuinely drawn-down (0-qty) doc — otherwise Number(qty)||1 would
    // render it as a phantom 1-unit item occupying a slot / adding weight.
    const q = Number(inner.system?.quantity);
    if (Number.isFinite(q) && q <= 0) continue;
    resolved.push(inner);
  }
  const isPlaced = new Set();
  // Pass 1 — items pinned to a specific slot ("row:slot") claim that exact tile.
  for (const inner of resolved) {
    const place = itemContainerPlacement(inner);
    if (!place || place === "loose") continue;
    const row = rows[place.row];
    if (!row || !itemMatchesSlot(row, inner)) continue;   // stale/invalid pin → auto
    if (place.slot < 0 || place.slot >= row.slotFills.length) continue;
    if (row.slotFills[place.slot]) continue;              // tile already claimed
    const qty = Number(inner.system?.quantity) || 1;
    const put = Math.min(qty, row.stackMax);
    row.slotFills[place.slot] = { item: inner, qty: put };
    row.used += put;
    row.items.push({ item: inner, qty: put });
    isPlaced.add(inner.id);
    // Overflow beyond this single pinned tile spreads into other matching free
    // slots so it's never silently dropped from the accounting; any remainder
    // after every slot is full falls to the hybrid loose section (total-placed).
    let leftover = qty - put;
    for (const r2 of rows) {
      if (leftover <= 0) break;
      if (!itemMatchesSlot(r2, inner)) continue;
      leftover = fillRow(r2, inner, leftover);
    }
  }
  // Pass 2 — auto items (no pin, not "loose") greedily fill the first matching
  // row with a free slot.
  for (const inner of resolved) {
    if (isPlaced.has(inner.id)) continue;
    if (itemContainerPlacement(inner) === "loose") continue;   // → general pool
    let qty = Number(inner.system?.quantity) || 1;
    for (const row of rows) {
      if (qty <= 0) break;
      if (!itemMatchesSlot(row, inner)) continue;
      qty = fillRow(row, inner, qty);
    }
  }
  return rows;
}

/* ── Per-slot behavior toggles (quick-use / quick-draw / free-draw) ── */

/** The configured slot row `item` currently occupies inside `container`
 *  (using the same greedy assignment as capacity), or null if it isn't
 *  assigned to any row. */
export function slotRowForItem(container, item) {
  if (!container || !item) return null;
  const rows = assignToRows(container);
  for (const r of rows) {
    if (r.items.some(a => a.item?.id === item.id || a.item?.uuid === item.uuid)) return r;
  }
  return null;
}

/** Does `item`'s assigned slot in `container` carry the given behavior flag? */
function slotFlag(container, item, flag) {
  return slotRowForItem(container, item)?.[flag] === true;
}

/** quickDraw: a WEAPON here may be snap/fast-drawn (scabbard behavior). */
export function itemInQuickDrawSlot(container, item) { return slotFlag(container, item, "quickDraw"); }
/** freeUse : using the item (draw / drink / eat / consume / take out) costs
 *  no combat action. */
export function itemInFreeUseSlot(container, item)   { return slotFlag(container, item, "freeUse"); }

/** Generic: is `item` in a slot carrying `flag` in ANY equipped container on
 *  `actor`? The equipped gate matches the combat access rule (you can only
 *  reach an item stowed in an equipped/railed container). */
function actorSlotFlag(actor, item, flag) {
  if (!actor || !item) return false;
  for (const c of actor.items) {
    if (c.type !== "container" || c.system?.equipped !== true) continue;
    const content = c.system?.content ?? [];
    if (!(content.includes(item.uuid) || content.includes(item.id))) continue;
    if (slotFlag(c, item, flag)) return true;
  }
  return false;
}
export function actorItemQuickDraw(actor, item) { return actorSlotFlag(actor, item, "quickDraw"); }
export function actorItemFreeUse(actor, item)   { return actorSlotFlag(actor, item, "freeUse"); }

/* ── Capacity API used by drop sites ──────────────────────────────── */

/** Does the general (kg-capped) pool ACCEPT + have room for `item`? This is
 *  the loose-space gate: the generalAccept whitelist (type/subtype + per-rule
 *  size & weight caps), the per-item weight cap, and the weight capacity. Used
 *  both by fitsInContainer and directly by loose-space drops so dropping into
 *  the loose pool obeys the same rules as any other placement. In hybrid, only
 *  items NOT in a slot count against the pool; otherwise the whole load does. */
export function fitsGeneralPool(container, item) {
  const cfg = getContainerCfg(container);
  const w   = Number(item?.system?.weight) || 0;
  const qty = Number(item?.system?.quantity) || 1;
  if (cfg.weightLimitPerItem > 0 && w > cfg.weightLimitPerItem) return false;
  if (!matchesGeneralAccept(cfg, item)) return false;   // general accept whitelist
  const capacity = Number(container?.system?.carry) || 0;
  if (capacity <= 0) return true;                        // 0 = unlimited general space
  // Exclude the item itself from the stored sum — re-testing a drop of an item
  // already stored here (a slot→loose move, a redundant re-drop) must not
  // double-count its own weight and spuriously reject it near the cap.
  const excludeId = item?.id ?? null;
  // Compartment items count toward the container's weight budget too, so the
  // capacity check uses the FULL stored weight (loose + slotted), not loose only.
  const stored = liveStoredWeight(container, excludeId);
  return (stored + w * qty) <= capacity;
}

/** True if `item` can be added to `container`, honoring capacity mode. */
export function fitsInContainer(container, item) {
  const cfg = getContainerCfg(container);
  const qty = Number(item?.system?.quantity) || 1;

  // Per-item weight cap is independent of everything else — applies always.
  if (cfg.weightLimitPerItem > 0 && (Number(item?.system?.weight) || 0) > cfg.weightLimitPerItem) return false;

  // Does the item fit into a matching compartment? Free capacity = free slots
  // × (stackMax if the compartment stacks, else 1). A non-stacking compartment
  // spreads a stack 1-per-slot; a stacking one packs up to stackMax per slot.
  const fitsSlot = () => {
    if (!cfg.slots.length) return false;
    const rows = assignToRows(container);
    return rows.some(r => {
      if (!itemMatchesSlot(r, item)) return false;
      const perSlot = r.stack ? Math.max(1, r.stackMax || 1) : 1;
      const freeSlots = r.slotFills.filter(f => !f).length;
      let capacity = freeSlots * perSlot;
      // Stacking rows: even with every slot occupied, a partially-filled
      // same-item (unpinned) stack still has headroom to top off. Count it so a
      // drop that fits ONLY by stacking onto an existing pile isn't wrongly
      // rejected as full. Mirrors unitsToTopNextSlot's merge rule.
      if (r.stack) {
        for (const f of r.slotFills) {
          if (f && !f.item?.flags?.[MODULE_ID]?.containerSlot
              && f.item?.type === item?.type && f.item?.name === item?.name
              && f.qty < perSlot) {
            capacity += perSlot - f.qty;
          }
        }
      }
      return capacity >= qty;
    });
  };

  switch (cfg.capacityMode) {
    case "general": return fitsGeneralPool(container, item);
    case "slots":   return fitsSlot();
    case "hybrid":  return fitsSlot() || fitsGeneralPool(container, item);
    default:        return fitsGeneralPool(container, item);
  }
}

/** True if a compartment can take ONE MORE unit of `item` right now — an
 *  empty matching slot, or a partially-filled same-item slot below stackMax.
 *  Used by the one-unit-per-drag stow path. Only meaningful when the
 *  container has compartments. */
export function containerHasRoomForOne(container, item) {
  return unitsToTopNextSlot(container, item) > 0;
}

/** How many units of `item` a single drop should take to fill the NEXT slot
 *  to its max: tops off a partially-filled same-item slot, else fills a fresh
 *  slot to the per-slot max. 0 when no compartment can take it. */
export function unitsToTopNextSlot(container, item) {
  const cfg = getContainerCfg(container);
  if (!cfg.slots.length) return 0;
  const rows = assignToRows(container);
  for (const r of rows) {
    if (!itemMatchesSlot(r, item)) continue;
    const perSlot = r.stack ? Math.max(1, r.stackMax || 1) : 1;
    // Top off a partially-filled same-item slot first — but only an UNPINNED
    // (auto) one. The auto-fill path in moveItemToContainer refuses to merge
    // into a slot-pinned doc (that would over-cap its single slot), so counting
    // a pinned partial here would let the drop happen yet land the unit in a
    // different slot — or orphan it invisibly when nothing else is free.
    const partial = r.slotFills.find(f =>
      f && !f.item?.flags?.[MODULE_ID]?.containerSlot
      && f.item?.type === item?.type && f.item?.name === item?.name && f.qty < perSlot);
    if (partial) return perSlot - partial.qty;
    // Otherwise a fresh empty slot → fill it to the per-slot max.
    if (r.slotFills.some(f => !f)) return perSlot;
  }
  return 0;
}

/** Resolve a container-content ref (uuid or bare id) to its item. */
function resolveContentRef(container, ref) {
  if (!ref) return null;
  let inner = null;
  try { inner = (typeof fromUuidSync === "function") ? fromUuidSync(ref) : null; } catch (_) { inner = null; }
  if (!inner) inner = container?.parent?.items?.get?.(ref) ?? null;
  return inner;
}

/** Weight of contents NOT assigned to any slot row — the "general pool" load
 *  used by hybrid mode, so dedicated compartments don't eat the loose-space
 *  budget. */
function generalStoredWeight(container, excludeId = null) {
  const rows = assignToRows(container);
  const slotted = new Set();
  for (const r of rows) for (const a of r.items) {
    if (a.item?.id)   slotted.add(a.item.id);
    if (a.item?.uuid) slotted.add(a.item.uuid);
  }
  let total = 0;
  for (const ref of container?.system?.content ?? []) {
    const inner = resolveContentRef(container, ref);
    if (!inner) continue;
    if (excludeId && (inner.id === excludeId || inner.uuid === excludeId)) continue;
    if (slotted.has(inner.id) || slotted.has(inner.uuid)) continue;
    const q = Number(inner.system?.quantity);
    if (Number.isFinite(q) && q <= 0) continue;
    total += (Number(inner.system?.weight) || 0) * (Number.isFinite(q) ? q : 1);
  }
  return total;
}

/** Sum of weights of every resolved item in `system.content`. `excludeId` skips
 *  one item (used to avoid double-counting an item already stored here when
 *  re-testing a drop of it). */
function liveStoredWeight(container, excludeId = null) {
  const content = container?.system?.content ?? [];
  if (content.length === 0) return 0;
  let total = 0;
  for (const ref of content) {
    if (typeof fromUuidSync !== "function") return Number(container?.system?.storedWeight) || 0;
    const inner = fromUuidSync(ref);
    if (!inner) continue;
    if (excludeId && (inner.id === excludeId || inner.uuid === excludeId)) continue;
    const q = Number(inner.system?.quantity);
    if (Number.isFinite(q) && q <= 0) continue;
    total += (Number(inner.system?.weight) || 0) * (Number.isFinite(q) ? q : 1);
  }
  return total;
}

/** Header-bar capacity readout for the popup chrome.
 *  Returns null when there's nothing useful to render. */
export function getCapacityDisplay(container) {
  const cfg = getContainerCfg(container);
  const storedW = liveStoredWeight(container);
  const perItem = cfg.weightLimitPerItem;
  const carry = Number(container?.system?.carry) || 0;
  const mode = cfg.capacityMode;
  // Summed float weights can carry long fractional tails — show at most 2 dp.
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const showSlots  = (mode === "slots" || mode === "hybrid") && cfg.slots.length > 0;
  const showWeight = (mode === "general" || mode === "hybrid");

  if (!showSlots && !showWeight && carry <= 0 && perItem <= 0 && storedW <= 0) return null;

  const out = {
    hasSlots: showSlots,
    storedWeight: round2(storedW),
    perItemWeightCap: perItem,
  };
  if (showSlots) {
    const rows = assignToRows(container);
    // Count FILLED SLOTS (tiles), not the quantity of items in them — a slot
    // holding a stack of 5 is one filled slot, not 5. `r.used` sums stack units,
    // which made a full 5-slot container read 10/5. `max` is total slot count,
    // so the two must both be tile-counts.
    out.cur = rows.reduce((s, r) => s + r.slotFills.filter(Boolean).length, 0);
    out.max = cfg.slots.reduce((s, r) => s + r.count, 0);
    out.over = out.cur > out.max;
    out.label = "";
  }
  if (showWeight) {
    // The weight chip reflects the FULL load (loose + compartments) — compartment
    // items count toward the container's weight budget. The slot chip shows slot
    // COUNT, so the two chips measure different things (no double-count).
    const genW = storedW;
    out.storedWeight = round2(genW);
    out.totalWeightCap = carry;
    out.over = (out.over === true) || (carry > 0 && genW > carry);
    if (!showSlots) { out.cur = round2(genW); out.max = carry; out.label = "kg"; }
  }
  return out;
}

/** Build the visual slot layout for the popup body.  For each row, emit
 *  one tile per slot-unit: an item that occupies N slot-units (a stack
 *  of N) emits N filled tiles all pointing back to the same item, then
 *  the remaining (count - used) emit as empty placeholders. */
export function buildSlotLayout(container) {
  if (!hasSlotRows(container)) return [];
  const cfg = getContainerCfg(container);
  const rows = assignToRows(container);
  const tiles = [];
  rows.forEach((r, ri) => {
    // One tile per slot: a filled slot carries its own per-slot quantity
    // (a stacking slot shows e.g. "5"; a spread stack shows 1 per slot).
    // `slotKey` ("row:slot") makes each tile an addressable drop target.
    r.slotFills.forEach((fill, si) => {
      const slotKey = `${ri}:${si}`;
      if (fill) {
        // `slotMax` is the per-slot stack capacity — only set for STACKING rows
        // so the tile can render "filled/max" (e.g. 2/5). null on plain slots.
        tiles.push({ row: r, item: fill.item, slotQty: fill.qty, isStack: fill.qty > 1, slotMax: r.stack ? r.stackMax : null, slotKey });
      } else {
        tiles.push({ row: r, item: null, slotKey });
      }
    });
  });
  /* Hybrid: after the dedicated compartments, show the general-pool items
   * (anything not assigned to a slot). When BOTH exist we bracket them with
   * labeled section dividers so the open container reads clearly as
   * "Compartments … / Loose space …". A `null` row means a plain stored item
   * (no behavior badge); a `divider` tile is a full-width section header. */
  if (cfg.capacityMode === "hybrid") {
    // How many units of each doc are already shown in compartments. A doc can
    // be PARTLY slotted and partly loose — an over-capped pin, or a stack that
    // outgrew its matching slots — so the loose pool shows only the REMAINDER.
    // (Excluding a partly-slotted doc entirely is what made overflow vanish.)
    const placedById = new Map();
    for (const r of rows) {
      for (const a of r.items) {
        const k = a.item?.id ?? a.item?.uuid;
        if (k != null) placedById.set(k, (placedById.get(k) || 0) + a.qty);
      }
    }
    const loose = [];
    for (const ref of container?.system?.content ?? []) {
      const inner = resolveContentRef(container, ref);
      if (!inner) continue;
      const q = Number(inner.system?.quantity);
      if (Number.isFinite(q) && q <= 0) continue;   // skip 0-qty ghosts
      const total  = Number.isFinite(q) ? q : 1;
      const placed = placedById.get(inner.id) ?? placedById.get(inner.uuid) ?? 0;
      const looseQty = total - placed;
      if (looseQty > 0) loose.push({ item: inner, qty: looseQty });
    }
    // Bracket the compartments so it reads as "Compartments … / Loose space …".
    // The loose pool is rendered as ONE dashed drop-zone tile (see slotTileHTML)
    // that frames its items — so the user can see exactly where to drop for
    // loose storage. It's shown even when empty, as a labelled drop target.
    if (tiles.length) {
      tiles.unshift({ divider: true, label: t("WITCHER.Chrome.Lib.Container.Compartments", "Compartments") });
    }
    tiles.push({ looseZone: true, label: t("WITCHER.Chrome.Lib.Container.LooseSpace", "Loose space"), items: loose });
  }
  return tiles;
}

/** Total slot count across all configured rows. */
export function totalSlots(container) {
  return getContainerCfg(container).slots.reduce((s, r) => s + r.count, 0);
}

/** Resolve a "row:slot" key into its compartment config + capacity, or null
 *  if the key is stale / out of range. */
export function describeSlot(container, slotKey) {
  if (typeof slotKey !== "string") return null;
  const [ri, si] = slotKey.split(":").map(Number);
  const cfg = getContainerCfg(container);
  const row = cfg.slots[ri];
  if (!row) return null;
  const count = Math.max(1, row.count);
  if (!(si >= 0 && si < count)) return null;
  const stackMax = row.stack ? Math.max(1, row.stackMax || 1) : 1;
  return { rowIndex: ri, slotIndex: si, row, stackMax };
}

/** True if `item` is allowed in the compartment addressed by `slotKey`. */
export function slotAcceptsItem(container, slotKey, item) {
  const info = describeSlot(container, slotKey);
  return info ? itemMatchesSlot(info.row, item) : false;
}

/** The item currently occupying `slotKey` (with its per-slot qty), or null. */
export function slotOccupant(container, slotKey) {
  const info = describeSlot(container, slotKey);
  if (!info) return null;
  const rows = assignToRows(container);
  const fill = rows[info.rowIndex]?.slotFills?.[info.slotIndex];
  return fill ? { item: fill.item, qty: fill.qty } : null;
}

/* ── Empty-tile presentation hint ─────────────────────────────────── */

/** FontAwesome class to render in an empty placeholder tile, picked
 *  from the slot row's type+subtype. */
/** FA class for a single {type, subtype}. */
function slotEntryIcon(type, subtype) {
  if (type === "weapon") {
    const m = {
      swordsmanship: "fa-sword",
      smallblades:   "fa-dagger",
      staffspear:    "fa-staff-aesculapius",
      melee:         "fa-hammer",
      brawling:      "fa-hand-fist",
      archery:       "fa-bow-arrow",
      crossbow:      "fa-crosshairs",
      athletics:     "fa-person-running",
      bomb:          "fa-bomb",
    };
    return m[subtype] ?? "fa-swords";
  }
  if (type === "ammo") {
    const m = {
      arrow:       "fa-bow-arrow",
      bolt:        "fa-arrow-right-long",
      slingBullet: "fa-circle",
      siege:       "fa-bomb",
    };
    return m[subtype] ?? "fa-location-arrow";
  }
  switch (type) {
    case "any":         return "fa-asterisk";
    case "armor":       return "fa-shield-halved";
    case "alchemical":  return "fa-flask";
    case "component":   return "fa-leaf";
    case "mutagen":     return "fa-vial";
    case "valuable":    return "fa-coins";
    case "map":         return "fa-map";
    case "remains":     return "fa-skull";
    case "enhancement": return "fa-gem";
    case "diagrams":    return "fa-scroll";
    case "note":        return "fa-feather";
    case "container":   return "fa-box";
    default:            return "fa-cube";
  }
}

export function tilePlaceholderIcon(row) {
  if (!row) return "fa-circle-question";
  return slotEntryIcon(row.type, row.subtype);
}

/** One FA class per accepted type (deduped, order preserved). A multi-type slot
 *  renders all of these in its empty placeholder. */
export function tilePlaceholderIcons(row) {
  if (!row) return ["fa-circle-question"];
  const accepts = (Array.isArray(row.accepts) && row.accepts.length)
    ? row.accepts : [{ type: row.type, subtype: row.subtype }];
  const out = []; const seen = new Set();
  for (const a of accepts) {
    const ic = slotEntryIcon(a.type, a.subtype);
    if (!seen.has(ic)) { seen.add(ic); out.push(ic); }
  }
  return out.length ? out : ["fa-cube"];
}

/** Accept-entry list for a row (falls back to the legacy single {type,subtype}). */
function rowAccepts(row) {
  return (Array.isArray(row?.accepts) && row.accepts.length)
    ? row.accepts : [{ type: row?.type, subtype: row?.subtype }];
}

/** Human-readable description of a row for tooltips (joins all accepted types). */
export function rowTooltip(row) {
  if (!row) return "";
  return rowAccepts(row).map(a => {
    const ty = slotTypeLabel(a.type);
    const s = a.subtype ? subtypeLabel(a.type, a.subtype) : "";
    return s ? `${s} (${ty})` : ty;
  }).join(" / ");
}

/** Short caption for an empty slot tile — the subtype label when set, else
 *  the type label (or "Any" for the wildcard). Used to visibly mark which
 *  slot an empty placeholder tile is. */
export function rowShortLabel(row) {
  if (!row) return "";
  const label = a => a.type === "any"
    ? t("WITCHER.Chrome.Lib.Container.AnyShort", "Any")
    : (a.subtype ? subtypeLabel(a.type, a.subtype) : slotTypeLabel(a.type));
  return rowAccepts(row).map(label).join(" / ");
}

/* ── Warning composition ──────────────────────────────────────────── */

export function overflowWarning(container, item) {
  const cfg  = getContainerCfg(container);
  const name = container?.name ?? t("WITCHER.Chrome.Container.Text.Container", "Container");
  const w    = Number(item?.system?.weight) || 0;

  // Per-item cap applies regardless of slot config.
  if (cfg.weightLimitPerItem > 0 && w > cfg.weightLimitPerItem) {
    return tFormat("WITCHER.Chrome.Container.Warn.PerItemLimit", { name, cap: cfg.weightLimitPerItem, item: item?.name ?? t("WITCHER.Chrome.Container.Text.ThisItem", "this item"), w }, `${name}: per-item weight limit ${cfg.weightLimitPerItem} kg — ${item?.name ?? "this item"} is ${w} kg.`);
  }

  const qty = Number(item?.system?.quantity) || 1;
  const mode = cfg.capacityMode;
  const matchingRows = cfg.slots.filter(r => itemMatchesSlot(r, item));
  const itemName = item?.name ?? t("WITCHER.Chrome.Container.Text.ThisItem", "this item");

  // "Out of matching slots" — computed used/total across the rows this item could
  // occupy. Shared by slots-only and the hybrid slot-candidate case.
  const outOfSlots = () => {
    const rows = assignToRows(container);
    const total = matchingRows.reduce((s, r) => s + r.count, 0);
    // Count FILLED SLOTS (tiles), not stack units — a slot holding a stack of 5
    // is one filled slot. `r.used` sums units and made this read e.g. 10/5.
    const used = rows
      .filter(r => matchingRows.some(m => m === r || (m.type === r.type && m.subtype === r.subtype && m.maxConceal === r.maxConceal)))
      .reduce((s, r) => s + r.slotFills.filter(Boolean).length, 0);
    return tFormat("WITCHER.Chrome.Container.Warn.OutOfMatchingSlots", { name, used, total, qty }, `${name} is full.`);
  };
  const notAccepted = () =>
    tFormat("WITCHER.Chrome.Container.Warn.NotAccepted", { name, item: itemName }, `${name} won't accept ${itemName} (its type / size / weight rules).`);
  const weightOverflow = () => {
    const carryCap = Number(container?.system?.carry) || 0;
    const stored = mode === "hybrid" ? generalStoredWeight(container, item?.id) : liveStoredWeight(container, item?.id);
    const add = w * qty;
    return tFormat("WITCHER.Chrome.Container.Warn.WeightOverflow", { item: item?.name ?? t("WITCHER.Chrome.Container.Text.Item", "item"), add, container: container?.name ?? t("WITCHER.Chrome.Container.Text.ContainerLower", "container"), carryCap, stored, sum: stored + add }, `Can't store ${item?.name ?? "item"} (${add} kg) — ${container?.name ?? "container"} would exceed ${carryCap} kg capacity (currently ${stored} kg, +${add} = ${stored + add} kg).`);
  };

  // Slots-only: the blocker is always slot-related.
  if (mode === "slots") {
    return matchingRows.length === 0
      ? tFormat("WITCHER.Chrome.Container.Warn.NoSlotAccepting", { name, item: itemName }, `${name} has no slot accepting ${itemName}.`)
      : outOfSlots();
  }

  // Hybrid: overflowWarning only fires when NOTHING fit (slots full/none AND the
  // loose pool rejected it). Pick the message that reflects the real reason.
  if (mode === "hybrid") {
    if (!matchesGeneralAccept(cfg, item)) {
      // Can't go loose. If it's a slot candidate, the slots are simply full;
      // otherwise nothing here accepts it at all.
      return matchingRows.length > 0 ? outOfSlots() : notAccepted();
    }
    // Allowed loose but still didn't fit → the loose pool is over its weight cap.
    return weightOverflow();
  }

  // General (plain sack): accept-rule block, else weight.
  return matchesGeneralAccept(cfg, item) ? weightOverflow() : notAccepted();
}
